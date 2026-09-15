import { createAssetLoader, serveWorker, toBase64, fromBase64 } from './asset-loader.mjs';
let report = () => {}, initialized;
const loader = createAssetLoader(assets => report({ assets }));
async function initialize() {
  return initialized ??= (async () => {
    report({ stage: 'compiler-initialize' });
    await loader.verifyGraph('compiler/_framework/');
    // .NET 10's dotnet.js distinguishes sidecars from runtime threads using
    // onmessage at import time. Our lazy protocol already installed onmessage.
    globalThis.dotnetSidecar = true;
    const { dotnet } = await import(loader.url('compiler/_framework/dotnet.js'));
    const runtime = await dotnet.withResourceLoader((type, name) => {
      const path = `compiler/_framework/${name}`;
      // .NET imports JavaScript itself and requires a URL string for that branch.
      if (type === 'dotnetjs' || (type === 'manifest' && name.endsWith('.js'))) return loader.url(path);
      return loader.load(path).then(bytes => new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } }));
    }).create();
    runtime.setModuleImports('compiler-progress', { reportStage: stage => report({ stage }) });
    const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
    const program = exports.NetWasm.Playground.CompilerProbe.Program;
    program.EnableProgress();
    const loaded = await Promise.allSettled([
      loader.load('compiler/target-reference.dll').then(toBase64),
      loader.load('compiler/support.json').then(bytes => new TextDecoder().decode(bytes)),
      loader.load('compiler/target-implementation.dll').then(toBase64),
      loader.load('compiler/compiler-wit.json').then(bytes => new TextDecoder().decode(bytes)),
      loader.load('compiler/compiler.wit.wasm').then(toBase64),
      loader.load('compiler/runtime-pack.json').then(bytes => new TextDecoder().decode(bytes)),
    ]);
    const failed = loaded.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    return { runtime, program, inputs: loaded.map(result => result.value) };
  })().catch(error => { initialized = undefined; throw error; });
}
serveWorker(async (data, emit) => {
  report = emit;
  if (data.operation !== 'compile' && data.operation !== 'prune' && data.operation !== 'initialize') throw Error('Unsupported compiler operation');
  if (data.operation === 'compile' && (data.recipe !== 'hello' || typeof data.source !== 'string' || new TextEncoder().encode(data.source).length > 65536)) throw Error('Invalid compiler source or recipe');
  const module = data.operation === 'prune' ? (() => {
    if (!(data.module instanceof Uint8Array) || data.module.length > 1048576 || typeof data.prefix !== 'string' || data.prefix.length > 255) throw Error('Invalid export pruning request');
    return data.module.slice();
  })() : undefined;
  const { runtime, program, inputs } = await initialize();
  if (data.operation === 'initialize') return { success: true };
  if (module) return { module: fromBase64(program.RetainComponentExports(toBase64(module), data.prefix)) };
  const result = JSON.parse(program.Compile(data.source, ...inputs));
  if (typeof result.application === 'string') result.application = fromBase64(result.application);
  if (typeof result.pe === 'string') result.pe = fromBase64(result.pe);
  result.hostLinearMemoryBytes = runtime.Module?.HEAPU8?.buffer?.byteLength ?? null;
  return result;
});
