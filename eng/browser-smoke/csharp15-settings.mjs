import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const output = process.env.PLAYGROUND_EVIDENCE;
if (!output) throw new Error('PLAYGROUND_EVIDENCE is required');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/');
  await page.locator('.monaco-editor').waitFor();
  await page.getByLabel('Optimization', { exact: true }).selectOption('none');
  await page.getByLabel('Example', { exact: true }).selectOption('csharp15-tour');
  const source = await page.locator('#editor').textContent();

  async function compileExpecting(success) {
    await page.locator('#compile').click();
    await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined,
      { timeout: 240_000 });
    const result = await page.evaluate(() => ({
      status: document.querySelector('#status').textContent,
      diagnostics: document.querySelector('#diagnostics').textContent,
      download: !document.querySelector('#download').disabled,
    }));
    if (success !== result.download) throw new Error(JSON.stringify(result));
    return result;
  }

  await page.getByLabel('Language', { exact: true }).selectOption('15');
  const stable = await compileExpecting(false);
  await page.getByLabel('Language', { exact: true }).selectOption('preview');
  const previewWithoutRules = await compileExpecting(false);
  await page.locator('#updated-memory-safety').check();
  const recovered = await compileExpecting(true);
  if (await page.locator('#editor').textContent() !== source ||
      stable.diagnostics === 'No diagnostics.' || previewWithoutRules.diagnostics === 'No diagnostics.' ||
      recovered.diagnostics !== 'No diagnostics.' || errors.length)
    throw new Error(JSON.stringify({ stable, previewWithoutRules, recovered, errors }));
  const result = { passed: true, stable, previewWithoutRules, recovered, errors };
  writeFileSync(`${output}/results.json`, JSON.stringify(result, null, 2));
  console.log('PASS: identical C# 15 source follows language/feature settings and recovers');
} finally {
  await browser.close();
}
