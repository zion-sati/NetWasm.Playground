import type { CompilationResult, PipelineEvent, RunResult, SourceSnapshot, StageTiming, ToolchainPreloadProgress } from './contracts';
import { WorkerChannel } from './worker-channel';
import { optimizationArguments, optimizationModes } from './optimization';
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
type AssetReceipt = { sha256: string; bytes: number; bundle?: string; offset?: number };
type BundleRole = 'compiler' | 'linker' | 'tools' | 'guest';
type BundleReceipt = { path: string; sha256: string; bytes: number; rawBytes: number; assets: number };
type ToolchainManifest = { schemaVersion: number; assets: Record<string, AssetReceipt>; bundles: Record<string, BundleReceipt> };
export class PlaygroundPipeline {
  private channels = new Map<string, WorkerChannel>();
  private context?: SourceSnapshot;
  private root?: URL;
  private rootInitialization?: Promise<void>;
  private manifest?: ToolchainManifest;
  private toolchainId?: string;
  private channelInitializations = new Map<string, Promise<void>>();
  private abort?: AbortController;
  private epoch = 0;
  private assets = { rawBytes: 0, transferBytes: 0 };
  private measuredResources = new Set<string>();
  private bundleProgress = new Map<string, number>();
  private bundleDownloads = new Map<string, Promise<void>>();
  private onPreloadProgress?: (progress: ToolchainPreloadProgress) => void;
  private currentStage = 'download';
  private runOutput?: { stdout: string; stderr: string };
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
  private recordResource(name: string, rawBytes: number, transferBytes: number) {
    if (this.measuredResources.has(name)) return;
    this.measuredResources.add(name);
    const bundle = this.manifest?.bundles[name];
    if (bundle) this.bundleProgress.set(name, bundle.bytes);
    this.assets.rawBytes += rawBytes;
    this.assets.transferBytes += transferBytes;
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
    const timing = performance.getEntriesByName(response.url).at(-1) as PerformanceResourceTiming | undefined;
    this.recordResource(name, entry.rawBytes, timing?.encodedBodySize || entry.bytes);
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
      const timing = performance.getEntriesByName(response.url).at(-1) as PerformanceResourceTiming | undefined;
      this.recordResource(name, entry.bytes, timing?.encodedBodySize || entry.bytes);
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
          this.recordResource(data.assets.name, data.assets.rawBytes, data.assets.transferBytes);
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
    const result = await this.channel('tools').request({ operation, args, files: owned, outputs }, Object.values(owned).map(bytes => bytes.buffer), timeout);
    if (result.exitCode !== 0) throw new Error(result.stderr || result.failure || `${operation} failed`);
    return result.files as Record<string, Uint8Array>;
  }
  async compile(snapshot: SourceSnapshot): Promise<CompilationResult> {
    const optimization = snapshot.optimization ?? 'Oz';
    const epoch = this.epoch; this.context = snapshot; const timings: StageTiming[] = [];
    const result = { requestId: snapshot.requestId, revision: snapshot.revision, optimization,
      language: snapshot.language, updatedMemorySafetyRules: snapshot.updatedMemorySafetyRules,
      diagnostics: [], timings };
    try {
      if (!['hello', 'csharp15-tour', 'datetime', 'http',
        'allocation', 'linq', 'async-linq', 'pipelines', 'web-encoding', 'xml', 'json-dom',
        'json-generated', 'tunit', 'regex', 'di', 'logging', 'hashing'].includes(snapshot.recipeId)) throw new Error('Unknown compilation recipe');
      if (!optimizationModes.includes(optimization)) throw new Error('Unknown optimization mode');
      if (!['15', 'preview'].includes(snapshot.language) ||
          (snapshot.updatedMemorySafetyRules && snapshot.language !== 'preview'))
        throw new Error('Unknown C# language settings');
      if (snapshot.source.length > 65536 || new TextEncoder().encode(snapshot.source).byteLength > 65536) throw new Error('Source limit exceeded (64 KiB)');
      await this.stage('download', timings, () => this.initialize());
      await this.stage('compiler-initialize', timings, () => this.initializeChannel('compiler'));
      const compilation = await this.stage('compile', timings, () => this.channel('compiler').request({
        operation: 'compile', recipe: snapshot.recipeId, source: snapshot.source,
        language: snapshot.language, updatedMemorySafetyRules: snapshot.updatedMemorySafetyRules,
      }));
      for (const timing of compilation.timings ?? []) this.emit({ type: 'stage', stage: timing.stage, state: 'complete', milliseconds: timing.milliseconds });
      if (!compilation.success) return { ...result, success: false, diagnostics: compilation.diagnostics ?? [],
        stage: compilation.stage, error: compilation.error, assets: { ...this.assets } };
      if (compilation.timings) timings.push(...compilation.timings);
      await this.stage('linker-initialize', timings, () => this.initializeChannel('lld'));
      await this.stage('tools-initialize', timings, () => this.initializeChannel('tools'));
      const runtime = await this.stage('link', timings, () => this.channel('lld').request({ operation: 'link', plan: compilation.runtimeLinkPlan }));
      if (!runtime.success) throw new Error(runtime.error || runtime.stderr || 'Runtime link failed');
      const plan = compilation.coreLinkPlan;
      const files: Record<string, Uint8Array> = { 'application.wasm': compilation.application, 'runtime.wasm': runtime.bytes };
      const args = (invocation: any) => invocation.Arguments.map((arg: string) => arg.startsWith('/netwasm-link/') ? basename(arg) : arg);
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
        const packaged = await this.tool('wasm-tools', ['component', 'new', 'embedded.wasm', '--output', 'component.wasm'], embedded, ['component.wasm']);
        await this.tool('wasm-tools', ['validate', 'component.wasm', '--features', 'all'], packaged, []);
        return packaged['component.wasm'];
      });
      if (epoch !== this.epoch) throw new Error('Stopped');
      return { ...result, success: true, component, componentContract: compilation.componentContract,
        frontendCacheMetrics: compilation.frontendCacheMetrics, assets: { ...this.assets } };
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
      if (!['command', 'async-command'].includes(componentContract)) throw new Error('Invalid compiled component contract');
      await this.initialize(); this.channels.get('guest')?.reset(); this.channels.delete('guest');
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
    finally { this.channels.get('guest')?.reset(); this.channels.delete('guest'); this.runOutput = undefined; this.context = undefined; }
  }
  stop() { this.epoch++; this.abort?.abort(); for (const channel of this.channels.values()) channel.reset(); this.channelInitializations.clear(); }
  dispose() { this.stop(); this.channels.clear(); }
}
