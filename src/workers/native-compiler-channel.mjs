const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBase64 = bytes => {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 16384)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(text);
};
const fromBase64 = text => Uint8Array.from(atob(text), character => character.charCodeAt(0));
const coreRecipes = new Set(['hello', 'multi-file', 'span-memory-unsafe', 'datetime', 'async', 'csharp15-tour', 'native-lz4', 'web-worker']);
const generatedRecipes = new Set(['json-generated', 'di', 'logging']);
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

export function createNativeAotCompilerChannel(options = {}) {
  if (typeof options === 'string') options = { candidateRoot: options };
  const candidateUrl = new URL(options.candidateRoot ?? '/nativeaot/', location.origin);
  const candidatePrefix = options.candidatePrefix ?? 'compiler/_framework/';
  const externalLoader = options.assetLoader;
  const report = options.report ?? (() => {});
  let initialized, module, loader = externalLoader, compilerToolchainId, unitStore;
  const importedUnits = new Set();
  const recipes = new Map();
  const implementations = new Map();
  let framework;

  async function recipeInputs(id) {
    if (!recipes.has(id)) recipes.set(id, (async () => {
      // A recipe names the package libraries an example references; NetWasm.App's in-box assemblies are
      // always referenced, and every implementation is chosen after C# compiles.
      if (coreRecipes.has(id) && !(await loader.manifest())[`recipes/${id}.json`])
        return { images: ['{}', '{}'] };
      if (!(await loader.manifest())[`recipes/${id}.json`])
        throw Error('Recipe assets unavailable. Prepare the verified example bundle.');
      const recipe = JSON.parse(decoder.decode(await loader.load(`recipes/${id}.json`)));
      if (recipe.schemaVersion !== 1 || recipe.id !== id) throw Error('Invalid compilation recipe');
      if (!recipe.references || Object.keys(recipe.references).length > 64)
        throw Error('Invalid recipe assembly list');
      const references = {};
      for (const [name, asset] of Object.entries(recipe.references)) {
        if (!/^[A-Za-z0-9_.]+\.dll$/.test(name) || name === 'NetWasm.CoreLib.dll' || asset !== `references/${name}`)
          throw Error('Invalid recipe assembly role');
        references[name] = toBase64(await loader.load(asset));
      }
      return { images: [JSON.stringify(references), '{}'] };
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
        loader.load('compiler/command-wit.json').then(bytes => decoder.decode(bytes)),
        loader.load('compiler/command-wit-command.wat').then(bytes => decoder.decode(bytes)),
      ]);
      const failed = loaded.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      const values = loaded.map(result => result.value);
      await loadFramework();
      return {
        inputs: values.slice(0, 8),
        rawBindings: { runtimeWitJson: values[8], runtimeWitInventory: values[9] },
      };
    })().catch(error => { initialized = undefined; throw error; });
  }

  // NetWasm.App, as the SDK references it: every reference assembly goes to the host once, and its manifest
  // names each implementation's asset and closure.
  async function loadFramework() {
    const text = decoder.decode(await loader.load('compiler/framework.json'));
    const manifest = JSON.parse(text);
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.references) || manifest.references.length > 512 ||
        !manifest.implementations || typeof manifest.implementations !== 'object')
      throw Error('Invalid framework manifest');
    const references = {};
    await Promise.all(manifest.references.map(async name => {
      if (typeof name !== 'string' || !/^[A-Za-z0-9_.]+\.dll$/.test(name) || name === 'NetWasm.CoreLib.dll')
        throw Error('Invalid framework reference');
      references[name] = toBase64(await loader.load(`references/${name}`));
    }));
    invoke('loadFramework', [JSON.stringify(references), text]);
    framework = manifest;
  }

  // The implementation assemblies a compiled program requires, fetched on first use and kept for later compiles.
  async function implementationImages(names) {
    if (!Array.isArray(names) || names.length > 256) throw Error('Invalid required implementations');
    const images = {};
    await Promise.all(names.map(async name => {
      const entry = typeof name === 'string' ? framework?.implementations[name] : undefined;
      if (!entry || typeof entry.asset !== 'string' || !/^implementations\/[A-Za-z0-9_.]+\.[a-f0-9]{64}\.bin$/.test(entry.asset))
        throw Error(`The framework has no implementation for ${name}`);
      if (!implementations.has(name)) implementations.set(name, loader.load(entry.asset).then(toBase64)
        .catch(error => { implementations.delete(name); throw error; }));
      images[name] = await implementations.get(name);
    }));
    return JSON.stringify(images);
  }

  // Compiled units serve every level, as the compiler cache before them did: one set for each
  // setting that changes the code, so switching profiles keeps each of them warm.
  function unitsName(data) {
    if (data.compiledUnits === false) return '';
    return ['units', data.optimization, data.garbageCollector ?? 'Compact', data.structuredDiagnostics === true,
      JSON.stringify(data.optimizationOverrides ?? null)].join('/');
  }

  async function sha256Hex(value) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  // Finishes a compilation whose C# compiled. With compiled units, the worker restores them
  // from IndexedDB once before the first such compilation and stores them again after each.
  async function compileWebAssembly(name, implementationsJson) {
    const timings = [];
    const timed = async (stage, action) => {
      report({ stage, state: 'running' });
      const started = performance.now();
      try { return await action(); } finally {
        const milliseconds = performance.now() - started;
        timings.push({ stage, milliseconds });
        report({ stage, state: 'complete', milliseconds });
      }
    };
    let descriptor, restoredBytes = 0, storedBytes = 0;
    if (name) {
      const identity = await sha256Hex(encoder.encode(name));
      descriptor = { schema: 'compiled-units', namespace: identity, slot: identity,
        key: await sha256Hex(encoder.encode('netwasm.compiled-units/1')) };
      if (!importedUnits.has(name)) {
        const stored = await timed('cache-lookup', () => unitStore.loadRuntime(descriptor));
        await timed('cache-hydrate', async () => {
          if (!stored.hit) return;
          invoke('importCompiledUnits', [name, toBase64(stored.payload)]);
          restoredBytes = stored.payload.byteLength;
        });
        importedUnits.add(name);
      }
    }
    invoke('useCompiledUnits', [name]);
    report({ stage: 'netwasm', state: 'running' });
    const started = performance.now();
    const result = JSON.parse(invoke('compileWebAssembly', [implementationsJson]));
    report({ stage: 'netwasm', state: 'complete', milliseconds: performance.now() - started });
    if (name) {
      if (result.success) {
        await timed('cache-write', async () => {
          const units = fromBase64(invoke('exportCompiledUnits', [name]));
          const checksum = new Uint8Array(await crypto.subtle.digest('SHA-256', units));
          if (await unitStore.writeRuntime(descriptor, units, checksum)) storedBytes = units.byteLength;
        });
      }
      result.compiledUnitsCache = { restoredBytes, storedBytes };
    }
    result.timings = [...(result.timings ?? []), ...timings];
    return result;
  }

  return {
    async request(data) {
      if (data.operation === 'initialize') {
        if (compilerToolchainId && compilerToolchainId !== data.toolchainId)
          throw Error('Compiler toolchain identity changed');
        compilerToolchainId = data.toolchainId;
        unitStore ??= options.createFrontendCache?.(compilerToolchainId);
        await initialize();
        return { success: true };
      }
      const { inputs, rawBindings } = await initialize();
      if (data.operation === 'inline') {
        const value = invoke('filterInlineAnnotations', [toBase64(data.module), data.selection]);
        return { module: fromBase64(value), hostLinearMemoryBytes: module.HEAPU8.buffer.byteLength };
      }
      if (data.operation === 'prune') {
        const value = invoke('retainComponentExports', [toBase64(data.module), data.prefix]);
        return { module: fromBase64(value), hostLinearMemoryBytes: module.HEAPU8.buffer.byteLength };
      }
      if (data.operation === 'pruneRaw') {
        const value = invoke('removeRawExports', [toBase64(data.module), JSON.stringify(data.exports)]);
        return { module: fromBase64(value), hostLinearMemoryBytes: module.HEAPU8.buffer.byteLength };
      }
      if (data.operation === 'buildRawBindings') {
        const value = JSON.parse(invoke('buildRawBindings', [
          data.handle,
          rawBindings.runtimeWitJson,
          rawBindings.runtimeWitInventory,
          JSON.stringify(data.runtimeImports),
          JSON.stringify(data.finalImports),
        ]));
        if (!value.success) throw Error(value.error || 'Raw binding generation failed');
        return {
          adapter: fromBase64(value.adapter),
          requiredImports: value.requiredImports,
          hostLinearMemoryBytes: module.HEAPU8.buffer.byteLength,
        };
      }
      if (data.operation !== 'compile') throw Error('Unsupported native compiler operation');
      const { images } = await recipeInputs(data.recipe);
      const compilerInputs = inputs.slice();
      const settings = [data.language, data.updatedMemorySafetyRules, data.optimization, data.garbageCollector ?? 'Compact',
        data.structuredDiagnostics === true, JSON.stringify(data.optimizationOverrides ?? null)];
      const projectKind = data.projectKind ?? 'command';
      const nativeLibrariesJson = data.nativeLibrariesJson ?? '[]';
      const projectCompilation = projectKind !== 'command' || nativeLibrariesJson !== '[]';
      const generated = generatedRecipes.has(data.recipe);
      const trustedRecipe = data.recipe === 'di' ? 'di' : data.recipe === 'logging' ? 'logging' : 'json';
      const operation = projectCompilation ? 'compileProject' : generated ? 'compileGeneratedRecipe' : 'compileRecipe';
      const arguments_ = projectCompilation
        ? [data.sourceSet, projectKind, ...compilerInputs, ...images,
          nativeLibrariesJson, ...settings]
        : generated
        ? [data.sourceSet, ...compilerInputs, ...images, trustedRecipe, false, ...settings]
        : [data.sourceSet, ...compilerInputs, ...images, ...settings];
      let result = JSON.parse(invoke(operation, arguments_));
      if (result.prepared) result = await compileWebAssembly(unitStore ? unitsName(data) : '',
        await implementationImages(result.requiredImplementations));
      if (typeof result.application === 'string') result.application = fromBase64(result.application);
      if (typeof result.pe === 'string') result.pe = fromBase64(result.pe);
      if (result.symbolSidecars) result.symbolSidecars = {
        typeSymbols: fromBase64(result.symbolSidecars.typeSymbols),
        ...(typeof result.symbolSidecars.methodSymbols === 'string'
          ? { methodSymbols: fromBase64(result.symbolSidecars.methodSymbols) } : {}),
      };
      if (result.success) {
        validateRuntimeLinkPlan(result.runtimeLinkPlan, data.optimization);
        if (result.runtimeLinkPlan.GarbageCollector !== (data.garbageCollector ?? 'Compact'))
          throw Error('Runtime collector plan does not match the request');
      }
      result.hostLinearMemoryBytes = module.HEAPU8.buffer.byteLength;
      return result;
    },
    reset() {
      unitStore?.close();
      unitStore = undefined;
      importedUnits.clear();
      implementations.clear();
      framework = undefined;
      initialized = undefined;
      module = undefined;
      loader = externalLoader;
      compilerToolchainId = undefined;
      recipes.clear();
    },
  };
}
