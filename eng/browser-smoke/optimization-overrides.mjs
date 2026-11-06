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
    const slots = [];
    const channel = createNativeAotCompilerChannel({ assetLoader: createAssetLoader(),
      createFrontendCache(toolchain) {
        const cache = createFrontendCache(toolchain);
        return {
          loadRuntime(descriptor) { slots.push(descriptor.slot); return cache.loadRuntime(descriptor); },
          writeRuntime: (descriptor, payload, checksum) => cache.writeRuntime(descriptor, payload, checksum),
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
      // Each override set keeps compiled units of its own; the first compilation under one
      // restores none.
      const proof = { label, slot: slots.at(-1),
        restored: Number(/^restored (\d+) /.exec(result.compiledUnits ?? '')?.[1] ?? NaN),
        storedBytes: result.compiledUnitsCache?.storedBytes,
        inlineSelection: plan.operations.find(operation => operation.kind === 'inline').selection };
      results.push(proof);
      return proof;
    }
    try {
      await channel.request({ operation: 'initialize', toolchainId: index.id });
      const cold = await compile('default-cold');
      const warm = await compile('default-warm');
      if (cold.restored !== 0 || !(cold.storedBytes > 0) || !(warm.restored > 0))
        throw Error(`Default compiled units did not warm: ${JSON.stringify({ cold, warm })}`);
      for (const policy of ['loopInvariantFieldHoisting', 'staticDataViewElimination',
        'addressTakenValuePromotion', 'managedMethodInlining', 'branchPrefixDuplication',
        'arrayBoundsCheckElimination', 'loopUnrolling',
        'constantArgumentPropagation', 'staticArrayPopulationElimination']) {
        const enabled = await compile(`${policy}-enabled`, { [policy]: 'Enabled' });
        const disabled = await compile(`${policy}-disabled`, { [policy]: 'Disabled' });
        if (enabled.slot === disabled.slot || enabled.restored !== 0 || disabled.restored !== 0)
          throw Error(`Managed policy reused another policy's compiled units: ${policy}`);
      }
      for (const value of ['Enabled', 'Disabled']) {
        const scalar = await compile(`scalar-call-preservation-${value}`, { scalarCallPreservation: value });
        if (scalar.slot === cold.slot || scalar.restored !== 0)
          throw Error('Scalar-call emission policy reused the default compiled units');
      }
      const preserve = await compile('hints-preserve', { managedInliningHints: 'Preserve' });
      const sizeAware = await compile('hints-ignore-aggressive', { managedInliningHints: 'IgnoreAggressive' });
      if (preserve.inlineSelection !== 'Preserve' || sizeAware.inlineSelection !== 'SizeAware')
        throw Error('Backend-only hint selection is incorrect');
      return results;
    } finally { channel.reset(); }
  });
  assert.equal(results.length, 24);
  writeFileSync(`${output}/results.json`, JSON.stringify({ passed: true, browser: browser.version(), results }, null, 2));
} finally { await browser.close(); }
