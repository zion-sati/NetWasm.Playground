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
import { cloneProjectFiles, createProject, inferNativeLibraryName, isTextProjectFile, normalizeProjectPath,
  projectFileKind, validateNativeLibraryName, validateProjectFiles, validateWasmArchive,
  type NativeArchiveProjectFile, type PlaygroundProject, type ProjectFile, type ProjectFileSource } from './workspace';
import { loadProject, saveProject } from './workspace-store';
import { buildProjectArchive, projectArchiveName } from './project-archive';

declare const __PLAYGROUND_VERSION__: string;

(globalThis as typeof globalThis & { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
const icon = (body: string) => `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const icons = {
  newFile: icon('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 13v6m-3-3h6"/>'),
  upload: icon('<path d="M12 16V4m-4 4 4-4 4 4"/><path d="M5 15v4h14v-4"/>'),
  settings: icon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/>'),
  rename: icon('<path d="M4 20h4l11-11-4-4L4 16v4zM13.5 6.5l4 4"/>'),
  trash: icon('<path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6"/>'),
  export: icon('<path d="M12 4v11m-4-4 4 4 4-4"/><path d="M5 15v5h14v-5"/>'),
  close: icon('<path d="m7 7 10 10M17 7 7 17"/>'),
};
document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<section class="workbench" aria-label="C# playground">
  <div class="ide-toolbar"><button id="open-samples" class="project-button"><span>Project</span><strong id="project-name">Hello World</strong><span aria-hidden="true">⌄</span></button><div class="actions"><button id="run" class="primary">Run <span aria-hidden="true">▶</span></button><button id="compile"><span class="compile-spinner" aria-hidden="true"></span>Publish</button><button id="stop" disabled>Stop</button><button id="download" title="Download published WebAssembly artifact" disabled>${icons.export}<span>Artifact(s)</span></button><button id="export-project" title="Export project to a ZIP archive">${icons.export}<span>Project</span></button><button id="settings-toggle" class="icon-button" title="Playground settings" aria-label="Playground settings">${icons.settings}</button></div></div>
  <div class="ide-grid">
    <aside class="explorer"><div class="ide-heading"><strong>Explorer</strong><div><button id="new-file" title="New file" aria-label="New file">${icons.newFile}</button><button id="import-files" title="Upload project files" aria-label="Upload project files">${icons.upload}</button><button id="archive-properties" title="Native library settings" aria-label="Native library settings" disabled>${icons.settings}</button><button id="rename-file" title="Rename selected file" aria-label="Rename selected file">${icons.rename}</button><button id="delete-file" title="Delete selected file" aria-label="Delete selected file">${icons.trash}</button></div></div><input id="file-input" type="file" accept=".cs,.js,.mjs,.wit,.html,.htm,.txt,.a,text/plain,application/octet-stream" multiple hidden><div id="file-tree" role="tree" aria-label="Project files"></div></aside>
    <section class="editor-area"><div id="editor-tabs" class="editor-tabs" role="tablist"></div><div class="pane-heading"><h2 id="source-name">Program.cs</h2><span>C# · Release</span></div><div id="editor" aria-label="C# source editor"></div></section>
  </div>
  <section id="bottom-dock" class="bottom-dock"><div id="dock-resize" class="dock-resize" aria-hidden="true"></div><div class="dock-tabs" role="tablist"><button data-panel="problems">Problems <span id="diagnostic-count">0</span></button><button data-panel="console" class="active">Console</button><button data-panel="build">Build</button><button data-panel="artifacts">Artifacts</button><span id="exit"></span><button id="dock-collapse" title="Collapse panel" aria-label="Collapse bottom panel" aria-expanded="true">⌄</button></div><div id="problems-panel" class="dock-panel"><div id="diagnostics" aria-label="Compiler diagnostics"><p class="empty">Run or publish to check your project.</p></div></div><div id="console-panel" class="dock-panel active"><pre id="output" tabindex="0" aria-label="Program output"></pre></div><div id="build-panel" class="dock-panel"><ol id="stages" aria-label="Pipeline progress"></ol><div id="timings"></div><div id="optimizer"></div></div><div id="artifacts-panel" class="dock-panel"><div id="size">No published component</div><div id="comparison"></div><div id="assets"></div></div></section>
  <div id="toolchain-progress" class="toolchain-progress" role="status" aria-live="polite" hidden><div><strong>Preparing toolchain</strong><span id="toolchain-progress-detail">Reading manifest…</span></div><progress id="toolchain-progress-bar" aria-label="Toolchain preload progress"></progress></div>
  <footer class="status-bar"><div id="status" role="status" aria-live="polite">Ready</div><div id="project-status">1 file</div></footer><aside id="compilation-success" class="compilation-success" hidden><span>Compiled entirely in your browser with NetWasm.</span><a href="https://github.com/zion-sati/NetWasm" target="_blank" rel="noreferrer">Follow the project on GitHub →</a></aside>
</section>`;
document.body.insertAdjacentHTML('beforeend', `
<dialog id="samples-dialog" class="ide-dialog"><form method="dialog"><header><div><h2>Open a sample</h2><p>Choose a complete project to open in the Playground.</p></div><button value="cancel" aria-label="Close">×</button></header><div id="sample-list" class="sample-list"></div></form></dialog>
<dialog id="settings-dialog" class="ide-dialog settings-dialog"><form method="dialog"><header><div><h2>Playground settings</h2><p>Run and Publish use independent build profiles.</p></div><button value="cancel" aria-label="Close">×</button></header><div class="settings-grid"><section><h3>Run</h3><p>Optimize for the shortest edit and test loop.</p><label>Optimization <select id="run-optimization" aria-label="Run optimization"></select></label></section><section><h3>Publish</h3><p>Optimize the downloadable artifact.</p><label>Optimization <select id="optimization" aria-label="Publish optimization"></select></label></section><section class="compiler-settings"><h3>Compiler</h3><label>Language <select id="language" aria-label="Language"><option value="15">C# 15</option><option value="preview">C# 15 preview</option></select></label><label id="memory-safety-setting" class="feature-setting" hidden><input id="updated-memory-safety" type="checkbox"><span>Updated memory safety rules</span></label><button id="clear-cache" type="button">Clear compilation cache</button></section></div><footer><button value="cancel" class="primary">Done</button></footer></form></dialog>`);
document.body.insertAdjacentHTML('beforeend', `
<dialog id="file-dialog" class="ide-dialog file-dialog"><form method="dialog"><header><div><h2 id="file-dialog-title">New file</h2><p>Enter a project-relative path. The extension selects the file type.</p></div><button value="cancel" aria-label="Close">×</button></header><div class="file-settings"><label>File path<input id="file-path" autocomplete="off" spellcheck="false" placeholder="Helpers/Value.cs"></label><p id="file-dialog-error" class="dialog-error" role="alert"></p></div><footer><button value="cancel" class="secondary">Cancel</button><button id="save-file" value="default" class="primary">Create</button></footer></form></dialog>
<dialog id="archive-dialog" class="ide-dialog archive-dialog"><form method="dialog"><header><div><h2>Native library settings</h2><p id="archive-path"></p></div><button value="cancel" aria-label="Close">×</button></header><div class="archive-settings"><label>LibraryImport name<input id="archive-library-name" autocomplete="off" spellcheck="false"></label><p>This must match the name used by <code>[LibraryImport("…")]</code>. The archive is linked only when a reachable import uses it.</p></div><footer><button value="cancel">Cancel</button><button id="save-archive-settings" value="default" class="primary">Save</button></footer></form></dialog>`);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T;
el('playground-version').textContent = `v${__PLAYGROUND_VERSION__}`;
const compileButton = el<HTMLButtonElement>('compile');
const runButton = el<HTMLButtonElement>('run');
const stopButton = el<HTMLButtonElement>('stop');
const downloadButton = el<HTMLButtonElement>('download');
const clearCacheButton = el<HTMLButtonElement>('clear-cache');
const samplesDialog = el<HTMLDialogElement>('samples-dialog');
const settingsDialog = el<HTMLDialogElement>('settings-dialog');
const fileDialog = el<HTMLDialogElement>('file-dialog');
const archiveDialog = el<HTMLDialogElement>('archive-dialog');
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
let openFileIds = [project.activeFileId];
let switchingModel = false;
const editorLanguage = (file: ProjectFile) => file.kind === 'csharp' ? 'csharp'
  : file.kind === 'javascript' ? 'javascript' : file.kind === 'html' ? 'html' : 'plaintext';
const editorText = (file: ProjectFile) => isTextProjectFile(file) ? file.text
  : `WebAssembly static library\n\nPath: ${file.path}\nLibraryImport name: ${file.libraryName}\nTarget: ${file.target}\nObject files: ${validateWasmArchive(file.bytes, file.path)}\nSize: ${file.bytes.byteLength.toLocaleString()} bytes\n\nUse the Explorer gear button to edit the LibraryImport name.\n`;
const modelFor = (file: ProjectFile) => {
  let model = models.get(file.id);
  if (!model) {
    model = monaco.editor.createModel(editorText(file), editorLanguage(file), monaco.Uri.parse(`inmemory://netwasm/${file.path}`));
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
const activeFile = () => project.files.find(file => file.id === project.activeFileId);
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
  if (!openFileIds.includes(id)) openFileIds.push(id);
  project.activeFileId = id;
  switchingModel = true;
  editor.setModel(modelFor(file));
  editor.updateOptions({ readOnly: !isTextProjectFile(file) });
  switchingModel = false;
  el('source-name').textContent = file.path;
  renderFiles();
  editor.focus();
  scheduleSave();
}
function closeFileTab(id: string) {
  const index = openFileIds.indexOf(id);
  if (index < 0) return;
  openFileIds.splice(index, 1);
  if (project.activeFileId !== id) { renderFiles(); return; }
  const nextId = openFileIds[Math.min(index, openFileIds.length - 1)];
  if (nextId) { openFile(nextId); return; }
  project.activeFileId = '';
  switchingModel = true;
  editor.setModel(null);
  switchingModel = false;
  el('source-name').textContent = 'No file open';
  renderFiles();
  scheduleSave();
}
function renderFiles() {
  const tree = el('file-tree');
  tree.replaceChildren();
  for (const file of project.files) {
    const button = document.createElement('button');
    button.className = `file-item${file.id === project.activeFileId ? ' active' : ''}`;
    button.textContent = file.path;
    button.dataset.fileId = file.id;
    button.dataset.kind = file.kind;
    button.setAttribute('role', 'treeitem');
    button.onclick = () => openFile(file.id);
    tree.append(button);
  }
  const tabs = el('editor-tabs');
  tabs.replaceChildren();
  for (const id of openFileIds) {
    const file = project.files.find(candidate => candidate.id === id);
    if (!file) continue;
    const tab = document.createElement('div');
    tab.className = `editor-tab${file.id === project.activeFileId ? ' active' : ''}`;
    tab.dataset.fileId = file.id;
    tab.dataset.kind = file.kind;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(file.id === project.activeFileId));
    tab.onauxclick = event => { if (event.button === 1) { event.preventDefault(); closeFileTab(file.id); } };
    const label = document.createElement('button');
    label.className = 'editor-tab-label';
    label.textContent = file.path;
    label.title = file.path;
    label.onclick = () => openFile(file.id);
    const close = document.createElement('button');
    close.className = 'editor-tab-close';
    close.title = `Close ${file.path}`;
    close.setAttribute('aria-label', `Close ${file.path}`);
    close.innerHTML = icons.close;
    close.onclick = event => { event.stopPropagation(); closeFileTab(file.id); };
    tab.append(label, close);
    tabs.append(tab);
  }
  const selected = activeFile();
  el<HTMLButtonElement>('archive-properties').disabled = selected?.kind !== 'native-archive';
  el<HTMLButtonElement>('rename-file').disabled = !selected;
  el<HTMLButtonElement>('delete-file').disabled = !selected || selected.kind === 'csharp' &&
    project.files.filter(file => file.kind === 'csharp').length === 1;
  updateProjectStatus();
}
function replaceProject(next: PlaygroundProject) {
  for (const model of models.values()) model.dispose();
  models.clear();
  project = next;
  if (!project.files.some(file => file.id === project.activeFileId)) project.activeFileId = project.files[0].id;
  openFileIds = [project.activeFileId];
  el('project-name').textContent = project.name;
  revision++;
  comparisons.clear(); showComparisons(); invalidateDownload();
  renderFiles(); openFile(project.activeFileId); setDiagnostics([]); scheduleSave();
}
function setDockCollapsed(collapsed: boolean) {
  const dock = el('bottom-dock');
  const toggle = el<HTMLButtonElement>('dock-collapse');
  dock.classList.toggle('collapsed', collapsed);
  toggle.textContent = collapsed ? '⌃' : '⌄';
  toggle.title = collapsed ? 'Expand panel' : 'Collapse panel';
  toggle.setAttribute('aria-label', collapsed ? 'Expand bottom panel' : 'Collapse bottom panel');
  toggle.setAttribute('aria-expanded', String(!collapsed));
  editor.layout();
}
function selectDock(panel: string) {
  document.querySelectorAll<HTMLButtonElement>('.dock-tabs [data-panel]').forEach(button => button.classList.toggle('active', button.dataset.panel === panel));
  document.querySelectorAll<HTMLElement>('.dock-panel').forEach(element => element.classList.toggle('active', element.id === `${panel}-panel`));
  setDockCollapsed(false);
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
function showTimings(timings: StageTiming[]) { el('timings').textContent = timings.map(t => `${t.stage}: ${(t.milliseconds / 1000).toFixed(2)} s`).join('\n'); }
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
editor.onDidChangeModelContent(() => { if (switchingModel) return; const file = activeFile(); if (!file || !isTextProjectFile(file)) return; file.text = editor.getValue(); revision++; comparisons.clear(); showComparisons(); invalidateDownload(); setDiagnostics([]); scheduleSave(); el('status').textContent = unsupported ?? (active ? 'Project changed · result pending for earlier revision' : 'Project changed'); });
async function loadExample(recipeId: string) {
  comparisons.clear(); showComparisons();
  const example = examples.find(candidate => candidate.id === recipeId);
  if (!example) return;
  el('status').textContent = `Opening ${example.name}…`;
  const files: ProjectFileSource[] = [...(example.files ?? [
    { path: example.id === 'tunit' ? 'Tests.cs' : 'Program.cs', text: example.source },
  ])];
  try {
    for (const asset of example.assets ?? []) {
      const response = await fetch(new URL(`${import.meta.env.BASE_URL}${asset.publicPath}`, location.origin));
      if (!response.ok) throw new Error(`Unable to load ${asset.path} (${response.status}).`);
      if (asset.kind === 'native-archive') files.push({ path: asset.path, kind: asset.kind,
        bytes: new Uint8Array(await response.arrayBuffer()), libraryName: asset.libraryName, target: asset.target });
      else files.push({ path: asset.path, kind: asset.kind, text: await response.text() });
    }
  } catch (error) { el('status').textContent = errorSummary(error); return; }
  const previousRevision = revision;
  languageSelect.value = example.language ?? '15';
  updatedMemorySafety.checked = example.updatedMemorySafetyRules ?? false;
  memorySafetySetting.hidden = languageSelect.value !== 'preview';
  const next = createProject(example.name, files, example.id);
  next.kind = example.kind ?? 'command';
  replaceProject(next);
  // A recipe change must invalidate its artifact even when the source is equal.
  if (revision === previousRevision) { revision++; invalidateDownload(); setDiagnostics([]); el('status').textContent = 'Example changed'; }
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
    button.onclick = () => void loadExample(example.id);
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
function snapshot(run: boolean): SourceSnapshot { return { requestId: ++nextRequest, revision,
  files: cloneProjectFiles(project.files), projectKind: project.kind, recipeId: project.recipeId,
  optimization: (run ? runOptimizationSelect.value : optimizationSelect.value) as OptimizationMode,
  language: languageSelect.value as LanguageMode, updatedMemorySafetyRules: updatedMemorySafety.checked }; }
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
type ProjectSaveHandle = { createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }> };
type ProjectSavePicker = (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<ProjectSaveHandle>;
async function exportProject() {
  const archive = buildProjectArchive(project, {
    language: languageSelect.value as LanguageMode,
    updatedMemorySafetyRules: updatedMemorySafety.checked,
    runOptimization: runOptimizationSelect.value as OptimizationMode,
    publishOptimization: optimizationSelect.value as OptimizationMode,
  });
  const filename = projectArchiveName(project.name);
  const blob = new Blob([archive.buffer as ArrayBuffer], { type: 'application/zip' });
  const savePicker = (window as typeof window & { showSaveFilePicker?: ProjectSavePicker }).showSaveFilePicker;
  if (savePicker) {
    try {
      const handle = await savePicker.call(window, { suggestedName: filename, types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      el('status').textContent = `Exported ${filename}`;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      el('status').textContent = errorSummary(error);
    }
    return;
  }
  const url = URL.createObjectURL(new Blob([archive.buffer as ArrayBuffer], { type: 'application/zip' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  el('status').textContent = `Exported ${filename}`;
}
el<HTMLButtonElement>('export-project').onclick = () => { void exportProject(); };
el<HTMLButtonElement>('settings-toggle').onclick = () => settingsDialog.showModal();
for (const button of document.querySelectorAll<HTMLButtonElement>('.dock-tabs [data-panel]')) button.onclick = () => selectDock(button.dataset.panel!);
el<HTMLButtonElement>('dock-collapse').onclick = () => {
  const collapsed = !el('bottom-dock').classList.contains('collapsed');
  setDockCollapsed(collapsed);
  localStorage.setItem('netwasm.dockCollapsed', String(collapsed));
};
let fileDialogMode: 'new' | 'rename' = 'new';
let fileDialogFile: ProjectFile | undefined;
function showFileDialog(mode: 'new' | 'rename', file?: ProjectFile) {
  fileDialogMode = mode;
  fileDialogFile = file;
  const creating = mode === 'new';
  el('file-dialog-title').textContent = creating ? 'New file' : 'Rename file';
  el<HTMLButtonElement>('save-file').textContent = creating ? 'Create' : 'Rename';
  el<HTMLInputElement>('file-path').value = creating ? `File${project.files.length + 1}.cs` : file?.path ?? '';
  el('file-dialog-error').textContent = '';
  fileDialog.showModal();
  el<HTMLInputElement>('file-path').focus();
  el<HTMLInputElement>('file-path').select();
}
el<HTMLButtonElement>('new-file').onclick = () => showFileDialog('new');
el<HTMLButtonElement>('save-file').onclick = event => {
  event.preventDefault();
  try {
    const input = el<HTMLInputElement>('file-path').value.trim();
    const path = normalizeProjectPath(fileDialogMode === 'new' && !input.includes('.') ? `${input}.cs` : input);
    if (fileDialogMode === 'new') {
      if (project.files.some(file => file.path === path)) throw new Error(`A file named ${path} already exists.`);
      const kind = projectFileKind(path);
      if (kind === 'native-archive') throw new Error('Upload validated .a files with the upload button or drag and drop.');
      const file: ProjectFile = { id: crypto.randomUUID(), path, kind, text: '' };
      validateProjectFiles([...project.files, file]);
      project.files.push(file);
      revision++;
      openFile(file.id);
    } else {
      const file = fileDialogFile;
      if (!file) return;
      if (projectFileKind(path) !== file.kind) throw new Error('The renamed file must keep the same file type.');
      if (project.files.some(candidate => candidate !== file && candidate.path === path)) throw new Error(`A file named ${path} already exists.`);
      file.path = path;
      models.get(file.id)?.dispose();
      models.delete(file.id);
      revision++;
      openFile(file.id);
    }
    fileDialog.close();
    invalidateDownload();
    scheduleSave();
  } catch (error) { el('file-dialog-error').textContent = errorSummary(error); }
};
el<HTMLButtonElement>('import-files').onclick = () => el<HTMLInputElement>('file-input').click();
async function importProjectFiles(uploadedFiles: readonly File[]) {
  const imported: ProjectFile[] = [];
  for (const uploaded of uploadedFiles) {
    try {
      const path = normalizeProjectPath(uploaded.name);
      if (project.files.some(file => file.path === path) || imported.some(file => file.path === path))
        throw new Error(`A file named ${path} already exists.`);
      const kind = projectFileKind(path);
      if (kind === 'native-archive') imported.push({ id: crypto.randomUUID(), path, kind,
        bytes: new Uint8Array(await uploaded.arrayBuffer()), libraryName: inferNativeLibraryName(path), target: 'wasm32' });
      else imported.push({ id: crypto.randomUUID(), path, kind, text: await uploaded.text() });
    } catch (error) { el('status').textContent = errorSummary(error); }
  }
  if (!imported.length) return;
  try { validateProjectFiles([...project.files, ...imported]); project.files.push(...imported); revision++; renderFiles(); openFile(imported[0].id); invalidateDownload(); scheduleSave(); el('status').textContent = `Imported ${imported.length} validated project file${imported.length === 1 ? '' : 's'}`; }
  catch (error) { el('status').textContent = errorSummary(error); }
}
el<HTMLInputElement>('file-input').onchange = event => { const input = event.currentTarget as HTMLInputElement; void importProjectFiles([...(input.files ?? [])]); input.value = ''; };
function renameActiveFile() {
  const file = activeFile();
  if (!file) return;
  showFileDialog('rename', file);
}
function deleteActiveFile() {
  const file = activeFile();
  if (!file) return;
  if (file.kind === 'csharp' && project.files.filter(candidate => candidate.kind === 'csharp').length === 1) return;
  if (!confirm(`Delete ${file.path}?`)) return;
  models.get(file.id)?.dispose(); models.delete(file.id); project.files = project.files.filter(candidate => candidate !== file); openFileIds = openFileIds.filter(id => id !== file.id); project.activeFileId = project.files[0].id; revision++; openFile(project.activeFileId); invalidateDownload(); scheduleSave();
}
el<HTMLButtonElement>('rename-file').onclick = renameActiveFile;
el<HTMLButtonElement>('delete-file').onclick = deleteActiveFile;
let archiveSettingsFile: NativeArchiveProjectFile | undefined;
el<HTMLButtonElement>('archive-properties').onclick = () => {
  const file = activeFile();
  if (!file || file.kind !== 'native-archive') return;
  archiveSettingsFile = file;
  el('archive-path').textContent = `${file.path} · ${file.bytes.byteLength.toLocaleString()} bytes`;
  el<HTMLInputElement>('archive-library-name').value = file.libraryName;
  archiveDialog.showModal();
  el<HTMLInputElement>('archive-library-name').focus();
};
el<HTMLButtonElement>('save-archive-settings').onclick = event => {
  event.preventDefault();
  if (!archiveSettingsFile) return;
  try {
    archiveSettingsFile.libraryName = validateNativeLibraryName(el<HTMLInputElement>('archive-library-name').value);
    models.get(archiveSettingsFile.id)?.dispose(); models.delete(archiveSettingsFile.id);
    revision++; openFile(archiveSettingsFile.id); invalidateDownload(); scheduleSave();
    el('status').textContent = `Native library name set to ${archiveSettingsFile.libraryName}`;
    archiveDialog.close();
  } catch (error) { el('status').textContent = errorSummary(error); }
};
el('file-tree').addEventListener('dblclick', event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-file-id]'); if (button) { openFile(button.dataset.fileId!); renameActiveFile(); } });
el('file-tree').addEventListener('keydown', event => {
  if (event.key !== 'Delete') return;
  deleteActiveFile();
});
el('file-tree').addEventListener('dragover', event => { event.preventDefault(); el('file-tree').classList.add('drop-target'); });
el('file-tree').addEventListener('dragleave', () => el('file-tree').classList.remove('drop-target'));
el('file-tree').addEventListener('drop', event => { event.preventDefault(); el('file-tree').classList.remove('drop-target'); void importProjectFiles([...(event.dataTransfer?.files ?? [])]); });
for (const dialog of [samplesDialog, settingsDialog, fileDialog, archiveDialog]) {
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close('cancel'); });
}
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
setDockCollapsed(localStorage.getItem('netwasm.dockCollapsed') === 'true');
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
