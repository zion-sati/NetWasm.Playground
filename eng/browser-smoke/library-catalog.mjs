import { openSample, sampleIds, setOptimizations } from './playground-ui.mjs';
import { chromium } from 'playwright';

const url = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/';
const examples = new Map([
  ['json-generated', '{"Name":"Ada","Score":42}\n'],
  ['regex', 'Ada: 42\nGrace: 99\nAda scored 42, Grace scored 99\n'],
  ['di', 'Hello, Ada!\n'],
  ['logging', 'info WidgetClient[1]\n      Fetched 42 widgets in 12.5 ms\n'],
  ['async-linq', 'Async values: 20, 40, 60\n'],
  ['pipelines', 'Buffered bytes: 3\nFirst byte: 13\n'],
  ['web-encoding', '\\u003CNetWasm \\u0026 C#\\u003E\n'],
  ['xml', 'Runtime: NetWasm\nAnswer: 42\n'],
  ['fluentvalidation', 'Valid: False\nName: Name is required.\nAge: Age must be 42.\n'],
]);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await setOptimizations(page, 'none');
  const available = await sampleIds(page);
  for (const [id, expected] of examples) {
    if (!available.includes(id)) throw new Error(`Missing library example: ${id}`);
    await openSample(page, id);
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
  await openSample(page, 'hello');
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

  // Hello World references every NetWasm.App assembly, as an SDK project does: these types live outside CoreLib.
  await page.locator('#editor .view-lines').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(`using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Text.RegularExpressions;
var scores = new SortedDictionary<string, int> { ["Grace"] = 99, ["Ada"] = 42 };
var queue = new Stack<int>(scores.Values);
var names = ImmutableArray.CreateRange(scores.Keys);
Console.WriteLine($"{string.Join(",", names)} {queue.Pop()} {scores.Values.Sum()} {Regex.IsMatch("NetWasm", "^Net")}");`);
  await page.locator('#run').click();
  await page.waitForFunction(() => document.querySelector('#stop').disabled, undefined, { timeout: 240_000 });
  const inBox = { status: await page.locator('#status').textContent(), output: await page.locator('#output').textContent(),
    diagnostics: await page.locator('#diagnostics').textContent() };
  if (inBox.status !== 'Run complete' || inBox.output !== 'Ada,Grace 99 141 True\n')
    throw new Error(`In-box assemblies in Hello World: ${JSON.stringify(inBox)}`);
  console.log('PASS in-box framework assemblies in Hello World');
  if (errors.length) throw new Error(`Page errors: ${errors.join('; ')}`);
  console.log('PASS: complete ported-library catalog is represented in the Playground');
} finally {
  await browser.close();
}
