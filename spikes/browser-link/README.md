# Browser C# core-link smoke

The harness consumes verified desktop, interpreter compiler, browser-tool and
browser-LLD receipts. All compilation and tool execution happens in browser
workers. The local server serves static inputs and records verification output.

```sh
python3 spikes/browser-link/run.py .cache/desktop-baseline .cache/compiler-core-plan .cache/browser-tools .cache/browser-lld .cache/browser-link
```

The compiler fixture must use the published `browserCompilerCommit` and expose
the public C# component core-link plan. The runner verifies all input receipts,
stages the six public runtime archives and checks their manifest hashes. The
browser verifies archive hashes again before calling LLD with the C# runtime
plan. It parses the C# adapter WAT, runs the authoritative five-module merge,
applies the public C# export-pruning policy, runs Release optimization and
validates the resulting core module with the actual pinned wasm-tools binary.
The tool bridge replaces only virtual path arguments with isolated MEMFS names.

Edited Hello source must produce different linked modules. Syntax errors and an
invalid archive produce no linked output; subsequent compilation and linking
recover in the same workers. LLD uses a fresh module per call because the pinned
driver retains bitcode LTO state. The separate LLD smoke checks cancellation.

The receipt binds served assets, source snapshots, input receipt identities,
stage results and actual linked outputs. Hello's executable core sections must
equal the verified desktop core; custom sections contain packaging metadata.
Append `--verify` to check retained
evidence. Timings and exposed linear memory are observations; they do not measure
total process memory. Component packaging, guest Preview 2 imports, execution and
download are subsequent slices. This spike still uses the feasibility JSON
bridge; the application protocol will transfer owned buffers.
