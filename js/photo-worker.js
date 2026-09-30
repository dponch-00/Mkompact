// Worker de fotos: decodifica, reduce, codifica con MozJPEG y reinyecta el EXIF original.
import encodeMozjpeg from '../vendor/jsquash-jpeg/encode.js';
import { parseJpegHeader, patchExif, buildDateExif, assembleJpeg, MARK } from './jpeg.js';

self.onmessage = async ({ data }) => {
  const { id, file, quality, maxSide } = data;
  try {
    const result = await compress(file, quality, maxSide);
    self.postMessage({ id, ok: true, ...result }, [result.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};

async function compress(file, quality, maxSide) {
  const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const info = parseJpegHeader(head);

  // imageOrientation 'from-image' aplica la rotación EXIF: los píxeles salen derechos.
  let bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  let { width, height } = bmp;
  const scale = maxSide ? Math.min(1, maxSide / Math.max(width, height)) : 1;
  if (scale < 1) {
    width = Math.round(width * scale);
    height = Math.round(height * scale);
    const small = await createImageBitmap(bmp, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
    bmp.close();
    bmp = small;
  }
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

  const exif = info.exif ? patchExif(info.exif, width, height) : buildDateExif(file.lastModified);
  const out = assembleJpeg(encoded, exif, `${MARK} q${quality}${maxSide ? ' max' + maxSide : ''}`);
  return { buffer: out.buffer, width, height, engine };
}
