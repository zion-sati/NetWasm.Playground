import { clearCompilationCache, setOptimizations } from './playground-ui.mjs';
import { browserType } from './engine.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const output = process.env.PLAYGROUND_EVIDENCE;
if (!output) throw Error('PLAYGROUND_EVIDENCE is required');
mkdirSync(output, { recursive: true });

const browser = await browserType.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    globalThis.frontendCacheMetrics = [];
    globalThis.Worker = class ObservedWorker extends NativeWorker {
      constructor(specifier, options) {
        super(specifier, options);
        this.addEventListener('message', ({ data }) => {
          if (data?.result?.frontendCacheMetrics)
            globalThis.frontendCacheMetrics.push(structuredClone(data.result.frontendCacheMetrics));
        });
      }
    };
  });

  const url = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/';
  const compile = async () => {
    await page.locator('.monaco-editor').waitFor();
    await setOptimizations(page, 'none');
    await page.locator('#compile').click();
    await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined,
      { timeout: 240_000 });
    const status = await page.locator('#status').textContent();
    if (status !== 'Compilation complete') throw Error(`Compilation failed: ${status}`);
    const stages = await page.locator('#stages li').evaluateAll(items => Object.fromEntries(
      items.filter(item => ['cache-lookup', 'cache-hydrate', 'cache-write'].includes(item.dataset.stage))
        .map(item => [item.dataset.stage, item.dataset.state])));
    const metrics = await page.evaluate(() => globalThis.frontendCacheMetrics.at(-1));
    if (stages['cache-lookup'] !== 'complete' || stages['cache-hydrate'] !== 'complete' || !metrics)
      throw Error(`Compiler cache evidence is missing: ${JSON.stringify({ stages, metrics })}`);
    return { stages, metrics };
  };
  const storage = () => page.evaluate(async () => {
    const request = indexedDB.open('netwasm-playground-frontend-cache');
    const database = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains('artifacts'))
        return { entries: 0, totalBytes: 0 };
      const transaction = database.transaction('artifacts', 'readonly');
      const rows = await new Promise((resolve, reject) => {
        const result = [];
        const cursor = transaction.objectStore('artifacts').openCursor();
        cursor.onsuccess = () => {
          if (!cursor.result) { resolve(result); return; }
          result.push(cursor.result.value);
          cursor.result.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      });
      return {
        entries: rows.length,
        totalBytes: rows.reduce((total, row) => total + (row.payload?.byteLength ?? 0), 0),
        partitions: [...new Set(rows.map(row => row.partition))],
      };
    } finally {
      database.close();
    }
  });

  await page.goto(url);
  await page.locator('.monaco-editor').waitFor();
  await clearCompilationCache(page);
  const cold = await compile();
  const afterCold = await storage();
  if (afterCold.entries < 1 || afterCold.totalBytes < 1)
    throw Error(`Cold compilation did not persist compiler artifacts: ${JSON.stringify(afterCold)}`);

  await page.reload();
  const warm = await compile();
  const afterReload = await storage();
  if (!(warm.metrics.loadedEntries > 0) || !(warm.metrics.readBytes > 0) ||
      afterReload.entries !== afterCold.entries ||
      afterReload.totalBytes !== afterCold.totalBytes ||
      JSON.stringify(afterReload.partitions) !== JSON.stringify(afterCold.partitions))
    throw Error(`Reload did not reuse the persisted compiler cache: ${JSON.stringify({
      cold, warm, afterCold, afterReload,
    })}`);
  if (errors.length) throw Error(`Page errors: ${JSON.stringify(errors)}`);

  const result = { passed: true, cold, warm, afterCold, afterReload, errors };
  writeFileSync(`${output}/results.json`, JSON.stringify(result, null, 2));
  console.log(`PASS: persisted ${afterReload.entries} compiler artifacts and reused ${warm.metrics.loadedEntries} after reload`);
} finally {
  await browser.close();
}
