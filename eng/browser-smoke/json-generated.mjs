import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { examples } from '../../src/examples.ts';
const url = process.env.PLAYGROUND_URL, output = process.env.PLAYGROUND_EVIDENCE, desktop = process.env.PLAYGROUND_DESKTOP_EXAMPLES;
if (!url || !output || !desktop) throw Error('PLAYGROUND_URL, PLAYGROUND_EVIDENCE and PLAYGROUND_DESKTOP_EXAMPLES are required');
mkdirSync(output, { recursive: true });
const expected = JSON.parse(readFileSync(`${desktop}/outcomes.json`, 'utf8')).find(example => example.id === 'json-generated');
const source = examples.find(example => example.id === 'json-generated').source;
const browser = await chromium.launch({ headless: true });
const errors = [], results = [];
try {
  const page = await browser.newPage({ acceptDownloads: true });
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(url);
  await page.locator('.monaco-editor').waitFor();
  if (process.env.PLAYGROUND_COMPARE_DESKTOP_BYTES === '1') await page.getByLabel('Optimization', { exact: true }).selectOption('Oz');
  await page.getByLabel('Example', { exact: true }).selectOption('json-generated');
  async function run(stdout) {
    await page.locator('#run').click();
    await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 300000 });
    const result = await page.evaluate(() => ({ stdout: document.querySelector('#output').textContent, status: document.querySelector('#status').textContent, diagnostics: document.querySelector('#diagnostics').textContent, timings: document.querySelector('#timings').textContent, size: document.querySelector('#size').textContent }));
    results.push(result);
    writeFileSync(`${output}/partial.json`, JSON.stringify({ results, errors }, null, 2));
    if (result.status !== 'Run complete' || result.stdout !== stdout) throw Error(JSON.stringify(result));
  }
  await run(expected.stdout);
  const download = page.waitForEvent('download'); await page.locator('#download').click();
  await (await download).saveAs(`${output}/json-generated.wasm`);
  const bytes = readFileSync(`${output}/json-generated.wasm`);
  const component = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  if (process.env.PLAYGROUND_COMPARE_DESKTOP_BYTES === '1' && component.sha256 !== expected.component.sha256) throw Error('Generated JSON component differs from desktop');
  const edited = source.replaceAll('Score', 'Count').replace('Count = 42', 'Count = 43');
  await page.locator('#editor .view-lines').click({ position: { x: 80, y: 12 } });
  await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(edited);
  if (await page.locator('#download').isEnabled()) throw Error('Edit retained stale download');
  await run('{"Name":"Ada","Count":43}\n');
  if (errors.length) throw Error(errors.join('\n'));
  await page.screenshot({ path: `${output}/json-generated.png`, fullPage: true });
  writeFileSync(`${output}/browser-test.json`, JSON.stringify({ passed: true, browser: browser.version(), component, source, edited, results, errors }, null, 2));
  console.log('PASS: actual JSON generator, downloaded component, renamed property and edited value');
} finally { await browser.close(); }
