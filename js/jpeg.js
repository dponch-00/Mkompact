// Lectura y escritura de metadatos JPEG sin dependencias.
// Se usa en el hilo principal (análisis) y en el worker (armado del archivo final).

export const MARK = 'MKompact/1';

const SOF = new Set([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF]);
const ascii = (u8, start, len) => String.fromCharCode(...u8.subarray(start, start + len));
const latin1 = new TextDecoder('latin1');

// Recorre los segmentos del encabezado (hasta SOS). `u8` puede ser solo el inicio del archivo;
// si un segmento queda cortado, `truncated` indica que hay que leer más.
export function parseJpegHeader(u8) {
  const info = {
    isJpeg: u8[0] === 0xFF && u8[1] === 0xD8,
    truncated: false,
    width: 0, height: 0,
    exif: null,          // Uint8Array con el payload de APP1 Exif (sin marcador ni longitud)
    orientation: 1,
    make: '',
    taken: 0,            // fecha de captura (ms) según EXIF, 0 si no tiene
    thumb: null,         // { off, len } de la miniatura que guarda la cámara dentro del EXIF
    motion: false,       // foto en movimiento (Google MicroVideo/MotionPhoto)
    special: false,      // retrato con profundidad editable (GDepth / Container de Google)
    pano: false,         // foto 360° (GPano)
    hdr: false,          // Ultra HDR (gain map)
    compacted: false,    // ya pasó por MKompact
  };
  if (!info.isJpeg) return info;
  let p = 2;
  while (true) {
    if (p + 4 > u8.length) { info.truncated = true; break; }
    if (u8[p] !== 0xFF) break;
    const m = u8[p + 1];
    if (m === 0xFF) { p++; continue; }
    if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { p += 2; continue; }
    if (m === 0xDA || m === 0xD9) break;
    const len = (u8[p + 2] << 8) | u8[p + 3];
    const s = p + 4, e = p + 2 + len;
    if (e > u8.length) { info.truncated = true; break; }
    if (m === 0xE1 && ascii(u8, s, 6) === 'Exif\0\0') {
      info.exif = u8.slice(s, e);
      Object.assign(info, readExifInfo(info.exif));
    } else if (m === 0xE1 && ascii(u8, s, 28) === 'http://ns.adobe.com/xap/1.0/') {
      const xmp = latin1.decode(u8.subarray(s, e));
      if (/MotionPhoto\s*[=>]\s*["']?1|MicroVideo\s*[=>]\s*["']?1|MotionPhoto_Data/.test(xmp)) info.motion = true;
      if (/GDepth:|Semantic\s*=\s*["'](Depth|Portrait)/.test(xmp)) info.special = true;
      if (/GPano:/.test(xmp)) info.pano = true;
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

// Lee solo lo necesario del archivo: 64 KB casi siempre alcanzan; si no, hasta 1 MB.
export async function readJpegInfo(file) {
  let info = parseJpegHeader(new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer()));
  if (info.truncated && file.size > 64 * 1024) {
    info = parseJpegHeader(new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer()));
  }
  // Samsung guarda el video de la foto en movimiento al final, después de la imagen.
  if (info.isJpeg && !info.motion && /samsung/i.test(info.make) && file.size > 1024 * 1024) {
    const tail = await file.slice(Math.max(0, file.size - 64 * 1024)).arrayBuffer();
    info.motion = latin1.decode(tail).includes('MotionPhoto_Data');
  }
  return info;
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

const readAscii = (dv, le, e, max = 64) => {
  const count = dv.getUint32(e + 4, le);
  const at = count <= 4 ? e + 8 : dv.getUint32(e + 8, le);
  if (at + count > dv.byteLength) return '';
  return String.fromCharCode(...new Uint8Array(dv.buffer, dv.byteOffset + at, Math.min(count, max))).replace(/\0.*$/, '');
};

// "2022:09:20 16:05:09" (+ "-06:00" si la cámara guardó la zona) -> milisegundos
export function parseExifDate(stamp, offset) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(stamp || '');
  if (!m || m[1] === '0000') return 0;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  const o = /^([+-])(\d{2}):(\d{2})$/.exec(offset || '');
  if (o) return Date.UTC(y, mo - 1, d, h, mi, se) - (o[1] === '-' ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3])) * 60000;
  return new Date(y, mo - 1, d, h, mi, se).getTime();
}

// Orientación, fabricante, fecha de captura y ubicación de la miniatura interna.
function readExifInfo(exif) {
  const out = { orientation: 1, make: '', taken: 0, thumb: null };
  try {
    const { dv, le } = tiff(exif);
    let exifIfd = 0, stamp = '', offset = '';
    const next = walkIfd(dv, le, dv.getUint32(4, le), (tag, e) => {
      if (tag === 0x0112) {
        const o = dv.getUint16(e + 8, le);
        if (o >= 1 && o <= 8) out.orientation = o;
      } else if (tag === 0x010F) out.make = readAscii(dv, le, e);
      else if (tag === 0x8769) exifIfd = dv.getUint32(e + 8, le);
      else if (tag === 0x0132 && !stamp) stamp = readAscii(dv, le, e); // DateTime, por si falta la original
    });
    if (exifIfd) {
      walkIfd(dv, le, exifIfd, (tag, e) => {
        if (tag === 0x9003) stamp = readAscii(dv, le, e);
        else if (tag === 0x9011) offset = readAscii(dv, le, e);
      });
    }
    out.taken = parseExifDate(stamp, offset);
    // IFD1: la miniatura JPEG que guarda la cámara (unos 10 KB, sin girar)
    const ifd1 = next ? dv.getUint32(next, le) : 0;
    if (ifd1) {
      let off = 0, len = 0;
      walkIfd(dv, le, ifd1, (tag, e) => {
        if (tag === 0x0201) off = dv.getUint32(e + 8, le);
        else if (tag === 0x0202) len = dv.getUint32(e + 8, le);
      });
      if (off && len && off + len <= dv.byteLength) out.thumb = { off, len };
    }
  } catch { /* EXIF dañado: valores por omisión */ }
  return out;
}

// Bytes de la miniatura interna (JPEG) a partir del payload EXIF, o null.
export function exifThumbnail(exif, thumb) {
  if (!exif || !thumb) return null;
  const start = 6 + thumb.off;
  const bytes = exif.subarray(start, start + thumb.len);
  return bytes[0] === 0xFF && bytes[1] === 0xD8 ? bytes.slice() : null;
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

function dateStrings(ms) {
  const d = new Date(ms);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}\0`;
  const offMin = -d.getTimezoneOffset();
  const offset = `${offMin < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}\0`;
  return { stamp, offset };
}

// Si el EXIF no trae fecha de captura (fotos editadas, descargadas…), se agrega con la fecha del archivo.
// Los directorios afectados se reescriben al final del bloque TIFF con las entradas nuevas; los datos
// existentes no se mueven, así que todos los demás punteros (MakerNote incluida) siguen siendo válidos.
export function ensureDateTaken(exif, ms) {
  try {
    const { dv, le, len } = tiff(exif);
    const ifd0 = dv.getUint32(4, le);
    let exifIfd = 0, hasDate = false, hasOffset = false;
    walkIfd(dv, le, ifd0, (tag, e) => { if (tag === 0x8769) exifIfd = dv.getUint32(e + 8, le); });
    if (exifIfd) walkIfd(dv, le, exifIfd, tag => { hasDate ||= tag === 0x9003; hasOffset ||= tag === 0x9011; });
    if (hasDate) return exif;

    const { stamp, offset } = dateStrings(ms);
    const entries = off => {
      const out = [];
      walkIfd(dv, le, off, (tag, e) => out.push({ tag, bytes: new Uint8Array(dv.buffer, dv.byteOffset + e, 12).slice() }));
      return out;
    };
    const entry = (tag, type, count, value) => {
      const bytes = new Uint8Array(12), d = new DataView(bytes.buffer);
      d.setUint16(0, tag, le); d.setUint16(2, type, le); d.setUint32(4, count, le); d.setUint32(8, value, le);
      return { tag, bytes };
    };
    const ifdSize = n => 2 + n * 12 + 4;

    let pos = len + (len & 1);
    const newIfd0 = exifIfd ? null : entries(ifd0);
    const ifd0At = newIfd0 ? pos : 0;
    if (newIfd0) pos += ifdSize(newIfd0.length + 1);
    const exifEntries = exifIfd ? entries(exifIfd) : [];
    const exifAt = pos;
    const added = hasOffset ? 1 : 2;
    pos += ifdSize(exifEntries.length + added);
    const stampAt = pos; pos += stamp.length;
    const offsetAt = pos; pos += offset.length;
    if (6 + pos + 2 > 0xFFFF) return exif; // no cabe en un segmento APP1

    exifEntries.push(entry(0x9003, 2, stamp.length, stampAt));
    if (!hasOffset) exifEntries.push(entry(0x9011, 2, offset.length, offsetAt));

    const out = new Uint8Array(6 + pos);
    out.set(exif);
    const o = new DataView(out.buffer, 6);
    const writeIfd = (at, list) => {
      list.sort((a, b) => a.tag - b.tag);
      o.setUint16(at, list.length, le);
      list.forEach((en, i) => out.set(en.bytes, 6 + at + 2 + i * 12));
      o.setUint32(at + 2 + list.length * 12, 0, le);
    };
    writeIfd(exifAt, exifEntries);
    if (newIfd0) {
      newIfd0.push(entry(0x8769, 4, 1, exifAt));
      writeIfd(ifd0At, newIfd0);
      o.setUint32(4, ifd0At, le);
    } else {
      walkIfd(o, le, ifd0, (tag, e) => { if (tag === 0x8769) o.setUint32(e + 8, exifAt, le); });
    }
    for (let i = 0; i < stamp.length; i++) o.setUint8(stampAt + i, stamp.charCodeAt(i));
    for (let i = 0; i < offset.length; i++) o.setUint8(offsetAt + i, offset.charCodeAt(i));
    return out;
  } catch { return exif; }
}

// EXIF mínimo con la fecha de captura, para imágenes que no traían (capturas PNG, etc.).
// Así la galería de Android sigue ordenándolas por su fecha real y no por "hoy".
export function buildDateExif(ms) {
  const { stamp, offset } = dateStrings(ms);
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
