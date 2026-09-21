import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { examples } from '../../src/examples.ts';

const output = process.env.PLAYGROUND_EVIDENCE;
if (!output) throw new Error('PLAYGROUND_EVIDENCE is required');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/');
  await page.locator('.monaco-editor').waitFor();
  await page.getByLabel('Optimization', { exact: true }).selectOption('none');
  await page.getByLabel('Example', { exact: true }).selectOption('tunit');
  await page.locator('#editor .view-lines').click({ position: { x: 80, y: 12 } });
  await page.keyboard.press('ControlOrMeta+A');
  const source = examples.find(example => example.id === 'tunit')?.source;
  if (!source?.includes('IsEqualTo(42)')) throw new Error('TUnit source anchor is missing');
  await page.keyboard.insertText(source.replace('IsEqualTo(42)', 'IsEqualTo(43)'));
  await page.locator('#run').click();
  await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined,
    { timeout: 300_000 });
  const result = await page.evaluate(() => ({
    status: document.querySelector('#status').textContent,
    stdout: document.querySelector('#output').textContent,
    exit: document.querySelector('#exit').textContent,
  }));
  if (result.status !== 'Tests complete · 0 passed · 1 failed' || result.exit !== 'Exit 1' ||
      !result.stdout.includes('0 passed · 1 failed')) throw new Error(JSON.stringify(result));
  writeFileSync(`${output}/results.json`, JSON.stringify({ passed: true, ...result }, null, 2));
  console.log('PASS: TUnit assertion failure is discovered and reported');
} finally {
  await browser.close();
}
