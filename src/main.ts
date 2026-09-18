import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/languages/definitions/csharp/register';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/hover/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { PlaygroundPipeline } from './pipeline';
import type { CompilationResult, Diagnostic, PipelineEvent, SourceSnapshot, StageTiming, ToolchainPreloadProgress } from './contracts';
import { examples } from './examples';
import { formatTestReport } from './tunit-report';
import './style.css';
import { browserSupportMessage } from './browser-support';
import { optimizationLabels, optimizationModes, type OptimizationMode } from './optimization';
import { clearFrontendCache } from './workers/frontend-cache.mjs';

(globalThis as typeof globalThis & { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header><div class="brand"><a href="https://www.netwasm.com/">NetWasm</a> <span>Playground</span></div><span class="badge">C# → WebAssembly</span></header>
<main><section class="intro"><h1>Small code. Real WebAssembly.</h1><p>Compiled locally in your browser. Your source code never leaves this page.</p></section>
<section class="workbench" aria-label="C# playground"><aside class="compile-notice"><span aria-hidden="true">⏱</span><p><strong>Browser compilation is slower.</strong> NetWasm's compiler currently runs in Mono interpreter mode on a single browser thread because Microsoft's browser AOT compiler miscompiles this workload and can crash with memory-access violations. Even simple samples can take tens of seconds. Optimization defaults to <b>-Oz</b> for the smallest output; choose <b>None</b> for the fastest compile-and-test loop.</p></aside><div class="toolbar"><div class="options"><label class="recipe">Example <select id="example" aria-label="Example"></select></label><label class="recipe">Optimization <select id="optimization" aria-label="Optimization"></select></label></div><div class="actions"><button id="compile"><span class="compile-spinner" aria-hidden="true"></span>Compile</button><button id="run" class="primary">Run <span aria-hidden="true">▶</span></button><button id="stop" disabled>Stop</button><button id="download" disabled>Download</button></div></div>
<div class="panes"><section class="source-pane"><div class="pane-heading"><h2 id="source-name">Program.cs</h2><span>C# · Release</span></div><div id="editor" aria-label="C# source editor"></div></section><section class="results-pane"><div class="pane-heading"><h2>Console</h2><span id="exit"></span></div><pre id="output" tabindex="0" aria-label="Program output"></pre><div class="diagnostic-heading"><h2>Diagnostics</h2><span id="diagnostic-count">0</span></div><div id="diagnostics" aria-label="Compiler diagnostics"><p class="empty">Compile to check your source.</p></div></section></div>
<div id="toolchain-progress" class="toolchain-progress" role="status" aria-live="polite" hidden><div><strong>Preparing toolchain in the background</strong><span id="toolchain-progress-detail">Reading manifest…</span></div><progress id="toolchain-progress-bar" aria-label="Toolchain preload progress"></progress></div><footer class="results"><div id="status" role="status" aria-live="polite">Ready</div><div id="size">No component yet</div></footer><div class="details"><ol id="stages" aria-label="Pipeline progress"></ol><div id="timings"></div><div id="comparison"></div><div id="assets"></div></div></section><p class="cache-note">Reusable compiler artifacts stay in this browser so later compilations can be faster. Source files are not stored. <button id="clear-cache" type="button">Clear compilation cache</button></p><p id="footnote" class="footnote">One file, no setup. Download the compiled WASI Preview 2 component to run with Wasmtime.</p><p class="footnote">Current Chromium and Firefox recommended. Safari support is experimental.</p></main>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const compileButton = el<HTMLButtonElement>('compile');
const runButton = el<HTMLButtonElement>('run');
const stopButton = el<HTMLButtonElement>('stop');
const downloadButton = el<HTMLButtonElement>('download');
const clearCacheButton = el<HTMLButtonElement>('clear-cache');
const exampleSelect = el<HTMLSelectElement>('example');
const optimizationSelect = el<HTMLSelectElement>('optimization');
for (const example of examples) { const option = document.createElement('option'); option.value = example.id; option.textContent = example.name; exampleSelect.append(option); }
for (const mode of optimizationModes) { const option = document.createElement('option'); option.value = mode; option.textContent = optimizationLabels[mode]; optimizationSelect.append(option); }
optimizationSelect.value = 'Oz';
const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
const editor = monaco.editor.create(el('editor'), { value: examples[0].source, language: 'csharp', theme: colorScheme.matches ? 'vs-dark' : 'vs', automaticLayout: true, minimap: { enabled: false }, fontSize: 14, lineHeight: 23, scrollBeyondLastLine: false, scrollbar: { alwaysConsumeMouseWheel: false }, padding: { top: 18 }, tabSize: 4, fixedOverflowWidgets: true, accessibilitySupport: 'auto' });
colorScheme.addEventListener('change', event => monaco.editor.setTheme(event.matches ? 'vs-dark' : 'vs'));
let revision = 0;
let nextRequest = 0;
let active: SourceSnapshot | undefined;
let queued: { snapshot: SourceSnapshot; run: boolean } | undefined;
let compilation: CompilationResult | undefined;
let downloadUrl: string | undefined;
let stopped = false;
let unsupported: string | undefined;
let pipeline: PlaygroundPipeline | undefined;
const comparisons = new Map<OptimizationMode, { bytes: number; milliseconds: number }>();
const stages = new Map<string, HTMLLIElement>();
const progressSteps: Record<string, number> = {
  download: 1, 'compiler-initialize': 2,
  compile: 3, roslyn: 3, generator: 3, netwasm: 3, 'cache-read': 3, 'cache-write': 3,
  'linker-initialize': 4, 'tools-initialize': 4, link: 4, parse: 4,
  merge: 5, prune: 5, optimize: 6, validate: 7, componentization: 7, run: 8,
};
const stageLabels: Record<string, string> = {
  download: 'Loading toolchain manifest', 'compiler-initialize': 'Loading C# compiler',
  compile: 'Compiling C#', roslyn: 'Checking C#', generator: 'Generating source', netwasm: 'Compiling WebAssembly',
  'cache-read': 'Reading compiler cache', 'cache-write': 'Saving compiler cache',
  'linker-initialize': 'Loading linker', 'tools-initialize': 'Loading WebAssembly tools',
  link: 'Linking runtime', parse: 'Preparing runtime modules', merge: 'Combining modules',
  prune: 'Removing unused exports', optimize: 'Optimizing WebAssembly',
  validate: 'Validating WebAssembly', componentization: 'Packaging component', run: 'Running program',
};
let progressTotal = 8;
let runOnly = false;

const formatBytes = (bytes: number) => `${bytes.toLocaleString()} bytes`;
const formatMegabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
const errorSummary = (error: unknown) => String(error).split('\n')[0].slice(0, 300);
function invalidateDownload() { compilation = undefined; downloadButton.disabled = true; if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = undefined; el('size').textContent = 'No current component'; }
function showComparisons() {
  el('comparison').textContent = [...comparisons].map(([mode, result]) =>
    `${optimizationLabels[mode]}: ${formatBytes(result.bytes)} · ${(result.milliseconds / 1000).toFixed(2)} s`).join('  |  ');
}
function setDiagnostics(diagnostics: Diagnostic[]) {
  const model = editor.getModel()!;
  monaco.editor.setModelMarkers(model, 'roslyn', diagnostics.map(d => ({ message: `${d.code}: ${d.message}`, severity: d.severity.toLowerCase() === 'error' ? monaco.MarkerSeverity.Error : d.severity.toLowerCase() === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info, startLineNumber: (d.line ?? 0) + 1, endLineNumber: (d.line ?? 0) + 1, startColumn: (d.column ?? 0) + 1, endColumn: (d.column ?? 0) + 2 })));
  el('diagnostic-count').textContent = diagnostics.length >= 128 ? `${diagnostics.length} · limit reached` : String(diagnostics.length);
  el('diagnostics').replaceChildren();
  if (!diagnostics.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'No diagnostics.'; el('diagnostics').append(p); }
  for (const d of diagnostics) { const button = document.createElement('button'); button.className = 'diagnostic'; button.textContent = `${d.line === undefined ? '' : `${d.line + 1}:${(d.column ?? 0) + 1} · `}${d.code} ${d.message}`; button.onclick = () => { const position = { lineNumber: (d.line ?? 0) + 1, column: (d.column ?? 0) + 1 }; editor.setPosition(position); editor.revealPositionInCenter(position); editor.focus(); }; el('diagnostics').append(button); }
}
function showTimings(timings: StageTiming[]) { el('timings').textContent = timings.map(t => `${t.stage}: ${(t.milliseconds / 1000).toFixed(2)} s`).join(' · '); }
function onEvent(event: PipelineEvent) {
  if (!active || stopped || event.requestId !== active.requestId || event.revision !== revision) return;
  if (event.type === 'console') el('output').textContent += event.text;
  if (event.type === 'assets') el('assets').textContent = `Tool assets: ${formatBytes(event.transferBytes)} transfer cost · ${formatBytes(event.rawBytes)} uncompressed`;
  if (event.type === 'stage') { const activeOptimization = active.optimization ?? 'Oz'; const optimized = activeOptimization !== 'none'; const label = event.stage === 'optimize' ? `${stageLabels.optimize} (-${activeOptimization})` : stageLabels[event.stage] ?? event.stage; let item = stages.get(event.stage); if (!item) { item = document.createElement('li'); item.textContent = label; item.dataset.stage = event.stage; stages.set(event.stage, item); el('stages').append(item); } item.dataset.state = event.state; let step = runOnly ? 1 : progressSteps[event.stage]; if (!optimized && step && step >= 7) step--; if (step && event.state === 'running') el('status').textContent = `Step ${step} of ${progressTotal} · ${label}`; }
}
function showPreloadProgress(progress: ToolchainPreloadProgress) {
  const container = el('toolchain-progress');
  const bar = el<HTMLProgressElement>('toolchain-progress-bar');
  container.hidden = false;
  container.dataset.completedBundles = String(progress.completedBundles);
  container.dataset.totalBundles = String(progress.totalBundles);
  container.dataset.loadedBundleBytes = String(progress.loadedBundleBytes);
  container.dataset.totalBundleBytes = String(progress.totalBundleBytes);
  if (!progress.totalBundles) {
    bar.removeAttribute('value');
    el('toolchain-progress-detail').textContent = 'Reading manifest…';
    return;
  }
  bar.max = progress.totalBundleBytes;
  bar.value = progress.loadedBundleBytes;
  const percentage = Math.round(progress.loadedBundleBytes / progress.totalBundleBytes * 100);
  el('toolchain-progress-detail').textContent = `${percentage}% · ${progress.completedBundles} of ${progress.totalBundles} bundles · ${formatMegabytes(progress.loadedBundleBytes)} of ${formatMegabytes(progress.totalBundleBytes)} loaded`;
  if (!active && el('status').textContent.startsWith('Preparing toolchain')) el('status').textContent = `Preparing toolchain · ${percentage}%`;
}
editor.onDidChangeModelContent(() => { revision++; comparisons.clear(); showComparisons(); invalidateDownload(); setDiagnostics([]); el('status').textContent = unsupported ?? (active ? 'Source changed · result pending for earlier revision' : 'Source changed'); });
exampleSelect.onchange = () => {
  comparisons.clear(); showComparisons();
  const example = examples.find(example => example.id === exampleSelect.value);
  if (!example) return;
  const previousRevision = revision;
  editor.setValue(example.source);
  // A recipe change must invalidate its artifact even when the source is equal.
  if (revision === previousRevision) { revision++; invalidateDownload(); setDiagnostics([]); el('status').textContent = 'Example changed'; }
  el('source-name').textContent = example.id === 'tunit' ? 'Tests.cs' : 'Program.cs';
  el('footnote').textContent = example.id === 'tunit' ? 'TUnit uses the NetWasm asynchronous component host and the generated guest test runner.' : 'One file, no setup. Download the compiled WASI Preview 2 component to run with Wasmtime.';
  editor.setScrollTop(0);
  editor.setPosition({ lineNumber: 1, column: 1 });
};
optimizationSelect.onchange = () => { invalidateDownload(); el('status').textContent = `Optimization changed to ${optimizationLabels[optimizationSelect.value as OptimizationMode]}`; };
function snapshot(): SourceSnapshot { return { requestId: ++nextRequest, revision, source: editor.getValue(), recipeId: exampleSelect.value, optimization: optimizationSelect.value as OptimizationMode }; }
function request(run: boolean) { const job = { snapshot: snapshot(), run }; if (active) { queued = job; el('status').textContent = 'Latest request queued'; } else void execute(job); }
async function execute(job: { snapshot: SourceSnapshot; run: boolean }) {
  runOnly = job.run && !!compilation?.success && compilation.revision === job.snapshot.revision && compilation.optimization === job.snapshot.optimization;
  const optimized = job.snapshot.optimization !== 'none';
  progressTotal = runOnly ? 1 : job.run ? (optimized ? 8 : 7) : (optimized ? 7 : 6);
  compileButton.disabled = true; runButton.disabled = true; optimizationSelect.disabled = true; clearCacheButton.disabled = true;
  document.querySelector('.workbench')!.setAttribute('aria-busy', 'true');
  active = job.snapshot; stopped = false; stopButton.disabled = false; stages.clear(); el('stages').replaceChildren(); el('output').textContent = ''; el('exit').textContent = ''; el('timings').textContent = ''; el('status').textContent = 'Starting';
  pipeline ??= new PlaygroundPipeline(onEvent);
  try {
    let result = compilation;
    if (!job.run || !result?.success || result.revision !== job.snapshot.revision || result.optimization !== job.snapshot.optimization) {
      result = await pipeline.compile(job.snapshot);
      if (!stopped && revision === job.snapshot.revision) {
        setDiagnostics(result.diagnostics); showTimings(result.timings);
        if (result.success && result.component) { invalidateDownload(); compilation = result; downloadUrl = URL.createObjectURL(new Blob([new Uint8Array(result.component)], { type: 'application/wasm' })); downloadButton.disabled = false; el('size').textContent = `${optimizationLabels[result.optimization ?? 'Oz']} · ${formatBytes(result.component.byteLength)}`; const exclusive = result.timings.filter(t => !['generator', 'roslyn', 'netwasm'].includes(t.stage)).reduce((total, timing) => total + timing.milliseconds, 0); comparisons.set(result.optimization ?? 'Oz', { bytes: result.component.byteLength, milliseconds: exclusive }); showComparisons(); }
        else { invalidateDownload(); el('status').textContent = result.cancelled ? 'Stopped' : result.error ? errorSummary(result.error) : 'Compilation failed'; }
      }
    }
    if (job.run && result?.success && !stopped && revision === job.snapshot.revision) {
      const run = await pipeline.run(result, job.snapshot);
      if (!stopped && revision === job.snapshot.revision) { el('output').textContent = run.stdout + run.stderr; el('exit').textContent = run.exitCode === undefined ? '' : `Exit ${run.exitCode}`; showTimings([...result.timings, ...run.timings]); el('status').textContent = run.cancelled ? 'Stopped' : run.success ? 'Run complete' : run.error ? errorSummary(run.error) : 'Run failed'; if (job.snapshot.recipeId === 'tunit' && !run.cancelled && !run.error && run.exitCode !== undefined) { const report = formatTestReport(run.stdout); el('output').textContent = report.text + run.stderr; el('status').textContent = `Tests complete · ${report.passed} passed · ${report.failed} failed`; } }
    } else if (!stopped && result?.success && revision === job.snapshot.revision) el('status').textContent = 'Compilation complete';
  } catch (error) { if (!stopped && revision === job.snapshot.revision) el('status').textContent = errorSummary(error); }
  finally { active = undefined; stopButton.disabled = true; compileButton.disabled = !!unsupported; runButton.disabled = !!unsupported; optimizationSelect.disabled = false; clearCacheButton.disabled = false; document.querySelector('.workbench')!.setAttribute('aria-busy', 'false'); const next = queued; queued = undefined; if (next) void execute(next); }
}
unsupported = browserSupportMessage();
if (unsupported) { compileButton.disabled = true; runButton.disabled = true; el('status').textContent = unsupported; }
else {
  pipeline = new PlaygroundPipeline(onEvent);
  (document.querySelector('.workbench') as HTMLElement).dataset.toolchainPreload = 'loading';
  el('status').textContent = 'Preparing toolchain in background…';
  // Let the editor paint, then begin fetching and initializing the heavy toolchain
  // without waiting for the user to choose Compile or Run.
  setTimeout(() => void pipeline!.preload(showPreloadProgress).then(assets => {
    (document.querySelector('.workbench') as HTMLElement).dataset.toolchainPreload = 'complete';
    el('assets').textContent = `Tool assets: ${formatBytes(assets.transferBytes)} transfer cost · ${formatBytes(assets.rawBytes)} uncompressed`;
    el('toolchain-progress').hidden = true;
    if (!active && el('status').textContent.startsWith('Preparing toolchain')) el('status').textContent = 'Ready · toolchain preloaded';
  }).catch(() => {
    (document.querySelector('.workbench') as HTMLElement).dataset.toolchainPreload = 'failed';
    el('toolchain-progress').hidden = true;
    if (!active && el('status').textContent.startsWith('Preparing toolchain')) el('status').textContent = 'Ready · toolchain will load when needed';
  }), 0);
}
compileButton.onclick = () => request(false);
runButton.onclick = () => request(true);
stopButton.onclick = () => { stopped = true; queued = undefined; pipeline?.stop(); stopButton.disabled = true; el('status').textContent = 'Stopped'; };
downloadButton.onclick = () => { if (!downloadUrl || compilation?.revision !== revision) return; const anchor = document.createElement('a'); anchor.href = downloadUrl; anchor.download = `program-${compilation.optimization ?? 'Oz'}.wasm`; anchor.click(); };
clearCacheButton.onclick = () => {
  clearCacheButton.disabled = true;
  void clearFrontendCache().then(() => {
    el('status').textContent = 'Compilation cache cleared';
  }).catch(error => {
    el('status').textContent = errorSummary(error);
  }).finally(() => { clearCacheButton.disabled = false; });
};
window.addEventListener('pagehide', () => { pipeline?.dispose(); if (downloadUrl) URL.revokeObjectURL(downloadUrl); editor.dispose(); });
