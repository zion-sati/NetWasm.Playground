import { createAssetLoader, ownedFiles, serveWorker } from './asset-loader.mjs';
let report = () => {}, initialized;
const loader = createAssetLoader(assets => report({ assets }));
async function initialize() {
  return initialized ??= (async () => {
    const graphs = await Promise.allSettled([loader.verifyGraph('hosts/'), loader.verifyGraph('wasi-shim/')]);
    const failed = graphs.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    const [{ createWasmToolsHost }, { createBinaryenHost }, shim] = await Promise.all([
      import(loader.url('hosts/wasm-tools-host.mjs')), import(loader.url('hosts/binaryen-host.mjs')),
      import(loader.url('wasi-shim/index.js')),
    ]);
    return { wasmTools: createWasmToolsHost({ loadAsset: loader.load, wasiShim: shim }),
      binaryen: createBinaryenHost({ loadAsset: loader.load }) };
  })().catch(error => { initialized = undefined; throw error; });
}
serveWorker(async (data, emit) => {
  report = emit;
  if (!['initialize', 'wasm-tools', 'wasm-merge', 'wasm-opt'].includes(data.operation)) throw Error('Unsupported tool operation');
  const request = { args: data.args?.slice(), files: ownedFiles(data.files, 1048576), outputs: data.outputs?.slice() };
  const hosts = await initialize();
  if (data.operation === 'initialize') return { success: true };
  report({ stage: data.operation });
  const result = data.operation === 'wasm-tools' ? await hosts.wasmTools.run(request) : await hosts.binaryen.run(data.operation, request);
  for (const stream of ['stdout', 'stderr']) if (result[stream]) report({ console: stream, text: result[stream] });
  return result;
});
