import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const url = process.env.PLAYGROUND_URL;
if (!url) throw new Error('PLAYGROUND_URL is required');
const output = process.env.PLAYGROUND_EVIDENCE || '.';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [], requests = [], results = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
try {
  const page = await browser.newPage({ acceptDownloads: true });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
  await page.goto(url);
  await page.locator('.monaco-editor').waitFor();
  assert(!requests.some(request => request.url.includes('/toolchain/')), 'Toolchain fetched before first action');
  await page.screenshot({ path: `${output}/desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile page overflows');
  await page.screenshot({ path: `${output}/mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  async function source(text) {
    await page.locator('#editor .view-lines').click({ position: { x: 80, y: 12 } });
    await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(text);
  }
  async function finish() { await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 180_000 }); }
  async function run(text) { await source(text); await page.locator('#run').click(); await finish(); const result = await page.locator('#output').textContent(); results.push({ source: text, stdout: result, status: await page.locator('#status').textContent() }); writeFileSync(`${output}/partial.json`, JSON.stringify({results,errors},null,2)); return result; }
  assert(await run('using System;\n\nConsole.WriteLine(42);\n') === '42\n', 'Hello actual output');
  const downloadEvent = page.waitForEvent('download'); await page.locator('#download').click();
  await (await downloadEvent).saveAs(`${output}/hello.wasm`);
  const component = readFileSync(`${output}/hello.wasm`);
  assert(hash(component) === 'dc433ef969973d37b0ff8a3a9acf66bba4fa071b78f09359d4dc0836021baa17', 'Configured component equality');
  await source('using System; Console.WriteLine(11);'); await page.locator('#compile').click();
  await source('using System; Console.WriteLine(12);'); await page.locator('#run').click();
  await source('using System; Console.WriteLine(13);'); await page.locator('#run').click();
  assert(await page.locator('#download').isDisabled(), 'Edit did not invalidate download');
  await page.waitForFunction(() => document.querySelector('#output').textContent === '13\n' && document.querySelector('#stop').disabled, undefined, { timeout: 180_000 });
  await run('using System; Console.WriteLine(;');
  assert(await page.locator('#download').isDisabled(), 'Syntax failure retains download');
  assert(await page.locator('#diagnostics .diagnostic').count() > 0, 'Missing diagnostics');
  await page.locator('#diagnostics .diagnostic').first().click();
  assert(await run('using System; Console.WriteLine("before"); throw new Exception();') === 'before\n', 'Print-before-trap output lost');
  assert((await page.locator('#status').textContent()).includes('unreachable'), 'Trap missing');
  assert(await page.locator('#download').isEnabled(), 'Valid trap component download lost');
  await source('using System; Console.WriteLine("loop started"); while(true) {}'); await page.locator('#run').click();
  await page.waitForFunction(() => document.querySelector('#output').textContent.includes('loop started'), undefined, { timeout: 180_000 });
  await page.locator('#stop').click(); await finish();
  assert(await run('using System; Console.WriteLine(44);') === '44\n', 'Stop recovery failed');
  // Enter an actual compiler stage with a deliberately short deadline, then reuse the channel.
  const timeoutRecovery = await page.evaluate(async () => {
    const { WorkerChannel } = await import(`${new URL('.', location.href).pathname}src/worker-channel.ts`);
    const index = await (await fetch('./toolchain/index.json')).json();
    const workerUrl = new URL(`./toolchain/${index.id}/workers/compiler-worker.mjs`, location.href);
    const entered = [];
    const channel = new WorkerChannel(workerUrl, data => { if(data.stage) entered.push(data.stage); });
    let timedOut = false;
    try { await channel.request({ operation: 'compile', recipe: 'hello', source: 'using System; Console.WriteLine(42);' }, [], 1); }
    catch (error) { timedOut = String(error).includes('timeout'); }
    try {
      await channel.request({ operation: 'initialize' }); entered.length = 0;
      let compileTimedOut = false;
      try { await channel.request({ operation: 'compile', recipe: 'hello', source: 'using System; Console.WriteLine(42);' }, [], 50); }
      catch(error) { compileTimedOut = String(error).includes('timeout'); }
      const compileEntered = entered.includes('roslyn');
      const result = await channel.request({ operation: 'compile', recipe: 'hello', source: 'using System; Console.WriteLine(42);' });
      return { timedOut, compileTimedOut, compileEntered, success: result.success, bytes: result.application?.length };
    }
    finally { channel.reset(); }
  });
  assert(timeoutRecovery.timedOut && timeoutRecovery.compileTimedOut && timeoutRecovery.compileEntered && timeoutRecovery.success && timeoutRecovery.bytes > 0, 'Stage timeout recovery failed');
  assert(errors.length === 0, `Browser errors: ${errors.join('\n')}`);
  assert(requests.every(request => request.method === 'GET' && !request.body), 'Source sent over network');
  await page.screenshot({ path: `${output}/completed.png`, fullPage: true });
  writeFileSync(`${output}/browser-test.json`, JSON.stringify({ passed: true, browser: browser.version(), results, timeoutRecovery, component: { bytes: component.length, sha256: hash(component) }, requests, errors }, null, 2));
  console.log('PASS: editor-first, nested base, actual component, queue/stale/edit, diagnostics, print-before-trap, Stop and stage timeout recovery');
} finally { await browser.close(); }
