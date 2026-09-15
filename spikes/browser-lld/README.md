# Actual browser LLD smoke check

This runner consumes an accepted desktop baseline and the existing browser LLD
build cache. It does not rebuild LLVM or compile on its HTTP server.

```sh
python3 spikes/browser-lld/smoke.py BASELINE BUILD_CACHE NEW_RUN \
  --public-source PUBLIC_NETWASM_CHECKOUT \
  --wasm-ld PINNED_NATIVE_WASM_LD \
  --playwright-cache EXISTING_PLAYWRIGHT_CACHE
python3 spikes/browser-lld/smoke.py BASELINE BUILD_CACHE NEW_RUN --verify
```

`NEW_RUN` must not exist. `EXISTING_PLAYWRIGHT_CACHE` contains `node_modules/`;
both Playwright packages and Node must match the exact public toolchain versions.
The public source checkout may contain unrelated edits: the runner reads only
committed builder/adapter files at `browserLinkerCommit` from
`eng/upstream-sources.json`, verifies their hashes against the build receipt,
and checks that the pinned manifest is accessible from public GitHub.

Before staging, the runner verifies the desktop receipt and built assets. It
copies the six retained runtime archives, preserves every authoritative desktop
flag while normalizing input/output paths, and links with the matched native
LLD. Matching output basenames preserve LLD's custom module-name section.

Chromium links the full archive set through a response file in tool-private
MEMFS. The smoke checks two successful jobs in the same worker, invalid-archive
failure, subsequent success, cancellation after a signal immediately before
the real C ABI call, and success in a fresh worker. Every invocation gets a new
LLD module because the pinned Wasm driver retains LTO state after success.
Transferred output buffers belong to the completed job. Timings separate linker
execution from module initialization; observed linear memory is not process peak.

`browser-test.json` records results, output hashes, browser version, timings,
network requests and errors. `receipt.json` binds the staged source/origin,
assets, captured policy, archives, logs and native/browser outputs. `--verify`
checks the retained evidence without needing the original caches or networking.
Failed runs preserve their logs. All browser/server operations have deadlines
and the runner closes its browser and server on success or failure.

This proves the browser runtime-link boundary. The complete C# application,
merge/optimization, componentization and execution pipeline has its own checks.
