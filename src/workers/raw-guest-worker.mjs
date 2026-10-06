import { serveWorker } from './asset-loader.mjs';
import {
  bindWorkerImports,
  createBrowserRawExportSession,
  createFilesystem,
  InMemoryFilesystemAdapter,
  WASIShim,
} from '../jco/raw-worker-runtime.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const manifestUrl = 'https://playground.netwasm.invalid/deployment.json';

async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
}

function validate(data) {
  if (!(data.module instanceof Uint8Array) || data.module.byteLength > 8 * 1048576 ||
      !(data.adapter instanceof Uint8Array) || data.adapter.byteLength > 1048576 ||
      !(data.runtimeLayout instanceof Uint8Array) || data.runtimeLayout.byteLength > 1048576 ||
      !(data.interopManifest instanceof Uint8Array) || data.interopManifest.byteLength > 1048576 ||
      typeof data.moduleName !== 'string' || data.moduleName.length > 512 ||
      typeof data.moduleSource !== 'string' || encoder.encode(data.moduleSource).byteLength > 65536 ||
      typeof data.exportName !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$-]{0,127}$/.test(data.exportName) ||
      !Array.isArray(data.arguments) || data.arguments.length > 16 ||
      !Array.isArray(data.requiredImports) || data.requiredImports.length > 256)
    throw Error('Invalid raw worker execution request');
}

serveWorker(async (data, emit) => {
  if (data.operation !== 'run') throw Error('Unsupported raw guest operation');
  validate(data);
  const layout = JSON.parse(decoder.decode(data.runtimeLayout));
  const interop = JSON.parse(decoder.decode(data.interopManifest));
  const artifacts = new Map([
    ['application.wasm', { bytes: data.module, role: 'application', mediaType: 'application/wasm', schemaVersion: null }],
    ['raw-adapter.mjs', { bytes: data.adapter, role: 'raw-adapter', mediaType: 'text/javascript', schemaVersion: null }],
    ['runtime-layout.json', { bytes: data.runtimeLayout, role: 'runtime-layout', mediaType: 'application/json', schemaVersion: 1 }],
    ['interop.json', { bytes: data.interopManifest, role: 'interop-manifest', mediaType: 'application/json', schemaVersion: 1 }],
  ]);
  const artifactEntries = await Promise.all([...artifacts].map(async ([relativePath, artifact]) => ({
    relativePath,
    role: artifact.role,
    mediaType: artifact.mediaType,
    sha256: await sha256(artifact.bytes),
    schemaVersion: artifact.schemaVersion,
  })));
  const semanticBuildId = await sha256(data.module);
  const buildFingerprint = await sha256(encoder.encode(JSON.stringify({
    semanticBuildId,
    artifacts: artifactEntries.map(value => value.sha256),
  })));
  const requiredImports = data.requiredImports.map(value => ({
    interface: value.Interface,
    name: value.Name,
    parameters: value.Parameters,
    results: value.Results,
  }));
  const deployment = {
    schemaVersion: 1,
    semanticBuildId,
    deploymentKind: 'raw',
    profile: 'netwasm0.1',
    target: 'wasm32',
    featureSet: 'none',
    executionContract: 'netwasm:worker/jsexport@1.0.0',
    versions: {
      sdk: 'playground', compiler: 'playground', runtime: 'playground',
      runtimeAbi: 'netwasm.runtime.v1', hosting: 'playground', toolchain: 'playground',
    },
    buildFingerprint,
    runtimeFeatures: layout.runtimeFeatures,
    artifacts: artifactEntries,
    requiredImportModules: [...new Set(requiredImports.map(value => value.interface))].sort(),
    requiredImports,
    exports: [],
  };
  const manifestBytes = encoder.encode(JSON.stringify(deployment));
  const manifestSha256 = await sha256(manifestBytes);
  const consumerUrl = URL.createObjectURL(new Blob([data.moduleSource], { type: 'text/javascript' }));
  let session;
  try {
    const namespace = await import(consumerUrl);
    const notify = (operation, arguments_) => {
      const suffix = Array.isArray(arguments_) ? arguments_.join('/') : '';
      emit({ console: 'stdout', text: `${operation}${suffix ? `: ${suffix}` : ''}\n` });
    };
    const consumerModules = Object.freeze({
      [data.moduleName]: bindWorkerImports(namespace, notify),
    });
    const fetchArtifact = async input => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.href === manifestUrl) return new Response(manifestBytes, {
        headers: { 'Content-Type': 'application/json' },
      });
      const relative = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/') + 1));
      const artifact = artifacts.get(relative);
      if (!artifact) return new Response('Not found', { status: 404 });
      return new Response(artifact.bytes, { headers: { 'Content-Type': artifact.mediaType } });
    };
    const output = stream => Object.freeze({
      write(bytes) { emit({ console: stream, text: decoder.decode(bytes) }); },
    });
    const open = createBrowserRawExportSession({
      configuration: Object.freeze({
        applicationImports: Object.freeze([]),
        arguments: Object.freeze([]),
        environment: Object.freeze([]),
        grants: Object.freeze({
          clocks: Object.freeze(['wall', 'monotonic']),
          environment: Object.freeze([]),
          network: 'denyAll',
          preopens: Object.freeze([]),
          randomness: true,
        }),
      }),
      consumerModules,
      manifestUrl,
      platform: Object.freeze({
        compileCoreModule: WebAssembly.compile.bind(WebAssembly),
        createFilesystem({ preopens }) {
          if (Object.keys(preopens).length !== 0) throw new TypeError('Playground worker preopens are unavailable');
          return createFilesystem({ adapter: new InMemoryFilesystemAdapter(), preopens: Object.freeze({}) });
        },
        createModuleUrl: bytes => URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' })),
        createShim: configuration => new WASIShim(configuration),
        digest: crypto.subtle.digest.bind(crypto.subtle),
        fetch: fetchArtifact,
        importModule: url => import(url),
        revokeModuleUrl: URL.revokeObjectURL.bind(URL),
      }),
      stderr: output('stderr'),
      stdout: output('stdout'),
    });
    session = await open({ startup: { buildFingerprint, manifestSha256 } });
    const operation = session.exports[data.exportName];
    if (typeof operation !== 'function') throw Error(`Worker export '${data.exportName}' is unavailable`);
    const value = await operation(...data.arguments);
    return { success: true, exitCode: 0, stdout: '', stderr: '', value };
  } finally {
    await session?.close();
    URL.revokeObjectURL(consumerUrl);
  }
});
