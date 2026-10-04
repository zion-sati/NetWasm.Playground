#!/usr/bin/env node
import { rolldown } from 'rolldown';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const stage = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw Error('Usage: bundle-toolchain-modules.mjs <staging-directory>');
const providersOnly = process.argv[3] === '--providers-only';
const hostingOnly = process.argv[3] === '--hosting-only';
if (process.argv[3] && !providersOnly && !hostingOnly) throw Error('Unknown bundle mode');

const temporary = await mkdtemp(join(tmpdir(), 'netwasm-toolchain-modules-'));
const specifications = [
  {
    name: 'tools-runtime',
    destination: 'hosts/tools-runtime.mjs',
    source: `
      export { createBinaryenHost } from ${JSON.stringify(pathToFileURL(join(stage, 'hosts/binaryen-host.mjs')).href)};
      export { createWasmToolsHost } from ${JSON.stringify(pathToFileURL(join(stage, 'hosts/wasm-tools-host.mjs')).href)};
      import * as wasiShim from ${JSON.stringify(pathToFileURL(join(stage, 'wasi-shim/index.js')).href)};
      export { wasiShim };
    `,
  },
  {
    name: 'lld-runtime',
    destination: 'lld/lld-runtime.mjs',
    source: `
      export { default as factory } from ${JSON.stringify(pathToFileURL(join(stage, 'lld/netwasm-browser-lld.mjs')).href)};
      export { createBrowserLld } from ${JSON.stringify(pathToFileURL(join(stage, 'lld/netwasm-lld.mjs')).href)};
    `,
  },
  {
    name: 'guest-runtime',
    destination: 'jco/guest-runtime.mjs',
    source: `
      import * as jco from ${JSON.stringify(pathToFileURL(join(stage, 'jco/browser.js')).href)};
      import * as cliModule from ${JSON.stringify(pathToFileURL(join(stage, 'jco/preview2/cli.js')).href)};
      import * as io from ${JSON.stringify(pathToFileURL(join(stage, 'jco/preview2/io.js')).href)};
      import * as clockModule from ${JSON.stringify(pathToFileURL(join(stage, 'jco/preview2/clocks.js')).href)};
      export { jco, cliModule, io, clockModule };
    `,
  },
  {
    name: 'component-host',
    destination: 'jco/component-host.mjs',
    source: `
      export { executeComponent } from ${JSON.stringify(pathToFileURL(join(stage, 'hosting/component-executor.mjs')).href)};
    `,
  },
  {
    name: 'guest-providers',
    destination: 'jco/guest-providers.mjs',
    source: `
      import * as cliModule from ${JSON.stringify(pathToFileURL(join(stage, 'jco/preview2/cli.js')).href)};
      import * as io from ${JSON.stringify(pathToFileURL(join(stage, 'jco/preview2/io.js')).href)};
      import * as clockModule from ${JSON.stringify(pathToFileURL(join(stage, 'jco/preview2/clocks.js')).href)};
      import * as filesystemModule from ${JSON.stringify(pathToFileURL(join(stage, 'jco/preview2/filesystem.js')).href)};
      import * as httpModule from ${JSON.stringify(pathToFileURL(join(stage, 'jco/preview2/http.js')).href)};
      import * as randomModule from ${JSON.stringify(pathToFileURL(join(stage, 'jco/preview2/random.js')).href)};
      export { cliModule, io, clockModule, filesystemModule, httpModule, randomModule };
    `,
  },
];

const hostingObsolete = [
  'hosting/canonical-component-binder.mjs', 'hosting/command-executor.mjs',
  'hosting/component-execution-preparation.mjs', 'hosting/component-executor.mjs',
  'hosting/component-managed-exception-host.mjs', 'hosting/diagnostic-command-export.mjs',
  'hosting/execution-contracts.mjs', 'hosting/execution-result.mjs',
  'hosting/execution-scope-closer.mjs', 'hosting/guest-wake-notifier.mjs',
  'hosting/managed-errors.mjs', 'hosting/managed-exception-details.mjs',
  'hosting/managed-exception-reporter.mjs',
  'hosting/managed-process-observer.mjs', 'hosting/pollable-reactor.mjs',
  'hosting/terminal-managed-export.mjs',
];

const obsolete = [
  'hosts/binaryen-host.mjs', 'hosts/tool-inputs.mjs', 'hosts/wasm-tools-host.mjs',
  'hosts/wasm32-memory-ceiling.mjs', 'lld/netwasm-browser-lld.mjs', 'lld/netwasm-lld.mjs',
  ...hostingObsolete,
  'jco/browser.js', 'jco/js-component-bindgen-component.js', 'jco/preview2/cli.js',
  'jco/preview2/clocks.js', 'jco/preview2/common.js', 'jco/preview2/config.js',
  'jco/preview2/environment.js', 'jco/preview2/filesystem.js', 'jco/preview2/http.js',
  'jco/preview2/in-memory-filesystem.js', 'jco/preview2/in-memory-http.js',
  'jco/preview2/in-memory-sockets.js', 'jco/preview2/index.js', 'jco/preview2/io.js',
  'jco/preview2/random.js', 'jco/preview2/sockets.js',
  'wasi-shim/debug.js', 'wasi-shim/fd.js', 'wasi-shim/fs_mem.js', 'wasi-shim/fs_opfs.js',
  'wasi-shim/index.js', 'wasi-shim/strace.js', 'wasi-shim/wasi.js', 'wasi-shim/wasi_defs.js',
];

try {
  const selected = providersOnly ? specifications.filter(item => item.name === 'guest-providers')
    : hostingOnly ? specifications.filter(item => item.name === 'component-host') : specifications;
  for (const specification of selected) {
    const entry = join(temporary, `${specification.name}.mjs`);
    await writeFile(entry, specification.source);
    const bundle = await rolldown({ input: entry, external: id => id === 'node:fs/promises' });
    const generated = await bundle.generate({ format: 'esm', minify: false });
    const chunks = generated.output.filter(item => item.type === 'chunk');
    if (chunks.length !== 1 || generated.output.length !== 1 || chunks[0].dynamicImports.some(id => id !== 'node:fs/promises'))
      throw Error(`Unexpected ${specification.name} module graph`);
    const destination = join(stage, specification.destination);
    // Rolldown labels inlined modules with their input paths. Remove those
    // comments so the random staging-directory name cannot affect the bundle.
    const code = chunks[0].code.replace(/^\/\/#(?:end)?region.*\n/gm, '');
    await writeFile(destination, code);
  }
  if (hostingOnly) for (const relative of hostingObsolete) await rm(join(stage, relative));
  else if (!providersOnly) for (const relative of obsolete) await rm(join(stage, relative));

  // Rolldown preserves these URLs relative to the generated guest module in jco/.
  if (!providersOnly && !hostingOnly) {
    const guest = await readFile(join(stage, 'jco/guest-runtime.mjs'), 'utf8');
    for (const name of ['js-component-bindgen-component.core.wasm', 'js-component-bindgen-component.core2.wasm']) {
      if (!guest.includes(`./${name}`)) throw Error(`Guest runtime lost ${name} URL`);
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
