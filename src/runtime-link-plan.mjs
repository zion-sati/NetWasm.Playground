const ephemeronExports = new Set([
  '--export=ephemeron_handle_get_key',
  '--export=ephemeron_handle_get_value',
  '--export=ephemeron_handle_new',
  '--export=ephemeron_handle_release',
]);
const structuredDiagnosticExports = new Set([
  '--export=command_exception_capture',
  '--export=command_exception_completion',
  '--export=command_exception_release',
  '--export=command_exception_write',
]);

function canonicalFeatures(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32 ||
      value.some(feature => typeof feature !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feature)))
    throw Error('Invalid compiler runtime feature evidence');
  return new Set(value);
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function materializeRuntimeLinkPlan(plan, runtimeFeatures) {
  if (!plan || !Array.isArray(plan.Arguments) || !Array.isArray(plan.OptimizationArguments) ||
      !Number.isSafeInteger(plan.RuntimeGlobalBase) || !/^[a-f0-9]{64}$/.test(plan.Cache?.key))
    throw Error('Invalid runtime link plan');
  const features = canonicalFeatures(runtimeFeatures);
  // The runtime planner in the 0.6.0 compiler package predates forwarding the
  // compiler's feature evidence and runtime global base. Apply those two
  // authoritative inputs at the browser boundary until the package pin advances.
  // Missing feature evidence deliberately preserves the legacy complete runtime.
  let arguments_ = plan.Arguments;
  if (features) {
    const includeEphemerons = features.has('ephemeron-handles');
    const includeStructuredDiagnostics = features.has('structured-command-diagnostics');
    arguments_ = arguments_.filter(argument =>
      (includeEphemerons || !ephemeronExports.has(argument)) &&
      (includeStructuredDiagnostics || !structuredDiagnosticExports.has(argument)));
  }
  const optimizationArguments = [...plan.OptimizationArguments];
  if (plan.RuntimeGlobalBase >= 1024 && optimizationArguments.length &&
      !optimizationArguments.includes('--low-memory-unused')) {
    const optimizationIndex = optimizationArguments.findIndex(argument =>
      /^-O(?:[0-3]|s|z)$/.test(argument));
    if (optimizationIndex < 0) throw Error('Runtime optimization plan has no optimization mode');
    optimizationArguments.splice(optimizationIndex + 1, 0, '--low-memory-unused');
  }
  const argumentsChanged = arguments_.length !== plan.Arguments.length;
  const optimizationChanged = optimizationArguments.length !== plan.OptimizationArguments.length;
  if (!argumentsChanged && !optimizationChanged) return plan;
  const key = await sha256(JSON.stringify({
    schema: 'playground-runtime-materialization-v1',
    sourceKey: plan.Cache.key,
    arguments: arguments_,
    optimizationArguments,
  }));
  return {
    ...plan,
    Arguments: arguments_,
    OptimizationArguments: optimizationArguments,
    Cache: { ...plan.Cache, key },
  };
}
