import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeAotCompilerChannel } from '../../src/workers/native-compiler-channel.mjs';

test('native transport forwards the entire override record on every compilation path', async () => {
  const source = `
    export const requests = [];
    const heap = new Uint8Array(1048576);
    const encoder = new TextEncoder(), decoder = new TextDecoder();
    const result = encoder.encode(JSON.stringify({success:false}));
    let cursor = 16;
    export default async () => ({
      HEAPU8:heap,
      _NetWasmCompiler_Alloc(size) { const p=cursor; cursor+=size; return p; },
      _NetWasmCompiler_Free() {},
      _NetWasmCompiler_Invoke(p,n) {
        requests.push(JSON.parse(decoder.decode(heap.subarray(p,p+n))));
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
    optimizationOverrides: overrides };
  try {
    for (const [recipe, projectKind, cached, operation] of [
      ['hello', 'command', false, 'compileRecipe'],
      ['json-generated', 'command', false, 'compileGeneratedRecipe'],
      ['hello', 'jsexport-worker', false, 'compileProject'],
      ['hello', 'command', true, 'prepareRecipe'],
      ['json-generated', 'command', true, 'prepareGeneratedRecipe'],
    ]) {
      const channel = createNativeAotCompilerChannel({ assetLoader: loader,
        createFrontendCache: () => ({ close() {} }) });
      if (cached) await channel.request({ operation: 'initialize', toolchainId: 'test' });
      await channel.request({ ...request, recipe, projectKind, frontendCache: cached });
      const actual = native.requests.at(-1);
      assert.equal(actual.operation, operation);
      assert.equal(actual.arguments.at(-2), 'NetWasm');
      assert.deepEqual(JSON.parse(actual.arguments.at(-1)), overrides);
      channel.reset();
    }
    const channel = createNativeAotCompilerChannel({ assetLoader: loader });
    await channel.request({ ...request, recipe: 'hello', optimizationOverrides: undefined });
    assert.equal(native.requests.at(-1).arguments.at(-1), 'null');
    channel.reset();
  } finally {
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else delete globalThis.location;
  }
});
