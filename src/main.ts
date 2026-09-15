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

(globalThis as typeof globalThis & { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header><a class="brand" href="./">NetWasm <span>Playground</span></a><span class="badge">C# → WebAssembly</span></header>
<main><section class="intro"><h1>Small code. Real WebAssembly.</h1><p>Compiled locally in your browser. Your source code never leaves this page.</p></section>
<section class="workbench" aria-label="C# playground"><div class="toolbar"><label class="recipe">Example <select id="example" aria-label="Example"></select></label><div class="actions"><button id="compile">Compile</button><button id="run" class="primary">Run <span aria-hidden="true">▶</span></button><button id="stop" disabled>Stop</button><button id="download" disabled>Download</button></div></div>
<div class="panes"><section class="source-pane"><div class="pane-heading"><h2>Program.cs</h2><span>C# · Release</span></div><div id="editor" aria-label="C# source editor"></div></section><section class="results-pane"><div class="pane-heading"><h2>Console</h2><span id="exit"></span></div><pre id="output" tabindex="0" aria-label="Program output"></pre><div class="diagnostic-heading"><h2>Diagnostics</h2><span id="diagnostic-count">0</span></div><div id="diagnostics" aria-label="Compiler diagnostics"><p class="empty">Compile to check your source.</p></div></section></div>
<footer class="results"><div id="status" role="status" aria-live="polite">Ready</div><div id="size">No component yet</div></footer><div class="details"><ol id="stages" aria-label="Pipeline progress"></ol><div id="timings"></div><div id="assets"></div></div></section><p id="footnote" class="footnote">One file, no setup. Download the compiled WASI Preview 2 component to run with Wasmtime.</p></main>`;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
const compileButton = el<HTMLButtonElement>('compile');
const runButton = el<HTMLButtonElement>('run');
const stopButton = el<HTMLButtonElement>('stop');
const downloadButton = el<HTMLButtonElement>('download');
const exampleSelect = el<HTMLSelectElement>('example');
for (const example of examples) { const option = document.createElement('option'); option.value = example.id; option.textContent = example.name; exampleSelect.append(option); }
const editor = monaco.editor.create(el('editor'), { value: examples[0].source, language: 'csharp', theme: 'vs', automaticLayout: true, minimap: { enabled: false }, fontSize: 14, lineHeight: 23, scrollBeyondLastLine: false, padding: { top: 18 }, tabSize: 4, fixedOverflowWidgets: true, accessibilitySupport: 'auto' });
let revision = 0;
let nextRequest = 0;
let active: SourceSnapshot | undefined;
let queued: { snapshot: SourceSnapshot; run: boolean } | undefined;
let compilation: CompilationResult | undefined;
let downloadUrl: string | undefined;
let stopped = false;
let pipeline: PlaygroundPipeline | undefined;
const stages = new Map<string, HTMLLIElement>();
const formatBytes = (bytes: number) => `${bytes.toLocaleString()} bytes`;
const errorSummary = (error: unknown) => String(error).split('\n')[0].slice(0, 300);
function invalidateDownload() { compilation = undefined; downloadButton.disabled = true; if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = undefined; el('size').textContent = 'No current component'; }
function setDiagnostics(diagnostics: Diagnostic[]) {
  const model = editor.getModel()!;
  monaco.editor.setModelMarkers(model, 'roslyn', diagnostics.map(d => ({ message: `${d.code}: ${d.message}`, severity: d.severity.toLowerCase() === 'error' ? monaco.MarkerSeverity.Error : d.severity.toLowerCase() === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info, startLineNumber: (d.line ?? 0) + 1, endLineNumber: (d.line ?? 0) + 1, startColumn: (d.column ?? 0) + 1, endColumn: (d.column ?? 0) + 2 })));
  el('diagnostic-count').textContent = String(diagnostics.length);
  el('diagnostics').replaceChildren();
  if (!diagnostics.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'No diagnostics.'; el('diagnostics').append(p); }
  for (const d of diagnostics) { const button = document.createElement('button'); button.className = 'diagnostic'; button.textContent = `${d.line === undefined ? '' : `${d.line + 1}:${(d.column ?? 0) + 1} · `}${d.code} ${d.message}`; button.onclick = () => { const position = { lineNumber: (d.line ?? 0) + 1, column: (d.column ?? 0) + 1 }; editor.setPosition(position); editor.revealPositionInCenter(position); editor.focus(); }; el('diagnostics').append(button); }
}
function showTimings(timings: StageTiming[]) { el('timings').textContent = timings.map(t => `${t.stage}: ${(t.milliseconds / 1000).toFixed(2)} s`).join(' · '); }
function onEvent(event: PipelineEvent) {
  if (!active || stopped || event.requestId !== active.requestId || event.revision !== revision) return;
  if (event.type === 'console') el('output').textContent += event.text;
  if (event.type === 'assets') el('assets').textContent = `Tool assets: ${formatBytes(event.transferBytes)} transfer cost · ${formatBytes(event.rawBytes)} uncompressed`;
  if (event.type === 'stage') { let item = stages.get(event.stage); if (!item) { item = document.createElement('li'); item.textContent = event.stage; stages.set(event.stage, item); el('stages').append(item); } item.dataset.state = event.state; el('status').textContent = event.state === 'running' ? event.stage : `${event.stage} complete`; }
}
editor.onDidChangeModelContent(() => { revision++; invalidateDownload(); setDiagnostics([]); el('status').textContent = active ? 'Source changed · result pending for earlier revision' : 'Source changed'; });
exampleSelect.onchange = () => {
  const example = examples.find(example => example.id === exampleSelect.value);
  if (!example) return;
  const previousRevision = revision;
  editor.setValue(example.source);
  // A recipe change must invalidate its artifact even when the source is equal.
  if (revision === previousRevision) { revision++; invalidateDownload(); setDiagnostics([]); el('status').textContent = 'Example changed'; }
  el('footnote').textContent = example.id === 'tunit' ? 'TUnit uses the NetWasm asynchronous component host and the generated guest test runner.' : 'One file, no setup. Download the compiled WASI Preview 2 component to run with Wasmtime.';
  editor.setScrollTop(0);
  editor.setPosition({ lineNumber: 1, column: 1 });
};
function snapshot(): SourceSnapshot { return { requestId: ++nextRequest, revision, source: editor.getValue(), recipeId: exampleSelect.value }; }
function request(run: boolean) { const job = { snapshot: snapshot(), run }; if (active) { queued = job; el('status').textContent = 'Latest request queued'; } else void execute(job); }
async function execute(job: { snapshot: SourceSnapshot; run: boolean }) {
  active = job.snapshot; stopped = false; stopButton.disabled = false; stages.clear(); el('stages').replaceChildren(); el('output').textContent = ''; el('exit').textContent = ''; el('timings').textContent = ''; el('status').textContent = 'Starting';
  pipeline ??= new PlaygroundPipeline(onEvent);
  try {
    let result = compilation;
    if (!job.run || !result?.success || result.revision !== job.snapshot.revision) {
      result = await pipeline.compile(job.snapshot);
      if (!stopped && revision === job.snapshot.revision) {
        setDiagnostics(result.diagnostics); showTimings(result.timings);
        if (result.success && result.component) { invalidateDownload(); compilation = result; downloadUrl = URL.createObjectURL(new Blob([new Uint8Array(result.component)], { type: 'application/wasm' })); downloadButton.disabled = false; el('size').textContent = `Component · ${formatBytes(result.component.byteLength)}`; }
        else { invalidateDownload(); el('status').textContent = result.cancelled ? 'Stopped' : result.error ? errorSummary(result.error) : 'Compilation failed'; }
      }
    }
    if (job.run && result?.success && !stopped && revision === job.snapshot.revision) {
      const run = await pipeline.run(result, job.snapshot);
      if (!stopped && revision === job.snapshot.revision) { el('output').textContent = run.stdout + run.stderr; el('exit').textContent = run.exitCode === undefined ? '' : `Exit ${run.exitCode}`; showTimings([...result.timings, ...run.timings]); el('status').textContent = run.cancelled ? 'Stopped' : run.success ? 'Run complete' : run.error ? errorSummary(run.error) : 'Run failed'; if (job.snapshot.recipeId === 'tunit' && !run.cancelled && !run.error && run.exitCode !== undefined) { const report = formatTestReport(run.stdout); el('output').textContent = report.text + run.stderr; el('status').textContent = `Tests complete · ${report.passed} passed · ${report.failed} failed`; } }
    } else if (!stopped && result?.success && revision === job.snapshot.revision) el('status').textContent = 'Compilation complete';
  } catch (error) { if (!stopped && revision === job.snapshot.revision) el('status').textContent = errorSummary(error); }
  finally { active = undefined; stopButton.disabled = true; const next = queued; queued = undefined; if (next) void execute(next); }
}
compileButton.onclick = () => request(false);
runButton.onclick = () => request(true);
stopButton.onclick = () => { stopped = true; queued = undefined; pipeline?.stop(); stopButton.disabled = true; el('status').textContent = 'Stopped'; };
downloadButton.onclick = () => { if (!downloadUrl || compilation?.revision !== revision) return; const anchor = document.createElement('a'); anchor.href = downloadUrl; anchor.download = 'program.wasm'; anchor.click(); };
window.addEventListener('pagehide', () => { pipeline?.dispose(); if (downloadUrl) URL.revokeObjectURL(downloadUrl); editor.dispose(); });
