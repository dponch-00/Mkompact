// Cache de la app para que funcione sin internet. Subir VERSION en cada publicación.
const VERSION = 'mkompact-v3';
const FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/emblem.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'fonts/cinzel.woff2', 'fonts/barlow-400.woff2', 'fonts/barlow-600.woff2', 'fonts/barlow-700.woff2',
  'js/app.js', 'js/store.js', 'js/fsops.js', 'js/jpeg.js', 'js/photo-worker.js', 'js/video.js',
  'vendor/jsquash-jpeg/encode.js', 'vendor/jsquash-jpeg/meta.js', 'vendor/jsquash-jpeg/utils.js',
  'vendor/jsquash-jpeg/codec/enc/mozjpeg_enc.js', 'vendor/jsquash-jpeg/codec/enc/mozjpeg_enc.wasm',
  'vendor/mediabunny/mediabunny.min.mjs',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
