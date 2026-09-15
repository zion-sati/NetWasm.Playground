# Trusted TUnit generator browser probe

Run from the repository root, supplying the verified desktop baseline, staged
public TUnit archives/extractions, and the accepted reusable Roslyn worker run:

```sh
python3 spikes/generator-worker/run-probe.py BASELINE TUNIT_PACKAGES ROSLYN_RUN NEW_RUN
```

The host uses the pinned full .NET browser runtime and SDK Roslyn. It statically
references only the approved Core generator assembly from the public
`NetWasm.TUnit.Core` package's `roslyn4.14` folder. All four packaged Core
generators execute through the ordinary Roslyn driver with the package's normal
`ClosedWorldCatalog` analyzer configuration. Guest CoreLib/TUnit assemblies are
metadata references; user PE bytes are retained and never executed in the host.

The browser checks a one-case catalog, an edited two-case catalog, a syntax
failure, an actual `TUNIT1001` generator rejection, and recovery in the same
worker. Editing a declaration through the page also changes generated output.
No CodeFix assembly, arbitrary analyzer, or user DLL is loaded for execution.
The bootstrap verifies the generated served asset manifest before importing
the .NET host. Local trusted runner inputs establish that manifest's origin.

Generated sources, hashes/counts, producer diagnostics, timings, host closure,
managed outputs, and a verifiable receipt remain in the ignored run directory.
The server and Chromium close on success or failure. No LLVM/AOT build runs.
This proves generator hosting; it does not execute the generated guest tests.
Append `--verify` to the same command to verify retained evidence later.
