const compiler = new Worker('./compiler-worker.mjs', { type: 'module' });
const tools = new Worker('./tools/worker.js', { type: 'module' });
const lld = new Worker('./lld-worker.mjs', { type: 'module' });
let nextId = 0;
const pending = new Map();
let readyResolve, readyReject;
window.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
for (const worker of [compiler, tools, lld]) {
  worker.onmessage = ({ data }) => {
    if (data.ready) { readyResolve(); return; }
    if (data.fatal) { readyReject(new Error(data.fatal)); return; }
    if (data.started || data.toolEntered) return;
    const call = pending.get(data.id);
    if (!call) return;
    pending.delete(data.id); clearTimeout(call.timer);
    data.error ? call.reject(new Error(data.error)) : call.resolve(data.result);
  };
  worker.onerror = event => {
    readyReject(new Error(event.message));
    for (const [id, call] of pending) if (call.worker === worker) {
      clearTimeout(call.timer); pending.delete(id); call.reject(new Error(event.message));
    }
  };
}
function invoke(worker, data) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id); worker.terminate(); reject(new Error('Browser stage timeout'));
    }, 120_000);
    pending.set(id, { resolve, reject, timer, worker }); worker.postMessage({ ...data, id });
  });
}
const decode = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));
const encode = bytes => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
const basename = path => path.slice(path.lastIndexOf('/') + 1);
function requireTool(result) {
  if (result.exitCode !== 0) throw new Error(`Browser tool failed: ${result.stderr || result.failure}`);
  return result;
}
window.link = async (source, invalid = false) => {
  await window.ready;
  const stages = [];
  async function stage(name, action) {
    const start = performance.now(); const result = await action();
    stages.push({ name, milliseconds: performance.now() - start }); return result;
  }
  const compilation = await stage('compile', () => invoke(compiler,
    { schemaVersion: 1, recipe: 'hello', source }));
  if (!compilation.success) return { success: false, stage: compilation.stage, compilation, stages };
  const runtime = await stage('runtime-link', () => invoke(lld, { plan: compilation.runtimeLinkPlan, invalid }));
  if (!runtime.success) return { success: false, stage: 'runtime-link', runtime, stages };
  const files = { 'application.wasm': Array.from(decode(compilation.application)),
    'runtime.wasm': Array.from(runtime.bytes) };
  const plan = compilation.coreLinkPlan;
  await stage('tool-initialize', () => invoke(tools, { operation: 'initialize' }));
  for (const module of plan.TextModules) {
    const output = basename(module.OutputPath); const input = `${output}.wat`;
    const result = await stage(`parse-${output}`, async () => requireTool(await invoke(tools,
      { operation: 'wasm-tools', args: ['parse', input, '--output', output],
        files: { [input]: Array.from(new TextEncoder().encode(module.Text)) }, outputs: [output] })));
    files[output] = result.files[output];
  }
  const pathArguments = invocation => invocation.Arguments.map(arg => arg.startsWith('/netwasm-link/') ? basename(arg) : arg);
  const merged = await stage('merge', async () => requireTool(await invoke(tools,
    { operation: 'wasm-merge', args: pathArguments(plan.Merge), files, outputs: [basename(plan.ExportPruning.InputPath)] })));
  const pruning = await stage('prune', () => invoke(compiler, { schemaVersion: 1, recipe: 'hello', operation: 'prune',
    module: encode(merged.files[basename(plan.ExportPruning.InputPath)]), prefix: plan.ExportPruning.Prefix }));
  const sanitized = decode(pruning.module);
  const optimized = await stage('optimize', async () => requireTool(await invoke(tools,
    { operation: 'wasm-opt', args: pathArguments(plan.Optimization),
      files: { [basename(plan.ExportPruning.OutputPath)]: Array.from(sanitized) }, outputs: ['linked.wasm'] })));
  const linked = optimized.files['linked.wasm'];
  await stage('validate', async () => requireTool(await invoke(tools,
    { operation: 'wasm-tools', args: ['validate', 'linked.wasm'], files: { 'linked.wasm': linked }, outputs: [] })));
  return { success: true, linked, runtime: { ...runtime, bytes: undefined }, stages,
    compilation: { ...compilation, pe: undefined, application: undefined },
    sanitizedBytes: sanitized.length, toolMemoryBytes: optimized.memoryBytes };
};
window.stop = () => { for (const worker of [compiler, tools, lld]) worker.terminate(); };
