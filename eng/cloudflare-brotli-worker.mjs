function acceptsBrotli(header = '') {
  const encodings = header.split(',').map(value => {
    const [name, ...parameters] = value.trim().toLowerCase().split(';');
    const parameter = parameters.map(value => value.trim()).find(value => value.startsWith('q='));
    const quality = parameter === undefined ? 1 : Number(parameter.slice(2));
    return { name, quality: Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0 };
  });
  return (encodings.find(value => value.name === 'br') ??
    encodings.find(value => value.name === '*'))?.quality > 0;
}

function varyAcceptEncoding(value) {
  if (value?.split(',').some(item => ['*', 'accept-encoding'].includes(item.trim().toLowerCase()))) return value;
  return value ? `${value}, Accept-Encoding` : 'Accept-Encoding';
}

export function isolateResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers,
  });
}

export async function serveBrotli(request, originFetch = fetch) {
  const url = new URL(request.url);
  const extension = /\.(wasm|bin)$/.exec(url.pathname)?.[1];
  // Cloudflare can rewrite Accept-Encoding. Negotiate against the visitor's original header.
  const accepted = request.cf?.clientAcceptEncoding ?? request.headers.get('Accept-Encoding') ?? '';
  if (!extension || !['GET', 'HEAD'].includes(request.method) ||
      request.headers.has('Range') || request.headers.has('If-Range') ||
      request.headers.has('Authorization') || !acceptsBrotli(accepted))
    return originFetch(request);

  const immutable = /\.[a-f0-9]{64}\.(?:wasm|bin)$/.test(url.pathname);
  url.pathname += '.br';
  const originHeaders = new Headers(request.headers);
  // The sidecar is already Brotli. Request its bytes without an outer HTTP encoding.
  originHeaders.set('Accept-Encoding', 'identity');
  const sidecar = await originFetch(new Request(url, {
    method: request.method, headers: originHeaders, redirect: 'manual',
  }), { cf: {
    cacheEverything: true,
    cacheTtlByStatus: { '200': immutable ? 31536000 : 600, '404': 0, '500-599': 0 },
  } });
  if (sidecar.status === 404) {
    await sidecar.body?.cancel();
    return originFetch(request);
  }
  // Never relabel an error page, redirect, partial body, or outer encoding as Brotli.
  if (![200, 304].includes(sidecar.status) || sidecar.headers.has('Content-Encoding')) {
    await sidecar.body?.cancel();
    return originFetch(request);
  }

  const headers = new Headers(sidecar.headers);
  headers.set('Content-Type', extension === 'wasm' ? 'application/wasm' : 'application/octet-stream');
  headers.set('Content-Encoding', 'br');
  headers.set('Vary', varyAcceptEncoding(headers.get('Vary')));
  headers.delete('Accept-Ranges');
  headers.delete('Content-Range');
  const cacheControl = immutable ? 'public, max-age=31536000, immutable' :
    headers.get('Cache-Control') || 'public, max-age=600';
  headers.set('Cache-Control', /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(cacheControl) ?
    cacheControl : `${cacheControl}, no-transform`);
  headers.set('X-NetWasm-Precompressed', 'br11');
  // Stream the existing compressed body. Do not buffer or recompress it in the Worker.
  return new Response(sidecar.body, {
    status: sidecar.status, statusText: sidecar.statusText, headers, encodeBody: 'manual',
  });
}

export default { fetch: async request => isolateResponse(await serveBrotli(request)) };
