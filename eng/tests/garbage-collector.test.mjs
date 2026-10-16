import assert from 'node:assert/strict';
import test from 'node:test';
import { garbageCollectors, garbageCollectorLabels, parseGarbageCollector } from '../../src/garbage-collector.ts';

test('legacy settings default to Compact', () => {
  assert.equal(parseGarbageCollector(undefined), 'Compact');
  assert.equal(parseGarbageCollector(null), 'Compact');
});

test('collector identities round trip without label substitution', () => {
  for (const collector of garbageCollectors) {
    assert.equal(parseGarbageCollector(collector), collector);
    assert.ok(garbageCollectorLabels[collector]);
  }
  assert.equal(garbageCollectorLabels.NetWasm, 'NetWasmGC');
});

test('unknown selections are rejected instead of changing collector', () => {
  for (const invalid of ['', 'compact', 'NetWasmGC', 'O3', 0, {}, []])
    assert.throws(() => parseGarbageCollector(invalid), /Unknown garbage collector/);
});
