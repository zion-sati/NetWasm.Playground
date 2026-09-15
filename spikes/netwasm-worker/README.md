# NetWasm browser compiler feasibility harness

Run from the repository root with a verified public desktop baseline and the
published checkout pinned by `browserCompilerCommit` in `eng/upstream-sources.json`:

```sh
python3 eng/roslyn-worker.py .cache/desktop-baseline .cache/netwasm-worker --compiler-source .cache/public-netwasm
```

The run directory must be new. The runner builds the public browser adapter
from source with a fresh NuGet.org-only cache and the pinned .NET browser host.
Roslyn emits a managed PE against NetWasm.Ref. NetWasm compiles that PE using the
separate implementation CoreLib and explicit packaged compiler WIT world.
User assemblies are parsed and compiled; they are never loaded into the host.

The fixed Hello recipe uses protocol schema 1. Compiler results contain application
bytes, static-data end, runtime features, import signatures, interop metadata and
entry identity. Compiler failures include a stage/code and bounded messages.
This feasibility bridge uses base64 JSON; the final UI worker protocol will transfer
owned buffers. Runtime linking and component execution are later slices.

Chromium exercises edited source, malformed source and recovery in one worker,
then the editable page. The receipt verifies actual emitted modules and compares
Hello's application bytes, static-data end and interop manifest with desktop.
It binds served files, sources, managed/application outputs, packages and logs.
Compile timings and exposed host linear-memory size are recorded in results;
linear memory is not total browser process memory. Verify retained evidence with
the command above plus `--verify`. The local server and browser close on failure.
