import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../public/coi-service-worker.js', import.meta.url), 'utf8');

test('preserves null-body responses while adding isolation headers', async () => {
  const listeners = new Map();
  const self = {
    location: { origin: 'https://playground.netwasm.com' },
    addEventListener: (name, listener) => listeners.set(name, listener),
    skipWaiting: () => undefined,
    clients: { claim: () => undefined },
  };
  const upstream = {
    type: 'basic',
    status: 204,
    statusText: 'No Content',
    headers: new Headers({ 'Cache-Control': 'no-store' }),
    // WebKit can expose a stream here even though reconstructed 204 responses
    // are forbidden from carrying one.
    body: new Uint8Array([1]),
  };
  vm.runInNewContext(source, {
    self,
    fetch: async () => upstream,
    URL,
    Headers,
    Response,
    Set,
    Object,
  });

  let responsePromise;
  listeners.get('fetch')({
    request: {
      url: 'https://playground.netwasm.com/cdn-cgi/rum',
      method: 'POST',
      cache: 'default',
      mode: 'cors',
    },
    respondWith: value => { responsePromise = value; },
  });
  const response = await responsePromise;

  assert.equal(response.status, 204);
  assert.equal(response.body, null);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.equal(response.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
});
