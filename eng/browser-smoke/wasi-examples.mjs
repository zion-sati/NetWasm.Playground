import { chromium, firefox, webkit } from 'playwright';

const engines = { chromium, firefox, webkit };
const selected = (process.env.PLAYGROUND_BROWSERS ?? 'chromium').split(',');
const url = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/';

for (const name of selected) {
  const engine = engines[name];
  if (!engine) throw Error(`Unknown browser: ${name}`);
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    const sampleRequests = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => {
      if (new URL(request.url()).pathname.endsWith('/example-http.json'))
        sampleRequests.push({ url: request.url(), method: request.method(), body: request.postData() });
    });
    await page.goto(url);
    await page.locator('#optimization').selectOption('none');

    for (const example of ['datetime', 'http']) {
      await page.locator('#example').selectOption(example);
      await page.locator('#run').click();
      if (!await page.locator('#compile').isDisabled() || !await page.locator('#run').isDisabled())
        throw Error(`${name}/${example}: busy controls stayed enabled`);
      await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 240_000 });
      const status = await page.locator('#status').textContent();
      const output = await page.locator('#output').textContent();
      const diagnostics = await page.locator('#diagnostics').textContent();
      if (status !== 'Run complete' || diagnostics !== 'No diagnostics.')
        throw Error(`${name}/${example}: ${JSON.stringify({ status, output, diagnostics })}`);
      if (example === 'datetime') {
        const now = output.match(/DateTime\.Now \(UTC\): (\S+)/)?.[1];
        const utc = output.match(/UtcNow: (\S+)/)?.[1];
        if (!output.includes('Playground timezone: UTC (no timezone data supplied)') ||
            !now?.endsWith('+00:00') || !utc?.endsWith('Z') ||
            Math.abs(Date.parse(now) - Date.now()) > 120_000 ||
            Math.abs(Date.parse(utc) - Date.now()) > 120_000)
          throw Error(`${name}/datetime: implausible UTC output: ${output}`);
      } else if (output !== 'HTTP 200\n{"message":"Hello from NetWasm Playground"}\n\n') {
        throw Error(`${name}/http: unexpected response: ${output}`);
      }
      console.log(`PASS ${name}/${example}: ${output.trim().replaceAll('\n', ' · ')}`);
    }
    const expectedUrl = new URL('example-http.json', url).href;
    if (sampleRequests.length !== 1 || sampleRequests[0].url !== expectedUrl ||
        sampleRequests[0].method !== 'GET' || sampleRequests[0].body !== null)
      throw Error(`${name}: unexpected HTTP sample request: ${JSON.stringify(sampleRequests)}`);
    if (pageErrors.length) throw Error(`${name}: page errors: ${pageErrors.join('; ')}`);
  } finally {
    await browser.close();
  }
}
