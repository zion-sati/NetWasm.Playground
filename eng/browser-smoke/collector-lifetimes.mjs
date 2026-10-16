import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { browserType } from './engine.mjs';

const output = process.env.PLAYGROUND_EVIDENCE;
if (!output) throw Error('PLAYGROUND_EVIDENCE is required');
mkdirSync(output, { recursive: true });
const browser = await browserType.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/');
  const results = await page.evaluate(async () => {
    const index = await (await fetch('/toolchain/index.json')).json();
    const { createAssetLoader } = await import(`/toolchain/${index.id}/workers/asset-loader.mjs`);
    const { createNativeAotCompilerChannel } = await import('/src/workers/native-compiler-channel.mjs');
    const channel = createNativeAotCompilerChannel({ assetLoader: createAssetLoader() });
    const cases = [
      ['finalization', 'using System; Console.WriteLine(new Resource().Value); class Resource { public int Value = 42; ~Resource() {} }'],
      ['weak-handles', 'using System; var value = new object(); var weak = new WeakReference(value); Console.WriteLine(weak.IsAlive); GC.KeepAlive(value);'],
      ['ephemeron-handles', 'using System; using System.Runtime.CompilerServices; var key = new object(); var table = new ConditionalWeakTable<object, object>(); table.Add(key, new object()); Console.WriteLine(table.TryGetValue(key, out _));'],
    ];
    const results = [];
    try {
      await channel.request({ operation: 'initialize', toolchainId: index.id });
      for (const [feature, text] of cases) {
        const sourceSet = JSON.stringify({ schemaVersion: 1, files: [{ path: 'Program.cs', text }] });
        for (const garbageCollector of ['Compact', 'Bump']) {
          const result = await channel.request({ operation: 'compile', recipe: 'hello', sourceSet,
            projectKind: 'command', nativeLibrariesJson: '[]', language: '15',
            updatedMemorySafetyRules: false, optimization: 'Oz', garbageCollector, frontendCache: false });
          if (garbageCollector === 'Compact') {
            if (!result.success || !result.runtimeFeatures.includes(feature) ||
                result.runtimeLinkPlan.GarbageCollector !== 'Compact')
              throw Error(`Supported collector lifetime qualification failed: ${feature}`);
          } else if (result.success || !result.error?.includes('The Bump collector does not support')) {
            throw Error(`Bump did not explicitly reject the reached lifetime feature: ${feature}`);
          }
          results.push({ feature, garbageCollector, success: result.success,
            explicitLifetimeRejection: garbageCollector === 'Bump' });
        }
      }
      return results;
    } finally { channel.reset(); }
  });
  assert.equal(results.length, 6);
  writeFileSync(`${output}/results.json`, JSON.stringify({ passed: true, browser: browser.version(), results }, null, 2));
} finally { await browser.close(); }
