LZ4 1.10.0 WebAssembly sample

liblz4.a was built from the unmodified upstream LZ4 1.10.0 source at commit
ebb370ca83af193212df4dcbadcc5d87bc0de2f0 with Emscripten 6.0.7:

  emcc -O2 -DNDEBUG -I lib -c lib/lz4.c -o lz4.o
  emar rcs liblz4.a lz4.o

Archive SHA-256:
0e89bbc78fb9e08010ebc7bf64707f22f9546f69322dad494c2f7b4b7f0ced84

The upstream BSD-2-Clause license is in LZ4-LICENSE.txt.
