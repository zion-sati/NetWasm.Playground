import { createAssetLoader, serveWorker, digest, errorText } from './asset-loader.mjs';

const allowedImports = ['wasi:cli/environment', 'wasi:cli/exit', 'wasi:cli/stderr',
  'wasi:cli/stdout', 'wasi:io/error', 'wasi:io/streams'];

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
    const component = data.component.slice();
    if (component.byteLength > 1048576) throw Error('Component input limit exceeded');
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
    const [jco, cliModule, io] = await Promise.all([
      import(loader.url('jco/browser.js')), import(loader.url('jco/preview2/cli.js')),
      import(loader.url('jco/preview2/io.js')),
    ]);
    const generated = await jco.generate(component, { name: 'guest', instantiation: { tag: 'async' },
      noTypescript: true, noNodejsCompat: true, base64Cutoff: 0, bindgenEnableWasmExnref: true });
    generatedImports = generated.imports;
    if (generatedImports.some(name => !allowedImports.includes(name)))
      throw Error(`Unsupported guest import: ${generatedImports.filter(name => !allowedImports.includes(name)).join(', ')}`);
    if (generated.files.reduce((total, [, bytes]) => total + bytes.byteLength, 0) > 8388608)
      throw Error('Generated graph limit exceeded');
    const javascript = generated.files.filter(([name]) => name.endsWith('.js'));
    if (javascript.length !== 1 || javascript[0][0] !== 'guest.js') throw Error('Unsupported generated JavaScript graph');
    const files = Object.fromEntries(generated.files);
    graph = await Promise.all(generated.files.map(async ([name, bytes]) => ({ name, bytes: bytes.byteLength, sha256: await digest(bytes) })));
    complete();
    begin('instantiate');
    const cli = cliModule.createCli({ arguments: [], environment: {}, initialCwd: '/',
      stdout: capture('stdout'), stderr: capture('stderr') });
    // Each WASI getter returns an owned stream. Dropping one write's handle
    // must not close the stream returned by a later Console.WriteLine.
    const imports = { 'wasi:cli/environment': cli.environment, 'wasi:cli/exit': cli.exit,
      'wasi:cli/stderr': { getStderr: () => io.outputStreamCreate(capture('stderr')) },
      'wasi:cli/stdout': { getStdout: () => io.outputStreamCreate(capture('stdout')) },
      'wasi:io/error': io.error, 'wasi:io/streams': io.streams };
    url = URL.createObjectURL(new Blob([files['guest.js']], { type: 'text/javascript' }));
    const main = await import(url);
    const guest = await main.instantiate(async name => {
      if (!Object.hasOwn(files, name) || !name.endsWith('.wasm')) throw Error(`Missing generated core: ${name}`);
      const module = await WebAssembly.compile(files[name]);
      const coreImports = WebAssembly.Module.imports(module);
      if (coreImports.some(item => item.module === 'wasi_snapshot_preview1')) throw Error('Guest Preview 1 imports are unsupported');
      loaded.push({ name, imports: coreImports });
      return module;
    }, imports);
    if (loaded.length !== generated.files.filter(([name]) => name.endsWith('.wasm')).length)
      throw Error('Generated core graph was not fully resolved');
    const command = guest['wasi:cli/run@0.2.11'];
    if (!command || typeof command.run !== 'function') throw Error('Missing guest command export');
    complete();
    begin('execute');
    running = true;
    report({ guestEntered: true });
    let exitCode = 0;
    try { command.run(); }
    catch (error) {
      if (error?.exitError) exitCode = error.code;
      else if (Object.hasOwn(error ?? {}, 'payload') && error.payload === undefined) exitCode = 1;
      else throw error;
    }
    complete();
    finishOutput();
    return { success: true, exitCode, ...output, consoleBytes, providedArguments: cli.environment.getArguments(),
      componentSha256, graph, loaded, imports: generatedImports, timings };
  } catch (error) {
    complete();
    finishOutput();
    return { success: false, ...output, error: errorText(error), stage,
      code: running ? 'guest-trap' : 'guest-failure', consoleBytes, componentSha256,
      graph, loaded, imports: generatedImports, timings, recoverable: true };
  } finally { if (url) URL.revokeObjectURL(url); }
});
