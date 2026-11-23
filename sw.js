/* ============================================================================
 * Baukosten Hub – Service Worker (App-Shell-Caching, offlinefähig)  v2
 * Strategie:
 *  - eigene Dateien (index.html, app.js, …) + Navigationen: NETWORK-FIRST
 *    (damit App-Updates sofort greifen), Cache nur als Offline-Fallback
 *  - Fremdanbieter (CDN, Fonts): CACHE-FIRST, damit die App offline startet
 * ========================================================================== */
const CACHE_NAME = 'baukosten-hub-v3';

const APP_SHELL = [
  './',
  'index.html',
  'app.js',
  'manifest.json',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'icon-512-maskable.png',
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js',
  'https://unpkg.com/lucide@0.462.0/dist/umd/lucide.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // API-POSTs immer durchlassen

  const url = new URL(req.url);
  const isOwn = url.origin === location.origin;

  // Navigationen & eigene Dateien: Network-First (Update-freundlich)
  if (req.mode === 'navigate' || isOwn) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => {
            if (cached) return cached;
            if (req.mode === 'navigate') return caches.match('index.html');
            return Response.error();
          })
        )
    );
    return;
  }

  // CDN / Fonts / Icons: Cache-First, dann Netzwerk + cachen
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
