// Miniaturas para la galería. Orden de preferencia:
//  1. caché en IndexedDB (instantáneo al volver a abrir la galería)
//  2. la miniatura que la cámara guarda dentro del EXIF (~10 KB, sin decodificar la foto)
//  3. decodificar la foto reducida en un worker (PNG, fotos compactadas)
//  4. un cuadro del video
// Se piden solo las que están en pantalla, y se atiende primero la última pedida (la que se ve ahora).
import { store } from './store.js';
import { readJpegInfo, exifThumbnail } from './jpeg.js';

export function createThumbs({ resolveItem, pool }) {
  const ready = new Map();   // clave -> { url, orient }
  const stack = [];          // trabajos pendientes (LIFO)
  let active = 0, videoBusy = false;
  const MAX = 4;
  const keyOf = item => `${item.fk}|${item.size}|${item.mtime}`;

  function request(item) {
    const key = keyOf(item);
    if (ready.has(key)) return { promise: Promise.resolve(ready.get(key)), cancel() {} };
    const job = { item, key, cancelled: false };
    job.promise = new Promise((res, rej) => { job.res = res; job.rej = rej; });
    stack.push(job);
    pump();
    return { promise: job.promise, cancel() { job.cancelled = true; } };
  }

  function pump() {
    while (active < MAX) {
      let i = stack.length - 1;
      while (i >= 0 && (stack[i].cancelled || (stack[i].item.type === 'video' && videoBusy))) {
        if (stack[i].cancelled) { stack[i].rej(new Error('cancelled')); stack.splice(i, 1); }
        i--;
      }
      if (i < 0) return;
      const [job] = stack.splice(i, 1);
      active++;
      const isVideo = job.item.type === 'video';
      if (isVideo) videoBusy = true;
      load(job).then(v => {
        const val = { url: URL.createObjectURL(v.blob), orient: v.orient };
        ready.set(job.key, val);
        job.res(val);
      }, job.rej).finally(() => {
        active--;
        if (isVideo) videoBusy = false;
        pump();
      });
    }
  }

  async function load({ item, key }) {
    const cached = await store.get('thumbs', key).catch(() => null);
    if (cached) return cached;
    await resolveItem(item);
    let blob = null, orient = 1;
    if (item.type === 'video') {
      blob = await videoFrame(item.file);
    } else {
      if (item.type === 'photo') {
        const info = await readJpegInfo(item.file);
        const t = exifThumbnail(info.exif, info.thumb);
        if (t) { blob = new Blob([t], { type: 'image/jpeg' }); orient = info.orientation; }
      }
      if (!blob) blob = new Blob([(await pool.thumb(item.file)).buffer], { type: 'image/jpeg' });
    }
    const val = { blob, orient };
    store.put('thumbs', val, key).catch(() => {});
    return val;
  }

  return { request, keyOf, forget: item => ready.delete(keyOf(item)) };
}

// Un cuadro del video (al 1 s o a un tercio si es más corto). Se rinde a los 10 s.
function videoFrame(file) {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = () => { clearTimeout(timer); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); };
    const timer = setTimeout(() => { done(); rej(new Error('El video tardó demasiado')); }, 10000);
    Object.assign(v, { muted: true, preload: 'metadata', playsInline: true, src: url });
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 3) / 3); };
    v.onseeked = async () => {
      try {
        const w = 320, h = Math.max(1, Math.round(320 * v.videoHeight / v.videoWidth)) || 180;
        const c = new OffscreenCanvas(w, h);
        c.getContext('2d').drawImage(v, 0, 0, w, h);
        const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
        done(); res(blob);
      } catch (e) { done(); rej(e); }
    };
    v.onerror = () => { done(); rej(new Error('No se pudo leer el video')); };
  });
}
