const CACHE_NAME = 'wordspark-v19';
const ASSETS = [
  '/', '/index.html', '/css/style.css',
  '/js/app.js', '/js/db.js', '/js/tts.js', '/js/sfx.js', '/js/learning-state.js',
  '/js/seed-data.js', '/js/seed-data-p2.js', '/js/seed-data-a2.js', '/js/seed-data-industry.js', '/js/seed-data-industry2.js',
  '/js/seed-data-zh.js', '/js/seed-data-zh2.js',
  '/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first: always try fresh content, fallback to cache offline
self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
