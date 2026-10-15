import assert from 'node:assert/strict';
import test from 'node:test';
import { executeCoreLink } from '../../src/core-link-executor.mjs';

function fixture() {
  return { plan: { schemaVersion: 1, requiredCapabilities: ['inline', 'tool', 'validate', 'move'],
    inputs: ['app'], outputs: ['final'], temporaryPaths: ['stage'], operations: [
      { kind: 'inline', inputPath: 'app', outputPath: 'stage', selection: 'Preserve' },
      { kind: 'tool', toolId: 'wasm-opt' }, { kind: 'validate', path: 'stage' },
      { kind: 'move', inputPath: 'stage', outputPath: 'final' },
    ] }, invocations: {
    1: { toolId: 'wasm-opt', arguments: ['input-0', '-Oz', '--output', 'output-0'],
      inputs: [{ logicalPath: 'stage', physicalName: 'input-0' }], outputs: [{ logicalPath: 'stage', physicalName: 'output-0' }] },
    2: { toolId: 'wasm-tools', arguments: ['validate', 'input-0', '--features', 'mvp'],
      inputs: [{ logicalPath: 'stage', physicalName: 'input-0' }], outputs: [] },
  } };
}

test('executes order and in-place versions without transferring retained inputs', async () => {
  const input = new Uint8Array([1, 2]); const calls = [];
  const result = await executeCoreLink(fixture(), { app: input }, {
    checkCancelled() {},
    async inline(bytes, selection) { calls.push(selection); bytes[0] = 3; return bytes; },
    async tool(id, args, files, outputs) {
      calls.push(id);
      assert.equal(files['input-0'][0], 3);
      const bytes = structuredClone(files['input-0'], { transfer: [files['input-0'].buffer] });
      return outputs.length ? { 'output-0': bytes } : {};
    },
  });
  assert.deepEqual(calls, ['Preserve', 'wasm-opt', 'wasm-tools']);
  assert.deepEqual([...result.final], [3, 2]);
  assert.deepEqual([...input], [1, 2]);
});

test('unknown trailing capabilities fail before any execution', async () => {
  const envelope = fixture(); envelope.plan.operations.push({ kind: 'unknown' });
  await assert.rejects(executeCoreLink(envelope, { app: new Uint8Array([1]) }, {
    checkCancelled() { assert.fail('execution must not start'); },
  }), /Unsupported core link operation/);
});

test('cancellation after a tool prevents publication', async () => {
  let cancelled = false;
  await assert.rejects(executeCoreLink(fixture(), { app: new Uint8Array([1]) }, {
    checkCancelled() { if (cancelled) throw Error('cancelled'); },
    async inline(bytes) { cancelled = true; return bytes; },
  }), /cancelled/);
});
