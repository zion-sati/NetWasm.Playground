import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  if (!directory) throw new Error('Usage: node precompress-binaries.mjs <site-output>');
  await precompressBinaries(directory);
}
