import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:5174/';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(url);
  await page.waitForFunction(() => crossOriginIsolated, undefined, { timeout: 30_000 });
  await page.locator('.monaco-editor').waitFor();
  await page.getByLabel('Example').selectOption('multi-file');
  if (await page.locator('#file-tree .file-item').count() !== 2)
    throw new Error('The multi-file example did not create two project files.');
  await page.locator('#run').click();
  try {
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Run complete' ||
      document.querySelector('#diagnostics .diagnostic'), undefined, { timeout: 120_000 });
  } catch (error) {
    const state = await page.evaluate(() => ({ status: document.querySelector('#status')?.textContent,
      diagnostics: document.querySelector('#diagnostics')?.textContent,
      stages: [...document.querySelectorAll('#stages li')].map(item => ({ text: item.textContent, state: item.dataset.state })),
      stopDisabled: document.querySelector('#stop')?.disabled }));
    throw new Error(`${error}\n${JSON.stringify({ state, errors })}`);
  }
  const output = await page.locator('#output').textContent();
  const status = await page.locator('#status').textContent();
  if (output !== '42\n' || status !== 'Run complete')
    throw new Error(`Multi-file run failed: ${JSON.stringify({ output, status })}`);
  await page.locator('#compile').click();
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Compilation complete' ||
    document.querySelector('#diagnostics .diagnostic'), undefined, { timeout: 300_000 });
  if (!await page.locator('#download').isEnabled() || !(await page.locator('#size').textContent())?.includes('bytes'))
    throw new Error('Multi-file publish did not produce a downloadable component.');
  if (process.env.PLAYGROUND_EVIDENCE) {
    mkdirSync(process.env.PLAYGROUND_EVIDENCE, { recursive: true });
    await page.screenshot({ path: `${process.env.PLAYGROUND_EVIDENCE}/mini-ide.png`, fullPage: true });
  }

  await page.locator('#file-tree .file-item', { hasText: 'Answer.cs' }).click();
  await page.locator('.monaco-editor').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type('public static class Answer { public const int Value = Missing; }');
  await page.locator('#compile').click();
  await page.waitForFunction(() => document.querySelector('#diagnostics .diagnostic'), undefined, { timeout: 300_000 });
  const diagnostic = await page.locator('#diagnostics .diagnostic').first().textContent();
  if (!diagnostic?.includes('Answer.cs') || !diagnostic.includes('CS0103'))
    throw new Error(`Path-aware diagnostic missing: ${diagnostic}`);
  if (errors.length) throw new Error(`Page errors: ${errors.join('\n')}`);
  console.log('PASS: multi-file run and path-aware diagnostic');
} finally {
  await browser.close();
}
