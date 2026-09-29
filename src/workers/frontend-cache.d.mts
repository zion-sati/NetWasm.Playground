export function clearFrontendCache(timeoutMilliseconds?: number): Promise<void>;

export interface CacheDescriptor {
  schema: string;
  namespace: string;
}

export interface RuntimeCacheDescriptor extends CacheDescriptor {
  slot: string;
  key: string;
}

export interface CacheEntry {
  key: string;
  payload: Uint8Array;
  checksum: Uint8Array;
}

export interface CachePolicy {
  maximumEntries?: number;
  maximumBytes?: number;
  maximumPayloadBytes?: number;
  maximumBatchEntries?: number;
  maximumBatchBytes?: number;
  blockedOpenTimeoutMilliseconds?: number;
}

export function createFrontendCache(toolchainId: string, policy?: CachePolicy): {
  load(descriptor: CacheDescriptor): Promise<{
    entries: CacheEntry[];
    totalBytes: number;
    available: boolean;
  }>;
  write(descriptor: CacheDescriptor, entries: CacheEntry[]): Promise<boolean>;
  loadRuntime(descriptor: RuntimeCacheDescriptor): Promise<
    | { hit: true; available: true; payload: Uint8Array; checksum: Uint8Array }
    | { hit: false; available: boolean; payload?: undefined; checksum?: undefined }
  >;
  writeRuntime(
    descriptor: RuntimeCacheDescriptor,
    payload: Uint8Array,
    checksum: Uint8Array,
  ): Promise<boolean>;
  close(): void;
};
