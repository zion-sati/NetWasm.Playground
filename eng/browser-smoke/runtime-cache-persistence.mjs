import { clearCompilationCache, setOptimizations } from './playground-ui.mjs';
import { browserType } from './engine.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const output = process.env.PLAYGROUND_EVIDENCE;
if (!output) throw Error('PLAYGROUND_EVIDENCE is required');
mkdirSync(output, { recursive: true });
const optimization = process.env.PLAYGROUND_OPTIMIZATION ?? 'none';

const browser = await browserType.launch({ headless: true });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/');
  await page.locator('.monaco-editor').waitFor();
  await clearCompilationCache(page);

  await setOptimizations(page, optimization);
  const compile = async value => {
    await page.locator('#editor .view-lines').click({ position: { x: 80, y: 12 } });
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText(`using System; Console.WriteLine(${value});`);
    await page.locator('#compile').click();
    await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined,
      { timeout: 240_000 });
    const status = await page.locator('#status').textContent();
    const stages = await page.locator('#stages li').evaluateAll(items => items.map(item => ({
      stage: item.dataset.stage,
      state: item.dataset.state,
    })));
    return {
      success: status === 'Compilation complete',
      status,
      stages,
      componentSize: await page.locator('#size').textContent(),
      timings: await page.locator('#timings').textContent(),
    };
  };
  const runtimeStorage = () => page.evaluate(async () => {
    const request = indexedDB.open('netwasm-playground-frontend-cache');
    const database = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = database.transaction('artifacts', 'readonly');
      const rows = await new Promise((resolve, reject) => {
        const values = [];
        const cursor = transaction.objectStore('artifacts').openCursor();
        cursor.onsuccess = () => {
          if (!cursor.result) { resolve(values); return; }
          if (cursor.result.value?.slot) values.push(cursor.result.value);
          cursor.result.continue();
        };
        cursor.onerror = () => reject(cursor.error);
      });
      return rows.map(row => ({
        id: row.id,
        key: row.key,
        slot: row.slot,
        bytes: row.payload?.byteLength ?? 0,
      }));
    } finally {
      database.close();
    }
  });
  const cold = await compile(42);
  const download = page.waitForEvent('download');
  await page.locator('#download').click();
  const componentPath = `${output}/cold.wasm`;
  await (await download).saveAs(componentPath);
  const component = readFileSync(componentPath);
  const afterCold = await runtimeStorage();
  await page.reload();
  await page.locator('.monaco-editor').waitFor();
  await setOptimizations(page, optimization);
  const warm = await compile(43);
  const afterWarm = await runtimeStorage();
  const results = {
    cold,
    warm,
    afterCold,
    afterWarm,
    component: {
      bytes: component.byteLength,
      sha256: createHash('sha256').update(component).digest('hex'),
    },
  };

  if (!results.cold.success || !results.warm.success)
    throw Error(`Compilation failed: ${JSON.stringify(results)}`);
  const coldStages = new Set(results.cold.stages.map(stage => stage.stage));
  if (!coldStages.has('runtime-cache-write') || results.afterCold.length !== 1 ||
      !(results.afterCold[0].bytes > 0))
    throw Error(`Cold compilation did not populate the runtime cache: ${JSON.stringify(results.cold)}`);
  if (JSON.stringify(results.afterWarm) !== JSON.stringify(results.afterCold))
    throw Error(`Warm compilation did not reuse the runtime cache: ${JSON.stringify(results.warm)}`);
  const warmStages = new Set(results.warm.stages.map(stage => stage.stage));
  for (const stage of ['link', 'runtime-optimize', 'runtime-validate', 'runtime-cache-write']) {
    if (warmStages.has(stage))
      throw Error(`Warm compilation unexpectedly ran ${stage}: ${JSON.stringify(results.warm)}`);
  }
  if (!warmStages.has('merge') || !warmStages.has('prune'))
    throw Error(`Warm compilation skipped edited application work: ${JSON.stringify(results.warm)}`);
  if (errors.length) throw Error(`Page errors: ${JSON.stringify(errors)}`);

  const evidence = { passed: true, results, errors };
  writeFileSync(`${output}/results.json`, JSON.stringify(evidence, null, 2));
  console.log(`PASS: ${optimization} cold runtime cache miss became a warm hit; reused ${results.afterWarm[0].bytes} bytes`);
} finally {
  await browser.close();
}
