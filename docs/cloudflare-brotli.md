# Serve Brotli-precompressed Wasm and binary bundles

Both Playground and RegexStorm generate `.wasm.br` and `.bin.br` sidecars with
Brotli quality 11 after their final production build. Originals remain available.
Every sidecar is decompressed and checked against its original during the build.
The sidecars are transport files; Playground's toolchain manifest, decoded byte
lengths, asset offsets and SHA-256 hashes remain unchanged.

GitHub Pages hosts both representations. A Cloudflare Worker selects the sidecar
while keeping the browser's existing `.wasm` or `.bin` URL. No loader changes,
storage bindings, API tokens in the Worker, or application-level decoder are needed.

## Set up one Worker

1. In Cloudflare, open **Workers & Pages** and create a Worker named
   `netwasm-brotli` using the Hello World starter.
2. Open **Edit code**, replace the starter with the complete contents of
   [`eng/cloudflare-brotli-worker.mjs`](../eng/cloudflare-brotli-worker.mjs), and
   deploy the Worker. Use an ES module Worker, as in the starter.
3. In the Worker, open **Settings > Domains & Routes > Add > Route**. Select
   the `netwasm.com` zone and add `*.netwasm.com/*`. This is a **Route**, not a
   Custom Domain: GitHub Pages remains the origin. Existing DNS records must stay
   proxied (orange cloud). More specific existing Worker routes take precedence.
   Alternatively, route only `playground.netwasm.com/toolchain/*` and
   `regexstorm.netwasm.com/engine/*` to reduce Worker invocations.
4. Keep the existing Brotli compression rule. The Worker adds `no-transform` to
   precompressed responses so Cloudflare preserves their bytes. Its subrequest
   requests `Accept-Encoding: identity` to avoid an outer compression layer.
5. Purge the cache for the two sites after deployment, especially old binary
   URLs and any `.br` URLs previously cached as missing. No DNS target changes
   are needed.

The Worker passes requests for other extensions through. For Brotli-capable
clients, it tries the same URL with `.br` appended. Missing sidecars fall back to
the original. Errors, redirects, unexpected outer encodings, range requests,
and clients excluding Brotli also use the original delivery path.

Sidecar subrequests are cached separately by their `.br` URLs. SHA-256-named
bundles get a one-year cache lifetime; fixed Wasm URLs retain their origin cache
policy, with a ten-minute edge lifetime. Missing sidecars are not cached by the
Worker. The Worker streams the already-compressed response using
`encodeBody: "manual"`, so it does not spend its CPU allowance compressing assets.

Workers Free allows 100,000 requests per day. A wildcard route invokes the
Worker for all matching requests, even when it passes them through.

## Verify

For RegexStorm:

```sh
curl -sSI -H 'Accept-Encoding: br' \
  https://regexstorm.netwasm.com/engine/RegexStorm-component.core.wasm
```

For Playground, read `toolchain/index.json`, then the corresponding
`toolchain/<id>/asset-manifest.json`, and test one of its `bundles.*.path` URLs.

Expect `Content-Encoding: br`, the original binary MIME type,
`X-NetWasm-Precompressed: br11`, and `Cache-Control` containing `no-transform`.
The diagnostic header distinguishes the stored Brotli-11 sidecar from
Cloudflare's ordinary dynamic Brotli compression. Use `curl --compressed` or
the browser for a decoded-byte/hash check.

Test a client without Brotli support using `Accept-Encoding: gzip`, and test a
range request. Both must retain working original delivery without the diagnostic
header. A binary without a sidecar must also fall back to its original.

## Cloudflare references

- [Routes and same-zone origin fetches](https://developers.cloudflare.com/workers/configuration/routing/routes/)
- [Original visitor Accept-Encoding](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [Serving precompressed response bodies](https://developers.cloudflare.com/workers/runtime-apis/response/)
- [Content compression and no-transform](https://developers.cloudflare.com/speed/optimization/content/compression/)
- [Workers pricing and free allowances](https://developers.cloudflare.com/workers/platform/pricing/)
