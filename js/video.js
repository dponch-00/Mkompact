// Compactación de video con WebCodecs (Mediabunny). Experimental: lento y gasta batería.
import {
  Input, Output, Conversion, BlobSource, StreamTarget, Mp4OutputFormat, ALL_FORMATS,
  canEncodeVideo,
} from '../vendor/mediabunny/mediabunny.min.mjs';
import { MARK } from './jpeg.js';
import { readCreationTime, readLocationBoxes, injectLocation, LOCATION } from './mp4.js';

export { readLocationBoxes, injectLocation };

// Lectura completa con Mediabunny: se usa para verificar el video ya convertido.
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

export async function convertVideo(file, plan, codec, writable, onProgress, registerCancel) {
  // Debe asignarse antes de crear el Output: ahí se construye el muxer que lee la fecha.
  globalThis.__mkompactCreationTime = (await readCreationTime(file)) ?? file.lastModified;
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
    delete globalThis.__mkompactCreationTime;
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
