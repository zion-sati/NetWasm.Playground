// Reads a core module's function imports from `wasm-tools print --skeleton`, for the raw
// binding planner, which the browser cannot hand a module to inspect itself.
const valueTypes = new Map([['i32', 0], ['i64', 1], ['f32', 2], ['f64', 3]]);
// A function or type may carry a name, as a linked runtime keeps its symbol names: `$name`,
// or `$"..."` when the name has characters an identifier cannot.
const name = String.raw`(?: \$(?:"(?:\\.|[^"\\])*"|[^\s()"]+))?`;
const typeLine = new RegExp(String.raw`^\s*\(type${name} \(;([0-9]+);\) \(func(?: \(param ([^)]*)\))?(?: \(result ([^)]*)\))?\)\)\s*$`, 'u');
const importLine = new RegExp(String.raw`^\s*\(import ("(?:\\.|[^"\\])*") ("(?:\\.|[^"\\])*") \(func${name} \(;[0-9]+;\) \(type ([0-9]+)\)\)\)\s*$`, 'u');

export function parseCoreFunctionImports(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const types = new Map();
  const imports = [];
  const values = source => source ? source.trim().split(/\s+/u).map(value => {
    const mapped = valueTypes.get(value);
    if (mapped === undefined) throw new Error(`Unsupported core Wasm value type: ${value}`);
    return mapped;
  }) : [];
  for (const line of text.split('\n')) {
    const type = typeLine.exec(line);
    if (type) {
      const index = Number(type[1]);
      if (types.has(index) || index !== types.size) throw new Error('Invalid core Wasm type inventory');
      types.set(index, { Parameters: values(type[2]), Results: values(type[3]) });
      continue;
    }
    if (!line.trimStart().startsWith('(import ')) continue;
    const imported = importLine.exec(line);
    if (!imported) {
      // Memories, tables and globals are not functions; any other import must parse.
      if (/^\s*\(import "(?:\\.|[^"\\])*" "(?:\\.|[^"\\])*" \(func\b/u.test(line))
        throw new Error(`Unrecognized core Wasm function import: ${line.trim()}`);
      continue;
    }
    const signature = types.get(Number(imported[3]));
    if (!signature) throw new Error('Core Wasm import references an unknown type');
    imports.push({ Module: JSON.parse(imported[1]), Name: JSON.parse(imported[2]),
      Parameters: [...signature.Parameters], Results: [...signature.Results] });
  }
  if (types.size === 0 || imports.length > 512) throw new Error('Invalid core Wasm import inventory');
  return imports;
}
