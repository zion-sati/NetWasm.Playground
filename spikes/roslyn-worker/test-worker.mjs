import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const inputs = JSON.parse(readFileSync('inputs.json', 'utf8'));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
const messages = [];
page.on('console', message => messages.push({ type: message.type(), text: message.text() }));
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const watchdog = setTimeout(() => { void browser.close(); }, 120_000);
try {
  await page.goto(process.env.COMPILER_PROBE_URL);
  await page.evaluate(() => window.ready);
  const results = [];
  const sources = [inputs.source, inputs.source.replace('42', '43'),
    'using System; Console.WriteLine(;', inputs.source.replace('42', '44')];
  for (const source of sources) {
    const start = performance.now();
    const result = await page.evaluate(source => window.compile(source), source);
    if (result.pe) {
      const bytes = Buffer.from(result.pe, 'base64');
      writeFileSync(`managed-${results.length}.dll`, bytes);
      result.bytes = bytes.length;
      result.sha256 = createHash('sha256').update(bytes).digest('hex');
      delete result.pe;
    }
    results.push({ ...result, ms: performance.now() - start });
  }
  const record = { browser: browser.version(), results, errors,
    inputsSha256: createHash('sha256').update(readFileSync('inputs.json')).digest('hex') };
  writeFileSync('worker-test.json', JSON.stringify(record, null, 2));
  const diagnostic = results[2].diagnostics.find(d => d.code === 'CS1026');
  if (!results[0].success || !results[1].success || results[2].success || !results[3].success ||
      results[0].sha256 === results[1].sha256 || results[1].sha256 === results[3].sha256 ||
      diagnostic?.path !== 'Program.cs' || diagnostic.line !== 0 || diagnostic.column !== 32 ||
      results[2].bytes !== undefined || errors.length !== 0) {
    throw new Error('Compile, diagnostic location, failure isolation or recovery assertions failed');
  }
  await page.locator('#source').fill(inputs.source.replace('42', '45'));
  await page.locator('#compile').click();
  await page.waitForFunction(() => window.lastResult !== null && window.lastResult !== undefined);
  const editorResult = await page.evaluate(() => window.lastResult);
  if (!editorResult.success || await page.locator('#status').textContent() !== 'Managed compilation succeeded') {
    throw new Error('Editing and Compile button did not produce a successful result');
  }
  record.editorCompile = { success: editorResult.success, bytes: Buffer.from(editorResult.pe, 'base64').length };
  writeFileSync('worker-test.json', JSON.stringify(record, null, 2));
  console.log(`PASS: Chromium ${record.browser}; three distinct managed PEs; error then recovery`);
} catch (error) {
  writeFileSync('worker-failure.json', JSON.stringify({error: String(error), errors, messages}, null, 2));
  throw error;
} finally {
  clearTimeout(watchdog);
  await browser.close();
}
