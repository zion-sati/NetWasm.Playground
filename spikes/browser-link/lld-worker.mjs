import loadLld from './lld/netwasm-browser-lld.mjs';
import { createBrowserLld } from './lld/netwasm-lld.mjs';

const linker = createBrowserLld(loadLld);
self.onmessage = async ({ data }) => {
  try {
    const files = {};
    for (const asset of data.plan.Inputs) {
      const response = await fetch(`./runtime/${asset.Path.split('/runtime/')[1]}`);
      if (!response.ok) throw new Error(`Runtime asset: HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map(x => x.toString(16).padStart(2, '0')).join('');
      if (hash !== asset.Sha256) throw new Error('Runtime asset SHA-256 mismatch');
      files[asset.Path] = bytes;
    }
    if (data.invalid) files[data.plan.Inputs[0].Path] = new TextEncoder().encode('invalid archive');
    const result = await linker.link({ arguments: data.plan.Arguments, files,
      outputPath: '/netwasm-link/runtime.wasm' });
    self.postMessage({ id: data.id, result }, result.bytes ? [result.bytes.buffer] : []);
  } catch (error) { self.postMessage({ id: data.id, error: String(error) }); }
};
