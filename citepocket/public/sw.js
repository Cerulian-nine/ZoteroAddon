/* CitePocket service worker.
 *
 * Strategy:
 *  - Precache the app shell on install.
 *  - Same-origin GET requests: cache-first with background revalidation
 *    (Vite emits content-hashed assets, so cached copies are always valid;
 *    the shell HTML revalidates so deploys are picked up).
 *  - api.zotero.org: never intercepted — library data is cached in
 *    IndexedDB by the app, not here.
 *
 * Hand-written rather than generated so the whole offline story fits in
 * one readable file.
 */

const CACHE = 'citepocket-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Leave the Zotero API (and any other cross-origin request) alone.
  if (url.origin !== self.location.origin) return;

  // Navigations: serve the cached shell, refresh it in the background.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((cached) => {
        const network = fetch(request)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put('./index.html', copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Static assets: cache-first, populate on first fetch.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      });
    })
  );
});
