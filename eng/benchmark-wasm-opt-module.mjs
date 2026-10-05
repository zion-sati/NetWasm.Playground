#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { cpus } from 'node:os';
import process from 'node:process';
import { chromium, firefox, webkit } from 'playwright';
import { build, preview } from 'vite';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 === args.length) throw Error(`Missing ${name}`);
  return args[index + 1];
};
const optionalValue = name => args.includes(name) ? value(name) : undefined;
const input = resolve(value('--input'));
const output = resolve(value('--output'));
const nativeCandidate = optionalValue('--native-wasm-opt');
const executionClosure = optionalValue('--execution-closure');
const executionModule = optionalValue('--execution-module');
const executionPrimaryCore = optionalValue('--execution-primary-core');
const expectedStdout = optionalValue('--expected-stdout');
const browserName = optionalValue('--browser') ?? 'chromium';
const verifyReset = args.includes('--verify-reset');
const verifyRepeat = args.includes('--verify-repeat');
const workerCount = Number(optionalValue('--wasm-opt-workers') ?? '4');
const runs = Number(optionalValue('--runs') ?? '3');
const port = Number(optionalValue('--port') ?? '5194');
if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 16 ||
    !Number.isInteger(runs) || runs < 1 || runs > 20 ||
    !Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error('Invalid numeric argument');
const browserTypes = { chromium, firefox, webkit };
if (!(browserName in browserTypes)) throw Error('Invalid --browser');
if ([executionClosure, executionModule, executionPrimaryCore, expectedStdout]
  .some(Boolean) && ![executionClosure, executionModule, executionPrimaryCore, expectedStdout].every(Boolean))
  throw Error('Execution verification arguments must be supplied together');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const benchmarkDist = resolve(root, 'artifacts/.wasm-opt-module-site');
await build({ root, publicDir: 'public', logLevel: 'silent', build: {
  target: 'es2022', outDir: benchmarkDist, emptyOutDir: true,
  rollupOptions: { input: resolve(root, 'eng/benchmark-host.html') },
} });
await cp(input, resolve(benchmarkDist, 'input.wasm'));
if (nativeCandidate) {
  await rm(resolve(benchmarkDist, 'native-wasm-opt'), { recursive: true, force: true });
  await cp(resolve(nativeCandidate), resolve(benchmarkDist, 'native-wasm-opt'), { recursive: true });
}
if (executionClosure)
  await cp(resolve(executionClosure), resolve(benchmarkDist, 'execution'), { recursive: true });
const server = await preview({ root, logLevel: 'silent', build: { outDir: benchmarkDist },
  preview: { host: '127.0.0.1', port, strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    } } });
const browser = await browserTypes[browserName].launch({ headless: true,
  ...(browserName === 'chromium'
    ? { args: ['--js-flags=--experimental-wasm-compact-imports'] }
    : {}) });
