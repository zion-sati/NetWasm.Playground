// Trusted tool probe. This Preview 1 adapter is never supplied to user programs.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const outputLimit = 65536;
const inputLimit = 1048576;
let manifest, shim, wasmTools;
let busy = false;
let activeRequestId;
async function verified(name) {
  const response = await fetch(name);
  if (!response.ok) throw new Error(`Asset ${name}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
  if (digest !== manifest[name].sha256) throw new Error(`Asset ${name}: SHA-256 mismatch`);
  return bytes;
}
async function initialize() {
  manifest = await (await fetch('assets.json')).json();
  // Verify the whole shim module graph before its static browser import.
  for (const name of Object.keys(manifest).filter(x => x.startsWith('wasi-shim/') && x.endsWith('.js'))) await verified(name);
  shim = await import('./wasi-shim/index.js');
  wasmTools = await WebAssembly.compile(await verified('wasm-tools.wasm'));
  return { imports: WebAssembly.Module.imports(wasmTools) };
}
function capture() {
  let stdout = '', stderr = '', count = 0;
  const append = stream => bytes => {
    count += bytes.byteLength;
    if (count > outputLimit) throw new Error('Tool console limit exceeded');
    if (stream === 'stdout') stdout += decoder.decode(bytes);
    else stderr += decoder.decode(bytes);
  };
  return { append, result: () => ({ stdout, stderr, consoleBytes: count }) };
}
async function wasiRun(args, files, outputs) {
  const log = capture();
  const root = new shim.PreopenDirectory('.', Object.entries(files).map(([name, bytes]) => [name, new shim.File(bytes)]));
  const wasi = new shim.WASI(['wasm-tools', ...args], [], [new shim.OpenFile(new shim.File([])), new shim.ConsoleStdout(log.append('stdout')), new shim.ConsoleStdout(log.append('stderr')), root]);
  const calls = {};
  const imports = Object.fromEntries(Object.entries(wasi.wasiImport).map(([name, fn]) => [name, (...argv) => {
    calls[name] = (calls[name] || 0) + 1;
    return fn(...argv);
  }]));
  const instance = await WebAssembly.instantiate(wasmTools, { wasi_snapshot_preview1: imports });
  self.postMessage({ id: activeRequestId, toolEntered: true });
  const exitCode = wasi.start(instance);
  const result = {};
  if (exitCode === 0) for (const name of outputs) {
    const file = root.dir.contents.get(name);
    if (!file || !(file instanceof shim.File)) throw new Error(`Missing output ${name}`);
    result[name] = Array.from(file.data);
  }
  return { exitCode, files: result, memoryBytes: instance.exports.memory.buffer.byteLength, calls, ...log.result() };
}
async function binaryenRun(tool, args, files, outputs) {
  const log = capture();
  let source = decoder.decode(await verified(`${tool}.js`)).replace(/^#![^\n]*\n/, '');
  const pathModule = { exports: {} };
  new Function('module', 'exports', 'process', decoder.decode(await verified('path-browserify.js')))(pathModule, pathModule.exports, { cwd: () => '/' });
  const pathNeedle = 'var nodePath=require("node:path");';
  const start = source.indexOf('if(!ENVIRONMENT_IS_NODE){throw new Error("NODERAWFS');
  const end = source.indexOf('{if(Module["noExitRuntime"])', start);
  if (source.split(pathNeedle).length !== 2 || start < 0 || end <= start) throw new Error('Pinned Binaryen bootstrap shape changed');
  source = source.slice(0, start) + source.slice(end);
  source = source.replace(pathNeedle, 'var nodePath=Module.browserPath;');
  // The pinned CLI has no public FS/callMain export. A closure exposes its
  // actual CLI entry and MEMFS without modifying command semantics or Wasm.
  const factory = new Function('Module', `${source}\nreturn { ready: new Promise(resolve => Module.onRuntimeInitialized = () => resolve({ FS, callMain, memory: () => wasmMemory.buffer.byteLength, exit: () => EXITSTATUS })) };`);
  const module = factory({ browserPath: pathModule.exports, noInitialRun: true, print: x => log.append('stdout')(encoder.encode(x + '\n')), printErr: x => log.append('stderr')(encoder.encode(x + '\n')) });
  const runtime = await module.ready;
  for (const [name, bytes] of Object.entries(files)) runtime.FS.writeFile(name, bytes);
  let exitCode, failure;
  try { exitCode = runtime.callMain([...args]); }
  catch (error) { exitCode = runtime.exit() ?? 1; failure = String(error); }
  const result = {};
  if (exitCode === 0) for (const name of outputs) result[name] = Array.from(runtime.FS.readFile(name));
  for (const name of [...Object.keys(files), ...outputs]) { try { runtime.FS.unlink(name); } catch {} }
  return { exitCode, failure, files: result, memoryBytes: runtime.memory(), ...log.result() };
}
let jco;
async function jcoRun(files) {
  if (!jco) {
    for (const name of Object.keys(manifest).filter(x => x.startsWith('jco/'))) await verified(name);
    jco = await import('./jco/browser.js');
  }
  const generated = await jco.generate(files['component.wasm'], {
    name: 'small', instantiation: { tag: 'async' }, noTypescript: true,
    noNodejsCompat: true, base64Cutoff: 0,
  });
  const resultFiles = Object.fromEntries(generated.files);
  const script = resultFiles['small.js'];
  if (!script) throw new Error('Missing generated browser module');
  // This fixture has one JS module and no component imports. A general module
  // graph resolver and guest Preview 2 import policy remain future work.
  if (generated.imports.length) throw new Error('Unexpected fixture imports');
  const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
  try {
    const module = await import(url);
    const exports = await module.instantiate(async name => {
      const bytes = resultFiles[name];
      if (!bytes) throw new Error(`Missing generated core ${name}`);
      return WebAssembly.compile(bytes);
    }, {});
    return { files: Object.fromEntries(generated.files.map(([name, bytes]) => [name, Array.from(bytes)])), imports: generated.imports, exports: generated.exports, answer: exports.answer() };
  } finally { URL.revokeObjectURL(url); }
}
self.onmessage = async event => {
  const { id, operation, args = [], files = {}, outputs = [] } = event.data;
  if (busy) { self.postMessage({ id, error: 'Busy' }); return; }
  busy = true;
  activeRequestId = id;
  self.postMessage({ id, started: true });
  const started = performance.now();
  try {
    let result;
    if (operation === 'initialize') result = await initialize();
    else {
      const bytes = Object.fromEntries(Object.entries(files).map(([name, value]) => {
        if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Invalid virtual filename');
        return [name, Uint8Array.from(value)];
      }));
      if (Object.values(bytes).reduce((n, x) => n + x.length, 0) > inputLimit) throw new Error('Tool input limit exceeded');
      if (operation === 'jco') result = await jcoRun(bytes);
      else if (operation === 'wasm-tools') result = await wasiRun(args, bytes, outputs);
      else if (operation === 'wasm-merge' || operation === 'wasm-opt') result = await binaryenRun(operation, args, bytes, outputs);
      else throw new Error('Unknown operation');
    }
    self.postMessage({ id, operation, result, elapsedMs: performance.now() - started });
  } catch (error) { self.postMessage({ id, operation, error: String(error), elapsedMs: performance.now() - started }); }
  finally { busy = false; }
};
