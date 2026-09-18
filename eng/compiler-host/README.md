# NetWasm browser compiler feasibility harness

Run from the repository root with a verified public desktop baseline and the
exact package version pinned in `eng/upstream-sources.json`:

```sh
python3 eng/roslyn-worker.py .cache/desktop-baseline .cache/netwasm-worker \
  --compiler-package-version <public-version> \
  --json-example <verified-json-example> \
  --tunit-example <verified-tunit-example>
```

The run directory must be new. The runner restores the public browser compiler
and runtime planner packages with a fresh NuGet.org-only cache and the pinned
.NET browser host.
Roslyn emits a managed PE against NetWasm.Ref. NetWasm compiles that PE using the
separate implementation CoreLib and explicit packaged compiler WIT world.
User assemblies are parsed and compiled; they are never loaded into the host.

The fixed Hello recipe uses protocol schema 1. Compiler results contain application
bytes, static-data end, runtime features, import signatures, interop metadata and
entry identity and parameter/return/completion ABI. Shared public metadata policy
selects the managed entry from PE bytes. The public C# runtime planner returns
the complete linker arguments, virtual asset paths and SHA-256 hashes using each
application's static-data end. Compiler failures include a stage/code and bounded messages.
This feasibility bridge uses base64 JSON; the final UI worker protocol will transfer
owned buffers. The public component core-link plan also supplies adapter WAT,
merge arguments, export-pruning policy and Release optimization arguments.
[The browser link smoke](../browser-link/README.md) executes that plan; component
packaging and guest execution remain subsequent slices.

Chromium exercises edited source, malformed source and recovery in one worker,
then the editable page. The receipt verifies actual emitted modules and compares
Hello's application bytes, static-data end and interop manifest with desktop.
It also compares the browser runtime plan against the captured desktop linker
arguments and archive hashes, after replacing only input and output paths.
It binds served files, sources, managed/application outputs, packages and logs.
Compile timings and exposed host linear-memory size are recorded in results;
linear memory is not total browser process memory. Verify retained evidence with
the command above plus `--verify`. The local server and browser close on failure.
