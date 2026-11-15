import assert from 'node:assert/strict';
import test from 'node:test';
import { observeUntilServed, sha256, validateObservedSiteIdentity } from '../site-identity.mjs';

const site = 'a'.repeat(64);
const toolchain = 'b'.repeat(64);
const manifest = 'c'.repeat(64);
const indexHtml = Buffer.from('<!doctype html>\n<html><body><div id="app"></div></body></html>\n');
const indexHtmlSha256 = sha256(indexHtml);
const expected = { siteIdentitySha256: site, toolchainId: toolchain, toolchainManifestSha256: manifest };
const observation = () => ({
  siteIdentitySha256: site,
  identity: { schemaVersion: 1, sourceCommit: 'd'.repeat(40), indexHtmlSha256,
    toolchain: { id: toolchain, manifestSha256: manifest } },
  index: { id: toolchain, manifestSha256: manifest },
  toolchainManifestSha256: manifest,
  toolchainManifest: { id: toolchain },
  fileFailures: [],
  entrypointFailures: [],
});

test('accepts the exact browser-observed site and toolchain', () => {
  assert.equal(validateObservedSiteIdentity(observation(), expected).siteIdentitySha256, site);
});

test('rejects a switched toolchain after deployment polling', () => {
  const observed = observation();
  observed.index.id = 'e'.repeat(64);
  assert.throws(() => validateObservedSiteIdentity(observed, expected), /toolchain differs/);
});

test('rejects an older frontend with the same toolchain', () => {
  const observed = observation();
  observed.siteIdentitySha256 = 'f'.repeat(64);
  assert.throws(() => validateObservedSiteIdentity(observed, expected), /site identity differs/);
});

test('rejects a frontend file that differs from the built inventory', () => {
  const observed = observation();
  observed.fileFailures.push({ path: 'assets/index.js' });
  assert.throws(() => validateObservedSiteIdentity(observed, expected), /frontend files differ/);
});

const unavailable = (path, status) => ({ path, error: `Error: Site identity resource unavailable: ${path} (${status})` });
const noWait = { sleep: async () => {} };

test('observes the site again while the host answers a file with a server error', async () => {
  const observations = [{ ...observation(), fileFailures: [unavailable('example-http.json', 503)] }, observation()];
  let calls = 0;
  const observed = await observeUntilServed(async () => observations[calls++], noWait);
  assert.equal(calls, 2);
  assert.equal(validateObservedSiteIdentity(observed, expected).siteIdentitySha256, site);
});

test('reports a missing or changed file without observing again', async () => {
  let calls = 0;
  const observed = await observeUntilServed(async () => {
    calls++;
    return { ...observation(), fileFailures: [unavailable('example-http.json', 503), unavailable('assets/index.js', 404)] };
  }, noWait);
  assert.equal(calls, 1);
  assert.throws(() => validateObservedSiteIdentity(observed, expected), /assets\/index.js/);
});

test('keeps the server error after the last attempt', async () => {
  let calls = 0;
  const observed = await observeUntilServed(async () => {
    calls++;
    return { ...observation(), fileFailures: [unavailable('example-http.json', 503)] };
  }, { ...noWait, attempts: 3 });
  assert.equal(calls, 3);
  assert.throws(() => validateObservedSiteIdentity(observed, expected), /example-http.json/);
});

test('observes again when the identity file itself answers a server error', async () => {
  let calls = 0;
  const observed = await observeUntilServed(async () => {
    if (calls++ === 0) throw Error('page.evaluate: Error: Site identity resource unavailable: site-identity.json (502)\n    at read');
    return observation();
  }, noWait);
  assert.equal(calls, 2);
  assert.equal(observed.siteIdentitySha256, site);
});

test('rethrows a missing identity file at once', async () => {
  let calls = 0;
  await assert.rejects(observeUntilServed(async () => {
    calls++;
    throw Error('page.evaluate: Error: Site identity resource unavailable: site-identity.json (404)');
  }, noWait), /\(404\)/);
  assert.equal(calls, 1);
});
