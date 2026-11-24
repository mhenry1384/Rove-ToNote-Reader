// Service worker: caches the app shell so the app opens offline.
// The open document itself is cached by app.js in IndexedDB.
// The cache name comes from version.js, so bumping the version clears old caches.
importScripts('version.js');
const CACHE = 'rove-tonote-reader-v' + self.APP_VERSION;
const SHELL = [
  './',
  'index.html',
  'version.js',
  'styles.css',
  'app.js',
  'config.js',
  'manifest.webmanifest',
  'vendor/marked.min.js',
  'vendor/purify.min.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((p) => new Request(p, { cache: 'no-store' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Always fetch the latest files from the server, skipping the browser's HTTP
// cache too. The saved copy is used only when the network fails (offline).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cacheKey = req.mode === 'navigate' ? 'index.html' : url.pathname;
    try {
      const res = await fetch(url.href, { cache: 'no-store', credentials: 'same-origin' });
      if (res.ok) cache.put(cacheKey, res.clone());
      return res;
    } catch (err) {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      throw err;
    }
  })());
});
