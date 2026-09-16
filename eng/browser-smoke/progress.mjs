import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
const output = process.env.PLAYGROUND_EVIDENCE;
if (!output) throw Error('PLAYGROUND_EVIDENCE is required');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:5174/playground/');
  await page.locator('.monaco-editor').waitFor();
  await page.getByLabel('Optimization', { exact: true }).selectOption('Oz');
  await page.evaluate(() => {
    window.progressStatuses = [];
    new MutationObserver(() => window.progressStatuses.push(document.querySelector('#status').textContent))
      .observe(document.querySelector('#status'), { childList: true, subtree: true, characterData: true });
  });
  async function busy() {
    if (!await page.locator('.compile-spinner').isVisible()) throw Error('Busy spinner is hidden');
    if (await page.locator('#compile').isEnabled() || await page.locator('#run').isEnabled() || !await page.locator('#stop').isEnabled()) throw Error('Busy action buttons are incorrect');
  }
  async function idle() {
    await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 180000 });
    if (await page.locator('.compile-spinner').isVisible()) throw Error('Idle spinner remains visible');
    if (!await page.locator('#compile').isEnabled() || !await page.locator('#run').isEnabled()) throw Error('Actions did not recover');
  }
  await page.locator('#run').click();
  await busy();
  await page.screenshot({ path: `${output}/busy.png`, fullPage: true });
  await idle();
  if (await page.locator('#output').textContent() !== '42\n') throw Error('Run failed');
  const statuses = await page.evaluate(() => window.progressStatuses);
  if (!statuses.some(text => text.startsWith('Step 3 of 8')) || !statuses.some(text => text.startsWith('Step 6 of 8')) || !statuses.some(text => text.startsWith('Step 8 of 8'))) throw Error(JSON.stringify(statuses));
  await page.evaluate(() => { window.progressStatuses = []; });
  await page.locator('#run').click();
  await busy();
  await idle();
  const rerun = await page.evaluate(() => window.progressStatuses);
  if (!rerun.some(text => text.startsWith('Step 1 of 1'))) throw Error('Cached run denominator incorrect');
  await page.locator('#compile').click();
  await busy();
  if (!(await page.locator('#status').textContent()).includes('of 7')) throw Error('Compile denominator incorrect');
  await page.locator('#stop').click();
  await idle();
  if (await page.locator('#status').textContent() !== 'Stopped' || errors.length) throw Error(JSON.stringify(errors));
  writeFileSync(`${output}/results.json`, JSON.stringify({ passed: true, statuses, rerun, stopped: true, errors }, null, 2));
  console.log('PASS: numbered progress, disabled actions, cached run and Stop recovery');
} finally { await browser.close(); }
