import { openSample } from './playground-ui.mjs';
import { browserType } from './engine.mjs';

const base = process.argv[2] ?? process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/';
const browser = await browserType.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const workerUrls = [];
  const failedRequests = [];
  const serviceWorkerUrls = [];
  let phase = 'startup';
  page.on('worker', worker => workerUrls.push(worker.url()));
  page.context().on('serviceworker', worker => serviceWorkerUrls.push(worker.url()));
  page.on('requestfailed', request => failedRequests.push({ phase, url: request.url(), type: request.resourceType(), failure: request.failure() }));
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push({ phase, message: String(error), stack: error.stack ?? '' }));
  await page.route('**/toolchain/**', route => route.abort());
  await page.route('https://www.netwasm.com/', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>NetWasm</title><h1>NetWasm</h1>',
  }));

  await page.goto(base);
  phase = 'initial-editor';
  const editor = page.locator('#editor .view-lines');
  await editor.waitFor();
  await page.waitForFunction(() => document.querySelector('#editor .view-lines')?.textContent?.includes('Console.WriteLine(42)'));
  phase = 'navigate-away';
  await page.locator('.brand > a').click();
  phase = 'destination';
  await page.getByRole('heading', { name: 'NetWasm', exact: true }).waitFor();
  phase = 'navigate-back';
  await page.goBack();
  phase = 'restored-editor';
  await page.locator('.monaco-editor').waitFor();

  // Chromium automation does not consistently retain cross-origin pages in
  // BFCache, so exercise the persisted lifecycle events deterministically too.
  phase = 'persisted-lifecycle';
  await page.evaluate(() => {
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });

  await openSample(page, 'regex');
  await page.waitForFunction(() => document.querySelector('#editor .view-lines')?.textContent?.includes('Regex'));
  const restored = await page.evaluate(() => ({
    source: document.querySelector('#editor .view-lines')?.textContent ?? '',
    width: document.querySelector('#editor .monaco-editor')?.getBoundingClientRect().width ?? 0,
    height: document.querySelector('#editor .monaco-editor')?.getBoundingClientRect().height ?? 0,
  }));
  if (!restored.source.includes('Regex') || restored.width <= 0 || restored.height <= 0)
    throw Error(`Editor did not render after back navigation: ${JSON.stringify(restored)}`);
  if (pageErrors.length) {
    throw Error(`Browser errors: ${JSON.stringify(pageErrors)}\nFailed requests: ${JSON.stringify(failedRequests)}\nWorkers: ${JSON.stringify(workerUrls)}\nService workers: ${JSON.stringify(serviceWorkerUrls)}`);
  }
  console.log('PASS: editor renders and responds after browser back navigation');
} finally {
  await browser.close();
}
