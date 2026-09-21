#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
core="${NETWASM_CORE_SOURCE:?NETWASM_CORE_SOURCE is required}"
tunit="${NETWASM_TUNIT_SOURCE:?NETWASM_TUNIT_SOURCE is required}"
core_commit="$(git -C "$core" rev-parse HEAD)"
tunit_commit="$(git -C "$tunit" rev-parse HEAD)"
expected_core="${NETWASM_CORE_COMMIT:?NETWASM_CORE_COMMIT is required}"
expected_tunit="${NETWASM_TUNIT_COMMIT:?NETWASM_TUNIT_COMMIT is required}"
[[ "$core_commit" == "$expected_core" && "$tunit_commit" == "$expected_tunit" ]] || {
  echo "Candidate source checkout does not match its immutable input descriptor." >&2
  exit 1
}

work="${NETWASM_CANDIDATE_WORK:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/netwasm-playground-candidate}"
feed="$work/packages"
framework="$work/compiler-framework"
runtime_plan="$work/runtime-plan.json"
evidence="$work/evidence"
version="0.4.0-ci.${GITHUB_RUN_ID:-local}.${GITHUB_RUN_ATTEMPT:-1}"
rm -rf "$work"
mkdir -p "$feed" "$evidence"

source "${NETWASM_EMSDK_ROOT:?NETWASM_EMSDK_ROOT is required}/emsdk_env.sh"
bash "$core/eng/build-packages.sh" --version "$version" --output "$feed"
python3 "$core/eng/build-host-tools-package.py" \
  --rid linux-x64 --version "$version" --output "$work/host-packages" \
  --cache "$work/host-inputs"
cp "$work/host-packages"/*.nupkg "$feed/"

NETWASM_CI_PACKAGE_SOURCE="$feed" \
  bash "$tunit/eng/netwasm-build-packages.sh" \
    --version "$version" --netwasm-candidate-version "$version" --output "$feed"

python3 "$root/eng/build-release-compiler.py" \
  --output "$framework" \
  --candidate-feed "$feed" --candidate-version "$version" \
  --candidate-tunit-version "$version"

rebuild=(python3 "$root/eng/rebuild-public-toolchain.py"
  --compiler-framework "$framework" --output "$root/public/toolchain"
  --candidate-feed "$feed" --candidate-version "$version" --candidate-commit "$core_commit"
  --candidate-tunit-version "$version" --candidate-tunit-commit "$tunit_commit")
"${rebuild[@]}"

cd "$root"
npm run dev -- --port 4173 >"$work/preliminary-server.log" 2>&1 &
server_pid=$!
trap 'kill "${server_pid:-}" 2>/dev/null || true' EXIT
for _ in {1..60}; do
  curl --fail --silent http://127.0.0.1:4173/ >/dev/null && break
  sleep 1
done
curl --fail --silent http://127.0.0.1:4173/ >/dev/null
PLAYGROUND_URL=http://127.0.0.1:4173/ PLAYGROUND_RUNTIME_PLAN="$runtime_plan" \
  node eng/browser-smoke/capture-runtime-plan.mjs
kill "$server_pid"
wait "$server_pid" 2>/dev/null || true
unset server_pid

"${rebuild[@]}" --runtime-plan "$runtime_plan"

npm run dev -- --port 4173 >"$work/development-server.log" 2>&1 &
server_pid=$!
for _ in {1..60}; do
  curl --fail --silent http://127.0.0.1:4173/ >/dev/null && break
  sleep 1
done
curl --fail --silent http://127.0.0.1:4173/ >/dev/null
PLAYGROUND_URL=http://127.0.0.1:4173/ PLAYGROUND_EVIDENCE="$evidence/frontend-cache" \
  node eng/browser-smoke/frontend-cache.mjs
PLAYGROUND_URL=http://127.0.0.1:4173/ PLAYGROUND_EVIDENCE="$evidence/resource" \
  node eng/browser-smoke/resource.mjs
kill "$server_pid"
wait "$server_pid" 2>/dev/null || true
unset server_pid

PLAYGROUND_BASE=/ npm run build
npm run preview -- --host 127.0.0.1 --port 4173 >"$work/production-server.log" 2>&1 &
server_pid=$!
for _ in {1..60}; do
  curl --fail --silent http://127.0.0.1:4173/ >/dev/null && break
  sleep 1
done
curl --fail --silent http://127.0.0.1:4173/ >/dev/null

export PLAYGROUND_URL=http://127.0.0.1:4173/
PLAYGROUND_EVIDENCE="$evidence/settings" node eng/browser-smoke/csharp15-settings.mjs
PLAYGROUND_BROWSERS=chromium PLAYGROUND_CSHARP15_OPTIMIZATION=Oz \
  node eng/browser-smoke/csharp15-runtime.mjs
node eng/browser-smoke/library-catalog.mjs
PLAYGROUND_EVIDENCE="$evidence/tunit-failure" node eng/browser-smoke/tunit-failure.mjs
PLAYGROUND_EVIDENCE="$evidence/progress" node eng/browser-smoke/progress.mjs
PLAYGROUND_CHANNEL_RESULT="$evidence/worker-channel.json" node eng/browser-smoke/worker-channel.mjs
PLAYGROUND_EVIDENCE="$evidence/lifecycle" node eng/browser-smoke/compiler-lifecycle.mjs
PLAYGROUND_EVIDENCE="$evidence/deployment" node eng/browser-smoke/deployment.mjs

python3 - "$feed" "$evidence/candidate-receipt.json" "$version" "$core_commit" "$tunit_commit" <<'PY'
import hashlib, json, os, subprocess, sys
from pathlib import Path
feed_arg, output, version, core, tunit = sys.argv[1:]
feed = Path(feed_arg)
index = json.loads(Path('public/toolchain/index.json').read_text())
packages = {path.name: {'bytes': path.stat().st_size,
                        'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
            for path in sorted(feed.glob('*.nupkg'))}
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
receipt = {
    'schemaVersion': 1,
    'playground': {'commit': head,
                   'tree': subprocess.check_output(['git', 'rev-parse', f'{head}^{{tree}}'], text=True).strip()},
    'netwasmCommit': core,
    'tunitCommit': tunit,
    'candidateVersion': version,
    'workflowRunId': os.environ.get('GITHUB_RUN_ID'),
    'workflowRunAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
    'toolchain': index,
    'packages': packages,
}
Path(output).write_text(json.dumps(receipt, indent=2) + '\n')
PY

echo "PASS: C# 15 candidate browser qualification $version"
