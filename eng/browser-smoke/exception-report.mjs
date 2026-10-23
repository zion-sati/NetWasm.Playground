import { openSettings, closeSettings, setOptimizations } from './playground-ui.mjs';
import { chromium, firefox, webkit } from 'playwright';

// Run reports an exception that escapes Main as desktop .NET does, for
// synchronous and asynchronous programs, and stops when the setting is off.
const engines = { chromium, firefox, webkit };
const selected = (process.env.PLAYGROUND_BROWSERS ?? 'chromium').split(',');
const url = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/';
const report = 'Unhandled exception. System.InvalidOperationException: boom\n';
const programs = {
  synchronous: 'using System;\nConsole.WriteLine("before");\nthrow new InvalidOperationException("boom");\n',
  asynchronous: 'using System;\nusing System.Threading.Tasks;\nConsole.WriteLine("before");\nawait Task.Yield();\n' +
    'throw new InvalidOperationException("boom");\n',
};

async function run(page, name, source) {
  await page.locator('#editor .view-lines').click({ position: { x: 80, y: 12 } });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(source);
  await page.locator('#run').click();
  await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 240_000 });
  const output = await page.locator('#output').textContent();
  const diagnostics = await page.locator('#diagnostics').textContent();
  if (diagnostics !== 'No diagnostics.') throw Error(`${name}: ${diagnostics}`);
  return output;
}

for (const name of selected) {
  const engine = engines[name];
  if (!engine) throw Error(`Unknown browser: ${name}`);
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(url);
    await page.locator('.monaco-editor').waitFor();
    await setOptimizations(page, 'none');
    await openSettings(page);
    if (!await page.locator('#run-diagnostics').isChecked() || await page.locator('#publish-diagnostics').isChecked())
      throw Error(`${name}: Run should report unhandled exceptions by default and Publish should not`);
    await closeSettings(page);

    for (const [kind, source] of Object.entries(programs)) {
      const output = await run(page, `${name}/${kind}`, source);
      if (!output.startsWith('before\n') || !output.includes(report))
        throw Error(`${name}/${kind}: the unhandled exception was not reported: ${JSON.stringify(output)}`);
    }
    if (await page.locator('#exit').textContent() === 'Exit 0')
      throw Error(`${name}: an unhandled exception exited with code 0`);

    await openSettings(page);
    await page.locator('#run-diagnostics').uncheck();
    await closeSettings(page);
    const quiet = await run(page, `${name}/off`, programs.synchronous);
    if (quiet.includes('Unhandled exception.'))
      throw Error(`${name}: the exception was reported with the setting off: ${JSON.stringify(quiet)}`);
    if (pageErrors.length) throw Error(`${name}: ${pageErrors.join('\n')}`);
    console.log(`PASS: ${name} reports unhandled exceptions from synchronous and asynchronous Main when Run asks`);
  } finally {
    await browser.close();
  }
}
