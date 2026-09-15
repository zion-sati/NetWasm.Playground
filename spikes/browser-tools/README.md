# Trusted browser tool feasibility probe

This small harness runs the released NetWasm.Toolchain 0.1.0 wasm-tools 1.256.0,
Binaryen 132 merge/opt CLIs, and jco 1.28.1 browser API in a real Chromium worker.
It serves static assets; all tool operations execute in the browser. It needs an
accepted desktop baseline and the pinned Playwright 1.62.1 installation from the
Roslyn worker verification. No native tool builds are required.

```sh
python3 spikes/browser-tools/prepare.py BASELINE RUN
node spikes/browser-tools/test.cjs PLAYWRIGHT_MODULE RUN/site RUN/worker-test.json
python3 spikes/browser-tools/verify.py RUN --record
python3 spikes/browser-tools/verify.py RUN
```

`BASELINE` is the verified directory produced by `eng/desktop-baseline.py`.
`RUN` must be an owned ignored cache directory. `PLAYWRIGHT_MODULE` is an absolute
path to the installed `playwright` module. Install its pinned Chromium beforehand
if it is not already present. The test owns and closes its HTTP server/browser,
including on failure. Preparation verifies the baseline receipt, requires the
published manifest/closure hashes for all consumed packaged assets, and binds the
package archive, manifest and baseline receipt hashes. Added public npm adapters
are exact pins recorded in the run's package lock.

The probe tests actual core parsing and validation, WIT embedding, component
creation/validation/WIT extraction, cross-module import resolution by wasm-merge,
wasm-opt `-Oz`, and explicit jco browser instantiation. The optimized module
returns 42 and 43 with no imports; the generated component returns 42. Malformed
inputs fail with no prior output and subsequent requests recover in the same
worker. Each wasm-tools/Binaryen operation uses a fresh tool instance; jco reuses
its healthy initialized browser API.

## Browser adaptations

The exact packaged wasm-tools Wasm uses trusted, tool-private Preview 1 WASI over
`@bjorn3/browser_wasi_shim` 0.4.2 in-memory files. No guest receives this adapter.
The worker verifies all shim modules before importing its module graph.

The packaged Binaryen CLIs contain MEMFS but forcibly install NODERAWFS and
unconditionally require `node:path`. The raw bootstrap fails in a browser.
The probe verifies the unchanged asset first, replaces its path binding with
public `path-browserify` 1.0.1, removes only the NODERAWFS installation block, and
exposes the actual lexical FS/callMain through a closure. The embedded tool Wasm
and CLI operations remain intact. This narrow adaptation proves the tool seam;
a maintained browser adapter belongs in public NetWasm infrastructure. Production
CSP compatibility with this function constructor has not been assessed.

jco's published browser module and component-bindgen binding map bare package
specifiers to staged browser URLs. The original and staged hashes record that
mapping. The complete staged module/Wasm graph is verified before importing it.
The fixture produces one JS module plus its core Wasm; Blob URLs are revoked
after explicit instantiation with an empty component import map. Resolving general
generated module graphs and supplying a reviewed guest Preview 2 policy remain
outside this tool-hosting probe.

## Limits and evidence

The worker caps input bytes at 1 MiB and console bytes at 64 KiB, rejects virtual
path traversal, and the page terminates operations after 30 seconds. Focused
input/path/console denials recover. A separate short-deadline test terminates a
real large synchronous parse after the worker signals immediately before entering
wasm-tools, then validates input successfully in a new worker. Original tool
memory maxima remain unchanged: reported linear-memory bytes are observations,
not a proven memory budget or process peak. Only a busy rejection is implemented;
editor scheduling and coalescing belong to later integration.

`inputs.json`, `worker-test.json`, exact resulting fixture files, staged asset
hashes, package lock, and `receipt.json` retain provenance and outcomes. The test
checks that browser requests are asset GETs with no request bodies. Raw asset
sizes exclude HTTP compression and are separate from guest component sizes.
The receipt also binds source snapshots, making cleanup/review reproducible.
This probe does not demonstrate LLD, full runtime linking, actual C# guest
execution, Firefox/WebKit support, or final NetWasm Release artifact equality.
