import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/languages/definitions/csharp/register';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/hover/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { PlaygroundPipeline } from './pipeline';
import type { CompilationResult, Diagnostic, LanguageMode, PipelineEvent, SourceSnapshot, StageTiming, ToolchainPreloadProgress } from './contracts';
import { examples } from './examples';
import { formatTestReport } from './tunit-report';
import './style.css';
import { browserSupportMessage } from './browser-support';
import { optimizationLabels, optimizationModes, type OptimizationMode } from './optimization';
import { clearFrontendCache } from './workers/frontend-cache.mjs';
import { createProject, normalizeProjectPath, validateProjectFiles, type PlaygroundProject, type ProjectFile } from './workspace';
import { loadProject, saveProject } from './workspace-store';

declare const __PLAYGROUND_VERSION__: string;

(globalThis as typeof globalThis & { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<section class="workbench" aria-label="C# playground">
  <div class="ide-toolbar"><button id="open-samples" class="project-button"><span>Project</span><strong id="project-name">Hello World</strong><span aria-hidden="true">⌄</span></button><div class="actions"><button id="run" class="primary">Run <span aria-hidden="true">▶</span></button><button id="compile"><span class="compile-spinner" aria-hidden="true"></span>Publish</button><button id="stop" disabled>Stop</button><button id="download" disabled>Download</button><button id="settings-toggle">Settings</button></div></div>
  <div class="ide-grid">
    <aside class="explorer"><div class="ide-heading"><strong>Explorer</strong><div><button id="new-file" title="New C# file">+</button><button id="import-files" title="Import C# files">↑</button><button id="rename-file" title="Rename selected file">✎</button><button id="delete-file" title="Delete selected file">×</button></div></div><input id="file-input" type="file" accept=".cs,text/plain" multiple hidden><div id="file-tree" role="tree" aria-label="Project files"></div></aside>
    <section class="editor-area"><div id="editor-tabs" class="editor-tabs" role="tablist"></div><div class="pane-heading"><h2 id="source-name">Program.cs</h2><span>C# · Release</span></div><div id="editor" aria-label="C# source editor"></div></section>
  </div>
  <section id="bottom-dock" class="bottom-dock"><div id="dock-resize" class="dock-resize" aria-hidden="true"></div><div class="dock-tabs" role="tablist"><button data-panel="problems">Problems <span id="diagnostic-count">0</span></button><button data-panel="console" class="active">Console</button><button data-panel="build">Build</button><button data-panel="artifacts">Artifacts</button><span id="exit"></span><button id="dock-collapse" title="Collapse panel">⌄</button></div><div id="problems-panel" class="dock-panel"><div id="diagnostics" aria-label="Compiler diagnostics"><p class="empty">Run or publish to check your project.</p></div></div><div id="console-panel" class="dock-panel active"><pre id="output" tabindex="0" aria-label="Program output"></pre></div><div id="build-panel" class="dock-panel"><ol id="stages" aria-label="Pipeline progress"></ol><div id="timings"></div><div id="optimizer"></div></div><div id="artifacts-panel" class="dock-panel"><div id="size">No published component</div><div id="comparison"></div><div id="assets"></div></div></section>
  <div id="toolchain-progress" class="toolchain-progress" role="status" aria-live="polite" hidden><div><strong>Preparing toolchain</strong><span id="toolchain-progress-detail">Reading manifest…</span></div><progress id="toolchain-progress-bar" aria-label="Toolchain preload progress"></progress></div>
  <footer class="status-bar"><div id="status" role="status" aria-live="polite">Ready</div><div id="project-status">1 file</div></footer><aside id="compilation-success" class="compilation-success" hidden><span>Compiled entirely in your browser with NetWasm.</span><a href="https://github.com/zion-sati/NetWasm" target="_blank" rel="noreferrer">Follow the project on GitHub →</a></aside>
</section><p class="cache-note">Your project stays in this browser. Compilation artifacts are cached locally for faster rebuilds.</p><p id="footnote" class="footnote">Run uses the fastest build. Publish uses the selected size optimization and creates a downloadable WASI Preview 2 component.</p>`;
document.body.insertAdjacentHTML('beforeend', `
<dialog id="samples-dialog" class="ide-dialog"><form method="dialog"><header><div><h2>Open a sample</h2><p>Choose a complete project to open in the Playground.</p></div><button value="cancel" aria-label="Close">×</button></header><div id="sample-list" class="sample-list"></div></form></dialog>
<dialog id="settings-dialog" class="ide-dialog settings-dialog"><form method="dialog"><header><div><h2>Playground settings</h2><p>Run and Publish use independent build profiles.</p></div><button value="cancel" aria-label="Close">×</button></header><div class="settings-grid"><section><h3>Run</h3><p>Optimize for the shortest edit and test loop.</p><label>Optimization <select id="run-optimization" aria-label="Run optimization"></select></label></section><section><h3>Publish</h3><p>Optimize the downloadable artifact.</p><label>Optimization <select id="optimization" aria-label="Publish optimization"></select></label></section><section class="compiler-settings"><h3>Compiler</h3><label>Language <select id="language" aria-label="Language"><option value="15">C# 15</option><option value="preview">C# 15 preview</option></select></label><label id="memory-safety-setting" class="feature-setting" hidden><input id="updated-memory-safety" type="checkbox"><span>Updated memory safety rules</span></label><button id="clear-cache" type="button">Clear compilation cache</button></section></div><footer><button value="cancel" class="primary">Done</button></footer></form></dialog>`);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
el('playground-version').textContent = `v${__PLAYGROUND_VERSION__}`;
const compileButton = el<HTMLButtonElement>('compile');
const runButton = el<HTMLButtonElement>('run');
const stopButton = el<HTMLButtonElement>('stop');
const downloadButton = el<HTMLButtonElement>('download');
const clearCacheButton = el<HTMLButtonElement>('clear-cache');
const samplesDialog = el<HTMLDialogElement>('samples-dialog');
const settingsDialog = el<HTMLDialogElement>('settings-dialog');
const runOptimizationSelect = el<HTMLSelectElement>('run-optimization');
const optimizationSelect = el<HTMLSelectElement>('optimization');
const languageSelect = el<HTMLSelectElement>('language');
const updatedMemorySafety = el<HTMLInputElement>('updated-memory-safety');
const memorySafetySetting = el<HTMLLabelElement>('memory-safety-setting');
for (const mode of optimizationModes) { for (const select of [runOptimizationSelect, optimizationSelect]) { const option = document.createElement('option'); option.value = mode; option.textContent = optimizationLabels[mode]; select.append(option); } }
runOptimizationSelect.value = localStorage.getItem('netwasm.runOptimization') ?? 'none';
if (!optimizationModes.includes(runOptimizationSelect.value as OptimizationMode)) runOptimizationSelect.value = 'none';
optimizationSelect.value = localStorage.getItem('netwasm.publishOptimization') ?? 'Oz';
if (!optimizationModes.includes(optimizationSelect.value as OptimizationMode)) optimizationSelect.value = 'Oz';
languageSelect.value = localStorage.getItem('netwasm.language') ?? '15';
if (!['15', 'preview'].includes(languageSelect.value)) languageSelect.value = '15';
updatedMemorySafety.checked = localStorage.getItem('netwasm.updatedMemorySafety') === 'true' && languageSelect.value === 'preview';
memorySafetySetting.hidden = languageSelect.value !== 'preview';
const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
const initialExample = examples[0];
let project = createProject(initialExample.name, initialExample.files ?? [{ path: 'Program.cs', text: initialExample.source }], initialExample.id);
const models = new Map<string, monaco.editor.ITextModel>();
let switchingModel = false;
const modelFor = (file: ProjectFile) => {
  let model = models.get(file.id);
  if (!model) {
    model = monaco.editor.createModel(file.text, 'csharp', monaco.Uri.parse(`inmemory://netwasm/${file.path}`));
    models.set(file.id, model);
  }
  return model;
};
const editor = monaco.editor.create(el('editor'), { model: modelFor(project.files[0]), theme: colorScheme.matches ? 'vs-dark' : 'vs', automaticLayout: true, minimap: { enabled: false }, fontSize: 14, lineHeight: 23, scrollBeyondLastLine: false, scrollbar: { alwaysConsumeMouseWheel: false }, padding: { top: 18 }, tabSize: 4, fixedOverflowWidgets: true, accessibilitySupport: 'auto' });
colorScheme.addEventListener('change', event => monaco.editor.setTheme(event.matches ? 'vs-dark' : 'vs'));
let revision = 0;
let nextRequest = 0;
let active: SourceSnapshot | undefined;
let queued: { snapshot: SourceSnapshot; run: boolean } | undefined;
let compilation: CompilationResult | undefined;
let publishedCompilation: CompilationResult | undefined;
let downloadUrl: string | undefined;
let stopped = false;
let unsupported: string | undefined;
let pipeline: PlaygroundPipeline | undefined;
let saveTimer: number | undefined;
let stageStarted = 0;
let stageTimer: number | undefined;
const comparisons = new Map<OptimizationMode, { bytes: number; milliseconds: number }>();
const stages = new Map<string, HTMLLIElement>();
const stageLabels: Record<string, string> = {
  download: 'Loading toolchain manifest', 'compiler-initialize': 'Loading C# compiler',
  compile: 'Compiling C#', roslyn: 'Checking C#', generator: 'Generating source', netwasm: 'Compiling WebAssembly',
  'cache-lookup': 'Looking up compiler cache', 'cache-hydrate': 'Hydrating compiler cache',
  'cache-write': 'Saving compiler cache',
  'runtime-cache-read': 'Reading runtime cache', 'runtime-cache-write': 'Saving runtime cache',
  'runtime-optimize': 'Optimizing runtime', 'runtime-validate': 'Validating runtime',
  'linker-initialize': 'Loading linker', 'tools-initialize': 'Loading WebAssembly tools',
  link: 'Linking runtime', parse: 'Preparing runtime modules', merge: 'Combining modules',
  prune: 'Removing unused exports', optimize: 'Optimizing WebAssembly',
  validate: 'Validating WebAssembly', componentization: 'Packaging component', run: 'Running program',
};
let runOnly = false;

const formatBytes = (bytes: number) => `${bytes.toLocaleString()} bytes`;
const formatMegabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
const errorSummary = (error: unknown) => String(error).split('\n')[0].slice(0, 300);
const formatAssets = (assets: { rawBytes: number; compressedBytes?: number }) =>
  assets.compressedBytes === undefined
    ? `Tool assets: ${formatBytes(assets.rawBytes)} uncompressed · Brotli-11 size unavailable`
    : `Tool assets: ${formatBytes(assets.compressedBytes)} Brotli-11 · ${formatBytes(assets.rawBytes)} uncompressed`;
const activeFile = () => project.files.find(file => file.id === project.activeFileId) ?? project.files[0];
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveProject(project).then(() => {
    localStorage.setItem('netwasm.activeProject', project.id);
  }).catch(() => {}), 250);
}
function updateProjectStatus() { el('project-status').textContent = `${project.files.length} file${project.files.length === 1 ? '' : 's'} · saved locally`; }
function openFile(id: string) {
  const file = project.files.find(candidate => candidate.id === id);
  if (!file) return;
  project.activeFileId = id;
  switchingModel = true;
  editor.setModel(modelFor(file));
  switchingModel = false;
  el('source-name').textContent = file.path;
  renderFiles();
  editor.focus();
  scheduleSave();
}
function renderFiles() {
  const render = (container: HTMLElement, className: string, role: 'treeitem' | 'tab') => {
    container.replaceChildren();
    for (const file of project.files) {
      const button = document.createElement('button');
      button.className = `${className}${file.id === project.activeFileId ? ' active' : ''}`;
      button.textContent = file.path;
      button.dataset.fileId = file.id;
      button.setAttribute('role', role);
      if (role === 'tab') button.setAttribute('aria-selected', String(file.id === project.activeFileId));
      button.onclick = () => openFile(file.id);
      container.append(button);
    }
  };
  render(el('file-tree'), 'file-item', 'treeitem');
  render(el('editor-tabs'), 'editor-tab', 'tab');
  el<HTMLButtonElement>('delete-file').disabled = project.files.length === 1;
  updateProjectStatus();
}
function replaceProject(next: PlaygroundProject) {
  for (const model of models.values()) model.dispose();
  models.clear();
  project = next;
  el('project-name').textContent = project.name;
  revision++;
  comparisons.clear(); showComparisons(); invalidateDownload();
  renderFiles(); openFile(project.activeFileId); setDiagnostics([]); scheduleSave();
}
function selectDock(panel: string) {
  document.querySelectorAll<HTMLButtonElement>('.dock-tabs [data-panel]').forEach(button => button.classList.toggle('active', button.dataset.panel === panel));
  document.querySelectorAll<HTMLElement>('.dock-panel').forEach(element => element.classList.toggle('active', element.id === `${panel}-panel`));
  el('bottom-dock').classList.remove('collapsed');
  localStorage.setItem('netwasm.dockPanel', panel);
}
function setCompilationSuccess(visible: boolean) { el('compilation-success').hidden = !visible; }
function invalidateDownload() { compilation = undefined; publishedCompilation = undefined; setCompilationSuccess(false); downloadButton.disabled = true; if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = undefined; el('size').textContent = 'No current component'; }
function showComparisons() {
  el('comparison').textContent = [...comparisons].map(([mode, result]) =>
    `${optimizationLabels[mode]}: ${formatBytes(result.bytes)} · ${(result.milliseconds / 1000).toFixed(2)} s`).join('  |  ');
}
function setDiagnostics(diagnostics: Diagnostic[]) {
  for (const file of project.files) {
    const fileDiagnostics = diagnostics.filter(d => !d.path || d.path === file.path);
    monaco.editor.setModelMarkers(modelFor(file), 'roslyn', fileDiagnostics.map(d => ({ message: `${d.code}: ${d.message}`, severity: d.severity.toLowerCase() === 'error' ? monaco.MarkerSeverity.Error : d.severity.toLowerCase() === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info, startLineNumber: (d.line ?? 0) + 1, endLineNumber: (d.line ?? 0) + 1, startColumn: (d.column ?? 0) + 1, endColumn: (d.column ?? 0) + 2 })));
  }
  el('diagnostic-count').textContent = diagnostics.length >= 128 ? `${diagnostics.length} · limit reached` : String(diagnostics.length);
  el('diagnostics').replaceChildren();
  if (!diagnostics.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'No diagnostics.'; el('diagnostics').append(p); }
  for (const d of diagnostics) { const button = document.createElement('button'); button.className = 'diagnostic'; button.textContent = `${d.path ? `${d.path} · ` : ''}${d.line === undefined ? '' : `${d.line + 1}:${(d.column ?? 0) + 1} · `}${d.code} ${d.message}`; button.onclick = () => { const file = project.files.find(file => file.path === d.path); if (file) openFile(file.id); const position = { lineNumber: (d.line ?? 0) + 1, column: (d.column ?? 0) + 1 }; editor.setPosition(position); editor.revealPositionInCenter(position); editor.focus(); }; el('diagnostics').append(button); }
}
function showTimings(timings: StageTiming[]) { el('timings').textContent = timings.map(t => `${t.stage}: ${(t.milliseconds / 1000).toFixed(2)} s`).join(' · '); }
function showOptimizer(result: CompilationResult) {
  if (!result.optimizerHost) { el('optimizer').textContent = ''; return; }
  if (result.optimizerHost === 'native-threads') {
    const workers = result.optimizerWorkerCount ? ` · ${result.optimizerWorkerCount} workers` : '';
    const memory = result.optimizerLinearMemoryBytes ? ` · ${formatMegabytes(result.optimizerLinearMemoryBytes)} memory` : '';
    el('optimizer').textContent = `Optimizer: native WebAssembly${workers}${memory}`;
    return;
  }
  el('optimizer').textContent = result.optimizerFallback
    ? 'Optimizer: JavaScript fallback · native optimizer unavailable'
    : 'Optimizer: JavaScript';
}
function onEvent(event: PipelineEvent) {
  if (!active || stopped || event.requestId !== active.requestId || event.revision !== revision) return;
  if (event.type === 'console') el('output').textContent += event.text;
  if (event.type === 'assets') el('assets').textContent = formatAssets(event);
  if (event.type === 'stage') { const activeOptimization = active.optimization ?? 'Oz'; const label = ['optimize', 'runtime-optimize'].includes(event.stage) ? `${stageLabels[event.stage]} (-${activeOptimization})` : stageLabels[event.stage] ?? event.stage; let item = stages.get(event.stage); if (!item) { item = document.createElement('li'); item.textContent = label; item.dataset.stage = event.stage; stages.set(event.stage, item); el('stages').append(item); } item.dataset.state = event.state; if (stageTimer) clearInterval(stageTimer); stageTimer = undefined; if (event.state === 'running') { stageStarted = performance.now(); el('status').textContent = label; stageTimer = window.setInterval(() => { if (active) el('status').textContent = `${label} · ${((performance.now() - stageStarted) / 1000).toFixed(1)}s`; }, 250); } else if (stageStarted) el('status').textContent = `${label} · ${(Math.max(event.milliseconds ?? 0, performance.now() - stageStarted) / 1000).toFixed(1)}s`; }
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
editor.onDidChangeModelContent(() => { if (switchingModel) return; const file = activeFile(); file.text = editor.getValue(); revision++; comparisons.clear(); showComparisons(); invalidateDownload(); setDiagnostics([]); scheduleSave(); el('status').textContent = unsupported ?? (active ? 'Project changed · result pending for earlier revision' : 'Project changed'); });
function loadExample(recipeId: string) {
  comparisons.clear(); showComparisons();
  const example = examples.find(candidate => candidate.id === recipeId);
  if (!example) return;
  const previousRevision = revision;
  languageSelect.value = example.language ?? '15';
  updatedMemorySafety.checked = example.updatedMemorySafetyRules ?? false;
  memorySafetySetting.hidden = languageSelect.value !== 'preview';
  const next = createProject(example.name, example.files ?? [{ path: example.id === 'tunit' ? 'Tests.cs' : 'Program.cs', text: example.source }], example.id);
  next.kind = example.kind ?? 'command';
  replaceProject(next);
  // A recipe change must invalidate its artifact even when the source is equal.
  if (revision === previousRevision) { revision++; invalidateDownload(); setDiagnostics([]); el('status').textContent = 'Example changed'; }
  el('footnote').textContent = example.id === 'tunit' ? 'TUnit uses the NetWasm asynchronous component host and the generated guest test runner.' : 'Projects can contain up to 32 C# files. Run uses the fast profile; Publish creates a downloadable component.';
  editor.setScrollTop(0);
  editor.setPosition({ lineNumber: 1, column: 1 });
  samplesDialog.close();
}
const categories = ['Getting started', 'Language and runtime', 'Libraries', 'Interop and workers', 'Testing'] as const;
for (const category of categories) {
  const members = examples.filter(example => (example.category ?? 'Libraries') === category);
  if (!members.length) continue;
  const section = document.createElement('section');
  const heading = document.createElement('h3');
  heading.textContent = category;
  section.append(heading);
  for (const example of members) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sample-card';
    button.dataset.sampleId = example.id;
    const name = document.createElement('strong');
    name.textContent = example.name;
    const description = document.createElement('span');
    description.textContent = example.description ?? 'Open this sample project.';
    button.append(name, description);
    button.onclick = () => loadExample(example.id);
    section.append(button);
  }
  el('sample-list').append(section);
}
el<HTMLButtonElement>('open-samples').onclick = () => samplesDialog.showModal();
runOptimizationSelect.onchange = () => { localStorage.setItem('netwasm.runOptimization', runOptimizationSelect.value); invalidateDownload(); el('status').textContent = `Run optimization changed to ${optimizationLabels[runOptimizationSelect.value as OptimizationMode]}`; };
optimizationSelect.onchange = () => { localStorage.setItem('netwasm.publishOptimization', optimizationSelect.value); invalidateDownload(); el('status').textContent = `Publish optimization changed to ${optimizationLabels[optimizationSelect.value as OptimizationMode]}`; };
function languageSettingsChanged() {
  if (languageSelect.value !== 'preview') updatedMemorySafety.checked = false;
  memorySafetySetting.hidden = languageSelect.value !== 'preview';
  localStorage.setItem('netwasm.language', languageSelect.value);
  localStorage.setItem('netwasm.updatedMemorySafety', String(updatedMemorySafety.checked));
  revision++; comparisons.clear(); showComparisons(); invalidateDownload(); setDiagnostics([]);
  el('status').textContent = languageSelect.value === 'preview'
    ? 'Language changed to C# 15 preview'
    : 'Language changed to C# 15';
}
languageSelect.onchange = languageSettingsChanged;
updatedMemorySafety.onchange = () => {
  localStorage.setItem('netwasm.updatedMemorySafety', String(updatedMemorySafety.checked));
  revision++; comparisons.clear(); showComparisons(); invalidateDownload(); setDiagnostics([]);
  el('status').textContent = updatedMemorySafety.checked
    ? 'Updated memory safety rules enabled'
    : 'Updated memory safety rules disabled';
};
function snapshot(run: boolean): SourceSnapshot { return { requestId: ++nextRequest, revision, files: project.files.map(file => ({ ...file })), recipeId: project.recipeId, optimization: (run ? runOptimizationSelect.value : optimizationSelect.value) as OptimizationMode, language: languageSelect.value as LanguageMode, updatedMemorySafetyRules: updatedMemorySafety.checked }; }
function request(run: boolean) { const job = { snapshot: snapshot(run), run }; selectDock('build'); if (active) { queued = job; el('status').textContent = 'Latest request queued'; } else void execute(job); }
async function execute(job: { snapshot: SourceSnapshot; run: boolean }) {
  runOnly = job.run && !!compilation?.success && compilation.revision === job.snapshot.revision && compilation.optimization === job.snapshot.optimization && compilation.language === job.snapshot.language && compilation.updatedMemorySafetyRules === job.snapshot.updatedMemorySafetyRules;
  compileButton.disabled = true; runButton.disabled = true; runOptimizationSelect.disabled = true; optimizationSelect.disabled = true; languageSelect.disabled = true; updatedMemorySafety.disabled = true; clearCacheButton.disabled = true;
  document.querySelector('.workbench')!.setAttribute('aria-busy', 'true');
  if (!job.run) setCompilationSuccess(false);
  active = job.snapshot; stopped = false; stopButton.disabled = false; stages.clear(); el('stages').replaceChildren(); el('output').textContent = ''; el('exit').textContent = ''; el('timings').textContent = ''; el('optimizer').textContent = ''; el('status').textContent = 'Starting';
  pipeline ??= new PlaygroundPipeline(onEvent);
  try {
    let result = compilation;
    if (!job.run || !result?.success || result.revision !== job.snapshot.revision || result.optimization !== job.snapshot.optimization || result.language !== job.snapshot.language || result.updatedMemorySafetyRules !== job.snapshot.updatedMemorySafetyRules) {
      result = await pipeline.compile(job.snapshot);
      if (!stopped && revision === job.snapshot.revision) {
        setDiagnostics(result.diagnostics); showTimings(result.timings); showOptimizer(result);
        if (result.success && result.component) { compilation = result; const exclusive = result.timings.filter(t => !['generator', 'roslyn', 'netwasm'].includes(t.stage)).reduce((total, timing) => total + timing.milliseconds, 0); comparisons.set(result.optimization ?? 'Oz', { bytes: result.component.byteLength, milliseconds: exclusive }); showComparisons(); if (!job.run) { invalidateDownload(); compilation = result; publishedCompilation = result; downloadUrl = URL.createObjectURL(new Blob([new Uint8Array(result.component)], { type: 'application/wasm' })); downloadButton.disabled = false; setCompilationSuccess(true); el('size').textContent = `${optimizationLabels[result.optimization ?? 'Oz']} · ${formatBytes(result.component.byteLength)}`; selectDock('artifacts'); } }
        else { invalidateDownload(); if (!result.cancelled) selectDock('problems'); el('status').textContent = result.cancelled ? 'Stopped' : result.error ? errorSummary(result.error) : 'Compilation failed'; }
      }
    }
    if (job.run && result?.success && !stopped && revision === job.snapshot.revision) {
      selectDock('console');
      const run = await pipeline.run(result, job.snapshot);
      if (!stopped && revision === job.snapshot.revision) { el('output').textContent = run.stdout + run.stderr; el('exit').textContent = run.exitCode === undefined ? '' : `Exit ${run.exitCode}`; showTimings([...result.timings, ...run.timings]); el('status').textContent = run.cancelled ? 'Stopped' : run.success ? 'Run complete' : run.error ? errorSummary(run.error) : 'Run failed'; if (job.snapshot.recipeId === 'tunit' && !run.cancelled && !run.error && run.exitCode !== undefined) { const report = formatTestReport(run.stdout); el('output').textContent = report.text + run.stderr; el('status').textContent = `Tests complete · ${report.passed} passed · ${report.failed} failed`; } }
    } else if (!stopped && result?.success && revision === job.snapshot.revision) el('status').textContent = 'Compilation complete';
  } catch (error) { if (!stopped && revision === job.snapshot.revision) el('status').textContent = errorSummary(error); }
  finally { if (stageTimer) clearInterval(stageTimer); stageTimer = undefined; active = undefined; stopButton.disabled = true; compileButton.disabled = !!unsupported; runButton.disabled = !!unsupported; runOptimizationSelect.disabled = false; optimizationSelect.disabled = false; languageSelect.disabled = false; updatedMemorySafety.disabled = false; clearCacheButton.disabled = false; document.querySelector('.workbench')!.setAttribute('aria-busy', 'false'); const next = queued; queued = undefined; if (next) void execute(next); }
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
    el('assets').textContent = formatAssets(assets);
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
downloadButton.onclick = () => { if (!downloadUrl || publishedCompilation?.revision !== revision) return; const anchor = document.createElement('a'); anchor.href = downloadUrl; anchor.download = `program-${publishedCompilation.optimization ?? 'Oz'}.wasm`; anchor.click(); };
el<HTMLButtonElement>('settings-toggle').onclick = () => settingsDialog.showModal();
for (const button of document.querySelectorAll<HTMLButtonElement>('.dock-tabs [data-panel]')) button.onclick = () => selectDock(button.dataset.panel!);
el<HTMLButtonElement>('dock-collapse').onclick = () => el('bottom-dock').classList.toggle('collapsed');
el<HTMLButtonElement>('new-file').onclick = () => {
  const suggested = `File${project.files.length + 1}.cs`;
  const answer = prompt('New C# file path', suggested);
  if (!answer) return;
  try {
    const path = normalizeProjectPath(answer.endsWith('.cs') ? answer : `${answer}.cs`);
    if (project.files.some(file => file.path === path)) throw new Error(`A file named ${path} already exists.`);
    const file: ProjectFile = { id: crypto.randomUUID(), path, kind: 'csharp', text: '' };
    validateProjectFiles([...project.files, file]); project.files.push(file); revision++; renderFiles(); openFile(file.id); invalidateDownload(); scheduleSave();
  } catch (error) { el('status').textContent = errorSummary(error); }
};
el<HTMLButtonElement>('import-files').onclick = () => el<HTMLInputElement>('file-input').click();
async function importProjectFiles(uploadedFiles: readonly File[]) {
  const imported: ProjectFile[] = [];
  for (const uploaded of uploadedFiles) {
    try {
      const path = normalizeProjectPath(uploaded.name);
      if (!path.endsWith('.cs') || project.files.some(file => file.path === path)) throw new Error(`Cannot import ${path}.`);
      imported.push({ id: crypto.randomUUID(), path, kind: 'csharp', text: await uploaded.text() });
    } catch (error) { el('status').textContent = errorSummary(error); }
  }
  try { validateProjectFiles([...project.files, ...imported]); project.files.push(...imported); revision++; renderFiles(); invalidateDownload(); scheduleSave(); }
  catch (error) { el('status').textContent = errorSummary(error); }
}
el<HTMLInputElement>('file-input').onchange = event => { const input = event.currentTarget as HTMLInputElement; void importProjectFiles([...(input.files ?? [])]); input.value = ''; };
function renameActiveFile() {
  const file = activeFile();
  if (!file) return;
  const answer = prompt('Rename C# file', file.path);
  if (!answer) return;
  try { const path = normalizeProjectPath(answer); if (!path.endsWith('.cs')) throw new Error('C# file paths must end in .cs.'); if (project.files.some(candidate => candidate !== file && candidate.path === path)) throw new Error(`A file named ${path} already exists.`); file.path = path; models.get(file.id)?.dispose(); models.delete(file.id); revision++; renderFiles(); openFile(file.id); invalidateDownload(); scheduleSave(); } catch (error) { el('status').textContent = errorSummary(error); }
}
function deleteActiveFile() {
  if (project.files.length === 1) return;
  const file = activeFile();
  if (!file || !confirm(`Delete ${file.path}?`)) return;
  models.get(file.id)?.dispose(); models.delete(file.id); project.files = project.files.filter(candidate => candidate !== file); project.activeFileId = project.files[0].id; revision++; renderFiles(); openFile(project.activeFileId); invalidateDownload(); scheduleSave();
}
el<HTMLButtonElement>('rename-file').onclick = renameActiveFile;
el<HTMLButtonElement>('delete-file').onclick = deleteActiveFile;
el('file-tree').addEventListener('dblclick', event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-file-id]'); if (button) { openFile(button.dataset.fileId!); renameActiveFile(); } });
el('file-tree').addEventListener('keydown', event => {
  if (event.key !== 'Delete') return;
  deleteActiveFile();
});
el('file-tree').addEventListener('dragover', event => { event.preventDefault(); el('file-tree').classList.add('drop-target'); });
el('file-tree').addEventListener('dragleave', () => el('file-tree').classList.remove('drop-target'));
el('file-tree').addEventListener('drop', event => { event.preventDefault(); el('file-tree').classList.remove('drop-target'); void importProjectFiles([...(event.dataTransfer?.files ?? [])]); });
const dockHeight = Number(localStorage.getItem('netwasm.dockHeight'));
if (dockHeight >= 140 && dockHeight <= 500) el('bottom-dock').style.setProperty('--dock-height', `${dockHeight}px`);
el('dock-resize').addEventListener('pointerdown', event => {
  const startY = event.clientY, startHeight = el('bottom-dock').getBoundingClientRect().height;
  const move = (moveEvent: PointerEvent) => { const height = Math.max(140, Math.min(500, startHeight + startY - moveEvent.clientY)); el('bottom-dock').style.setProperty('--dock-height', `${height}px`); localStorage.setItem('netwasm.dockHeight', String(Math.round(height))); editor.layout(); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
});
renderFiles();
selectDock(localStorage.getItem('netwasm.dockPanel') ?? 'console');
const savedProjectId = localStorage.getItem('netwasm.activeProject');
if (savedProjectId) void loadProject(savedProjectId).then(saved => { if (saved) replaceProject(saved); }).catch(() => {});
clearCacheButton.onclick = () => {
  clearCacheButton.disabled = true;
  void clearFrontendCache().then(() => {
    el('status').textContent = 'Compilation cache cleared';
  }).catch(error => {
    el('status').textContent = errorSummary(error);
  }).finally(() => { clearCacheButton.disabled = false; });
};
window.addEventListener('pagehide', event => {
  // A persisted page is only being frozen for browser back/forward navigation.
  // Its JavaScript heap is restored as-is, so disposing Monaco here leaves the
  // restored page with a dead editor that cannot render later model changes.
  if (event.persisted) return;
  pipeline?.dispose();
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  for (const model of models.values()) model.dispose();
  editor.dispose();
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  requestAnimationFrame(() => {
    editor.layout();
    editor.render(true);
  });
});
