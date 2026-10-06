export const maximumProjectFiles = 64;
export const maximumSourceFiles = 32;
export const maximumTextFileBytes = 64 * 1024;
export const maximumSourceSetBytes = 256 * 1024;
export const maximumNativeArchiveBytes = 8 * 1024 * 1024;
export const maximumProjectBytes = 16 * 1024 * 1024;

export type ProjectKind = 'command' | 'wit-worker' | 'jsexport-worker';
export type TextProjectFileKind = 'csharp' | 'javascript' | 'wit' | 'html' | 'text';

interface ProjectFileBase {
  id: string;
  path: string;
}

export interface TextProjectFile extends ProjectFileBase {
  kind: TextProjectFileKind;
  text: string;
}

export interface NativeArchiveProjectFile extends ProjectFileBase {
  kind: 'native-archive';
  bytes: Uint8Array;
  libraryName: string;
  target: 'wasm32';
}

export type ProjectFile = TextProjectFile | NativeArchiveProjectFile;
export type ProjectFileSource =
  | { path: string; text: string; kind?: TextProjectFileKind }
  | { path: string; bytes: Uint8Array; kind: 'native-archive'; libraryName: string; target?: 'wasm32' };

export interface PlaygroundProject {
  schemaVersion: 2;
  id: string;
  name: string;
  kind: ProjectKind;
  recipeId: string;
  files: ProjectFile[];
  activeFileId: string;
}

