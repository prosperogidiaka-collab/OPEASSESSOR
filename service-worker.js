const CACHE_NAME = 'ope-assessor-v30';
const urlsToCache = [
  './',
  './index.html',
  './config.js',
  './app.js',
  './style.css',
  './manifest.json',
  './summary-preview.png',
  'https://cdn.tailwindcss.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(urlsToCache).catch(() => {
        // Ignore errors for external resources
        return Promise.resolve();
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(event.request.url);
  const isApiRequest = requestUrl.origin === self.location.origin && requestUrl.pathname.startsWith('/api/');
  const isAppShellAsset = requestUrl.origin === self.location.origin && (
    requestUrl.pathname.endsWith('/config.js') ||
    requestUrl.pathname.endsWith('/app.js') ||
    requestUrl.pathname.endsWith('/style.css') ||
    requestUrl.pathname.endsWith('/index.html')
  );

  if (isApiRequest) {
    event.respondWith(
      fetch(event.request).catch(() => new Response(JSON.stringify({
        error: 'Network unavailable'
      }), {
        status: 503,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      }))
    );
    return;
  }

  if (isAppShellAsset) {
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic' && !requestUrl.pathname.startsWith('/api/')) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
        }
        return response;
      }).catch(() => caches.match(event.request).then((response) => response || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) {
        return response;
      }
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return response;
      }).catch(() => {
        return caches.match('./index.html');
      });
    })
  );
});
