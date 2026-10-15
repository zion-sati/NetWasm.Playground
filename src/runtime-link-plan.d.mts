export interface BrowserRuntimeLinkPlan {
  Arguments: string[];
  OptimizationArguments: string[];
  RuntimeGlobalBase: number;
  GarbageCollector: string;
  Cache: {
    schema: string;
    namespace: string;
    slot: string;
    key: string;
  };
  [key: string]: unknown;
}

export function acceptRuntimeLinkPlan(
  plan: BrowserRuntimeLinkPlan,
): BrowserRuntimeLinkPlan;
