const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const errorText = error => String(error?.stack || error?.message || error).slice(0, 4096);
function ownedFiles(files = {}, maximum) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw Error('Tool files must be a byte map');
  let total = 0;
  return Object.fromEntries(Object.entries(files).map(([name, bytes]) => {
    if (!(bytes instanceof Uint8Array)) throw Error('Tool inputs must be Uint8Array');
    total += bytes.byteLength;
    if (total > maximum) throw Error('Native wasm-opt input byte limit exceeded');
    return [name, bytes.slice()];
  }));
}
function serveWorker(handler) {
  let busy = false;
  self.onmessage = async ({ data }) => {
    const id = data?.id;
    if (busy) { self.postMessage({ id, error: 'Worker is busy' }); return; }
    busy = true;
    try {
      const result = await handler(data);
      const transfers = Object.values(result.files ?? {}).map(bytes => bytes.buffer);
      self.postMessage({ id, result }, transfers);
    } catch (error) { self.postMessage({ id, error: errorText(error) }); }
    finally { busy = false; }
  };
}

const maximumAssetBytes = 16 * 1048576;
const limits = { maximumInputBytes: 5 * 1048576, maximumOutputBytes: 5 * 1048576 };
let initialized, runtime, configuredRoot, configuredWorkers, workerCount;
let javascriptUrl, wasmUrl;
let stdout = [], stderr = [];

const validPath = name => typeof name === 'string' && /^[A-Za-z0-9_.@/-]+$/.test(name) &&
  !name.startsWith('/') && !name.split('/').some(part => !part || part === '.' || part === '..');

