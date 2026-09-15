export interface SourceSnapshot {
  requestId: number;
  revision: number;
  source: string;
  recipeId: string;
}

export interface Diagnostic {
  code: string;
  message: string;
  severity: string;
  path?: string;
  line?: number;
  column?: number;
}

export interface StageTiming { stage: string; milliseconds: number }
export interface AssetMeasurement { rawBytes: number; transferBytes: number }

export type PipelineEvent = { requestId: number; revision: number } & (
  | { type: 'stage'; stage: string; state: 'running' | 'complete'; milliseconds?: number }
  | { type: 'console'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'assets'; rawBytes: number; transferBytes: number }
);

export interface CompilationResult {
  requestId: number;
  revision: number;
  success: boolean;
  cancelled?: boolean;
  component?: Uint8Array;
  diagnostics: Diagnostic[];
  timings: StageTiming[];
  assets?: AssetMeasurement;
  error?: string;
  stage?: string;
}

export interface RunResult {
  requestId: number;
  revision: number;
  success: boolean;
  cancelled?: boolean;
  exitCode?: number;
  stdout: string;
  stderr: string;
  error?: string;
  stage?: string;
  timings: StageTiming[];
}
