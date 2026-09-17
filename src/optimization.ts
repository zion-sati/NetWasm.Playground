export const optimizationModes = ['none', 'O0', 'O1', 'O2', 'O3', 'Os', 'Oz'] as const;
export type OptimizationMode = typeof optimizationModes[number];

export const optimizationLabels: Record<OptimizationMode, string> = {
  none: 'None (fastest)', O0: '-O0', O1: '-O1', O2: '-O2',
  O3: '-O3', Os: '-Os', Oz: '-Oz (smallest)',
};

export function optimizationArguments(arguments_: readonly string[], mode: OptimizationMode): string[] {
  if (!optimizationModes.includes(mode)) throw new Error('Unknown optimization mode');
  if (mode === 'none') throw new Error('None skips the optimizer invocation');
  const indices = arguments_.flatMap((argument, index) => /^-O(?:[0-4]|s|z)$/.test(argument) ? [index] : []);
  if (indices.length !== 1) throw new Error('Unexpected authoritative optimization command');
  const result = [...arguments_];
  result[indices[0]] = `-${mode}`;
  return result;
}
