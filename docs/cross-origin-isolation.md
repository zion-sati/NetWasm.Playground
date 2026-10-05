# Cross-origin isolation

The native browser `wasm-opt` tool uses WebAssembly shared memory and pthreads.
The Playground enables it only when `crossOriginIsolated`, `SharedArrayBuffer` and
a shared `WebAssembly.Memory` are all available.

Production responses carry these headers:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The Cloudflare Worker adds them to direct responses. Static hosting also includes
a same-origin service worker for hosts that cannot set response headers. On its
first visit the service worker installs, claims its scope and reloads the page at
most once. A session marker prevents a reload loop and is removed after isolation
is established. Later visits and service-worker updates do not require another
reload when the page is already isolated.

The service worker does not cache application or toolchain files. It forwards
same-origin requests to the network and adds the isolation headers to successful
non-opaque responses. Offline availability therefore depends on the browser HTTP
cache and is not a supported Playground feature. Cross-origin requests are never
proxied or rewritten.

If registration, control, shared-memory construction, pthread startup or native
optimizer asset verification fails, compilation remains available through the
single-threaded JavaScript optimizer. The result panel reports:

```text
Optimizer: JavaScript fallback · native optimizer unavailable
```

The browser qualification blocks service workers deliberately to verify this
fallback, in addition to testing native execution, Stop and worker recovery.
