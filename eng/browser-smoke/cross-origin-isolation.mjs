import { mkdirSync, writeFileSync } from 'node:fs';
import { browserName, browserType } from './engine.mjs';

const url = process.env.PLAYGROUND_URL;
const output = process.env.PLAYGROUND_EVIDENCE;
if (!url || !output) throw Error('PLAYGROUND_URL and PLAYGROUND_EVIDENCE are required');
mkdirSync(output, { recursive: true });

const browser = await browserType.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const navigations = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  const response = await page.goto(url);
  if (!response?.ok()) throw Error(`Playground navigation failed: ${response?.status()}`);
  // The activating worker claims the first page immediately before the
  // isolation bootstrap reloads it. Wait through that short intermediate
  // state: sampling the page while its reload guard is still set makes a valid
  // two-navigation startup look like a failed bootstrap.
  await page.waitForFunction(() => crossOriginIsolated &&
    typeof SharedArrayBuffer === 'function' && navigator.serviceWorker.controller &&
    sessionStorage.getItem('netwasm-coi-reload-v1') === null,
  undefined, { timeout: 30_000 });
  const state = await page.evaluate(() => ({
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    controlled: !!navigator.serviceWorker.controller,
    reloadMarker: sessionStorage.getItem('netwasm-coi-reload-v1'),
  }));
  if (!state.crossOriginIsolated || !state.sharedArrayBuffer || !state.controlled ||
      state.reloadMarker !== null || navigations.length > 2 || errors.length)
    throw Error(JSON.stringify({ state, navigations, errors }));
  const result = { passed: true, browser: browserName, ...state,
    navigations: navigations.length, errors };
  writeFileSync(`${output}/results.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(`PASS: ${browserName} established cross-origin isolation in ${navigations.length} navigation(s)`);
} finally {
  await browser.close();
}
