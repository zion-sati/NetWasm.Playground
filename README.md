# NetWasm.Playground

A browser playground for C#: edit a program, compile it with NetWasm, run it
locally and download the resulting WASI component.

The project is in development. The local editor compiles, links and packages
real C# programs in browser workers, then runs the downloaded component in a
separate guest worker.

Editable examples cover Hello World, allocation and guest GC, LINQ, and
read-only JSON parsing.

## Local development

Use the pinned Node version in the public NetWasm toolchain manifest.

```sh
npm ci
python3 eng/prepare-web.py --baseline <verified-baseline> --compiler <verified-compiler-host> --tools <verified-tools> --lld <verified-browser-lld> --component <verified-component-probe> --examples <verified-desktop-examples> --source <public-netwasm-checkout>
npm run dev
```

The asset preparation command checks the existing verification receipts and
stages assets under an ignored, content-addressed `public/toolchain/` directory.
It consumes the public inputs produced by the runners under `eng/` and `spikes/`.
It does not rebuild LLVM. A reusable toolchain release bundle is still planned.

For a static build, run `npm run build`. Set `PLAYGROUND_BASE=/playground/`
when building for a nested path. The default base is `/`.

```sh
npm run typecheck
PLAYGROUND_URL=http://127.0.0.1:5173/playground/ PLAYGROUND_EVIDENCE=.cache/ui-smoke node eng/browser-smoke/ui.mjs
```

The smoke expects a running development server with the same base path and
Playwright's Chromium installed. It exercises the actual compiler and guest.

`eng/desktop-examples.py` creates the example inputs using a fresh NuGet.org-only
workspace. `eng/browser-smoke/examples.mjs` checks all four examples and compares
their downloads with those desktop builds; set `PLAYGROUND_DESKTOP_EXAMPLES` to
the verified workspace alongside the smoke environment variables above.

Built on [NetWasm](https://github.com/zion-sati/NetWasm), with examples using
[NetWasm libraries](https://github.com/zion-sati/NetWasm.Libraries) and
[TUnit-NetWasm](https://github.com/zion-sati/TUnit-NetWasm).

[Sponsor development](https://github.com/sponsors/zion-sati)
