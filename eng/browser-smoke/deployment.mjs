import { browserType } from './engine.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expectedSiteIdentity } from '../site-identity.mjs';
import { observeSiteIdentity } from './site-identity.mjs';

const url = process.env.PLAYGROUND_URL;
const output = process.env.PLAYGROUND_EVIDENCE;
if (!url || !output) throw Error('PLAYGROUND_URL and PLAYGROUND_EVIDENCE are required');
const expectedIdentity = expectedSiteIdentity();
const playgroundVersion = process.env.EXPECTED_PLAYGROUND_VERSION ??
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(playgroundVersion))
  throw Error('Invalid expected Playground version');
mkdirSync(output, { recursive: true });
const browser = await browserType.launch({ headless: true });
const errors = [];
const requests = [];
const consoleErrors = [];
const optionalTelemetry = /\/cdn-cgi\/rum(?:[/?]|$)/i;
const bundleStarts = new Map();
const bundleResponses = new Map();
let resolveBundleStarts;
const bundlesStarted = new Promise(resolve => { resolveBundleStarts = resolve; });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url });
  });
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
        age: headers.age ?? null,
        contentEncoding: headers['content-encoding'] ?? null,
      });
    }
  });
  const initialNavigation = await page.goto(url, { waitUntil: 'commit' });
  if (!initialNavigation?.ok()) throw Error(`Playground navigation failed: ${initialNavigation?.status()}`);
  await page.waitForFunction(() => crossOriginIsolated, undefined, { timeout: 30_000 });
  const initialSiteIdentity = await observeSiteIdentity(page, url, expectedIdentity);
  const toolchainManifest = initialSiteIdentity.toolchainManifest;
  if (toolchainManifest.schemaVersion !== 3 ||
      Object.keys(toolchainManifest.bundles).sort().join(',') !== 'compiler,guest,linker,tools')
    throw Error(`Unexpected toolchain manifest: ${JSON.stringify(toolchainManifest.bundles)}`);
  for (const [role, receipt] of Object.entries(toolchainManifest.bundles)) {
    if (receipt.path !== `bundles/${role}.${receipt.sha256}.bin` || !/^[a-f0-9]{64}$/.test(receipt.sha256))
      throw Error(`Bundle is not content addressed: ${JSON.stringify({ role, receipt })}`);
  }
  const inspectToolbar = () => page.evaluate(() => {
    const toolbar = document.querySelector('.toolbar');
    const options = document.querySelector('.options');
    const optionControls = [...document.querySelectorAll('.options > *:not([hidden])')].map(control => {
      const box = control.getBoundingClientRect();
      return { id: control.id, className: control.className, left: box.left, right: box.right, width: box.width };
    });
    const controls = [...document.querySelectorAll('.actions button')].map(button => {
      const box = button.getBoundingClientRect();
      return { id: button.id, left: box.left, right: box.right, width: box.width };
    });
    return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      toolbar: toolbar ? { left: toolbar.getBoundingClientRect().left, right: toolbar.getBoundingClientRect().right,
        clientWidth: toolbar.clientWidth, scrollWidth: toolbar.scrollWidth } : null,
      options: options ? { left: options.getBoundingClientRect().left, right: options.getBoundingClientRect().right,
        clientWidth: options.clientWidth, scrollWidth: options.scrollWidth } : null, optionControls, controls };
  });
  const assertToolbar = toolbarLayout => {
    const subpixelTolerance = 0.5;
    if (!toolbarLayout.toolbar || !toolbarLayout.options || toolbarLayout.scrollWidth > toolbarLayout.viewport ||
        toolbarLayout.toolbar.scrollWidth > toolbarLayout.toolbar.clientWidth ||
        toolbarLayout.optionControls.some(control => control.width <= 0 ||
          control.left < toolbarLayout.options.left - subpixelTolerance ||
          control.right > toolbarLayout.options.right + subpixelTolerance) ||
        toolbarLayout.controls.length !== 4 || toolbarLayout.controls.some(control =>
          control.width <= 0 || control.left < toolbarLayout.toolbar.left - subpixelTolerance ||
          control.right > toolbarLayout.toolbar.right + subpixelTolerance))
      throw Error(`Responsive toolbar overflow: ${JSON.stringify(toolbarLayout)}`);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel('Example', { exact: true }).selectOption('csharp15-tour');
  await page.getByLabel('Language', { exact: true }).selectOption('preview');
  const intermediateToolbarLayout = await inspectToolbar();
  assertToolbar(intermediateToolbarLayout);
  const memorySafetyLink = page.locator('#memory-safety-setting a');
  if (!await memorySafetyLink.isVisible() ||
      await memorySafetyLink.getAttribute('href') !== 'https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/unsafe-evolution')
    throw Error('Updated memory-safety documentation link is missing');
  await page.screenshot({ path: `${output}/responsive-toolbar-intermediate.png`, fullPage: false });
  await page.setViewportSize({ width: 780, height: 900 });
  const toolbarLayout = await inspectToolbar();
  await page.screenshot({ path: `${output}/responsive-toolbar.png`, fullPage: false });
  assertToolbar(toolbarLayout);
  await page.getByLabel('Example', { exact: true }).selectOption('hello');
  await page.getByLabel('Language', { exact: true }).selectOption('15');
  await page.setViewportSize({ width: 1280, height: 900 });
  const pageContract = await page.evaluate(async () => {
    const icons = [...document.querySelectorAll('link[rel="icon"]')].map(link => link.href);
    const statuses = await Promise.all(icons.map(async href => (await fetch(href)).status));
    const brandLink = document.querySelector('.brand > a');
    return { icons, statuses, brandLink: brandLink ? { href: brandLink.href, text: brandLink.textContent } : null,
      brandText: document.querySelector('.brand')?.textContent,
      version: document.querySelector('#playground-version')?.textContent };
  });
  if (pageContract.icons.length !== 2 ||
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
  await page.waitForFunction(() => {
    const progress = document.querySelector('#toolchain-progress');
    const completed = Number(progress?.dataset.completedBundles);
    const total = Number(progress?.dataset.totalBundles);
    const loadedBytes = Number(progress?.dataset.loadedBundleBytes);
    const totalBytes = Number(progress?.dataset.totalBundleBytes);
    const partialProgress = completed < total && loadedBytes > 0 && loadedBytes < totalBytes;
    const completedProgress = completed === total && loadedBytes === totalBytes && totalBytes > 0;
    return total > 0 && (partialProgress || completedProgress);
  });
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
  const assetSummary = await page.locator('#assets').textContent();
  if (stdout !== '42\n' || status !== 'Run complete') throw Error(`Browser run failed: ${status} ${JSON.stringify(stdout)}`);
  const assetSizes = assetSummary?.match(/^Tool assets: ([\d,]+) bytes Brotli-11 · ([\d,]+) bytes uncompressed$/);
  if (!assetSizes || Number(assetSizes[1].replaceAll(',', '')) >= Number(assetSizes[2].replaceAll(',', '')))
    throw Error(`Tool asset compression receipt was not displayed: ${assetSummary}`);
  const event = page.waitForEvent('download');
  await page.locator('#download').click();
  const download = await event;
  if (download.suggestedFilename() !== 'program-none.wasm') throw Error('Unexpected download filename');
  const componentPath = `${output}/hello-none.wasm`;
  await download.saveAs(componentPath);
  const nativeStdout = execFileSync('wasmtime', [componentPath], { encoding: 'utf8' });
  if (nativeStdout !== stdout) throw Error('Wasmtime output differs from browser output');
  const applicationErrors = errors.filter(error => !optionalTelemetry.test(error));
  const applicationConsoleErrors = consoleErrors.filter(error => !optionalTelemetry.test(`${error.text} ${error.url}`));
  if (applicationErrors.length || applicationConsoleErrors.some(error =>
    error.text.includes('Content Security Policy') || error.text.includes('favicon.ico')))
    throw Error(`Page errors: ${JSON.stringify({ applicationErrors, applicationConsoleErrors })}`);
  const toolchainRequests = [...new Set(requests.filter(request => request.includes('/toolchain/')).map(request => new URL(request).pathname))];
  const bundleRequests = toolchainRequests.filter(request => request.endsWith('.bin'));
  const expectedBundles = Object.values(toolchainManifest.bundles).map(receipt => receipt.path).sort();
  if (bundleRequests.map(request => request.slice(request.indexOf('/bundles/') + 1)).sort().join(',') !== expectedBundles.join(','))
    throw Error(`Unexpected bundle requests: ${JSON.stringify(bundleRequests)}`);
  const directPayloads = toolchainRequests.filter(request => /\.(?:wasm|dll|a|dat|json)$/.test(request) &&
    !request.endsWith('/index.json') && !request.endsWith('/asset-manifest.json'));
  // The separately bundled Preview 2 guest provider and component host add two
  // verified module requests outside the four payload bundles.
  if (directPayloads.length || toolchainRequests.length > 22)
    throw Error(`Toolchain request graph was not bundled: ${JSON.stringify({ count: toolchainRequests.length, directPayloads })}`);
  const finalUrl = new URL(url);
  finalUrl.searchParams.set('site-identity', expectedIdentity.siteIdentitySha256);
  const finalNavigation = await page.goto(finalUrl.href, { waitUntil: 'commit' });
  if (!finalNavigation?.ok()) throw Error(`Playground reload failed: ${finalNavigation?.status()}`);
  await page.waitForFunction(() => crossOriginIsolated, undefined, { timeout: 30_000 });
  const finalSiteIdentity = await observeSiteIdentity(page, url, expectedIdentity);
  const bytes = readFileSync(componentPath);
  const result = { passed: true, browser: browser.version(), stdout, status,
    component: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    siteIdentity: { sha256: finalSiteIdentity.siteIdentitySha256,
      sourceCommit: finalSiteIdentity.identity.sourceCommit,
      indexHtmlSha256: finalSiteIdentity.identity.indexHtmlSha256,
      toolchainId: finalSiteIdentity.index.id,
      toolchainManifestSha256: finalSiteIdentity.toolchainManifestSha256 },
    toolchainRequests: { unique: toolchainRequests.length, bundles: bundleRequests, parallelStartSpreadMs: bundleStartSpreadMs,
      responses: Object.fromEntries(bundleResponses) }, toolbarLayout, pageContract, errors, consoleErrors };
  result.assetSummary = assetSummary;
  writeFileSync(`${output}/results.json`, JSON.stringify(result, null, 2));
  console.log('PASS: deployed browser compile/run/download and Wasmtime execution');
} finally {
  await browser.close();
}
