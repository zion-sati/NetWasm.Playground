import { chromium } from 'playwright';

const base = process.argv[2] ?? process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.route('**/toolchain/**', route => route.abort());
  await page.route('https://www.netwasm.com/', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>NetWasm</title><h1>NetWasm</h1>',
  }));

  await page.goto(base);
  const editor = page.locator('#editor .view-lines');
  await editor.waitFor();
  await page.waitForFunction(() => document.querySelector('#editor .view-lines')?.textContent?.includes('Console.WriteLine(42)'));
  await page.locator('.brand > a').click();
  await page.getByRole('heading', { name: 'NetWasm', exact: true }).waitFor();
  await page.goBack();
  await page.locator('.monaco-editor').waitFor();

  // Chromium automation does not consistently retain cross-origin pages in
  // BFCache, so exercise the persisted lifecycle events deterministically too.
  await page.evaluate(() => {
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });

  await page.getByLabel('Example', { exact: true }).selectOption('regex');
  await page.waitForFunction(() => document.querySelector('#editor .view-lines')?.textContent?.includes('Regex'));
  const restored = await page.evaluate(() => ({
    source: document.querySelector('#editor .view-lines')?.textContent ?? '',
    width: document.querySelector('#editor .monaco-editor')?.getBoundingClientRect().width ?? 0,
    height: document.querySelector('#editor .monaco-editor')?.getBoundingClientRect().height ?? 0,
  }));
  if (!restored.source.includes('Regex') || restored.width <= 0 || restored.height <= 0)
    throw Error(`Editor did not render after back navigation: ${JSON.stringify(restored)}`);
  if (pageErrors.length) throw Error(`Browser errors: ${pageErrors.join('\n')}`);
  console.log('PASS: editor renders and responds after browser back navigation');
} finally {
  await browser.close();
}
