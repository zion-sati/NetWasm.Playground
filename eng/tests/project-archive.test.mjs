import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProjectArchive, projectArchiveName } from '../../src/project-archive.ts';
import { createProject } from '../../src/workspace.ts';

const decoder = new TextDecoder();

function nativeArchive() {
  const object = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0,
    0, 9, 7, 108, 105, 110, 107, 105, 110, 103, 2]);
  const header = `${'sample.o/'.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'644'.padEnd(8)}${String(object.length).padEnd(10)}\`\n`;
  const result = new Uint8Array(8 + 60 + object.length + (object.length & 1));
  result.set(new TextEncoder().encode('!<arch>\n'));
  result.set(new TextEncoder().encode(header), 8);
  result.set(object, 68);
  if (object.length & 1) result[result.length - 1] = 10;
  return result;
}

function readEntries(bytes) {
  const entries = new Map();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0, 'project ZIP should use portable stored entries');
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    entries.set(name, bytes.slice(start, start + size));
    offset = start + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50, 'project ZIP has no central directory');
  return entries;
}

test('writes a deterministic portable project ZIP with settings and binary files', () => {
  const binary = nativeArchive();
  const project = createProject('Worker / Native', [
    { path: 'Worker.cs', text: 'public static class Worker {}' },
    { path: 'progress.mjs', text: 'export function report() {}\n' },
  ], 'web-worker');
  project.kind = 'jsexport-worker';
  project.files.push({ id: 'native', path: 'native/libsample.a', kind: 'native-archive',
    bytes: binary, libraryName: 'sample', target: 'wasm32' });
  const settings = { language: 'preview', updatedMemorySafetyRules: true,
    runOptimization: 'none', publishOptimization: 'Oz' };

  const first = buildProjectArchive(project, settings);
  const second = buildProjectArchive(project, settings);
  const entries = readEntries(first);
  const manifest = JSON.parse(decoder.decode(entries.get('netwasm-project.json')));

  assert.deepEqual(first, second);
  assert.equal(projectArchiveName(project.name), 'Worker-Native.zip');
  assert.equal(decoder.decode(entries.get('Worker.cs')), 'public static class Worker {}');
  assert.equal(decoder.decode(entries.get('progress.mjs')), 'export function report() {}\n');
  assert.deepEqual(entries.get('native/libsample.a'), binary);
  assert.deepEqual(manifest.profiles, {
    run: { optimization: 'none' }, publish: { optimization: 'Oz' },
  });
  assert.equal(manifest.projectKind, 'jsexport-worker');
  assert.deepEqual(manifest.files.find(file => file.path === 'native/libsample.a'), {
    path: 'native/libsample.a', kind: 'native-archive', libraryName: 'sample', target: 'wasm32',
  });
});
