// sw.js: makes the website an installable app (PWA) that opens from this device.
//
// firefox.html is one 77 MB file. This service worker keeps it, and the app's few small
// files, in the browser's Cache Storage, so opening the app reads it from disk instead of
// the network, and works offline. Each opening also asks the site whether firefox.html
// changed, with a conditional request: an unchanged file costs a "304 Not Modified" and no
// download. A new build downloads in the background and is used from the next opening on
// (the page offers to reload for it). Responses are stored with their headers, so the
// COOP/COEP headers that make the page multi-threaded come along. firefox.html registers
// this only when opened from a website; a file opened from disk has no service worker.

const CACHE = 'firefox-html-app-v1';
const APP = 'firefox.html';
const FILES = ['./', APP, 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];
const url = (file) => new URL(file, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // A new version of this file (a new CACHE name) keeps the firefox.html already on the
    // device; the next opening's update check downloads a newer one if the site has it.
    // On the first visit firefox.html normally comes from the browser's HTTP cache here,
    // rather than being downloaded a second time.
    const kept = await caches.match(url(APP));
    await cache.addAll(kept ? FILES.filter((file) => file !== APP) : FILES);
    if (kept) await cache.put(url(APP), kept);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('firefox-html-app-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const { origin, pathname } = new URL(request.url);
  const key = origin + pathname; // the same file whatever its query (?env.NAME=...)
  if (!FILES.some((file) => url(file) === key)) return; // everything else: as without this
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key);
    if (cached) {
      if (key === url(APP)) event.waitUntil(checkForUpdate(cache, cached));
      return cached;
    }
    const response = await fetch(request);
    if (response.ok) event.waitUntil(cache.put(key, response.clone()));
    return response;
  })());
});

// Downloads a new firefox.html if the site has one; one check at a time.
let checking = null;
const strong = (etag) => (etag || '').replace(/^W\//, '');
function checkForUpdate(cache, cached) {
  checking ??= (async () => {
    const etag = cached.headers.get('etag');
    const modified = cached.headers.get('last-modified');
    if (!etag && !modified) return; // no cheap way to ask: don't download 77 MB every time
    const headers = {};
    if (etag) headers['If-None-Match'] = etag;
    if (modified) headers['If-Modified-Since'] = modified;
    const abort = new AbortController();
    const response = await fetch(url(APP), { cache: 'no-store', headers, signal: abort.signal });
    // Unchanged (304), unavailable, or a server that answers 200 anyway with the same file:
    // keep the copy on the device, and stop before the body downloads.
    const unchanged = response.status === 304 || !response.ok ||
      (etag && strong(response.headers.get('etag')) === strong(etag)) ||
      (!etag && response.headers.get('last-modified') === modified);
    if (unchanged) {
      abort.abort();
      return;
    }
    await cache.put(url(APP), response);
    for (const client of await self.clients.matchAll()) client.postMessage({ type: 'firefox-html-update' });
  })().catch(() => {}).finally(() => { checking = null; });
  return checking;
}
