# Browser compiler program

`Program.cs` is the compiler program the Playground runs in the browser: it
compiles the editor's C# with Roslyn, then compiles the result to WebAssembly
with the pinned NetWasm browser compiler package. The
[NativeAOT-LLVM host](../nativeaot-compiler-host/README.md) links it, and
`eng/build-nativeaot-compiler.py` builds that host from the pinned public
packages.
