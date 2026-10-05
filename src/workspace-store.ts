import type { PlaygroundProject } from './workspace';
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
    if (!value || value.schemaVersion !== 1) return undefined;
    validateProjectFiles(value.files);
    return { ...value, recipeId: value.recipeId ?? 'hello' };
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
