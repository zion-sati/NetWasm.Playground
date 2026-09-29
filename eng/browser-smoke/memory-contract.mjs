import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { browserName, browserType } from './engine.mjs';

const url = process.env.PLAYGROUND_URL;
const output = process.env.PLAYGROUND_EVIDENCE;
if (!url || !output) throw Error('PLAYGROUND_URL and PLAYGROUND_EVIDENCE are required');
mkdirSync(output, { recursive: true });

const sources = Object.fromEntries(['memory-exact', 'memory-high', 'repeated-memory-instance']
  .map(name => [name, readFileSync(new URL(`fixtures/${name}.wat`, import.meta.url), 'utf8')]));
const browser = await browserType.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(url);
  const result = await page.evaluate(async ({ root, sources }) => {
    const index = await (await fetch(new URL('toolchain/index.json', root))).json();
    const assetRoot = new URL(`toolchain/${index.id}/`, root);
    let sequence = 0;
    const createWorker = name => {
      const workerUrl = new URL(`workers/${name}-worker.mjs`, assetRoot);
      const bootstrap = URL.createObjectURL(new Blob([`import ${JSON.stringify(workerUrl.href)};`],
        { type: 'text/javascript' }));
      try { return new Worker(bootstrap, { type: 'module' }); }
      finally { URL.revokeObjectURL(bootstrap); }
    };
    const request = (worker, payload, transfers = [], timeout = 120_000) => new Promise((resolve, reject) => {
      const id = ++sequence;
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener('message', receive);
        worker.removeEventListener('error', fail);
      };
      const fail = event => {
        cleanup();
        reject(Error(event.message || 'Memory-contract worker failed'));
      };
      const receive = ({ data }) => {
        if (data.id !== id || data.stage || data.console || data.assets || data.guestEntered || data.toolEntered)
          return;
        cleanup();
        data.error ? reject(Error(String(data.error))) : resolve(data.result);
      };
      timer = setTimeout(() => { cleanup(); reject(Error('Memory-contract worker timeout')); }, timeout);
      worker.addEventListener('message', receive);
      worker.addEventListener('error', fail);
      worker.postMessage({ ...payload, id }, transfers);
    });
    const tools = createWorker('tools');
    const components = {};
    try {
      for (const [name, source] of Object.entries(sources)) {
        const input = new TextEncoder().encode(source);
        const response = await request(tools, {
          operation: 'wasm-tools', args: ['parse', `${name}.wat`, '-o', `${name}.wasm`],
          files: { [`${name}.wat`]: input }, outputs: [`${name}.wasm`],
        }, [input.buffer]);
        if (response.exitCode !== 0 || !(response.files?.[`${name}.wasm`] instanceof Uint8Array))
          throw Error(response.stderr || `Failed to build ${name}`);
        components[name] = response.files[`${name}.wasm`];
      }
    } finally { tools.terminate(); }

    const run = async name => {
      const worker = createWorker('guest');
      const component = components[name].slice();
      try {
        return await request(worker, {
          operation: 'run', component, recipe: 'hello', componentContract: 'command',
        }, [component.buffer], 60_000);
      } finally { worker.terminate(); }
    };
    const exact = await run('memory-exact');
    const over = await run('memory-high');
    const recoveryAfterOver = await run('memory-exact');
    const aggregate = await run('repeated-memory-instance');
    const recoveryAfterAggregate = await run('memory-exact');
    return { exact, over, recoveryAfterOver, aggregate, recoveryAfterAggregate };
  }, { root: url, sources });

  if (!result.exact.success || result.exact.exitCode !== 0 ||
      result.exact.memoryMaximumBytes !== 2147483648 ||
      result.over.success || !result.over.error?.includes('Guest memory limit exceeded') ||
      !result.recoveryAfterOver.success || result.recoveryAfterOver.memoryMaximumBytes !== 2147483648 ||
      result.aggregate.success || !result.aggregate.error?.includes('Guest memory limit exceeded (aggregate)') ||
      !result.recoveryAfterAggregate.success || result.recoveryAfterAggregate.memoryMaximumBytes !== 2147483648)
    throw Error(`Guest memory contract failed: ${JSON.stringify(result)}`);

  const receipt = { passed: true, browserName, browser: browser.version(), result };
  writeFileSync(`${output}/memory-contract.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`PASS ${browserName}: exact 2 GiB guest memory, individual/aggregate denial and recovery`);
} finally {
  await browser.close();
}
