import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeAotCompilerChannel } from '../../src/workers/native-compiler-channel.mjs';

test('native transport forwards the entire override record on every compilation path', async () => {
  const source = `
    export const requests = [];
    const heap = new Uint8Array(1048576);
    const encoder = new TextEncoder(), decoder = new TextDecoder();
    // A compile call stops once C# has compiled; compileWebAssembly finishes it.
    const prepared = encoder.encode(JSON.stringify({success:true,prepared:true}));
    const finished = encoder.encode(JSON.stringify({success:false}));
    let result = finished;
    let cursor = 16;
    export default async () => ({
      HEAPU8:heap,
      _NetWasmCompiler_Alloc(size) { const p=cursor; cursor+=size; return p; },
      _NetWasmCompiler_Free() {},
      _NetWasmCompiler_Invoke(p,n) {
        const request = JSON.parse(decoder.decode(heap.subarray(p,p+n)));
        requests.push(request);
        result = request.operation.startsWith('compile') && request.operation !== 'compileWebAssembly'
          ? prepared : finished;
        return result.length;
      },
      _NetWasmCompiler_CopyResult(p) { heap.set(result,p); return result.length; }
    });`;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const native = await import(moduleUrl);
  const encoder = new TextEncoder();
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://example.test' } });
  const loader = {
    installFetchAdapter() {},
    url() { return moduleUrl; },
    async manifest() { return { 'recipes/json-generated.json': {} }; },
    async load(path) {
      if (path.endsWith('nativeaot-compiler-receipt.json'))
        return encoder.encode(JSON.stringify({ files: { 'compiler.mjs': {} } }));
      if (path === 'compiler/runtime-pack.json')
        return encoder.encode(JSON.stringify({ targets: [{ target: 'wasm32', systemLibraries: { names: [] } }] }));
      if (path === 'recipes/json-generated.json')
        return encoder.encode(JSON.stringify({ schemaVersion: 1, id: 'json-generated', references: {}, implementations: {} }));
      return encoder.encode('{}');
    },
  };
  const overrides = {
    managedInliningHints: 'Preserve', loopInvariantFieldHoisting: 'Enabled',
    staticDataViewElimination: 'Disabled', addressTakenValuePromotion: 'Enabled',
    managedMethodInlining: 'Enabled', branchPrefixDuplication: 'Disabled',
    scalarCallPreservation: 'Enabled', arrayBoundsCheckElimination: 'Disabled',
    loopUnrolling: 'Enabled', constantArgumentPropagation: 'Disabled',
    staticArrayPopulationElimination: 'Enabled',
  };
  const request = { operation: 'compile', sourceSet: '{}', language: '15',
    updatedMemorySafetyRules: false, optimization: 'O3', garbageCollector: 'NetWasm',
    structuredDiagnostics: true, optimizationOverrides: overrides };
  try {
    for (const [recipe, projectKind, operation] of [
      ['hello', 'command', 'compileRecipe'],
      ['json-generated', 'command', 'compileGeneratedRecipe'],
      ['hello', 'jsexport-worker', 'compileProject'],
    ]) {
      const channel = createNativeAotCompilerChannel({ assetLoader: loader,
        createFrontendCache: () => ({ close() {} }) });
      await channel.request({ operation: 'initialize', toolchainId: 'test' });
      await channel.request({ ...request, recipe, projectKind, compiledUnits: false });
      // A compilation that asks for none keeps no compiled units.
      assert.deepEqual(native.requests.slice(-2),
        [{ operation: 'useCompiledUnits', arguments: [''] }, { operation: 'compileWebAssembly', arguments: [] }]);
      const actual = native.requests.at(-3);
      assert.equal(actual.operation, operation);
      assert.equal(actual.arguments.at(-3), 'NetWasm');
      assert.equal(actual.arguments.at(-2), 'true');
      assert.deepEqual(JSON.parse(actual.arguments.at(-1)), overrides);
      channel.reset();
    }
    // A compilation restores its stored units once per worker, under a name for its settings.
    const loads = [];
    const units = createNativeAotCompilerChannel({ assetLoader: loader,
      createFrontendCache: () => ({
        async loadRuntime(descriptor) {
          loads.push(descriptor);
          return { hit: true, available: true, payload: encoder.encode('units') };
        },
        close() {},
      }) });
    await units.request({ operation: 'initialize', toolchainId: 'test' });
    for (let compilation = 0; compilation < 2; compilation++)
      await units.request({ ...request, recipe: 'hello', optimization: 'None' });
    const name = 'units/None/NetWasm/true/' + JSON.stringify(overrides);
    assert.deepEqual(native.requests.slice(-7).map(item => item.operation),
      ['compileRecipe', 'importCompiledUnits', 'useCompiledUnits', 'compileWebAssembly',
        'compileRecipe', 'useCompiledUnits', 'compileWebAssembly']);
    assert.deepEqual(native.requests.at(-6).arguments, [name, Buffer.from('units').toString('base64')]);
    assert.deepEqual(native.requests.at(-5).arguments, [name]);
    assert.equal(loads.length, 1);
    assert.equal(loads[0].schema, 'compiled-units');
    assert.match(loads[0].slot, /^[a-f0-9]{64}$/);
    units.reset();
    const channel = createNativeAotCompilerChannel({ assetLoader: loader });
    await channel.request({ ...request, recipe: 'hello', optimizationOverrides: undefined,
      structuredDiagnostics: undefined });
    assert.equal(native.requests.at(-3).operation, 'compileRecipe');
    assert.equal(native.requests.at(-3).arguments.at(-1), 'null');
    assert.equal(native.requests.at(-3).arguments.at(-2), 'false');
    channel.reset();
  } finally {
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else delete globalThis.location;
  }
});
