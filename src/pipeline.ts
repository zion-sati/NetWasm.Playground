import type { CompilationResult, PipelineEvent, RunResult, SourceSnapshot, StageTiming, ToolchainPreloadProgress } from './contracts';
import { createProject, isTextProjectFile, serializeSourceSet, validateProjectFiles } from './workspace';
import { WorkerChannel } from './worker-channel';
import { optimizationArguments, optimizationModes } from './optimization';
import { createFrontendCache } from './workers/frontend-cache.mjs';
import { createNativeWasmOptChannel, supportsNativeWasmOpt } from './workers/native-wasm-opt-channel.mjs';
import { materializeRuntimeLinkPlan } from './runtime-link-plan.mjs';
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const compilerTimeoutMilliseconds = 300_000;
type RawCoreImport = { Module: string; Name: string; Parameters: number[]; Results: number[] };
const rawCoreValueTypes = new Map([['i32', 0], ['i64', 1], ['f32', 2], ['f64', 3]]);

function parseCoreFunctionImports(bytes: Uint8Array): RawCoreImport[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const types = new Map<number, { Parameters: number[]; Results: number[] }>();
  const imports: RawCoreImport[] = [];
  const values = (source: string | undefined) => source ? source.trim().split(/\s+/u).map(value => {
    const mapped = rawCoreValueTypes.get(value);
    if (mapped === undefined) throw new Error(`Unsupported core Wasm value type: ${value}`);
    return mapped;
  }) : [];
  for (const line of text.split('\n')) {
    const type = /^\s*\(type \(;([0-9]+);\) \(func(?: \(param ([^)]*)\))?(?: \(result ([^)]*)\))?\)\)\s*$/u.exec(line);
    if (type) {
      const index = Number(type[1]);
      if (types.has(index) || index !== types.size) throw new Error('Invalid core Wasm type inventory');
      types.set(index, { Parameters: values(type[2]), Results: values(type[3]) });
      continue;
    }
    if (!line.trimStart().startsWith('(import ')) continue;
    const imported = /^\s*\(import ("(?:\\.|[^"\\])*") ("(?:\\.|[^"\\])*") \(func \(;[0-9]+;\) \(type ([0-9]+)\)\)\)\s*$/u.exec(line);
    if (!imported) continue;
    const signature = types.get(Number(imported[3]));
    if (!signature) throw new Error('Core Wasm import references an unknown type');
    imports.push({ Module: JSON.parse(imported[1]), Name: JSON.parse(imported[2]),
      Parameters: [...signature.Parameters], Results: [...signature.Results] });
  }
  if (types.size === 0 || imports.length > 512) throw new Error('Invalid core Wasm import inventory');
  return imports;
}

