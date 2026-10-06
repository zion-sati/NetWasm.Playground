import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:5178/';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(root);
  await page.locator('.monaco-editor').waitFor();

  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
  const header = Buffer.from(`${'native.o/'.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'644'.padEnd(8)}${String(elf.length).padEnd(10)}\`\n`);
  await page.locator('#file-input').setInputFiles({
    name: 'libnative.a', mimeType: 'application/octet-stream',
    buffer: Buffer.concat([Buffer.from('!<arch>\n'), header, elf]),
  });
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('not a WebAssembly object'));
  assert.equal(await page.locator('.file-item[data-kind="native-archive"]').count(), 0,
    'rejected native archive entered the project');

  await page.locator('#open-samples').click();
  await page.locator('[data-sample-id="native-lz4"]').click();
  await page.waitForFunction(() => document.querySelector('#project-name')?.textContent === 'Native library · LZ4');
  assert.equal(await page.locator('.file-item[data-kind="native-archive"]').count(), 1);
  await page.locator('.file-item[data-kind="native-archive"]').click();
  await page.locator('#archive-properties').click();
  assert.equal(await page.locator('#archive-library-name').inputValue(), 'lz4');
  await page.locator('#archive-dialog button[value="cancel"]').first().click();

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
  assert.match(output ?? '', /^LZ4 compressed 257 bytes to \d+ bytes\.\nRound trip: True\n$/);
  assert.deepEqual(errors, []);
  console.log(`PASS: ${output.trim().replaceAll('\n', ' · ')}`);
} finally {
  await browser.close();
}
