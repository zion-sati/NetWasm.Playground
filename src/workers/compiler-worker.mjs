import { createAssetLoader, serveWorker } from './asset-loader.mjs';
import { createFrontendCache } from './frontend-cache.mjs';
import { createNativeAotCompilerChannel } from './native-compiler-channel.mjs';

let report = () => {};
const loader = createAssetLoader(assets => report({ assets }));
const compiler = createNativeAotCompilerChannel({
  assetLoader: loader,
  createFrontendCache,
  report: event => report(event),
});
const recipes = new Set([
  'hello', 'datetime', 'csharp15-tour', 'http', 'allocation', 'linq', 'async-linq',
  'pipelines', 'web-encoding', 'xml', 'json-dom', 'json-generated', 'tunit', 'regex',
  'di', 'logging', 'hashing', 'fluentvalidation',
]);

serveWorker(async (data, emit) => {
  report = emit;
  if (!['compile', 'prune', 'initialize'].includes(data.operation))
    throw Error('Unsupported compiler operation');
  if (data.operation === 'initialize') {
    if (typeof data.toolchainId !== 'string' || !/^[a-f0-9]{64}$/.test(data.toolchainId))
      throw Error('Invalid compiler toolchain identity');
  }
  if (data.operation === 'compile' &&
      (!recipes.has(data.recipe) || typeof data.source !== 'string' ||
       data.source.length > 65536 || new TextEncoder().encode(data.source).length > 65536 ||
       !['15', 'preview'].includes(data.language) ||
       !['none', 'O0', 'O1', 'O2', 'O3', 'Os', 'Oz'].includes(data.optimization) ||
       typeof data.updatedMemorySafetyRules !== 'boolean' ||
       (data.updatedMemorySafetyRules && data.language !== 'preview')))
    throw Error('Invalid compiler source, recipe, language, or optimization settings');
  if (data.operation === 'prune' &&
      (!(data.module instanceof Uint8Array) || data.module.length > 5 * 1048576 ||
       typeof data.prefix !== 'string' || data.prefix.length > 255))
    throw Error('Invalid export pruning request');
  return compiler.request(data);
});
