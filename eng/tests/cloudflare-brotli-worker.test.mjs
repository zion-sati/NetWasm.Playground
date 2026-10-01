import assert from 'node:assert/strict';
import test from 'node:test';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { serveBrotli } from '../cloudflare-brotli-worker.mjs';

const hashed = `https://playground.netwasm.com/toolchain/id/bundles/compiler.${'a'.repeat(64)}.bin`;
const wasm = 'https://regexstorm.netwasm.com/engine/RegexStorm-component.core.wasm';
const request = (url = hashed, headers = { 'Accept-Encoding': 'gzip, br' }, method = 'GET') =>
  new Request(url, { method, headers });

test('serves the exact sidecar bytes with binary headers and immutable caching', async () => {
  const original = Buffer.from('toolchain binary'.repeat(100));
  const compressed = brotliCompressSync(original);
  let upstream;
  const response = await serveBrotli(request(`${hashed}?revision=1`), async (input, options) => {
    upstream = { input, options };
    return new Response(compressed, { headers: { 'Content-Type': 'application/octet-stream',
      'Cache-Control': 'max-age=600', Vary: 'Origin', ETag: '"sidecar"', 'Accept-Ranges': 'bytes' } });
  });
  assert.equal(upstream.input.url, `${hashed}.br?revision=1`);
  assert.equal(upstream.input.headers.get('Accept-Encoding'), 'identity');
  assert.equal(upstream.options.cf.cacheTtlByStatus['404'], 0);
  assert.equal(response.headers.get('Content-Encoding'), 'br');
  assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(response.headers.get('Vary'), 'Origin, Accept-Encoding');
  assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable, no-transform');
  assert.equal(response.headers.get('ETag'), '"sidecar"');
  assert.equal(response.headers.get('Accept-Ranges'), null);
  assert.equal(response.headers.get('X-NetWasm-Precompressed'), 'br11');
  const received = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(received, compressed);
  assert.deepEqual(brotliDecompressSync(received), original);
});

test('preserves a short cache lifetime and correct MIME type for fixed Wasm URLs', async () => {
  const response = await serveBrotli(request(wasm), async () =>
    new Response('compressed', { headers: { 'Cache-Control': 'max-age=600' } }));
  assert.equal(response.headers.get('Content-Type'), 'application/wasm');
  assert.equal(response.headers.get('Cache-Control'), 'max-age=600, no-transform');
});

test('falls back to the original without relabeling missing or unusable sidecars', async () => {
  for (const sidecar of [new Response('missing', { status: 404 }),
    new Response('unavailable', { status: 503 }),
    new Response(null, { status: 302, headers: { Location: '/error' } }),
    new Response('outer gzip', { headers: { 'Content-Encoding': 'gzip' } })]) {
    const calls = [];
    const original = new Response('original');
    assert.equal(await serveBrotli(request(), async input => {
      calls.push(input.url);
      return calls.length === 1 ? sidecar : original;
    }), original);
    assert.deepEqual(calls, [`${hashed}.br`, hashed]);
  }
});

test('passes other assets, direct sidecars, ranges, and unsupported clients through', async () => {
  const requests = [request('https://www.netwasm.com/index.html'), request(`${hashed}.br`),
    request(hashed, { 'Accept-Encoding': 'gzip' }),
    request(hashed, { 'Accept-Encoding': 'br;q=0, *;q=1' }),
    request(hashed, { 'Accept-Encoding': 'br', Range: 'bytes=0-10' }),
    request(hashed, { 'Accept-Encoding': 'br', 'If-Range': '"original"' }),
    request(hashed, { 'Accept-Encoding': 'br', Authorization: 'test' }),
    request(hashed, { 'Accept-Encoding': 'br' }, 'POST')];
  const normalized = request();
  normalized.cf = { clientAcceptEncoding: 'gzip' };
  requests.push(normalized);
  for (const incoming of requests) {
    const calls = [];
    const original = new Response('original');
    assert.equal(await serveBrotli(incoming, async input => {
      calls.push(input);
      return original;
    }), original);
    assert.deepEqual(calls, [incoming]);
  }
});

test('supports HEAD and conditional requests without downloading or inventing a body', async () => {
  for (const [method, status] of [['HEAD', 200], ['GET', 304]]) {
    const response = await serveBrotli(request(wasm, { 'Accept-Encoding': 'br' }, method), async input => {
      assert.equal(input.method, method);
      return new Response(null, { status, headers: { ETag: '"sidecar"' } });
    });
    assert.equal(response.status, status);
    assert.equal(response.body, null);
    assert.equal(response.headers.get('Content-Encoding'), 'br');
  }
});
