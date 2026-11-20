import assert from 'node:assert/strict';
import test from 'node:test';
import { assetRoot, createAssetLoader } from '../../src/workers/asset-loader.mjs';

test('asset paths take the runtime pack file names, plus signs included, and nothing that leaves the root', () => {
  const loader = createAssetLoader();
  // 0.15's runtime pack names libc++'s archives with plus signs.
  for (const name of ['runtime/wasm32/system/libc++-noexcept.a', 'runtime/wasm32/system/libc++abi-noexcept.a',
    'compiler/framework.json', 'tools/@scope/tool.wasm'])
    assert.equal(loader.url(name), new URL(name, assetRoot).href);
  for (const name of ['/runtime/libc.a', 'runtime/../secret', 'runtime//libc.a', 'runtime/./libc.a', 'runtime/lib c.a',
    'runtime/libc.a?query', 'https://example.test/libc.a', 7])
    assert.throws(() => loader.url(name), /Invalid tool asset path/);
});
