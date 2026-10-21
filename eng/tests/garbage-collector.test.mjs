import assert from 'node:assert/strict';
import test from 'node:test';
import { garbageCollectors, garbageCollectorLabels, parseGarbageCollector, storedGarbageCollector } from '../../src/garbage-collector.ts';

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

test('a stored collector that NetWasm removed falls back to Compact', () => {
  assert.equal(storedGarbageCollector('Boehm'), 'Compact');
  assert.equal(storedGarbageCollector(null), 'Compact');
  for (const collector of garbageCollectors) assert.equal(storedGarbageCollector(collector), collector);
  assert.throws(() => parseGarbageCollector('Boehm'), /Unknown garbage collector/);
});
