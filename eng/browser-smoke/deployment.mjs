import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const url = process.env.PLAYGROUND_URL;
const output = process.env.PLAYGROUND_EVIDENCE;
if (!url || !output) throw Error('PLAYGROUND_URL and PLAYGROUND_EVIDENCE are required');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [], requests = [];
try {
  const page = await browser.newPage({ acceptDownloads: true });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => requests.push({ method: request.method(), body: request.postData() }));
  await page.goto(url);
  await page.locator('.monaco-editor').waitFor();
  if (requests.some(request => request.body || request.method !== 'GET')) throw Error('Unexpected request before compilation');
  await page.getByLabel('Optimization', { exact: true }).selectOption('none');
  await page.locator('#run').click();
  if (await page.locator('#compile').isEnabled() || await page.locator('#run').isEnabled()) throw Error('Busy controls remain enabled');
  await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 240000 });
  const stdout = await page.locator('#output').textContent();
  const status = await page.locator('#status').textContent();
  if (stdout !== '42\n' || status !== 'Run complete') throw Error(`Browser run failed: ${status} ${JSON.stringify(stdout)}`);
  const event = page.waitForEvent('download');
  await page.locator('#download').click();
  const download = await event;
  if (download.suggestedFilename() !== 'program-none.wasm') throw Error('Unexpected download filename');
  const componentPath = `${output}/hello-none.wasm`;
  await download.saveAs(componentPath);
  const nativeStdout = execFileSync('wasmtime', [componentPath], { encoding: 'utf8' });
  if (nativeStdout !== stdout) throw Error('Wasmtime output differs from browser output');
  if (errors.length || requests.some(request => request.body || request.method !== 'GET')) throw Error(`Privacy/page errors: ${JSON.stringify({ errors, requests })}`);
  const bytes = readFileSync(componentPath);
  const result = { passed: true, browser: browser.version(), stdout, status,
    component: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, errors, requestCount: requests.length };
  writeFileSync(`${output}/results.json`, JSON.stringify(result, null, 2));
  console.log('PASS: deployed browser compile/run/download and Wasmtime execution');
} finally {
  await browser.close();
}
