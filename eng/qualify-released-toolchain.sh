#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="${NETWASM_RELEASED_WORK:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/netwasm-playground-released}"
framework="$work/compiler-framework"
evidence="$work/evidence"

rm -rf "$work"
mkdir -p "$evidence"

python3 "$root/eng/build-release-compiler.py" --output "$framework"
python3 "$root/eng/rebuild-public-toolchain.py" \
  --compiler-framework "$framework" \
  --output "$root/public/toolchain"

cd "$root"
PLAYGROUND_BASE=/ npm run build
./node_modules/.bin/vite preview --host 127.0.0.1 --port 4173 --strictPort \
  >"$work/production-server.log" 2>&1 &
server_pid=$!
trap 'kill "${server_pid:-}" 2>/dev/null || true' EXIT
for _ in {1..60}; do
  curl --fail --silent http://127.0.0.1:4173/ >/dev/null && break
  sleep 1
done
curl --fail --silent http://127.0.0.1:4173/ >/dev/null

export PLAYGROUND_URL=http://127.0.0.1:4173/
PLAYGROUND_EVIDENCE="$evidence/settings" node eng/browser-smoke/csharp15-settings.mjs
PLAYGROUND_BROWSERS=chromium PLAYGROUND_CSHARP15_OPTIMIZATION=none \
  node eng/browser-smoke/csharp15-runtime.mjs
node eng/browser-smoke/library-catalog.mjs
PLAYGROUND_EVIDENCE="$evidence/tunit-failure" node eng/browser-smoke/tunit-failure.mjs
PLAYGROUND_EVIDENCE="$evidence/progress" node eng/browser-smoke/progress.mjs
PLAYGROUND_EVIDENCE="$evidence/lifecycle" node eng/browser-smoke/compiler-lifecycle.mjs
PLAYGROUND_EVIDENCE="$evidence/deployment" node eng/browser-smoke/deployment.mjs

python3 - "$evidence/released-receipt.json" <<'PY'
import json
import os
import subprocess
import sys
from pathlib import Path

output = Path(sys.argv[1])
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
receipt = {
    'schemaVersion': 1,
    'playground': {
        'commit': head,
        'tree': subprocess.check_output(
            ['git', 'rev-parse', f'{head}^{{tree}}'], text=True).strip(),
    },
    'workflowRunId': os.environ.get('GITHUB_RUN_ID'),
    'workflowRunAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
    'publicInputs': json.loads(Path('eng/upstream-sources.json').read_text()),
    'toolchain': json.loads(Path('public/toolchain/index.json').read_text()),
}
output.write_text(json.dumps(receipt, indent=2) + '\n')
PY

echo "PASS: released browser toolchain qualification"
