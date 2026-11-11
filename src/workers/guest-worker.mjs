import { checkGuestMemory } from './guest-memory.mjs';
import { meterGuestHttpBodies } from './guest-http-budget.mjs';
import { createAssetLoader, serveWorker, digest, errorText } from './asset-loader.mjs';

// An HttpClient program, with .NET 11's System.Net.Http, is a measured 6.45 MB component at O3.
const maximumComponentBytes = 8 * 1048576;
// The command contract NetWasm's hosting generates component adapters for.
const contractKey = 'wasi-command@0.3.2';
// Main's arguments follow the program name, as on any WASI host.
const programName = 'NetWasmApp';
// jco's transpile options as the NetWasm SDK runs them, for a browser that compiles
// every core module itself.
const transpileOptions = Object.freeze({
  name: 'guest', map: [], instantiation: { tag: 'async' }, validLiftingOptimization: false,
  tracing: false, noComponentErrorWrapping: false, noNodejsCompat: true, noTypescript: true,
  tlaCompat: false, base64Cutoff: 0, noNamespacedExports: false, multiMemory: false,
  bindgenEnableWasmExnref: true, strict: true, emitConditionalSuspendingWasm: true,
});
// A worker reads a mounted Blob in place.
const readBlobSync = (blob, start, end) => new Uint8Array(new FileReaderSync().readAsArrayBuffer(blob.slice(start, end)));

// The program's symbols files, which a published NetWasm program finds beside it: type names by runtime type ID
// (a structured failure report names the exception type from them) and method names for stack traces.
function readSymbols(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || !(value.typeSymbols instanceof Uint8Array) ||
      (value.methodSymbols !== undefined && !(value.methodSymbols instanceof Uint8Array)))
    throw Error('Invalid program symbols');
  return value;
}

// The program opens each file beside it under this folder, by the name the build gave it.
const sidecarPath = name => `/netwasm-sidecars/${programName}.wasm.${name}`;

// Desktop .NET's wording for an exception that escapes Main.
function unhandledExceptionText(typeName, message, stackTrace) {
  return `Unhandled exception. ${typeName}${message ? `: ${message}` : ''}${stackTrace ? `\n${stackTrace}` : ''}\n`;
}

// The adapter NetWasm generates for a wasi:cli command over jco's output: run's
// result<_, _> exits 0, and its declared error exits 1.
function createCommandAdapter(generatedModule, onInstantiated) {
  const isComponentError = generatedModule._util?.isComponentError;
  return Object.freeze({ contractKey, async instantiate({ loadCoreModule, imports, instantiateCore }) {
    const root = await generatedModule.instantiate(loadCoreModule, imports, instantiateCore);
    onInstantiated();
    const command = root?.['wasi:cli/run@0.3.2'];
    if (command === null || typeof command !== 'object' || typeof command.run !== 'function')
      throw Error('Missing guest command export');
    // A command built with structured diagnostics reports an escaping exception
    // through this export instead of trapping.
    const diagnosticCommand = root['netwasm:diagnostics/command@1.0.0'];
    if (diagnosticCommand !== undefined && typeof diagnosticCommand?.run !== 'function')
      throw Error('Invalid guest diagnostic command export');
    return Object.freeze({
      ...(diagnosticCommand === undefined ? {} : {
        diagnosticCommand: Object.freeze({ run: diagnosticCommand.run.bind(diagnosticCommand) }),
      }),
      command: Object.freeze({ async run() {
        try {
          await command.run();
          return 0;
        } catch (error) {
          if (typeof isComponentError === 'function' && isComponentError(error) && error.payload === undefined) return 1;
          throw error;
        }
      } }),
    });
  } });
}

