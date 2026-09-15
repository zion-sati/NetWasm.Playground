import './pipeline.mjs';
const tools = new Worker('./tools/worker.js', { type: 'module' });
let nextId = 0, guest, guestPending, downloadUrl;
const pending = new Map();
tools.onmessage = ({ data }) => {
  if (data.started || data.toolEntered) return;
  const call = pending.get(data.id); if (!call) return;
  clearTimeout(call.timer); pending.delete(data.id);
  data.error ? call.reject(new Error(data.error)) : call.resolve(data.result);
};
tools.onerror = event => {
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error(event.message)); }
  pending.clear(); tools.terminate();
};
function tool(args, files, outputs) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { tools.terminate(); pending.delete(id); reject(new Error('Component tool timeout')); }, 120_000);
    pending.set(id, { resolve: result => result.exitCode === 0 ? resolve(result) : reject(new Error(result.stderr)), reject, timer });
    tools.postMessage({ id, operation: 'wasm-tools', args, files, outputs });
  });
}
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
window.runComponent = async source => {
  if (guest) guest.terminate();
  window.guestEntered = false;
  document.querySelector('#bytes').textContent = '';
  document.querySelector('#download').hidden = true;
  if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = undefined; }
  const linked = await window.link(source);
  if (!linked.success) return linked;
  const initialized = await new Promise((resolve, reject) => {
    const id = ++nextId; const timer = setTimeout(() => reject(new Error('Tool initialization timeout')), 120_000);
    pending.set(id, { resolve, reject, timer }); tools.postMessage({ id, operation: 'initialize' });
  });
  const witResponse = await fetch('./command.wit.wasm');
  if (!witResponse.ok) throw new Error('Command WIT unavailable');
  const wit = Array.from(new Uint8Array(await witResponse.arrayBuffer()));
  const stages = [];
  let started = performance.now();
  const embedded = await tool(['component', 'embed', 'command.wit.wasm', 'linked.wasm', '--encoding', 'utf8',
    '--output', 'embedded.wasm', '--world', 'wasi:cli/command@0.2.11'],
    { 'command.wit.wasm': wit, 'linked.wasm': linked.linked }, ['embedded.wasm']);
  stages.push({ name: 'embed', milliseconds: performance.now() - started });
  started = performance.now();
  const packaged = await tool(['component', 'new', 'embedded.wasm', '--output', 'component.wasm'],
    { 'embedded.wasm': embedded.files['embedded.wasm'] }, ['component.wasm']);
  stages.push({ name: 'component-new', milliseconds: performance.now() - started });
  const component = Uint8Array.from(packaged.files['component.wasm']);
  await tool(['validate', 'component.wasm', '--features', 'all'], { 'component.wasm': Array.from(component) }, []);
  const sha256 = await hash(component);
  downloadUrl = URL.createObjectURL(new Blob([component], { type: 'application/wasm' }));
  const download = document.querySelector('#download');
  download.href = downloadUrl; download.hidden = false;
  document.querySelector('#bytes').textContent = `${component.length} bytes`;
  if (guest) guest.terminate();
  guest = new Worker('./guest-worker.mjs', { type: 'module' });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      guest.terminate(); guestPending = undefined; document.querySelector('#stop').disabled = true;
      reject(new Error('Guest execution timeout'));
    }, 60_000);
    guestPending = { timer, reject };
    document.querySelector('#stop').disabled = false;
    guest.onmessage = ({ data }) => {
      if (data.guestEntered) { window.guestEntered = true; return; }
      if (data.console) {
        const output = document.querySelector(`#${data.console}`);
        output.textContent += new TextDecoder().decode(data.bytes); return;
      }
      clearTimeout(timer); guestPending = undefined; document.querySelector('#stop').disabled = true; resolve(data.result);
    };
    guest.onerror = event => {
      clearTimeout(timer); guest.terminate(); guestPending = undefined;
      document.querySelector('#stop').disabled = true; reject(new Error(event.message));
    };
    const transferred = component.slice();
    guest.postMessage({ id: 1, component: transferred.buffer, sha256, arguments: [] }, [transferred.buffer]);
  });
  return { ...result, component: Array.from(component),
    linked: { ...linked, linked: undefined }, packagingStages: stages, toolPreview1Imports: initialized.imports };
};
window.stopComponent = () => {
  guest?.terminate();
  if (guestPending) { clearTimeout(guestPending.timer); guestPending.reject(new Error('Stopped')); guestPending = undefined; }
  document.querySelector('#stop').disabled = true;
};
document.querySelector('#stop').onclick = window.stopComponent;
window.ready.then(() => { document.querySelector('#run').disabled = false; document.querySelector('#status').textContent = 'Ready'; });
document.querySelector('#run').onclick = async () => {
  const button = document.querySelector('#run'); button.disabled = true;
  window.lastComponentResult = undefined; document.querySelector('#stdout').textContent = ''; document.querySelector('#stderr').textContent = '';
  try {
    const result = await window.runComponent(document.querySelector('#source').value);
    window.lastComponentResult = result;
    document.querySelector('#stdout').textContent = result.stdout ?? '';
    document.querySelector('#stderr').textContent = result.stderr ?? result.error ?? '';
    document.querySelector('#status').textContent = result.success ? `Exited ${result.exitCode}` : 'Compilation or execution failed';
  } catch (error) {
    window.lastComponentResult = { success: false, stage: error.message === 'Stopped' ? 'cancelled' : 'guest', error: String(error) };
    document.querySelector('#status').textContent = error.message === 'Stopped' ? 'Stopped' : String(error);
  }
  finally { button.disabled = false; }
};
window.addEventListener('pagehide', () => { tools.terminate(); guest?.terminate(); window.stop(); if (downloadUrl) URL.revokeObjectURL(downloadUrl); });
