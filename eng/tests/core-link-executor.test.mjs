import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
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

test('executes the compiler-qualified portable version-one fixture', async () => {
  const json = await readFile(new URL('./fixtures/ordered-link-v1.json', import.meta.url), 'utf8');
  const calls = [];
  const result = await executeCoreLink(json, { 'application.wasm': new Uint8Array([1]) }, {
    checkCancelled() {},
    async parse(text) { assert.equal(text, '(module)'); calls.push('text'); return new Uint8Array([2]); },
    async inline(bytes, selection) {
      assert.equal(selection, 'Preserve'); calls.push('inline'); return bytes;
    },
    async exports(bytes, operation) {
      assert.equal(operation.componentPrefix, null); assert.deepEqual(operation.removedExports, []);
      calls.push('exports'); return bytes;
    },
    async tool(id, args, inputs, outputs) {
      calls.push(id);
      if (id === 'wasm-merge') {
        assert.deepEqual(args, ['input-0', 'application', 'input-1', 'environment', '--output', 'output-0']);
        assert.deepEqual([...inputs['input-0']], [1]);
        assert.deepEqual([...inputs['input-1']], [2]);
        assert.deepEqual(outputs, ['output-0']);
        return { 'output-0': new Uint8Array([3]) };
      }
      assert.equal(id, 'wasm-tools');
      assert.deepEqual(args, ['validate', 'input-0', '--features', 'mvp']);
      assert.deepEqual([...inputs['input-0']], [3]);
      assert.deepEqual(outputs, []);
      return {};
    },
  });
  assert.deepEqual(calls, ['text', 'inline', 'wasm-merge', 'exports', 'wasm-tools']);
  assert.deepEqual(Object.keys(result), ['result.wasm']);
  assert.deepEqual([...result['result.wasm']], [3]);
});

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

test('text and export operations preserve compiler order and publish owned bytes', async () => {
  const operations = [
    { kind: 'text', text: '(module)', outputPath: 'text' },
    { kind: 'exports', inputPath: 'text', outputPath: 'edited', componentPrefix: 'component', removedExports: [] },
    { kind: 'move', inputPath: 'edited', outputPath: 'final' },
  ];
  const calls = [];
  const result = await executeCoreLink(JSON.stringify({ plan: {
    schemaVersion: 1, requiredCapabilities: ['text', 'exports', 'move'],
    inputs: [], outputs: ['final'], temporaryPaths: ['text', 'edited'], operations,
  }, invocations: {} }), {}, {
    checkCancelled() {},
    async parse(text) { calls.push(text); return new Uint8Array([1]); },
    async exports(bytes, operation) {
      calls.push(operation.componentPrefix);
      assert.deepEqual(operation, operations[1]);
      bytes[0] = 2;
      return bytes;
    },
  });
  assert.deepEqual(calls, ['(module)', 'component']);
  assert.deepEqual(Object.keys(result), ['final']);
  assert.deepEqual([...result.final], [2]);
});

test('malformed envelopes and bindings fail before host execution', async () => {
  const invalid = [
    value => { value.plan.schemaVersion = 2; },
    value => { delete value.plan.operations; },
    value => { value.plan.operations = []; },
    value => { delete value.plan.requiredCapabilities; },
    value => { delete value.plan.inputs; },
    value => { delete value.plan.outputs; },
    value => { value.plan.outputs = []; },
    value => { delete value.plan.temporaryPaths; },
    value => { delete value.invocations; },
    value => { value.plan.requiredCapabilities.push('tool'); },
    value => { value.plan.requiredCapabilities.push('unknown'); },
    value => { value.plan.operations[0] = null; },
    value => { value.plan.requiredCapabilities = ['tool', 'validate', 'move']; },
    value => { delete value.invocations[1]; },
    value => { value.invocations[1].toolId = 'unknown'; },
    value => { value.invocations[1].arguments = null; },
    value => { value.invocations[1].arguments = [false]; },
    value => { value.invocations[1].inputs = null; },
    value => { value.invocations[1].outputs = null; },
    value => { value.invocations[1].toolId = 'wasm-merge'; },
    value => { value.invocations[1].inputs[0] = null; },
    value => { value.invocations[1].inputs[0].logicalPath = 1; },
    value => { value.invocations[1].inputs[0].physicalName = 1; },
    value => { value.invocations[1].inputs[0].physicalName = '../input'; },
    value => { value.invocations[1].outputs[0].physicalName = 'input-0'; },
    value => { value.plan.requiredCapabilities.push('text'); },
    value => { value.invocations[0] = value.invocations[1]; },
  ];
  for (const mutate of invalid) {
    const envelope = fixture();
    mutate(envelope);
    await assert.rejects(executeCoreLink(envelope, { app: new Uint8Array([1]) }, {
      checkCancelled() { assert.fail('preflight must precede execution'); },
    }));
  }
});

test('missing inputs and missing tool outputs cannot escape as published artifacts', async () => {
  await assert.rejects(executeCoreLink(fixture(), {}, {
    checkCancelled() { assert.fail('missing input must fail before execution'); },
  }), /Missing core link input/);
  await assert.rejects(executeCoreLink(fixture(), { app: new Uint8Array([1]) }, {
    checkCancelled() {},
    async inline(bytes) { return bytes; },
    async tool() { return {}; },
  }), /did not produce its declared output/);
  const missingRead = fixture();
  missingRead.plan.operations[0].inputPath = 'missing';
  await assert.rejects(executeCoreLink(missingRead, { app: new Uint8Array([1]) }, {
    checkCancelled() {},
  }), /Missing core link artifact/);
});
