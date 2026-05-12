const CACHE_NAME = 'ope-assessor-v62';

// Pre-cache the shell so the app still opens when the device is offline. At
// RUNTIME, though, we always prefer the network — see the fetch handler — so a
// stale precache can never be served to an online user. (That "cache-first for
// the root navigation" behaviour was exactly what kept the old code sticking
// around no matter how many times the page was refreshed.)
const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './config.js',
  './style.css',
  './manifest.json',
  './summary-preview.png',
  './ope-icon-192.png',
  './ope-icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) => (name !== CACHE_NAME ? caches.delete(name) : Promise.resolve())));
    await self.clients.claim();
    // Any page that was being controlled by the previous worker is still
    // running the OLD app.js. Reload them onto this worker so they pick up the
    // fresh code immediately instead of needing a manual hard refresh.
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      await Promise.all(clients.map((client) => client.navigate(client.url).catch(() => {})));
    } catch (e) {}
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Never touch the API (the page owns all sync) or the service worker file
  // itself (let the browser's own SW update mechanism handle it).
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;
  if (url.pathname.endsWith('/service-worker.js')) return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(event.request);
      // Keep the offline cache warm with full, same-origin 200s (skip 206 range
      // responses, opaque cross-origin responses, errors).
      if (fresh && fresh.status === 200 && fresh.type === 'basic') {
        const copy = fresh.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
      }
      return fresh;
    } catch (err) {
      // Offline (or the network genuinely failed): serve from cache; for a
      // page navigation fall back to the cached shell so the app still opens.
      const cached = await caches.match(event.request);
      if (cached) return cached;
      if (event.request.mode === 'navigate') {
        const shell = (await caches.match('./index.html')) || (await caches.match('./'));
        if (shell) return shell;
      }
      return Response.error();
    }
  })());
});
