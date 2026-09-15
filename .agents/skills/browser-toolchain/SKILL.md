---
name: browser-toolchain
description: Implement or debug NetWasm.Playground browser compilation, runtime linking, componentization, worker execution and reproducible toolchain asset delivery using public NetWasm sources.
---

# Browser toolchain

Read the current external plan and pinned public sources in
`eng/upstream-sources.json`. Reuse the public NetWasm compiler and Hosting policy.

## Preserve the real pipeline

Roslyn compiles source to managed PE bytes. NetWasm reads those bytes and emits
an application core Wasm module with imports, static layout and runtime features.
LLD links selected native runtime inputs using NetWasm's runtime link plan.
Binaryen merges application, runtime and generated adapter modules, then applies
the desktop Release optimization policy. wasm-tools embeds WIT, constructs and
validates the Preview 2 component. jco supplies browser execution modules.

Do not invent relocatable application objects: inspect the current public
compiler result before defining the wire contract. Keep static-data offsets,
runtime export selection, entry-point adapters, WIT and ABI versions together.
Never replace per-program runtime selection with a universal retained runtime.

Public source anchors in `zion-sati/NetWasm`:

- `src/NetWasm.Compiler/CompilerOptions.cs`: compiler request/result.
- `src/NetWasm.Compiler.Metadata/IManagedAssemblyImageReader.cs`: byte input seam.
- `src/NetWasm.Runtime.Pack/Materialization/RuntimeLinkArgumentBuilder.cs`: LLD policy.
- `src/NetWasm.Compiler.ComponentModel/ComponentCoreModuleLinkExecution.cs`:
  adapters, merge and optimization.
- `src/NetWasm.Compiler.ComponentModel/ComponentPackageExecution.cs`: packaging.
- `src/NetWasm.Hosting/JavaScript/`: reusable execution contracts and providers.
- `src/NetWasm.Toolchain/JavaScript/run-wasm-tools.mjs`: current Node tool host.
- `eng/toolchain.json`: authoritative toolchain versions.

## Distinguish the compiler host from the program

The compiler worker runs Roslyn and NetWasm on the full .NET browser runtime.
An interpreter-first spike is acceptable; assess AOT for warm speed and cold
download cost after it works. User PE bytes are compiler input, never dynamically
loaded or executed as desktop .NET assemblies. Keep the compiler's own desktop
dependencies separate from NetWasm target reference/implementation assemblies.
Only preapproved, pinned source generators run inside the compiler host.

No processes or ambient host files belong in the browser call path. Virtual
paths over a byte map or tool-private MEMFS are acceptable. Reuse policies with
browser implementations of their I/O boundaries; avoid cloning those policies.

The existing wasm-tools tool binary targets WASI Preview 1. Give that trusted
tool a private in-memory Preview 1 adapter; generated programs remain Preview 2.
Binaryen's actual wasm-merge and wasm-opt availability is a feasibility item;
the npm library alone is not proof that both CLI paths work in a worker.

## Workers and capabilities

Use request IDs and immutable input snapshots. Keep only one active compilation;
coalesce queued edits and ignore stale replies. The UI owns timeout/cancellation
and can terminate workers blocked inside synchronous Wasm.

Compilation may reuse a healthy worker; execution gets a fresh worker per run.
Discard a linker instance on failure or when LLD reports it cannot run again.
Release Blob URLs, MEMFS files and transferred buffers when their consumer ends.

A worker has browser network/storage APIs; it is not a capability sandbox by
itself. User Wasm receives explicit imports only: bounded console output, empty
environment/arguments by default, and clocks/randomness only as required. Exclude
arbitrary JS imports, callbacks, fetch, storage, filesystem, sockets and DOM.
Tool asset fetching and virtual compiler files must never become guest powers.
Validate the component, import policy and resource limits before execution.

## Browser and distribution proof

Pin full public source commits and exact published packages. Pin tool assets,
bootstrap JS, generators, WIT, runtime inputs and references by SHA-256. Verify
files before importing code; a hash manifest is useful only when its origin is
trusted. Measure final component bytes separately from compiler download bytes.

Use jco's browser API and explicit instantiation/import mapping. Resolve the
entire generated module graph; browser Blob URLs cannot resolve arbitrary
relative imports without mapping. Reuse the NetWasm Hosting abstractions where
they fit. Do not invoke Node CLI modules in a browser bundle.

Check actual required Wasm features in Chromium, then Firefox, then WebKit.
Single-threaded execution must not require SharedArrayBuffer or COOP/COEP.
Pin the .NET workload's compatible Emscripten separately from NetWasm runtime
and browser LLD build prerequisites when those versions differ.
