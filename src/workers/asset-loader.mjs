// Trusted tool assets only. Guest bytes never become asset paths or URLs.
export const assetRoot = new URL('../', import.meta.url);
export const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
export const errorText = error => String(error?.stack ?? error).slice(0, 4096);
function pathName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.@/-]+$/.test(name) || name.startsWith('/') ||
      name.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Invalid tool asset path');
  return name;
}
async function boundedBytes(response, maximum, onProgress = () => {}) {
  if (!response.ok) throw Error(`Tool asset HTTP ${response.status}`);
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw Error('Tool asset byte limit exceeded');
      chunks.push(value);
      onProgress(length);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
export function createAssetLoader(report = () => {}) {
  let manifestPromise, fetchAdapterInstalled = false;
  const originalFetch = globalThis.fetch.bind(globalThis);
  const cache = new Map(), bundleCache = new Map(), reportedBundles = new Set();
  const manifestDocument = () => manifestPromise ??= (async () => {
    const response = await originalFetch(new URL('asset-manifest.json', assetRoot), { cache: 'force-cache' });
    const parsed = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 1048576)));
    if (parsed.schemaVersion !== 2 || !parsed.assets || typeof parsed.assets !== 'object' || Array.isArray(parsed.assets) ||
        !parsed.bundles || typeof parsed.bundles !== 'object' || Array.isArray(parsed.bundles)) throw Error('Invalid tool asset manifest');
    return parsed;
  })().catch(error => { manifestPromise = undefined; throw error; });
  const manifest = async () => (await manifestDocument()).assets;
  async function bundle(name) {
    pathName(name);
    if (!bundleCache.has(name)) bundleCache.set(name, (async () => {
      const receipt = (await manifestDocument()).bundles[name];
      if (!receipt || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0 || receipt.bytes > 134217728 ||
          !Number.isSafeInteger(receipt.rawBytes) || receipt.rawBytes !== receipt.bytes ||
          !Number.isSafeInteger(receipt.assets) || receipt.assets < 1 || !/^[a-f0-9]{64}$/.test(receipt.sha256))
        throw Error(`Invalid tool bundle receipt: ${name}`);
      const response = await originalFetch(new URL(name, assetRoot), { cache: 'force-cache' });
      let reported = 0;
      const bytes = await boundedBytes(response, receipt.bytes, loadedBytes => {
        if (loadedBytes !== receipt.bytes && loadedBytes - reported < 524288) return;
        reported = loadedBytes;
        report({ name, loadedBytes, totalBytes: receipt.bytes });
      });
      if (bytes.byteLength !== receipt.bytes || await digest(bytes) !== receipt.sha256) throw Error(`Tool bundle integrity failed: ${name}`);
      if (!reportedBundles.has(name)) {
        reportedBundles.add(name);
        const timing = performance.getEntriesByName(response.url).at(-1);
        report({ name, rawBytes: receipt.rawBytes,
          transferBytes: timing?.encodedBodySize > 0 ? timing.encodedBodySize : bytes.byteLength });
      }
      return bytes;
    })().catch(error => { bundleCache.delete(name); throw error; }));
    return bundleCache.get(name);
  }
  async function load(name) {
    pathName(name);
    const entry = (await manifest())[name];
    if (!entry || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 134217728 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error(`Invalid tool asset receipt: ${name}`);
    if (entry.bundle !== undefined) {
      if (typeof entry.bundle !== 'string' || !Number.isSafeInteger(entry.offset) || entry.offset < 0) throw Error(`Invalid tool asset range: ${name}`);
      const payload = await bundle(entry.bundle);
      if (entry.offset + entry.bytes > payload.byteLength) throw Error(`Tool asset range failed: ${name}`);
      const bytes = payload.slice(entry.offset, entry.offset + entry.bytes);
      if (await digest(bytes) !== entry.sha256) throw Error(`Tool asset integrity failed: ${name}`);
      return bytes;
    }
    if (!cache.has(name)) cache.set(name, (async () => {
      const response = await originalFetch(new URL(name, assetRoot), { cache: 'force-cache' });
      const bytes = await boundedBytes(response, entry.bytes);
      if (bytes.byteLength !== entry.bytes || await digest(bytes) !== entry.sha256) throw Error(`Tool asset integrity failed: ${name}`);
      const timing = performance.getEntriesByName(response.url).at(-1);
      report({ name, rawBytes: bytes.byteLength,
        transferBytes: timing?.encodedBodySize > 0 ? timing.encodedBodySize : bytes.byteLength });
      return bytes;
    })().catch(error => { cache.delete(name); throw error; }));
    return (await cache.get(name)).slice();
  }
  async function verifyGraph(prefix) {
    const names = Object.keys(await manifest()).filter(name => name.startsWith(prefix) && /\.(?:mjs|js)$/.test(name));
    if (!names.length) throw Error(`Missing trusted JavaScript graph: ${prefix}`);
    const results = await Promise.allSettled(names.map(name => load(name, { javascript: true })));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  function installFetchAdapter() {
    if (fetchAdapterInstalled) return;
    fetchAdapterInstalled = true;
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), globalThis.location.href);
      if (url.origin === assetRoot.origin && url.pathname.startsWith(assetRoot.pathname) && !url.search &&
          (!init?.method || init.method === 'GET') && (!(input instanceof Request) || input.method === 'GET')) {
        const name = decodeURIComponent(url.pathname.slice(assetRoot.pathname.length));
        if (name && !name.startsWith('bundles/') && name !== 'asset-manifest.json') {
          const entry = (await manifest())[name];
          if (entry?.bundle) {
            const bytes = await load(name);
            return new Response(bytes, { headers: { 'Content-Type': name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' } });
          }
        }
      }
      return originalFetch(input, init);
    };
  }
  return { load, manifest, verifyGraph, installFetchAdapter, url: name => new URL(pathName(name), assetRoot).href };
}
export function ownedFiles(files = {}, maximum = 268435456) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw Error('Tool files must be a byte map');
  let total = 0;
  return Object.fromEntries(Object.entries(files).map(([name, bytes]) => {
    if (!(bytes instanceof Uint8Array)) throw Error('Tool inputs must be Uint8Array');
    total += bytes.byteLength;
    if (total > maximum) throw Error('Tool input byte limit exceeded');
    return [name, bytes.slice()];
  }));
}
export function serveWorker(handler) {
  let busy = false;
  self.onmessage = async ({ data }) => {
    const id = data?.id;
    if (busy) { self.postMessage({ id, error: 'Worker is busy' }); return; }
    busy = true;
    const report = payload => self.postMessage({ id, ...payload });
    try {
      const result = await handler(data, report);
      const transfers = new Set();
      const visit = value => {
        if (value instanceof Uint8Array) { transfers.add(value.buffer); return; }
        if (value && typeof value === 'object') for (const item of Object.values(value)) visit(item);
      };
      visit(result);
      self.postMessage({ id, result }, [...transfers]);
    } catch (error) { report({ error: errorText(error) }); }
    finally { busy = false; }
  };
}
export function toBase64(bytes) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) text += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(text);
}
export const fromBase64 = text => Uint8Array.from(atob(text), character => character.charCodeAt(0));
