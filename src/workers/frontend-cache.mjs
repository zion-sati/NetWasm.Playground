const databaseName = 'netwasm-playground-frontend-cache';
const databaseVersion = 2;
const artifactStoreName = 'artifacts';
const accessStoreName = 'artifact-access';
const accountingStoreName = 'cache-accounting';
const partitionIndex = 'partition';
const accessedAtIndex = 'accessedAt';
const totalsKey = 'totals';
const maximumEntries = 100_000;
const maximumBytes = 72 * 1024 * 1024;
const maximumPayloadBytes = 16 * 1024 * 1024;
const maximumBatchEntries = 256;
const maximumBatchBytes = 4 * 1024 * 1024;
const blockedOpenTimeoutMilliseconds = 1_500;

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

function equalBytes(left, right) {
  const a = bytes(left), b = bytes(right);
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index++) if (a[index] !== b[index]) return false;
  return true;
}

function partition(toolchainId, descriptor) {
  if (!validHash(toolchainId) || !validIdentity(descriptor?.schema) ||
      !validHash(descriptor?.namespace)) throw Error('Invalid frontend cache identity');
  return `${toolchainId}/${descriptor.schema}/${descriptor.namespace}`;
}

function validRecord(record, expectedPartition, payloadLimit) {
  const payload = bytes(record?.payload), checksum = bytes(record?.checksum);
  return record?.partition === expectedPartition && validHash(record?.key) &&
    payload && payload.byteLength <= payloadLimit && checksum?.byteLength === 32 &&
    record.id === `${expectedPartition}/${record.key}`;
}

function createStores(database, transaction, migrate) {
  const artifacts = database.objectStoreNames.contains(artifactStoreName)
    ? transaction.objectStore(artifactStoreName)
    : database.createObjectStore(artifactStoreName, { keyPath: 'id' });
  if (!artifacts.indexNames.contains(partitionIndex))
    artifacts.createIndex(partitionIndex, partitionIndex, { unique: false });
  const access = database.objectStoreNames.contains(accessStoreName)
    ? transaction.objectStore(accessStoreName)
    : database.createObjectStore(accessStoreName, { keyPath: 'id' });
  if (!access.indexNames.contains(accessedAtIndex))
    access.createIndex(accessedAtIndex, accessedAtIndex, { unique: false });
  const accounting = database.objectStoreNames.contains(accountingStoreName)
    ? transaction.objectStore(accountingStoreName)
    : database.createObjectStore(accountingStoreName, { keyPath: 'id' });
  if (!migrate) {
    accounting.put({ id: totalsKey, count: 0, totalBytes: 0 });
    return;
  }
  let count = 0, totalBytes = 0, ordinal = Date.now();
  const cursor = artifacts.openCursor();
  cursor.onsuccess = () => {
    const row = cursor.result;
    if (!row) {
      accounting.put({ id: totalsKey, count, totalBytes });
      return;
    }
    const payload = bytes(row.value?.payload);
    if (payload) {
      count++;
      totalBytes += payload.byteLength;
      access.put({ id: row.primaryKey, accessedAt: ordinal++ });
    }
    row.continue();
  };
}

function openDatabase(onVersionChange, timeoutMilliseconds) {
  if (!globalThis.indexedDB) return Promise.reject(Error('IndexedDB is unavailable'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(Error('IndexedDB open was blocked')); }
    }, timeoutMilliseconds);
    request.onupgradeneeded = event =>
      createStores(request.result, request.transaction, event.oldVersion > 0);
    request.onblocked = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(Error('IndexedDB upgrade was blocked'));
      }
    };
    request.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(request.error ?? Error('IndexedDB open failed'));
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) { database.close(); return; }
      settled = true;
      clearTimeout(timer);
      database.onversionchange = () => {
        database.close();
        onVersionChange(database);
      };
      resolve(database);
    };
  });
}

export function clearFrontendCache(
  timeoutMilliseconds = blockedOpenTimeoutMilliseconds) {
  if (!globalThis.indexedDB) return Promise.reject(Error('IndexedDB is unavailable'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(Error('Frontend cache clearing was blocked by another tab'));
      }
    }, timeoutMilliseconds);
    request.onblocked = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(Error('Frontend cache clearing was blocked by another tab'));
      }
    };
    request.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(request.error ?? Error('Frontend cache clearing failed'));
      }
    };
    request.onsuccess = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };
  });
}

function normalizePolicy(overrides = {}) {
  const policy = {
    maximumEntries: overrides.maximumEntries ?? maximumEntries,
    maximumBytes: overrides.maximumBytes ?? maximumBytes,
    maximumPayloadBytes: overrides.maximumPayloadBytes ?? maximumPayloadBytes,
    maximumBatchEntries: overrides.maximumBatchEntries ?? maximumBatchEntries,
    maximumBatchBytes: overrides.maximumBatchBytes ?? maximumBatchBytes,
    blockedOpenTimeoutMilliseconds:
      overrides.blockedOpenTimeoutMilliseconds ?? blockedOpenTimeoutMilliseconds,
  };
  for (const value of Object.values(policy))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw Error('Invalid frontend cache policy');
  return policy;
}

