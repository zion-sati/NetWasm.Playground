# NativeAOT-LLVM compiler host

This host compiles the browser compiler program through a small UTF-8 JSON C ABI.
The Playground release pipeline builds it from the pinned NativeAOT-LLVM,
Emscripten, SDK-container, compiler-package, and generator inputs.

The current NativeAOT-LLVM toolchain publishes only from Linux x64. Build it
from macOS through the pinned container and Emscripten toolchain:

```sh
python3 eng/build-nativeaot-compiler.py \
  --emsdk /path/to/emsdk-3.1.56-x64 \
  --output .cache/performance/compiler-nativeaot
```

The builder pins the NativeAOT-LLVM package, SDK container, Emscripten version, compiler packages, and trusted generators in `eng/upstream-sources.json` and writes hashes for every output.
