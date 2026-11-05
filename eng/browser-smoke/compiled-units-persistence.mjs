import { clearCompilationCache, setOptimizations } from './playground-ui.mjs';
import { browserName, browserType } from './engine.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const output = process.env.PLAYGROUND_EVIDENCE;
if (!output) throw Error('PLAYGROUND_EVIDENCE is required');
mkdirSync(output, { recursive: true });

// A compilation keeps each method's compiled code in IndexedDB; after a reload the new compiler
// worker restores it. Unchanged source reuses the whole kept compilation, and an edit to a
// method body patches the last compile with that method alone.
const browser = await browserType.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    globalThis.compiledUnits = [];
    globalThis.Worker = class ObservedWorker extends NativeWorker {
      constructor(specifier, options) {
        super(specifier, options);
        this.addEventListener('message', ({ data }) => {
          if (data?.result?.compiledUnitsCache)
            globalThis.compiledUnits.push({ ...data.result.compiledUnitsCache, summary: data.result.compiledUnits,
              netwasmMilliseconds: data.result.timings?.find(timing => timing.stage === 'netwasm')?.milliseconds });
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
    const units = await page.evaluate(() => globalThis.compiledUnits.at(-1));
    if (stages['cache-lookup'] !== 'complete' || stages['cache-hydrate'] !== 'complete' ||
        stages['cache-write'] !== 'complete' || typeof units?.summary !== 'string')
      throw Error(`Compiled unit evidence is missing: ${JSON.stringify({ stages, units })}`);
    return { stages, units };
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
      const units = rows.filter(row => row.partition?.split('/')[1] === 'compiled-units');
      return {
        entries: units.length,
        totalBytes: units.reduce((total, row) => total + (row.payload?.byteLength ?? 0), 0),
        partitions: [...new Set(units.map(row => row.partition))],
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
  if (!cold.units.summary.startsWith('restored 0 ') || cold.units.restoredBytes !== 0 ||
      !(cold.units.storedBytes > 0) ||
      afterCold.entries !== 1 || afterCold.totalBytes !== cold.units.storedBytes)
    throw Error(`Cold compilation did not persist its compiled units: ${JSON.stringify({ cold, afterCold })}`);

  await page.reload();
  const warm = await compile();
  const afterReload = await storage();
  if (warm.units.restoredBytes !== cold.units.storedBytes ||
      !warm.units.summary.includes('early cutoff: nothing changed') || afterReload.entries !== 1 ||
      JSON.stringify(afterReload.partitions) !== JSON.stringify(afterCold.partitions))
    throw Error(`Reload did not restore the persisted compiled units: ${JSON.stringify({
      cold, warm, afterCold, afterReload,
    })}`);

  // After an edit, the next compiler worker restores the units again and patches the last
  // compile with the edited method.
  await page.locator('.monaco-editor').click();
  await page.keyboard.press(browserName === 'webkit' ? 'Meta+A' : 'ControlOrMeta+A');
  // One line: Firefox inserts multi-line text into Monaco twice.
  await page.keyboard.insertText('using System; Console.WriteLine(42); Console.WriteLine(43);');
  await page.waitForFunction(() => document.querySelectorAll('#editor .view-line').length === 1 &&
    document.querySelector('#editor .view-lines')?.textContent?.includes('WriteLine(43)'));
  const edited = await compile();
  const patched = Number(/early cutoff: patched (\d+) /.exec(edited.units.summary)?.[1]);
  if (!(edited.units.restoredBytes > 0) || !(patched > 0))
    throw Error(`An edit did not reuse the persisted compiled units: ${JSON.stringify({ cold, warm, edited })}`);
  if (errors.length) throw Error(`Page errors: ${JSON.stringify(errors)}`);

  const result = { passed: true, cold, warm, edited, afterCold, afterReload, errors };
  writeFileSync(`${output}/results.json`, JSON.stringify(result, null, 2));
  console.log(`PASS: persisted ${afterCold.totalBytes} bytes of compiled units; after reload an edit patched ${patched} functions of the last compile`);
} finally {
  await browser.close();
}
