import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, lstatSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const hashPattern = /^[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const publicPath = (root, path) => relative(root, path).split(sep).join('/');

function frontendFiles(root) {
  const files = {};
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      const name = publicPath(root, path);
      if (name === 'index.html' || name === 'site-identity.json' || name === 'toolchain' || name.startsWith('toolchain/')) continue;
      if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) throw Error(`Site output contains a symbolic link: ${name}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const bytes = readFileSync(path);
        files[name] = { bytes: bytes.length, sha256: sha256(bytes) };
      } else throw Error(`Site output contains an unsupported entry: ${name}`);
    }
  };
  visit(root);
  return files;
}

export function createSiteIdentity(rootPath, sourceCommit) {
  if (!commitPattern.test(sourceCommit)) throw Error('Site source commit is invalid');
  const root = resolve(rootPath);
  const indexBytes = readFileSync(resolve(root, 'toolchain/index.json'));
  const index = JSON.parse(indexBytes);
  if (Object.keys(index).sort().join(',') !== 'id,manifestSha256' ||
      !hashPattern.test(index.id) || !hashPattern.test(index.manifestSha256))
    throw Error('Toolchain index identity is invalid');
  const manifestBytes = readFileSync(resolve(root, `toolchain/${index.id}/asset-manifest.json`));
  if (sha256(manifestBytes) !== index.manifestSha256) throw Error('Toolchain manifest digest does not match its index');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.id !== index.id) throw Error('Toolchain manifest identity does not match its index');
  const indexHtml = readFileSync(resolve(root, 'index.html'));
  const entrypoints = [...indexHtml.toString().matchAll(/(?:src|href)="([^"]*assets\/[^"?]+)"/g)]
    .map(match => match[1].slice(match[1].indexOf('assets/'))).sort();
  if (!entrypoints.length || new Set(entrypoints).size !== entrypoints.length)
    throw Error('Site index entrypoints are missing or duplicated');
  const identity = {
    schemaVersion: 1,
    sourceCommit,
    toolchain: { id: index.id, manifestSha256: index.manifestSha256 },
    indexHtmlSha256: sha256(indexHtml),
    entrypoints,
    files: frontendFiles(root),
  };
  const bytes = Buffer.from(`${JSON.stringify(identity, null, 2)}\n`);
  writeFileSync(resolve(root, 'site-identity.json'), bytes);
  return { identity, sha256: sha256(bytes) };
}

export function expectedSiteIdentity(environment = process.env) {
  const expected = {
    siteIdentitySha256: environment.EXPECTED_SITE_IDENTITY_SHA256,
    toolchainId: environment.EXPECTED_TOOLCHAIN_ID,
    toolchainManifestSha256: environment.EXPECTED_TOOLCHAIN_MANIFEST_SHA256,
  };
  if (Object.values(expected).some(value => typeof value !== 'string' || !hashPattern.test(value)))
    throw Error('Expected site and toolchain identities are required');
  return expected;
}

export function validateObservedSiteIdentity(observed, expected) {
  if (!observed || typeof observed !== 'object' || !observed.identity || !observed.index ||
      observed.siteIdentitySha256 !== expected.siteIdentitySha256)
    throw Error('Browser-observed site identity differs from the built site');
  if (observed.identity.schemaVersion !== 1 || !commitPattern.test(observed.identity.sourceCommit ?? '') ||
      !hashPattern.test(observed.identity.indexHtmlSha256 ?? '') ||
      observed.identity.toolchain?.id !== expected.toolchainId ||
      observed.identity.toolchain?.manifestSha256 !== expected.toolchainManifestSha256)
    throw Error('Browser-observed site identity has unexpected coordinates');
  if (observed.index.id !== expected.toolchainId ||
      observed.index.manifestSha256 !== expected.toolchainManifestSha256 ||
      observed.toolchainManifestSha256 !== expected.toolchainManifestSha256 ||
      observed.toolchainManifest?.id !== expected.toolchainId)
    throw Error('Browser-observed toolchain differs from the built toolchain');
  if (!Array.isArray(observed.fileFailures) || observed.fileFailures.length ||
      !Array.isArray(observed.entrypointFailures) || observed.entrypointFailures.length)
    throw Error(`Browser-observed frontend files differ from the built site: ${JSON.stringify({
      files: observed.fileFailures, entrypoints: observed.entrypointFailures,
    })}`);
  return observed;
}

// A 5xx is the host failing to serve a file it has (GitHub Pages answers 503 for a moment
// after a deploy), not a different file, so the observation is taken again. A missing or
// changed file fails at once.
const unavailableStatus = text => Number(/resource unavailable: \S+ \((\d{3})\)/.exec(String(text))?.[1]);
const serverError = status => status >= 500 && status <= 599;

export async function observeUntilServed(observe, {
  attempts = 4, delayMs = 2000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  for (let attempt = 1; ; attempt++) {
    let observed;
    let failure;
    try {
      observed = await observe();
    } catch (error) {
      failure = error;
    }
    const statuses = failure ? [unavailableStatus(failure.message ?? failure)]
      : (observed?.fileFailures ?? []).map(fileFailure => unavailableStatus(fileFailure.error));
    if (attempt >= attempts || !statuses.length || !statuses.every(serverError)) {
      if (failure) throw failure;
      return observed;
    }
    await sleep(delayMs * attempt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, sourceCommit] = process.argv.slice(2);
  if (!root || !sourceCommit) throw Error('Usage: node eng/site-identity.mjs <site-root> <source-commit>');
  const result = createSiteIdentity(root, sourceCommit);
  console.log(JSON.stringify({ sha256: result.sha256, sourceCommit,
    toolchain: result.identity.toolchain, fileCount: Object.keys(result.identity.files).length }));
}
