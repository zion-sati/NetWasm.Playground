import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:5178/';
const html = await (await fetch(root)).text();
assert.doesNotMatch(html, /Console\.WriteLine\(42\)/,
  'The obsolete static code sample remains in the initial HTML');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/toolchain/**', route => route.abort());
  await page.goto(root);
  await page.locator('.monaco-editor').waitFor();

  assert.equal(await page.locator('.ide-toolbar select').count(), 0,
    'The toolbar still contains an inline sample or settings dropdown');
  assert.equal(await page.locator('#samples-dialog').evaluate(dialog => dialog.open), false);
  await page.locator('#open-samples').click();
  assert.equal(await page.locator('#samples-dialog').evaluate(dialog => dialog.open), true);
  const cards = page.locator('#sample-list .sample-card');
  assert.ok(await cards.count() > 1, 'The sample dialog contains no project list');
  assert.equal(await cards.filter({ has: page.locator('strong') }).count(), await cards.count());
  assert.equal(await cards.filter({ has: page.locator('span') }).count(), await cards.count());
  await page.locator('#samples-dialog [aria-label="Close"]').click();

  await page.locator('#settings-toggle').click();
  assert.equal(await page.locator('#settings-dialog').evaluate(dialog => dialog.open), true);
  assert.equal(await page.locator('#run-optimization').inputValue(), 'none');
  assert.equal(await page.locator('#optimization').inputValue(), 'Oz');
  await page.locator('#run-optimization').selectOption('O1');
  await page.locator('#optimization').selectOption('Os');
  await page.locator('#settings-dialog footer button').click();

  await page.reload();
  await page.locator('.monaco-editor').waitFor();
  await page.locator('#settings-toggle').click();
  assert.equal(await page.locator('#run-optimization').inputValue(), 'O1');
  assert.equal(await page.locator('#optimization').inputValue(), 'Os');
  assert.deepEqual(await page.evaluate(() => ({
    run: localStorage.getItem('netwasm.runOptimization'),
    publish: localStorage.getItem('netwasm.publishOptimization'),
  })), { run: 'O1', publish: 'Os' });
  assert.deepEqual(errors, []);
  console.log('PASS: static sample removed, modal sample/settings flows, independent persisted profiles');
} finally {
  await browser.close();
}
