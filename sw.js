// sw.js - Simple Service Worker for caching assets
const CACHE_NAME = 'musicrunner-cache-v3';
const OFFLINE_URL = 'index.html';

const ASSETS_TO_CACHE = [
  '/',
  'index.html',
  'style.css',
  'main.js',
  'manifest.json',
  // Icons
  'icons/icon_192_1779500783783.png',
  'icons/icon_512_1779500897773.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .catch(() => caches.match(event.request))
      .then(response => response || caches.match(OFFLINE_URL))
  );
});
