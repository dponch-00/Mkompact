// Lectura y escritura de metadatos JPEG sin dependencias.
// Se usa en el hilo principal (análisis) y en el worker (armado del archivo final).

export const MARK = 'Compacta/1';

const SOF = new Set([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF]);
const ascii = (u8, start, len) => String.fromCharCode(...u8.subarray(start, start + len));
const latin1 = new TextDecoder('latin1');

// Recorre los segmentos del encabezado (hasta SOS). `u8` puede ser solo el inicio del archivo.
export function parseJpegHeader(u8) {
  const info = {
    isJpeg: u8[0] === 0xFF && u8[1] === 0xD8,
    width: 0, height: 0,
    exif: null,          // Uint8Array con el payload de APP1 Exif (sin marcador ni longitud)
    orientation: 1,
    motion: false,       // foto en movimiento (Google MicroVideo/MotionPhoto)
    hdr: false,          // Ultra HDR (gain map)
    compacted: false,    // ya pasó por Compacta
  };
  if (!info.isJpeg) return info;
  let p = 2;
  while (p + 4 <= u8.length) {
    if (u8[p] !== 0xFF) break;
    const m = u8[p + 1];
    if (m === 0xFF) { p++; continue; }
    if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { p += 2; continue; }
    if (m === 0xDA || m === 0xD9) break;
    const len = (u8[p + 2] << 8) | u8[p + 3];
    const s = p + 4, e = p + 2 + len;
    if (e > u8.length) break;
    if (m === 0xE1 && ascii(u8, s, 6) === 'Exif\0\0') {
      info.exif = u8.slice(s, e);
      info.orientation = readOrientation(info.exif);
    } else if (m === 0xE1 && ascii(u8, s, 28) === 'http://ns.adobe.com/xap/1.0/') {
      const xmp = latin1.decode(u8.subarray(s, e));
      if (/MotionPhoto\s*[=>]\s*["']?1|MicroVideo\s*[=>]\s*["']?1|MotionPhoto_Data/.test(xmp)) info.motion = true;
      if (/hdrgm:Version|GainMap/.test(xmp)) info.hdr = true;
    } else if (m === 0xE2 && ascii(u8, s, 4) === 'MPF\0') {
      info.hdr = true;
    } else if (m === 0xFE && ascii(u8, s, MARK.length) === MARK) {
      info.compacted = true;
    } else if (SOF.has(m)) {
      info.height = (u8[s + 1] << 8) | u8[s + 2];
      info.width = (u8[s + 3] << 8) | u8[s + 4];
    }
    p = e;
  }
  return info;
}

// Samsung guarda el video de la foto en movimiento al final del archivo, después de la imagen.
export function tailHasSamsungMotion(u8tail) {
  return latin1.decode(u8tail).includes('MotionPhoto_Data');
}

// ---------- EXIF (TIFF) ----------

function tiff(exif) {
  const t = 6; // después de "Exif\0\0"
  const le = exif[t] === 0x49;
  const dv = new DataView(exif.buffer, exif.byteOffset + t, exif.byteLength - t);
  return { dv, le, len: exif.byteLength - t };
}

function walkIfd(dv, le, off, fn) {
  if (off < 8 || off + 2 > dv.byteLength) return 0;
  const n = dv.getUint16(off, le);
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12;
    if (e + 12 > dv.byteLength) return 0;
    fn(dv.getUint16(e, le), e);
  }
  const next = off + 2 + n * 12;
  return next + 4 <= dv.byteLength ? next : 0; // posición del puntero al siguiente IFD
}

function readOrientation(exif) {
  try {
    const { dv, le } = tiff(exif);
    let o = 1;
    walkIfd(dv, le, dv.getUint32(4, le), (tag, e) => { if (tag === 0x0112) o = dv.getUint16(e + 8, le); });
    return o >= 1 && o <= 8 ? o : 1;
  } catch { return 1; }
}

// Copia del EXIF original ajustada a la imagen nueva: orientación 1 (los píxeles ya van girados),
// dimensiones nuevas, y sin la miniatura interna (quedaría girada o desfasada).
export function patchExif(exif, width, height) {
  const out = exif.slice();
  try {
    const { dv, le } = tiff(out);
    let exifIfd = 0;
    const nextPtr = walkIfd(dv, le, dv.getUint32(4, le), (tag, e) => {
      if (tag === 0x0112) dv.setUint16(e + 8, 1, le);
      if (tag === 0x8769) exifIfd = dv.getUint32(e + 8, le);
    });
    if (nextPtr) dv.setUint32(nextPtr, 0, le);
    if (exifIfd) {
      walkIfd(dv, le, exifIfd, (tag, e) => {
        if (tag !== 0xA002 && tag !== 0xA003) return;
        const v = tag === 0xA002 ? width : height;
        if (dv.getUint16(e + 2, le) === 3) dv.setUint16(e + 8, Math.min(v, 65535), le);
        else dv.setUint32(e + 8, v, le);
      });
    }
  } catch { /* EXIF raro: se copia tal cual */ }
  return out;
}

// EXIF mínimo con la fecha de captura, para imágenes que no traían (capturas PNG, etc.).
// Así la galería de Android sigue ordenándolas por su fecha real y no por "hoy".
export function buildDateExif(ms) {
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}\0`;
  const offMin = -d.getTimezoneOffset();
  const offset = `${offMin < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}\0`;
  // Big-endian. IFD0 (1 entrada) -> ExifIFD (2 entradas) -> datos
  const ifd0 = 8, exifIfd = ifd0 + 2 + 12 + 4, data = exifIfd + 2 + 2 * 12 + 4;
  const size = data + stamp.length + offset.length;
  const buf = new Uint8Array(6 + size);
  buf.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
  const dv = new DataView(buf.buffer, 6);
  dv.setUint16(0, 0x4D4D); dv.setUint16(2, 42); dv.setUint32(4, ifd0);
  dv.setUint16(ifd0, 1);
  dv.setUint16(ifd0 + 2, 0x8769); dv.setUint16(ifd0 + 4, 4); dv.setUint32(ifd0 + 6, 1); dv.setUint32(ifd0 + 10, exifIfd);
  dv.setUint32(ifd0 + 14, 0);
  dv.setUint16(exifIfd, 2);
  const entry = (i, tag, count, off) => {
    const e = exifIfd + 2 + i * 12;
    dv.setUint16(e, tag); dv.setUint16(e + 2, 2); dv.setUint32(e + 4, count); dv.setUint32(e + 8, off);
  };
  entry(0, 0x9003, stamp.length, data);                  // DateTimeOriginal
  entry(1, 0x9011, offset.length, data + stamp.length);  // OffsetTimeOriginal
  dv.setUint32(exifIfd + 2 + 24, 0);
  for (let i = 0; i < stamp.length; i++) dv.setUint8(data + i, stamp.charCodeAt(i));
  for (let i = 0; i < offset.length; i++) dv.setUint8(data + stamp.length + i, offset.charCodeAt(i));
  return buf;
}

// Arma el JPEG final: SOI + APP1 Exif + COM (marca) + el resto del JPEG codificado (sin su APP0 JFIF).
export function assembleJpeg(encoded, exifPayload, comment) {
  const enc = new Uint8Array(encoded);
  let rest = 2;
  if (enc[2] === 0xFF && enc[3] === 0xE0) rest = 4 + ((enc[4] << 8) | enc[5]);
  const parts = [enc.subarray(0, 2)];
  if (exifPayload && exifPayload.length + 2 <= 0xFFFF) parts.push(segment(0xE1, exifPayload));
  if (comment) parts.push(segment(0xFE, new TextEncoder().encode(comment)));
  parts.push(enc.subarray(rest));
  const total = parts.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of parts) { out.set(a, o); o += a.length; }
  return out;
}

function segment(marker, payload) {
  const s = new Uint8Array(4 + payload.length);
  s[0] = 0xFF; s[1] = marker;
  s[2] = (payload.length + 2) >> 8; s[3] = (payload.length + 2) & 0xFF;
  s.set(payload, 4);
  return s;
}