const results = [];
try {
  for (let index = 0; index < runs; index++) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/eng/benchmark-host.html`,
      { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async ({ native, workerCount, executionModule,
      executionPrimaryCore, expectedStdout, verifyReset, verifyRepeat }) => {
      const { PlaygroundPipeline, createNativeWasmOptChannel } = globalThis.__netwasmBenchmark;
      const pipeline = new PlaygroundPipeline(() => {});
      const initialized = performance.now();
      await pipeline.initialize();
      await pipeline.initializeChannel('tools');
      const currentTools = pipeline.channel('tools');
      const nativeTools = native ? createNativeWasmOptChannel('/native-wasm-opt/', workerCount) : undefined;
      const selected = nativeTools ?? currentTools;
      let nativeMetadata;
      if (nativeTools) nativeMetadata = await nativeTools.initialize();
      const initializationMilliseconds = performance.now() - initialized;
      const input = new Uint8Array(await (await fetch('/input.wasm')).arrayBuffer());
      const resetInput = verifyReset ? input.slice() : undefined;
      const repeatInput = verifyRepeat ? input.slice() : undefined;
      const started = performance.now();
      const optimized = await selected.request({ operation: 'wasm-opt',
        args: ['input.wasm', '-Oz', '--all-features', '-o', 'output.wasm'],
        files: { 'input.wasm': input }, outputs: ['output.wasm'] }, [input.buffer], 300_000);
      const optimizationMilliseconds = performance.now() - started;
      const bytes = optimized.files['output.wasm'];
      const validation = bytes.slice();
      await currentTools.request({ operation: 'wasm-tools',
        args: ['validate', 'output.wasm', '--features', 'all'],
        files: { 'output.wasm': validation }, outputs: [] }, [validation.buffer], 120_000);
      let executionStdout;
      if (executionModule) {
        let stdout = '', stderr = '';
        const decoder = new TextDecoder();
        class OutputStream {
          constructor(write) { this.write = write; }
          blockingWriteAndFlush(contents) { this.write(decoder.decode(contents)); }
        }
        class WasiError {}
        const stdoutStream = new OutputStream(text => { stdout += text; });
        const stderrStream = new OutputStream(text => { stderr += text; });
        const generated = await import(`/execution/${executionModule}`);
        const instance = await generated.instantiate(async name => WebAssembly.compile(
          name === executionPrimaryCore ? bytes
            : await (await fetch(`/execution/${name}`)).arrayBuffer()), {
          'wasi:cli/environment': { getArguments: () => [], getEnvironment: () => [] },
          'wasi:cli/exit': { exit: () => { throw Error('Unexpected WASI exit'); } },
          'wasi:cli/stderr': { getStderr: () => stderrStream },
          'wasi:cli/stdout': { getStdout: () => stdoutStream },
          'wasi:io/error': { Error: WasiError },
          'wasi:io/streams': { OutputStream },
        });
        instance.run.run();
        if (stdout !== expectedStdout || stderr !== '')
          throw Error(`Optimized execution failed: ${JSON.stringify({ stdout, stderr })}`);
        executionStdout = stdout;
      }
      let resetRecovery;
      if (verifyReset) {
        if (!nativeTools) throw Error('Reset verification requires native wasm-opt');
        const interruptedInput = resetInput.slice();
        const interrupted = nativeTools.request({ operation: 'wasm-opt',
          args: ['input.wasm', '-Oz', '--all-features', '-o', 'output.wasm'],
          files: { 'input.wasm': interruptedInput }, outputs: ['output.wasm'] },
        [interruptedInput.buffer], 300_000);
        setTimeout(() => nativeTools.reset(new Error('Reset verification')), 20);
        let interruption;
        try { await interrupted; interruption = 'unexpected-success'; }
        catch (error) { interruption = String(error); }
        if (!interruption.includes('Reset verification'))
          throw Error(`Native wasm-opt interruption failed: ${interruption}`);
        // Give browser pthread bookkeeping a task boundary after terminating the
        // owning worker before constructing a replacement pool.
        await new Promise(resolve => setTimeout(resolve, 250));
        const recoveryInput = resetInput.slice();
        const recovered = await nativeTools.request({ operation: 'wasm-opt',
          args: ['input.wasm', '-Oz', '--all-features', '-o', 'output.wasm'],
          files: { 'input.wasm': recoveryInput }, outputs: ['output.wasm'] },
        [recoveryInput.buffer], 300_000);
        const recoveredBytes = recovered.files['output.wasm'];
        if (recoveredBytes.byteLength !== bytes.byteLength ||
            recoveredBytes.some((value, index) => value !== bytes[index]))
          throw Error('Native wasm-opt recovery output changed');
        resetRecovery = 'interrupted-and-recovered';
      }
      let repeatDeterminism;
      if (verifyRepeat) {
        const repeated = await selected.request({ operation: 'wasm-opt',
          args: ['input.wasm', '-Oz', '--all-features', '-o', 'output.wasm'],
          files: { 'input.wasm': repeatInput }, outputs: ['output.wasm'] },
        [repeatInput.buffer], 300_000);
        const repeatedBytes = repeated.files['output.wasm'];
        if (repeatedBytes.byteLength !== bytes.byteLength ||
            repeatedBytes.some((value, index) => value !== bytes[index]))
          throw Error('Repeated wasm-opt output changed');
        repeatDeterminism = 'byte-identical';
      }
      nativeTools?.reset();
      pipeline.dispose();
      return { bytes: [...bytes], initializationMilliseconds, optimizationMilliseconds,
        workerCount: nativeMetadata?.workerCount ?? 1,
        hardwareConcurrency: nativeMetadata?.hardwareConcurrency ?? navigator.hardwareConcurrency ?? 1,
        memoryBytes: optimized.memoryBytes,
        stdout: optimized.stdout, stderr: optimized.stderr, executionStdout,
        resetRecovery, repeatDeterminism };
    }, { native: Boolean(nativeCandidate), workerCount, executionModule,
      executionPrimaryCore, expectedStdout, verifyReset, verifyRepeat });
    await page.close();
    if (errors.length) throw Error(errors.join('\n'));
    const bytes = Buffer.from(result.bytes);
    const path = `${output}.run-${index + 1}.wasm`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    results.push({ ...result, bytes: bytes.length, sha256: sha256(bytes), path });
  }
  if (results.some(result => result.sha256 !== results[0].sha256))
    throw Error('Repeated wasm-opt output is not deterministic');
  const medians = key => {
    const samples = results.map(result => result[key]).sort((left, right) => left - right);
    const middle = Math.floor(samples.length / 2);
    return { samples, median: samples.length % 2 ? samples[middle]
      : (samples[middle - 1] + samples[middle]) / 2,
    minimum: samples[0], maximum: samples.at(-1) };
  };
  const receipt = { schemaVersion: 1, input: { path: input, bytes: (await readFile(input)).byteLength,
    sha256: sha256(await readFile(input)) }, mode: nativeCandidate ? 'native-pthreads' : 'javascript',
  environment: { browserName, browser: await browser.version(), cpu: cpus()[0]?.model, logicalCpuCount: cpus().length,
    requestedWorkerCount: nativeCandidate ? workerCount : 1 },
  summary: { initializationMilliseconds: medians('initializationMilliseconds'),
    optimizationMilliseconds: medians('optimizationMilliseconds'),
    memoryBytes: medians('memoryBytes') },
  output: { bytes: results[0].bytes, sha256: results[0].sha256,
    workerCount: results[0].workerCount,
    ...(expectedStdout ? { executionStdout: results[0].executionStdout } : {}),
    ...(verifyRepeat ? { repeatDeterminism: results[0].repeatDeterminism } : {}),
    ...(verifyReset ? { resetRecovery: results[0].resetRecovery } : {}) }, runs: results };
  await writeFile(`${output}.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt.summary));
} finally {
  await browser.close();
  await new Promise(accept => server.httpServer.close(accept));
  await rm(benchmarkDist, { recursive: true, force: true });
}
