/** Canonical runtime collector identifiers; selection is independent of optimization. */
export const garbageCollectors = ['Compact', 'NetWasm', 'Boehm', 'Bump'] as const;
export type GarbageCollector = typeof garbageCollectors[number];

export const garbageCollectorLabels: Record<GarbageCollector, string> = {
  Compact: 'Compact (default)',
  NetWasm: 'NetWasmGC',
  Boehm: 'Boehm',
  Bump: 'Bump (no collection)',
};

export function parseGarbageCollector(value: unknown): GarbageCollector {
  if (value === undefined || value === null) return 'Compact';
  if (typeof value !== 'string' || !garbageCollectors.includes(value as GarbageCollector))
    throw new Error('Unknown garbage collector');
  return value as GarbageCollector;
}
