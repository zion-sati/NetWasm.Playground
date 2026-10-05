import { openSample, setOptimizations } from './playground-ui.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { browserName, browserType } from './engine.mjs';

const url = process.env.PLAYGROUND_URL;
const output = process.env.PLAYGROUND_EVIDENCE;
if (!url || !output) throw Error('PLAYGROUND_URL and PLAYGROUND_EVIDENCE are required');
mkdirSync(output, { recursive: true });
const contract = JSON.parse(readFileSync(
  new URL('../release-contract.json', import.meta.url), 'utf8'));
if (contract.schemaVersion !== 1 || contract.helloWorld42?.componentBytes !== 84_653)
  throw Error('Invalid Hello World release contract');

async function downloadContractComponent(page, name) {
  const event = page.waitForEvent('download');
  await page.locator('#download').click();
  const download = await event;
  if (download.suggestedFilename() !== 'program-Oz.wasm')
    throw Error(`Unexpected contract artifact name: ${download.suggestedFilename()}`);
  const path = `${output}/${name}.wasm`;
  await download.saveAs(path);
  const bytes = readFileSync(path);
  if (bytes.length !== contract.helloWorld42.componentBytes)
    throw Error(`Hello World size regression: expected ${contract.helloWorld42.componentBytes}, got ${bytes.length}`);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

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
  await openSample(page, contract.helloWorld42.exampleId);
  await setOptimizations(page, contract.helloWorld42.optimization);
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
  if (first.status !== 'Run complete' || first.stdout !== contract.helloWorld42.stdout ||
      !first.optimizer.startsWith('Optimizer: native WebAssembly') || !first.isolated ||
      !first.statuses.some(status => status.includes('Compiling WebAssembly')))
    throw Error(`Native optimizer did not complete: ${JSON.stringify(first)}`);
  const component = await downloadContractComponent(page, `${browserName}-hello-oz-native`);

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
  const result = { passed: true, browser: browserName, first, recovery, component,
    nativeAssets: requested, errors };

  const fallbackContext = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const fallbackPage = await fallbackContext.newPage();
    await fallbackPage.goto(url);
    await fallbackPage.locator('.monaco-editor').waitFor();
    await openSample(fallbackPage, contract.helloWorld42.exampleId);
    await setOptimizations(fallbackPage, contract.helloWorld42.optimization);
    await fallbackPage.locator('#run').click();
    await fallbackPage.waitForFunction(() => document.querySelector('#stop').disabled,
      undefined, { timeout: 300_000 });
    result.fallback = await fallbackPage.evaluate(() => ({
      status: document.querySelector('#status').textContent,
      stdout: document.querySelector('#output').textContent,
      optimizer: document.querySelector('#optimizer').textContent,
      isolated: crossOriginIsolated,
    }));
    if (result.fallback.status !== 'Run complete' || result.fallback.stdout !== contract.helloWorld42.stdout ||
        result.fallback.isolated ||
        result.fallback.optimizer !== 'Optimizer: JavaScript fallback · native optimizer unavailable')
      throw Error(`Native optimizer fallback failed: ${JSON.stringify(result.fallback)}`);
    result.fallback.component = await downloadContractComponent(
      fallbackPage, `${browserName}-hello-oz-javascript`);
    if (result.fallback.component.sha256 !== component.sha256)
      throw Error('Native and JavaScript optimizer outputs differ');
  } finally { await fallbackContext.close(); }
  writeFileSync(`${output}/results.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(`PASS: ${browserName} native wasm-opt, Stop recovery, and visible JavaScript fallback`);
} finally {
  await browser.close();
}
