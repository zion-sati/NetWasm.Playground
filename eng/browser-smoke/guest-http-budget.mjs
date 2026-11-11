import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { meterGuestHttpBodies } from '../../src/workers/guest-http-budget.mjs';

const root = resolve(process.env.PLAYGROUND_TOOLCHAIN ?? 'public/toolchain');
const { id } = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
const { createWasiHttpFetch, createGuestByteReader } =
  await import(pathToFileURL(join(root, id, 'jco/guest-host.mjs')).href);

// The published provider over a fetch that records what reaches it.
function provider(maximumBytes, denied) {
  const sent = [];
  const modules = meterGuestHttpBodies({
    modules: createWasiHttpFetch(Object.freeze({ fetch: async (url, init) => {
      sent.push(init.body?.byteLength ?? 0);
      return new Response('ok');
    } })),
    readGuestBytes: createGuestByteReader, onDenied: message => denied.push(message), maximumBytes,
  });
  const { Fields, Request } = modules['wasi:http/types@0.3.2'];
  const { send } = modules['wasi:http/client@0.3.2'];
  const post = async chunks => {
    const contents = (async function* () { for (const chunk of chunks) yield chunk; })();
    const [request] = Request.new(new Fields(), contents, Promise.resolve({ tag: 'ok', val: undefined }), undefined);
    request.setMethod({ tag: 'post' });
    request.setScheme({ tag: 'HTTPS' });
    request.setAuthority('example.test');
    return send(request);
  };
  return { post, sent };
}

const denied = [];
const { post, sent } = provider(128 * 1024, denied);
const chunk = new Uint8Array(64 * 1024);
assert.equal((await post([chunk, chunk])).tag, 'ok');
const refused = await post([new Uint8Array(1)]);
assert.equal(refused.tag, 'err');
assert.deepEqual(sent, [128 * 1024]);
assert.deepEqual(denied, [`Guest HTTP request body limit exceeded (${128 * 1024} bytes per run)`]);

// A fresh run starts with a fresh budget.
const fresh = provider(4096, []);
assert.equal((await fresh.post([new Uint8Array(4096)])).tag, 'ok');
assert.equal((await fresh.post([new Uint8Array(1)])).tag, 'err');
assert.deepEqual(fresh.sent, [4096]);

console.log('PASS public browser HTTP provider: bounded request bodies and fresh-run recovery');
