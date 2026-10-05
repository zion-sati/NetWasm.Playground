import assert from 'node:assert/strict';
import test from 'node:test';
import { createProject, normalizeProjectPath, serializeSourceSet, validateProjectFiles } from '../../src/workspace.ts';

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
