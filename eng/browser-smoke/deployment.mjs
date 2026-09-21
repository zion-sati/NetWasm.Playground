import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const url = process.env.PLAYGROUND_URL;
const output = process.env.PLAYGROUND_EVIDENCE;
if (!url || !output) throw Error('PLAYGROUND_URL and PLAYGROUND_EVIDENCE are required');
const playgroundVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version;
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const requests = [];
const consoleErrors = [];
const bundleStarts = new Map();
const bundleResponses = new Map();
let resolveBundleStarts;
const bundlesStarted = new Promise(resolve => { resolveBundleStarts = resolve; });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', request => {
    requests.push(request.url());
    const name = new URL(request.url()).pathname.split('/').at(-1);
    if (name?.endsWith('.bin') && !bundleStarts.has(name)) {
      bundleStarts.set(name, Date.now());
      if (bundleStarts.size === 4) resolveBundleStarts();
    }
  });
  page.on('response', response => {
    const name = new URL(response.url()).pathname.split('/').at(-1);
    if (name?.endsWith('.bin')) {
      const headers = response.headers();
      bundleResponses.set(name, {
        status: response.status(),
        cacheControl: headers['cache-control'] ?? null,
        cfCacheStatus: headers['cf-cache-status'] ?? null,
        age: headers.age ?? null,
        contentEncoding: headers['content-encoding'] ?? null,
      });
    }
  });
  await page.goto(url);
  const toolchainManifest = await page.evaluate(async () => {
    const base = new URL('toolchain/', location.href);
    const index = await (await fetch(new URL('index.json', base), { cache: 'no-cache' })).json();
    return (await fetch(new URL(`${index.id}/asset-manifest.json`, base), { cache: 'force-cache' })).json();
  });
  if (toolchainManifest.schemaVersion !== 3 ||
      Object.keys(toolchainManifest.bundles).sort().join(',') !== 'compiler,guest,linker,tools')
    throw Error(`Unexpected toolchain manifest: ${JSON.stringify(toolchainManifest.bundles)}`);
  for (const [role, receipt] of Object.entries(toolchainManifest.bundles)) {
    if (receipt.path !== `bundles/${role}.${receipt.sha256}.bin` || !/^[a-f0-9]{64}$/.test(receipt.sha256))
      throw Error(`Bundle is not content addressed: ${JSON.stringify({ role, receipt })}`);
  }
  await page.setViewportSize({ width: 780, height: 900 });
  const toolbarLayout = await page.evaluate(() => {
    const toolbar = document.querySelector('.toolbar');
    const controls = [...document.querySelectorAll('.actions button')].map(button => {
      const box = button.getBoundingClientRect();
      return { id: button.id, left: box.left, right: box.right, width: box.width };
    });
    return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      toolbar: toolbar ? { clientWidth: toolbar.clientWidth, scrollWidth: toolbar.scrollWidth } : null, controls };
  });
  if (!toolbarLayout.toolbar || toolbarLayout.scrollWidth > toolbarLayout.viewport ||
      toolbarLayout.toolbar.scrollWidth > toolbarLayout.toolbar.clientWidth ||
      toolbarLayout.controls.length !== 4 || toolbarLayout.controls.some(control =>
        control.width <= 0 || control.left < 0 || control.right > toolbarLayout.viewport))
    throw Error(`Responsive toolbar overflow: ${JSON.stringify(toolbarLayout)}`);
  await page.screenshot({ path: `${output}/responsive-toolbar.png`, fullPage: false });
  await page.setViewportSize({ width: 1280, height: 900 });
  const pageContract = await page.evaluate(async () => {
    const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? '';
    const icons = [...document.querySelectorAll('link[rel="icon"]')].map(link => link.href);
    const statuses = await Promise.all(icons.map(async href => (await fetch(href)).status));
    const brandLink = document.querySelector('.brand > a');
    return { csp, icons, statuses, brandLink: brandLink ? { href: brandLink.href, text: brandLink.textContent } : null,
      brandText: document.querySelector('.brand')?.textContent,
      version: document.querySelector('#playground-version')?.textContent };
  });
  if (!pageContract.csp.includes('https://static.cloudflareinsights.com') ||
      !pageContract.csp.includes('https://cloudflareinsights.com') || pageContract.icons.length !== 2 ||
      pageContract.statuses.some(status => status !== 200) || pageContract.brandLink?.href !== 'https://www.netwasm.com/' ||
      pageContract.brandLink?.text !== 'NetWasm' || pageContract.brandText !== `NetWasm Playgroundv${playgroundVersion}` ||
      pageContract.version !== `v${playgroundVersion}`)
    throw Error(`Page resource contract failed: ${JSON.stringify(pageContract)}`);
  await page.locator('.monaco-editor').waitFor();
  await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/toolchain/')));
  await Promise.race([
    bundlesStarted,
    page.waitForTimeout(30000).then(() => { throw Error(`Bundle requests did not start together: ${JSON.stringify([...bundleStarts])}`); }),
  ]);
  const bundleStartSpreadMs = Math.max(...bundleStarts.values()) - Math.min(...bundleStarts.values());
  if (bundleStartSpreadMs > 1000) throw Error(`Bundle requests were serialized: ${JSON.stringify([...bundleStarts])}`);
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
  const partialProgress = !preload.hidden && preload.completed < preload.total &&
    preload.loadedBytes > 0 && preload.loadedBytes < preload.totalBytes;
  const completedProgress = preload.completed === preload.total &&
    preload.loadedBytes === preload.totalBytes && preload.totalBytes > 0;
  if ((!partialProgress && !completedProgress) || preload.barValue !== preload.loadedBytes ||
      preload.barMax !== preload.totalBytes || !preload.detail.includes(`of ${preload.total} bundles`) ||
      !preload.detail.includes(' loaded'))
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
  const expectedBundles = Object.values(toolchainManifest.bundles).map(receipt => receipt.path).sort();
  if (bundleRequests.map(request => request.slice(request.indexOf('/bundles/') + 1)).sort().join(',') !== expectedBundles.join(','))
    throw Error(`Unexpected bundle requests: ${JSON.stringify(bundleRequests)}`);
  const directPayloads = toolchainRequests.filter(request => /\.(?:wasm|dll|a|dat|json)$/.test(request) &&
    !request.endsWith('/index.json') && !request.endsWith('/asset-manifest.json'));
  // The separately bundled Preview 2 guest provider adds one verified module request.
  if (directPayloads.length || toolchainRequests.length > 21)
    throw Error(`Toolchain request graph was not bundled: ${JSON.stringify({ count: toolchainRequests.length, directPayloads })}`);
  const bytes = readFileSync(componentPath);
  const result = { passed: true, browser: browser.version(), stdout, status,
    component: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    toolchainRequests: { unique: toolchainRequests.length, bundles: bundleRequests, parallelStartSpreadMs: bundleStartSpreadMs,
      responses: Object.fromEntries(bundleResponses) }, toolbarLayout, pageContract, errors, consoleErrors };
  writeFileSync(`${output}/results.json`, JSON.stringify(result, null, 2));
  console.log('PASS: deployed browser compile/run/download and Wasmtime execution');
} finally {
  await browser.close();
}
