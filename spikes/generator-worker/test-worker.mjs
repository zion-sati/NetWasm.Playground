import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = JSON.parse(readFileSync('inputs.json', 'utf8'));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const watchdog = setTimeout(() => { void browser.close(); }, 120_000);
const results = [];
try {
  await page.goto(process.env.GENERATOR_PROBE_URL);
  const boot = await page.evaluate(() => window.ready);
  const second = inputs.source.replace('    [Test]', `    [Test]
    public async System.Threading.Tasks.Task AnotherAnswer()
    {
        await Assert.That(43).IsEqualTo(43);
    }

    [Test]`);
  const sources = [inputs.source, second,
    'using TUnit.Core; public sealed class Tests { [Test] public void Broken( }',
    'using TUnit.Core; public sealed class Tests { [Test] public int UnsupportedReturn() => 42; }',
    inputs.source.replace('AnswerIsFortyTwo', 'RecoveredAnswer')];
  for (const source of sources) {
    const started = performance.now();
    const result = await page.evaluate(source => window.generate(source), source);
    const index = results.length;
    if (result.pe) {
      const bytes = Buffer.from(result.pe, 'base64');
      writeFileSync(`managed-${index}.dll`, bytes);
      result.managedBytes = bytes.length; result.managedSha256 = hash(bytes); delete result.pe;
    }
    if (result.success) {
      mkdirSync(`generated-${index}`);
      for (const [sourceIndex, generated] of result.generatedSources.entries()) {
        const bytes = Buffer.from(generated.text, 'utf8');
        if (bytes.length !== generated.bytes || hash(bytes) !== generated.sha256)
          throw new Error('Produced source hash failed');
        writeFileSync(`generated-${index}/${sourceIndex}.g.cs`, bytes);
      }
      result.catalogSha256 = hash(Buffer.from(result.generatedSources.map(item => `${item.hintName}\n${item.text}`).join('\n')));
      result.generatedTexts = result.generatedSources.map(item => item.text).join('\n');
    }
    results.push({ ...result, sourceSha256: hash(Buffer.from(source)), ms: performance.now() - started });
  }
  const counts = results.map(result => result.catalogCaseCount);
  const syntaxDiagnostic = results[2].diagnostics?.find(item => item.severity === 'Error');
  const capabilityDiagnostic = results[3].generatorDiagnostics?.find(item => item.code === 'TUNIT1001');
  if (results.map(result => result.success).join(',') !== 'true,true,false,false,true' ||
      counts.join(',') !== '1,2,0,0,1' ||
      results[0].catalogSha256 === results[1].catalogSha256 ||
      results[1].catalogSha256 === results[4].catalogSha256 ||
      !results[1].generatedTexts.includes('AnotherAnswer') ||
      !results[4].generatedTexts.includes('RecoveredAnswer') ||
      results[4].generatedTexts.includes('AnotherAnswer') ||
      results.filter(result => result.success).some(result => result.generatedSources.some(
        item => item.producer !== 'TUnit.Core.SourceGenerator.Generators.TestMetadataGenerator')) ||
      syntaxDiagnostic?.path !== 'Tests.cs' || capabilityDiagnostic?.path !== 'Tests.cs' ||
      results[2].managedBytes !== undefined || results[3].managedBytes !== undefined ||
      results[2].generatedSources.length || results[3].generatedSources.length || errors.length)
    throw new Error('Catalog edit, diagnostic, failure-isolation or recovery assertions failed');
  await page.locator('#source').fill(inputs.source.replace('AnswerIsFortyTwo', 'EditorAnswer'));
  await page.locator('#generate').click();
  await page.waitForFunction(() => window.lastResult !== null && window.lastResult !== undefined);
  const editor = await page.evaluate(() => window.lastResult);
  if (!editor.success || editor.catalogCaseCount !== 1 ||
      !editor.generatedSources.some(item => item.text.includes('EditorAnswer')))
    throw new Error('Editable declaration did not change the generated catalog');
  for (const result of results) {
    delete result.generatedTexts;
    for (const generated of result.generatedSources ?? []) delete generated.text;
  }
  writeFileSync('worker-test.json', JSON.stringify({ schemaVersion: 1, browser: browser.version(), boot,
    results, errors, editor: { success: editor.success, catalogCaseCount: editor.catalogCaseCount },
    inputsSha256: hash(readFileSync('inputs.json')) }, null, 2));
  console.log('PASS: actual packaged TUnit generator; changed catalog; syntax/generator failures and recovery');
} catch (error) {
  writeFileSync('worker-failure.json', JSON.stringify({ category: String(error), errors, results }, null, 2));
  throw error;
} finally { clearTimeout(watchdog); await browser.close(); }
