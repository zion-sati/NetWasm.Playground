# NativeAOT-LLVM compiler host experiment

This host compiles the same browser compiler program as the released Mono host through a small UTF-8 JSON C ABI. It is an experimental performance candidate and is not selected by the production playground.

The current NativeAOT-LLVM toolchain publishes only from Linux x64. Build it from macOS through the pinned container and Emscripten toolchain:

```sh
python3 eng/build-nativeaot-compiler.py \
  --emsdk /path/to/emsdk-3.1.56-x64 \
  --output .cache/performance/compiler-nativeaot
```

The builder pins the NativeAOT-LLVM package, SDK container, Emscripten version, compiler packages, and trusted generators in `eng/upstream-sources.json` and writes hashes for every output.
