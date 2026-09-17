import { createAssetLoader, serveWorker, toBase64, fromBase64 } from './asset-loader.mjs';
let report = () => {}, initialized;
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
  if (data.operation === 'compile' && (!['hello', 'allocation', 'linq', 'json-dom', 'json-generated', 'tunit', 'regex', 'di', 'hashing'].includes(data.recipe) || typeof data.source !== 'string' || data.source.length > 65536 || new TextEncoder().encode(data.source).length > 65536)) throw Error('Invalid compiler source or recipe');
  const module = data.operation === 'prune' ? (() => {
    if (!(data.module instanceof Uint8Array) || data.module.length > 4 * 1048576 || typeof data.prefix !== 'string' || data.prefix.length > 255) throw Error('Invalid export pruning request');
    return data.module.slice();
  })() : undefined;
  const { runtime, program, inputs } = await initialize();
  if (data.operation === 'initialize') return { success: true };
  if (module) return { module: fromBase64(program.RetainComponentExports(toBase64(module), data.prefix)),
    hostLinearMemoryBytes: runtime.Module?.HEAPU8?.buffer?.byteLength ?? null };
  const { images: additional, supportJson } = await recipeInputs(data.recipe);
  const recipeCompilerInputs = inputs.slice();
  if (supportJson !== undefined) recipeCompilerInputs[1] = supportJson;
  if (typeof program.CompileRecipe !== 'function' && data.recipe !== 'hello') throw Error('Rebuild the compiler host for library recipes');
  if (['json-generated', 'tunit', 'di'].includes(data.recipe) && typeof program.CompileGeneratedRecipe !== 'function') throw Error('Rebuild the compiler host for source generation');
  const result = JSON.parse(['json-generated', 'tunit', 'di'].includes(data.recipe)
    ? program.CompileGeneratedRecipe(data.source, ...recipeCompilerInputs, ...additional, data.recipe === 'tunit' ? 'tunit' : data.recipe === 'di' ? 'di' : 'json', false)
    : typeof program.CompileRecipe === 'function' ? program.CompileRecipe(data.source, ...recipeCompilerInputs, ...additional) : program.Compile(data.source, ...recipeCompilerInputs));
  if (typeof result.application === 'string') result.application = fromBase64(result.application);
  if (typeof result.pe === 'string') result.pe = fromBase64(result.pe);
  result.hostLinearMemoryBytes = runtime.Module?.HEAPU8?.buffer?.byteLength ?? null;
  return result;
});
