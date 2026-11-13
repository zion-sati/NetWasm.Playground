import type { OptimizationMode } from './optimization';
import type { GarbageCollector } from './garbage-collector';
import type { ProjectFile, ProjectKind } from './workspace';

export type LanguageMode = '15' | 'preview';

export interface SourceSnapshot {
  requestId: number;
  revision: number;
  files: ProjectFile[];
  projectKind: ProjectKind;
  /** Accepted temporarily by lower-level compatibility tests and older callers. */
  source?: string;
  recipeId: string;
  optimization?: OptimizationMode;
  garbageCollector?: GarbageCollector;
  /** IANA zone for runs; time zone data is mounted only for programs that reach local time. */
  timeZone?: string;
  /** Compiler-owned override names and values; validated by the compiler. */
  optimizationOverrides?: Readonly<Record<string, string>>;
  language: LanguageMode;
  updatedMemorySafetyRules: boolean;
  /** Whether an unhandled exception reports its type and message; Run turns it on by default. */
  structuredDiagnostics?: boolean;
}

/**
 * The program's symbols sidecars. Type-symbols names the types a failure report carries, or every
 * type when type names are on; method-symbols, present when stack traces are on, names stack frames.
 */
export interface SymbolSidecars {
  typeSymbols: Uint8Array;
  methodSymbols?: Uint8Array;
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
export interface AssetMeasurement { rawBytes: number; compressedBytes?: number }
export interface ToolchainPreloadProgress extends AssetMeasurement {
  completedBundles: number;
  totalBundles: number;
  loadedBundleBytes: number;
  totalBundleBytes: number;
}

// What a compilation reused of the compiled units the worker kept for its settings.
export interface CompiledUnitsMetrics {
  summary?: string;
  restoredBytes: number;
  storedBytes: number;
}

export interface RuntimeCacheMetrics {
  outcome: 'hit' | 'miss' | 'unavailable';
  readBytes: number;
  written: boolean;
}

export type PipelineEvent = { requestId: number; revision: number } & (
  | { type: 'stage'; stage: string; state: 'running' | 'complete'; milliseconds?: number }
  | { type: 'console'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'assets'; rawBytes: number; compressedBytes?: number }
);

export interface CompilationResult {
  requestId: number;
  revision: number;
  success: boolean;
  optimization?: OptimizationMode;
  garbageCollector?: GarbageCollector;
  /** Compiler-owned override names and values; validated by the compiler. */
  optimizationOverrides?: Readonly<Record<string, string>>;
  language?: LanguageMode;
  updatedMemorySafetyRules?: boolean;
  structuredDiagnostics?: boolean;
  /** The program's deployed file name, which its sidecars' names extend. */
  programFileName?: string;
  symbolSidecars?: SymbolSidecars;
  cancelled?: boolean;
  component?: Uint8Array;
  componentContract?: 'command' | 'jsexport-worker';
  /** Runtime features the compiled program reaches, such as 'local-time'. */
  runtimeFeatures?: readonly string[];
  rawAdapter?: Uint8Array;
  runtimeLayout?: Uint8Array;
  interopManifest?: Uint8Array;
  requiredImports?: readonly {
    Interface: string;
    Name: string;
    Parameters: readonly string[];
    Results: readonly string[];
  }[];
  diagnostics: Diagnostic[];
  timings: StageTiming[];
  compiledUnits?: CompiledUnitsMetrics;
  runtimeCacheMetrics?: RuntimeCacheMetrics;
  compilerHostLinearMemoryBytes?: number;
  optimizerHost?: 'native-threads' | 'javascript';
  optimizerWorkerCount?: number;
  optimizerLinearMemoryBytes?: number;
  optimizerFallback?: string;
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
