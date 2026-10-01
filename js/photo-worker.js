// Worker de fotos: decodifica, reduce, codifica y reinyecta el EXIF original. También hace miniaturas.
import { readJpegInfo, patchExif, ensureDateTaken, buildDateExif, assembleJpeg, MARK } from './jpeg.js';

let mozjpeg; // se carga solo si se pide "compresión extra"

self.onmessage = async ({ data }) => {
  const { id } = data;
  try {
    const result = data.type === 'thumb'
      ? await thumbnail(data.file, data.size)
      : await compress(data.file, data.quality, data.maxSide, data.skipSpecial, data.engine);
    self.postMessage({ id, ok: true, ...result }, result.buffer ? [result.buffer] : []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};

async function compress(file, quality, maxSide, skipSpecial, engine) {
  const t0 = performance.now();
  const info = await readJpegInfo(file);
  // Se vuelve a revisar aquí por si el archivo cambió desde el análisis guardado.
  if (info.compacted) return { ignored: 'compacted' };
  if (info.pano) return { ignored: 'pano' };
  if (skipSpecial && (info.motion || info.special)) return { ignored: 'motion' };
  const bmp = await decode(file, info, maxSide);
  const { width, height } = bmp;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: engine === 'mozjpeg' });
  ctx.fillStyle = '#fff';            // PNG con transparencia -> fondo blanco
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();

  // "native": el codificador JPEG del navegador, varias veces más rápido. "mozjpeg": ~10 % más chico pero lento.
  let encoded;
  if (engine === 'mozjpeg') {
    try {
      mozjpeg ??= (await import('../vendor/jsquash-jpeg/encode.js')).default;
      encoded = await mozjpeg(ctx.getImageData(0, 0, width, height), { quality });
    } catch { engine = 'native'; }
  }
  if (!encoded) {
    engine = 'native';
    encoded = await (await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 })).arrayBuffer();
  }
  canvas.width = canvas.height = 1;

  const exif = info.exif
    ? patchExif(ensureDateTaken(info.exif, file.lastModified), width, height)
    : buildDateExif(file.lastModified);
  const out = assembleJpeg(encoded, exif, `${MARK} q${quality}${maxSide ? ' max' + maxSide : ''}`);
  return { buffer: out.buffer, width, height, engine, ms: performance.now() - t0 };
}

// imageOrientation 'from-image' aplica la rotación EXIF: los píxeles salen derechos.
// Si ya se conocen las dimensiones (JPEG), se decodifica directo al tamaño final: el decodificador
// escala mientras lee y no hace falta tener en memoria la foto completa.
async function decode(file, info, maxSide) {
  const opts = { imageOrientation: 'from-image' };
  if (maxSide && info.width && info.height) {
    const swap = info.orientation >= 5;
    const w = swap ? info.height : info.width, h = swap ? info.width : info.height;
    const scale = maxSide / Math.max(w, h);
    if (scale >= 1) return createImageBitmap(file, opts);
    return createImageBitmap(file, {
      ...opts, resizeWidth: Math.round(w * scale), resizeHeight: Math.round(h * scale), resizeQuality: 'high',
    });
  }
  const full = await createImageBitmap(file, opts);
  const scale = maxSide ? maxSide / Math.max(full.width, full.height) : 1;
  if (scale >= 1) return full;
  const small = await createImageBitmap(full, {
    resizeWidth: Math.round(full.width * scale), resizeHeight: Math.round(full.height * scale), resizeQuality: 'high',
  });
  full.close();
  return small;
}

// Miniatura cuadrada-ish para la galería, ya girada (para fotos sin miniatura interna: PNG, compactadas…)
async function thumbnail(file, size = 320) {
  const info = /\.jpe?g$/i.test(file.name) ? await readJpegInfo(file) : {};
  const bmp = await decode(file, info, size);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  const buffer = await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 })).arrayBuffer();
  return { buffer };
}
