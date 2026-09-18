import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const output = process.env.PLAYGROUND_EVIDENCE;
if (!output) throw Error('PLAYGROUND_EVIDENCE is required');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [], errors = [];
try {
  const page = await browser.newPage({ acceptDownloads: true });
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:5173/playground/');
  await page.locator('.monaco-editor').waitFor();
  const modes = await page.getByLabel('Optimization', { exact: true }).locator('option').evaluateAll(options => options.map(option => option.value));
  if (modes.includes('O4') || !['none', 'O0', 'O1', 'O2', 'O3', 'Os', 'Oz'].every(mode => modes.includes(mode))) throw Error(`Unexpected optimization modes: ${modes}`);
  if (await page.getByLabel('Optimization', { exact: true }).inputValue() !== 'Oz') throw Error('Expected -Oz to be selected by default');
  await page.getByLabel('Example', { exact: true }).selectOption('json-generated');
  for (const mode of ['none', 'Oz']) {
    await page.getByLabel('Optimization', { exact: true }).selectOption(mode);
    await page.evaluate(() => {
      window.optimizationStatuses = [];
      new MutationObserver(() => window.optimizationStatuses.push(document.querySelector('#status').textContent))
        .observe(document.querySelector('#status'), { childList: true, subtree: true, characterData: true });
    });
    const started = Date.now();
    await page.locator('#run').click();
    if (await page.getByLabel('Optimization', { exact: true }).isEnabled()) throw Error('Optimization changed while busy');
    await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 240000 });
    const ui = await page.evaluate(() => ({
      status: document.querySelector('#status').textContent,
      stdout: document.querySelector('#output').textContent,
      size: document.querySelector('#size').textContent,
      timings: document.querySelector('#timings').textContent,
      comparison: document.querySelector('#comparison').textContent,
      statuses: window.optimizationStatuses,
    }));
    if (ui.status !== 'Run complete' || ui.stdout !== '{"Name":"Ada","Score":42}\n') throw Error(JSON.stringify(ui));
    if ((mode === 'none') === ui.timings.includes('optimize:')) throw Error(`${mode}: unexpected optimization timing`);
    const download = page.waitForEvent('download');
    await page.locator('#download').click();
    const item = await download;
    if (item.suggestedFilename() !== `program-${mode}.wasm`) throw Error(`Wrong filename: ${item.suggestedFilename()}`);
    const path = `${output}/${mode}.wasm`; await item.saveAs(path);
    const bytes = readFileSync(path), nativeStdout = execFileSync('wasmtime', [path], { encoding: 'utf8' });
    if (nativeStdout !== ui.stdout) throw Error(`${mode}: Wasmtime output mismatch`);
    const denominator = mode === 'none' ? 7 : 8;
    if (!ui.statuses.some(status => status.startsWith(`Step ${denominator} of ${denominator}`))) throw Error(`${mode}: progress denominator missing`);
    results.push({ mode, elapsedMilliseconds: Date.now() - started, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), nativeStdout, ui });
    writeFileSync(`${output}/partial.json`, JSON.stringify({ results, errors }, null, 2));
    console.log(`PASS: ${mode} ${bytes.length} bytes`);
  }
  if (results[0].bytes <= results[1].bytes || results[0].elapsedMilliseconds >= results[1].elapsedMilliseconds)
    throw Error('None did not demonstrate the expected speed/size tradeoff');
  const comparison = results[1].ui.comparison;
  if (!comparison.includes('None (fastest)') || !comparison.includes('-Oz (smallest)')) throw Error('Comparison did not retain both results');
  if (errors.length) throw Error(errors.join('\n'));
  await page.screenshot({ path: `${output}/comparison.png`, fullPage: true });
  writeFileSync(`${output}/results.json`, JSON.stringify({ passed: true, browser: browser.version(), wasmtime: execFileSync('wasmtime', ['--version'], { encoding: 'utf8' }).trim(), results, errors }, null, 2));
  console.log('PASS: selectable optimization speed/size comparison and Wasmtime downloads');
} finally { await browser.close(); }
