import { setOptimizations } from './playground-ui.mjs';
import { browserType } from './engine.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const output = process.env.PLAYGROUND_EVIDENCE;
if (!output) throw Error('PLAYGROUND_EVIDENCE is required');
mkdirSync(output, { recursive: true });
const browser = await browserType.launch({ headless: true });
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
  await setOptimizations(page, 'none');
  const success = page.locator('#compilation-success');
  if (await success.isVisible()) throw Error('Compilation callout is visible before compilation');
  await page.locator('#compile').click();
  await page.waitForFunction(() => !document.querySelector('#stop').disabled, undefined,
    { timeout: 10000 });
  if (await success.isVisible()) throw Error('Compilation callout remains visible while compiling');
  await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined,
    { timeout: 240000 });
  const status = await page.locator('#status').textContent();
  if (status !== 'Compilation complete') throw Error(`Compilation did not complete: ${status}`);
  if (!await success.isVisible() || await success.locator('span').textContent() !==
      'Compiled entirely in your browser with NetWasm.')
    throw Error('Compilation callout is missing or stale');
  const followLink = success.getByRole('link', { name: 'Follow the project on GitHub →' });
  if (await followLink.getAttribute('href') !== 'https://github.com/zion-sati/NetWasm' ||
      await followLink.getAttribute('target') !== '_blank')
    throw Error('Compilation callout link is incorrect');
  const compilers = await page.evaluate(() => globalThis.compilerLifecycle()
    .filter(worker => worker.operations.includes('compile')));
  if (compilers.length !== 1 || compilers.some(worker => !worker.terminated) ||
      compilers.some(worker => !worker.operations.includes('prune')))
    throw Error('Compiler worker lifetime mismatch after compilation');
  await page.locator('#editor .view-lines').click({ position: { x: 80, y: 12 } });
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText('\n');
  if (await success.isVisible()) throw Error('Source edit did not hide compilation callout');
  const beforeReload = await page.evaluate(() => globalThis.compilerLifecycle());
  await page.reload();
  await page.locator('.monaco-editor').waitFor();
  if (await page.locator('#compilation-success').isVisible())
    throw Error('Page reload retained compilation callout');
  await setOptimizations(page, 'none');
  await page.locator('#compile').click();
  await page.waitForFunction(() => !document.querySelector('#stop').disabled, undefined,
    { timeout: 10000 });
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
