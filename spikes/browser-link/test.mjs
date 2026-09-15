import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const inputs = JSON.parse(readFileSync('inputs.json', 'utf8'));
const browser = await chromium.launch({ headless: true });
const errors = [], results = [];
const watchdog = setTimeout(() => { void browser.close(); }, 240_000);
try {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(process.env.BROWSER_LINK_URL);
  await page.evaluate(() => window.ready);
  const requests = [
    { source: inputs.source }, { source: inputs.source.replace('42', '43') },
    { source: 'using System; Console.WriteLine(;' },
    { source: inputs.source.replace('42', '44') },
    { source: inputs.source, invalid: true }, { source: inputs.source },
  ];
  for (const request of requests) {
    const result = await page.evaluate(request => window.link(request.source, request.invalid), request);
    if (result.linked) {
      const bytes = Buffer.from(result.linked); delete result.linked;
      result.linkedBytes = bytes.length;
      result.linkedSha256 = createHash('sha256').update(bytes).digest('hex');
      writeFileSync(`linked-${results.length}.wasm`, bytes);
    }
    results.push(result);
    writeFileSync('browser-test.json', JSON.stringify({ browser: browser.version(), results, errors }, null, 2));
  }
  if (![0, 1, 3, 5].every(index => results[index].success) || results[2].success || results[4].success ||
      results[2].stage !== 'roslyn' || results[4].stage !== 'runtime-link' ||
      results[2].linkedBytes !== undefined || results[4].linkedBytes !== undefined ||
      results[0].linkedSha256 === results[1].linkedSha256 || results[1].linkedSha256 === results[3].linkedSha256 ||
      results[0].linkedSha256 !== results[5].linkedSha256 || errors.length) {
    throw new Error('Browser five-module link, changed source or failure recovery assertion failed');
  }
  await page.evaluate(() => window.stop());
  writeFileSync('browser-test.json', JSON.stringify({ passed: true, browser: browser.version(), results, errors }, null, 2));
  console.log('PASS: actual browser C# runtime link, generated adapters, five-module merge, export pruning, Release optimization and validation');
} finally { clearTimeout(watchdog); await browser.close(); }
