/** Accept the compiler-owned runtime plan without changing policy or cache identity. */
export function acceptRuntimeLinkPlan(plan) {
  if (!plan || !Array.isArray(plan.Arguments) || !Array.isArray(plan.OptimizationArguments) ||
      !plan.Arguments.every(value => typeof value === 'string') ||
      !plan.OptimizationArguments.every(value => typeof value === 'string') ||
      !Number.isSafeInteger(plan.RuntimeGlobalBase) ||
      typeof plan.GarbageCollector !== 'string' || !plan.GarbageCollector ||
      plan.Cache?.schema !== 'runtime-materialization-cache-v1' ||
      ![plan.Cache.namespace, plan.Cache.slot, plan.Cache.key].every(value =>
        typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)))
    throw Error('Invalid runtime link plan');
  return plan;
}
