#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { cpus, totalmem } from 'node:os';
import process from 'node:process';
import { chromium } from 'playwright';
import { build, preview } from 'vite';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 === args.length) throw new Error(`Missing ${name}`);
  return args[index + 1];
};
const optionalValue = name => args.includes(name) ? value(name) : undefined;
const output = resolve(value('--output'));
const port = Number(args.includes('--port') ? value('--port') : '5187');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid --port');
const candidateToolchain = optionalValue('--toolchain');
const nativeAotCompiler = optionalValue('--nativeaot-compiler');
const nativeWasmOpt = optionalValue('--native-wasm-opt');
const forceJavaScriptWasmOpt = args.includes('--force-javascript-wasm-opt');
const wasmOptWorkers = Number(optionalValue('--wasm-opt-workers') ?? '4');
const selectedRecipes = optionalValue('--recipes')?.split(',').filter(Boolean);
const selectedSteps = optionalValue('--steps')?.split(',').filter(Boolean);
const runOverride = optionalValue('--runs');
const optimization = optionalValue('--optimization') ?? 'none';
if (runOverride !== undefined && (!Number.isInteger(Number(runOverride)) || Number(runOverride) < 1))
  throw new Error('Invalid --runs');
if (!['none', 'O0', 'O1', 'O2', 'O3', 'Os', 'Oz'].includes(optimization))
  throw new Error('Invalid --optimization');
if (!Number.isInteger(wasmOptWorkers) || wasmOptWorkers < 1 || wasmOptWorkers > 16)
  throw new Error('Invalid --wasm-opt-workers');
if (nativeWasmOpt && forceJavaScriptWasmOpt)
  throw new Error('Select either native or forced JavaScript wasm-opt');
if (selectedSteps && (selectedSteps.length === 0 || selectedSteps.some(step =>
  !['cold', 'identical', 'body-edit', 'reverse-edit'].includes(step))))
  throw new Error('Invalid --steps');

const benchmarkDist = resolve(root, 'artifacts/.compiler-iteration-browser-site');
await build({ root, publicDir: 'public', logLevel: 'silent', build: {
  target: 'es2022', outDir: benchmarkDist, emptyOutDir: true,
  rollupOptions: { input: resolve(root, 'eng/benchmark-host.html') },
} });
if (candidateToolchain) {
  await rm(resolve(benchmarkDist, 'toolchain'), { recursive: true, force: true });
  await cp(resolve(candidateToolchain), resolve(benchmarkDist, 'toolchain'), { recursive: true });
}
if (nativeAotCompiler) {
  await rm(resolve(benchmarkDist, 'nativeaot'), { recursive: true, force: true });
  await cp(resolve(nativeAotCompiler), resolve(benchmarkDist, 'nativeaot'), { recursive: true });
}
if (nativeWasmOpt) {
  await rm(resolve(benchmarkDist, 'native-wasm-opt'), { recursive: true, force: true });
  await cp(resolve(nativeWasmOpt), resolve(benchmarkDist, 'native-wasm-opt'), { recursive: true });
}
const server = await preview({ root, logLevel: 'silent', build: { outDir: benchmarkDist },
  preview: { host: '127.0.0.1', port, strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    } } });
