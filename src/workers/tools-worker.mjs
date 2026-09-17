import { createAssetLoader, ownedFiles, serveWorker } from './asset-loader.mjs';
let report = () => {}, initialized;
const loader = createAssetLoader(assets => report({ assets }));
// The read-only JSON recipe merges about 1.1 MiB before optimization.
const limits = { maximumInputBytes: 4 * 1048576, maximumOutputBytes: 4 * 1048576 };
async function initialize() {
  return initialized ??= (async () => {
    await loader.verifyGraph('hosts/');
    const { createWasmToolsHost, createBinaryenHost, wasiShim } = await import(loader.url('hosts/tools-runtime.mjs'));
    return { wasmTools: createWasmToolsHost({ loadAsset: loader.load, wasiShim, limits }),
      binaryen: createBinaryenHost({ loadAsset: loader.load, limits }) };
  })().catch(error => { initialized = undefined; throw error; });
}
serveWorker(async (data, emit) => {
  report = emit;
  if (!['initialize', 'wasm-tools', 'wasm-merge', 'wasm-opt'].includes(data.operation)) throw Error('Unsupported tool operation');
  const request = { args: data.args?.slice(), files: ownedFiles(data.files, limits.maximumInputBytes), outputs: data.outputs?.slice() };
  const hosts = await initialize();
  if (data.operation === 'initialize') return { success: true };
  report({ stage: data.operation });
  const result = data.operation === 'wasm-tools' ? await hosts.wasmTools.run(request) : await hosts.binaryen.run(data.operation, request);
  for (const stream of ['stdout', 'stderr']) if (result[stream]) report({ console: stream, text: result[stream] });
  return result;
});
