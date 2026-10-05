const isolationHeaders = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
};
const nullBodyStatuses = new Set([204, 205, 304]);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin ||
      event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.type === 'opaque' || response.type === 'opaqueredirect') return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(isolationHeaders)) headers.set(name, value);
    const body = event.request.method === 'HEAD' || nullBodyStatuses.has(response.status) ? null : response.body;
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }));
});
