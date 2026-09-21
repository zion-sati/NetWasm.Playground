import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const output = process.env.PLAYGROUND_EVIDENCE;
if (!output) throw Error('PLAYGROUND_EVIDENCE is required');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    const workers = [];
    globalThis.Worker = class ObservedWorker extends NativeWorker {
      constructor(specifier, options) {
        super(specifier, options);
        const record = { operations: [], terminated: false };
        workers.push(record);
        const post = this.postMessage.bind(this);
        this.postMessage = (message, transfer) => {
          if (typeof message?.operation === 'string') record.operations.push(message.operation);
          return transfer === undefined ? post(message) : post(message, transfer);
        };
        const terminate = this.terminate.bind(this);
        this.terminate = () => { record.terminated = true; return terminate(); };
      }
    };
    globalThis.compilerLifecycle = () => structuredClone(workers);
  });
  await page.goto(process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:5173/playground/');
  await page.locator('.monaco-editor').waitFor();
  await page.getByLabel('Optimization', { exact: true }).selectOption('none');
  for (let iteration = 0; iteration < 2; iteration++) {
    await page.locator('#compile').click();
    await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined,
      { timeout: 240000 });
    if (await page.locator('#status').textContent() !== 'Compilation complete')
      throw Error(`Compilation ${iteration + 1} did not complete`);
    const compilers = await page.evaluate(() => globalThis.compilerLifecycle()
      .filter(worker => worker.operations.includes('compile')));
    if (compilers.length !== iteration + 1 || compilers.some(worker => !worker.terminated) ||
        compilers.some(worker => !worker.operations.includes('prune')))
      throw Error(`Compiler worker lifetime mismatch after compilation ${iteration + 1}`);
  }
  const beforeReload = await page.evaluate(() => globalThis.compilerLifecycle());
  await page.reload();
  await page.locator('.monaco-editor').waitFor();
  await page.getByLabel('Optimization', { exact: true }).selectOption('none');
  await page.locator('#compile').click();
  await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined,
    { timeout: 240000 });
  const afterReload = await page.evaluate(() => globalThis.compilerLifecycle());
  const reloadedCompilers = afterReload.filter(worker => worker.operations.includes('compile'));
  if (reloadedCompilers.length !== 1 || reloadedCompilers.some(worker => !worker.terminated))
    throw Error('Compiler worker did not recover and recycle after page reload');
  const result = { passed: true, beforeReload, afterReload };
  writeFileSync(`${output}/results.json`, JSON.stringify(result, null, 2));
  console.log('PASS: each compilation terminates its compiler worker after pruning');
} finally {
  await browser.close();
}
