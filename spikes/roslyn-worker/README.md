# Roslyn browser worker feasibility harness

From the repository root, run against a verified public desktop baseline:

```sh
python3 eng/roslyn-worker.py .cache/desktop-baseline .cache/roslyn-worker
```

The run directory must be new. The runner selects the desktop fixture's .NET SDK
and uses its publicly distributed Roslyn assemblies. Guest target references
come from NetWasm.Ref, separately from the full .NET browser compiler host.
The guest's assembly name, source path, generated support-file paths, symbols,
nullable setting and Release optimization match the desktop fixture.

The untrimmed interpreter host performs real C# compilation in a module worker.
Its runtime and matching browser SDK pack are pinned in `eng/browser-host.json`.
.NET 10.0.12 includes the [Mono interpreter barrier intrinsic fix](https://github.com/dotnet/runtime/commit/319ee4785c9e5cd21df2289854dc43788a7d9242)
needed by this Roslyn path. Earlier installed packs terminated the worker with
a stack overflow. The runner selects the supported patch through
`RuntimeFrameworkVersion` during restore and publish.
Roslyn concurrency is disabled because the single-threaded browser runtime
cannot wait on monitors. Compilation output is parsed or retained as PE bytes;
it is never loaded for execution into the host. This harness does not execute
the generated program or claim a finished NetWasm pipeline.

A headless Chromium test compiles the baseline, edited source, a syntax error
and another valid input in the same worker. It checks distinct PE hashes,
source diagnostic positions, absence of stale output after failure and recovery.
`inputs.json`, `worker-test.json`, managed PEs and build logs stay in the ignored
run directory. The local server and browser close after the test. Playwright is
installed at the public toolchain pin; its corresponding Chromium must be
installed beforehand (`npx playwright install chromium` in the run directory).
Asset compression is disabled for this feasibility build. The receipt binds
served assets, compiler inputs and sources, packages, results and managed output;
check it later with the same command plus `--verify`.

This small spike intentionally has a fixed recipe and a JSON bridge. Replace
it with reusable public NetWasm browser compiler infrastructure when testing
NetWasm itself. PE byte identity is not asserted: desktop embeds debug/source
metadata; application module semantics and imports are the later comparison.
