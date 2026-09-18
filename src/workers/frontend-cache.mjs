const databaseName = 'netwasm-playground-frontend-cache';
const databaseVersion = 1;
const storeName = 'artifacts';
const partitionIndex = 'partition';
const maximumEntries = 100_000;
const maximumBytes = 72 * 1024 * 1024;
const maximumPayloadBytes = 16 * 1024 * 1024;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? Error('IndexedDB transaction failed'));
  });
}

function validIdentity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function validHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return undefined;
}

function partition(toolchainId, descriptor) {
  if (!validHash(toolchainId) || !validIdentity(descriptor?.schema) ||
      !validHash(descriptor?.namespace)) throw Error('Invalid frontend cache identity');
  return `${toolchainId}/${descriptor.schema}/${descriptor.namespace}`;
}

function validRecord(record, expectedPartition) {
  const payload = bytes(record?.payload), checksum = bytes(record?.checksum);
  return record?.partition === expectedPartition && validHash(record?.key) &&
    payload && payload.byteLength <= maximumPayloadBytes && checksum?.byteLength === 32 &&
    record.id === `${expectedPartition}/${record.key}`;
}

async function openDatabase() {
  if (!globalThis.indexedDB) throw Error('IndexedDB is unavailable');
  const request = indexedDB.open(databaseName, databaseVersion);
  request.onupgradeneeded = () => {
    const database = request.result;
    const store = database.objectStoreNames.contains(storeName)
      ? request.transaction.objectStore(storeName)
      : database.createObjectStore(storeName, { keyPath: 'id' });
    if (!store.indexNames.contains(partitionIndex))
      store.createIndex(partitionIndex, partitionIndex, { unique: false });
  };
  return requestResult(request);
}

export function createFrontendCache(toolchainId) {
  let database;
  const open = async () => database ??= await openDatabase();
  return {
    async load(descriptor) {
      const selectedPartition = partition(toolchainId, descriptor);
      try {
        const db = await open();
        const transaction = db.transaction(storeName, 'readonly');
        const completed = transactionComplete(transaction);
        const cursorRequest = transaction.objectStore(storeName).index(partitionIndex)
          .openCursor(IDBKeyRange.only(selectedPartition));
        const entries = [];
        let totalBytes = 0;
        await new Promise((resolve, reject) => {
          cursorRequest.onerror = () => reject(cursorRequest.error ?? Error('Frontend cache read failed'));
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) { resolve(); return; }
            const record = cursor.value;
            if (!validRecord(record, selectedPartition)) { cursor.continue(); return; }
            const payload = bytes(record.payload), checksum = bytes(record.checksum);
            if (entries.length >= maximumEntries || payload.byteLength > maximumBytes - totalBytes) {
              resolve(); return;
            }
            totalBytes += payload.byteLength;
            entries.push({ key: record.key, payload: payload.slice(), checksum: checksum.slice() });
            cursor.continue();
          };
        });
        await completed;
        return { entries, totalBytes, available: true };
      } catch {
        return { entries: [], totalBytes: 0, available: false };
      }
    },

    async write(descriptor, entries) {
      const selectedPartition = partition(toolchainId, descriptor);
      if (!Array.isArray(entries) || entries.length > 256) return false;
      let totalBytes = 0;
      const records = [];
      for (const entry of entries) {
        const payload = bytes(entry?.payload), checksum = bytes(entry?.checksum);
        if (!validHash(entry?.key) || !payload || payload.byteLength > maximumPayloadBytes ||
            checksum?.byteLength !== 32 || payload.byteLength > 4 * 1024 * 1024 - totalBytes)
          return false;
        totalBytes += payload.byteLength;
        records.push({
          id: `${selectedPartition}/${entry.key}`,
          partition: selectedPartition,
          key: entry.key,
          payload: payload.slice().buffer,
          checksum: checksum.slice().buffer,
          updatedAt: Date.now(),
        });
      }
      try {
        const db = await open();
        const transaction = db.transaction(storeName, 'readwrite', { durability: 'relaxed' });
        const store = transaction.objectStore(storeName);
        for (const record of records) store.put(record);
        await transactionComplete(transaction);
        return true;
      } catch {
        return false;
      }
    },

    close() {
      database?.close();
      database = undefined;
    },
  };
}

export const frontendCacheLimits = Object.freeze({
  maximumEntries,
  maximumBytes,
  maximumPayloadBytes,
  maximumBatchEntries: 256,
  maximumBatchBytes: 4 * 1024 * 1024,
});
