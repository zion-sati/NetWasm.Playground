# NetWasm.Playground

A browser playground for C#: edit a program, compile it with NetWasm, run it
locally and download the resulting WASI component.

The project is in development. The local editor compiles, links and packages
real C# programs in browser workers, then runs the downloaded component in a
separate guest worker.

Editable examples cover Hello World, allocation and guest GC, LINQ, read-only
JSON parsing, source-generated JSON serialization, regular expressions,
constructor-based dependency injection, CRC32 hashing, and TUnit tests.

The Optimization dropdown exposes Binaryen's `-O0` through `-O4`, `-Os` and
`-Oz` settings, plus a None option that skips `wasm-opt` for the quickest
iteration. The page retains each setting's build time and component size for
the current source so the tradeoff can be compared directly. C# remains a
Release compilation for every setting; this control changes the final
WebAssembly optimization pass.

## Local development

Use the pinned Node version in the public NetWasm toolchain manifest.

```sh
npm ci
python3 eng/browser-notices.py --packages <verified-baseline>/packages --packages <verified-generator-host>/packages --packages <verified-tunit-template>/packages --cache <notice-cache> --output <verified-notices>
python3 eng/prepare-web.py --baseline <verified-baseline> --compiler <verified-compiler-host> --tools <verified-tools> --lld <verified-browser-lld> --component <verified-component-probe> --examples <verified-desktop-examples> --generated-json <verified-generated-json> --additional-examples <verified-extra-examples> --tunit <verified-tunit-template> --notices <verified-notices>
npm run dev
```

The asset preparation command checks the existing verification receipts and
stages assets under an ignored, content-addressed `public/toolchain/` directory.
It consumes the public NuGet.org packages and verified inputs produced by the
runners under `eng/` and `spikes/`; it does not read NetWasm source checkouts.
It does not rebuild LLVM. Pages builds install the immutable browser bundle
recorded in `eng/toolchain-release.json`; its archive hash, content identity and
every staged asset are verified before use. A ready manifest identifies the
exact archive the owner publishes as a GitHub release asset before deploying
Pages. Public releases use semantic tags such as `v0.2.0`; the independent
content-addressed toolchain ID continues to identify the exact browser bundle.

```sh
python3 eng/toolchain-release.py install
```

For a static build, run `npm run build`. Set `PLAYGROUND_BASE=/playground/`
when building for a nested path. The default base is `/`.
Build and preview must use the same base. For the local nested-path preview:

```sh
PLAYGROUND_BASE=/playground/ npm run build
PLAYGROUND_BASE=/playground/ npm run preview -- --port 5174
```

Open `http://127.0.0.1:5174/playground/`. Rebuilding with the default base
while this preview is running will break its asset URLs.

Pull requests and pushes to `main` run type checking and build the application
shell without downloading an unpublished toolchain. The Pages workflow is
manual: after the owner publishes the browser bundle asset recorded in
`eng/toolchain-release.json`, it builds with GitHub Pages' configured base path,
runs an actual Chromium compile/run/download smoke test, executes that download
with pinned Wasmtime, and deploys the verified `dist/` artifact. It then repeats
that check against the public Pages URL and retains both evidence sets for 14
days. Configure Pages with **GitHub Actions** as its source; publishing directly
from the repository root does not build this Vite project.

```sh
npm run typecheck
PLAYGROUND_URL=http://127.0.0.1:5173/playground/ PLAYGROUND_EVIDENCE=.cache/ui-smoke node eng/browser-smoke/ui.mjs
```

Compile and Run disable while a job is active; Stop remains available. A
spinner and numbered status show the current operation across eight steps for
Compile + Run, seven for Compile, or one for an unchanged component rerun.
`eng/browser-smoke/progress.mjs` checks these states and Stop recovery.

The smoke expects a running development server with the same base path and
Playwright's Chromium installed. It exercises the actual compiler and guest.

`eng/desktop-examples.py` creates the example inputs using a fresh NuGet.org-only
workspace; `--recipe` selects a particular example. The Regex, DI and hashing
recipes use their public NetWasm library packages. The compiler host includes
the package-owned DI generator through `eng/roslyn-worker.py --di-example`
with that verified workspace; it closes constructor activation at compile time.
`eng/tunit-example.py` downloads the exact released public TUnit template
package from NuGet.org and checks it using ordinary `dotnet test`.
`eng/browser-smoke/examples.mjs` checks the ordinary examples and compares
their outputs with those desktop builds; set `PLAYGROUND_DESKTOP_EXAMPLES` to
the verified workspace alongside the smoke environment variables above.

