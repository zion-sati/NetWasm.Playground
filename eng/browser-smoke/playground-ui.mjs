export async function openSample(page, id) {
  await page.locator('#open-samples').click();
  const sample = page.locator(`#sample-list [data-sample-id="${id}"]`);
  if (await sample.count() !== 1) throw new Error(`Sample is unavailable: ${id}`);
  await sample.click();
}

export async function sampleIds(page) {
  await page.locator('#open-samples').click();
  const ids = await page.locator('#sample-list [data-sample-id]').evaluateAll(items =>
    items.map(item => item.dataset.sampleId));
  await page.locator('#samples-dialog [aria-label="Close"]').click();
  return ids;
}

export async function setOptimizations(page, mode) {
  await page.locator('#settings-toggle').click();
  await page.locator('#run-optimization').selectOption(mode);
  await page.locator('#optimization').selectOption(mode);
  await page.locator('#settings-dialog footer button').click();
}

export async function openSettings(page) {
  await page.locator('#settings-toggle').click();
}

export async function closeSettings(page) {
  await page.locator('#settings-dialog footer button').click();
}

export async function clearCompilationCache(page) {
  await openSettings(page);
  await page.locator('#clear-cache').click();
  await page.locator('#status').filter({ hasText: 'Compilation cache cleared' }).waitFor();
  await closeSettings(page);
}
