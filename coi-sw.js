// coi-sw.js: lets firefox.html run multi-threaded on a website that can't send headers,
// such as GitHub Pages. A page may share memory with Web Workers only when it is
// cross-origin isolated, which takes two response headers (COOP and COEP). Put this file
// next to firefox.html: the page registers it and reloads once, and from then on this
// service worker adds the headers to the site's responses. Requests pass through to the
// network unchanged otherwise (nothing is cached here), so updates show up as usual.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // A service worker may not answer these itself (Chrome); leave them to the browser.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  event.respondWith(fetch(request).then((response) => {
    if (response.status === 0) return response; // opaque or redirect: headers are read-only
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }));
});
