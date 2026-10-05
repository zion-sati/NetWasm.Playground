export interface BrowserRuntimeLinkPlan {
  Arguments: string[];
  OptimizationArguments: string[];
  RuntimeGlobalBase: number;
  Cache: {
    schema: string;
    namespace: string;
    slot: string;
    key: string;
  };
  [key: string]: unknown;
}

export function materializeRuntimeLinkPlan(
  plan: BrowserRuntimeLinkPlan,
  runtimeFeatures?: string[],
): Promise<BrowserRuntimeLinkPlan>;
