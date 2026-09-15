# Public desktop comparison fixture

Activate Emscripten at the version in the pinned public NetWasm tool manifest.
Install that manifest's .NET SDK and Wasmtime versions, then run:

```sh
python3 eng/desktop-baseline.py .cache/desktop-baseline --wasm-ld "$EMSDK/upstream/bin/wasm-ld"
python3 eng/desktop-baseline.py .cache/desktop-baseline --verify
```

The directory must be new. The runner downloads the released application
template, pins its SDK, and restores into a fresh package cache using NuGet.org
alone. Verification disables .NET's implicit offline library feed and fallback
folders. Contributor NuGet settings remain ordinary.

The real Release publish retains managed PE, application core module, runtime
layout, interop/compiler/component manifests and the final Preview 2 component.
Transparent wrappers capture the upstream-selected LLD inputs and arguments,
Binaryen merge inputs (including generated adapters), and optimization input and
output. A temporary MSBuild target replaces only tool paths after SDK tool
resolution; it does not maintain separate link or package policy. Binaryen's
published CLI files run through Node, so their wrapper delegates to the same
Python capture adapter.

`publish.log` includes the Roslyn response and packaging task inputs.
`commands.json` records commands, outcomes and timings; `receipt.json` binds
package archives, retained application artifacts, tool captures and exact final
component bytes by SHA-256. The component must print `42` under pinned Wasmtime.
All captures stay ignored because they contain machine-specific paths.

Retain one verified run and its package cache for browser comparison. Delete
failed disposable runs at the milestone boundary. This fixture proves desktop
inputs and behavior; browser compilation remains a separate feasibility gate.
