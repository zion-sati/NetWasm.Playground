import assert from 'node:assert/strict';
import test from 'node:test';
import { observedIndexHtml, sha256, validateObservedSiteIdentity } from '../site-identity.mjs';

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
  indexHtmlSha256,
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

test('rejects stale navigation HTML with unchanged entrypoints and toolchain', () => {
  const observed = observation();
  observed.indexHtmlSha256 = sha256(Buffer.from('<!doctype html><html><body>stale</body></html>'));
  assert.throws(() => validateObservedSiteIdentity(observed, expected), /navigation HTML differs/);
});

test('accepts the exact Cloudflare analytics injection without changing site identity', () => {
  const injection = '<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/v31edd6df95cf4e85bb4c19e7a9bdbcba1788362987495" integrity="sha512-iIg7k2xntmwu6/uSb5tpc/hySgZc4eoL31yB29W6tJFo2akwjPWcEqnCEdJvGexCL0KEQwVYv5BlowfhVz26hg==" data-cf-beacon=\'{"version":"2024.11.0","token":"public"}\' crossorigin="anonymous"></script>\n';
  const transformed = Buffer.from(indexHtml.toString().replace('</body>', `${injection}</body>`));
  assert.deepEqual(observedIndexHtml(transformed), { sha256: indexHtmlSha256, edgeTransform: 'cloudflare-web-analytics' });
});

test('rejects an altered Cloudflare analytics injection', () => {
  const injection = '<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/v31edd6df95cf4e85bb4c19e7a9bdbcba1788362987495" integrity="sha512-aA==" data-cf-beacon=\'{"version":"2024.11.0","token":"public"}\' crossorigin="anonymous" onload="alert(1)"></script>\n';
  const transformed = Buffer.from(indexHtml.toString().replace('</body>', `${injection}</body>`));
  assert.throws(() => observedIndexHtml(transformed), /analytics injection is malformed/);
});

test('rejects a displaced Cloudflare analytics injection', () => {
  const injection = '<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/v31edd6df95cf4e85bb4c19e7a9bdbcba1788362987495" integrity="sha512-aA==" data-cf-beacon=\'{"version":"2024.11.0","token":"public"}\' crossorigin="anonymous"></script>\n';
  const transformed = Buffer.from(indexHtml.toString().replace('<div id="app">', `${injection}<div id="app">`));
  assert.throws(() => observedIndexHtml(transformed), /analytics injection is malformed/);
});

test('rejects a frontend file that differs from the built inventory', () => {
  const observed = observation();
  observed.fileFailures.push({ path: 'assets/index.js' });
  assert.throws(() => validateObservedSiteIdentity(observed, expected), /frontend files differ/);
});
