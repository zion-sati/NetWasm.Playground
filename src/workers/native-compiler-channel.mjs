const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBase64 = bytes => {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 16384)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(text);
};
const fromBase64 = text => Uint8Array.from(atob(text), character => character.charCodeAt(0));
const coreRecipes = new Set(['hello', 'span-memory-unsafe', 'datetime', 'csharp15-tour']);
const generatedRecipes = new Set(['json-generated', 'tunit', 'di', 'logging']);
const validStringArray = (value, maximumLength = 256) => Array.isArray(value) &&
  value.length <= maximumLength && value.every(item => typeof item === 'string' && item.length <= 4096);

function validateRuntimeLinkPlan(plan, optimization) {
  const cache = plan?.Cache;
  if (!plan || !validStringArray(plan.Arguments) || !validStringArray(plan.OptimizationArguments) ||
      !Array.isArray(plan.Inputs) || plan.Inputs.length > 128 ||
      !Number.isSafeInteger(plan.MaximumMemorySizeBytes) || plan.MaximumMemorySizeBytes <= 0 ||
      plan.MaximumMemorySizeBytes % 65536 !== 0 ||
      cache?.schema !== 'runtime-materialization-cache-v1' ||
      ![cache.namespace, cache.slot, cache.key]
        .every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)))
    throw Error('Invalid runtime link plan');
  if (!plan.Inputs.every(input => input && typeof input.Path === 'string' && input.Path.length <= 4096 &&
      typeof input.Sha256 === 'string' && /^[a-f0-9]{64}$/i.test(input.Sha256)))
    throw Error('Invalid runtime link plan');
  const optimizationFlags = plan.OptimizationArguments
    .filter(argument => /^-O(?:[0-3]|s|z)$/.test(argument));
  if (optimization === 'none' ? plan.OptimizationArguments.length !== 0 :
      optimizationFlags.length !== 1 || optimizationFlags[0] !== `-${optimization}`)
    throw Error('Runtime optimization plan does not match the request');
}

function checksumBytes(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw Error('Invalid frontend cache checksum');
  return Uint8Array.from(value.match(/../g), byte => Number.parseInt(byte, 16));
}

