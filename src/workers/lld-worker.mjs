import { createAssetLoader, serveWorker } from './asset-loader.mjs';
let report = () => {}, initialized;
const loader = createAssetLoader(assets => report({ assets }));
async function initialize() {
  return initialized ??= (async () => {
    await loader.verifyGraph('lld/');
    const [{ default: factory }, { createBrowserLld }] = await Promise.all([
      import(loader.url('lld/netwasm-browser-lld.mjs')), import(loader.url('lld/netwasm-lld.mjs')),
    ]);
    const wasm = await loader.load('lld/netwasm-browser-lld.wasm');
    return createBrowserLld(options => factory({ ...options, wasmBinary: wasm.slice() }));
  })().catch(error => { initialized = undefined; throw error; });
}
serveWorker(async (data, emit) => {
  report = emit;
  if (data.operation !== 'link' && data.operation !== 'initialize') throw Error('Unsupported linker operation');
  if (data.operation === 'initialize') { await initialize(); return { success: true }; }
  const plan = structuredClone(data.plan);
  if (!Array.isArray(plan?.Inputs) || plan.Inputs.length > 128 || !Array.isArray(plan.Arguments)) throw Error('Invalid runtime link plan');
  const files = {};
  for (const input of plan.Inputs) {
    if (typeof input.Path !== 'string' || !input.Path.startsWith('/netwasm-link/runtime/')) throw Error('Invalid runtime input path');
    const name = `runtime/${input.Path.slice('/netwasm-link/runtime/'.length)}`;
    const entry = (await loader.manifest())[name];
    if (!entry || entry.sha256 !== input.Sha256) throw Error('Runtime plan asset integrity mismatch');
    files[input.Path] = await loader.load(name);
  }
  const outputIndex = plan.Arguments.indexOf('-o');
  const outputPath = plan.OutputPath ?? plan.Arguments[outputIndex + 1];
  if (outputIndex < 0 || typeof outputPath !== 'string') throw Error('Missing runtime output path');
  const linker = await initialize();
  report({ stage: 'link' });
  return linker.link({ arguments: plan.Arguments, files, outputPath });
});
