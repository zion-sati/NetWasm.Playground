import { WorkerChannel } from '../worker-channel';

export const recommendedNativeWasmOptWorkers = () =>
  Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 4) - 2));

export function createNativeWasmOptChannel(candidateRoot, workerCount, signal = () => {}) {
  workerCount ??= recommendedNativeWasmOptWorkers();
  const channel = new WorkerChannel(new URL('./native-wasm-opt-worker.mjs', import.meta.url), signal);
  let initialization;
  const initialize = () => initialization ??= channel.request({
    operation: 'initialize', candidateRoot, workerCount,
  }, [], 120_000).catch(error => { initialization = undefined; throw error; });
  return {
    async request(data, transfers = [], timeout = 300_000) {
      await initialize();
      if (data.operation !== 'wasm-opt') throw Error('Unsupported native wasm-opt channel operation');
      return channel.request({ ...data, candidateRoot, workerCount }, transfers, timeout);
    },
    reset(reason) { channel.reset(reason); initialization = undefined; },
  };
}