const browser = await chromium.launch({ headless: true });
const releaseTag = optionalValue('--release-tag');
let toolchainIndex;
let cases = [
  { recipe: 'hello', runs: 5, from: 'Console.WriteLine(42);', to: 'Console.WriteLine(43);' },
  { recipe: 'json-generated', runs: 5, from: 'Score = 42', to: 'Score = 43' },
  { recipe: 'regex', runs: 1, from: 'Ada:42, Grace:99', to: 'Ada:43, Grace:99' },
  { recipe: 'di', runs: 1, from: 'SayHello("Ada")', to: 'SayHello("Grace")' },
  { recipe: 'fluentvalidation', runs: 1, from: 'Age = 41', to: 'Age = 42' },
];
if (selectedRecipes) {
  const requested = new Set(selectedRecipes);
  cases = cases.filter(fixture => requested.delete(fixture.recipe));
  if (requested.size > 0 || cases.length === 0) throw new Error(`Unknown --recipes: ${[...requested].join(',')}`);
}
if (runOverride !== undefined) cases = cases.map(fixture => ({ ...fixture, runs: Number(runOverride) }));
const summarize = values => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    samples: values,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    minimum: sorted[0],
    maximum: sorted.at(-1),
  };
};
const summarizeRuns = runs => Object.fromEntries(runs[0].steps.map(({ label }) => {
  const steps = runs.map(run => run.steps.find(step => step.label === label));
  const stageNames = [...new Set(steps.flatMap(step => [...step.timings, ...step.runTimings].map(timing => timing.stage)))];
  return [label, {
    compilerSessionClassifications: steps.map(step => step.compilerWorker.classification),
    warmCompilerSessionSamples: steps.filter(step => step.compilerWorker.startedWithExistingChannel).length,
    retainedAfterCompileSamples: steps.filter(step => step.compilerWorker.retainedAfterCompile).length,
    compileWallMilliseconds: summarize(steps.map(step => step.compileWallMilliseconds)),
    runWallMilliseconds: summarize(steps.map(step => step.runWallMilliseconds)),
    componentBytes: summarize(steps.map(step => step.componentBytes)),
    compilerHostLinearMemoryBytes: summarize(steps.map(step => step.compilerHostLinearMemoryBytes)),
    toolsHostLinearMemoryBytes: summarize(steps.map(step => step.toolsHostLinearMemoryBytes)),
    stages: Object.fromEntries(stageNames.map(stage => [stage, summarize(steps.map(step =>
      [...step.timings, ...step.runTimings].filter(timing => timing.stage === stage)
        .reduce((total, timing) => total + timing.milliseconds, 0)))])),
  }];
}));
const receipt = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  command: 'node eng/benchmark-compiler-iteration.mjs',
  arguments: args,
  environment: {
    browserVersion: await browser.version(),
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    cpuModel: cpus()[0]?.model ?? 'unavailable',
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    workerCount: 1,
    wasmOptWorkerCount: nativeWasmOpt ? wasmOptWorkers : 1,
    compilerHost: nativeAotCompiler ? 'NativeAOT-LLVM' : 'pending toolchain inspection',
    wasmOptHost: nativeWasmOpt ? 'Binaryen browser CLI with pthreads'
      : forceJavaScriptWasmOpt ? 'Binaryen JavaScript CLI' : 'production-selected optimizer',
    optimization,
    network: 'local Vite; immutable public toolchain assets already present',
    concurrentHostLoad: 'No concurrent CPU-heavy build or benchmark; ordinary interactive desktop processes remained.',
    unavailableCounters: ['allocations', 'gc', 'retained-memory', 'process-private-memory', 'methods-decoded', 'methods-analyzed', 'methods-lowered', 'cache-hits', 'cache-misses', 'cache-evictions', 'key-construction'],
  },
  publicToolchain: {
    releaseTag: releaseTag ?? null,
    source: candidateToolchain ? 'candidate directory' : 'checked-in public toolchain',
  },
  semantics: {
    repetition: 'Each repetition opens a fresh page and creates a fresh PlaygroundPipeline, compiler worker, linker worker, and tools worker. Browser HTTP cache remains available; timings therefore exclude first-visit Internet transfer.',
    sequence: 'Within a repetition, cold, identical, body-edit, and reverse-edit steps reuse the same PlaygroundPipeline. Runtime compiler-channel identity records whether each step starts warm and whether the production memory threshold recycles the worker afterward.',
    inclusiveTimings: ['compile includes generator, roslyn, and netwasm', 'run includes transpile, instantiate, and execute'],
    exclusiveBoundaries: ['initialization: download, compiler-initialize, linker-initialize, tools-initialize', 'source generation: generator', 'managed compilation: roslyn', 'NetWasm compiler: netwasm', 'runtime link: link', 'package: parse, merge, prune, validate, componentization', 'execution: transpile, instantiate, execute'],
    fixtureLimit: 'Browser examples are maintained feature-equivalent fixtures, not byte-identical inputs to the local frozen PE/SDK fixtures. Browser generated inputs and public package/toolchain pins are authoritative for this adapter baseline.',
  },
  fixtures: [],
};