async function boundedBytes(url, maximum = maximumAssetBytes) {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) throw Error(`Native wasm-opt asset HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw Error('Native wasm-opt asset exceeds its byte limit');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > maximum) throw Error('Native wasm-opt asset exceeds its byte limit');
  return bytes;
}

async function initialize(root, requestedWorkers) {
  if (initialized && (root !== configuredRoot || requestedWorkers !== configuredWorkers))
    throw Error('Native wasm-opt configuration changed');
  configuredRoot = root;
  configuredWorkers = requestedWorkers;
  return initialized ??= (async () => {
    if (!crossOriginIsolated || typeof SharedArrayBuffer !== 'function')
      throw Error('Native wasm-opt requires cross-origin isolation and SharedArrayBuffer');
    const candidateRoot = new URL(root, location.origin);
    if (candidateRoot.origin !== location.origin || !candidateRoot.pathname.endsWith('/'))
      throw Error('Invalid native wasm-opt candidate root');
    if (!Number.isSafeInteger(requestedWorkers) || requestedWorkers < 1 || requestedWorkers > 16)
      throw Error('Invalid native wasm-opt worker count');
    const receiptResponse = await fetch(new URL('build-receipt.json', candidateRoot), { cache: 'no-store' });
    if (!receiptResponse.ok) throw Error('Native wasm-opt receipt unavailable');
    const receipt = await receiptResponse.json();
    const maximumWorkerCount = receipt.maximumWorkerCount ?? receipt.pthreadPoolSize;
    const legacyReceipt = receipt.pthreadPoolSize !== undefined;
    if (receipt.schemaVersion !== 1 || !Number.isSafeInteger(maximumWorkerCount) ||
        maximumWorkerCount < requestedWorkers || maximumWorkerCount > 16 ||
        (legacyReceipt && receipt.binaryenCores !== maximumWorkerCount) ||
        (!legacyReceipt && (receipt.pthreadPoolBuildSize !== maximumWorkerCount ||
          receipt.binaryenCoresEnvironmentVariable !== 'BINARYEN_CORES')) ||
        !Number.isSafeInteger(receipt.javascriptSize) || receipt.javascriptSize < 10000 ||
        !Number.isSafeInteger(receipt.wasmSize) || receipt.wasmSize < 1000000 ||
        !/^[a-f0-9]{64}$/.test(receipt.javascriptSha256) || !/^[a-f0-9]{64}$/.test(receipt.wasmSha256))
      throw Error('Invalid native wasm-opt receipt');
    const loaded = await Promise.allSettled([
      boundedBytes(new URL('wasm-opt.js', candidateRoot)),
      boundedBytes(new URL('wasm-opt.wasm', candidateRoot)),
    ]);
    const failed = loaded.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    const [javascript, wasm] = loaded.map(result => result.value);
    if (javascript.byteLength !== receipt.javascriptSize || await digest(javascript) !== receipt.javascriptSha256 ||
        wasm.byteLength !== receipt.wasmSize || await digest(wasm) !== receipt.wasmSha256)
      throw Error('Native wasm-opt asset integrity failed');
    // Candidate paths are immutable during a benchmark run. Production bundles
    // will provide the same URLs through the verified tool asset loader.
    javascriptUrl = new URL('wasm-opt.js', candidateRoot).href;
    wasmUrl = new URL('wasm-opt.wasm', candidateRoot).href;
    const createWasmOpt = (await import(javascriptUrl)).default;
    workerCount = 0;
    runtime = await createWasmOpt({
      noInitialRun: true,
      noExitRuntime: true,
      pthreadPoolSize: requestedWorkers,
      environment: { BINARYEN_CORES: String(requestedWorkers) },
      pthreadWorkerUrl: javascriptUrl,
      locateFile: name => name === 'wasm-opt.wasm' ? wasmUrl : (() => { throw Error('Unexpected native wasm-opt asset'); })(),
      onPthreadWorker: () => workerCount++,
      print: text => stdout.push(String(text)),
      printErr: text => stderr.push(String(text)),
    });
    if (workerCount !== requestedWorkers) throw Error('Native wasm-opt pthread pool did not initialize');
    return { receipt, hardwareConcurrency: navigator.hardwareConcurrency || 1 };
  })().catch(error => { initialized = undefined; throw error; });
}

function clean(names) {
  for (const name of names) {
    try { runtime.FS.unlink(name); } catch {}
  }
}

serveWorker(async data => {
  if (!['initialize', 'wasm-opt'].includes(data.operation)) throw Error('Unsupported native wasm-opt operation');
  const metadata = await initialize(data.candidateRoot, data.workerCount);
  if (data.operation === 'initialize') return { success: true, workerCount, ...metadata };
  if (!Array.isArray(data.args) || data.args.length > 256 || !data.args.every(argument => typeof argument === 'string' && argument.length <= 4096) ||
      !Array.isArray(data.outputs) || data.outputs.length > 16 || !data.outputs.every(validPath))
    throw Error('Invalid native wasm-opt request');
  const files = ownedFiles(data.files, limits.maximumInputBytes);
  if (!Object.keys(files).every(validPath)) throw Error('Invalid native wasm-opt input path');
  const names = [...new Set([...Object.keys(files), ...data.outputs])];
  clean(names);
  stdout = []; stderr = [];
  try {
    for (const [name, bytes] of Object.entries(files)) runtime.FS.writeFile(name, bytes);
    const started = performance.now();
    let exitCode = 0;
    try { exitCode = runtime.callMain(data.args); }
    catch (error) {
      if (!Number.isInteger(error?.status)) throw error;
      exitCode = error.status;
    }
    const optimizationMilliseconds = performance.now() - started;
    const outputs = {};
    let outputBytes = 0;
    for (const name of data.outputs) {
      const bytes = runtime.FS.readFile(name).slice();
      outputBytes += bytes.byteLength;
      if (outputBytes > limits.maximumOutputBytes) throw Error('Native wasm-opt output byte limit exceeded');
      outputs[name] = bytes;
    }
    return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n'), files: outputs,
      workerCount: configuredWorkers, pthreadPoolSize: workerCount,
      hardwareConcurrency: metadata.hardwareConcurrency, optimizationMilliseconds };
  } catch (error) {
    throw Error(errorText(error));
  } finally { clean(names); }
});
