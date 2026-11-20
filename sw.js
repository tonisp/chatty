const CACHE_NAME = 'decloc-shell-v4';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './config.js',
  './manifest.json',
  './icon.svg',
  './js/i18n.js',
  './js/emojis.js',
  './js/crypto.js',
  './js/storage.js',
  './js/nostr.js',
  './js/webrtc.js',
  './js/app.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for app files so updates on GitHub Pages appear quickly, fallback to cache offline
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/decloc-relay.json') || url.pathname.endsWith('/health')) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
