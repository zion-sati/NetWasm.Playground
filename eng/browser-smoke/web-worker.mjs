import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { openSample } from './playground-ui.mjs';

const root = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:5178/';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(root);
  await page.locator('.monaco-editor').waitFor();

  await openSample(page, 'web-worker');
  await page.waitForFunction(() => document.querySelector('#project-name')?.textContent === 'Web Worker · JSExport');
  assert.equal(await page.locator('.file-item[data-kind="csharp"]').count(), 1);
  assert.equal(await page.locator('.file-item[data-kind="javascript"]').count(), 1);

  await page.locator('#run').click();
  await page.waitForFunction(() => {
    const status = document.querySelector('#status')?.textContent ?? '';
    return status === 'Run complete' || /failed|error|unsupported/i.test(status);
  }, undefined, { timeout: 240_000 });
  const status = await page.locator('#status').textContent();
  if (status !== 'Run complete') {
    const problems = await page.locator('#diagnostics').textContent();
    const consoleText = await page.locator('#output').textContent();
    throw new Error(`${status}\nProblems: ${problems}\nConsole: ${consoleText}`);
  }
  const output = await page.locator('#output').textContent();
  assert.equal(output, [
    'Progress: 1/5',
    'Progress: 2/5',
    'Progress: 3/5',
    'Progress: 4/5',
    'Progress: 5/5',
    'Completed: 5',
    '',
  ].join('\n'));
  assert.deepEqual(errors, []);
  console.log(`PASS: ${output.trim().replaceAll('\n', ' · ')}`);
} finally {
  await browser.close();
}
