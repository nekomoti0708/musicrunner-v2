// sw.js - Simple Service Worker for caching assets
const CACHE_NAME = 'music-runner-v2-cache';
const OFFLINE_URL = 'index.html';

const ASSETS_TO_CACHE = [
  './',
  'index.html',
  'style.css',
  'main.js',
  'manifest.json',
  'audio-presets.js',
  'icons/icon_192_1779500783783.png',
  'icons/icon_512_1779500897773.png',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
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
  return self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  if (!['http:', 'https:'].includes(requestUrl.protocol) || requestUrl.origin !== self.location.origin) {
    return;
  }

  // モバイル通信かどうか判定（Chrome Network Information API）
  const isCellular = navigator.connection && navigator.connection.type === 'cellular';

  if (isCellular) {
    // モバイル通信 → キャッシュ優先（通信量を節約）
    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse;
        }
        // キャッシュになければネットワークへ
        return fetch(event.request).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseToCache)).catch(() => {});
          }
          return networkResponse;
        }).catch(() => {
          if (event.request.mode === 'navigate') {
            return caches.match(OFFLINE_URL);
          }
          return undefined;
        });
      })
    );
  } else {
    // WiFi / 有線 → ネットワーク優先（常に最新を取得）
    event.respondWith(
      fetch(event.request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseToCache)).catch(() => {});
        }
        return networkResponse;
      }).catch(() => {
        return caches.match(event.request).then(cachedResponse => {
          if (cachedResponse) {
            return cachedResponse;
          }
          if (event.request.mode === 'navigate') {
            return caches.match(OFFLINE_URL);
          }
          return undefined;
        });
      })
    );
  }
});
