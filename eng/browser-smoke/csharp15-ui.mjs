import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:4173/';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.route('**/toolchain/**', route => route.abort());
  await page.goto(base);

  const language = page.getByLabel('Language', { exact: true });
  if (await language.inputValue() !== '15') throw Error('C# 15 is not the default language');

  const ids = await page.getByLabel('Example', { exact: true }).locator('option').evaluateAll(options =>
    options.map(option => option.value));
  for (const id of ['csharp15-collection-arguments', 'csharp15-extension-indexer', 'csharp15-labeled-jumps',
    'csharp15-unions', 'csharp15-closed-hierarchies', 'csharp15-memory-safety'])
    if (!ids.includes(id)) throw Error(`Missing C# 15 example: ${id}`);

  await page.getByLabel('Example', { exact: true }).selectOption('csharp15-memory-safety');
  if (await language.inputValue() !== 'preview') throw Error('Memory-safety example did not select preview');
  const setting = page.locator('#memory-safety-setting');
  if (!await setting.isVisible() || !await page.locator('#updated-memory-safety').isChecked())
    throw Error('Memory-safety opt-in was not selected');
  if (!await page.locator('#editor').textContent().then(text => text?.includes('unsafe(')))
    throw Error('Memory-safety example does not show the feature syntax');

  await page.getByLabel('Example', { exact: true }).selectOption('hello');
  if (await language.inputValue() !== '15' || await setting.isVisible() || await page.locator('#updated-memory-safety').isChecked())
    throw Error('Stable example did not restore stable C# 15 settings');

  await language.selectOption('preview');
  if (!await setting.isVisible()) throw Error('Preview did not expose the feature setting');
  await page.locator('#updated-memory-safety').check();
  await language.selectOption('15');
  if (await setting.isVisible() || await page.locator('#updated-memory-safety').isChecked())
    throw Error('Stable language mode retained a preview-only feature');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) throw Error('C# 15 controls overflow the viewport');
  console.log('PASS: C# 15 language controls and six feature examples');
} finally {
  await browser.close();
}
