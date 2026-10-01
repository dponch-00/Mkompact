// Lectura y ajustes de cajas MP4/MOV sin dependencias. Solo lee el índice (moov), nunca el video:
// en Android cada lectura de archivo pasa por el sistema y es lenta, así que se hacen las mínimas.
import { MARK } from './jpeg.js';

const MAC_EPOCH = 2082844800; // segundos entre 1904 (MP4) y 1970
const fourcc = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

// Cajas de primer nivel: [{ type, start, size, header }]
async function topBoxes(file) {
  const boxes = [];
  for (let pos = 0; pos + 8 <= file.size;) {
    const h = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    let size = h.getUint32(0), header = 8;
    if (size === 1) { size = Number(h.getBigUint64(8)); header = 16; } else if (size === 0) size = file.size - pos;
    if (size < header) break;
    boxes.push({ type: fourcc(h, 4), start: pos, size, header });
    pos += size;
  }
  return boxes;
}

// Hijos directos de una caja ya leída en memoria (u8 = la caja completa, encabezado de 8 bytes).
export function children(u8, from = 8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = [];
  for (let q = from; q + 8 <= u8.byteLength;) {
    const size = dv.getUint32(q);
    if (size < 8 || q + size > u8.byteLength) break;
    out.push({ type: fourcc(dv, q + 4), start: q, size, u8: u8.subarray(q, q + size) });
    q += size;
  }
  return out;
}
const child = (u8, type) => u8 && children(u8).find(b => b.type === type)?.u8;
const view = u8 => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

export async function readMoov(file) {
  const boxes = await topBoxes(file);
  const moov = boxes.find(b => b.type === 'moov');
  if (!moov || moov.header !== 8 || moov.size > 64 * 2 ** 20) return null;
  const u8 = new Uint8Array(await file.slice(moov.start, moov.start + moov.size).arrayBuffer());
  return { ...moov, u8, isLast: moov === boxes[boxes.length - 1] };
}

// Datos básicos del video leyendo solo moov: medidas en pantalla, duración, cuadros por segundo
// y si ya pasó por MKompact. Sustituye a abrir el archivo con Mediabunny durante el análisis.
export async function quickProbe(file) {
  const moov = await readMoov(file);
  if (!moov) return null;
  const mvhd = child(moov.u8, 'mvhd');
  let duration = 0;
  if (mvhd) {
    const d = view(mvhd), v1 = d.getUint8(8) === 1;
    const scale = d.getUint32(v1 ? 28 : 20), dur = v1 ? Number(d.getBigUint64(32)) : d.getUint32(24);
    duration = scale ? dur / scale : 0;
  }
  for (const trak of children(moov.u8).filter(b => b.type === 'trak')) {
    const mdia = child(trak.u8, 'mdia');
    const hdlr = child(mdia, 'hdlr');
    if (!hdlr || fourcc(view(hdlr), 16) !== 'vide') continue;
    const tkhd = view(child(trak.u8, 'tkhd'));
    const v1 = tkhd.getUint8(8) === 1;
    const m = v1 ? 60 : 48;                      // inicio de la matriz de transformación
    const a = tkhd.getInt32(m), b = tkhd.getInt32(m + 4);
    const rotated = a === 0 && Math.abs(b) === 65536; // 90° o 270°
    const w = tkhd.getUint32(m + 36) / 65536, h = tkhd.getUint32(m + 40) / 65536;
    const mdhd = view(child(mdia, 'mdhd'));
    const mv1 = mdhd.getUint8(8) === 1;
    const ts = mdhd.getUint32(mv1 ? 28 : 20), tdur = mv1 ? Number(mdhd.getBigUint64(32)) : mdhd.getUint32(24);
    const stsz = child(child(child(mdia, 'minf'), 'stbl'), 'stsz');
    const frames = stsz ? view(stsz).getUint32(16) : 0;
    const trackSecs = ts ? tdur / ts : duration;
    duration ||= trackSecs;
    return {
      width: Math.round(rotated ? h : w), height: Math.round(rotated ? w : h),
      duration, fps: trackSecs && frames ? frames / trackSecs : 30,
      bitrate: duration ? file.size * 8 / duration : 0,
      compacted: includesAscii(moov.u8, MARK),
    };
  }
  return null;
}

function includesAscii(u8, text) {
  const first = text.charCodeAt(0);
  outer: for (let i = u8.indexOf(first); i !== -1 && i + text.length <= u8.length; i = u8.indexOf(first, i + 1)) {
    for (let j = 1; j < text.length; j++) if (u8[i + j] !== text.charCodeAt(j)) continue outer;
    return true;
  }
  return false;
}

// Fecha de grabación guardada en mvhd (la que usa la galería de Android).
export async function readCreationTime(file) {
  const moov = await readMoov(file);
  const mvhd = moov && child(moov.u8, 'mvhd');
  if (!mvhd) return null;
  const d = view(mvhd);
  const secs = d.getUint8(8) === 1 ? Number(d.getBigUint64(12)) : d.getUint32(12);
  return secs > MAC_EPOCH ? (secs - MAC_EPOCH) * 1000 : null;
}

// Ubicación GPS: los celulares Android la guardan en moov/udta/©xyz (algunos en loci).
// Mediabunny no lee ©xyz y copia mal loci, así que se copian estas cajas tal cual.
export const LOCATION = new Set(['©xyz', 'loci']);
export async function readLocationBoxes(file) {
  const moov = await readMoov(file);
  const udta = moov && child(moov.u8, 'udta');
  if (!udta) return null;
  const parts = children(udta).filter(b => LOCATION.has(b.type)).map(b => b.u8.slice());
  if (!parts.length) return null;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((o, p) => (out.set(p, o), o + p.length), 0);
  return out;
}

// Agrega las cajas de ubicación dentro de moov/udta del video nuevo (moov va al final del archivo).
export async function injectLocation(handle, extra) {
  const file = await handle.getFile();
  const moov = await readMoov(file);
  if (!moov || !moov.isLast) return false;
  const u8 = moov.u8;
  const udta = children(u8).find(b => b.type === 'udta');
  let newMoov;
  if (udta) {
    newMoov = new Uint8Array(u8.length + extra.length);
    const udtaEnd = udta.start + udta.size;
    newMoov.set(u8.subarray(0, udtaEnd));
    newMoov.set(extra, udtaEnd);
    newMoov.set(u8.subarray(udtaEnd), udtaEnd + extra.length);
    new DataView(newMoov.buffer).setUint32(udta.start, udta.size + extra.length);
  } else {
    newMoov = new Uint8Array(u8.length + 8 + extra.length);
    newMoov.set(u8);
    const dv = new DataView(newMoov.buffer);
    dv.setUint32(u8.length, 8 + extra.length);
    newMoov.set([0x75, 0x64, 0x74, 0x61], u8.length + 4); // 'udta'
    newMoov.set(extra, u8.length + 8);
  }
  new DataView(newMoov.buffer).setUint32(0, newMoov.length);
  const w = await handle.createWritable({ keepExistingData: true });
  await w.write({ type: 'write', position: moov.start, data: newMoov });
  await w.close();
  return true;
}
