import { WorkerChannel } from '../worker-channel';

export const recommendedNativeWasmOptWorkers = () =>
  Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 4) - 2));

export const supportsNativeWasmOpt = () => {
  if (!crossOriginIsolated || typeof SharedArrayBuffer !== 'function') return false;
  try {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    return memory.buffer instanceof SharedArrayBuffer;
  } catch { return false; }
};

export function createNativeWasmOptChannel(candidateRoot, wasmProvider, workerCount, signal = () => {}) {
  if (typeof wasmProvider !== 'function') throw Error('Native wasm-opt module provider is required');
  workerCount ??= recommendedNativeWasmOptWorkers();
  const channel = new WorkerChannel(new URL('./native-wasm-opt-worker.mjs', import.meta.url), signal);
  let initialization;
  const initialize = () => initialization ??= Promise.resolve(wasmProvider()).then(wasm => {
    if (!(wasm instanceof Uint8Array) || wasm.byteLength < 1)
      throw Error('Native wasm-opt module provider returned invalid bytes');
    return channel.request({ operation: 'initialize', candidateRoot, workerCount, wasm },
      [wasm.buffer], 120_000);
  }).catch(error => { initialization = undefined; throw error; });
  return {
    initialize,
    async request(data, transfers = [], timeout = 300_000) {
      await initialize();
      if (data.operation !== 'wasm-opt') throw Error('Unsupported native wasm-opt channel operation');
      return channel.request({ ...data, candidateRoot, workerCount }, transfers, timeout);
    },
    reset(reason) { channel.reset(reason); initialization = undefined; },
  };
}
