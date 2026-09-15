import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const inputs = JSON.parse(readFileSync('inputs.json', 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const browser = await chromium.launch({ headless: true });
const errors = [], results = [], downloads = [];
const watchdog = setTimeout(() => { void browser.close(); }, 360_000);
try {
  const page = await browser.newPage({ acceptDownloads: true });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(process.env.BROWSER_COMPONENT_URL);
  await page.evaluate(() => window.ready);
  for (const [index, source] of [inputs.source, inputs.source.replace('42', '43'),
    'using System; Console.WriteLine(;', inputs.source.replace('42', '44'),
    'using System; Console.WriteLine("nonzero"); return 1;',
    'using System; throw new Exception("guest trap");',
    'using System; Console.WriteLine("loop started"); while (true) {}',
    inputs.source.replace('42', '45')].entries()) {
    await page.locator('#source').fill(source);
    await page.locator('#run').click();
    if (index === 6) {
      await page.waitForFunction(() => window.guestEntered && document.querySelector('#stdout').textContent.includes('loop started'), undefined, { timeout: 120_000 });
      await page.locator('#stop').click();
    }
    await page.waitForFunction(() => window.lastComponentResult !== undefined, undefined, { timeout: 120_000 });
    const result = await page.evaluate(() => window.lastComponentResult);
    if (result.component) {
      const bytes = Buffer.from(result.component); delete result.component;
      result.componentBytes = bytes.length; result.componentSha256 = hash(bytes);
      writeFileSync(`component-${index}.wasm`, bytes);
      const downloadPromise = page.waitForEvent('download');
      await page.locator('#download').click();
      const download = await downloadPromise;
      const filename = `download-${index}.wasm`; await download.saveAs(filename);
      const downloaded = readFileSync(filename);
      if (hash(downloaded) !== result.componentSha256) throw new Error('Downloaded component differs from executed bytes');
      downloads.push({ index, name: download.suggestedFilename(), bytes: downloaded.length, sha256: hash(downloaded) });
    }
    results.push(result);
    writeFileSync('browser-test.json', JSON.stringify({ browser: browser.version(), results, downloads, errors }, null, 2));
    if (index === 2 && await page.locator('#download').isVisible()) throw new Error('Stale download remains after failure');
  }
  if (![0, 1, 3, 7].every(index => results[index].success && results[index].exitCode === 0 &&
      results[index].stderr === '' && results[index].loaded.length === 4 && results[index].graph.length === 5 &&
      results[index].providedArguments.length === 0) ||
      results[0].stdout !== '42\n' || results[1].stdout !== '43\n' || results[3].stdout !== '44\n' ||
      results[2].success || results[2].componentBytes !== undefined ||
      results[0].componentSha256 !== inputs.desktopComponent.sha256 ||
      results[0].componentSha256 === results[1].componentSha256 || results[1].componentSha256 === results[3].componentSha256 ||
      !results[4].success || results[4].exitCode !== 1 || results[4].stdout !== 'nonzero\n' ||
      results[5].success || results[5].code !== 'guest-trap' ||
      results[6].success || results[6].stage !== 'cancelled' || results[7].stdout !== '45\n' || errors.length) {
    throw new Error('Actual browser component/run/download/edit/failure/recovery assertion failed');
  }
  writeFileSync('browser-test.json', JSON.stringify({ passed: true, browser: browser.version(), results, downloads, errors }, null, 2));
  console.log('PASS: actual C# component executes in guest worker, edits change stdout, downloads match executed bytes, syntax failure recovers');
} finally { clearTimeout(watchdog); await browser.close(); }
