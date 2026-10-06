import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:5178/';
const html = await (await fetch(root)).text();
assert.doesNotMatch(html, /Console\.WriteLine\(42\)/,
  'The obsolete static code sample remains in the initial HTML');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ acceptDownloads: true });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async options => {
        window.__projectSaveOptions = options;
        return { createWritable: async () => ({
          write: async blob => { window.__projectSaveBytes = [...new Uint8Array(await blob.arrayBuffer()).subarray(0, 4)]; },
          close: async () => { window.__projectSaveClosed = true; },
        }) };
      },
    });
  });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/toolchain/**', route => route.abort());
  await page.goto(root);
  await page.locator('.monaco-editor').waitFor();
  assert.equal(await page.title(), 'Compile C# 15 to WebAssembly in your browser | NetWasm Playground');
  assert.equal(await page.locator('h1').textContent(), 'Compile C# 15 to WebAssembly in your browser');
  assert.equal(await page.locator('.github-link span').textContent(), 'NetWasm');
  assert.equal(await page.locator('#download span').textContent(), 'Artifact(s)');
  assert.equal(await page.locator('#export-project span').textContent(), 'Project');
  assert.equal(await page.locator('#settings-toggle .icon').count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true,
    'The expanded toolbar overflows a narrow viewport');
  await page.setViewportSize({ width: 1280, height: 900 });

  const dockToggle = page.locator('#dock-collapse');
  assert.equal(await dockToggle.getAttribute('aria-expanded'), 'true');
  const expandedArrow = await dockToggle.textContent();
  await dockToggle.click();
  assert.equal(await dockToggle.getAttribute('aria-expanded'), 'false');
  assert.notEqual(await dockToggle.textContent(), expandedArrow,
    'The dock toggle arrow did not change when collapsed');
  await dockToggle.click();
  assert.equal(await dockToggle.getAttribute('aria-expanded'), 'true');

  assert.equal(await page.locator('.ide-toolbar select').count(), 0,
    'The toolbar still contains an inline sample or settings dropdown');
  assert.equal(await page.locator('#samples-dialog').evaluate(dialog => dialog.open), false);
  await page.locator('#open-samples').click();
  assert.equal(await page.locator('#samples-dialog').evaluate(dialog => dialog.open), true);
  const cards = page.locator('#sample-list .sample-card');
  assert.ok(await cards.count() > 1, 'The sample dialog contains no project list');
  assert.equal(await cards.filter({ has: page.locator('strong') }).count(), await cards.count());
  assert.equal(await cards.filter({ has: page.locator('span') }).count(), await cards.count());
  await page.locator('#samples-dialog [aria-label="Close"]').click();

  await page.locator('#settings-toggle').click();
  assert.equal(await page.locator('#settings-dialog').evaluate(dialog => dialog.open), true);
  await page.mouse.click(2, 2);
  assert.equal(await page.locator('#settings-dialog').evaluate(dialog => dialog.open), false,
    'Clicking outside a modal did not dismiss it');
  await page.locator('#settings-toggle').click();
  assert.equal(await page.locator('#run-optimization').inputValue(), 'none');
  assert.equal(await page.locator('#optimization').inputValue(), 'Oz');
  await page.locator('#run-optimization').selectOption('O1');
  await page.locator('#optimization').selectOption('Os');
  await page.locator('#settings-dialog footer button').click();

  await page.reload();
  await page.locator('.monaco-editor').waitFor();
  await page.locator('#settings-toggle').click();
  assert.equal(await page.locator('#run-optimization').inputValue(), 'O1');
  assert.equal(await page.locator('#optimization').inputValue(), 'Os');
  assert.deepEqual(await page.evaluate(() => ({
    run: localStorage.getItem('netwasm.runOptimization'),
    publish: localStorage.getItem('netwasm.publishOptimization'),
  })), { run: 'O1', publish: 'Os' });
  await page.locator('#settings-dialog footer button').click();
  await page.locator('#export-project').click();
  await page.waitForFunction(() => window.__projectSaveClosed === true);
  assert.deepEqual(await page.evaluate(() => ({
    name: window.__projectSaveOptions.suggestedName,
    bytes: window.__projectSaveBytes,
  })), { name: 'Hello-World.zip', bytes: [0x50, 0x4b, 0x03, 0x04] });

  await page.locator('#new-file').click();
  assert.equal(await page.locator('#file-dialog').evaluate(dialog => dialog.open), true);
  await page.locator('#file-path').fill('Helpers/Value.cs');
  await page.locator('#save-file').click();
  assert.equal(await page.locator('#file-tree .file-item', { hasText: 'Helpers/Value.cs' }).count(), 1);
  const helperTab = page.locator('.editor-tab', { hasText: 'Helpers/Value.cs' });
  assert.equal(await helperTab.count(), 1);
  await helperTab.click({ button: 'middle' });
  assert.equal(await helperTab.count(), 0, 'Middle-click did not close the editor tab');
  assert.equal(await page.locator('#file-tree .file-item', { hasText: 'Helpers/Value.cs' }).count(), 1,
    'Closing a tab removed the project file');
  assert.deepEqual(errors, []);
  console.log('PASS: C# 15 identity, modal flows, persisted profiles, dock toggle, native project export and closable tabs');
} finally {
  await browser.close();
}
