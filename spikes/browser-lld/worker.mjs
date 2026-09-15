import loadLld from './assets/netwasm-browser-lld.mjs';
import { createBrowserLld } from './assets/netwasm-lld.mjs';

let instances = 0, signalEntry = false, initializationMilliseconds = 0;
const linker = createBrowserLld(async options => {
  instances++;
  const started = performance.now();
  const module = await loadLld(options);
  initializationMilliseconds = performance.now() - started;
  const original = module._netwasm_lld_link;
  module._netwasm_lld_link = (...args) => {
    // Signal immediately before entering the synchronous real linker.
    if (signalEntry) self.postMessage({ entered: true });
    return original(...args);
  };
  return module;
});

async function fetchInput(path, json = false) {
  const response = await fetch(path);
  if (!response.ok) throw Error(`Fixture fetch failed: ${path}`);
  return json ? response.json() : new Uint8Array(await response.arrayBuffer());
}

self.onmessage = async ({ data }) => {
  try {
    const args = await fetchInput('./fixture/arguments.json', true);
    const inputs = await fetchInput('./fixture/inputs.json', true);
    const files = {};
    for (const item of inputs) files[item.path] = await fetchInput('./fixture/' + item.filename);
    if (data.invalid) files[inputs[0].path] = new TextEncoder().encode('invalid archive bytes');
    files['/netwasm-link/arguments.rsp'] = new TextEncoder().encode(
      args.map(arg => JSON.stringify(arg)).join('\n'));
    signalEntry = Boolean(data.entered);
    const result = await linker.link({ arguments: ['@/netwasm-link/arguments.rsp'],
      files, outputPath: '/netwasm-link/runtime.wasm' });
    // readFile returned an owned copy. Transfer it once, then release this job.
    const bytes = result.bytes;
    self.postMessage({ ...result, instances, initializationMilliseconds, id: data.id },
      bytes ? [bytes.buffer] : []);
  } catch (error) { self.postMessage({ error: String(error), instances, id: data.id }); }
};
