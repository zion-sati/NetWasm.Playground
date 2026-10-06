import assert from 'node:assert/strict';
import test from 'node:test';
import { cloneProjectFiles, createProject, inferNativeLibraryName, normalizeProjectPath,
  serializeSourceSet, validateNativeLibraryName, validateProjectFiles, validateWasmArchive } from '../../src/workspace.ts';

function archive(member) {
  const encoder = new TextEncoder();
  const header = `${'sample.o/'.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'644'.padEnd(8)}${String(member.length).padEnd(10)}\`\n`;
  const result = new Uint8Array(8 + 60 + member.length + (member.length & 1));
  result.set(encoder.encode('!<arch>\n'));
  result.set(encoder.encode(header), 8);
  result.set(member, 68);
  if (member.length & 1) result[result.length - 1] = 10;
  return result;
}

const wasmObject = () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0,
  0, 9, 7, 108, 105, 110, 107, 105, 110, 103, 2]);

test('serializes an ordered, versioned multi-file source set', () => {
  const project = createProject('Example', [
    { path: 'Program.cs', text: 'Console.WriteLine(Answer.Value);' },
    { path: 'Domain/Answer.cs', text: 'static class Answer { public const int Value = 42; }' },
  ]);
  const sourceSet = JSON.parse(serializeSourceSet(project.files));
  assert.deepEqual(sourceSet, { schemaVersion: 1, files: [
    { path: 'Program.cs', text: 'Console.WriteLine(Answer.Value);' },
    { path: 'Domain/Answer.cs', text: 'static class Answer { public const int Value = 42; }' },
  ] });
});

test('rejects traversal, duplicate paths, excess files and excess bytes', () => {
  assert.throws(() => normalizeProjectPath('../Program.cs'));
  assert.throws(() => normalizeProjectPath('bad:name.cs'));
  const duplicate = createProject('Example', [{ path: 'Program.cs', text: '' }]).files[0];
  assert.throws(() => validateProjectFiles([duplicate, { ...duplicate, id: 'second' }]));
  assert.throws(() => validateProjectFiles(Array.from({ length: 33 }, (_, index) =>
    ({ id: String(index), path: `File${index}.cs`, kind: 'csharp', text: '' }))));
  assert.throws(() => validateProjectFiles([
    { id: 'large', path: 'Large.cs', kind: 'csharp', text: 'x'.repeat(65537) },
  ]));
});

test('keeps editable project assets out of the compiler source set', () => {
  const project = createProject('Worker', [
    { path: 'Worker.cs', text: 'public static class Worker {}' },
    { path: 'client.mjs', text: 'export {};' },
    { path: 'worker.wit', text: 'package example:worker;' },
  ]);

  assert.equal(project.schemaVersion, 2);
  assert.deepEqual(project.files.map(file => file.kind), ['csharp', 'javascript', 'wit']);
  assert.deepEqual(JSON.parse(serializeSourceSet(project.files)).files,
    [{ path: 'Worker.cs', text: 'public static class Worker {}' }]);
});

test('validates and clones native archives as owned binary project assets', () => {
  const project = createProject('Native', [
    { path: 'Program.cs', text: 'class Program {}' },
    { path: 'native/liblz4.a', kind: 'native-archive', bytes: archive(wasmObject()),
      libraryName: 'lz4' },
  ]);
  const cloned = cloneProjectFiles(project.files);

  assert.equal(inferNativeLibraryName('native/liblz4.a'), 'lz4');
  assert.equal(validateNativeLibraryName(' custom.native '), 'custom.native');
  assert.throws(() => validateNativeLibraryName('../native'));
  assert.notEqual(cloned[1].bytes, project.files[1].bytes);
  assert.deepEqual(cloned[1].bytes, project.files[1].bytes);
  assert.throws(() => validateProjectFiles([
    project.files[0], { ...project.files[1], libraryName: '../lz4' },
  ]));
  assert.equal(validateWasmArchive(project.files[1].bytes), 1);
  assert.throws(() => validateWasmArchive(archive(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))),
    /not a WebAssembly object/);
});
