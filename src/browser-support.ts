// Minimal core module containing an exnref parameter, parsed by pinned wasm-tools.
const exceptionReferences = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,1,105,0,3,2,1,0,10,4,1,2,0,11]);
export function browserSupportMessage(): string | undefined {
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) return 'Compilation requires HTTPS or localhost.';
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined' || typeof DecompressionStream === 'undefined') return 'This browser lacks required worker, WebAssembly or decompression support. Try a current Chromium or Firefox browser.';
  if (!WebAssembly.validate(exceptionReferences)) return 'This browser lacks WebAssembly exception references required by NetWasm. Try a current Chromium or Firefox browser.';
}
