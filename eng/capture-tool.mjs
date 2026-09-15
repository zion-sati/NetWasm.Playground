// Binaryen's published CLI assets are launched through Node by the SDK.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { spawnSync } from 'node:child_process';

const config = JSON.parse(readFileSync(process.env.NETWASM_CAPTURE_CONFIG, 'utf8'));
const result = spawnSync(config.python, [config.pythonAdapter, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, NETWASM_CAPTURE_TOOL: basename(process.argv[1]) },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
