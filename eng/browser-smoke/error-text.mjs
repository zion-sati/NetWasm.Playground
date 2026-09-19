import assert from 'node:assert/strict';
import { errorText } from '../../src/workers/asset-loader.mjs';

const unsupported = 'Unsupported guest import: wasi:clocks/wall-clock';
const location = '@https://playground.netwasm.com/toolchain/workers/guest-worker.mjs:66:13';

assert.equal(errorText({ name: 'Error', message: unsupported, stack: location }),
  `Error: ${unsupported}\n${location}`);
assert.equal(errorText({ name: 'TypeError', message: 'cross realm', stack: `TypeError: cross realm\n${location}` }),
  `TypeError: cross realm\n${location}`);
assert.equal(errorText({ name: 'Error', message: unsupported }), `Error: ${unsupported}`);
assert.equal(errorText({ name: 'Error', message: 'outer', cause: { name: 'TypeError', message: 'inner' } }),
  'Error: outer\nCaused by: TypeError: inner');
assert.equal(errorText(unsupported), unsupported);
assert.equal(errorText({ stack: location }), location);
assert.equal(errorText(null), 'null');
assert.equal(errorText({ name: 'Error', message: 'x'.repeat(5000), stack: location }).length, 4096);

console.log('Worker error text preserves messages and stack locations');
