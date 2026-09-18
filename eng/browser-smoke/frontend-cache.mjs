import { chromium } from 'playwright';

const base = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:5174/playground/';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const { createFrontendCache } = await import('/src/workers/frontend-cache.mjs');
    const toolchain = 'a'.repeat(64), namespace = 'b'.repeat(64);
    const descriptor = { schema: 'netwasm-frontend-v1', namespace };
    const cache = createFrontendCache(toolchain);
    const key = 'c'.repeat(64), payload = new Uint8Array([1, 2, 3, 4]);
    const checksum = new Uint8Array(32).fill(7);
    if (!await cache.write(descriptor, [{ key, payload, checksum }])) throw Error('write failed');
    cache.close();
    const reopened = createFrontendCache(toolchain);
    const loaded = await reopened.load(descriptor);
    if (!loaded.available || loaded.entries.length !== 1 || loaded.totalBytes !== 4 ||
        loaded.entries[0].payload.join(',') !== '1,2,3,4') throw Error('reload failed');

    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('netwasm-playground-frontend-cache', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction('artifacts', 'readwrite');
    const store = transaction.objectStore('artifacts');
    store.put({ id: 'invalid', partition: `${toolchain}/netwasm-frontend-v1/${namespace}`,
      key: 'not-a-hash', payload: new Uint8Array([9]).buffer, checksum: new Uint8Array(1).buffer });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    const afterCorruption = await reopened.load(descriptor);
    reopened.close();
    if (afterCorruption.entries.length !== 1 || afterCorruption.entries[0].key !== key)
      throw Error('corruption fallback failed');
    return { entries: afterCorruption.entries.length, bytes: afterCorruption.totalBytes };
  });
  console.log(JSON.stringify({ passed: true, ...result }));
} finally {
  await browser.close();
}
