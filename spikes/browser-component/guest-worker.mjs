const encoder = new TextEncoder();
const allowedImports = ['wasi:cli/environment', 'wasi:cli/exit', 'wasi:cli/stderr',
  'wasi:cli/stdout', 'wasi:io/error', 'wasi:io/streams'];
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
let initialized;
async function initialize() {
  if (!initialized) initialized = (async () => {
    const manifest = await (await fetch('./tools/assets.json')).json();
    for (const [name, expected] of Object.entries(manifest).filter(([name]) => name.startsWith('jco/'))) {
      const response = await fetch(`./tools/${name}`);
      if (!response.ok) throw new Error(`Tool asset: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== expected.bytes || await digest(bytes) !== expected.sha256)
        throw new Error('Tool asset hash mismatch');
    }
    return { jco: await import('./tools/jco/browser.js'),
      cli: await import('./tools/jco/preview2/cli.js'), io: await import('./tools/jco/preview2/io.js') };
  })();
  return initialized;
}
let busy = false;
self.onmessage = async ({ data }) => {
  if (busy) { self.postMessage({ id: data.id, error: 'Guest worker busy' }); return; }
  busy = true;
  let url;
  let running = false;
  const stages = [];
  try {
    const component = new Uint8Array(data.component);
    if (component.length > 1048576) throw new Error('Component input limit exceeded');
    if (await digest(component) !== data.sha256) throw new Error('Component digest mismatch');
    const { jco, cli: cliModule, io } = await initialize();
    let started = performance.now();
    const generated = await jco.generate(component, { name: 'guest', instantiation: { tag: 'async' },
      noTypescript: true, noNodejsCompat: true, base64Cutoff: 0, bindgenEnableWasmExnref: true });
    stages.push({ name: 'generate', milliseconds: performance.now() - started });
    if (generated.imports.some(name => !allowedImports.includes(name)))
      throw new Error(`Unsupported guest import: ${generated.imports.filter(name => !allowedImports.includes(name)).join(', ')}`);
    const files = Object.fromEntries(generated.files);
    if (generated.files.reduce((total, [, bytes]) => total + bytes.length, 0) > 8388608)
      throw new Error('Generated graph limit exceeded');
    const javascript = generated.files.filter(([name]) => name.endsWith('.js'));
    if (javascript.length !== 1 || javascript[0][0] !== 'guest.js')
      throw new Error('Unsupported generated JavaScript graph');
    const graph = await Promise.all(generated.files.map(async ([name, bytes]) =>
      ({ name, bytes: bytes.length, sha256: await digest(bytes) })));
    const captures = { stdout: [], stderr: [] };
    let consoleBytes = 0;
    const capture = stream => ({ write(bytes) {
      consoleBytes += bytes.length;
      if (consoleBytes > 65536) throw new Error('Guest console limit exceeded');
      captures[stream].push(bytes.slice());
      self.postMessage({ id: data.id, console: stream, bytes: bytes.slice() });
    }, flush() {} });
    const cli = cliModule.createCli({ arguments: [...(data.arguments ?? [])], environment: {},
      initialCwd: '/', stdout: capture('stdout'), stderr: capture('stderr') });
    const imports = { 'wasi:cli/environment': cli.environment, 'wasi:cli/exit': cli.exit,
      'wasi:cli/stderr': cli.stderr, 'wasi:cli/stdout': cli.stdout,
      'wasi:io/error': io.error, 'wasi:io/streams': io.streams };
    url = URL.createObjectURL(new Blob([files['guest.js']], { type: 'text/javascript' }));
    const main = await import(url);
    const loaded = [];
    started = performance.now();
    const guest = await main.instantiate(async name => {
      if (!Object.hasOwn(files, name) || !name.endsWith('.wasm')) throw new Error(`Missing generated core: ${name}`);
      const module = await WebAssembly.compile(files[name]);
      const coreImports = WebAssembly.Module.imports(module);
      if (coreImports.some(item => item.module === 'wasi_snapshot_preview1'))
        throw new Error('Guest Preview 1 imports are unsupported');
      loaded.push({ name, imports: coreImports }); return module;
    }, imports);
    stages.push({ name: 'instantiate', milliseconds: performance.now() - started });
    if (loaded.length !== generated.files.filter(([name]) => name.endsWith('.wasm')).length)
      throw new Error('Generated core graph was not fully resolved');
    const command = guest['wasi:cli/run@0.2.11'];
    if (!command || typeof command.run !== 'function') throw new Error('Missing guest command export');
    started = performance.now();
    let exitCode = 0;
    running = true;
    self.postMessage({ id: data.id, guestEntered: true });
    try { command.run(); }
    catch (error) {
      if (error?.exitError) exitCode = error.code;
      else if (Object.hasOwn(error ?? {}, 'payload') && error.payload === undefined) exitCode = 1;
      else throw error;
    }
    stages.push({ name: 'run', milliseconds: performance.now() - started });
    const text = stream => new TextDecoder().decode(Uint8Array.from(captures[stream].flatMap(bytes => Array.from(bytes))));
    self.postMessage({ id: data.id, result: { success: true, exitCode, stdout: text('stdout'), stderr: text('stderr'),
      consoleBytes, providedArguments: cli.environment.getArguments(), componentSha256: data.sha256,
      graph, loaded, imports: generated.imports, stages } });
  } catch (error) {
    self.postMessage({ id: data.id, result: { success: false, stage: running ? 'execution' : 'guest', code: running ? 'guest-trap' : 'guest-failure',
      error: String(error).slice(0, 4096), stages, recoverable: true } });
  } finally { if (url) URL.revokeObjectURL(url); busy = false; }
};
