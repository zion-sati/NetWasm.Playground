import { createAssetLoader, serveWorker } from './asset-loader.mjs';
let report = () => {}, initialized;
const loader = createAssetLoader(assets => report({ assets }));
async function initialize() {
  return initialized ??= (async () => {
    await loader.verifyGraph('lld/');
    loader.installFetchAdapter();
    const { factory, createBrowserLld } = await import(loader.url('lld/lld-runtime.mjs'));
    const wasm = await loader.load('lld/netwasm-browser-lld.wasm');
    return createBrowserLld(options => factory({ ...options, wasmBinary: wasm.slice() }));
  })().catch(error => { initialized = undefined; throw error; });
}
serveWorker(async (data, emit) => {
  report = emit;
  if (data.operation !== 'link' && data.operation !== 'initialize') throw Error('Unsupported linker operation');
  if (data.operation === 'initialize') { await initialize(); return { success: true }; }
  const plan = structuredClone(data.plan);
  if (!Array.isArray(plan?.Inputs) || plan.Inputs.length > 128 || !Array.isArray(plan.Arguments) ||
      !Array.isArray(plan.OptimizationArguments)) throw Error('Invalid runtime link plan');
  const files = {};
  const supplied = data.files && typeof data.files === 'object' && !Array.isArray(data.files)
    ? data.files : {};
  const suppliedNames = Object.keys(supplied);
  if (suppliedNames.length > 16 || suppliedNames.some(path =>
    !/^\/netwasm-link\/user-native\/archive-[0-9]+\.a$/.test(path) ||
    !(supplied[path] instanceof Uint8Array) || supplied[path].byteLength > 8 * 1048576))
    throw Error('Invalid caller-supplied linker input');
  const usedSupplied = new Set();
  for (const input of plan.Inputs) {
    if (typeof input.Path !== 'string') throw Error('Invalid runtime input path');
    if (input.Path.startsWith('/netwasm-link/runtime/')) {
      const name = `runtime/${input.Path.slice('/netwasm-link/runtime/'.length)}`;
      const entry = (await loader.manifest())[name];
      if (!entry || entry.sha256 !== input.Sha256) throw Error('Runtime plan asset integrity mismatch');
      files[input.Path] = await loader.load(name);
      continue;
    }
    const bytes = supplied[input.Path];
    if (!bytes) throw Error('Selected native archive was not supplied');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
    const actual = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== input.Sha256.toLowerCase()) throw Error('Native archive integrity mismatch');
    usedSupplied.add(input.Path);
    files[input.Path] = bytes.slice();
  }
  if (usedSupplied.size !== suppliedNames.length) throw Error('Unused native archive was supplied to the linker');
  const outputIndex = plan.Arguments.indexOf('-o');
  const outputPath = plan.OutputPath ?? plan.Arguments[outputIndex + 1];
  if (outputIndex < 0 || typeof outputPath !== 'string') throw Error('Missing runtime output path');
  const linker = await initialize();
  report({ stage: 'link' });
  return linker.link({ arguments: plan.Arguments, files, outputPath });
});
