import assert from 'node:assert/strict';
import test from 'node:test';
import { materializeRuntimeLinkPlan } from '../../src/runtime-link-plan.mjs';

const digest = character => character.repeat(64);
const plan = () => ({
  Arguments: [
    '--export=initialize',
    '--export=ephemeron_handle_new',
    '--export=command_exception_capture',
    '-o',
    '/netwasm-link/runtime.wasm',
  ],
  OptimizationArguments: [
    '--post-emscripten', '-Oz', '--zero-filled-memory',
    '/netwasm-link/runtime.wasm', '-o', '/netwasm-link/runtime.wasm',
  ],
  RuntimeGlobalBase: 1152,
  Cache: {
    schema: 'runtime-materialization-cache-v1',
    namespace: digest('a'),
    slot: digest('b'),
    key: digest('c'),
  },
});

test('explicit empty feature evidence selects the base runtime and optimization policy', async () => {
  const original = plan();
  const actual = await materializeRuntimeLinkPlan(original, []);

  assert.deepEqual(actual.Arguments,
    ['--export=initialize', '-o', '/netwasm-link/runtime.wasm']);
  assert.deepEqual(actual.OptimizationArguments.slice(0, 4),
    ['--post-emscripten', '-Oz', '--low-memory-unused', '--zero-filled-memory']);
  assert.notEqual(actual.Cache.key, original.Cache.key);
  assert.equal(actual.Cache.namespace, original.Cache.namespace);
  assert.equal(actual.Cache.slot, original.Cache.slot);
});

test('compiler feature evidence preserves only the requested optional capability', async () => {
  const ephemerons = await materializeRuntimeLinkPlan(plan(), ['ephemeron-handles']);
  const diagnostics = await materializeRuntimeLinkPlan(plan(), ['structured-command-diagnostics']);

  assert(ephemerons.Arguments.includes('--export=ephemeron_handle_new'));
  assert(!ephemerons.Arguments.includes('--export=command_exception_capture'));
  assert(!diagnostics.Arguments.includes('--export=ephemeron_handle_new'));
  assert(diagnostics.Arguments.includes('--export=command_exception_capture'));
  assert.notEqual(ephemerons.Cache.key, diagnostics.Cache.key);
});

test('missing feature evidence retains legacy exports', async () => {
  const original = plan();
  original.RuntimeGlobalBase = 1008;
  const actual = await materializeRuntimeLinkPlan(original, undefined);

  assert.equal(actual, original);
});

test('the derived cache identity is stable', async () => {
  const first = await materializeRuntimeLinkPlan(plan(), []);
  const second = await materializeRuntimeLinkPlan(plan(), []);

  assert.equal(first.Cache.key, second.Cache.key);
  assert.match(first.Cache.key, /^[a-f0-9]{64}$/);
});
