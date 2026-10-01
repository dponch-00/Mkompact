// Cache de la app para que funcione sin internet. Subir VERSION en cada publicación.
const VERSION = 'mkompact-v4';
const FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'fonts/cinzel.woff2', 'fonts/barlow-400.woff2', 'fonts/barlow-600.woff2', 'fonts/barlow-700.woff2',
  'js/app.js', 'js/store.js', 'js/fsops.js', 'js/jpeg.js', 'js/mp4.js', 'js/photo-worker.js', 'js/video.js',
  'vendor/jsquash-jpeg/encode.js', 'vendor/jsquash-jpeg/meta.js', 'vendor/jsquash-jpeg/utils.js',
  'vendor/jsquash-jpeg/codec/enc/mozjpeg_enc.js', 'vendor/jsquash-jpeg/codec/enc/mozjpeg_enc.wasm',
  'vendor/mediabunny/mediabunny.min.mjs',
];

// cache: 'reload' se salta la caché HTTP del navegador: siempre baja los archivos de esta versión.
const fill = () => caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))));
const dropAll = keep => caches.keys().then(keys => Promise.all(keys.filter(k => k !== keep).map(k => caches.delete(k))));

self.addEventListener('install', e => {
  e.waitUntil(fill().then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(dropAll(VERSION).then(() => self.clients.claim()));
});
// "Reinstalar limpio" desde Opciones: borra todo lo guardado y lo vuelve a bajar de la red.
self.addEventListener('message', e => {
  if (e.data !== 'reinstall') return;
  e.waitUntil(dropAll(null).then(fill).then(() => e.source?.postMessage('reinstalled')));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
