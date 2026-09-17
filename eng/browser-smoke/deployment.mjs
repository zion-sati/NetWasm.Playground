import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const url = process.env.PLAYGROUND_URL;
const output = process.env.PLAYGROUND_EVIDENCE;
if (!url || !output) throw Error('PLAYGROUND_URL and PLAYGROUND_EVIDENCE are required');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const requests = [];
const consoleErrors = [];
try {
  const page = await browser.newPage({ acceptDownloads: true });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', request => requests.push(request.url()));
  await page.goto(url);
  const pageContract = await page.evaluate(async () => {
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? '';
    const icons = [...document.querySelectorAll('link[rel="icon"]')].map(link => link.href);
    const statuses = await Promise.all(icons.map(async href => (await fetch(href)).status));
    const brandLink = document.querySelector('.brand > a');
    return { csp, icons, statuses, brandLink: brandLink ? { href: brandLink.href, text: brandLink.textContent } : null,
      brandText: document.querySelector('.brand')?.textContent };
  });
  if (!pageContract.csp.includes('https://static.cloudflareinsights.com') ||
      !pageContract.csp.includes('https://cloudflareinsights.com') || pageContract.icons.length !== 2 ||
      pageContract.statuses.some(status => status !== 200) || pageContract.brandLink?.href !== 'https://www.netwasm.com/' ||
      pageContract.brandLink?.text !== 'NetWasm' || pageContract.brandText !== 'NetWasm Playground')
    throw Error(`Page resource contract failed: ${JSON.stringify(pageContract)}`);
  await page.locator('.monaco-editor').waitFor();
  await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/toolchain/')));
  await page.waitForFunction(() => Number(document.querySelector('#toolchain-progress')?.dataset.totalBundles) > 0 &&
    Number(document.querySelector('#toolchain-progress')?.dataset.loadedBundleBytes) > 0);
  const preload = await page.evaluate(() => ({
    hidden: document.querySelector('#toolchain-progress').hidden,
    completed: Number(document.querySelector('#toolchain-progress').dataset.completedBundles),
    total: Number(document.querySelector('#toolchain-progress').dataset.totalBundles),
    loadedBytes: Number(document.querySelector('#toolchain-progress').dataset.loadedBundleBytes),
    totalBytes: Number(document.querySelector('#toolchain-progress').dataset.totalBundleBytes),
    barValue: Number(document.querySelector('#toolchain-progress-bar').value),
    barMax: Number(document.querySelector('#toolchain-progress-bar').max),
    detail: document.querySelector('#toolchain-progress-detail').textContent,
  }));
  if (preload.hidden || preload.completed >= preload.total || preload.loadedBytes <= 0 || preload.loadedBytes >= preload.totalBytes ||
      preload.barValue !== preload.loadedBytes || preload.barMax !== preload.totalBytes ||
      !preload.detail.includes(`of ${preload.total} bundles`) || !preload.detail.includes(' loaded'))
    throw Error(`Preload progress missing: ${JSON.stringify(preload)}`);
  if (!await page.locator('#compile').isEnabled() || !await page.locator('#run').isEnabled()) throw Error('Background preload disabled actions');
  await page.getByLabel('Optimization', { exact: true }).selectOption('none');
  await page.locator('#run').click();
  if (await page.locator('#compile').isEnabled() || await page.locator('#run').isEnabled()) throw Error('Busy controls remain enabled');
  await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 240000 });
  await page.locator('[data-toolchain-preload="complete"]').waitFor({ timeout: 240000 });
  const stdout = await page.locator('#output').textContent();
  const status = await page.locator('#status').textContent();
  if (stdout !== '42\n' || status !== 'Run complete') throw Error(`Browser run failed: ${status} ${JSON.stringify(stdout)}`);
  const event = page.waitForEvent('download');
  await page.locator('#download').click();
  const download = await event;
  if (download.suggestedFilename() !== 'program-none.wasm') throw Error('Unexpected download filename');
  const componentPath = `${output}/hello-none.wasm`;
  await download.saveAs(componentPath);
  const nativeStdout = execFileSync('wasmtime', [componentPath], { encoding: 'utf8' });
  if (nativeStdout !== stdout) throw Error('Wasmtime output differs from browser output');
  if (errors.length || consoleErrors.some(error => error.includes('Content Security Policy') || error.includes('favicon.ico')))
    throw Error(`Page errors: ${JSON.stringify({ errors, consoleErrors })}`);
  const toolchainRequests = [...new Set(requests.filter(request => request.includes('/toolchain/')).map(request => new URL(request).pathname))];
  const bundleRequests = toolchainRequests.filter(request => request.endsWith('.bin'));
  const expectedBundles = ['compiler.bin', 'guest.bin', 'linker.bin', 'tools.bin'];
  if (bundleRequests.map(request => request.slice(request.lastIndexOf('/') + 1)).sort().join(',') !== expectedBundles.join(','))
    throw Error(`Unexpected bundle requests: ${JSON.stringify(bundleRequests)}`);
  const directPayloads = toolchainRequests.filter(request => /\.(?:wasm|dll|a|dat|json)$/.test(request) &&
    !request.endsWith('/index.json') && !request.endsWith('/asset-manifest.json'));
  if (directPayloads.length || toolchainRequests.length > 20)
    throw Error(`Toolchain request graph was not bundled: ${JSON.stringify({ count: toolchainRequests.length, directPayloads })}`);
  const bytes = readFileSync(componentPath);
  const result = { passed: true, browser: browser.version(), stdout, status,
    component: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    toolchainRequests: { unique: toolchainRequests.length, bundles: bundleRequests }, pageContract, errors, consoleErrors };
  writeFileSync(`${output}/results.json`, JSON.stringify(result, null, 2));
  console.log('PASS: deployed browser compile/run/download and Wasmtime execution');
} finally {
  await browser.close();
}
