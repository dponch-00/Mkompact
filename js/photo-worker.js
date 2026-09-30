// Worker de fotos: decodifica, reduce, codifica con MozJPEG y reinyecta el EXIF original.
import encodeMozjpeg from '../vendor/jsquash-jpeg/encode.js';
import { readJpegInfo, patchExif, ensureDateTaken, buildDateExif, assembleJpeg, MARK } from './jpeg.js';

self.onmessage = async ({ data }) => {
  const { id, file, quality, maxSide } = data;
  try {
    const result = await compress(file, quality, maxSide);
    self.postMessage({ id, ok: true, ...result }, [result.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};

async function compress(file, quality, maxSide) {
  const info = await readJpegInfo(file);
  const bmp = await decode(file, info, maxSide);
  const { width, height } = bmp;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';            // PNG con transparencia -> fondo blanco
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();

  let encoded, engine = 'mozjpeg';
  try {
    encoded = await encodeMozjpeg(ctx.getImageData(0, 0, width, height), { quality });
  } catch {
    engine = 'canvas';
    encoded = await (await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 })).arrayBuffer();
  }
  canvas.width = canvas.height = 1;

  const exif = info.exif
    ? patchExif(ensureDateTaken(info.exif, file.lastModified), width, height)
    : buildDateExif(file.lastModified);
  const out = assembleJpeg(encoded, exif, `${MARK} q${quality}${maxSide ? ' max' + maxSide : ''}`);
  return { buffer: out.buffer, width, height, engine };
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
    const bmp = await createImageBitmap(file, {
      ...opts, resizeWidth: Math.round(w * scale), resizeHeight: Math.round(h * scale), resizeQuality: 'high',
    });
    return bmp;
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
