import type { CompilationResult, PipelineEvent, RunResult, SourceSnapshot, StageTiming } from './contracts';
import { WorkerChannel } from './worker-channel';
import { optimizationArguments, optimizationModes } from './optimization';
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export class PlaygroundPipeline {
  private channels = new Map<string, WorkerChannel>();
  private context?: SourceSnapshot;
  private root?: URL;
  private manifest?: { assets: Record<string, { sha256: string; bytes: number }> };
  private abort?: AbortController;
  private epoch = 0;
  private assets = { rawBytes: 0, transferBytes: 0 };
  private measuredAssets = new Set<string>();
  private currentStage = 'download';
  private runOutput?: { stdout: string; stderr: string };
  constructor(private onEvent: (event: PipelineEvent) => void) {}
  private emit(event: object) { if (this.context) this.onEvent({ requestId: this.context.requestId, revision: this.context.revision, ...event } as PipelineEvent); }
  private async initialize() {
    this.abort = new AbortController();
    if (this.root) return;
    const base = new URL(`${import.meta.env.BASE_URL}toolchain/`, location.origin);
    const response = await fetch(new URL('index.json', base), { signal: this.abort.signal, cache: 'no-cache' });
    if (!response.ok) throw new Error('Toolchain assets unavailable. Run the asset preparation command.');
    const index = await response.json();
    if (!/^[a-f0-9]{64}$/.test(index.id)) throw new Error('Invalid toolchain version');
    const root = new URL(`${index.id}/`, base);
    const manifestResponse = await fetch(new URL('asset-manifest.json', root), { signal: this.abort.signal, cache: 'force-cache' });
    if (!manifestResponse.ok) throw new Error('Toolchain manifest unavailable');
    const bytes = new Uint8Array(await manifestResponse.arrayBuffer());
    await this.verify(bytes, index.manifestSha256);
    this.manifest = JSON.parse(new TextDecoder().decode(bytes));
    this.root = root;
  }
  private async verify(bytes: Uint8Array, expected: string) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer));
    const actual = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== expected) throw new Error('Toolchain asset integrity check failed');
  }
  private channel(name: string) {
    let channel = this.channels.get(name);
    if (!channel) {
      channel = new WorkerChannel(new URL(`workers/${name}-worker.mjs`, this.root!), data => {
        if (data.stage && !['wasm-tools', 'wasm-merge', 'wasm-opt'].includes(data.stage)) { this.currentStage = data.stage; this.emit({ type: 'stage', stage: data.stage, state: 'running' }); }
        if (data.console) {
          if (this.runOutput && (data.console === 'stdout' || data.console === 'stderr')) this.runOutput[data.console as 'stdout' | 'stderr'] += data.text ?? '';
          this.emit({ type: 'console', stream: data.console, text: data.text ?? '' });
        }
        if (data.assets && !this.measuredAssets.has(data.assets.name)) { this.measuredAssets.add(data.assets.name); this.assets.rawBytes += data.assets.rawBytes; this.assets.transferBytes += data.assets.transferBytes; this.emit({ type: 'assets', ...this.assets }); }
      });
      this.channels.set(name, channel);
    }
    return channel;
  }
  private async stage<T>(name: string, timings: StageTiming[], action: () => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    this.currentStage = name; this.emit({ type: 'stage', stage: name, state: 'running' });
    const started = performance.now(); const result = await action();
    if (epoch !== this.epoch) throw new Error('Stopped');
    const milliseconds = performance.now() - started;
    timings.push({ stage: name, milliseconds }); this.emit({ type: 'stage', stage: name, state: 'complete', milliseconds }); return result;
  }
  private async tool(operation: string, args: string[], files: Record<string, Uint8Array>, outputs: string[]) {
    // Snapshot input buffers because callers may retain an artifact for later stages.
    const owned = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, bytes.slice()]));
    const result = await this.channel('tools').request({ operation, args, files: owned, outputs }, Object.values(owned).map(bytes => bytes.buffer));
    if (result.exitCode !== 0) throw new Error(result.stderr || result.failure || `${operation} failed`);
    return result.files as Record<string, Uint8Array>;
  }
  async compile(snapshot: SourceSnapshot): Promise<CompilationResult> {
    const optimization = snapshot.optimization ?? 'Oz';
    const epoch = this.epoch; this.context = snapshot; const timings: StageTiming[] = [];
    const result = { requestId: snapshot.requestId, revision: snapshot.revision, optimization, diagnostics: [], timings };
    let recycleCompiler = false;
    try {
      if (!['hello', 'allocation', 'linq', 'json-dom', 'json-generated', 'tunit', 'regex', 'di', 'hashing'].includes(snapshot.recipeId)) throw new Error('Unknown compilation recipe');
      if (!optimizationModes.includes(optimization)) throw new Error('Unknown optimization mode');
      if (snapshot.source.length > 65536 || new TextEncoder().encode(snapshot.source).byteLength > 65536) throw new Error('Source limit exceeded (64 KiB)');
      await this.stage('download', timings, () => this.initialize());
      await this.stage('compiler-initialize', timings, () => this.channel('compiler').request({ operation: 'initialize' }));
      const compilation = await this.stage('compile', timings, () => this.channel('compiler').request({ operation: 'compile', recipe: snapshot.recipeId, source: snapshot.source }));
      recycleCompiler = compilation.hostLinearMemoryBytes >= 512 * 1048576;
      for (const timing of compilation.timings ?? []) this.emit({ type: 'stage', stage: timing.stage, state: 'complete', milliseconds: timing.milliseconds });
      if (!compilation.success) return { ...result, success: false, diagnostics: compilation.diagnostics ?? [], stage: compilation.stage, assets: { ...this.assets } };
      if (compilation.timings) timings.push(...compilation.timings);
      await this.stage('linker-initialize', timings, () => this.channel('lld').request({ operation: 'initialize' }));
      await this.stage('tools-initialize', timings, () => this.channel('tools').request({ operation: 'initialize' }));
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
      recycleCompiler ||= pruned.hostLinearMemoryBytes >= 512 * 1048576;
      const linked = optimization === 'none' ? pruned.module : (await this.stage('optimize', timings, () =>
        this.tool('wasm-opt', optimizationArguments(args(plan.Optimization), optimization),
          { [basename(plan.ExportPruning.OutputPath)]: pruned.module }, ['linked.wasm'])))['linked.wasm'];
      await this.stage('validate', timings, () => this.tool('wasm-tools', ['validate', 'linked.wasm'], { 'linked.wasm': linked }, []));
      const witName = snapshot.recipeId === 'tunit' ? 'async-command.wit.wasm' : 'command.wit.wasm';
      const witWorld = snapshot.recipeId === 'tunit' ? 'netwasm:component/async-command@1.0.0' : 'wasi:cli/command@0.2.11';
      const witResponse = await fetch(new URL(witName, this.root!), { signal: this.abort?.signal, cache: 'force-cache' });
      if (!witResponse.ok) throw new Error('Command WIT unavailable');
      const wit = new Uint8Array(await witResponse.arrayBuffer());
      await this.verify(wit, this.manifest!.assets[witName].sha256);
      const component = await this.stage('componentization', timings, async () => {
        const embedded = await this.tool('wasm-tools', ['component', 'embed', witName, 'linked.wasm', '--encoding', 'utf8', '--output', 'embedded.wasm', '--world', witWorld], { [witName]: wit, 'linked.wasm': linked }, ['embedded.wasm']);
        const packaged = await this.tool('wasm-tools', ['component', 'new', 'embedded.wasm', '--output', 'component.wasm'], embedded, ['component.wasm']);
        await this.tool('wasm-tools', ['validate', 'component.wasm', '--features', 'all'], packaged, []);
        return packaged['component.wasm'];
      });
      if (epoch !== this.epoch) throw new Error('Stopped');
      return { ...result, success: true, component, assets: { ...this.assets } };
    } catch (error) { return { ...result, success: false, cancelled: epoch !== this.epoch, stage: this.currentStage, error: String(error) }; }
    finally {
      if (recycleCompiler) { this.channels.get('compiler')?.reset(); this.channels.delete('compiler'); }
      this.context = undefined;
    }
  }
  async run(compilation: CompilationResult, snapshot: SourceSnapshot): Promise<RunResult> {
    this.context = snapshot; const epoch = this.epoch; const timings: StageTiming[] = [];
    this.runOutput = { stdout: '', stderr: '' };
    const base = { requestId: snapshot.requestId, revision: snapshot.revision, timings, stdout: '', stderr: '' };
    try {
      if (!compilation.component) throw new Error('No compiled component');
      await this.initialize(); this.channels.get('guest')?.reset(); this.channels.delete('guest');
      const component = compilation.component.slice();
      const result = await this.stage('run', timings, () => this.channel('guest').request({ operation: 'run', component, recipe: snapshot.recipeId }, [component.buffer], 60_000, 5_000));
      for (const timing of result.timings ?? []) this.emit({ type: 'stage', stage: timing.stage, state: 'complete', milliseconds: timing.milliseconds });
      return { ...base, ...result, timings: [...timings, ...(result.timings ?? [])] };
    } catch (error) { return { ...base, ...this.runOutput, success: false, cancelled: epoch !== this.epoch, stage: this.currentStage, error: String(error) }; }
    finally { this.channels.get('guest')?.reset(); this.channels.delete('guest'); this.runOutput = undefined; this.context = undefined; }
  }
  stop() { this.epoch++; this.abort?.abort(); for (const channel of this.channels.values()) channel.reset(); }
  dispose() { this.stop(); this.channels.clear(); }
}
