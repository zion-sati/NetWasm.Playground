import assert from 'node:assert/strict';
import test from 'node:test';
import { validateObservedSiteIdentity } from '../site-identity.mjs';

const site = 'a'.repeat(64);
const toolchain = 'b'.repeat(64);
const manifest = 'c'.repeat(64);
const expected = { siteIdentitySha256: site, toolchainId: toolchain, toolchainManifestSha256: manifest };
const observation = () => ({
  siteIdentitySha256: site,
  identity: { schemaVersion: 1, sourceCommit: 'd'.repeat(40), indexHtmlSha256: 'e'.repeat(64),
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
