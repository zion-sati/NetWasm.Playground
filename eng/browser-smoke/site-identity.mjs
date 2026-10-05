import { expectedSiteIdentity, validateObservedSiteIdentity } from '../site-identity.mjs';

export async function observeSiteIdentity(page, url, expected = expectedSiteIdentity()) {
  const observed = await page.evaluate(async baseUrl => {
    const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    const read = async path => {
      const response = await fetch(new URL(path, baseUrl), { cache: 'no-store' });
      if (!response.ok) throw Error(`Site identity resource unavailable: ${path} (${response.status})`);
      return response.arrayBuffer();
    };
    const identityBytes = await read('site-identity.json');
    const identity = JSON.parse(new TextDecoder().decode(identityBytes));
    const fileFailures = [];
    if (!identity.files || Array.isArray(identity.files)) fileFailures.push({ path: '*', reason: 'invalid inventory' });
    else {
      for (const [path, receipt] of Object.entries(identity.files)) {
        try {
          const bytes = await read(path);
          const actual = { bytes: bytes.byteLength, sha256: await digest(bytes) };
          if (actual.bytes !== receipt?.bytes || actual.sha256 !== receipt?.sha256)
            fileFailures.push({ path, expected: receipt, actual });
        } catch (error) {
          fileFailures.push({ path, error: String(error) });
        }
      }
    }
    const indexBytes = await read('toolchain/index.json');
    const index = JSON.parse(new TextDecoder().decode(indexBytes));
    const manifestBytes = await read(`toolchain/${index.id}/asset-manifest.json`);
    const actualEntrypoints = [...document.querySelectorAll('script[src],link[href]')]
      .map(element => new URL(element.src || element.href).pathname)
      .filter(path => path.includes('/assets/'))
      .map(path => path.slice(path.indexOf('/assets/') + 1)).sort();
    const expectedEntrypoints = Array.isArray(identity.entrypoints) ? [...identity.entrypoints].sort() : [];
    const entrypointFailures = JSON.stringify(actualEntrypoints) === JSON.stringify(expectedEntrypoints)
      ? [] : [{ expected: expectedEntrypoints, actual: actualEntrypoints }];
    return {
      siteIdentitySha256: await digest(identityBytes),
      identity,
      index,
      toolchainManifestSha256: await digest(manifestBytes),
      toolchainManifest: JSON.parse(new TextDecoder().decode(manifestBytes)),
      fileFailures,
      entrypointFailures,
    };
  }, new URL('./', url).href);
  return validateObservedSiteIdentity(observed, expected);
}
