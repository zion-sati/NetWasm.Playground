#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
browser="${PLAYGROUND_BROWSER:?PLAYGROUND_BROWSER is required}"
evidence="${PLAYGROUND_EVIDENCE:?PLAYGROUND_EVIDENCE is required}"
: "${PLAYGROUND_URL:?PLAYGROUND_URL is required}"

mkdir -p "$evidence"
cd "$root"

assert_identity() {
  node eng/browser-smoke/site-identity-check.mjs 2>&1 | tee -a "$evidence/site-identity.log"
}

run_step() {
  local name="$1"
  shift
  "$@" 2>&1 | tee "$evidence/$name.log"
  assert_identity
}

assert_identity
run_step deployment env PLAYGROUND_EVIDENCE="$evidence/deployment" \
  node eng/browser-smoke/deployment.mjs
run_step csharp15 env PLAYGROUND_BROWSERS="$browser" PLAYGROUND_CSHARP15_OPTIMIZATION=none \
  node eng/browser-smoke/csharp15-runtime.mjs
run_step wasi env PLAYGROUND_BROWSERS="$browser" node eng/browser-smoke/wasi-examples.mjs
run_step tunit-failure env PLAYGROUND_EVIDENCE="$evidence/tunit-failure" \
  node eng/browser-smoke/tunit-failure.mjs
run_step lifecycle env PLAYGROUND_EVIDENCE="$evidence/lifecycle" \
  node eng/browser-smoke/compiler-lifecycle.mjs
run_step frontend-cache node eng/browser-smoke/frontend-cache-persistence.mjs
run_step back-navigation node eng/browser-smoke/back-navigation.mjs
run_step resource env PLAYGROUND_EVIDENCE="$evidence/resource" node eng/browser-smoke/resource.mjs
