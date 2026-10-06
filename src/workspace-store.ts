import type { PlaygroundProject, ProjectFile } from './workspace';
import { validateProjectFiles } from './workspace';

const databaseName = 'netwasm-playground-projects';
const storeName = 'projects';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadProject(id: string): Promise<PlaygroundProject | undefined> {
  const database = await openDatabase();
  try {
    const value = await new Promise<PlaygroundProject | undefined>((resolve, reject) => {
      const request = database.transaction(storeName).objectStore(storeName).get(id);
      request.onsuccess = () => resolve(request.result as PlaygroundProject | undefined);
      request.onerror = () => reject(request.error);
    });
    if (!value || ![1, 2].includes(value.schemaVersion)) return undefined;
    const files = value.files.map(file => ({ ...file,
      ...(file.kind === 'native-archive' ? { bytes: new Uint8Array(file.bytes) } : {}),
    })) as ProjectFile[];
    validateProjectFiles(files);
    return { ...value, schemaVersion: 2, files, recipeId: value.recipeId ?? 'hello' };
  } finally { database.close(); }
}

export async function saveProject(project: PlaygroundProject): Promise<void> {
  validateProjectFiles(project.files);
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(project);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { database.close(); }
}
