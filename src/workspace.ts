export const maximumSourceFiles = 32;
export const maximumSourceFileBytes = 64 * 1024;
export const maximumSourceSetBytes = 256 * 1024;

export type ProjectKind = 'command' | 'wit-worker' | 'jsexport-worker';

export interface ProjectFile {
  id: string;
  path: string;
  kind: 'csharp';
  text: string;
}

export interface PlaygroundProject {
  schemaVersion: 1;
  id: string;
  name: string;
  kind: ProjectKind;
  recipeId: string;
  files: ProjectFile[];
  activeFileId: string;
}

const encoder = new TextEncoder();
const validSegment = /^[^<>:"|?*\x00-\x1f]+$/;

export function normalizeProjectPath(value: string): string {
  const path = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  const segments = path.split('/');
  if (!path || path.startsWith('/') || path.length > 240 ||
      segments.some(segment => !segment || segment === '.' || segment === '..' || !validSegment.test(segment)))
    throw new Error('Use a relative project path without empty, . or .. segments.');
  return segments.join('/');
}

export function validateProjectFiles(files: readonly ProjectFile[]): void {
  if (!files.length || files.length > maximumSourceFiles)
    throw new Error(`A project must contain 1–${maximumSourceFiles} C# files.`);
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    const path = normalizeProjectPath(file.path);
    if (!path.endsWith('.cs')) throw new Error(`${path} is not a C# source file.`);
    if (paths.has(path)) throw new Error(`Duplicate project path: ${path}`);
    paths.add(path);
    const bytes = encoder.encode(file.text).byteLength;
    if (bytes > maximumSourceFileBytes) throw new Error(`${path} exceeds the 64 KiB file limit.`);
    totalBytes += bytes;
  }
  if (totalBytes > maximumSourceSetBytes) throw new Error('Project source exceeds the 256 KiB limit.');
}

export function serializeSourceSet(files: readonly ProjectFile[]): string {
  validateProjectFiles(files);
  return JSON.stringify({
    schemaVersion: 1,
    files: files.map(({ path, text }) => ({ path: normalizeProjectPath(path), text })),
  });
}

export function createProject(name: string, sources: readonly { path: string; text: string }[], recipeId = 'hello'): PlaygroundProject {
  const files = sources.map((source, index): ProjectFile => ({
    id: crypto.randomUUID?.() ?? `file-${Date.now()}-${index}`,
    path: normalizeProjectPath(source.path),
    kind: 'csharp',
    text: source.text,
  }));
  validateProjectFiles(files);
  return { schemaVersion: 1, id: crypto.randomUUID?.() ?? `project-${Date.now()}`, name,
    kind: 'command', recipeId, files, activeFileId: files[0].id };
}
