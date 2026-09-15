const { chromium } = require(process.argv[2]);
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const site = path.resolve(process.argv[3]);
const receipt = path.resolve(process.argv[4]);
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = path.resolve(site, '.' + pathname);
  if (!file.startsWith(site + path.sep)) { response.writeHead(403).end(); return; }
  const target = pathname === '/' ? path.join(site, 'index.html') : file;
  fs.readFile(target, (error, bytes) => {
    if (error) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.json') ? 'application/json' : target.endsWith('.wasm') ? 'application/wasm' : 'text/html');
    response.end(bytes);
  });
});
(async () => {
  let browser;
  const result = { requests: [], browserErrors: [], network: [], limits: { timeoutMs: 30000, inputBytes: 1048576, consoleBytes: 65536, wasmMemory: 'Observed only; original tool binaries retain their own maxima.' } };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true });
    result.browser = browser.version();
    const page = await browser.newPage();
    page.on('pageerror', error => result.browserErrors.push(String(error)));
    page.on('request', request => result.network.push({ method: request.method(), pathname: new URL(request.url()).pathname, postData: request.postData() }));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => {
      window.worker = new Worker('./worker.js', { type: 'module' });
      window.nextId = 0;
      window.call = request => new Promise((resolve, reject) => {
        const id = ++window.nextId;
        const timer = setTimeout(() => { window.worker.terminate(); reject(new Error('Tool timeout; worker terminated')); }, 30000);
        const handler = event => { if (event.data.id !== id || (event.data.started || event.data.toolEntered)) return; clearTimeout(timer); window.worker.removeEventListener('message', handler); resolve(event.data); };
        window.worker.addEventListener('message', handler);
        window.worker.postMessage({ id, ...request });
      });
    });
    async function call(label, request) {
      const output = await page.evaluate(request => window.call(request), request);
      result.requests.push({ label, request, output });
      console.log(label, JSON.stringify(output).slice(0, 550));
      return output;
    }
    await call('initialize', { operation: 'initialize' });
    const wat = '(module (func (export "answer") (result i32) i32.const 42))';
    const parse = await call('parse-valid-core', { operation: 'wasm-tools', args: ['parse', 'input.wat', '-o', 'a.wasm'], files: { 'input.wat': [...Buffer.from(wat)] }, outputs: ['a.wasm'] });
    if (parse.error || parse.result.exitCode !== 0) return;
    const a = parse.result.files['a.wasm'];
    await call('validate-valid-core', { operation: 'wasm-tools', args: ['validate', 'a.wasm'], files: { 'a.wasm': a } });
    await call('validate-malformed-core', { operation: 'wasm-tools', args: ['validate', 'bad.wasm'], files: { 'bad.wasm': [0, 97, 115, 109, 1] } });
    await call('validate-recovery-core', { operation: 'wasm-tools', args: ['validate', 'a.wasm'], files: { 'a.wasm': a } });
    const wit = 'package probe:small@1.0.0; world small { export answer: func() -> u32; }';
    const embed = await call('component-embed', { operation: 'wasm-tools', args: ['component', 'embed', 'small.wit', 'a.wasm', '--world', 'small', '-o', 'embedded.wasm'], files: { 'small.wit': [...Buffer.from(wit)], 'a.wasm': a }, outputs: ['embedded.wasm'] });
    if (!embed.error && embed.result.exitCode === 0) {
      const component = await call('component-new', { operation: 'wasm-tools', args: ['component', 'new', 'embedded.wasm', '-o', 'component.wasm'], files: { 'embedded.wasm': embed.result.files['embedded.wasm'] }, outputs: ['component.wasm'] });
      if (!component.error && component.result.exitCode === 0) {
        const c = component.result.files['component.wasm'];
        await call('component-validate', { operation: 'wasm-tools', args: ['validate', 'component.wasm'], files: { 'component.wasm': c } });
        await call('component-wit', { operation: 'wasm-tools', args: ['component', 'wit', 'component.wasm'], files: { 'component.wasm': c } });
        await call('jco-browser-generate-instantiate', { operation: 'jco', files: { 'component.wasm': c } });
        await call('jco-browser-malformed', { operation: 'jco', files: { 'component.wasm': [0, 97, 115, 109, 13] } });
        await call('jco-browser-recovery', { operation: 'jco', files: { 'component.wasm': c } });
      }
    }
    // Module B imports A's function and returns 43. The merge must resolve it.
    const bparse = await call('parse-dependent-core', { operation: 'wasm-tools', args: ['parse', 'b.wat', '-o', 'b.wasm'], files: { 'b.wat': [...Buffer.from('(module (import "a" "answer" (func $answer (result i32))) (func (export "combined") (result i32) call $answer i32.const 1 i32.add))')] }, outputs: ['b.wasm'] });
    const b = bparse.result.files['b.wasm'];
    const merged = await call('binaryen-merge', { operation: 'wasm-merge', args: ['a.wasm', 'a', 'b.wasm', 'b', '-o', 'merged.wasm'], files: { 'a.wasm': a, 'b.wasm': b }, outputs: ['merged.wasm'] });
    await call('binaryen-merge-malformed', { operation: 'wasm-merge', args: ['bad.wasm', 'bad', '-o', 'merged.wasm'], files: { 'bad.wasm': [0, 97, 115, 109, 1] }, outputs: ['merged.wasm'] });
    await call('binaryen-merge-recovery', { operation: 'wasm-merge', args: ['a.wasm', 'a', 'b.wasm', 'b', '-o', 'merged.wasm'], files: { 'a.wasm': a, 'b.wasm': b }, outputs: ['merged.wasm'] });
    if (!merged.error && merged.result.exitCode === 0) {
      const optimize = await call('binaryen-optimize', { operation: 'wasm-opt', args: ['merged.wasm', '-Oz', '-o', 'optimized.wasm'], files: { 'merged.wasm': merged.result.files['merged.wasm'] }, outputs: ['optimized.wasm'] });
      await call('binaryen-optimize-malformed', { operation: 'wasm-opt', args: ['bad.wasm', '-Oz', '-o', 'optimized.wasm'], files: { 'bad.wasm': [0, 97, 115, 109, 1] }, outputs: ['optimized.wasm'] });
      await call('binaryen-optimize-recovery', { operation: 'wasm-opt', args: ['merged.wasm', '-Oz', '-o', 'optimized.wasm'], files: { 'merged.wasm': merged.result.files['merged.wasm'] }, outputs: ['optimized.wasm'] });
      if (!optimize.error && optimize.result.exitCode === 0) result.execution = await page.evaluate(async bytes => {
        const module = await WebAssembly.compile(Uint8Array.from(bytes));
        const instance = await WebAssembly.instantiate(module, {});
        return { imports: WebAssembly.Module.imports(module), answer: instance.exports.answer(), combined: instance.exports.combined() };
      }, optimize.result.files['optimized.wasm']);
    }
    await call('input-limit-denial', { operation: 'wasm-tools', args: ['validate', 'big.wasm'], files: { 'big.wasm': Array(1048577).fill(0) } });
    await call('path-limit-denial', { operation: 'wasm-tools', args: ['validate', '../outside.wasm'], files: { '../outside.wasm': a } });
    const many = await call('parse-console-limit-fixture', { operation: 'wasm-tools', args: ['parse', 'many.wat', '-o', 'many.wasm'], files: { 'many.wat': [...Buffer.from('(module ' + '(func (nop)) '.repeat(6000) + ')')] }, outputs: ['many.wasm'] });
    if (!many.error && many.result.exitCode === 0) await call('console-limit-denial', { operation: 'wasm-tools', args: ['print', 'many.wasm'], files: { 'many.wasm': many.result.files['many.wasm'] } });
    await call('limit-failure-recovery', { operation: 'wasm-tools', args: ['validate', 'a.wasm'], files: { 'a.wasm': a } });
    // Start a real synchronous parse, then terminate from the page on a short
    // deadline. toolEntered is posted immediately before wasi.start(instance).
    result.cancellation = await page.evaluate(bytes => new Promise(resolve => {
      const id = ++window.nextId;
      const startedAt = performance.now();
      let deadline;
      const handler = event => {
        if (event.data.id !== id) return;
        if (event.data.started) return;
        if (event.data.toolEntered) {
          deadline = setTimeout(() => { window.worker.terminate(); window.worker.removeEventListener('message', handler); resolve({ terminated: true, sawToolEntered: true, elapsedMs: performance.now() - startedAt }); }, 1);
        } else {
          clearTimeout(deadline); window.worker.removeEventListener('message', handler); resolve({ terminated: false, output: event.data });
        }
      };
      window.worker.addEventListener('message', handler);
      window.worker.postMessage({ id, operation: 'wasm-tools', args: ['parse', 'cancel.wat', '-o', 'cancel.wasm'], files: { 'cancel.wat': bytes }, outputs: ['cancel.wasm'] });
    }), [...Buffer.from('(module ' + '(func (nop)) '.repeat(60000) + ')')]);
    await page.evaluate(() => { window.worker = new Worker('./worker.js', { type: 'module' }); });
    await call('cancellation-fresh-worker-initialize', { operation: 'initialize' });
    await call('cancellation-fresh-worker-recovery', { operation: 'wasm-tools', args: ['validate', 'a.wasm'], files: { 'a.wasm': a } });
    await page.evaluate(() => window.worker.terminate());
    const byLabel = Object.fromEntries(result.requests.map(x => [x.label, x.output]));
    for (const label of ['parse-valid-core', 'validate-valid-core', 'validate-recovery-core', 'component-embed', 'component-new', 'component-validate', 'component-wit', 'parse-dependent-core', 'binaryen-merge', 'binaryen-merge-recovery', 'binaryen-optimize', 'binaryen-optimize-recovery', 'limit-failure-recovery', 'cancellation-fresh-worker-recovery']) {
      if (byLabel[label]?.result?.exitCode !== 0) throw new Error(`Expected success: ${label}`);
    }
    for (const label of ['validate-malformed-core', 'binaryen-merge-malformed', 'binaryen-optimize-malformed']) {
      if (byLabel[label]?.result?.exitCode !== 1 || Object.keys(byLabel[label].result.files).length) throw new Error(`Expected clean tool failure: ${label}`);
    }
    for (const label of ['jco-browser-generate-instantiate', 'jco-browser-recovery']) if (byLabel[label]?.result?.answer !== 42) throw new Error(`Expected real component output: ${label}`);
    for (const label of ['input-limit-denial', 'path-limit-denial', 'console-limit-denial', 'jco-browser-malformed']) if (!byLabel[label]?.error || byLabel[label].result) throw new Error(`Expected clean host failure: ${label}`);
    if (result.execution.answer !== 42 || result.execution.combined !== 43 || result.execution.imports.length) throw new Error('Merge/optimizer semantics incorrect');
    if (!result.cancellation.terminated || !result.cancellation.sawToolEntered) throw new Error('Expected actual worker cancellation');
    if (result.browserErrors.length || result.network.some(x => x.method !== 'GET' || x.postData !== null)) throw new Error('Unexpected browser error or network upload');
    result.passed = true;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    for (const request of result.requests) for (const [name, bytes] of Object.entries(request.output.result?.files || {})) {
      const buffer = Buffer.from(bytes); const filename = `${request.label}-${name}`;
      fs.writeFileSync(path.join(path.dirname(receipt), filename), buffer);
      request.output.result.files[name] = { bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), retainedAs: filename };
    }
    for (const request of result.requests) request.request.files = Object.fromEntries(Object.entries(request.request.files || {}).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex') }]));
    fs.writeFileSync(receipt, JSON.stringify(result, null, 2) + '\n');
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
