export interface CoreLinkExportOperation {
  componentPrefix: string | null;
  removedExports: { name: string; kind: number }[];
}
export interface CoreLinkHost {
  checkCancelled(): void;
  parse(text: string): Promise<Uint8Array>;
  inline(bytes: Uint8Array, selection: string): Promise<Uint8Array>;
  exports(bytes: Uint8Array, operation: CoreLinkExportOperation): Promise<Uint8Array>;
  tool(id: string, arguments_: string[], files: Record<string, Uint8Array>, outputs: string[]): Promise<Record<string, Uint8Array>>;
}
export function executeCoreLink(envelope: string, inputs: Record<string, Uint8Array>, host: CoreLinkHost): Promise<Record<string, Uint8Array>>;
