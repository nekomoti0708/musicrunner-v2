// sw.js - Simple Service Worker for caching assets
const CACHE_NAME = 'music-runner-v2.9.8';
const OFFLINE_URL = 'index.html';

const ASSETS_TO_CACHE = [
  '/',
  'index.html',
  'style.css',
  'main.js',
  'manifest.json',
  'audio-presets.js',
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
    caches.match(event.request).then(cachedResponse => {
      // 1. キャッシュが存在すればそれを返す
      if (cachedResponse) {
        return cachedResponse;
      }

      // 2. キャッシュに無ければネットワーク取得を試みる
      return fetch(event.request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // 3. オフラインかつページ遷移 (navigate) の場合のみ index.html を返す
        if (event.request.mode === 'navigate') {
          return caches.match(OFFLINE_URL);
        }
        // その他のアセット（JS, CSS, 画像等）が取得できない場合は HTML を返さずに失敗させる
        return undefined;
      });
    })
  );
});
