import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, brotliDecompress, constants } from 'node:zlib';

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

// Transport sidecars are generated from final output, outside asset manifests.
export async function precompressBinaries(directory) {
  const results = [];
  async function visit(folder) {
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Binary output contains a symbolic link: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:wasm|bin)$/.test(entry.name)) {
        const original = await readFile(path);
        const compressed = await compress(original, { params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_GENERIC,
          [constants.BROTLI_PARAM_SIZE_HINT]: original.length,
        } });
        if (!(await decompress(compressed)).equals(original))
          throw new Error(`Brotli round trip failed: ${path}`);
        await writeFile(`${path}.br`, compressed);
        results.push({ path, originalBytes: original.length, compressedBytes: compressed.length });
        console.log(`Brotli 11: ${path}: ${original.length} -> ${compressed.length} bytes`);
      }
    }
  }
  // Sequential compression keeps large toolchain bundles from competing for memory.
  await visit(directory);
  return results;
}

export async function writeToolchainCompressionReceipt(directory, { allowMissing = false } = {}) {
  const toolchain = join(directory, 'toolchain');
  try {
    await stat(toolchain);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
  const index = JSON.parse(await readFile(join(toolchain, 'index.json'), 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(index.id) || !/^[a-f0-9]{64}$/.test(index.manifestSha256))
    throw new Error('Invalid toolchain index for compression receipt');
  const root = join(toolchain, index.id);
  const files = {};
  let rawBytes = 0, compressedBytes = 0;
  async function visit(folder) {
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Toolchain output contains a symbolic link: ${path}`);
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile() || entry.name.endsWith('.br')) continue;
      const raw = (await stat(path)).size;
      let compressed = raw;
      if (/\.(?:wasm|bin)$/.test(entry.name)) {
        compressed = (await stat(`${path}.br`)).size;
      }
      const name = relative(root, path).split('\\').join('/');
      files[name] = { rawBytes: raw, compressedBytes: compressed };
      rawBytes += raw;
      compressedBytes += compressed;
    }
  }
  await visit(root);
  const receipt = {
    schemaVersion: 1,
    toolchainId: index.id,
    toolchainManifestSha256: index.manifestSha256,
    compression: 'Brotli quality 11 sidecars for .wasm and .bin; original bytes for other files',
    rawBytes,
    compressedBytes,
    files,
  };
  await writeFile(join(toolchain, 'compression-receipt.json'),
    JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error('Usage: node precompress-binaries.mjs <site-output>');
  await precompressBinaries(directory);
  // Pull-request shell builds intentionally have no staged toolchain. Release builds
  // contain one and therefore emit the receipt consumed by the browser status UI.
  await writeToolchainCompressionReceipt(directory, { allowMissing: true });
}