try {
  toolchainIndex = await (await fetch(`http://127.0.0.1:${port}/toolchain/index.json`)).json();
  receipt.publicToolchain.id = toolchainIndex.id;
  receipt.publicToolchain.manifestSha256 = toolchainIndex.manifestSha256;
  const toolchainManifest = await (await fetch(
    `http://127.0.0.1:${port}/toolchain/${toolchainIndex.id}/asset-manifest.json`)).json();
  receipt.environment.compilerHost = nativeAotCompiler || toolchainManifest.pins?.nativeAotLlvmCompilerHost
    ? 'NativeAOT-LLVM' : 'Mono browser host';
  for (const fixture of cases) {
    const runs = [];
    for (let runIndex = 0; runIndex < fixture.runs; runIndex++) {
      const page = await browser.newPage();
      page.on('console', message => {
        if (message.type() === 'error') process.stderr.write(`browser console: ${message.text()}\n`);
      });
      page.on('pageerror', error => process.stderr.write(`browser page error: ${error.stack ?? error}\n`));
      await page.exposeFunction('__benchmarkProgress', label => process.stdout.write(`${fixture.recipe} ${runIndex + 1}/${fixture.runs} ${label}\n`));
      await page.goto(`http://127.0.0.1:${port}/eng/benchmark-host.html`, { waitUntil: 'domcontentloaded' });
      const sequence = await page.evaluate(async ({ recipe, from, to, runIndex, optimization, nativeAotCompiler, nativeWasmOpt, forceJavaScriptWasmOpt, wasmOptWorkers, selectedSteps }) => {
        const { PlaygroundPipeline, examples, createNativeAotCompilerChannel,
          createFrontendCache, createNativeWasmOptChannel } = globalThis.__netwasmBenchmark;
        const fixture = examples.find(example => example.id === recipe);
        if (!fixture) throw new Error(`Unknown fixture ${recipe}`);
        if (!fixture.source.includes(from) || fixture.source.includes(to)) throw new Error(`Edit anchor failed for ${recipe}`);
        const sourceV1 = fixture.source;
        const sourceV2 = fixture.source.replace(from, to);
        const sourceDigest = async source => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))))
          .map(byte => byte.toString(16).padStart(2, '0')).join('');
        const inputs = {
          sourceV1Sha256: await sourceDigest(sourceV1), sourceV2Sha256: await sourceDigest(sourceV2),
          sourceV1Bytes: new TextEncoder().encode(sourceV1).byteLength,
          sourceV2Bytes: new TextEncoder().encode(sourceV2).byteLength,
        };
        const events = [];
        const compilerChannelIds = new WeakMap();
        let nextCompilerChannelId = 0;
        const channelId = channel => {
          if (!channel) return undefined;
          let id = compilerChannelIds.get(channel);
          if (!id) { id = ++nextCompilerChannelId; compilerChannelIds.set(channel, id); }
          return id;
        };
        const pipeline = new PlaygroundPipeline(event => {
          events.push(event);
          if (event.type === 'stage' && event.state === 'running') void window.__benchmarkProgress(`stage:${event.stage}`);
        });
        if (forceJavaScriptWasmOpt) pipeline.nativeWasmOptUnavailable = true;
        if (nativeAotCompiler) {
          const nativeChannel = createNativeAotCompilerChannel({
            candidateRoot: '/nativeaot/',
            createFrontendCache,
            report: event => {
              if (event.stage) events.push({ type: 'stage', ...event });
            },
          });
          const originalChannel = pipeline.channel.bind(pipeline);
          const originalInitializeChannel = pipeline.initializeChannel.bind(pipeline);
          pipeline.channel = name => {
            if (name !== 'compiler') return originalChannel(name);
            pipeline.channels.set('compiler', nativeChannel);
            return nativeChannel;
          };
          pipeline.initializeChannel = name => name === 'compiler'
            ? nativeChannel.request({ operation: 'initialize', toolchainId: pipeline.toolchainId }).then(() => undefined)
            : originalInitializeChannel(name);
        }
        const originalChannel = pipeline.channel.bind(pipeline);
        const originalDispose = pipeline.dispose.bind(pipeline);
        const nativeTools = nativeWasmOpt
          ? createNativeWasmOptChannel('/native-wasm-opt/', async () =>
            new Uint8Array(await (await fetch('/native-wasm-opt/wasm-opt.wasm')).arrayBuffer()), wasmOptWorkers)
          : undefined;
        let originalTools;
        const toolMemoryBytes = [];
        const proxy = {
          async request(data, transfers, timeout, executionTimeout) {
            const selected = data.operation === 'wasm-opt' && nativeTools
              ? nativeTools : (originalTools ??= originalChannel('tools'));
            const response = await selected.request(data, transfers, timeout, executionTimeout);
            if (Number.isSafeInteger(response.memoryBytes)) toolMemoryBytes.push(response.memoryBytes);
            return response;
          },
          reset(reason) { originalTools?.reset(reason); nativeTools?.reset(reason); },
        };
        pipeline.channel = name => name === 'tools' ? proxy : originalChannel(name);
        pipeline.dispose = () => { nativeTools?.reset(); originalDispose(); };
        if (!(pipeline.channels instanceof Map)) throw new Error('Compiler channel observation boundary unavailable');
        let steps = [
          ['cold', sourceV1, 1],
          ['identical', sourceV1, 1],
          ['body-edit', sourceV2, 2],
          ['reverse-edit', sourceV1, 1],
        ];
        if (selectedSteps) steps = steps.filter(([label]) => selectedSteps.includes(label));
        const results = [];
        try {
          for (let index = 0; index < steps.length; index++) {
            const [label, source, version] = steps[index];
            const snapshot = { requestId: runIndex * 10 + index + 1, revision: index + 1, source,
              recipeId: recipe, optimization, language: '15', updatedMemorySafetyRules: false };
            const toolMemoryStart = toolMemoryBytes.length;
            const compilerChannelBefore = pipeline.channels.get('compiler');
            const wallStarted = performance.now();
            const compiled = await pipeline.compile(snapshot);
            const compileWallMilliseconds = performance.now() - wallStarted;
            const compilerChannelAfter = pipeline.channels.get('compiler');
            const compilerWorker = {
              beforeChannelId: channelId(compilerChannelBefore),
              afterChannelId: channelId(compilerChannelAfter),
              startedWithExistingChannel: Boolean(compilerChannelBefore),
              retainedAfterCompile: Boolean(compilerChannelAfter),
              classification: compilerChannelBefore
                ? compilerChannelBefore === compilerChannelAfter ? 'reused-and-retained'
                  : compilerChannelAfter ? 'reused-then-replaced' : 'reused-then-recycled'
                : compilerChannelAfter ? 'created-and-retained' : 'created-then-recycled',
            };
            if (!compiled.success || !compiled.component) throw new Error(`${recipe}/${label} compile failed at ${compiled.stage}: ${compiled.error ?? 'diagnostics'}`);
            const componentBytes = compiled.component.byteLength;
            const componentSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', compiled.component.slice(0))))
              .map(byte => byte.toString(16).padStart(2, '0')).join('');
            const runStarted = performance.now();
            const executed = await pipeline.run(compiled, snapshot);
            const runWallMilliseconds = performance.now() - runStarted;
            if (!executed.success || executed.exitCode !== 0) throw new Error(`${recipe}/${label} execution failed at ${executed.stage}: ${executed.error ?? executed.stderr}`);
            const currentToolMemory = toolMemoryBytes.slice(toolMemoryStart);
            results.push({ label, version, compilerWorker, compileWallMilliseconds, runWallMilliseconds,
              componentBytes, componentSha256,
              compilerHostLinearMemoryBytes: compiled.compilerHostLinearMemoryBytes,
              toolsHostLinearMemoryBytes: currentToolMemory.length ? Math.max(...currentToolMemory) : 0,
              timings: compiled.timings, runTimings: executed.timings, stdout: executed.stdout, stderr: executed.stderr });
            await window.__benchmarkProgress(label);
          }
        } finally { pipeline.dispose(); }
        return { inputs, steps: results, stageEvents: events.filter(event => event.type === 'stage') };
      }, { ...fixture, runIndex, optimization, nativeAotCompiler: Boolean(nativeAotCompiler),
        nativeWasmOpt: Boolean(nativeWasmOpt), forceJavaScriptWasmOpt,
        wasmOptWorkers, selectedSteps });
      await page.close();
      const byLabel = Object.fromEntries(sequence.steps.map(step => [step.label, step]));
      const stable = ['cold', 'identical', 'reverse-edit'].filter(label => byLabel[label]);
      if (stable.length > 1 && stable.some(label => byLabel[label].componentSha256 !== byLabel[stable[0]].componentSha256))
        throw new Error(`${fixture.recipe} stable-input component hashes differ`);
      if (byLabel.cold && byLabel['body-edit'] && byLabel.cold.componentSha256 === byLabel['body-edit'].componentSha256)
        throw new Error(`${fixture.recipe} body edit did not change component`);
      if (stable.length > 1 && stable.some(label => byLabel[label].stdout !== byLabel[stable[0]].stdout) ||
          byLabel.cold && byLabel['body-edit'] && byLabel.cold.stdout === byLabel['body-edit'].stdout)
        throw new Error(`${fixture.recipe} execution outcome guard failed`);
      runs.push(sequence);
    }
    if (runs.some(run => JSON.stringify(run.inputs) !== JSON.stringify(runs[0].inputs))) throw new Error(`${fixture.recipe} input identity changed`);
    receipt.fixtures.push({ recipe: fixture.recipe, repetitions: fixture.runs, inputs: runs[0].inputs,
      edit: { from: fixture.from, to: fixture.to }, summary: summarizeRuns(runs), runs });
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  await browser.close();
  await new Promise(resolvePromise => server.httpServer.close(resolvePromise));
  await rm(benchmarkDist, { recursive: true, force: true });
}
