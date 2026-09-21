import { chromium, firefox, webkit } from 'playwright';

const engines = { chromium, firefox, webkit };
const selected = (process.env.PLAYGROUND_BROWSERS ?? 'chromium,firefox,webkit').split(',');
const optimization = process.env.PLAYGROUND_CSHARP15_OPTIMIZATION ?? 'none';
const url = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/';
const expectedOutput = [
  'Collection arguments: 42',
  'Extension indexer: 42',
  'Labeled jumps: 45',
  'Union: 42',
  'Closed hierarchy: 42',
  'Updated memory safety: 42',
  '',
].join('\n');

for (const name of selected) {
  const engine = engines[name];
  if (!engine) throw new Error(`Unknown browser: ${name}`);
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.locator('#optimization').selectOption(optimization);
    await page.locator('#example').selectOption('csharp15-tour');
    await page.locator('#run').click();
    await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 240_000 });
    const actual = {
      status: await page.locator('#status').textContent(),
      output: await page.locator('#output').textContent(),
      diagnostics: await page.locator('#diagnostics').textContent(),
    };
    if (actual.status !== 'Run complete' || actual.output !== expectedOutput || actual.diagnostics !== 'No diagnostics.')
      throw new Error(`${name}/csharp15-tour: ${JSON.stringify(actual)}`);
    console.log(`PASS ${name}/csharp15-tour/${optimization}: six language features`);
    if (errors.length) throw new Error(`${name}: page errors: ${errors.join('; ')}`);
  } finally {
    await browser.close();
  }
}