const encoder = new TextEncoder();
const validSegment = /^[^<>:"|?*\x00-\x1f]+$/;
const validLibraryName = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export function normalizeProjectPath(value: string): string {
  const path = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  const segments = path.split('/');
  if (!path || path.startsWith('/') || path.length > 240 ||
      segments.some(segment => !segment || segment === '.' || segment === '..' || !validSegment.test(segment)))
    throw new Error('Use a relative project path without empty, . or .. segments.');
  return segments.join('/');
}

export function projectFileKind(path: string): TextProjectFileKind | 'native-archive' {
  const lower = path.toLowerCase();
  if (lower.endsWith('.cs')) return 'csharp';
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'javascript';
  if (lower.endsWith('.wit')) return 'wit';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.a')) return 'native-archive';
  return 'text';
}

export function inferNativeLibraryName(path: string): string {
  const filename = normalizeProjectPath(path).split('/').at(-1)!;
  const stem = filename.slice(0, -2).replace(/^lib(?=.)/, '');
  try { return validateNativeLibraryName(stem); }
  catch { throw new Error(`Cannot infer a LibraryImport name from ${filename}.`); }
}

export function validateNativeLibraryName(value: string): string {
  const name = value.trim();
  if (!validLibraryName.test(name))
    throw new Error('A LibraryImport name must start with a letter or underscore and contain only letters, numbers, dots, dashes, or underscores.');
  return name;
}

export function isTextProjectFile(file: ProjectFile): file is TextProjectFile {
  return file.kind !== 'native-archive';
}

function readUnsignedLeb(bytes: Uint8Array, offset: number, limit: number): [number, number] {
  let value = 0;
  for (let shift = 0; shift < 35 && offset < limit; shift += 7) {
    const current = bytes[offset++];
    value += (current & 0x7f) * 2 ** shift;
    if (!(current & 0x80)) {
      if (!Number.isSafeInteger(value)) break;
      return [value, offset];
    }
  }
  throw new Error('The native archive contains malformed WebAssembly metadata.');
}

function wasmObject(bytes: Uint8Array, label: string): void {
  if (bytes.byteLength < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 ||
      bytes[3] !== 0x6d || bytes[4] !== 1 || bytes[5] || bytes[6] || bytes[7])
    throw new Error(`${label} is not a WebAssembly object file.`);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 8;
  let linking = false;
  while (offset < bytes.byteLength) {
    const sectionId = bytes[offset++];
    let size;
    [size, offset] = readUnsignedLeb(bytes, offset, bytes.byteLength);
    const end = offset + size;
    if (end > bytes.byteLength) throw new Error(`${label} has a truncated WebAssembly section.`);
    if (sectionId === 0) {
      let nameLength;
      [nameLength, offset] = readUnsignedLeb(bytes, offset, end);
      if (offset + nameLength > end) throw new Error(`${label} has malformed WebAssembly metadata.`);
      const name = decoder.decode(bytes.subarray(offset, offset + nameLength));
      offset += nameLength;
      if (name === 'linking') linking = true;
      if (name === 'target_features') {
        let count;
        [count, offset] = readUnsignedLeb(bytes, offset, end);
        for (let index = 0; index < count; index++) {
          if (offset >= end) throw new Error(`${label} has malformed target features.`);
          offset++;
          let featureLength;
          [featureLength, offset] = readUnsignedLeb(bytes, offset, end);
          if (offset + featureLength > end) throw new Error(`${label} has malformed target features.`);
          const feature = decoder.decode(bytes.subarray(offset, offset + featureLength));
          offset += featureLength;
          if (feature === 'memory64') throw new Error(`${label} targets wasm64; the Playground requires wasm32.`);
        }
      }
    }
    offset = end;
  }
  if (!linking) throw new Error(`${label} is a WebAssembly module, but not a relocatable object file.`);
}

export function validateWasmArchive(bytes: Uint8Array, path = 'archive.a'): number {
  const ascii = new TextDecoder('ascii', { fatal: true });
  if (bytes.byteLength < 8 || ascii.decode(bytes.subarray(0, 8)) !== '!<arch>\n')
    throw new Error(`${path} is not a regular ar archive.`);
  let offset = 8;
  let objects = 0;
  while (offset < bytes.byteLength) {
    if (offset + 60 > bytes.byteLength) throw new Error(`${path} has a truncated ar member header.`);
    const header = bytes.subarray(offset, offset + 60);
    if (header[58] !== 0x60 || header[59] !== 0x0a)
      throw new Error(`${path} has an invalid ar member header.`);
    const rawName = ascii.decode(header.subarray(0, 16)).trim();
    const sizeText = ascii.decode(header.subarray(48, 58)).trim();
    if (!/^[0-9]+$/.test(sizeText)) throw new Error(`${path} has an invalid ar member size.`);
    const size = Number(sizeText);
    offset += 60;
    if (!Number.isSafeInteger(size) || offset + size > bytes.byteLength)
      throw new Error(`${path} has a truncated ar member.`);
    let member = bytes.subarray(offset, offset + size);
    let name = rawName.replace(/\/$/, '');
    if (rawName.startsWith('#1/')) {
      const nameLength = Number(rawName.slice(3));
      if (!Number.isSafeInteger(nameLength) || nameLength < 1 || nameLength > member.byteLength)
        throw new Error(`${path} has an invalid extended ar member name.`);
      name = ascii.decode(member.subarray(0, nameLength)).replace(/\0+$/, '');
      member = member.subarray(nameLength);
    }
    const metadata = rawName === '/' || rawName === '//' || rawName === '/SYM64/' ||
      name.startsWith('__.SYMDEF');
    if (!metadata) {
      wasmObject(member, `${path} member ${name || objects + 1}`);
      objects++;
    }
    offset += size;
    if (size & 1) {
      if (offset >= bytes.byteLength) throw new Error(`${path} has a truncated ar member boundary.`);
      offset++;
    }
  }
  if (!objects) throw new Error(`${path} contains no WebAssembly object files.`);
  return objects;
}

export function validateProjectFiles(files: readonly ProjectFile[]): void {
  if (!files.length || files.length > maximumProjectFiles)
    throw new Error(`A project must contain 1–${maximumProjectFiles} files.`);
  const paths = new Set<string>();
  let sourceCount = 0;
  let sourceBytes = 0;
  let projectBytes = 0;
  for (const file of files) {
    const path = normalizeProjectPath(file.path);
    if (paths.has(path)) throw new Error(`Duplicate project path: ${path}`);
    paths.add(path);
    if (isTextProjectFile(file)) {
      if (projectFileKind(path) !== file.kind && !(file.kind === 'text' && projectFileKind(path) === 'text'))
        throw new Error(`${path} does not match its project file type.`);
      const bytes = encoder.encode(file.text).byteLength;
      if (bytes > maximumTextFileBytes) throw new Error(`${path} exceeds the 64 KiB text file limit.`);
      projectBytes += bytes;
      if (file.kind === 'csharp') {
        sourceCount++;
        sourceBytes += bytes;
      }
      continue;
    }
    if (projectFileKind(path) !== 'native-archive') throw new Error(`${path} is not a .a archive.`);
    if (!(file.bytes instanceof Uint8Array)) throw new Error(`${path} has invalid binary contents.`);
    if (!file.bytes.byteLength || file.bytes.byteLength > maximumNativeArchiveBytes)
      throw new Error(`${path} must be between 1 byte and 8 MiB.`);
    validateWasmArchive(file.bytes, path);
    validateNativeLibraryName(file.libraryName);
    if (file.target !== 'wasm32') throw new Error(`${path} has an unsupported native target.`);
    projectBytes += file.bytes.byteLength;
  }
  if (!sourceCount || sourceCount > maximumSourceFiles)
    throw new Error(`A project must contain 1–${maximumSourceFiles} C# files.`);
  if (sourceBytes > maximumSourceSetBytes) throw new Error('Project C# source exceeds the 256 KiB limit.');
  if (projectBytes > maximumProjectBytes) throw new Error('Project files exceed the 16 MiB limit.');
}

export function serializeSourceSet(files: readonly ProjectFile[]): string {
  validateProjectFiles(files);
  return JSON.stringify({
    schemaVersion: 1,
    files: files.filter((file): file is TextProjectFile => file.kind === 'csharp')
      .map(({ path, text }) => ({ path: normalizeProjectPath(path), text })),
  });
}

export function cloneProjectFiles(files: readonly ProjectFile[]): ProjectFile[] {
  return files.map(file => isTextProjectFile(file)
    ? { ...file }
    : { ...file, bytes: file.bytes.slice() });
}

export function createProject(name: string, sources: readonly ProjectFileSource[], recipeId = 'hello'): PlaygroundProject {
  const files = sources.map((source, index): ProjectFile => {
    const path = normalizeProjectPath(source.path);
    const id = crypto.randomUUID?.() ?? `file-${Date.now()}-${index}`;
    if (source.kind === 'native-archive') return {
      id,
      path,
      kind: source.kind,
      bytes: source.bytes.slice(),
      libraryName: source.libraryName,
      target: source.target ?? 'wasm32',
    };
    return { id, path, kind: source.kind ?? projectFileKind(path) as TextProjectFileKind, text: source.text };
  });
  validateProjectFiles(files);
  return { schemaVersion: 2, id: crypto.randomUUID?.() ?? `project-${Date.now()}`, name,
    kind: 'command', recipeId, files, activeFileId: files[0].id };
}
