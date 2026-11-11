export interface CoreFunctionImport {
  Module: string;
  Name: string;
  Parameters: number[];
  Results: number[];
}

export function parseCoreFunctionImports(bytes: Uint8Array): CoreFunctionImport[];
