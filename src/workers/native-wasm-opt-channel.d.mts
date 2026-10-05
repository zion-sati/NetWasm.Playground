export interface NativeWasmOptChannel {
  initialize(): Promise<{
    success: boolean;
    workerCount: number;
    hardwareConcurrency: number;
  }>;
  request(
    data: Record<string, unknown>,
    transfers?: Transferable[],
    timeout?: number,
  ): Promise<any>;
  reset(reason?: Error): void;
}

export function recommendedNativeWasmOptWorkers(): number;
export function supportsNativeWasmOpt(): boolean;
export function createNativeWasmOptChannel(
  candidateRoot: string,
  workerCount?: number,
  signal?: (data: any) => void,
): NativeWasmOptChannel;
