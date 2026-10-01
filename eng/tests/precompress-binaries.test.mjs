import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { brotliDecompressSync } from 'node:zlib';
import { precompressBinaries } from '../precompress-binaries.mjs';

test('binary sidecars round trip without modifying originals or other assets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'binary-sidecars-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'nested'));
  const binary = Buffer.from('trusted toolchain binary\0'.repeat(2048));
  await writeFile(join(root, 'nested', 'compiler.bin'), binary);
  await writeFile(join(root, 'engine.wasm'), binary);
  await writeFile(join(root, 'index.json'), '{"unchanged":true}');
  await writeFile(join(root, 'app.js'), 'console.log("unchanged");');
  await writeFile(join(root, 'engine.wasm.br'), 'stale sidecar');
  const results = await precompressBinaries(root);
  assert.equal(results.length, 2);
  for (const result of results) {
    const sidecar = await readFile(`${result.path}.br`);
    assert.deepEqual(brotliDecompressSync(sidecar), binary);
    assert.deepEqual(await readFile(result.path), binary);
    assert.ok(sidecar.length < binary.length);
  }
  assert.equal(await readFile(join(root, 'index.json'), 'utf8'), '{"unchanged":true}');
  assert.equal(await readFile(join(root, 'app.js'), 'utf8'), 'console.log("unchanged");');
  assert.deepEqual((await readdir(root)).sort(), ['app.js', 'engine.wasm', 'engine.wasm.br', 'index.json', 'nested']);
  const firstSidecar = await readFile(join(root, 'engine.wasm.br'));
  await precompressBinaries(root);
  assert.deepEqual(await readFile(join(root, 'engine.wasm.br')), firstSidecar);
});

test('writes sidecars for every binary, including tiny and empty files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'binary-sidecars-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'tiny.wasm'), Buffer.from([0, 1]));
  await writeFile(join(root, 'tiny.wasm.br'), 'stale sidecar');
  await writeFile(join(root, 'empty.bin'), Buffer.alloc(0));
  assert.equal((await precompressBinaries(root)).length, 2);
  assert.deepEqual(brotliDecompressSync(await readFile(join(root, 'tiny.wasm.br'))), Buffer.from([0, 1]));
  assert.deepEqual(brotliDecompressSync(await readFile(join(root, 'empty.bin.br'))), Buffer.alloc(0));
  assert.deepEqual((await readdir(root)).sort(), ['empty.bin', 'empty.bin.br', 'tiny.wasm', 'tiny.wasm.br']);
});
