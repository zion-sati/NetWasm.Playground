import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { browserType } from './engine.mjs';
import { clearCompilationCache, openSettings, closeSettings, setOptimizations } from './playground-ui.mjs';

const output = process.env.PLAYGROUND_EVIDENCE;
if (!output) throw Error('PLAYGROUND_EVIDENCE is required');
mkdirSync(output, { recursive: true });
const collectors = (process.env.PLAYGROUND_COLLECTORS ?? 'Compact,NetWasm,Boehm,Bump,Compact').split(',');
const mode = process.env.PLAYGROUND_OPTIMIZATION ?? 'Oz';
const browser = await browserType.launch({ headless: true });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    globalThis.collectorPlans = [];
    const OriginalWorker = globalThis.Worker;
    globalThis.Worker = class extends OriginalWorker {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({ data }) => {
          const plan = data?.result?.runtimeLinkPlan;
          if (plan) globalThis.collectorPlans.push({ collector: plan.GarbageCollector,
            key: plan.Cache.key, inputs: plan.Inputs.map(input => input.Path) });
        });
      }
    };
  });
  await page.goto(process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/');
  await page.locator('.monaco-editor').waitFor();
  await clearCompilationCache(page);
  await setOptimizations(page, mode);
  await page.locator('#editor .view-lines').click({ position: { x: 80, y: 12 } });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('using System; Console.WriteLine(42);');
  const results = [];
  const keys = new Map();
  for (const collector of collectors) {
    await openSettings(page);
    await page.locator('#garbage-collector').selectOption(collector);
    if (collector === 'Bump')
      assert.match(await page.locator('#garbage-collector-help').textContent(), /never collects/);
    await closeSettings(page);
    await page.locator('#compile').click();
    await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 300_000 });
    assert.equal(await page.locator('#status').textContent(), 'Compilation complete');
    const actual = await page.evaluate(() => globalThis.collectorPlans.at(-1));
    assert.equal(actual?.collector, collector);
    if (keys.has(collector)) assert.equal(actual.key, keys.get(collector));
    else {
      assert(![...keys.values()].includes(actual.key), 'Different collectors must not share a runtime cache identity');
      keys.set(collector, actual.key);
    }
    assert(actual.inputs.some(path => path.includes('/' + collector.toLowerCase() + '/')),
      'Selected runtime archives must identify the collector');
    const download = page.waitForEvent('download');
    await page.locator('#download').click();
    const artifact = await download;
    assert.equal(artifact.suggestedFilename(), `program-${collector}-${mode}.wasm`);
    await artifact.saveAs(`${output}/${results.length}-${collector}-${mode}.wasm`);
    await page.locator('#run').click();
    await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 300_000 });
    assert.equal(await page.locator('#output').textContent(), '42\n');
    results.push({ collector, mode, ...actual, size: await page.locator('#size').textContent() });
    writeFileSync(`${output}/partial.json`, JSON.stringify({ results, errors }, null, 2));
  }
  await page.reload();
  await page.locator('.monaco-editor').waitFor();
  await openSettings(page);
  assert.equal(await page.locator('#garbage-collector').inputValue(), collectors.at(-1));
  assert.deepEqual(errors, []);
  writeFileSync(`${output}/results.json`, JSON.stringify({ passed: true, results }, null, 2));
} finally {
  await browser.close();
}
