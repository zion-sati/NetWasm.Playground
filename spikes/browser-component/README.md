# Browser compile, run and download smoke

This tiny page consumes the verified browser core-link site and public command
WIT. It packages C# into a Preview 2 command component using the pinned browser
wasm-tools binary, validates it, transpiles with the pinned browser jco API and
runs in a fresh guest worker. Compiler and tool workers never execute user PE.

```sh
python3 spikes/browser-component/run.py BASELINE BROWSER_LINK_RUN NEW_RUN --wasmtime PINNED_WASMTIME
python3 spikes/browser-component/run.py unused unused NEW_RUN --verify
```

The guest receives six explicit Preview 2 console/environment/exit/stream
interfaces. Environment and arguments are empty. Isolated `createCli` providers
capture copied output bytes; the tool's private Preview 1 filesystem is separate.
Unknown guest interfaces and Preview 1 core imports are rejected. The actual
generated Hello graph has one JavaScript module and four core binaries, all
resolved from an exact-name owned byte map. Exception-reference bindings are
enabled, as required by this compiler output.

The page shows the actual final component byte count. Download uses the same
validated component bytes transferred to the guest. Compilation failure clears
the previous download; an execution failure keeps the valid compiled artifact.
Stop terminates the guest outside synchronous execution. Each subsequent run
gets a fresh guest worker.

The smoke checks edited output, syntax failure and recovery, nonzero exit,
unhandled-exception traps, an entered infinite loop followed by Stop, and another
successful run. Downloads are replayed with pinned Wasmtime without directory
preopens. Hello packaging must match the verified desktop component exactly.
Receipts bind served assets, source, results, generated graph metadata, downloads
and native results. All servers and browsers close on success or failure.

This is a feasibility harness. Monaco, revision-aware scheduling, complete stage
loading feedback and broader example recipes belong to subsequent slices.
