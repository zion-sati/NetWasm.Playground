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
  if (!ids.includes('csharp15-tour')) throw Error('Missing C# 15 feature tour');
  if (ids.filter(id => id.startsWith('csharp15-')).length !== 1)
    throw Error('C# 15 features should be combined into one example');

  await page.getByLabel('Example', { exact: true }).selectOption('csharp15-tour');
  if (await language.inputValue() !== 'preview') throw Error('Memory-safety example did not select preview');
  const setting = page.locator('#memory-safety-setting');
  if (!await setting.isVisible() || !await page.locator('#updated-memory-safety').isChecked())
    throw Error('Memory-safety opt-in was not selected');
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
  console.log('PASS: C# 15 language controls and combined feature tour');
} finally {
  await browser.close();
}
