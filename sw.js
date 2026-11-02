// FreePot service worker.
//
// Two jobs:
//  1. Cache the app shell so it launches offline.
//  2. Serve downloaded audio back to the app.
//
// Downloaded audio is stored as a normal typed response (Invidious mirrors send
// CORS headers, so the bytes are readable). The player prefers a Blob URL built
// from that cache, but this route is the fallback for anything that references
// `/__audio/<id>` directly.

const SHELL_CACHE = 'freepot-shell-v9';
const AUDIO_CACHE = 'freepot-audio-v1';

// The app can be served from the domain root (local dev, user pages) or from a
// subpath (a GitHub Pages project site). Everything here is resolved against the
// worker's own scope so both cases work unchanged.
const BASE = new URL('./', self.location.href).pathname;
const AUDIO_PREFIX = `${BASE}__audio/`;

const SHELL = [
  './',
  './index.html',
  './setup.html',
  './manifest.json',
  './assets/css/base.css',
  './assets/css/artwork.css',
  './assets/css/chrome.css',
  './assets/css/home.css',
  './assets/css/lists.css',
  './assets/css/player.css',
  './assets/css/overlays.css',
  './assets/js/main.js',
  './assets/js/actions.js',
  './assets/js/art.js',
  './assets/js/catalog.js',
  './assets/js/config.js',
  './assets/js/device.js',
  './assets/js/downloads.js',
  './assets/js/events.js',
  './assets/js/invidious.js',
  './assets/js/library.js',
  './assets/js/lyrics.js',
  './assets/js/media.js',
  './assets/js/overlays.js',
  './assets/js/piped.js',
  './assets/js/player.js',
  './assets/js/provider.js',
  './assets/js/router.js',
  './assets/js/settings.js',
  './assets/js/shell.js',
  './assets/js/sources.js',
  './assets/js/ui.js',
  './assets/js/util.js',
  './assets/js/ytplayer.js',
  './assets/js/views/detail.js',
  './assets/js/views/home.js',
  './assets/js/views/library.js',
  './assets/js/views/search.js',
  './assets/icons/icon.svg',
  './assets/icons/icon-180.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL_CACHE, AUDIO_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Downloaded audio: served from the cache, never the network.
  if (sameOrigin && url.pathname.startsWith(AUDIO_PREFIX)) {
    event.respondWith(
      caches.open(AUDIO_CACHE)
        .then((cache) => cache.match(request))
        .then((hit) => hit || new Response('', { status: 404 }))
    );
    return;
  }

  // Never intercept the YouTube iframe player, its assets, or the provider.
  if (!sameOrigin) return;

  // Navigations: network-first so a fresh shell lands immediately.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(`${BASE}index.html`, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(`${BASE}index.html`)
          .then((hit) => hit || caches.match(`${BASE}`))
          .then((hit) => hit || caches.match('./index.html'))
          .then((hit) => hit || caches.match('./')))
    );
    return;
  }

  // Static assets: cache-first with a background refresh.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
