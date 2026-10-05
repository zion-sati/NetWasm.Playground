# Playground 0.6.1 compiler performance

This report qualifies two independent browser-side changes:

- the C# compiler host moves from the Mono interpreter to NativeAOT-LLVM; and
- final `wasm-opt` work moves from the JavaScript CLI to the native Binaryen CLI
  with a bounded SharedArrayBuffer pthread pool.

The compiler remains single-threaded. Browser threads are used only by
`wasm-opt`. Both tools continue to run outside the UI thread.

## Measurement environment

The latency measurements used Chromium 151.0.7922.34 on an Apple M1 Max with 10
logical processors and 64 GiB RAM. Node.js 26.7.0 hosted the local production
site. Assets were already local, so these timings measure decode, initialization,
compilation, optimization and packaging rather than Internet transfer.

Every comparison used the same source and verified the resulting component hash.
The raw receipts are in [`eng/performance/0.6.1`](../eng/performance/0.6.1).

## NativeAOT compiler

FluentValidation's expression-tree example was compiled three times with final
optimization disabled. This isolates the compiler host from `wasm-opt`.

| Measurement, median | 0.6.0 Mono | NativeAOT-LLVM | Improvement |
| --- | ---: | ---: | ---: |
| Complete compile | 41.45 s | 14.59 s | 2.84× |
| Managed compiler stage | 35.15 s | 8.37 s | 4.20× |
| NetWasm compiler substage | 30.21 s | 5.02 s | 6.02× |
| Compiler Wasm linear memory | 689.4 MiB | 380.3 MiB | 44.8% lower |

The complete-compile ranges were 40.47–41.51 seconds for Mono and 14.45–14.66
seconds for NativeAOT-LLVM. All six builds produced the same 4,089,636-byte
component with SHA-256
`a2ba6c8d6175837ddb904fcbaf58fbd9d306904343f6c25314855a6e10b9ef2d`.

For Hello World without final optimization, five cold runs had a 3.56-second
median. Repeating the same source with persisted compiler and runtime caches had
a 1.44-second median. A source-body edit had a 1.43-second median.

NativeAOT-LLVM is pinned to an exact package, source commit, SDK container and
Emscripten toolchain. It is still sourced from the NativeAOT-LLVM runtime-lab
branch, so upgrading that dependency requires a complete compatibility and
performance qualification rather than an automatic version bump.

## Multithreaded native wasm-opt

The same FluentValidation input was compiled three times with `-Oz`. Both paths
used the NativeAOT compiler; only the final optimizer changed.

| Measurement, median | JavaScript CLI | Native pthread CLI | Improvement |
| --- | ---: | ---: | ---: |
| Final `wasm-opt` | 210.06 s | 64.12 s | 3.28× |
| Complete `-Oz` compile | 225.79 s | 79.68 s | 2.83× |
| Tools-host Wasm linear memory | 248.2 MiB | 99.7 MiB | 59.8% lower |

The complete-compile ranges were 221.28–225.85 seconds for the JavaScript CLI
and 78.75–82.15 seconds for the native CLI. All six runs produced the same
3,321,445-byte component with SHA-256
`0c37a8395dfe92649673ddc762a37577d58d231871fcad85f3024b18f0178dae`.

Linear-memory figures do not include browser process overhead or pthread stacks.
The production worker count is `min(8, max(1, hardwareConcurrency - 2))`, leaving
two reported logical processors available to the browser and UI.

The immutable native optimizer release is built and verified by NetWasm's native
tooling pipeline. GitHub-hosted qualification executes real SharedArrayBuffer
pthread work on Ubuntu/Chromium, macOS/WebKit and Windows/Firefox. The Playground
also verifies native optimization, Stop, worker termination, recovery and
byte-identical output through its browser pipeline.

## Toolchain transfer size

Binary bundles and Wasm files were compressed with Brotli quality 11. The full
closure counts every file in the content-addressed toolchain directory, using a
precompressed sidecar when one is served and original bytes for other files. The
application shell is outside this measurement.

| Toolchain closure | Raw bytes | Brotli-11 transfer bytes |
| --- | ---: | ---: |
| 0.6.0 complete toolchain | 154,752,754 | 38,074,938 |
| 0.6.1 initial toolchain | 141,553,301 | 29,592,133 |
| Lazy native optimizer | 10,080,155 | 1,575,620 |
| 0.6.1 complete toolchain after optimizer use | 151,633,456 | 31,167,753 |

The initial transfer is 22.3% smaller than 0.6.0. Even after loading the native
optimizer, the complete closure is 6,907,185 bytes, or 18.1%, smaller. Comparing
the four large bundles alone, Brotli-11 size falls from 35,586,175 to 27,441,356
bytes, a 22.9% reduction.

The optimizer remains a separate lazy closure. Browsers without cross-origin
isolation, SharedArrayBuffer or Wasm shared memory retain the JavaScript optimizer
and display that fallback in the UI.

## Adoption decision

Adopt both changes for 0.6.1. NativeAOT-LLVM materially reduces compiler latency,
memory and compressed transfer size. Native pthread `wasm-opt` removes most of
the expression-tree sample's dominant `-Oz` cost while preserving byte-identical
output. Cross-origin isolation, immutable asset verification, deterministic
output, fallback visibility, cancellation and recovery are release gates.
