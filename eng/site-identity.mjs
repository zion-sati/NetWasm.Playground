import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, lstatSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const hashPattern = /^[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function observedIndexHtml(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  const matches = [...text.matchAll(/<script\b[^>]*><\/script>\r?\n?/g)]
    .filter(match => match[0].includes('https://static.cloudflareinsights.com/beacon.min.js/'));
  if (matches.length > 1) throw Error('Browser navigation contains multiple Cloudflare analytics injections');
  if (matches.length) {
    const match = matches[0];
    const tag = match[0].replace(/\r?\n$/, '');
    const opening = tag.slice('<script'.length, tag.indexOf('>'));
    const attributes = [...opening.matchAll(/\s+([A-Za-z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g)];
    const values = Object.fromEntries(attributes.map(attribute => [attribute[1], attribute[2].slice(1, -1)]));
    let beacon;
    try { beacon = JSON.parse(values['data-cf-beacon']); } catch { beacon = null; }
    if (attributes.map(attribute => attribute[0]).join('') !== opening ||
        attributes.length !== Object.keys(values).length ||
        Object.keys(values).sort().join(',') !== 'crossorigin,data-cf-beacon,integrity,src,type' ||
        values.type !== 'module' || values.crossorigin !== 'anonymous' ||
        !/^https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[A-Za-z0-9]+$/.test(values.src) ||
        !/^sha512-[A-Za-z0-9+/=]+$/.test(values.integrity) ||
        !beacon || Array.isArray(beacon) || typeof beacon !== 'object' ||
        typeof beacon.version !== 'string' || typeof beacon.token !== 'string' ||
        !text.slice(match.index + match[0].length).startsWith('</body>'))
      throw Error('Cloudflare analytics injection is malformed');
  }
  const normalized = matches.length ? text.replace(matches[0][0], '') : text;
  return { sha256: sha256(Buffer.from(normalized)), edgeTransform: matches.length ? 'cloudflare-web-analytics' : null };
}

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
  if (observed.indexHtmlSha256 !== observed.identity.indexHtmlSha256)
    throw Error('Browser navigation HTML differs from the built site');
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, sourceCommit] = process.argv.slice(2);
  if (!root || !sourceCommit) throw Error('Usage: node eng/site-identity.mjs <site-root> <source-commit>');
  const result = createSiteIdentity(root, sourceCommit);
  console.log(JSON.stringify({ sha256: result.sha256, sourceCommit,
    toolchain: result.identity.toolchain, fileCount: Object.keys(result.identity.files).length }));
}