export function createNativeAotCompilerChannel(options = {}) {
  if (typeof options === 'string') options = { candidateRoot: options };
  const candidateUrl = new URL(options.candidateRoot ?? '/nativeaot/', location.origin);
  const candidatePrefix = options.candidatePrefix ?? 'compiler/_framework/';
  const externalLoader = options.assetLoader;
  const report = options.report ?? (() => {});
  let initialized, module, loader = externalLoader, compilerToolchainId, frontendCache;
  const recipes = new Map();

  async function recipeInputs(id) {
    if (!recipes.has(id)) recipes.set(id, (async () => {
      if (coreRecipes.has(id) && !(await loader.manifest())[`recipes/${id}.json`])
        return { images: ['{}', '{}'] };
      if (!(await loader.manifest())[`recipes/${id}.json`])
        throw Error('Recipe assets unavailable. Prepare the verified example bundle.');
      const recipe = JSON.parse(decoder.decode(await loader.load(`recipes/${id}.json`)));
      if (recipe.schemaVersion !== 1 || recipe.id !== id) throw Error('Invalid compilation recipe');
      const results = await Promise.allSettled(['references', 'implementations'].map(async role => {
        const images = {};
        if (!recipe[role] || Object.keys(recipe[role]).length > 64)
          throw Error('Invalid recipe assembly list');
        for (const [name, asset] of Object.entries(recipe[role])) {
          if (!/^[A-Za-z0-9_.]+\.dll$/.test(name) || name === 'NetWasm.CoreLib.dll' || asset !== `${role}/${name}`)
            throw Error('Invalid recipe assembly role');
          images[name] = toBase64(await loader.load(asset));
        }
        return JSON.stringify(images);
      }));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      let supportJson;
      if (recipe.support !== undefined) {
        if (id !== 'tunit' || recipe.support !== 'recipes/tunit-support.json')
          throw Error('Invalid trusted recipe support');
        const bytes = await loader.load(recipe.support);
        if (bytes.byteLength > 65536) throw Error('Recipe support limit exceeded');
        supportJson = decoder.decode(bytes);
      }
      return { images: results.map(result => result.value), supportJson };
    })().catch(error => { recipes.delete(id); throw error; }));
    return recipes.get(id);
  }

  function invoke(operation, values) {
    const request = encoder.encode(JSON.stringify({ operation, arguments: values.map(String) }));
    const requestPointer = module._NetWasmCompiler_Alloc(request.byteLength);
    if (!requestPointer) throw Error('Native compiler request allocation failed');
    try {
      module.HEAPU8.set(request, requestPointer);
      const length = module._NetWasmCompiler_Invoke(requestPointer, request.byteLength);
      if (length < 0) {
        const errorLength = module._NetWasmCompiler_CopyError(0, 0);
        const errorPointer = module._NetWasmCompiler_Alloc(errorLength);
        try {
          if (!errorPointer || module._NetWasmCompiler_CopyError(errorPointer, errorLength) !== errorLength)
            throw Error('Native compiler error transfer failed');
          throw Error(decoder.decode(module.HEAPU8.slice(errorPointer, errorPointer + errorLength)));
        } finally { if (errorPointer) module._NetWasmCompiler_Free(errorPointer); }
      }
      const resultPointer = module._NetWasmCompiler_Alloc(length);
      try {
        if (!resultPointer || module._NetWasmCompiler_CopyResult(resultPointer, length) !== length)
          throw Error('Native compiler result transfer failed');
        return decoder.decode(module.HEAPU8.slice(resultPointer, resultPointer + length));
      } finally { if (resultPointer) module._NetWasmCompiler_Free(resultPointer); }
    } finally { module._NetWasmCompiler_Free(requestPointer); }
  }

  async function initialize() {
    return initialized ??= (async () => {
      if (!loader) {
        const index = await (await fetch('/toolchain/index.json')).json();
        const toolchainRoot = new URL(`/toolchain/${index.id}/`, location.origin);
        const assetModule = await import(new URL('workers/asset-loader.mjs', toolchainRoot));
        loader = assetModule.createAssetLoader();
      }
      const receipt = externalLoader
        ? JSON.parse(decoder.decode(await loader.load(`${candidatePrefix}nativeaot-compiler-receipt.json`)))
        : await (await fetch(new URL('nativeaot-compiler-receipt.json', candidateUrl))).json();
      const script = Object.keys(receipt.files).find(name => name.endsWith('.js') || name.endsWith('.mjs'));
      if (!script) throw Error('Native compiler JavaScript host is missing');
      if (externalLoader) loader.installFetchAdapter();
      const scriptUrl = externalLoader ? loader.url(`${candidatePrefix}${script}`) : new URL(script, candidateUrl);
      const createModule = (await import(scriptUrl)).default;
      module = await createModule({ locateFile: name => externalLoader
        ? loader.url(`${candidatePrefix}${name}`) : new URL(name, candidateUrl).href });
      const runtimeManifestPromise = loader.load('compiler/runtime-pack.json').then(bytes => decoder.decode(bytes));
      const loaded = await Promise.allSettled([
        loader.load('compiler/target-reference.dll').then(toBase64),
        loader.load('compiler/support.json').then(bytes => decoder.decode(bytes)),
        loader.load('compiler/target-implementation.dll').then(toBase64),
        loader.load('compiler/compiler-wit.json').then(bytes => decoder.decode(bytes)),
        loader.load('compiler/compiler.wit.wasm').then(toBase64),
        loader.load('compiler/compiler-wit-platform.wat').then(bytes => decoder.decode(bytes)),
        loader.load('compiler/compiler-wit-async-platform.wat').then(bytes => decoder.decode(bytes)),
        runtimeManifestPromise,
        (async () => {
          const runtimeManifest = JSON.parse(await runtimeManifestPromise);
          const target = runtimeManifest.targets?.find(candidate => candidate.target === 'wasm32');
          if (!Array.isArray(target?.systemLibraries?.names))
            throw Error('Invalid runtime system-library manifest');
          const assets = await loader.manifest();
          return JSON.stringify(target.systemLibraries.names.map(name => {
            if (!/^[A-Za-z0-9_.-]+\.a$/.test(name))
              throw Error('Invalid runtime system-library name');
            const asset = `runtime/wasm32/system/${name}`, receipt = assets[asset];
            if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.sha256))
              throw Error(`Missing runtime system-library receipt: ${name}`);
            return { Path: `/netwasm-link/${asset}`, Sha256: receipt.sha256 };
          }));
        })(),
      ]);
      const failed = loaded.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      return { inputs: loaded.map(result => result.value) };
    })().catch(error => { initialized = undefined; throw error; });
  }

  async function compileWithFrontendCache(operation, arguments_) {
    const prepared = JSON.parse(invoke(operation, arguments_));
    if (!prepared.frontendCache) return prepared;
    report({ stage: 'cache-lookup', state: 'running' });
    const cacheLookupStarted = performance.now();
    const loaded = await frontendCache.load(prepared.frontendCache);
    const cacheLookupMilliseconds = performance.now() - cacheLookupStarted;
    report({ stage: 'cache-lookup', state: 'complete', milliseconds: cacheLookupMilliseconds });
    report({ stage: 'cache-hydrate', state: 'running' });
    const cacheHydrationStarted = performance.now();
    for (const entry of loaded.entries)
      invoke('importFrontendArtifact', [prepared.frontendCache.handle, entry.key,
        toBase64(entry.payload), toBase64(entry.checksum)]);
    const cacheHydrationMilliseconds = performance.now() - cacheHydrationStarted;
    report({ stage: 'cache-hydrate', state: 'complete', milliseconds: cacheHydrationMilliseconds });
    const loadedEntries = loaded.entries.length;
    const readBytes = loaded.totalBytes;
    loaded.entries.length = 0;
    report({ stage: 'netwasm', state: 'running' });
    const netwasmStarted = performance.now();
    const result = JSON.parse(invoke('compilePreparedRecipe', [prepared.frontendCache.handle]));
    report({ stage: 'netwasm', state: 'complete', milliseconds: performance.now() - netwasmStarted });
    let cacheWriteMilliseconds = 0;
    if (result.frontendPublication) {
      report({ stage: 'cache-write', state: 'running' });
      const cacheWriteStarted = performance.now();
      const publication = result.frontendPublication;
      try {
        for (;;) {
          const batch = JSON.parse(invoke('readFrontendArtifactBatch', [publication.token]));
          const entries = batch.entries.map((entry, index) => ({
            key: entry.key,
            checksum: checksumBytes(entry.checksum),
            payload: fromBase64(invoke('readFrontendArtifactPayload', [batch.token, index])),
          }));
          if (!await frontendCache.write(prepared.frontendCache, entries)) {
            invoke('abandonFrontendArtifactPublication', [publication.token]);
            break;
          }
          invoke('acknowledgeFrontendArtifactBatch', [publication.token, batch.token]);
          if (batch.isFinal) break;
        }
      } catch {
        try { invoke('abandonFrontendArtifactPublication', [publication.token]); } catch {}
      }
      cacheWriteMilliseconds = performance.now() - cacheWriteStarted;
      report({ stage: 'cache-write', state: 'complete', milliseconds: cacheWriteMilliseconds });
    }
    result.frontendCacheMetrics = {
      ...result.frontendCacheMetrics,
      loadedEntries,
      readBytes,
      cacheReadMilliseconds: cacheLookupMilliseconds + cacheHydrationMilliseconds,
      cacheLookupMilliseconds,
      cacheHydrationMilliseconds,
      cacheWriteMilliseconds,
    };
    result.timings = [...(result.timings ?? []),
      { stage: 'cache-lookup', milliseconds: cacheLookupMilliseconds },
      { stage: 'cache-hydrate', milliseconds: cacheHydrationMilliseconds },
      { stage: 'cache-write', milliseconds: cacheWriteMilliseconds }];
    return result;
  }

  return {
    async request(data) {
      if (data.operation === 'initialize') {
        if (compilerToolchainId && compilerToolchainId !== data.toolchainId)
          throw Error('Compiler toolchain identity changed');
        compilerToolchainId = data.toolchainId;
        frontendCache ??= options.createFrontendCache?.(compilerToolchainId);
        await initialize();
        return { success: true };
      }
      const { inputs } = await initialize();
      if (data.operation === 'prune') {
        const value = invoke('retainComponentExports', [toBase64(data.module), data.prefix]);
        return { module: fromBase64(value), hostLinearMemoryBytes: module.HEAPU8.buffer.byteLength };
      }
      if (data.operation !== 'compile') throw Error('Unsupported native compiler operation');
      const { images, supportJson } = await recipeInputs(data.recipe);
      const compilerInputs = inputs.slice();
      if (supportJson !== undefined) compilerInputs[1] = supportJson;
      const settings = [data.language, data.updatedMemorySafetyRules, data.optimization];
      const generated = generatedRecipes.has(data.recipe);
      const trustedRecipe = data.recipe === 'tunit' ? 'tunit'
        : data.recipe === 'di' ? 'di' : data.recipe === 'logging' ? 'logging' : 'json';
      let result;
      if (data.frontendCache !== false && frontendCache) {
        const operation = generated ? 'prepareGeneratedRecipe'
          : data.recipe === 'http' ? 'prepareHttpRecipe' : 'prepareRecipe';
        const arguments_ = generated
          ? [data.source, ...compilerInputs, ...images, trustedRecipe, ...settings]
          : [data.source, ...compilerInputs, ...images, ...settings];
        result = await compileWithFrontendCache(operation, arguments_);
      } else {
        const operation = generated ? 'compileGeneratedRecipe'
          : data.recipe === 'http' ? 'compileHttpRecipe' : 'compileRecipe';
        const arguments_ = generated
          ? [data.source, ...compilerInputs, ...images, trustedRecipe, false, ...settings]
          : [data.source, ...compilerInputs, ...images, ...settings];
        result = JSON.parse(invoke(operation, arguments_));
      }
      if (typeof result.application === 'string') result.application = fromBase64(result.application);
      if (typeof result.pe === 'string') result.pe = fromBase64(result.pe);
      if (result.success) validateRuntimeLinkPlan(result.runtimeLinkPlan, data.optimization);
      result.hostLinearMemoryBytes = module.HEAPU8.buffer.byteLength;
      return result;
    },
    reset() {
      frontendCache?.close();
      frontendCache = undefined;
      initialized = undefined;
      module = undefined;
      loader = externalLoader;
      compilerToolchainId = undefined;
      recipes.clear();
    },
  };
}
