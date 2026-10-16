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
    const { createFrontendCache, clearFrontendCache } = await import('/src/workers/frontend-cache.mjs');
    await clearFrontendCache();
    const namespaces = [];
    const channel = createNativeAotCompilerChannel({ assetLoader: createAssetLoader(),
      createFrontendCache(toolchain) {
        const cache = createFrontendCache(toolchain);
        return {
          load(descriptor) { namespaces.push(descriptor.namespace); return cache.load(descriptor); },
          write: (descriptor, entries) => cache.write(descriptor, entries),
          close: () => cache.close(),
        };
      },
    });
    const results = [];
    const sourceSet = JSON.stringify({ schemaVersion: 1,
      files: [{ path: 'Program.cs', text: 'using System; Console.WriteLine(42);' }] });
    async function compile(label, optimizationOverrides) {
      const result = await channel.request({ operation: 'compile', recipe: 'hello', sourceSet,
        projectKind: 'command', nativeLibrariesJson: '[]', language: '15',
        updatedMemorySafetyRules: false, optimization: 'O3', garbageCollector: 'Compact',
        optimizationOverrides });
      if (!result.success) throw Error(`Override compilation failed: ${label}`);
      const plan = JSON.parse(result.coreLinkPlan).plan;
      const proof = { label, namespace: namespaces.at(-1),
        loadedEntries: result.frontendCacheMetrics.loadedEntries,
        hits: result.frontendCacheMetrics.hits,
        inlineSelection: plan.operations.find(operation => operation.kind === 'inline').selection };
      results.push(proof);
      return proof;
    }
    try {
      await channel.request({ operation: 'initialize', toolchainId: index.id });
      const cold = await compile('default-cold');
      const warm = await compile('default-warm');
      if (cold.namespace !== warm.namespace || warm.loadedEntries < 1 || warm.hits < 1)
        throw Error('Default frontend cache did not warm');
      for (const policy of ['loopInvariantFieldHoisting', 'staticDataViewElimination',
        'addressTakenValuePromotion', 'managedMethodInlining', 'branchPrefixDuplication',
        'arrayBoundsCheckElimination', 'loopUnrolling',
        'constantArgumentPropagation', 'staticArrayPopulationElimination']) {
        const enabled = await compile(`${policy}-enabled`, { [policy]: 'Enabled' });
        const disabled = await compile(`${policy}-disabled`, { [policy]: 'Disabled' });
        if (enabled.namespace === disabled.namespace)
          throw Error(`Managed policy reused an incompatible frontend namespace: ${policy}`);
      }
      for (const value of ['Enabled', 'Disabled']) {
        const scalar = await compile(`scalar-call-preservation-${value}`, { scalarCallPreservation: value });
        if (scalar.namespace !== cold.namespace)
          throw Error('Post-cache scalar-call emission policy changed the frontend namespace');
      }
      const preserve = await compile('hints-preserve', { managedInliningHints: 'Preserve' });
      const sizeAware = await compile('hints-ignore-aggressive', { managedInliningHints: 'IgnoreAggressive' });
      if (preserve.namespace !== cold.namespace || sizeAware.namespace !== cold.namespace ||
          preserve.inlineSelection !== 'Preserve' || sizeAware.inlineSelection !== 'SizeAware')
        throw Error('Backend-only hint selection or frontend cache partition is incorrect');
      return results;
    } finally { channel.reset(); }
  });
  assert.equal(results.length, 24);
  writeFileSync(`${output}/results.json`, JSON.stringify({ passed: true, browser: browser.version(), results }, null, 2));
} finally { await browser.close(); }