The JSON generator smoke is `eng/browser-smoke/json-generated.mjs`. The TUnit
smoke is `eng/browser-smoke/tunit.mjs`, with `PLAYGROUND_TUNIT_EXAMPLE` pointing
to its verified native template workspace. Set `PLAYGROUND_COMPARE_DESKTOP_BYTES=1`
for exact ordinary/JSON download comparison when the desktop build uses the same
memory policy; Playground caps guest memory at 256 MiB. TUnit downloads use NetWasm's
asynchronous component contract and require its host.

Build the compiler host with `eng/roslyn-worker.py`, supplying the verified
baseline, an output directory, `--compiler-package-version`, `--json-example`
and `--tunit-example`. The compiler and runtime planner restore only their exact
pinned public NuGet.org packages; source checkouts and local package feeds are
rejected. Only the pinned JSON and TUnit generators run; user code
cannot supply packages or analyzers. Repeat host builds can use
`--reuse-verified-host <previous-host>` for Playwright, while the compiler
packages still restore into a fresh cache. `--skip-trusted-probes` keeps a
focused compiler-only check while retaining verification of generator inputs.

## Limits and browser checks

| Boundary | Limit |
| --- | --- |
| Source | 64 KiB UTF-8 |
| Diagnostics | 128, with a visible limit label |
| Guest console | 64 KiB across stdout and stderr |
| Component / generated execution graph | 4 MiB / 8 MiB |
| Guest defined memories | 256 MiB combined, counted per instance |
| Guest execution, including core start functions | 5 seconds |
| Guest transpilation / compiler and tool stages | 60 / 120 seconds |
| Completed compiler job recycling | At least 512 MiB retained linear memory |

Guest imports are explicit; environment and arguments are empty by default.
Filesystem, sockets and arbitrary JavaScript imports are excluded. Ordinary
programs can read the monotonic clock for elapsed-time and Regex timeout checks.
TUnit alone receives clock subscriptions, polling and reactor capabilities
needed by its asynchronous host.
Workers inherit the page CSP and are terminated on Stop or timeout.

Trusted compiler/tool binaries have finite linear-memory maxima: .NET 2 GiB,
LLD 1 GiB, Binaryen 4 GiB and wasm-tools 512 MiB. These are separate from accepted
input/output bounds and do not establish a browser process RAM quota.

Hello compile/run/download has been tested in Chromium 151, Firefox 153 and
WebKit 26.5; generated JSON, TUnit timers and failure recovery were tested in
Chromium. Safari support remains experimental. Unsupported required features
produce a message before compilation.

Focused development-server checks:

```sh
NETWASM_VERSION="$(python3 -c 'import json; print(json.load(open("eng/upstream-sources.json"))["sources"]["netwasm"]["packageVersion"])')"
PLAYGROUND_URL=http://127.0.0.1:5173/playground/ node eng/browser-smoke/worker-channel.mjs
PLAYGROUND_URL=http://127.0.0.1:5173/playground/ PLAYGROUND_EVIDENCE=<evidence-dir> PLAYGROUND_WASM_TOOLS=<verified-baseline>/packages/netwasm.toolchain/$NETWASM_VERSION/tools/wasm-tools node eng/browser-smoke/reliability.mjs
PLAYGROUND_URL=http://127.0.0.1:5173/playground/ PLAYGROUND_EVIDENCE=<evidence-dir> node eng/browser-smoke/resource.mjs
```

The resource check samples owned Chromium processes with `ps`. For a production
preview, use `eng/browser-smoke/browsers.mjs` with `PLAYGROUND_URL` and
`PLAYGROUND_EVIDENCE`; `PLAYGROUND_BROWSERS` can select `chromium`, `firefox`,
`webkit`, or a comma-separated list. Downloaded ordinary components run with
Wasmtime without preopens.

The bundle contains verified public notices and `notices/origins.json`, produced
from a pinned catalog of source and package inputs, including the upstream
MIT, BSD 2-Clause and BSD 3-Clause texts referenced by its license map.
Keep historical bundles outside
`public/toolchain/` so the static build includes the current version only.

Built on [NetWasm](https://github.com/zion-sati/NetWasm), with examples using
[NetWasm libraries](https://github.com/zion-sati/NetWasm.Libraries) and
[TUnit-NetWasm](https://github.com/zion-sati/TUnit-NetWasm).

[Sponsor development](https://github.com/sponsors/zion-sati)
