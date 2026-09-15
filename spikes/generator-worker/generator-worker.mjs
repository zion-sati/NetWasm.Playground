const hex = bytes => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
const base64 = bytes => {
  let result = '';
  for (let start = 0; start < bytes.length; start += 8192)
    result += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(result);
};
try {
  const start = performance.now();
  const manifest = await (await fetch('./assets.json')).json();
  for (const [path, expected] of Object.entries(manifest.files)) {
    const bytes = await (await fetch(`./${path}`)).arrayBuffer();
    if (bytes.byteLength !== expected.bytes || hex(await crypto.subtle.digest('SHA-256', bytes)) !== expected.sha256)
      throw new Error('Trusted host asset integrity check failed');
  }
  const verifiedMilliseconds = performance.now() - start;
  const { dotnet } = await import('./_framework/dotnet.js');
  const runtime = await dotnet.create();
  const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
  const references = [];
  for (const path of manifest.references) {
    const bytes = new Uint8Array(await (await fetch(`./${path}`)).arrayBuffer());
    references.push({ path, bytes: base64(bytes) });
  }
  const referenceJson = JSON.stringify(references);
  self.onmessage = ({ data }) => {
    try {
      self.postMessage({ id: data.id, result: JSON.parse(
        exports.NetWasm.Playground.GeneratorProbe.Program.Generate(data.source, referenceJson)) });
    } catch (error) { self.postMessage({ id: data.id, error: String(error) }); }
  };
  self.postMessage({ ready: true, verifiedMilliseconds, readyMilliseconds: performance.now() - start,
    verifiedAssets: Object.keys(manifest.files).length });
} catch (error) { self.postMessage({ fatal: String(error) }); }
