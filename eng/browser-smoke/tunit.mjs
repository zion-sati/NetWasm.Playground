import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const url = process.env.PLAYGROUND_URL, output = process.env.PLAYGROUND_EVIDENCE, desktop = process.env.PLAYGROUND_TUNIT_EXAMPLE;
if (!url || !output || !desktop) throw Error('PLAYGROUND_URL, PLAYGROUND_EVIDENCE and PLAYGROUND_TUNIT_EXAMPLE are required');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true }), errors = [], results = [];
const selectedCase = process.env.PLAYGROUND_TUNIT_CASE;
if (selectedCase && !['template', 'second-test', 'assertion-failure'].includes(selectedCase)) throw Error('Unknown TUnit smoke case');
try {
  const page = await browser.newPage({ acceptDownloads: true }); page.on('pageerror', error => errors.push(String(error)));
  await page.goto(url); await page.locator('.monaco-editor').waitFor();
  await page.getByLabel('Optimization', { exact: true }).selectOption('none');
  await page.getByLabel('Example', { exact: true }).selectOption('tunit');
  for (const [name, passed, failed] of [['template', 1, 0], ['second-test', 2, 0], ['assertion-failure', 1, 1]]) {
    if (selectedCase && name !== selectedCase) continue;
    const source = readFileSync(`${desktop}/cases/${name}/Tests.cs`, 'utf8');
    if (name !== 'template') {
      await page.locator('#editor').click({ position: { x: 100, y: 40 } }); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(source);
      if (await page.locator('#download').isEnabled()) throw Error('Edited tests retained stale artifact');
    }
    await page.locator('#run').click(); await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 300000 });
    const result = await page.evaluate(() => ({ stdout: document.querySelector('#output').textContent, status: document.querySelector('#status').textContent, diagnostics: document.querySelector('#diagnostics').textContent, exit: document.querySelector('#exit').textContent, timings: document.querySelector('#timings').textContent, size: document.querySelector('#size').textContent }));
    result.name = name; results.push(result); writeFileSync(`${output}/partial.json`, JSON.stringify({ results, errors }, null, 2));
    if (result.status !== `Tests complete · ${passed} passed · ${failed} failed` || result.exit !== `Exit ${failed ? 1 : 0}` || !result.stdout.includes(`${passed} passed · ${failed} failed`)) throw Error(JSON.stringify(result));
    if (failed && !result.stdout.includes('Expected answer')) throw Error('Missing assertion diagnostic');
    const download = page.waitForEvent('download'); await page.locator('#download').click(); await (await download).saveAs(`${output}/${name}.wasm`);
    const bytes = readFileSync(`${output}/${name}.wasm`); result.component = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    console.log(`PASS: editable TUnit ${name} ${passed}/${failed} ${bytes.length} bytes`);
  }
  if (new Set(results.map(result => result.component.sha256)).size !== results.length) throw Error('Test declaration/assertion edits did not change artifacts');
  if (errors.length) throw Error(errors.join('\n'));
  await page.screenshot({ path: `${output}/tunit.png`, fullPage: true });
  writeFileSync(`${output}/browser-test.json`, JSON.stringify({ passed: true, browser: browser.version(), results, errors }, null, 2));
} finally { await browser.close(); }
