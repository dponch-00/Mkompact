// Compactación de video con WebCodecs (Mediabunny). Experimental: lento y gasta batería.
import {
  Input, Output, Conversion, BlobSource, StreamTarget, Mp4OutputFormat, ALL_FORMATS,
  canEncodeVideo,
} from '../vendor/mediabunny/mediabunny.min.mjs';
import { MARK } from './jpeg.js';

const MAC_EPOCH = 2082844800; // segundos entre 1904 (MP4) y 1970

export async function probeVideo(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const duration = await input.computeDuration();
    const stats = await track.computePacketStats(120).catch(() => null);
    const tags = await input.getMetadataTags().catch(() => ({}));
    return {
      compacted: String(tags.comment || '').startsWith(MARK),
      width: track.displayWidth, height: track.displayHeight,
      duration, fps: stats?.averagePacketRate || 30,
      bitrate: duration ? file.size * 8 / duration : 0,
      codec: track.codec,
    };
  } finally { input.dispose?.(); }
}

// Bitrate objetivo por nivel, en bits por pixel por cuadro (H.264; HEVC necesita ~35 % menos).
const BPP = { suave: 0.10, equilibrado: 0.07, maximo: 0.05 };

export function planVideo(meta, level, hevc) {
  const maxSide = { suave: 0, equilibrado: 1920, maximo: 1280 }[level];
  let { width, height } = meta;
  const scale = maxSide ? Math.min(1, maxSide / Math.max(width, height)) : 1;
  width = Math.round(width * scale / 2) * 2;
  height = Math.round(height * scale / 2) * 2;
  const fps = Math.min(meta.fps || 30, 60);
  const bitrate = Math.round(width * height * fps * BPP[level] * (hevc ? 0.65 : 1));
  const audio = 128_000;
  const estimated = Math.round(meta.duration * (bitrate + audio) / 8);
  return { width, height, bitrate, estimated, resize: scale < 1 };
}

// HEVC pesa ~35 % menos; se usa si el teléfono puede codificarlo a esa resolución.
const codecCache = new Map();
export async function pickCodec(width = 1920, height = 1080) {
  const key = `${width}x${height}`;
  if (!codecCache.has(key)) {
    codecCache.set(key, (async () => {
      for (const codec of ['hevc', 'avc']) {
        if (await canEncodeVideo(codec, { width, height, bitrate: 4e6 }).catch(() => false)) return codec;
      }
      return null;
    })());
  }
  return codecCache.get(key);
}

// ---------- Cajas MP4 ----------
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

// Hijos directos de una caja ya leída en memoria (u8 = la caja completa).
function children(u8, from = 8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = [];
  for (let q = from; q + 8 <= u8.byteLength;) {
    const size = dv.getUint32(q);
    if (size < 8 || q + size > u8.byteLength) break;
    out.push({ type: fourcc(dv, q + 4), start: q, size });
    q += size;
  }
  return out;
}

async function readMoov(file) {
  const boxes = await topBoxes(file);
  const moov = boxes.find(b => b.type === 'moov');
  if (!moov || moov.header !== 8 || moov.size > 64 * 2 ** 20) return null;
  const u8 = new Uint8Array(await file.slice(moov.start, moov.start + moov.size).arrayBuffer());
  return { ...moov, u8, isLast: moov === boxes[boxes.length - 1] };
}

// Fecha de grabación guardada en mvhd (la que usa la galería de Android).
export async function readCreationTime(file) {
  const moov = await readMoov(file);
  const mvhd = moov && children(moov.u8).find(b => b.type === 'mvhd');
  if (!mvhd) return null;
  const dv = new DataView(moov.u8.buffer, mvhd.start);
  const secs = dv.getUint8(8) === 1 ? Number(dv.getBigUint64(12)) : dv.getUint32(12);
  return secs > MAC_EPOCH ? (secs - MAC_EPOCH) * 1000 : null;
}

// Ubicación GPS: los celulares Android la guardan en moov/udta/©xyz (algunos en loci).
// Mediabunny no lee ©xyz y copia mal loci, así que se copian estas cajas tal cual.
const LOCATION = new Set(['©xyz', 'loci']);
export async function readLocationBoxes(file) {
  const moov = await readMoov(file);
  const udta = moov && children(moov.u8).find(b => b.type === 'udta');
  if (!udta) return null;
  const body = moov.u8.subarray(udta.start, udta.start + udta.size);
  const parts = children(body).filter(b => LOCATION.has(b.type)).map(b => body.slice(b.start, b.start + b.size));
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

export async function convertVideo(file, plan, codec, writable, onProgress, registerCancel) {
  // Debe asignarse antes de crear el Output: ahí se construye el muxer que lee la fecha.
  globalThis.__compactaCreationTime = (await readCreationTime(file)) ?? file.lastModified;
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const output = new Output({
      format: new Mp4OutputFormat(),
      target: new StreamTarget(writable, { chunked: true }),
    });
    const conversion = await Conversion.init({
      input, output, showWarnings: false,
      video: {
        ...(plan.resize ? { width: plan.width, height: plan.height, fit: 'contain' } : {}),
        codec, bitrate: plan.bitrate, forceTranscode: true,
      },
      audio: {},
      tags: t => {
        const raw = { ...t.raw };
        for (const k of LOCATION) delete raw[k]; // la ubicación se copia aparte (injectLocation)
        return { ...t, raw, comment: `${MARK} ${codec} ${Math.round(plan.bitrate / 1000)}k` };
      },
    });
    // Nunca reemplazar un video por uno sin sonido o sin imagen.
    const lost = conversion.discardedTracks.filter(d => d.track.type === 'video' || d.track.type === 'audio');
    if (!conversion.isValid || lost.length) {
      throw new Error('Formato no compatible (' + (lost.map(d => `${d.track.type}: ${d.reason}`).join(', ') || 'sin pistas') + ')');
    }
    conversion.onProgress = onProgress;
    registerCancel?.(() => conversion.cancel());
    await conversion.execute();
  } finally {
    delete globalThis.__compactaCreationTime;
    input.dispose?.();
  }
}

export async function verifyVideo(outFile, originalDuration) {
  const meta = await probeVideo(outFile);
  if (!meta) throw new Error('El video nuevo no tiene imagen');
  if (Math.abs(meta.duration - originalDuration) > Math.max(1, originalDuration * 0.02)) {
    throw new Error(`Duración distinta (${meta.duration.toFixed(1)} s vs ${originalDuration.toFixed(1)} s)`);
  }
}
