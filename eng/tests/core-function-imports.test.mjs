import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCoreFunctionImports } from '../../src/core-function-imports.mjs';

const skeleton = lines => new TextEncoder().encode(['(module', ...lines, ')'].join('\n'));

test('reads unnamed function imports and their signatures', () => {
  const imports = parseCoreFunctionImports(skeleton([
    '  (type (;0;) (func (param i32 i64) (result f64)))',
    '  (type (;1;) (func))',
    '  (import "cm32p2|wasi:cli/environment@0.3" "get-environment" (func (;0;) (type 0)))',
    '  (import "$root" "[waitable-set-new]" (func (;1;) (type 1)))',
  ]));
  assert.deepEqual(imports, [
    { Module: 'cm32p2|wasi:cli/environment@0.3', Name: 'get-environment', Parameters: [0, 1], Results: [3] },
    { Module: '$root', Name: '[waitable-set-new]', Parameters: [], Results: [] },
  ]);
});

// A linked runtime keeps its symbol names, so its imports and types print with them.
test('reads named function imports, as a linked runtime prints them', () => {
  const imports = parseCoreFunctionImports(skeleton([
    '  (type $signature (;0;) (func (result i32)))',
    '  (import "$root" "[waitable-set-new]" (func $runtime_waitable_set_new (;0;) (type 0)))',
    '  (import "wasi:cli/stdout@0.3.2" "[stream-new-0]write-via-stream" (func $"odd name" (;1;) (type 0)))',
  ]));
  assert.deepEqual(imports.map(item => `${item.Module} ${item.Name}`),
    ['$root [waitable-set-new]', 'wasi:cli/stdout@0.3.2 [stream-new-0]write-via-stream']);
  assert.deepEqual(imports[0].Results, [0]);
});

test('skips imports that are not functions', () => {
  const imports = parseCoreFunctionImports(skeleton([
    '  (type (;0;) (func))',
    '  (import "env" "memory" (memory (;0;) 1))',
    '  (import "env" "__stack_pointer" (global (;0;) (mut i32)))',
  ]));
  assert.deepEqual(imports, []);
});

test('rejects a function import or type inventory it cannot read', () => {
  assert.throws(() => parseCoreFunctionImports(skeleton([
    '  (type (;0;) (func))',
    '  (import "env" "f" (func (;0;) (type 0) (param i32)))',
  ])), /Unrecognized core Wasm function import/);
  assert.throws(() => parseCoreFunctionImports(skeleton([
    '  (type (;0;) (func))',
    '  (import "env" "f" (func (;0;) (type 1)))',
  ])), /unknown type/);
  assert.throws(() => parseCoreFunctionImports(skeleton([
    '  (type (;1;) (func))',
  ])), /Invalid core Wasm type inventory/);
  assert.throws(() => parseCoreFunctionImports(skeleton([
    '  (type (;0;) (func (param v128)))',
  ])), /Unsupported core Wasm value type: v128/);
  assert.throws(() => parseCoreFunctionImports(skeleton([])), /Invalid core Wasm import inventory/);
});