export function createFrontendCache(toolchainId, policyOverrides) {
  const policy = normalizePolicy(policyOverrides);
  let database, opening;
  const reset = candidate => {
    if (!candidate || database === candidate) database = undefined;
    opening = undefined;
  };
  const open = async () => {
    if (database) return database;
    opening ??= openDatabase(reset, policy.blockedOpenTimeoutMilliseconds)
      .then(value => database = value)
      .catch(error => { reset(); throw error; });
    return opening;
  };
  return {
    async load(descriptor) {
      const selectedPartition = partition(toolchainId, descriptor);
      try {
        const db = await open();
        const transaction = db.transaction(artifactStoreName, 'readonly');
        const completed = transactionComplete(transaction);
        const cursorRequest = transaction.objectStore(artifactStoreName).index(partitionIndex)
          .openCursor(IDBKeyRange.only(selectedPartition));
        const entries = [];
        let totalBytes = 0;
        await new Promise((resolve, reject) => {
          cursorRequest.onerror = () =>
            reject(cursorRequest.error ?? Error('Frontend cache read failed'));
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) { resolve(); return; }
            const record = cursor.value;
            if (!validRecord(record, selectedPartition, policy.maximumPayloadBytes)) {
              cursor.continue();
              return;
            }
            const payload = bytes(record.payload), checksum = bytes(record.checksum);
            if (entries.length >= policy.maximumEntries ||
                payload.byteLength > policy.maximumBytes - totalBytes) {
              resolve();
              return;
            }
            totalBytes += payload.byteLength;
            entries.push({
              key: record.key,
              payload: payload.slice(),
              checksum: checksum.slice(),
            });
            cursor.continue();
          };
        });
        await completed;
        if (entries.length) {
          const accessTransaction = db.transaction(accessStoreName, 'readwrite',
            { durability: 'relaxed' });
          const access = accessTransaction.objectStore(accessStoreName);
          const now = Date.now();
          for (const entry of entries)
            access.put({ id: `${selectedPartition}/${entry.key}`, accessedAt: now });
          await transactionComplete(accessTransaction);
        }
        return { entries, totalBytes, available: true };
      } catch {
        reset(database);
        return { entries: [], totalBytes: 0, available: false };
      }
    },

    async write(descriptor, entries) {
      const selectedPartition = partition(toolchainId, descriptor);
      if (!Array.isArray(entries) || entries.length > policy.maximumBatchEntries) return false;
      let batchBytes = 0;
      const records = [];
      const ids = new Set();
      for (const entry of entries) {
        const payload = bytes(entry?.payload), checksum = bytes(entry?.checksum);
        const id = `${selectedPartition}/${entry?.key}`;
        if (!validHash(entry?.key) || !payload ||
            payload.byteLength > policy.maximumPayloadBytes ||
            checksum?.byteLength !== 32 ||
            payload.byteLength > policy.maximumBatchBytes - batchBytes ||
            ids.has(id)) return false;
        batchBytes += payload.byteLength;
        ids.add(id);
        records.push({
          id,
          partition: selectedPartition,
          key: entry.key,
          payload: payload.slice().buffer,
          checksum: checksum.slice().buffer,
        });
      }
      try {
        const db = await open();
        const transaction = db.transaction(
          [artifactStoreName, accessStoreName, accountingStoreName],
          'readwrite', { durability: 'relaxed' });
        const completed = transactionComplete(transaction);
        const artifacts = transaction.objectStore(artifactStoreName);
        const access = transaction.objectStore(accessStoreName);
        const accounting = transaction.objectStore(accountingStoreName);
        const totals = await requestResult(accounting.get(totalsKey)) ??
          { id: totalsKey, count: 0, totalBytes: 0 };
        const additions = [];
        const now = Date.now();
        for (const record of records) {
          const existing = await requestResult(artifacts.get(record.id));
          if (existing) {
            if (!equalBytes(existing.payload, record.payload) ||
                !equalBytes(existing.checksum, record.checksum)) {
              transaction.abort();
              await completed.catch(() => {});
              return false;
            }
            access.put({ id: record.id, accessedAt: now });
          } else additions.push(record);
        }
        let requiredCount = totals.count + additions.length;
        let requiredBytes = totals.totalBytes + additions.reduce(
          (sum, record) => sum + record.payload.byteLength, 0);
        if (requiredCount > policy.maximumEntries || requiredBytes > policy.maximumBytes) {
          const cursorRequest = access.index(accessedAtIndex).openCursor();
          await new Promise((resolve, reject) => {
            cursorRequest.onerror = () =>
              reject(cursorRequest.error ?? Error('Frontend cache eviction failed'));
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor ||
                  requiredCount <= policy.maximumEntries &&
                  requiredBytes <= policy.maximumBytes) {
                resolve();
                return;
              }
              if (ids.has(cursor.value.id)) { cursor.continue(); return; }
              const get = artifacts.get(cursor.value.id);
              get.onerror = () =>
                reject(get.error ?? Error('Frontend cache eviction read failed'));
              get.onsuccess = () => {
                const oldPayload = bytes(get.result?.payload);
                if (get.result) artifacts.delete(cursor.value.id);
                cursor.delete();
                if (oldPayload) {
                  requiredCount--;
                  requiredBytes -= oldPayload.byteLength;
                }
                cursor.continue();
              };
            };
          });
        }
        if (requiredCount > policy.maximumEntries || requiredBytes > policy.maximumBytes) {
          transaction.abort();
          await completed.catch(() => {});
          return false;
        }
        for (const record of additions) {
          artifacts.add(record);
          access.put({ id: record.id, accessedAt: now });
        }
        accounting.put({
          id: totalsKey,
          count: requiredCount,
          totalBytes: requiredBytes,
        });
        await completed;
        return true;
      } catch {
        return false;
      }
    },

    close() {
      database?.close();
      reset();
    },
  };
}

export const frontendCacheLimits = Object.freeze({
  maximumEntries,
  maximumBytes,
  maximumPayloadBytes,
  maximumBatchEntries,
  maximumBatchBytes,
  blockedOpenTimeoutMilliseconds,
});
