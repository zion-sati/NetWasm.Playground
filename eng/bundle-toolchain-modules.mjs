#!/usr/bin/env node
import { rolldown } from 'rolldown';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const stage = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw Error('Usage: bundle-toolchain-modules.mjs <staging-directory> [--guest-runtime <jco-node-modules> | --hosting-only]');
// --guest-runtime bundles jco's in-browser transpiler from a public toolchain package's
// node_modules; --hosting-only bundles the guest workers' NetWasm hosting modules.
const guestRuntime = process.argv[3] === '--guest-runtime';
const hostingOnly = process.argv[3] === '--hosting-only';
if (process.argv[3] && !guestRuntime && !hostingOnly) throw Error('Unknown bundle mode');
if (guestRuntime && !process.argv[4]) throw Error('--guest-runtime requires the jco node_modules directory');
const jcoModules = guestRuntime ? resolve(process.argv[4]) : undefined;
const hosting = name => JSON.stringify(pathToFileURL(join(stage, 'hosting', name)).href);

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
    // jco's browser API; its bindgen component reaches WASI through preview2-shim's
    // browser providers. Guests get their WASI 0.3 imports from guest-host instead.
    name: 'guest-runtime',
    destination: 'jco/guest-runtime.mjs',
    platform: 'browser',
    source: () => `
      export { generate } from ${JSON.stringify(pathToFileURL(join(jcoModules, '@bytecodealliance/jco/dist/browser.js')).href)};
    `,
  },
  {
    name: 'guest-host',
    destination: 'jco/guest-host.mjs',
    source: () => `
      export { executeComponent } from ${hosting('component-executor.mjs')};
      export { createWasiPlatform } from ${hosting('wasi-platform.mjs')};
      export { createWasiFilesystem } from ${hosting('wasi-filesystem.mjs')};
      export { createBrowserFileMounts } from ${hosting('browser-file-mounts.mjs')};
      export { createWasiHttpFetch } from ${hosting('wasi-http-fetch.mjs')};
      export { projectProviderModuleIdentity } from ${hosting('provider-module-identity.mjs')};
      export { createGuestByteReader } from ${hosting('output-sink-stream.mjs')};
      export { readTimeZoneNames } from ${hosting('timezone-sidecar-zones.mjs')};
    `,
  },
  {
    name: 'raw-worker-runtime',
    destination: 'jco/raw-worker-runtime.mjs',
    source: () => `
      export { bindWorkerImports } from ${hosting('worker-import-bindings.mjs')};
      export { createBrowserRawExportSession } from ${hosting('browser-raw-export-session.mjs')};
      export { validateDeploymentManifest } from ${hosting('deployment-manifest-validator.mjs')};
      export { platformProviderCatalog } from ${hosting('platform-provider-catalog.generated.mjs')};
      export { createWasiPlatform } from ${hosting('wasi-platform.mjs')};
      export { createWasiFilesystem } from ${hosting('wasi-filesystem.mjs')};
      export { createBrowserFileMounts } from ${hosting('browser-file-mounts.mjs')};
    `,
  },
];

const hostingSources = async () => (await readdir(join(stage, 'hosting')))
  .filter(name => name.endsWith('.mjs')).map(name => `hosting/${name}`);

// The pinned public base also inlines the tool and linker hosts.
const baseSources = [
  'hosts/binaryen-host.mjs', 'hosts/tool-inputs.mjs', 'hosts/wasm-tools-host.mjs',
  'hosts/wasm32-memory-ceiling.mjs', 'lld/netwasm-browser-lld.mjs', 'lld/netwasm-lld.mjs',
  'wasi-shim/debug.js', 'wasi-shim/fd.js', 'wasi-shim/fs_mem.js', 'wasi-shim/fs_opfs.js',
  'wasi-shim/index.js', 'wasi-shim/strace.js', 'wasi-shim/wasi.js', 'wasi-shim/wasi_defs.js',
];
const bindgenCores = ['js-component-bindgen-component.core.wasm', 'js-component-bindgen-component.core2.wasm'];

try {
  const names = guestRuntime ? ['guest-runtime']
    : hostingOnly ? ['guest-host', 'raw-worker-runtime']
    : ['tools-runtime', 'lld-runtime', 'guest-host', 'raw-worker-runtime'];
  const inlined = guestRuntime ? [] : await hostingSources();
  for (const specification of specifications.filter(item => names.includes(item.name))) {
    const entry = join(temporary, `${specification.name}.mjs`);
    await writeFile(entry, typeof specification.source === 'function' ? specification.source() : specification.source);
    const bundle = await rolldown({
      input: entry,
      ...(specification.platform ? { platform: specification.platform } : {}),
      external: id => id === 'node:fs/promises',
    });
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
  for (const relative of guestRuntime || hostingOnly ? inlined : [...baseSources, ...inlined])
    await rm(join(stage, relative));

  if (guestRuntime) {
    // jco fetches its bindgen cores relative to the bundled module in jco/.
    const guest = await readFile(join(stage, 'jco/guest-runtime.mjs'), 'utf8');
    for (const name of bindgenCores) {
      if (!guest.includes(`./${name}`)) throw Error(`Guest runtime lost ${name} URL`);
      await copyFile(join(jcoModules, '@bytecodealliance/jco-transpile/vendor', name), join(stage, 'jco', name));
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
