import { chromium } from 'playwright';

const url = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/';
const examples = new Map([
  ['async-linq', 'Async values: 20, 40, 60\n'],
  ['pipelines', 'Buffered bytes: 3\nFirst byte: 13\n'],
  ['web-encoding', '\\u003CNetWasm \\u0026 C#\\u003E\n'],
  ['xml', 'Runtime: NetWasm\nAnswer: 42\n'],
]);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.locator('#optimization').selectOption('none');
  const available = await page.locator('#example option').evaluateAll(options =>
    options.map(option => option.value));
  for (const [id, expected] of examples) {
    if (!available.includes(id)) throw new Error(`Missing library example: ${id}`);
    await page.locator('#example').selectOption(id);
    await page.locator('#run').click();
    await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 240_000 });
    const actual = {
      status: await page.locator('#status').textContent(),
      output: await page.locator('#output').textContent(),
      diagnostics: await page.locator('#diagnostics').textContent(),
    };
    if (actual.status !== 'Run complete' || actual.output !== expected || actual.diagnostics !== 'No diagnostics.')
      throw new Error(`${id}: ${JSON.stringify(actual)}`);
    console.log(`PASS ${id}`);
  }
  await page.locator('#example').selectOption('hello');
  await page.locator('#editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(`using System;
using System.Threading.Tasks;
public static class Program
{
    public static async Task<int> Main()
    {
        await Task.Yield();
        Console.WriteLine(42);
        return 0;
    }
}`);
  await page.locator('#run').click();
  await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 240_000 });
  if (await page.locator('#status').textContent() !== 'Run complete' ||
      await page.locator('#output').textContent() !== '42\n')
    throw new Error('Async contract inference depends on the selected example');
  console.log('PASS async C# pasted into Hello World');
  if (errors.length) throw new Error(`Page errors: ${errors.join('; ')}`);
  console.log('PASS: complete ported-library catalog is represented in the Playground');
} finally {
  await browser.close();
}
