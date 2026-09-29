import { browserType } from './engine.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const output = process.env.PLAYGROUND_EVIDENCE;
if (!output) throw Error('PLAYGROUND_EVIDENCE is required');
mkdirSync(output, { recursive: true });

const modes = ['none', 'O0', 'O1', 'O2', 'O3', 'Os', 'Oz'];
const browser = await browserType.launch({ headless: true });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/');
  await page.locator('.monaco-editor').waitFor();
  await page.locator('#clear-cache').click();
  await page.locator('#status').filter({ hasText: 'Compilation cache cleared' }).waitFor();
  await page.locator('#editor .view-lines').click({ position: { x: 80, y: 12 } });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('using System;\nConsole.WriteLine(42);\n');

  const results = [];
  for (const mode of modes) {
    await page.getByLabel('Optimization', { exact: true }).selectOption(mode);
    await page.locator('#compile').click();
    await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined,
      { timeout: 300_000 });
    const status = await page.locator('#status').textContent();
    if (status !== 'Compilation complete') throw Error(`${mode} failed: ${status}`);
    const download = page.waitForEvent('download');
    await page.locator('#download').click();
    const path = `${output}/${mode}.wasm`;
    await (await download).saveAs(path);
    const component = readFileSync(path);
    const result = {
      mode,
      bytes: component.byteLength,
      sha256: createHash('sha256').update(component).digest('hex'),
      timings: await page.locator('#timings').textContent(),
    };
    results.push(result);
    writeFileSync(`${output}/partial.json`, JSON.stringify({ results, errors }, null, 2));
    console.log(`PASS: ${mode} ${result.bytes} bytes ${result.sha256}`);
  }
  if (errors.length) throw Error(`Page errors: ${JSON.stringify(errors)}`);
  writeFileSync(`${output}/results.json`, JSON.stringify({ passed: true, results, errors }, null, 2));
} finally {
  await browser.close();
}
