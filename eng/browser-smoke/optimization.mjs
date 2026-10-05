import { openSample, setOptimizations } from './playground-ui.mjs';
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
  const modes = await page.locator('#optimization option').evaluateAll(options => options.map(option => option.value));
  if (modes.includes('O4') || !['none', 'O0', 'O1', 'O2', 'O3', 'Os', 'Oz'].every(mode => modes.includes(mode))) throw Error(`Unexpected optimization modes: ${modes}`);
  if (await page.locator('#optimization').inputValue() !== 'Oz') throw Error('Expected -Oz to be selected by default');
  await openSample(page, 'json-generated');
  for (const mode of ['none', 'Oz']) {
    await setOptimizations(page, mode);
    await page.evaluate(() => {
      window.optimizationStatuses = [];
      new MutationObserver(() => window.optimizationStatuses.push(document.querySelector('#status').textContent))
        .observe(document.querySelector('#status'), { childList: true, subtree: true, characterData: true });
    });
    const started = Date.now();
    await page.locator('#compile').click();
    if (await page.locator('#optimization').isEnabled()) throw Error('Optimization changed while busy');
    await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 240000 });
    const ui = await page.evaluate(() => ({
      status: document.querySelector('#status').textContent,
      stdout: document.querySelector('#output').textContent,
      size: document.querySelector('#size').textContent,
      timings: document.querySelector('#timings').textContent,
      comparison: document.querySelector('#comparison').textContent,
      statuses: window.optimizationStatuses,
    }));
    if (ui.status !== 'Compilation complete') throw Error(JSON.stringify(ui));
    if ((mode === 'none') === ui.timings.includes('optimize:')) throw Error(`${mode}: unexpected optimization timing`);
    const download = page.waitForEvent('download');
    await page.locator('#download').click();
    const item = await download;
    if (item.suggestedFilename() !== `program-${mode}.wasm`) throw Error(`Wrong filename: ${item.suggestedFilename()}`);
    const path = `${output}/${mode}.wasm`; await item.saveAs(path);
    const bytes = readFileSync(path), nativeStdout = execFileSync('wasmtime', [path], { encoding: 'utf8' });
    if (nativeStdout !== '{"Name":"Ada","Score":42}\n') throw Error(`${mode}: Wasmtime output mismatch`);
    if (!ui.statuses.some(status => status.startsWith('Packaging component'))) throw Error(`${mode}: component packaging phase missing`);
    if ((mode === 'none') === ui.statuses.some(status => status.startsWith('Optimizing WebAssembly')))
      throw Error(`${mode}: optimizer phase mismatch`);
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
