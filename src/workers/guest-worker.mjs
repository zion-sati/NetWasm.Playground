import { checkGuestMemory } from './guest-memory.mjs';
import { installGuestHttpBudget } from './guest-http-budget.mjs';
import { createAssetLoader, serveWorker, digest, errorText } from './asset-loader.mjs';

// The structured logging example produces a measured 4.12 MiB component.
const maximumComponentBytes = 5 * 1048576;

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
  let componentSha256;
  let filesystem;
  let restoreHttpBudget;
  let httpBudgetFailure;
  let previousFetch;
  let fetchFailure;
  const moduleMemories = new WeakMap();
  let allocatedMemoryPages = 0;
  let coreInstances = 0;
  function begin(next) { stage = next; started = performance.now(); report({ stage: next }); }
  function complete() {
    if (started !== undefined) { timings.push({ stage, milliseconds: performance.now() - started }); started = undefined; }
  }
  function append(stream, text) { output[stream] += text; if (text) report({ console: stream, text }); }
  function finishOutput() { for (const stream of ['stdout', 'stderr']) append(stream, decoders[stream].decode()); }
  const capture = stream => ({ write(bytes) {
    if (!(bytes instanceof Uint8Array)) throw Error('Invalid guest console bytes');
    consoleBytes += bytes.byteLength;
    if (consoleBytes > 65536) throw Error('Guest console limit exceeded');
    append(stream, decoders[stream].decode(bytes, { stream: true }));
  }, flush() {} });
  try {
    if (data.operation !== 'run' || !(data.component instanceof Uint8Array)) throw Error('Invalid guest run request');
    if (!['command', 'async-command'].includes(data.componentContract)) throw Error('Invalid guest component contract');
    const managedProcess = data.componentContract === 'async-command';
    const args = data.args === undefined ? [] : data.args;
    if (!Array.isArray(args) || (args.length !== 0 &&
        (data.recipe !== 'tunit' || args.length !== 1 || args[0] !== '--list'))) throw Error('Unsupported guest arguments');
    const argumentsSnapshot = args.slice();
    const component = data.component.slice();
    if (component.byteLength > maximumComponentBytes)
      throw Error(`Component input limit exceeded (${component.byteLength} > ${maximumComponentBytes})`);
    componentSha256 = await digest(component);
    if (data.sha256 !== undefined && componentSha256 !== data.sha256) throw Error('Component digest mismatch');
    begin('transpile');
    const loader = createAssetLoader(assets => report({ assets }));
    // jco's bootstrap fetches its own Wasm files; verify the complete raw
    // asset graph before imports so those fetches reuse verified cache entries.
    const jcoAssets = Object.keys(await loader.manifest()).filter(name => name.startsWith('jco/'));
    if (!jcoAssets.length) throw Error('Missing trusted jco asset graph');
    const verified = await Promise.allSettled(jcoAssets.map(name => loader.load(name, { javascript: true })));
    const failed = verified.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    loader.installFetchAdapter();
    const { jco, executeComponent } = await import(loader.url('jco/guest-runtime.mjs'));
    const { cliModule, io, clockModule, filesystemModule, httpModule, randomModule } =
      await import(loader.url('jco/guest-providers.mjs'));
    restoreHttpBudget = installGuestHttpBudget(httpModule, message => { httpBudgetFailure = message; });
    const generated = await jco.generate(component, { name: 'guest', instantiation: { tag: 'async' },
      noTypescript: true, noNodejsCompat: true, base64Cutoff: 0, bindgenEnableWasmExnref: true });
    generatedImports = generated.imports;
    if (generated.files.reduce((total, [, bytes]) => total + bytes.byteLength, 0) > 8388608)
      throw Error('Generated graph limit exceeded');
    const javascript = generated.files.filter(([name]) => name.endsWith('.js'));
    if (javascript.length !== 1 || javascript[0][0] !== 'guest.js') throw Error('Unsupported generated JavaScript graph');
    const files = Object.fromEntries(generated.files);
    graph = await Promise.all(generated.files.map(async ([name, bytes]) => ({ name, bytes: bytes.byteLength, sha256: await digest(bytes) })));
    complete();
    begin('instantiate');
    const environment = { TZ: 'UTC' };
    if (data.recipe === 'http') {
      const address = new URL(data.sampleHttpUrl);
      if (address.origin !== self.location.origin || !address.pathname.endsWith('/example-http.json') ||
          address.search || address.hash) throw Error('Invalid HTTP example URL');
      environment.PLAYGROUND_HTTP_SAMPLE_URL = address.href;
    }
    const cli = cliModule.createCli({ arguments: argumentsSnapshot, environment, initialCwd: '/',
      stdout: capture('stdout'), stderr: capture('stderr') });
    if (data.recipe === 'http') {
      previousFetch = self.fetch;
      const noteFetchFailure = error => {
        fetchFailure = (error?.message || String(error)).replace(/[.!?]+$/, '').slice(0, 256);
        throw error;
      };
      self.fetch = (...arguments_) => {
        try { return Promise.resolve(previousFetch.apply(self, arguments_)).catch(noteFetchFailure); }
        catch (error) { return noteFetchFailure(error); }
      };
    }
    filesystem = filesystemModule.createFilesystem({
      adapter: new filesystemModule.InMemoryFilesystemAdapter(), preopens: {} });
    // Each WASI getter returns an owned stream. Dropping one write's handle
    // must not close the stream returned by a later Console.WriteLine.
    const imports = { 'wasi:cli/environment': cli.environment, 'wasi:cli/exit': cli.exit,
      'wasi:cli/stdin': cli.stdin,
      'wasi:cli/stderr': { getStderr: () => io.outputStreamCreate(capture('stderr')) },
      'wasi:cli/stdout': { getStdout: () => io.outputStreamCreate(capture('stdout')) },
      'wasi:cli/terminal-stderr': cli.terminalStderr,
      'wasi:cli/terminal-stdin': cli.terminalStdin,
      'wasi:cli/terminal-stdout': cli.terminalStdout,
      'wasi:io/error': io.error, 'wasi:io/streams': io.streams, 'wasi:io/poll': io.poll,
      'wasi:clocks/monotonic-clock': clockModule.monotonicClock,
      'wasi:clocks/wall-clock': clockModule.wallClock,
      'wasi:filesystem/preopens': filesystem.preopens,
      'wasi:filesystem/types': filesystem.types,
      'wasi:http/outgoing-handler': httpModule.outgoingHandler,
      'wasi:http/types': httpModule.types,
      'wasi:random/insecure-seed': randomModule.insecureSeed,
      'wasi:random/insecure': randomModule.insecure,
      'wasi:random/random': randomModule.random };
    const permittedImports = managedProcess ? [...Object.keys(imports), 'netwasm:runtime/reactor-host']
      : Object.keys(imports);
    const unsupported = generatedImports.filter(name => !permittedImports.includes(name));
    if (unsupported.length) throw Error(`Unsupported guest import: ${unsupported.join(', ')}`);
    url = URL.createObjectURL(new Blob([files['guest.js']], { type: 'text/javascript' }));
    const main = await import(url);
    const loadCoreModule = async name => {
      if (!Object.hasOwn(files, name) || !name.endsWith('.wasm')) throw Error(`Missing generated core: ${name}`);
      const module = await WebAssembly.compile(files[name]);
      const memories = checkGuestMemory(files[name]);
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
      if (allocatedMemoryPages + pages > 4096) throw Error('Guest memory limit exceeded (256 MiB total)');
      allocatedMemoryPages += pages; coreInstances++;
      // Core start functions can execute during instantiation. Start the outer
      // execution deadline before allowing any guest core code to run.
      if (!running) { running = true; report({ guestEntered: true }); }
      return WebAssembly.instantiate(module, imports);
    };
    const checkCoreGraph = () => {
      if (loaded.length !== generated.files.filter(([name]) => name.endsWith('.wasm')).length)
        throw Error('Generated core graph was not fully resolved');
    };
    if (managedProcess) {
      // The public executor owns reactor watch/cancel, wake delivery, process
      // observation and cleanup. Guest imports cannot inject its reactor host.
      const contractKey = 'netwasm:runtime/process@1.0.0';
      const adapter = Object.freeze({ contractKey, async instantiate(request) {
        const root = await main.instantiate(request.loadCoreModule, request.imports, request.instantiateCore);
        checkCoreGraph();
        complete(); begin('execute'); running = true; report({ guestEntered: true });
        return Object.freeze({ process: root.process, reactorGuest: root.reactorGuest });
      } });
      const outcome = await executeComponent({ contractKey, adapter, loadCoreModule, instantiateCore,
        imports: { ...imports, 'wasi:io/poll': io.poll,
          'wasi:clocks/monotonic-clock': clockModule.monotonicClock } });
      complete(); finishOutput();
      const failureContext = httpBudgetFailure ?? (fetchFailure && outcome.completionKind === 'managedFailure'
        ? `A browser Fetch request also failed: ${fetchFailure}. Check the URL, network access and CORS policy.`
        : undefined);
      const failure = outcome.primaryFailure?.message;
      return { success: outcome.completionKind === 'normal', exitCode: outcome.exitCode,
        error: failureContext ? `${failure ?? 'The managed process failed.'} ${failureContext}` : failure,
        stage: outcome.primaryFailure?.phase,
        executionResult: outcome, ...output, consoleBytes,
        providedArguments: cli.environment.getArguments(), componentSha256,
        graph, loaded, memoryMaximumBytes: allocatedMemoryPages * 65536, coreInstances, imports: generatedImports, timings };
    }
    const guest = await main.instantiate(loadCoreModule, imports, instantiateCore);
    checkCoreGraph();
    const command = guest['wasi:cli/run@0.2.11'];
    if (!command || typeof command.run !== 'function') throw Error('Missing guest command export');
    complete();
    begin('execute');
    running = true;
    report({ guestEntered: true });
    let exitCode = 0;
    try { await command.run(); }
    catch (error) {
      if (error?.exitError) exitCode = error.code;
      else if (Object.hasOwn(error ?? {}, 'payload') && error.payload === undefined) exitCode = 1;
      else throw error;
    }
    complete();
    finishOutput();
    return { success: true, exitCode, ...output, consoleBytes, providedArguments: cli.environment.getArguments(),
      componentSha256, graph, loaded, memoryMaximumBytes: allocatedMemoryPages * 65536, coreInstances, imports: generatedImports, timings };
  } catch (error) {
    complete();
    finishOutput();
    return { success: false, ...output, error: errorText(error), stage,
      code: running ? 'guest-trap' : 'guest-failure', consoleBytes, componentSha256,
      graph, loaded, memoryMaximumBytes: allocatedMemoryPages * 65536, coreInstances, imports: generatedImports, timings, recoverable: true };
  } finally { restoreHttpBudget?.(); if (previousFetch) self.fetch = previousFetch;
    filesystem?.dispose(); if (url) URL.revokeObjectURL(url); }
});
