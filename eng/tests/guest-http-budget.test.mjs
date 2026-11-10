import assert from 'node:assert/strict';
import test from 'node:test';
import { meterGuestHttpBodies } from '../../src/workers/guest-http-budget.mjs';

// The provider's shape: requests come from Request.new, which keeps the body stream.
class Request {
  constructor() { throw new TypeError('a request is created with Request.new'); }
  static new(headers, contents) {
    const request = Object.create(Request.prototype);
    request.contents = contents;
    return [request, Promise.resolve()];
  }
  static consumeBody(request) { return [request.contents]; }
}
const typesModule = 'wasi:http/types@0.3.2';
const clientModule = 'wasi:http/client@0.3.2';
const modules = Object.freeze({
  [typesModule]: Object.freeze({ Fields: class Fields {}, Request }),
  [clientModule]: Object.freeze({ send() {} }),
});
// A guest body here is its list of chunks, read one at a time.
const readGuestBytes = chunks => {
  let index = 0;
  return async () => index < chunks.length ? chunks[index++] : null;
};
const body = (...sizes) => sizes.map(size => new Uint8Array(size));
async function lengths(contents) {
  const read = [];
  for await (const chunk of contents) read.push(chunk.byteLength);
  return read;
}

test('keeps the provider request class identity and its other modules', () => {
  const metered = meterGuestHttpBodies({ modules, readGuestBytes });
  const MeteredRequest = metered[typesModule].Request;
  const [request] = MeteredRequest.new(undefined, undefined);
  assert.ok(request instanceof MeteredRequest);
  assert.ok(request instanceof Request);
  assert.equal(request.contents, undefined);
  assert.equal(MeteredRequest.consumeBody, Request.consumeBody);
  assert.equal(metered[typesModule].Fields, modules[typesModule].Fields);
  assert.equal(metered[clientModule], modules[clientModule]);
  assert.ok(Object.isFrozen(metered) && Object.isFrozen(metered[typesModule]));
  assert.throws(() => new MeteredRequest(), /created with Request.new/);
});

test('meters every request body of a run against one limit', async () => {
  const denied = [];
  const metered = meterGuestHttpBodies({ modules, readGuestBytes, onDenied: message => denied.push(message), maximumBytes: 10 });
  const MeteredRequest = metered[typesModule].Request;
  const [first] = MeteredRequest.new(undefined, body(4, 4));
  assert.deepEqual(await lengths(first.contents), [4, 4]);
  const [second] = MeteredRequest.new(undefined, body(2, 1));
  const read = [];
  await assert.rejects(async () => { for await (const chunk of second.contents) read.push(chunk.byteLength); },
    /^Error: Guest HTTP request body limit exceeded \(10 bytes per run\)$/);
  assert.deepEqual(read, [2]);
  assert.deepEqual(denied, ['Guest HTTP request body limit exceeded (10 bytes per run)']);
});

test('rejects an invalid limit, reader or provider', () => {
  assert.throws(() => meterGuestHttpBodies({ modules, readGuestBytes, maximumBytes: 0 }), /Invalid guest HTTP byte limit/);
  assert.throws(() => meterGuestHttpBodies({ modules, readGuestBytes, maximumBytes: 1.5 }), /Invalid guest HTTP byte limit/);
  assert.throws(() => meterGuestHttpBodies({ modules }), /Invalid guest HTTP body reader/);
  assert.throws(() => meterGuestHttpBodies({ modules: {}, readGuestBytes }), /Unsupported browser HTTP provider/);
});
