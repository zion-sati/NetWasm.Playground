import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installGuestHttpBudget } from '../../src/workers/guest-http-budget.mjs';

const root = resolve(process.env.PLAYGROUND_TOOLCHAIN ?? 'public/toolchain');
const { id } = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
const { httpModule } = await import(pathToFileURL(join(root, id, 'jco/guest-providers.mjs')).href);
const stream = () => new httpModule.types.OutgoingRequest(new httpModule.types.Fields()).body().write();

const denied = [];
let restore = installGuestHttpBudget(httpModule, message => denied.push(message), 128 * 1024);
try {
  const output = stream();
  const bytes = new Uint8Array(64 * 1024);
  for (let index = 0; index < 2; index++) { output.checkWrite(); output.write(bytes); }
  output.checkWrite();
  assert.throws(() => output.write(bytes), /Guest HTTP request body limit exceeded/);
  assert.equal(denied.length, 1);
} finally { restore(); }

restore = installGuestHttpBudget(httpModule, () => {}, 4096);
try {
  const output = stream();
  output.blockingWriteAndFlush(new Uint8Array(4096));
  assert.throws(() => output.blockingWriteAndFlush(new Uint8Array(1)),
    /Guest HTTP request body limit exceeded/);
} finally { restore(); }

console.log('PASS public browser HTTP provider: bounded writes and fresh-run recovery');
