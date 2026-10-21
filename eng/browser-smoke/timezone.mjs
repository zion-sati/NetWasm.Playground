import { closeSettings, openSample, openSettings, setOptimizations } from './playground-ui.mjs';
import { chromium, firefox, webkit } from 'playwright';

const engines = { chromium, firefox, webkit };
const selected = (process.env.PLAYGROUND_BROWSERS ?? 'chromium').split(',');
const url = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/';
const zone = 'Australia/Melbourne';
const dataPath = /\/timezones\/netwasm-timezones\.[0-9a-f]{64}\.bin$/;

async function run(page, label, example) {
  await openSample(page, example);
  await page.locator('#run').click();
  await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 240_000 });
  const status = await page.locator('#status').textContent();
  const output = await page.locator('#output').textContent();
  if (status !== 'Run complete') throw Error(`${label}/${example}: ${JSON.stringify({ status, output })}`);
  return output;
}

function readLocalTime(label, output, expectedZone, offsets) {
  const reportedZone = output.match(/Time zone: (\S+)/)?.[1];
  const now = output.match(/DateTime\.Now: (\S+)/)?.[1];
  if (reportedZone !== expectedZone || !offsets.some(offset => now?.endsWith(offset)) ||
      Math.abs(Date.parse(now) - Date.now()) > 120_000)
    throw Error(`${label}: expected local time in ${expectedZone}: ${output}`);
}

for (const name of selected) {
  const engine = engines[name];
  if (!engine) throw Error(`Unknown browser: ${name}`);
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ timezoneId: zone });
    const page = await context.newPage();
    const pageErrors = [];
    const dataRequests = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => { if (dataPath.test(new URL(request.url()).pathname)) dataRequests.push(request.url()); });
    await page.goto(url);
    await setOptimizations(page, 'none');

    await run(page, name, 'hello');
    if (dataRequests.length !== 0) throw Error(`${name}: a program without local time downloaded time zone data`);

    readLocalTime(`${name}/${zone}`, await run(page, name, 'datetime'), zone, ['+10:00', '+11:00']);
    if (dataRequests.length !== 1) throw Error(`${name}: expected one time zone data download, saw ${dataRequests.length}`);

    await openSettings(page);
    await page.locator('#time-zone').selectOption('UTC');
    await closeSettings(page);
    readLocalTime(`${name}/UTC`, await run(page, name, 'datetime'), 'UTC', ['+00:00', 'Z']);
    if (dataRequests.length !== 1) throw Error(`${name}: UTC downloaded time zone data`);

    await page.reload();
    if (await page.locator('#time-zone').inputValue() !== 'UTC') throw Error(`${name}: the time zone setting did not persist`);
    if (pageErrors.length) throw Error(`${name}: ${pageErrors.join('\n')}`);
    console.log(`PASS ${name}: ${zone} local time, one data download, UTC without data, setting persisted`);
  } finally {
    await browser.close();
  }
}
