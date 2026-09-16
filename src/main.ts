import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/languages/definitions/csharp/register';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/hover/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { PlaygroundPipeline } from './pipeline';
import type { CompilationResult, Diagnostic, PipelineEvent, SourceSnapshot, StageTiming } from './contracts';
import { examples } from './examples';
import { formatTestReport } from './tunit-report';
import './style.css';
import { browserSupportMessage } from './browser-support';
import { optimizationLabels, optimizationModes, type OptimizationMode } from './optimization';

(globalThis as typeof globalThis & { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header><a class="brand" href="./">NetWasm <span>Playground</span></a><span class="badge">C# → WebAssembly</span></header>
<main><section class="intro"><h1>Small code. Real WebAssembly.</h1><p>Compiled locally in your browser. Your source code never leaves this page.</p></section>
<section class="workbench" aria-label="C# playground"><div class="toolbar"><div class="options"><label class="recipe">Example <select id="example" aria-label="Example"></select></label><label class="recipe">Optimization <select id="optimization" aria-label="Optimization"></select></label></div><div class="actions"><button id="compile"><span class="compile-spinner" aria-hidden="true"></span>Compile</button><button id="run" class="primary">Run <span aria-hidden="true">▶</span></button><button id="stop" disabled>Stop</button><button id="download" disabled>Download</button></div></div>
<div class="panes"><section class="source-pane"><div class="pane-heading"><h2 id="source-name">Program.cs</h2><span>C# · Release</span></div><div id="editor" aria-label="C# source editor"></div></section><section class="results-pane"><div class="pane-heading"><h2>Console</h2><span id="exit"></span></div><pre id="output" tabindex="0" aria-label="Program output"></pre><div class="diagnostic-heading"><h2>Diagnostics</h2><span id="diagnostic-count">0</span></div><div id="diagnostics" aria-label="Compiler diagnostics"><p class="empty">Compile to check your source.</p></div></section></div>
<footer class="results"><div id="status" role="status" aria-live="polite">Ready</div><div id="size">No component yet</div></footer><div class="details"><ol id="stages" aria-label="Pipeline progress"></ol><div id="timings"></div><div id="comparison"></div><div id="assets"></div></div></section><p id="footnote" class="footnote">One file, no setup. Download the compiled WASI Preview 2 component to run with Wasmtime.</p><p class="footnote">Current Chromium and Firefox recommended. Safari support is experimental.</p></main>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const compileButton = el<HTMLButtonElement>('compile');
const runButton = el<HTMLButtonElement>('run');
const stopButton = el<HTMLButtonElement>('stop');
const downloadButton = el<HTMLButtonElement>('download');
const exampleSelect = el<HTMLSelectElement>('example');
const optimizationSelect = el<HTMLSelectElement>('optimization');
for (const example of examples) { const option = document.createElement('option'); option.value = example.id; option.textContent = example.name; exampleSelect.append(option); }
for (const mode of optimizationModes) { const option = document.createElement('option'); option.value = mode; option.textContent = optimizationLabels[mode]; optimizationSelect.append(option); }
const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
const editor = monaco.editor.create(el('editor'), { value: examples[0].source, language: 'csharp', theme: colorScheme.matches ? 'vs-dark' : 'vs', automaticLayout: true, minimap: { enabled: false }, fontSize: 14, lineHeight: 23, scrollBeyondLastLine: false, padding: { top: 18 }, tabSize: 4, fixedOverflowWidgets: true, accessibilitySupport: 'auto' });
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
  compile: 3, roslyn: 3, generator: 3, netwasm: 3,
  'linker-initialize': 4, 'tools-initialize': 4, link: 4, parse: 4,
  merge: 5, prune: 5, optimize: 6, validate: 7, componentization: 7, run: 8,
};
const stageLabels: Record<string, string> = {
  download: 'Loading toolchain manifest', 'compiler-initialize': 'Loading C# compiler',
  compile: 'Compiling C#', roslyn: 'Checking C#', generator: 'Generating source', netwasm: 'Compiling WebAssembly',
  'linker-initialize': 'Loading linker', 'tools-initialize': 'Loading WebAssembly tools',
  link: 'Linking runtime', parse: 'Preparing runtime modules', merge: 'Combining modules',
  prune: 'Removing unused exports', optimize: 'Optimizing WebAssembly',
  validate: 'Validating WebAssembly', componentization: 'Packaging component', run: 'Running program',
};
let progressTotal = 8;
let runOnly = false;

const formatBytes = (bytes: number) => `${bytes.toLocaleString()} bytes`;
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
  if (event.type === 'stage') { const activeOptimization = active.optimization ?? 'Oz'; const optimized = activeOptimization !== 'none'; const label = event.stage === 'optimize' ? `${stageLabels.optimize} (-${activeOptimization})` : stageLabels[event.stage] ?? event.stage; let item = stages.get(event.stage); if (!item) { item = document.createElement('li'); item.textContent = label; stages.set(event.stage, item); el('stages').append(item); } item.dataset.state = event.state; let step = runOnly ? 1 : progressSteps[event.stage]; if (!optimized && step && step >= 7) step--; if (step && event.state === 'running') el('status').textContent = `Step ${step} of ${progressTotal} · ${label}`; }
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
  compileButton.disabled = true; runButton.disabled = true; optimizationSelect.disabled = true;
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
  finally { active = undefined; stopButton.disabled = true; compileButton.disabled = !!unsupported; runButton.disabled = !!unsupported; optimizationSelect.disabled = false; document.querySelector('.workbench')!.setAttribute('aria-busy', 'false'); const next = queued; queued = undefined; if (next) void execute(next); }
}
unsupported = browserSupportMessage();
if (unsupported) { compileButton.disabled = true; runButton.disabled = true; el('status').textContent = unsupported; }
compileButton.onclick = () => request(false);
runButton.onclick = () => request(true);
stopButton.onclick = () => { stopped = true; queued = undefined; pipeline?.stop(); stopButton.disabled = true; el('status').textContent = 'Stopped'; };
downloadButton.onclick = () => { if (!downloadUrl || compilation?.revision !== revision) return; const anchor = document.createElement('a'); anchor.href = downloadUrl; anchor.download = `program-${compilation.optimization ?? 'Oz'}.wasm`; anchor.click(); };
window.addEventListener('pagehide', () => { pipeline?.dispose(); if (downloadUrl) URL.revokeObjectURL(downloadUrl); editor.dispose(); });
