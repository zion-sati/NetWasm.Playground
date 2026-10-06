import { setOptimizations } from './playground-ui.mjs';
import { browserType, browserName } from './engine.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const output = process.env.PLAYGROUND_EVIDENCE;
if (!output) throw Error('PLAYGROUND_EVIDENCE is required');
mkdirSync(output, { recursive: true });

const server = await browserType.launchServer({ headless: true });
const browser = await browserType.connect(server.wsEndpoint());
const samples = [];
let peakRSSKiB = 0;
const sample = () => {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim()
    .split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([server.process().pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, parent] of rows)
      if (owned.has(parent) && !owned.has(pid)) { owned.add(pid); changed = true; }
  }
  const rssKiB = rows.filter(([pid]) => owned.has(pid))
    .reduce((total, [, , rss]) => total + rss, 0);
  peakRSSKiB = Math.max(peakRSSKiB, rssKiB);
  samples.push({ elapsed: Date.now(), rssKiB, processes: owned.size });
};
sample();
const timer = setInterval(sample, 1_000);
const cases = [];
const errors = [];

try {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4173/');
  await page.locator('.monaco-editor').waitFor();
  await setOptimizations(page, 'none');

  const setSource = async source => {
    await page.locator('.monaco-editor').click({ position: { x: 100, y: 40 } });
    await page.keyboard.press(browserName === 'webkit' ? 'Meta+A' : 'ControlOrMeta+A');
    await page.keyboard.insertText(source);
  };
  const waitForIdle = () => page.waitForFunction(
    () => document.querySelector('#stop').disabled, undefined, { timeout: 240_000 });
  const runSource = async (name, source) => {
    await setSource(source);
    await page.locator('#run').click();
    await waitForIdle();
    sample();
    const result = {
      name,
      status: await page.locator('#status').textContent(),
      stdout: await page.locator('#output').textContent(),
      diagnostics: await page.locator('#diagnostics').textContent(),
      timings: await page.locator('#timings').textContent(),
    };
    cases.push(result);
    writeFileSync(`${output}/partial.json`, JSON.stringify(
      { browser: browserName, cases, errors, peakRSSKiB, samples }, null, 2));
    return result;
  };

  const loop = await runSource('loop',
    'using System; Console.WriteLine("loop started"); while(true){}');
  if (loop.stdout !== 'loop started\n' ||
      !loop.status.includes('Guest execution time limit exceeded'))
    throw Error(`Infinite-loop boundary failed: ${JSON.stringify(loop)}`);

  const loopRecovery = await runSource('loop-recovery',
    'using System; Console.WriteLine(43);');
  if (loopRecovery.status !== 'Run complete' || loopRecovery.stdout !== '43\n')
    throw Error(`Recovery after timeout failed: ${JSON.stringify(loopRecovery)}`);

  const flood = await runSource('console-flood',
    'using System; for(int i=0;i<10000;i++)Console.WriteLine("0123456789012345678901234567890123456789012345678901234567890123456789");');
  if (!flood.status.includes('Guest console limit exceeded') || flood.stdout.length > 65_536)
    throw Error(`Console boundary failed: ${JSON.stringify({
      status: flood.status, outputBytes: flood.stdout.length,
    })}`);

  const floodRecovery = await runSource('flood-recovery',
    'using System; Console.WriteLine(44);');
  if (floodRecovery.status !== 'Run complete' || floodRecovery.stdout !== '44\n')
    throw Error(`Recovery after console limit failed: ${JSON.stringify(floodRecovery)}`);

  const repeatedRuns = [];
  await setSource('using System; Console.WriteLine(42);');
  await page.locator('#run').click();
  await waitForIdle();
  for (let iteration = 0; iteration < 10; iteration++) {
    const started = Date.now();
    await page.locator('#run').click();
    await waitForIdle();
    const stdout = await page.locator('#output').textContent();
    if (await page.locator('#status').textContent() !== 'Run complete' || stdout !== '42\n')
      throw Error(`Repeated run ${iteration + 1} failed`);
    repeatedRuns.push({ milliseconds: Date.now() - started, stdout });
    sample();
  }

  const repeatedCompiles = [];
  for (let iteration = 0; iteration < 3; iteration++) {
    const started = Date.now();
    await page.locator('#compile').click();
    await waitForIdle();
    if (await page.locator('#status').textContent() !== 'Compilation complete')
      throw Error(`Repeated compilation ${iteration + 1} failed`);
    repeatedCompiles.push({
      milliseconds: Date.now() - started,
      timings: await page.locator('#timings').textContent(),
      size: await page.locator('#size').textContent(),
    });
    sample();
  }

  const storage = await page.evaluate(async () => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    indexedDB: (await indexedDB.databases()).map(database => database.name),
    caches: await caches.keys(),
    serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length,
    cookies: document.cookie,
  }));
  sample();
  if (errors.length) throw Error(`Page errors: ${JSON.stringify(errors)}`);

  const result = {
    passed: true,
    browser: browserName,
    cases,
    repeatedRuns,
    repeatedCompiles,
    storage,
    errors,
    peakRSSKiB,
    samples,
  };
  writeFileSync(`${output}/results.json`, JSON.stringify(result, null, 2));
  console.log(`PASS: resource limits and recovery; peak RSS ${(peakRSSKiB / 1024).toFixed(1)} MiB`);
} finally {
  clearInterval(timer);
  await browser.close();
  await server.close();
}
