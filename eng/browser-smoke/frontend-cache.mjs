import { chromium } from 'playwright';

const base = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:5174/playground/';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const databaseName = 'netwasm-playground-frontend-cache';
    const removeDatabase = () => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('database deletion blocked'));
    });
    await removeDatabase();
    const { createFrontendCache, clearFrontendCache } =
      await import('/src/workers/frontend-cache.mjs');
    const toolchain = 'a'.repeat(64), namespace = 'b'.repeat(64);
    const descriptor = { schema: 'frontend-artifact-cache-v4', namespace };
    const entry = (character, values, checksum = 7) => ({
      key: character.repeat(64),
      payload: new Uint8Array(values),
      checksum: new Uint8Array(32).fill(checksum),
    });
    const first = entry('c', [1, 2, 3, 4]);
    const cache = createFrontendCache(toolchain);
    if (!await cache.write(descriptor, [first])) throw Error('initial write failed');
    const conflicting = entry('c', [9, 9, 9, 9], 8);
    if (await cache.write(descriptor, [conflicting])) throw Error('conflict was overwritten');
    let loaded = await cache.load(descriptor);
    if (loaded.entries.length !== 1 || loaded.entries[0].payload.join(',') !== '1,2,3,4')
      throw Error('conflict did not preserve immutable entry');

    const secondCache = createFrontendCache(toolchain);
    const second = entry('d', [5]), third = entry('e', [6]);
    if (!(await Promise.all([
      cache.write(descriptor, [second]),
      secondCache.write(descriptor, [third]),
    ])).every(Boolean)) throw Error('concurrent merge failed');
    const upgradedToolchain = createFrontendCache('9'.repeat(64));
    if (!await upgradedToolchain.write(descriptor, [conflicting]))
      throw Error('new toolchain partition write failed');
    const isolated = await upgradedToolchain.load(descriptor);
    if (isolated.entries.length !== 1 ||
        isolated.entries[0].payload.join(',') !== '9,9,9,9')
      throw Error('new toolchain partition was not isolated');
    upgradedToolchain.close();
    cache.close();
    secondCache.close();
    const reopened = createFrontendCache(toolchain);
    loaded = await reopened.load(descriptor);
    if (!loaded.available || loaded.entries.length !== 3 || loaded.totalBytes !== 6)
      throw Error('reload/merge failed');

    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction('artifacts', 'readwrite');
    transaction.objectStore('artifacts').put({
      id: 'invalid',
      partition: `${toolchain}/frontend-artifact-cache-v4/${namespace}`,
      key: 'not-a-hash',
      payload: new Uint8Array([9]).buffer,
      checksum: new Uint8Array(1).buffer,
    });
    await new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
    loaded = await reopened.load(descriptor);
    if (loaded.entries.length !== 3) throw Error('corruption fallback failed');
    reopened.close();

    const pressure = createFrontendCache(toolchain, {
      maximumEntries: 2,
      maximumBytes: 6,
      maximumPayloadBytes: 6,
      maximumBatchEntries: 2,
      maximumBatchBytes: 6,
    });
    const newest = entry('f', [7, 8, 9]);
    if (!await pressure.write(descriptor, [newest])) throw Error('pressure write failed');
    loaded = await pressure.load(descriptor);
    if (loaded.entries.length > 2 || loaded.totalBytes > 6 ||
        !loaded.entries.some(candidate => candidate.key === newest.key))
      throw Error('pressure policy failed');
    pressure.close();

    await clearFrontendCache();
    const cleared = createFrontendCache(toolchain);
    if ((await cleared.load(descriptor)).entries.length) throw Error('explicit clear failed');
    cleared.close();
    await clearFrontendCache();
    const blocker = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const blocked = createFrontendCache(toolchain,
      { blockedOpenTimeoutMilliseconds: 50 });
    const fallback = await blocked.load(descriptor);
    if (fallback.available || fallback.entries.length) throw Error('blocked open did not fall back');
    blocker.close();
    blocked.close();
    await new Promise(resolve => setTimeout(resolve, 100));

    const lifecycle = createFrontendCache(toolchain);
    if (!(await lifecycle.load(descriptor)).available) throw Error('recovery after blocked open failed');
    const upgraded = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('versionchange connection was not closed'));
    });
    upgraded.close();
    lifecycle.close();
    return { mergedEntries: 3, pressureBytes: loaded.totalBytes, blockedFallback: true };
  });
  await page.locator('#clear-cache').click();
  await page.locator('#status').filter({ hasText: 'Compilation cache cleared' })
    .waitFor();
  console.log(JSON.stringify({ passed: true, ...result }));
} finally {
  await browser.close();
}
