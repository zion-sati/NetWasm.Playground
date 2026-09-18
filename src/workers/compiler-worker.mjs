import { createAssetLoader, serveWorker, toBase64, fromBase64 } from './asset-loader.mjs';
import { createFrontendCache } from './frontend-cache.mjs';
let report = () => {}, initialized;
let frontendCache, compilerToolchainId;
const loader = createAssetLoader(assets => report({ assets }));
const recipes = new Map();
async function recipeInputs(id) {
  if (!recipes.has(id)) recipes.set(id, (async () => {
    if (id === 'hello' && !(await loader.manifest())['recipes/hello.json']) return { images: ['{}', '{}'] };
    if (!(await loader.manifest())[`recipes/${id}.json`]) throw Error('Recipe assets unavailable. Prepare the verified example bundle.');
    const recipe = JSON.parse(new TextDecoder().decode(await loader.load(`recipes/${id}.json`)));
    if (recipe.schemaVersion !== 1 || recipe.id !== id) throw Error('Invalid compilation recipe');
    const results = await Promise.allSettled(['references', 'implementations'].map(async role => {
      const images = {};
      if (!recipe[role] || Object.keys(recipe[role]).length > 64) throw Error('Invalid recipe assembly list');
      for (const [name, asset] of Object.entries(recipe[role])) {
        if (!/^[A-Za-z0-9_.]+\.dll$/.test(name) || name === 'NetWasm.CoreLib.dll' || asset !== `${role}/${name}`) throw Error('Invalid recipe assembly role');
        images[name] = toBase64(await loader.load(asset));
      }
      return JSON.stringify(images);
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    let supportJson;
    if (recipe.support !== undefined) {
      if (id !== 'tunit' || recipe.support !== 'recipes/tunit-support.json') throw Error('Invalid trusted recipe support');
      const bytes = await loader.load(recipe.support);
      if (bytes.byteLength > 65536) throw Error('Recipe support limit exceeded');
      supportJson = new TextDecoder().decode(bytes);
    }
    return { images: results.map(result => result.value), supportJson };
  })().catch(error => { recipes.delete(id); throw error; }));
  return recipes.get(id);
}
async function initialize() {
  return initialized ??= (async () => {
    report({ stage: 'compiler-initialize' });
    await loader.verifyGraph('compiler/_framework/');
    loader.installFetchAdapter();
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
    if (typeof program.ConfigureGuestMemoryMaximum !== 'function') throw Error('Rebuild the compiler host for guest memory limits');
    program.ConfigureGuestMemoryMaximum(256 * 1048576);
    const runtimeManifestPromise = loader.load('compiler/runtime-pack.json').then(bytes => new TextDecoder().decode(bytes));
    const loaded = await Promise.allSettled([
      loader.load('compiler/target-reference.dll').then(toBase64),
      loader.load('compiler/support.json').then(bytes => new TextDecoder().decode(bytes)),
      loader.load('compiler/target-implementation.dll').then(toBase64),
      loader.load('compiler/compiler-wit.json').then(bytes => new TextDecoder().decode(bytes)),
      loader.load('compiler/compiler.wit.wasm').then(toBase64),
      runtimeManifestPromise,
      (async () => {
        const runtimeManifest = JSON.parse(await runtimeManifestPromise);
        const target = runtimeManifest.targets?.find(candidate => candidate.target === 'wasm32');
        if (!Array.isArray(target?.systemLibraries?.names)) throw Error('Invalid runtime system-library manifest');
        const assets = await loader.manifest();
        return JSON.stringify(target.systemLibraries.names.map(name => {
          if (!/^[A-Za-z0-9_.-]+\.a$/.test(name)) throw Error('Invalid runtime system-library name');
          const asset = `runtime/wasm32/system/${name}`, receipt = assets[asset];
          if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.sha256)) throw Error(`Missing runtime system-library receipt: ${name}`);
          return { Path: `/netwasm-link/${asset}`, Sha256: receipt.sha256 };
        }));
      })(),
    ]);
    const failed = loaded.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    return { runtime, program, inputs: loaded.map(result => result.value) };
  })().catch(error => { initialized = undefined; throw error; });
}
serveWorker(async (data, emit) => {
  report = emit;
  if (data.operation !== 'compile' && data.operation !== 'prune' && data.operation !== 'initialize') throw Error('Unsupported compiler operation');
  if (data.operation === 'compile' && (!['hello', 'allocation', 'linq', 'json-dom', 'json-generated', 'tunit', 'regex', 'di', 'hashing'].includes(data.recipe) || typeof data.source !== 'string' || data.source.length > 65536 || new TextEncoder().encode(data.source).length > 65536)) throw Error('Invalid compiler source or recipe');
  const module = data.operation === 'prune' ? (() => {
    if (!(data.module instanceof Uint8Array) || data.module.length > 4 * 1048576 || typeof data.prefix !== 'string' || data.prefix.length > 255) throw Error('Invalid export pruning request');
    return data.module.slice();
  })() : undefined;
  if (data.operation === 'initialize') {
    if (typeof data.toolchainId !== 'string' || !/^[a-f0-9]{64}$/.test(data.toolchainId))
      throw Error('Invalid compiler toolchain identity');
    if (compilerToolchainId && compilerToolchainId !== data.toolchainId)
      throw Error('Compiler toolchain identity changed');
    compilerToolchainId = data.toolchainId;
    frontendCache ??= createFrontendCache(compilerToolchainId);
  }
  const { runtime, program, inputs } = await initialize();
  if (data.operation === 'initialize') return { success: true };
  if (module) return { module: fromBase64(program.RetainComponentExports(toBase64(module), data.prefix)),
    hostLinearMemoryBytes: runtime.Module?.HEAPU8?.buffer?.byteLength ?? null };
  const { images: additional, supportJson } = await recipeInputs(data.recipe);
  const recipeCompilerInputs = inputs.slice();
  if (supportJson !== undefined) recipeCompilerInputs[1] = supportJson;
  if (typeof program.CompileRecipe !== 'function' && data.recipe !== 'hello') throw Error('Rebuild the compiler host for library recipes');
  if (['json-generated', 'tunit', 'di'].includes(data.recipe) && typeof program.CompileGeneratedRecipe !== 'function') throw Error('Rebuild the compiler host for source generation');
  const generated = ['json-generated', 'tunit', 'di'].includes(data.recipe);
  const trustedRecipe = data.recipe === 'tunit' ? 'tunit' : data.recipe === 'di' ? 'di' : 'json';
  const supportsFrontendCache = data.frontendCache !== false && frontendCache && typeof program.PrepareRecipe === 'function' &&
    typeof program.PrepareGeneratedRecipe === 'function' && typeof program.ImportFrontendArtifact === 'function' &&
    typeof program.CompilePreparedRecipe === 'function';
  let result;
  if (supportsFrontendCache) {
    const prepared = JSON.parse(generated
      ? program.PrepareGeneratedRecipe(data.source, ...recipeCompilerInputs, ...additional, trustedRecipe)
      : program.PrepareRecipe(data.source, ...recipeCompilerInputs, ...additional));
    if (!prepared.frontendCache) result = prepared;
    else {
      report({ stage: 'cache-read' });
      const cacheReadStarted = performance.now();
      const loaded = await frontendCache.load(prepared.frontendCache);
      for (const entry of loaded.entries)
        program.ImportFrontendArtifact(prepared.frontendCache.handle, entry.key, entry.payload, entry.checksum);
      const loadedEntries = loaded.entries.length;
      const readBytes = loaded.totalBytes;
      // ImportFrontendArtifact copies validated payloads into managed memory.
      // Release the JavaScript copies before entering the synchronous compiler.
      loaded.entries.length = 0;
      const cacheReadMilliseconds = performance.now() - cacheReadStarted;
      result = JSON.parse(program.CompilePreparedRecipe(prepared.frontendCache.handle));
      let cacheWriteMilliseconds = 0;
      if (result.frontendPublication) {
        report({ stage: 'cache-write' });
        const cacheWriteStarted = performance.now();
        const publication = result.frontendPublication;
        try {
          for (;;) {
            const batch = JSON.parse(program.ReadFrontendArtifactBatch(publication.token));
            const entries = batch.entries.map((entry, index) => ({
              key: entry.key,
              checksum: Uint8Array.from(entry.checksum.match(/../g).map(value => Number.parseInt(value, 16))),
              payload: program.ReadFrontendArtifactPayload(batch.token, index),
            }));
            if (!await frontendCache.write(prepared.frontendCache, entries)) {
              program.AbandonFrontendArtifactPublication(publication.token);
              break;
            }
            program.AcknowledgeFrontendArtifactBatch(publication.token, batch.token);
            if (batch.isFinal) break;
          }
        } catch {
          try { program.AbandonFrontendArtifactPublication(publication.token); } catch {}
        }
        cacheWriteMilliseconds = performance.now() - cacheWriteStarted;
      }
      result.frontendCacheMetrics = {
        ...result.frontendCacheMetrics,
        loadedEntries,
        readBytes,
        cacheReadMilliseconds,
        cacheWriteMilliseconds,
      };
    }
  } else result = JSON.parse(generated
    ? program.CompileGeneratedRecipe(data.source, ...recipeCompilerInputs, ...additional, trustedRecipe, false)
    : typeof program.CompileRecipe === 'function' ? program.CompileRecipe(data.source, ...recipeCompilerInputs, ...additional) : program.Compile(data.source, ...recipeCompilerInputs));
  if (typeof result.application === 'string') result.application = fromBase64(result.application);
  if (typeof result.pe === 'string') result.pe = fromBase64(result.pe);
  result.hostLinearMemoryBytes = runtime.Module?.HEAPU8?.buffer?.byteLength ?? null;
  return result;
});
