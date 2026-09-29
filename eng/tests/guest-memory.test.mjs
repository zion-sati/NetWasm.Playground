import assert from 'node:assert/strict';
import test from 'node:test';
import { checkGuestMemory } from '../../src/workers/guest-memory.mjs';

const u32 = value => {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return bytes;
};

const moduleWithMemory = (flags, initialPages, maximumPages) => {
  const declaration = [1, ...u32(flags), ...u32(initialPages),
    ...(maximumPages === undefined ? [] : u32(maximumPages))];
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, ...u32(declaration.length), ...declaration]);
};

const maximumBytes = 2 * 1024 * 1024 * 1024;

test('accepts the exact declared guest-memory boundary', () => {
  assert.deepEqual(checkGuestMemory(moduleWithMemory(1, 1, 32768), maximumBytes), [
    { initialPages: 1, maximumPages: 32768 },
  ]);
});

test('rejects a declaration above the guest-memory boundary', () => {
  assert.throws(() => checkGuestMemory(moduleWithMemory(1, 1, 32769), maximumBytes),
    /Guest memory limit exceeded/);
});

test('rejects unbounded and shared guest memory', () => {
  assert.throws(() => checkGuestMemory(moduleWithMemory(0, 1), maximumBytes),
    /explicit unshared wasm32 maximum/);
  assert.throws(() => checkGuestMemory(moduleWithMemory(3, 1, 32768), maximumBytes),
    /explicit unshared wasm32 maximum/);
});

test('requires an explicit aligned policy', () => {
  const module = moduleWithMemory(1, 1, 1);
  for (const policy of [undefined, 0, 65535, Number.NaN])
    assert.throws(() => checkGuestMemory(module, policy), /Invalid guest memory policy/);
});