serveWorker(async (data, report) => {
  // These captures survive both instantiation failures and execution traps.
  const output = { stdout: '', stderr: '' };
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const timings = [];
  let consoleBytes = 0;
  let url;
  let stage = 'transpile';
  let started;
  let running = false;
  let graph = [];
  let loaded = [];
  let generatedImports = [];
  let providedArguments;
  let componentSha256;
  let filesystem;
  let httpBudgetFailure;
  let fetchFailure;
  const moduleMemories = new WeakMap();
  let allocatedMemoryPages = 0;
  let coreInstances = 0;
  function begin(next) { stage = next; started = performance.now(); report({ stage: next }); }
  function complete() {
    if (started !== undefined) { timings.push({ stage, milliseconds: performance.now() - started }); started = undefined; }
  }
  function enter() { if (!running) { running = true; report({ guestEntered: true }); } }
  function append(stream, text) { output[stream] += text; if (text) report({ console: stream, text }); }
  function finishOutput() { for (const stream of ['stdout', 'stderr']) append(stream, decoders[stream].decode()); }
  const sink = stream => Object.freeze({ write(bytes) {
    if (!(bytes instanceof Uint8Array)) throw Error('Invalid guest console bytes');
    consoleBytes += bytes.byteLength;
    if (consoleBytes > 65536) throw Error('Guest console limit exceeded');
    append(stream, decoders[stream].decode(bytes, { stream: true }));
  } });
  try {
    if (data.operation !== 'run' || !(data.component instanceof Uint8Array)) throw Error('Invalid guest run request');
    if (data.componentContract !== 'command') throw Error('Invalid guest component contract');
    const symbols = readSymbols(data.symbols);
    const timeZone = data.timeZone ?? 'UTC';
    if (typeof timeZone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(timeZone) ||
        typeof (data.localTime ?? false) !== 'boolean') throw Error('Invalid guest time zone');
    // Time zone data is fetched only for a program that reaches local time in another zone.
    const mountsTimeZone = data.localTime === true && timeZone !== 'UTC' && timeZone !== 'Etc/UTC';
    const args = data.args === undefined ? [] : data.args;
    if (!Array.isArray(args) || (args.length !== 0 &&
        (data.recipe !== 'tunit' || args.length !== 1 || args[0] !== '--list'))) throw Error('Unsupported guest arguments');
    providedArguments = Object.freeze([programName, ...args]);
    const component = data.component.slice();
    if (component.byteLength > maximumComponentBytes)
      throw Error(`Component input limit exceeded (${component.byteLength} > ${maximumComponentBytes})`);
    componentSha256 = await digest(component);
    if (data.sha256 !== undefined && componentSha256 !== data.sha256) throw Error('Component digest mismatch');
    begin('transpile');
    const loader = createAssetLoader(assets => report({ assets }));
    const runtimeManifest = JSON.parse(new TextDecoder().decode(
      await loader.load('compiler/runtime-pack.json')));
    const runtimeTarget = runtimeManifest.targets?.find(target => target.target === 'wasm32');
    const maximumMemorySizeBytes = runtimeTarget?.defaultMaximumMemorySizeBytes;
    if (!Number.isSafeInteger(maximumMemorySizeBytes) || maximumMemorySizeBytes <= 0 ||
        maximumMemorySizeBytes % 65536 !== 0)
      throw Error('Invalid guest memory policy');
    const maximumMemoryPages = maximumMemorySizeBytes / 65536;
    // jco's bootstrap fetches its own Wasm files; verify the complete raw
    // asset graph before imports so those fetches reuse verified cache entries.
    const jcoAssets = Object.keys(await loader.manifest()).filter(name => name.startsWith('jco/'));
    if (!jcoAssets.length) throw Error('Missing trusted jco asset graph');
    const verified = await Promise.allSettled(jcoAssets.map(name => loader.load(name, { javascript: true })));
    const failed = verified.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    loader.installFetchAdapter();
    const { generate } = await import(loader.url('jco/guest-runtime.mjs'));
    const { executeComponent, createWasiPlatform, createWasiFilesystem, createBrowserFileMounts,
      createWasiHttpFetch, projectProviderModuleIdentity, createGuestByteReader, readTimeZoneNames,
      readOptionalStackTraceSymbols } =
      await import(loader.url('jco/guest-host.mjs'));
    const generated = await generate(component, transpileOptions);
    generatedImports = generated.imports;
    if (generated.files.reduce((total, [, bytes]) => total + bytes.byteLength, 0) > 16 * 1048576)
      throw Error('Generated graph limit exceeded');
    const javascript = generated.files.filter(([name]) => name.endsWith('.js'));
    if (javascript.length !== 1 || javascript[0][0] !== 'guest.js') throw Error('Unsupported generated JavaScript graph');
    const files = Object.fromEntries(generated.files);
    graph = await Promise.all(generated.files.map(async ([name, bytes]) => ({ name, bytes: bytes.byteLength, sha256: await digest(bytes) })));
    complete();
    let timeZoneData;
    if (mountsTimeZone) {
      begin('timezone');
      const receipt = JSON.parse(new TextDecoder().decode(await loader.load('timezones/netwasm-timezones.json')));
      timeZoneData = await loader.load(receipt.asset);
      if (!readTimeZoneNames(timeZoneData).has(timeZone)) throw Error(`Time zone '${timeZone}' is not in the IANA time zone data`);
      complete();
    }
    begin('instantiate');
    const environment = [{ name: 'TZ', value: mountsTimeZone ? timeZone : 'UTC' }];
    if (data.recipe === 'http') {
      const address = new URL(data.sampleHttpUrl);
      if (address.origin !== self.location.origin || !address.pathname.endsWith('/example-http.json') ||
          address.search || address.hash) throw Error('Invalid HTTP example URL');
      environment.push({ name: 'PLAYGROUND_HTTP_SAMPLE_URL', value: address.href });
    }
    // HttpClient sends through the worker's fetch; a failed fetch explains a failed run.
    const noteFetchFailure = error => {
      fetchFailure = (error?.message || String(error)).replace(/[.!?]+$/, '').slice(0, 256);
      throw error;
    };
    const guestFetch = (input, init) => {
      try { return Promise.resolve(fetch(input, init)).catch(noteFetchFailure); }
      catch (error) { return noteFetchFailure(error); }
    };
    const network = meterGuestHttpBodies({
      modules: createWasiHttpFetch(Object.freeze({ fetch: guestFetch })),
      readGuestBytes: createGuestByteReader,
      onDenied: message => { httpBudgetFailure = message; },
    });
    // The browser's in-memory file system, as a published NetWasm page has it.
    const mounts = createBrowserFileMounts(Object.freeze({ readBlobSync }));
    filesystem = createWasiFilesystem(Object.freeze({ hostFiles: mounts.hostFiles,
      preopens: Object.freeze([Object.freeze({ access: 'readWrite', guestPath: '/', hostPath: '/' })]) }));
    if (timeZoneData) filesystem.mountReadOnlyFile({ guestPath: sidecarPath('tz-info'), bytes: timeZoneData });
    if (symbols) filesystem.mountReadOnlyFile({ guestPath: sidecarPath('type-symbols'), bytes: symbols.typeSymbols });
    if (symbols?.methodSymbols)
      filesystem.mountReadOnlyFile({ guestPath: sidecarPath('method-symbols'), bytes: symbols.methodSymbols });
    const platform = createWasiPlatform(Object.freeze({ initialDirectory: null, network: Object.freeze({ modules: network }) }))(
      Object.freeze({ arguments: providedArguments, environment, filesystem, grants: Object.freeze({ network: 'allowAll' }),
        signal: null, stdout: sink('stdout'), stderr: sink('stderr'), stdin: null }));
    // jco looks a WASI interface up without its version.
    const imports = Object.fromEntries(Object.entries(platform.imports).map(([module, value]) =>
      [projectProviderModuleIdentity({ module }).componentModule, value]));
    // The component executor supplies NetWasm's reserved diagnostics module itself.
    const unsupported = generatedImports.filter(name => !Object.hasOwn(imports, name) &&
      name !== 'netwasm:diagnostics/terminal' && name !== 'netwasm:diagnostics/terminal@1.0.0');
    if (unsupported.length) throw Error(`Unsupported guest import: ${unsupported.join(', ')}`);
    url = URL.createObjectURL(new Blob([files['guest.js']], { type: 'text/javascript' }));
    const main = await import(url);
    const loadCoreModule = async name => {
      if (!Object.hasOwn(files, name) || !name.endsWith('.wasm')) throw Error(`Missing generated core: ${name}`);
      const module = await WebAssembly.compile(files[name]);
      const memories = checkGuestMemory(files[name], maximumMemorySizeBytes);
      const coreImports = WebAssembly.Module.imports(module);
      if (coreImports.some(item => item.module === 'wasi_snapshot_preview1')) throw Error('Guest Preview 1 imports are unsupported');
      moduleMemories.set(module, memories);
      loaded.push({ name, imports: coreImports, memories });
      return module;
    };
    const instantiateCore = async (module, imports) => {
      const memories = moduleMemories.get(module);
      if (!memories) throw Error('Unverified guest core module');
      const pages = memories.reduce((total, memory) => total + memory.maximumPages, 0);
      if (allocatedMemoryPages + pages > maximumMemoryPages) throw Error('Guest memory limit exceeded (aggregate)');
      allocatedMemoryPages += pages; coreInstances++;
      // Core start functions can execute during instantiation. Start the outer
      // execution deadline before allowing any guest core code to run.
      enter();
      return WebAssembly.instantiate(module, imports);
    };
    const adapter = createCommandAdapter(main, () => {
      if (loaded.length !== generated.files.filter(([name]) => name.endsWith('.wasm')).length)
        throw Error('Generated core graph was not fully resolved');
      complete(); begin('execute'); enter();
    });
    const outcome = await executeComponent({ contractKey, adapter, imports, loadCoreModule, instantiateCore,
      releaseActions: [Object.freeze({ phase: 'output', code: 'host.platform-output',
        message: 'The execution host could not deliver application output.', release: () => platform.release() })],
      ...(symbols ? {
        diagnosticArtifacts: () => ({ typeSymbols: symbols.typeSymbols }),
        stackTraceSymbols: readOptionalStackTraceSymbols(symbols.methodSymbols),
        managedExceptionReporting: { reportEnriched: event => append('stderr',
          unhandledExceptionText(event.typeName, event.message, event.stackTrace)) },
      } : {}) });
    complete(); finishOutput();
    const failureContext = httpBudgetFailure ?? (fetchFailure && outcome.completionKind === 'managedFailure'
      ? `A browser Fetch request also failed: ${fetchFailure}. Check the URL, network access and CORS policy.`
      : undefined);
    // The executor reports what failed and, separately, why: a trap, a missing import or
    // the worker's own memory limit.
    const failure = outcome.primaryFailure && (outcome.primaryFailure.detail
      ? `${outcome.primaryFailure.message} ${outcome.primaryFailure.detail}` : outcome.primaryFailure.message);
    return { success: outcome.completionKind === 'normal', exitCode: outcome.exitCode,
      error: failureContext ? `${failure ?? 'The managed process failed.'} ${failureContext}` : failure,
      stage: outcome.primaryFailure?.phase,
      executionResult: outcome, ...output, consoleBytes, providedArguments, componentSha256,
      graph, loaded, memoryMaximumBytes: allocatedMemoryPages * 65536, coreInstances, imports: generatedImports, timings };
  } catch (error) {
    complete();
    finishOutput();
    return { success: false, ...output, error: errorText(error), stage,
      code: running ? 'guest-trap' : 'guest-failure', consoleBytes, componentSha256,
      graph, loaded, memoryMaximumBytes: allocatedMemoryPages * 65536, coreInstances, imports: generatedImports, timings, recoverable: true };
  } finally { await filesystem?.dispose(); if (url) URL.revokeObjectURL(url); }
});
