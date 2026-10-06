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
  'hello', 'multi-file', 'span-memory-unsafe', 'datetime', 'csharp15-tour', 'http', 'allocation', 'linq', 'async-linq',
  'pipelines', 'web-encoding', 'xml', 'json-dom', 'json-generated', 'tunit', 'regex',
  'di', 'logging', 'hashing', 'fluentvalidation',
  'native-lz4',
  'web-worker',
]);
const encoder = new TextEncoder();
const validStringArray = (value, maximumLength = 256) => Array.isArray(value) &&
  value.length <= maximumLength && value.every(item => typeof item === 'string' && item.length <= 512);

function validSourceSet(value) {
  if (typeof value !== 'string' || value.length > 300000) return false;
  let sourceSet;
  try { sourceSet = JSON.parse(value); } catch { return false; }
  if (sourceSet?.schemaVersion !== 1 || !Array.isArray(sourceSet.files) ||
      sourceSet.files.length < 1 || sourceSet.files.length > 32) return false;
  const paths = new Set();
  let totalBytes = 0;
  for (const file of sourceSet.files) {
    if (!file || typeof file.path !== 'string' || typeof file.text !== 'string' ||
        file.path.length > 240 || !file.path.endsWith('.cs') || file.path.startsWith('/') ||
        file.path.includes('\\') || /[<>:"|?*\x00-\x1f]/.test(file.path) ||
        file.path.split('/').some(part => !part || part === '.' || part === '..') ||
        paths.has(file.path)) return false;
    paths.add(file.path);
    const bytes = encoder.encode(file.text).byteLength;
    if (bytes > 65536) return false;
    totalBytes += bytes;
  }
  return totalBytes <= 262144;
}

serveWorker(async (data, emit) => {
  report = emit;
  if (!['compile', 'prune', 'pruneRaw', 'buildRawBindings', 'initialize'].includes(data.operation))
    throw Error('Unsupported compiler operation');
  if (data.operation === 'initialize') {
    if (typeof data.toolchainId !== 'string' || !/^[a-f0-9]{64}$/.test(data.toolchainId))
      throw Error('Invalid compiler toolchain identity');
  }
  if (data.operation === 'compile' && data.sourceSet === undefined && typeof data.source === 'string' &&
      encoder.encode(data.source).byteLength <= 65536) {
    data = { ...data, sourceSet: JSON.stringify({ schemaVersion: 1,
      files: [{ path: data.recipe === 'tunit' ? 'Tests.cs' : 'Program.cs', text: data.source }] }) };
  }
  if (data.operation === 'compile' &&
      (!recipes.has(data.recipe) || !validSourceSet(data.sourceSet) ||
       !['command', 'wit-worker', 'jsexport-worker'].includes(data.projectKind ?? 'command') ||
       typeof (data.nativeLibrariesJson ?? '[]') !== 'string' || (data.nativeLibrariesJson ?? '[]').length > 65536 ||
       !['15', 'preview'].includes(data.language) ||
       !['none', 'O0', 'O1', 'O2', 'O3', 'Os', 'Oz'].includes(data.optimization) ||
       typeof data.updatedMemorySafetyRules !== 'boolean' ||
       (data.updatedMemorySafetyRules && data.language !== 'preview')))
    throw Error('Invalid compiler source, recipe, language, or optimization settings');
  if (data.operation === 'prune' &&
      (!(data.module instanceof Uint8Array) || data.module.length > 5 * 1048576 ||
       typeof data.prefix !== 'string' || data.prefix.length > 255))
    throw Error('Invalid export pruning request');
  if (data.operation === 'pruneRaw' &&
      (!(data.module instanceof Uint8Array) || data.module.length > 5 * 1048576 ||
       !Array.isArray(data.exports) || data.exports.length < 1 || data.exports.length > 512 ||
       data.exports.some(value => !value || typeof value.Name !== 'string' || value.Name.length > 512 ||
         !Number.isInteger(value.Kind) || value.Kind < 0 || value.Kind > 4)))
    throw Error('Invalid raw export pruning request');
  if (data.operation === 'buildRawBindings') {
    const validImport = value => value && typeof value.Module === 'string' && value.Module.length <= 512 &&
      typeof value.Name === 'string' && value.Name.length <= 512 &&
      validStringArray(value.Parameters?.map(String), 32) && validStringArray(value.Results?.map(String), 4) &&
      [...value.Parameters, ...value.Results].every(item => Number.isInteger(item) && item >= 0 && item <= 3);
    if (typeof data.handle !== 'string' || !/^[a-f0-9]{32}$/.test(data.handle) ||
        !Array.isArray(data.runtimeImports) || data.runtimeImports.length > 512 ||
        !Array.isArray(data.finalImports) || data.finalImports.length > 512 ||
        !data.runtimeImports.every(validImport) || !data.finalImports.every(validImport))
      throw Error('Invalid raw binding request');
  }
  return compiler.request(data);
});
