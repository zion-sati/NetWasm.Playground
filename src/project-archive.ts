import type { OptimizationMode } from './optimization.ts';
import { isTextProjectFile, validateProjectFiles, type PlaygroundProject } from './workspace.ts';

export interface ProjectArchiveSettings {
  language: '15' | 'preview';
  updatedMemorySafetyRules: boolean;
  runOptimization: OptimizationMode;
  publishOptimization: OptimizationMode;
}

const encoder = new TextEncoder();
const utf8Flag = 0x0800;
const dosDate1980 = 0x0021;

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

function localHeader(path: Uint8Array, bytes: Uint8Array, checksum: number): Uint8Array {
  const header = new Uint8Array(30 + path.byteLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, utf8Flag, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, dosDate1980, true);
  view.setUint32(14, checksum, true);
  view.setUint32(18, bytes.byteLength, true);
  view.setUint32(22, bytes.byteLength, true);
  view.setUint16(26, path.byteLength, true);
  header.set(path, 30);
  return header;
}

function centralHeader(path: Uint8Array, bytes: Uint8Array, checksum: number, offset: number): Uint8Array {
  const header = new Uint8Array(46 + path.byteLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, utf8Flag, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, dosDate1980, true);
  view.setUint32(16, checksum, true);
  view.setUint32(20, bytes.byteLength, true);
  view.setUint32(24, bytes.byteLength, true);
  view.setUint16(28, path.byteLength, true);
  view.setUint32(42, offset, true);
  header.set(path, 46);
  return header;
}

function endOfCentralDirectory(entries: number, centralBytes: number, centralOffset: number): Uint8Array {
  const footer = new Uint8Array(22);
  const view = new DataView(footer.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries, true);
  view.setUint16(10, entries, true);
  view.setUint32(12, centralBytes, true);
  view.setUint32(16, centralOffset, true);
  return footer;
}

export function projectArchiveName(name: string): string {
  const stem = name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return `${stem || 'NetWasm-project'}.zip`;
}

export function buildProjectArchive(project: PlaygroundProject, settings: ProjectArchiveSettings): Uint8Array {
  validateProjectFiles(project.files);
  const sortedFiles = [...project.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const paths = new Set(sortedFiles.map(file => file.path));
  let archiveManifestPath = 'netwasm-project.json';
  for (let suffix = 1; paths.has(archiveManifestPath); suffix++)
    archiveManifestPath = `netwasm-project.${suffix}.json`;
  const manifest = {
    schemaVersion: 1,
    manifestPath: archiveManifestPath,
    name: project.name,
    projectKind: project.kind,
    recipeId: project.recipeId,
    language: settings.language,
    updatedMemorySafetyRules: settings.updatedMemorySafetyRules,
    profiles: {
      run: { optimization: settings.runOptimization },
      publish: { optimization: settings.publishOptimization },
    },
    files: sortedFiles.map(file => ({
      path: file.path,
      kind: file.kind,
      ...(file.kind === 'native-archive' ? { libraryName: file.libraryName, target: file.target } : {}),
    })),
  };
  const entries = [
    { path: archiveManifestPath, bytes: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`) },
    ...sortedFiles.map(file => ({ path: file.path,
      bytes: isTextProjectFile(file) ? encoder.encode(file.text) : file.bytes })),
  ];
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const path = encoder.encode(entry.path);
    const checksum = crc32(entry.bytes);
    const header = localHeader(path, entry.bytes, checksum);
    local.push(header, entry.bytes);
    central.push(centralHeader(path, entry.bytes, checksum, offset));
    offset += header.byteLength + entry.bytes.byteLength;
  }
  const directory = join(central);
  return join([...local, directory, endOfCentralDirectory(entries.length, directory.byteLength, offset)]);
}
