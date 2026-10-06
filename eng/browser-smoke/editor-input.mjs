import { openSample } from './playground-ui.mjs';
import { browserName, browserType } from './engine.mjs';

const browser = await browserType.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/');
  await page.locator('.monaco-editor').waitFor();
  await openSample(page, 'multi-file');
  await page.locator('#file-tree .file-item', { hasText: 'Answer.cs' }).click();
  await page.locator('#editor textarea').focus();
  await page.keyboard.press(browserName === 'webkit' ? 'Meta+A' : 'ControlOrMeta+A');
  await page.keyboard.insertText('public static class Answer { public const int Value = Missing; }');
  await page.waitForFunction(() => document.querySelector('#editor .view-lines')?.textContent?.includes('Missing'));
  const visibleText = await page.locator('#editor .view-lines').textContent();
  if (visibleText?.includes('42'))
    throw new Error(`${browserName} appended editor input instead of replacing the complete document: ${visibleText}`);
  console.log(`PASS: ${browserName} replaces the complete Monaco document`);
} finally {
  await browser.close();
}
