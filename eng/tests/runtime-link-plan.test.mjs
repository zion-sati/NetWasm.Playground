import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptRuntimeLinkPlan } from '../../src/runtime-link-plan.mjs';

function plan(collector) {
  return {
    Arguments: ['--export=initialize', '--export=ephemeron_handle_new', '-o', '/runtime.wasm'],
    OptimizationArguments: ['-Oz', '--low-memory-unused', '/runtime.wasm', '-o', '/runtime.wasm'],
    RuntimeGlobalBase: 1152,
    GarbageCollector: collector,
    Cache: { schema: 'runtime-materialization-cache-v1', namespace: 'a'.repeat(64),
      slot: 'b'.repeat(64), key: 'c'.repeat(64) },
  };
}

test('preserves compiler arguments and cache identity for every collector', () => {
  for (const collector of ['Compact', 'NetWasm', 'Bump']) {
    const original = plan(collector);
    const snapshot = structuredClone(original);
    assert.equal(acceptRuntimeLinkPlan(original), original);
    assert.deepEqual(original, snapshot);
  }
});

test('does not invent an optimizer invocation for None', () => {
  const original = plan('Compact'); original.OptimizationArguments = [];
  assert.equal(acceptRuntimeLinkPlan(original), original);
  assert.deepEqual(original.OptimizationArguments, []);
});

test('rejects missing identity and malformed argument transport', () => {
  for (const invalid of [
    null, {}, { ...plan('Compact'), Arguments: [42] },
    { ...plan('Compact'), OptimizationArguments: null },
    { ...plan('Compact'), GarbageCollector: '' },
    { ...plan('Compact'), RuntimeGlobalBase: NaN },
    { ...plan('Compact'), Cache: { ...plan('Compact').Cache, key: 'invalid' } },
  ]) assert.throws(() => acceptRuntimeLinkPlan(invalid), /Invalid runtime link plan/);
});