function lowerCamelData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(lowerCamelData);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([name, member]) =>
    [name[0].toLowerCase() + name.slice(1), lowerCamelData(member)]));
}
type AssetReceipt = { sha256: string; bytes: number; bundle?: string; offset?: number };
type BundleRole = 'compiler' | 'linker' | 'tools' | 'guest';
type BundleReceipt = { path: string; sha256: string; bytes: number; rawBytes: number; assets: number };
type ToolchainManifest = { schemaVersion: number; assets: Record<string, AssetReceipt>; bundles: Record<string, BundleReceipt> };
type CompressionReceipt = { rawBytes: number; compressedBytes: number };
type ToolchainCompressionReceipt = {
  schemaVersion: number;
  toolchainId: string;
  toolchainManifestSha256: string;
  compression: string;
  rawBytes: number;
  compressedBytes: number;
  files: Record<string, CompressionReceipt>;
};
type NativeWasmOptChannel = ReturnType<typeof createNativeWasmOptChannel>;
export class PlaygroundPipeline {
  private channels = new Map<string, WorkerChannel>();
  private context?: SourceSnapshot;
  private root?: URL;
  private rootInitialization?: Promise<void>;
  private manifest?: ToolchainManifest;
  private compressionReceipt?: ToolchainCompressionReceipt;
  private toolchainId?: string;
  private runtimeCache?: ReturnType<typeof createFrontendCache>;
  private channelInitializations = new Map<string, Promise<void>>();
  private abort?: AbortController;
  private epoch = 0;
  private assets: { rawBytes: number; compressedBytes?: number } = { rawBytes: 0, compressedBytes: 0 };
  private compressionComplete = true;
  private measuredResources = new Set<string>();
  private bundleProgress = new Map<string, number>();
  private bundleDownloads = new Map<string, Promise<void>>();
  private onPreloadProgress?: (progress: ToolchainPreloadProgress) => void;
  private currentStage = 'download';
  private runOutput?: { stdout: string; stderr: string };
  private nativeWasmOpt?: NativeWasmOptChannel;
  private nativeWasmOptUnavailable = false;
  private optimizerHost?: 'native-threads' | 'javascript';
  private optimizerWorkerCount?: number;
  private optimizerLinearMemoryBytes?: number;
  private optimizerFallback?: string;
  constructor(private onEvent: (event: PipelineEvent) => void) {}
  private emit(event: object) { if (this.context) this.onEvent({ requestId: this.context.requestId, revision: this.context.revision, ...event } as PipelineEvent); }
  private reportPreloadProgress() {
    if (!this.onPreloadProgress) return;
    const names = this.manifest ? Object.keys(this.manifest.bundles) : [];
    const totalBundleBytes = names.reduce((total, name) => total + this.manifest!.bundles[name].bytes, 0);
    const loadedBundleBytes = names.reduce((total, name) => total + (this.bundleProgress.get(name) ?? 0), 0);
    this.onPreloadProgress({
      completedBundles: names.filter(name => this.measuredResources.has(name)).length,
      totalBundles: names.length,
      loadedBundleBytes,
      totalBundleBytes,
      ...this.assets,
    });
  }
  private recordBundleProgress(name: string, loadedBytes: number, totalBytes: number) {
    const receipt = this.manifest?.bundles[name];
    if (!receipt || receipt.bytes !== totalBytes || !Number.isSafeInteger(loadedBytes) || loadedBytes < 0 || loadedBytes > totalBytes) return;
    if (loadedBytes <= (this.bundleProgress.get(name) ?? 0)) return;
    this.bundleProgress.set(name, loadedBytes);
    this.reportPreloadProgress();
  }
  private recordResource(name: string, rawBytes: number) {
    if (this.measuredResources.has(name)) return;
    this.measuredResources.add(name);
    const bundle = this.manifest?.bundles[name];
    if (bundle) this.bundleProgress.set(name, bundle.bytes);
    this.assets.rawBytes += rawBytes;
    const compressed = this.compressionReceipt?.files[bundle?.path ?? name];
    if (!compressed || compressed.rawBytes !== rawBytes) {
      this.compressionComplete = false;
      this.assets.compressedBytes = undefined;
    } else if (this.compressionComplete) {
      this.assets.compressedBytes = (this.assets.compressedBytes ?? 0) + compressed.compressedBytes;
    }
    this.emit({ type: 'assets', ...this.assets });
    this.reportPreloadProgress();
  }
  private async initialize() {
    if (!this.abort || this.abort.signal.aborted) this.abort = new AbortController();
    if (this.root) return;
    await (this.rootInitialization ??= (async () => {
      const signal = this.abort!.signal;
      const base = new URL(`${import.meta.env.BASE_URL}toolchain/`, location.origin);
      const response = await fetch(new URL('index.json', base), { signal, cache: 'no-cache' });
      if (!response.ok) throw new Error('Toolchain assets unavailable. Run the asset preparation command.');
      const index = await response.json();
      if (!/^[a-f0-9]{64}$/.test(index.id)) throw new Error('Invalid toolchain version');
      this.toolchainId = index.id;
      this.runtimeCache ??= createFrontendCache(index.id);
      const root = new URL(`${index.id}/`, base);
      const manifestResponse = await fetch(new URL('asset-manifest.json', root), { signal, cache: 'force-cache' });
      if (!manifestResponse.ok) throw new Error('Toolchain manifest unavailable');
      const bytes = new Uint8Array(await manifestResponse.arrayBuffer());
      await this.verify(bytes, index.manifestSha256);
      const manifest = JSON.parse(new TextDecoder().decode(bytes)) as ToolchainManifest;
      if (manifest.schemaVersion !== 3 || !manifest.assets || Array.isArray(manifest.assets) ||
          !manifest.bundles || Array.isArray(manifest.bundles) ||
          Object.keys(manifest.bundles).sort().join(',') !== 'compiler,guest,linker,tools')
        throw new Error('Invalid toolchain manifest');
      const compressionResponse = await fetch(new URL('compression-receipt.json', base),
        { signal, cache: 'no-cache' });
      if (compressionResponse.ok &&
          compressionResponse.headers.get('content-type')?.includes('application/json')) {
        const compression = await compressionResponse.json() as ToolchainCompressionReceipt;
        const entries = Object.entries(compression.files ?? {});
        if (compression.schemaVersion !== 1 || compression.toolchainId !== index.id ||
            compression.toolchainManifestSha256 !== index.manifestSha256 || entries.length > 2048 ||
            compression.compression !== 'Brotli quality 11 sidecars for .wasm and .bin; original bytes for other files' ||
            !Number.isSafeInteger(compression.rawBytes) || compression.rawBytes < 0 ||
            !Number.isSafeInteger(compression.compressedBytes) || compression.compressedBytes < 0 ||
            entries.some(([name, receipt]) => !name || name.startsWith('/') ||
              name.split('/').some(part => !part || part === '.' || part === '..') ||
              !Number.isSafeInteger(receipt.rawBytes) || receipt.rawBytes < 0 || receipt.rawBytes > 134217728 ||
              !Number.isSafeInteger(receipt.compressedBytes) || receipt.compressedBytes < 0 ||
              receipt.compressedBytes > 134217728) ||
            entries.reduce((total, [, receipt]) => total + receipt.rawBytes, 0) !== compression.rawBytes ||
            entries.reduce((total, [, receipt]) => total + receipt.compressedBytes, 0) !== compression.compressedBytes)
          throw new Error('Invalid toolchain compression receipt');
        this.compressionReceipt = compression;
      }
      this.manifest = manifest;
      this.root = root;
    })().catch(error => { this.rootInitialization = undefined; throw error; }));
  }
  private async verify(bytes: Uint8Array, expected: string) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
    const actual = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== expected) throw new Error('Toolchain asset integrity check failed');
  }
  private async fetchBundle(name: string, entry: BundleReceipt) {
    if (!entry || !/^(?:compiler|linker|tools|guest)$/.test(name) ||
        entry.path !== `bundles/${name}.${entry.sha256}.bin` || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 134217728 ||
        entry.rawBytes !== entry.bytes || !Number.isSafeInteger(entry.assets) || entry.assets < 1 || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw new Error(`Invalid toolchain bundle receipt: ${name}`);
    const url = new URL(entry.path, this.root!);
    const response = await fetch(url, { signal: this.abort!.signal, cache: 'force-cache' });
    if (!response.ok) throw new Error(`Toolchain bundle unavailable: ${name}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`Toolchain bundle body unavailable: ${name}`);
    const chunks: Uint8Array[] = [];
    let length = 0, reported = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > entry.bytes) throw new Error(`Toolchain bundle length failed: ${name}`);
        chunks.push(value);
        if (length === entry.bytes || length - reported >= 524288) {
          reported = length;
          this.recordBundleProgress(name, length, entry.bytes);
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (bytes.byteLength !== entry.bytes) throw new Error(`Toolchain bundle length failed: ${name}`);
    await this.verify(bytes, entry.sha256);
    this.recordResource(name, entry.rawBytes);
    return bytes;
  }
  private preloadBundle(name: string, entry: BundleReceipt) {
    let download = this.bundleDownloads.get(name);
    if (!download) {
      download = this.fetchBundle(name, entry).then(() => undefined);
      this.bundleDownloads.set(name, download);
      void download.catch(() => {
        if (this.bundleDownloads.get(name) === download) this.bundleDownloads.delete(name);
      });
    }
    return download;
  }
  private async loadAsset(name: string) {
    const entry = this.manifest!.assets[name];
    if (!entry || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw new Error(`Invalid toolchain asset receipt: ${name}`);
    let bytes: Uint8Array;
    if (entry.bundle) {
      if (!Number.isSafeInteger(entry.offset) || entry.offset! < 0) throw new Error(`Invalid toolchain asset range: ${name}`);
      const bundle = await this.fetchBundle(entry.bundle, this.manifest!.bundles[entry.bundle]);
      bytes = bundle.slice(entry.offset, entry.offset! + entry.bytes);
    } else {
      const response = await fetch(new URL(name, this.root!), { signal: this.abort!.signal, cache: 'force-cache' });
      if (!response.ok) throw new Error(`Toolchain asset unavailable: ${name}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      this.recordResource(name, entry.bytes);
    }
    if (bytes.byteLength !== entry.bytes) throw new Error(`Toolchain asset length failed: ${name}`);
    await this.verify(bytes, entry.sha256);
    return bytes;
  }
  private async preloadRemainingBundles() {
    await Promise.all(Object.entries(this.manifest!.bundles)
      .map(([name, entry]) => this.preloadBundle(name, entry)));
  }
  private channel(name: string) {
    let channel = this.channels.get(name);
    if (!channel) {
      channel = new WorkerChannel(new URL(`workers/${name}-worker.mjs`, this.root!), data => {
        if (data.stage && !['wasm-tools', 'wasm-merge', 'wasm-opt'].includes(data.stage)) {
          const state = data.state === 'complete' ? 'complete' : 'running';
          if (state === 'running') this.currentStage = data.stage;
          this.emit({ type: 'stage', stage: data.stage, state,
            ...(state === 'complete' && Number.isFinite(data.milliseconds) ? { milliseconds: data.milliseconds } : {}) });
        }
        if (data.console) {
          if (this.runOutput && (data.console === 'stdout' || data.console === 'stderr')) this.runOutput[data.console as 'stdout' | 'stderr'] += data.text ?? '';
          this.emit({ type: 'console', stream: data.console, text: data.text ?? '' });
        }
        if (data.assets?.loadedBytes !== undefined)
          this.recordBundleProgress(data.assets.name, data.assets.loadedBytes, data.assets.totalBytes);
        else if (data.assets)
          this.recordResource(data.assets.name, data.assets.rawBytes);
      });
      this.channels.set(name, channel);
    }
    return channel;
  }
  private initializeChannel(name: 'compiler' | 'lld' | 'tools') {
    let initialization = this.channelInitializations.get(name);
    if (!initialization) {
      const bundleName: BundleRole = name === 'lld' ? 'linker' : name;
      initialization = this.preloadBundle(bundleName, this.manifest!.bundles[bundleName])
        .then(() => this.channel(name).request({ operation: 'initialize',
          ...(name === 'compiler' ? { toolchainId: this.toolchainId } : {}) }))
        .then(() => undefined);
      this.channelInitializations.set(name, initialization);
      void initialization.catch(() => {
        if (this.channelInitializations.get(name) === initialization) this.channelInitializations.delete(name);
      });
    }
    return initialization;
  }
  async preload(onProgress: (progress: ToolchainPreloadProgress) => void = () => {}) {
    this.onPreloadProgress = onProgress;
    this.reportPreloadProgress();
    try {
      await this.initialize();
      this.reportPreloadProgress();
      await Promise.all([
        this.preloadRemainingBundles(),
        this.initializeChannel('compiler'),
        this.initializeChannel('lld'),
        this.initializeChannel('tools'),
      ]);
      this.reportPreloadProgress();
      return { ...this.assets };
    } finally {
      this.onPreloadProgress = undefined;
    }
  }
  private async stage<T>(name: string, timings: StageTiming[], action: () => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    this.currentStage = name; this.emit({ type: 'stage', stage: name, state: 'running' });
    const started = performance.now(); const result = await action();
    if (epoch !== this.epoch) throw new Error('Stopped');
    const milliseconds = performance.now() - started;
    timings.push({ stage: name, milliseconds }); this.emit({ type: 'stage', stage: name, state: 'complete', milliseconds }); return result;
  }
  private async tool(operation: string, args: string[], files: Record<string, Uint8Array>, outputs: string[], timeout = 120_000) {
    // Snapshot input buffers because callers may retain an artifact for later stages.
    const owned = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, bytes.slice()]));
    let result;
    const nativeWasmOptAvailable = operation === 'wasm-opt' && this.canUseNativeWasmOpt();
    if (nativeWasmOptAvailable) {
      const nativeOwned = Object.fromEntries(Object.entries(owned).map(([name, bytes]) => [name, bytes.slice()]));
      try {
        result = await this.nativeWasmOptChannel().request(
          { operation, args, files: nativeOwned, outputs },
          Object.values(nativeOwned).map(bytes => bytes.buffer), timeout);
        this.optimizerHost = 'native-threads';
        this.optimizerWorkerCount = result.workerCount;
        this.optimizerLinearMemoryBytes = result.memoryBytes;
      } catch (error) {
        if (this.abort?.signal.aborted) throw error;
        this.nativeWasmOpt?.reset();
        this.nativeWasmOpt = undefined;
        this.nativeWasmOptUnavailable = true;
        this.optimizerHost = 'javascript';
        this.optimizerWorkerCount = undefined;
        this.optimizerLinearMemoryBytes = undefined;
        this.optimizerFallback = String(error).split('\n')[0].slice(0, 300);
      }
    }
    if (operation === 'wasm-opt' && !nativeWasmOptAvailable) {
      this.optimizerHost = 'javascript';
      this.optimizerFallback ??= 'Cross-origin isolation or native optimizer assets are unavailable';
    }
    result ??= await this.channel('tools').request({ operation, args, files: owned, outputs }, Object.values(owned).map(bytes => bytes.buffer), timeout);
    if (operation === 'wasm-opt' && this.optimizerHost === undefined) this.optimizerHost = 'javascript';
    if (result.exitCode !== 0) throw new Error(result.stderr || result.failure || `${operation} failed`);
    return result.files as Record<string, Uint8Array>;
  }
  private canUseNativeWasmOpt() {
    return !this.nativeWasmOptUnavailable && supportsNativeWasmOpt() &&
      ['build-receipt.json', 'wasm-opt.js', 'wasm-opt.wasm']
        .every(name => this.manifest?.assets[`native-wasm-opt/${name}`]);
  }
  private nativeWasmOptChannel() {
    return this.nativeWasmOpt ??= createNativeWasmOptChannel(
      new URL('native-wasm-opt/', this.root!).href,
      () => this.loadAsset('native-wasm-opt/wasm-opt.wasm'));
  }
  private async nativeLibraries(snapshot: SourceSnapshot) {
    const libraries: { LibraryName: string; Target: 'wasm32'; Path: string; Sha256: string }[] = [];
    const files: Record<string, Uint8Array> = {};
    for (const [index, file] of snapshot.files.filter(file => file.kind === 'native-archive').entries()) {
      const path = `/netwasm-link/user-native/archive-${index}.a`;
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', file.bytes.slice().buffer));
      const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      libraries.push({ LibraryName: file.libraryName, Target: file.target, Path: path, Sha256: sha256 });
      files[path] = file.bytes.slice();
    }
    return { json: JSON.stringify(libraries), files };
  }
  async compile(snapshot: SourceSnapshot): Promise<CompilationResult> {
    const optimization = snapshot.optimization ?? 'Oz';
    const epoch = this.epoch; this.context = snapshot; const timings: StageTiming[] = [];
    this.optimizerHost = undefined; this.optimizerFallback = undefined;
    this.optimizerWorkerCount = undefined; this.optimizerLinearMemoryBytes = undefined;
    const result = { requestId: snapshot.requestId, revision: snapshot.revision, optimization,
      language: snapshot.language, updatedMemorySafetyRules: snapshot.updatedMemorySafetyRules,
      diagnostics: [], timings };
    try {
      if (!['hello', 'multi-file', 'span-memory-unsafe', 'csharp15-tour', 'datetime', 'http',
        'allocation', 'linq', 'async-linq', 'pipelines', 'web-encoding', 'xml', 'json-dom',
        'json-generated', 'tunit', 'regex', 'di', 'logging', 'hashing',
        'fluentvalidation', 'native-lz4', 'web-worker'].includes(snapshot.recipeId)) throw new Error('Unknown compilation recipe');
      if (!optimizationModes.includes(optimization)) throw new Error('Unknown optimization mode');
      if (!['15', 'preview'].includes(snapshot.language) ||
          (snapshot.updatedMemorySafetyRules && snapshot.language !== 'preview'))
        throw new Error('Unknown C# language settings');
      const projectFiles = snapshot.files?.length
        ? snapshot.files
        : createProject('Legacy project', [{ path: snapshot.recipeId === 'tunit' ? 'Tests.cs' : 'Program.cs', text: snapshot.source ?? '' }]).files;
      validateProjectFiles(projectFiles);
      const sourceSet = serializeSourceSet(projectFiles);
      const nativeLibraries = await this.nativeLibraries(snapshot);
      await this.stage('download', timings, () => this.initialize());
      await this.stage('compiler-initialize', timings, () => this.initializeChannel('compiler'));
      const compilation = await this.stage('compile', timings, () => this.channel('compiler').request({
        operation: 'compile', recipe: snapshot.recipeId, sourceSet,
        projectKind: snapshot.projectKind ?? 'command', nativeLibrariesJson: nativeLibraries.json,
        language: snapshot.language, updatedMemorySafetyRules: snapshot.updatedMemorySafetyRules,
        optimization,
      }, [], compilerTimeoutMilliseconds));
      for (const timing of compilation.timings ?? []) this.emit({ type: 'stage', stage: timing.stage, state: 'complete', milliseconds: timing.milliseconds });
      if (!compilation.success) return { ...result, success: false, diagnostics: compilation.diagnostics ?? [],
        stage: compilation.stage, error: compilation.error, assets: { ...this.assets } };
      if (compilation.timings) timings.push(...compilation.timings);
      const args = (invocation: any) => invocation.Arguments.map((arg: string) => arg.startsWith('/netwasm-link/') ? basename(arg) : arg);
      const runtimePlan = await materializeRuntimeLinkPlan(
        compilation.runtimeLinkPlan, compilation.runtimeFeatures);
      const runtimeLookup = await this.stage('runtime-cache-read', timings,
        () => this.runtimeCache!.loadRuntime(runtimePlan.Cache));
      let runtimeBytes: Uint8Array;
      let runtimeCacheWritten = false;
      if (runtimeLookup.hit) runtimeBytes = runtimeLookup.payload;
      else {
        await this.stage('linker-initialize', timings, () => this.initializeChannel('lld'));
        await this.stage('tools-initialize', timings, () => this.initializeChannel('tools'));
        const runtime = await this.stage('link', timings,
          () => {
            const selected = Object.fromEntries((runtimePlan.Inputs as { Path: string }[])
              .filter((input: { Path: string }) => input.Path.startsWith('/netwasm-link/user-native/'))
              .map((input: { Path: string }) => {
                const bytes = nativeLibraries.files[input.Path];
                if (!bytes) throw new Error(`Selected native archive is unavailable: ${input.Path}`);
                return [input.Path, bytes.slice()];
              }));
            return this.channel('lld').request({ operation: 'link', plan: runtimePlan, files: selected },
              Object.values(selected).map(bytes => bytes.buffer));
          });
        if (!runtime.success) throw new Error(runtime.error || runtime.stderr || 'Runtime link failed');
        runtimeBytes = runtime.bytes;
        if (optimization !== 'none') {
          const runtimeOptimizationArguments = args({ Arguments: runtimePlan.OptimizationArguments });
          const outputIndex = runtimeOptimizationArguments.lastIndexOf('-o') + 1;
          if (outputIndex <= 0 || outputIndex >= runtimeOptimizationArguments.length)
            throw new Error('Runtime optimization plan has no output');
          // The native CLI can replace its input in place. The browser tool host
          // keeps inputs immutable, so give the equivalent output a distinct name.
          runtimeOptimizationArguments[outputIndex] = 'runtime-optimized.wasm';
          runtimeBytes = (await this.stage('runtime-optimize', timings, () =>
            this.tool('wasm-opt', runtimeOptimizationArguments,
              { 'runtime.wasm': runtimeBytes }, ['runtime-optimized.wasm'], 300_000)))['runtime-optimized.wasm'];
        }
        await this.stage('runtime-validate', timings, () => this.tool('wasm-tools',
          ['validate', 'runtime.wasm', '--features', 'all'], { 'runtime.wasm': runtimeBytes }, []));
        const checksum = new Uint8Array(await crypto.subtle.digest(
          'SHA-256', runtimeBytes.slice().buffer));
        runtimeCacheWritten = await this.stage('runtime-cache-write', timings,
          () => this.runtimeCache!.writeRuntime(runtimePlan.Cache, runtimeBytes, checksum));
      }
      if (runtimeLookup.hit)
        await this.stage('tools-initialize', timings, () => this.initializeChannel('tools'));
      if (compilation.componentContract === 'jsexport-worker') {
        const plan = compilation.rawCoreLinkPlan;
        if (!plan || !compilation.rawBindingHandle) throw new Error('Compiler returned no raw worker link plan');
        const files: Record<string, Uint8Array> = {
          'application.wasm': compilation.application,
          'runtime.wasm': runtimeBytes,
        };
        for (const textModule of plan.TextModules) {
          const output = basename(textModule.OutputPath), input = `${output}.wat`;
          Object.assign(files, await this.stage('parse', timings, () => this.tool('wasm-tools',
            ['parse', input, '--output', output],
            { [input]: new TextEncoder().encode(textModule.Text) }, [output])));
        }
        const mergedName = basename(plan.ExportPruning?.InputPath ?? plan.Copy?.InputPath ?? plan.Validation.Path);
        const merged = await this.stage('merge', timings, () =>
          this.tool('wasm-merge', args(plan.Merge), files, [mergedName]));
        let linked = merged[mergedName];
        if (plan.ExportPruning) {
          const pruned = await this.stage('prune', timings, () => this.channel('compiler').request({
            operation: 'pruneRaw', module: linked, exports: plan.ExportPruning.RemovedExports,
          }, [linked.buffer]));
          linked = pruned.module;
        }
        if (plan.Optimization) {
          linked = (await this.stage('optimize', timings, () => this.tool('wasm-opt',
            optimizationArguments(args(plan.Optimization), optimization),
            { [basename(plan.ExportPruning?.OutputPath ?? plan.Copy?.InputPath ?? mergedName)]: linked },
            [basename(plan.Validation.Path)], 300_000)))[basename(plan.Validation.Path)];
        }
        const validationArguments = plan.Validation.Arguments.map((argument: string) =>
          argument.startsWith('/netwasm-link/') ? basename(argument) : argument);
        await this.stage('validate', timings, () => this.tool('wasm-tools', validationArguments,
          { [basename(plan.Validation.Path)]: linked }, []));
        const runtimeSkeleton = await this.stage('inspect-runtime', timings, () => this.tool('wasm-tools',
          ['print', 'runtime.wasm', '--skeleton', '-o', 'runtime.wat'],
          { 'runtime.wasm': runtimeBytes }, ['runtime.wat']));
        const finalSkeleton = await this.stage('inspect-application', timings, () => this.tool('wasm-tools',
          ['print', 'application.wasm', '--skeleton', '-o', 'application.wat'],
          { 'application.wasm': linked }, ['application.wat']));
        const rawBindings = await this.stage('bindings', timings, () =>
          this.channel('compiler').request({
            operation: 'buildRawBindings', handle: compilation.rawBindingHandle,
            runtimeImports: parseCoreFunctionImports(runtimeSkeleton['runtime.wat']),
            finalImports: parseCoreFunctionImports(finalSkeleton['application.wat']),
          }));
        const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
        const runtimeLayout = encode({
          schemaVersion: 3,
          target: 'wasm32',
          applicationStaticDataEnd: compilation.staticDataEnd,
          managedExecutableEntryPoint: null,
          runtimeFeatures: compilation.runtimeFeatures,
          nativeImports: [],
        });
        const interopManifest = encode(lowerCamelData(compilation.interopManifest));
        if (epoch !== this.epoch) throw new Error('Stopped');
        return { ...result, success: true, component: linked,
          componentContract: 'jsexport-worker', rawAdapter: rawBindings.adapter,
          runtimeLayout, interopManifest, requiredImports: rawBindings.requiredImports,
          compilerHostLinearMemoryBytes: rawBindings.hostLinearMemoryBytes,
          optimizerHost: this.optimizerHost,
          optimizerWorkerCount: this.optimizerWorkerCount,
          optimizerLinearMemoryBytes: this.optimizerLinearMemoryBytes,
          optimizerFallback: this.optimizerFallback,
          runtimeCacheMetrics: {
            outcome: runtimeLookup.hit ? 'hit' : runtimeLookup.available ? 'miss' : 'unavailable',
            readBytes: runtimeLookup.payload?.byteLength ?? 0,
            written: runtimeCacheWritten,
          },
          assets: { ...this.assets } };
      }
      const plan = compilation.coreLinkPlan;
      const files: Record<string, Uint8Array> = { 'application.wasm': compilation.application, 'runtime.wasm': runtimeBytes };
      for (const module of plan.TextModules) {
        const output = basename(module.OutputPath), input = `${output}.wat`;
        Object.assign(files, await this.stage('parse', timings, () => this.tool('wasm-tools', ['parse', input, '--output', output], { [input]: new TextEncoder().encode(module.Text) }, [output])));
      }
      const mergedName = basename(plan.ExportPruning.InputPath);
      const merged = await this.stage('merge', timings, () => this.tool('wasm-merge', args(plan.Merge), files, [mergedName]));
      const module = merged[mergedName];
      const pruned = await this.stage('prune', timings, () => this.channel('compiler').request({ operation: 'prune', module, prefix: plan.ExportPruning.Prefix }, [module.buffer]));
      const linked = optimization === 'none' ? pruned.module : (await this.stage('optimize', timings, () =>
        this.tool('wasm-opt', optimizationArguments(args(plan.Optimization), optimization),
          { [basename(plan.ExportPruning.OutputPath)]: pruned.module }, ['linked.wasm'], 300_000)))['linked.wasm'];
      await this.stage('validate', timings, () => this.tool('wasm-tools', ['validate', 'linked.wasm'], { 'linked.wasm': linked }, []));
      if (!['command', 'async-command'].includes(compilation.componentContract))
        throw new Error('Compiler returned an invalid component contract');
      const asynchronous = compilation.componentContract === 'async-command';
      const witName = asynchronous ? 'async-command.wit.wasm' : 'command.wit.wasm';
      const witWorld = snapshot.recipeId === 'http' ? 'netwasm:component/async-http-command@1.0.0'
        : asynchronous ? 'netwasm:component/async-command@1.0.0' : 'wasi:cli/command@0.2.11';
      const wit = await this.loadAsset(witName);
      const component = await this.stage('componentization', timings, async () => {
        const embedded = await this.tool('wasm-tools', ['component', 'embed', witName, 'linked.wasm', '--encoding', 'utf8', '--output', 'embedded.wasm', '--world', witWorld], { [witName]: wit, 'linked.wasm': linked }, ['embedded.wasm']);
        const packaged = await this.tool('wasm-tools', ['component', 'new', 'embedded.wasm', '--output', 'component-unstripped.wasm'], embedded, ['component-unstripped.wasm']);
        const stripped = await this.tool('wasm-tools', ['strip', '--all', 'component-unstripped.wasm', '--output', 'component.wasm'], packaged, ['component.wasm']);
        await this.tool('wasm-tools', ['validate', 'component.wasm', '--features', 'all'], stripped, []);
        return stripped['component.wasm'];
      });
      if (epoch !== this.epoch) throw new Error('Stopped');
      return { ...result, success: true, component, componentContract: compilation.componentContract,
        frontendCacheMetrics: compilation.frontendCacheMetrics,
        compilerHostLinearMemoryBytes: compilation.hostLinearMemoryBytes,
        optimizerHost: this.optimizerHost,
        optimizerWorkerCount: this.optimizerWorkerCount,
        optimizerLinearMemoryBytes: this.optimizerLinearMemoryBytes,
        optimizerFallback: this.optimizerFallback,
        runtimeCacheMetrics: {
          outcome: runtimeLookup.hit ? 'hit' : runtimeLookup.available ? 'miss' : 'unavailable',
          readBytes: runtimeLookup.payload?.byteLength ?? 0,
          written: runtimeCacheWritten,
        },
        assets: { ...this.assets } };
    } catch (error) { return { ...result, success: false, cancelled: epoch !== this.epoch, stage: this.currentStage, error: String(error) }; }
    finally {
      // A managed compiler's WebAssembly memory can grow but cannot shrink.
      // End every compilation with a fresh compiler-worker boundary so one
      // request's high-water mark cannot become the next request's baseline.
      this.channels.get('compiler')?.reset();
      this.channels.delete('compiler');
      this.channelInitializations.delete('compiler');
      this.context = undefined;
    }
  }
  async run(compilation: CompilationResult, snapshot: SourceSnapshot): Promise<RunResult> {
    this.context = snapshot; const epoch = this.epoch; const timings: StageTiming[] = [];
    this.runOutput = { stdout: '', stderr: '' };
    const base = { requestId: snapshot.requestId, revision: snapshot.revision, timings, stdout: '', stderr: '' };
    try {
      if (!compilation.component) throw new Error('No compiled component');
      const componentContract = compilation.componentContract ?? 'command';
      if (!['command', 'async-command', 'jsexport-worker'].includes(componentContract))
        throw new Error('Invalid compiled component contract');
      await this.initialize();
      if (componentContract === 'jsexport-worker') {
        if (!compilation.rawAdapter || !compilation.runtimeLayout || !compilation.interopManifest ||
            !compilation.requiredImports) throw new Error('Raw worker artifacts are incomplete');
        const modules = [...new Set((JSON.parse(new TextDecoder().decode(compilation.interopManifest)).imports ?? [])
          .map((value: { module?: unknown }) => value.module)
          .filter((value: unknown): value is string => typeof value === 'string' && value !== 'netwasm.host.v1'))];
        const scripts = snapshot.files.filter(isTextProjectFile).filter(file => file.path.endsWith('.mjs'));
        if (modules.length !== 1 || scripts.length !== 1)
          throw new Error('The Playground worker sample requires one JavaScript import module');
        this.channels.get('raw-guest')?.reset(); this.channels.delete('raw-guest');
        const module = compilation.component.slice();
        const adapter = compilation.rawAdapter.slice();
        const runtimeLayout = compilation.runtimeLayout.slice();
        const interopManifest = compilation.interopManifest.slice();
        const result = await this.stage('run', timings, async () => {
          const bundleName: BundleRole = 'guest';
          await this.preloadBundle(bundleName, this.manifest!.bundles[bundleName]);
          return this.channel('raw-guest').request({
            operation: 'run', module, adapter, runtimeLayout, interopManifest,
            requiredImports: compilation.requiredImports,
            moduleName: modules[0], moduleSource: scripts[0].text,
            exportName: 'run', arguments: [5],
          }, [module.buffer, adapter.buffer, runtimeLayout.buffer, interopManifest.buffer], 60_000, 5_000);
        });
        const completion = `Completed: ${String(result.value)}\n`;
        this.runOutput.stdout += completion;
        this.emit({ type: 'console', stream: 'stdout', text: completion });
        return { ...base, ...result, ...this.runOutput,
          timings: [...timings, ...(result.timings ?? [])] };
      }
      this.channels.get('guest')?.reset(); this.channels.delete('guest');
      const component = compilation.component.slice();
      const result = await this.stage('run', timings, async () => {
        const bundleName: BundleRole = 'guest';
        await this.preloadBundle(bundleName, this.manifest!.bundles[bundleName]);
        const sampleHttpUrl = snapshot.recipeId === 'http'
          ? new URL(`${import.meta.env.BASE_URL}example-http.json`, location.origin).href : undefined;
        return this.channel('guest').request({ operation: 'run', component, recipe: snapshot.recipeId,
          componentContract,
          sampleHttpUrl }, [component.buffer], 60_000, 5_000);
      });
      for (const timing of result.timings ?? []) this.emit({ type: 'stage', stage: timing.stage, state: 'complete', milliseconds: timing.milliseconds });
      return { ...base, ...result, timings: [...timings, ...(result.timings ?? [])] };
    } catch (error) { return { ...base, ...this.runOutput, success: false, cancelled: epoch !== this.epoch, stage: this.currentStage, error: String(error) }; }
    finally {
      this.channels.get('guest')?.reset(); this.channels.delete('guest');
      this.channels.get('raw-guest')?.reset(); this.channels.delete('raw-guest');
      this.runOutput = undefined; this.context = undefined;
    }
  }
  stop() {
    this.epoch++; this.abort?.abort();
    for (const channel of this.channels.values()) channel.reset();
    this.nativeWasmOpt?.reset(); this.nativeWasmOpt = undefined;
    this.channelInitializations.clear();
  }
  dispose() { this.stop(); this.channels.clear(); this.runtimeCache?.close(); this.runtimeCache = undefined; }
}
