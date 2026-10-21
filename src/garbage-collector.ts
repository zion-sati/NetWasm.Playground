/** Canonical runtime collector identifiers; selection is independent of optimization. */
export const garbageCollectors = ['Compact', 'NetWasm', 'Bump'] as const;
export type GarbageCollector = typeof garbageCollectors[number];

export const garbageCollectorLabels: Record<GarbageCollector, string> = {
  Compact: 'Compact (default)',
  NetWasm: 'NetWasmGC',
  Bump: 'Bump (no collection)',
};

export function parseGarbageCollector(value: unknown): GarbageCollector {
  if (value === undefined || value === null) return 'Compact';
  if (typeof value !== 'string' || !garbageCollectors.includes(value as GarbageCollector))
    throw new Error('Unknown garbage collector');
  return value as GarbageCollector;
}

/** A stored preference can name a collector that a later NetWasm removed, such as Boehm. */
export function storedGarbageCollector(value: string | null): GarbageCollector {
  return garbageCollectors.includes(value as GarbageCollector) ? value as GarbageCollector : 'Compact';
}
