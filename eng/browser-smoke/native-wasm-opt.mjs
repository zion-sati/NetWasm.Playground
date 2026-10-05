import { mkdirSync, writeFileSync } from 'node:fs';
import { browserName, browserType } from './engine.mjs';

const url = process.env.PLAYGROUND_URL;
const output = process.env.PLAYGROUND_EVIDENCE;
if (!url || !output) throw Error('PLAYGROUND_URL and PLAYGROUND_EVIDENCE are required');
mkdirSync(output, { recursive: true });

const browser = await browserType.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => {
    if (request.url().includes('/native-wasm-opt/')) requests.push(request.url());
  });
  await page.goto(url);
  await page.locator('.monaco-editor').waitFor();
  await page.getByLabel('Optimization', { exact: true }).selectOption('Oz');
  await page.evaluate(() => {
    window.nativeOptimizerStatuses = [];
    new MutationObserver(() => window.nativeOptimizerStatuses.push(document.querySelector('#status').textContent))
      .observe(document.querySelector('#status'), { childList: true, subtree: true, characterData: true });
  });

  const finish = () => page.waitForFunction(() => document.querySelector('#stop').disabled,
    undefined, { timeout: 300_000 });
  await page.locator('#run').click();
  await finish();
  const first = await page.evaluate(() => ({
    status: document.querySelector('#status').textContent,
    stdout: document.querySelector('#output').textContent,
    optimizer: document.querySelector('#optimizer').textContent,
    isolated: crossOriginIsolated,
    statuses: window.nativeOptimizerStatuses,
  }));
  if (first.status !== 'Run complete' || first.stdout !== '42\n' ||
      !first.optimizer.startsWith('Optimizer: native WebAssembly') || !first.isolated ||
      !first.statuses.some(status => status.includes('Compiling WebAssembly')))
    throw Error(`Native optimizer did not complete: ${JSON.stringify(first)}`);

  await page.locator('#compile').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Optimizing WebAssembly'),
    undefined, { timeout: 180_000 });
  await page.locator('#stop').click();
  await finish();
  if (await page.locator('#status').textContent() !== 'Stopped')
    throw Error('Stop did not terminate the native optimizer');

  await page.locator('#compile').click();
  await finish();
  const recovery = await page.evaluate(() => ({
    status: document.querySelector('#status').textContent,
    optimizer: document.querySelector('#optimizer').textContent,
  }));
  if (recovery.status !== 'Compilation complete' ||
      !/^Optimizer: (?:native WebAssembly|JavaScript fallback)/.test(recovery.optimizer) || errors.length)
    throw Error(`Native optimizer did not recover: ${JSON.stringify({ recovery, errors })}`);
  const requested = [...new Set(requests.map(value => new URL(value).pathname.split('/').at(-1)))];
  for (const required of ['build-receipt.json', 'wasm-opt.js', 'wasm-opt.wasm'])
    if (!requested.includes(required)) throw Error(`Native optimizer asset was not requested: ${required}`);
  const result = { passed: true, browser: browserName, first, recovery,
    nativeAssets: requested, errors };

  const fallbackContext = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const fallbackPage = await fallbackContext.newPage();
    await fallbackPage.goto(url);
    await fallbackPage.locator('.monaco-editor').waitFor();
    await fallbackPage.getByLabel('Optimization', { exact: true }).selectOption('Oz');
    await fallbackPage.locator('#run').click();
    await fallbackPage.waitForFunction(() => document.querySelector('#stop').disabled,
      undefined, { timeout: 300_000 });
    result.fallback = await fallbackPage.evaluate(() => ({
      status: document.querySelector('#status').textContent,
      stdout: document.querySelector('#output').textContent,
      optimizer: document.querySelector('#optimizer').textContent,
      isolated: crossOriginIsolated,
    }));
    if (result.fallback.status !== 'Run complete' || result.fallback.stdout !== '42\n' ||
        result.fallback.isolated ||
        result.fallback.optimizer !== 'Optimizer: JavaScript fallback · native optimizer unavailable')
      throw Error(`Native optimizer fallback failed: ${JSON.stringify(result.fallback)}`);
  } finally { await fallbackContext.close(); }
  writeFileSync(`${output}/results.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(`PASS: ${browserName} native wasm-opt, Stop recovery, and visible JavaScript fallback`);
} finally {
  await browser.close();
}
