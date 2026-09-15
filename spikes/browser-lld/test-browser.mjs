import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const root = path.dirname(fileURLToPath(import.meta.url));
const requests = [], errors = [];
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const filename = url.pathname === '/' ? path.join(root, 'index.html')
      : path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!filename.startsWith(root + path.sep)) throw Error('Path outside fixture');
    requests.push({ method: req.method, path: url.pathname,
      hasBody: Number(req.headers['content-length'] || 0) > 0 });
    if (url.pathname === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
    const bytes = await fs.readFile(filename);
    const extension = path.extname(filename);
    res.setHeader('content-type', ({ '.html': 'text/html', '.wasm': 'application/wasm',
      '.mjs': 'text/javascript', '.json': 'application/json' })[extension]
      || 'application/octet-stream');
    res.end(bytes);
  } catch (error) { res.statusCode = 404; res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, timedOut = false;
const deadline = setTimeout(() => {
  timedOut = true;
  if (browser) void browser.close().catch(() => {});
  server.closeAllConnections();
}, 180000);
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const results = await page.evaluate(async () => {
    const worker = new Worker('./worker.mjs', { type: 'module' });
    const invoke = data => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { worker.terminate(); reject(Error('LLD timeout')); }, 120000);
      worker.onmessage = ({ data: result }) => { clearTimeout(timer); resolve(result); };
      worker.onerror = error => { clearTimeout(timer); reject(Error(error.message)); };
      worker.postMessage(data);
    });
    try {
      const one = await invoke({ id: 1 });
      const two = await invoke({ id: 2 });
      const invalid = await invoke({ id: 3, invalid: true });
      const recovery = await invoke({ id: 4 });
      return [one, two, invalid, recovery].map(result => ({ ...result,
        bytes: result.bytes ? Array.from(result.bytes) : undefined }));
    } finally { worker.terminate(); }
  });
  const native = await fs.readFile(path.join(root, 'native/runtime.wasm'));
  const nativeHash = crypto.createHash('sha256').update(native).digest('hex');
  for (const result of results) {
    if (!result.bytes) continue;
    const bytes = Buffer.from(result.bytes);
    await fs.writeFile(path.join(root, `browser-runtime-${result.id}.wasm`), bytes);
    result.byteLength = bytes.length;
    result.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    delete result.bytes;
  }
  await fs.writeFile(path.join(root, 'browser-link-results.json'), JSON.stringify(results, null, 2) + '\n');
  if (!results[0].success || !results[1].success || results[2].success
      || !results[3].success || results.some((r, index) => r.instances !== index + 1))
    throw Error('Success/failure/recovery contract failed');
  if (results.filter(r => r.success).some(r => r.sha256 !== nativeHash))
    throw Error('Browser runtime differs from matched native LLD');
  if (!results[2].stderr.includes('unknown file type')) throw Error('Invalid archive diagnostic missing');
  const cancellation = await page.evaluate(async () => {
    const worker = new Worker('./worker.mjs', { type: 'module' });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { worker.terminate(); reject(Error('LLD entry timeout')); }, 120000);
        worker.onmessage = ({ data }) => {
          clearTimeout(timer);
          if (!data.entered) { reject(Error('LLD returned before entry signal')); return; }
          worker.terminate();
          resolve({ entered: true, terminated: true, resultReceived: false });
        };
        worker.onerror = error => { clearTimeout(timer); reject(Error(error.message)); };
        worker.postMessage({ id: 5, entered: true });
      });
    } finally { worker.terminate(); }
  });
  const afterTermination = await page.evaluate(async () => {
    const worker = new Worker('./worker.mjs', { type: 'module' });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { worker.terminate(); reject(Error('LLD recovery timeout')); }, 120000);
        worker.onmessage = ({ data }) => { clearTimeout(timer); resolve({ ...data,
          bytes: data.bytes ? Array.from(data.bytes) : undefined }); };
        worker.onerror = error => { clearTimeout(timer); reject(Error(error.message)); };
        worker.postMessage({ id: 6 });
      });
    } finally { worker.terminate(); }
  });
  if (!afterTermination.success) throw Error('Fresh worker failed after cancellation');
  const bytes = Buffer.from(afterTermination.bytes);
  delete afterTermination.bytes;
  await fs.writeFile(path.join(root, 'browser-runtime-6.wasm'), bytes);
  afterTermination.byteLength = bytes.length;
  afterTermination.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (afterTermination.sha256 !== nativeHash) throw Error('Fresh worker differs from native');
  if (timedOut) throw Error('Overall browser smoke deadline exceeded');
  const result = { browser: browser.version(), nativeHash, nativeBytes: native.length,
    results, cancellation, afterTermination, requests, errors };
  await fs.writeFile(path.join(root, 'browser-test.json'), JSON.stringify(result, null, 2) + '\n');
  if (errors.length || requests.some(request => request.method !== 'GET' || request.hasBody))
    throw Error('Browser errors or unexpected network writes');
  console.log(JSON.stringify(result, null, 2));
} finally {
  clearTimeout(deadline);
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
