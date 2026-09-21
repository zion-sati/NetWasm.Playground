import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const url = process.env.PLAYGROUND_URL;
const output = process.env.PLAYGROUND_RUNTIME_PLAN;
if (!url || !output) throw new Error('PLAYGROUND_URL and PLAYGROUND_RUNTIME_PLAN are required');

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(new URL('toolchain/index.json', url).href);
  const plan = await page.evaluate(async root => {
    const index = await (await fetch(new URL('toolchain/index.json', root))).json();
    const workerUrl = new URL(`toolchain/${index.id}/workers/compiler-worker.mjs`, root);
    const bootstrap = URL.createObjectURL(new Blob([`import ${JSON.stringify(workerUrl.href)};`],
      { type: 'text/javascript' }));
    const worker = new Worker(bootstrap, { type: 'module' });
    URL.revokeObjectURL(bootstrap);
    let sequence = 0;
    const pending = new Map();
    worker.onmessage = ({ data }) => {
      const call = pending.get(data.id);
      if (!call || data.stage || data.console || data.assets || data.started || data.toolEntered) return;
      clearTimeout(call.timer);
      pending.delete(data.id);
      data.error ? call.reject(new Error(String(data.error))) : call.resolve(data.result);
    };
    const request = payload => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => reject(new Error('Candidate compiler timeout')), 240_000);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...payload, id });
    });
    try {
      await request({ operation: 'initialize', toolchainId: index.id });
      const result = await request({
        operation: 'compile',
        recipe: 'hello',
        source: 'using System; Console.WriteLine(42);',
        language: '15',
        updatedMemorySafetyRules: false,
        frontendCache: false,
      });
      if (!result.success) throw new Error(`Candidate compilation failed: ${result.error ?? 'unknown error'}`);
      const actual = result.runtimeLinkPlan;
      if (!actual || !Array.isArray(actual.Arguments) || !Array.isArray(actual.Inputs))
        throw new Error('Candidate compiler returned an invalid runtime plan');
      return {
        arguments: actual.Arguments,
        inputs: actual.Inputs.map(input => ({ path: input.Path, sha256: input.Sha256 })),
      };
    } finally {
      worker.terminate();
    }
  }, url);
  writeFileSync(output, `${JSON.stringify({ arguments: plan.arguments, inputs: plan.inputs }, null, 2)}\n`);
  console.log(`PASS: captured candidate runtime plan with ${plan.inputs.length} inputs`);
} finally {
  await browser.close();
}
