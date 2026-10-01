import { store } from './store.js';
import { ensurePermission, listCandidates, inspect, getDirPath, replaceFile, restore, emptyTrash, trashSize } from './fsops.js';

const $ = id => document.getElementById(id);
const LEVELS = {
  suave: { quality: 85, maxSide: 0, hint: 'Casi imperceptible. Ahorro moderado.' },
  equilibrado: { quality: 75, maxSide: 2560, hint: 'Se ve igual en el celular y en la mayoría de pantallas. Buen ahorro.' },
  maximo: { quality: 65, maxSide: 1600, hint: 'Máximo ahorro. Bien para verlas en el celular; pierde detalle al ampliar o imprimir.' },
};
const MIN_SAVING = 0.2;        // si no se ahorra al menos 20 %, se deja el original
const MIN_VIDEO = 10 * 2 ** 20; // videos de menos de 10 MB no valen la pena

const nf = new Intl.NumberFormat('es-MX');
const fmtBytes = b => {
  if (b < 1024 ** 2) return `${nf.format(Math.round(b / 1024))} KB`;
  if (b < 1024 ** 3) return `${nf.format(Math.round(b / 1024 ** 2))} MB`;
  return `${(b / 1024 ** 3).toLocaleString('es-MX', { maximumFractionDigits: 1 })} GB`;
};
const fmtTime = s => s < 60 ? `${Math.max(1, Math.round(s))} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
const li = (html) => { const e = document.createElement('li'); e.innerHTML = html; return e; };
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const state = {
  roots: [],          // { id, name, handle, ok }
  analysis: null,     // { items, counts, skip }
  calib: {},          // nivel -> Promise<{ ratio, samples: [{item, blob, size}] }>
  running: false, paused: false, stopped: false, cancelVideo: null,
};
let renderSeq = 0; // descarta cálculos de ahorro viejos si cambian las opciones mientras tanto

// ---------- Worker pool ----------
// Cada foto decodificada ocupa ~4 bytes por pixel: con poca RAM se usan menos workers.
const pool = (() => {
  const mem = navigator.deviceMemory || 4;
  const size = Math.max(1, Math.min(mem >= 8 ? 3 : 2, (navigator.hardwareConcurrency || 2) - 1));
  const idle = [], queue = [];
  let seq = 0;
  for (let i = 0; i < size; i++) {
    const w = new Worker(new URL('./photo-worker.js', import.meta.url), { type: 'module' });
    const settle = (fn, value) => { const job = w.job; w.job = null; idle.push(w); next(); job?.[fn](value); };
    w.onmessage = ({ data }) => data.ok ? settle('resolve', data) : settle('reject', new Error(data.error));
    // Si el worker no carga o se cae, el trabajo falla en vez de quedarse esperando para siempre.
    w.onerror = e => { e.preventDefault(); settle('reject', new Error(e.message || 'Falló el procesador de fotos')); };
    idle.push(w);
  }
  function next() {
    while (idle.length && queue.length) {
      const w = idle.pop();
      w.job = queue.shift();
      w.postMessage(w.job.msg);
    }
  }
  return {
    size,
    run(file, level, skipSpecial = false) {
      const { quality, maxSide } = LEVELS[level];
      return new Promise((resolve, reject) => {
        queue.push({ msg: { id: ++seq, file, quality, maxSide, skipSpecial }, resolve, reject });
        next();
      });
    },
  };
})();

// ---------- Preferencias ----------
function readOpts() {
  return {
    level: document.querySelector('input[name=level]:checked')?.value || 'equilibrado',
    photos: $('opt-photos').checked, png: $('opt-png').checked, video: $('opt-video').checked,
    motion: document.querySelector('input[name=motion]:checked').value,
    trash: $('opt-trash').checked,
  };
}
async function loadPrefs() {
  const p = await store.get('prefs', 'opts') || {};
  (document.querySelector(`input[name=level][value="${p.level}"]`) || document.querySelector('input[name=level][value=equilibrado]')).checked = true;
  if (p.photos !== undefined) $('opt-photos').checked = p.photos;
  if (p.png !== undefined) $('opt-png').checked = p.png;
  if (p.video !== undefined) $('opt-video').checked = p.video;
  if (p.trash !== undefined) $('opt-trash').checked = p.trash;
  const motion = document.querySelector(`input[name=motion][value="${p.motion}"]`);
  if (motion) motion.checked = true;
  $('level-hint').textContent = LEVELS[readOpts().level].hint;
}
document.addEventListener('change', e => {
  if (!e.target.closest('.card')) return;
  const o = readOpts();
  store.put('prefs', o, 'opts');
  $('level-hint').textContent = LEVELS[o.level].hint;
  if (state.analysis && !state.running) renderAnalysis();
});

// ---------- Carpetas ----------
async function loadRoots() {
  const saved = await store.all('roots');
  state.roots = [];
  for (const r of saved) state.roots.push({ ...r, ok: await ensurePermission(r.handle, false).catch(() => false) });
  if (new URLSearchParams(location.search).has('opfs')) {
    const handle = await (await navigator.storage.getDirectory()).getDirectoryHandle('prueba', { create: true });
    state.roots.push({ id: 'opfs', name: 'prueba (OPFS)', handle, ok: true, temp: true });
  }
  renderRoots();
}

function renderRoots() {
  const ul = $('roots');
  ul.replaceChildren(...state.roots.map(r => {
    const e = li(`<span class="name">${esc(r.name)}<small>${r.ok ? 'Con permiso' : 'Hay que volver a dar permiso'}</small></span>`);
    if (!r.ok) {
      const b = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: 'Dar permiso' });
      b.onclick = async () => { r.ok = await ensurePermission(r.handle, true).catch(() => false); renderRoots(); restoreAnalysis(); };
      e.append(b);
    }
    const x = Object.assign(document.createElement('button'), { className: 'icon', textContent: '✕', title: 'Quitar de la lista' });
    x.setAttribute('aria-label', `Quitar ${r.name}`);
    x.disabled = state.running || scanState.running;
    x.onclick = async () => {
      if (!r.temp) await store.del('roots', r.id);
      state.roots = state.roots.filter(q => q !== r);
      invalidate(); renderRoots(); restoreAnalysis();
    };
    e.append(x);
    return e;
  }));
  $('analyze').disabled = !state.roots.some(r => r.ok) || state.running;
  renderTrash();
}

$('add-root').onclick = async () => {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'mkompact', startIn: 'pictures' });
  } catch (e) { if (e.name !== 'AbortError') alert('No se pudo abrir la carpeta: ' + e.message); return; }
  for (const r of state.roots) if (await r.handle.isSameEntry(handle)) return;
  const r = { id: crypto.randomUUID(), name: handle.name, handle };
  await store.put('roots', r);
  state.roots.push({ ...r, ok: true });
  invalidate();
  renderRoots();
  restoreAnalysis(); // avisa que la carpeta nueva falta por analizar
};

function invalidate() { state.analysis = null; state.calib = {}; renderSeq++; $('analysis').hidden = true; }

// ---------- Análisis ----------
// Fase 1 lista los archivos (rápido, no los abre). Fase 2 revisa cada uno, varios a la vez: en Android
// cada lectura pasa por el sistema y es lenta, así que el paralelismo es lo que más acelera.
// Cada resultado se guarda en IndexedDB mientras avanza: si la app se recarga o se cierra, el siguiente
// análisis reutiliza lo ya revisado y un análisis terminado se muestra al instante al volver a abrir.
const SCAN_CONCURRENCY = 6;
const SLOW_TEST = Number(new URLSearchParams(location.search).get('lento')) || 0; // pruebas: simula un celular lento
const scanState = { running: false, abort: null };
const ABORTED = new Error('aborted');
const fileKey = (rootId, path, name) => `${rootId}|${path}|${name}`;
const statusKey = root => `scan:${root.id}`;

// Lo que se guarda en IndexedDB de cada archivo (sin File ni handles).
const record = (root, info) => ({
  key: fileKey(root.id, info.path, info.name), rootId: root.id,
  path: info.path, name: info.name, type: info.type, size: info.size, mtime: info.mtime,
  ...(info.type === 'photo' ? { motion: info.motion, special: info.special, pano: info.pano, hdr: info.hdr, compacted: info.compacted } : {}),
  ...('meta' in info ? { meta: info.meta } : {}),
});
const toItem = (root, rec) => ({ ...rec, root, key: `${root.id}|${rec.path}/${rec.name}|${rec.size}|${rec.mtime}` });

async function mapPool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) await fn(list[i++]); }));
}

// Interfaz del progreso del análisis (con actualizaciones agrupadas por cuadro para no frenar).
const scanUi = {
  show(on) {
    $('scan').hidden = !on; $('analyze').hidden = on;
    if (on) $('scan-note').hidden = true;
    $('add-root').disabled = on || state.running;
  },
  phase(text) { $('scan-phase').textContent = text; },
  listing(rootName, path, n) {
    $('scan-bar').classList.add('indeterminate');
    this.phase(`Buscando archivos en ${rootName}…`);
    $('scan-count').textContent = `${nf.format(n)} archivos encontrados`;
    $('scan-eta').textContent = '';
    $('scan-file').textContent = path || rootName;
  },
  pending: null,
  inspect(done, total, name, t0, label = 'Revisando fotos y videos') {
    this.pending = { done, total, name, t0, label };
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const { done, total, name, t0, label } = this.pending;
      $('scan-bar').classList.remove('indeterminate');
      this.phase(label);
      $('scan-fill').style.width = `${total ? done / total * 100 : 100}%`;
      $('scan-count').textContent = `${nf.format(done)} de ${nf.format(total)} · ${total ? Math.floor(done / total * 100) : 100} %`;
      const el = (performance.now() - t0) / 1000;
      $('scan-eta').textContent = done > 20 && el > 3 ? `faltan ≈ ${fmtTime(el / done * (total - done))}` : '';
      $('scan-file').textContent = name;
    });
  },
};

$('analyze').onclick = () => analyze();
$('scan-stop').onclick = () => scanState.abort?.abort();

async function analyze() {
  if (scanState.running || state.running) return;
  invalidate();
  $('done').hidden = true;
  const o = readOpts();
  const ac = new AbortController();
  Object.assign(scanState, { running: true, abort: ac });
  scanUi.show(true);
  await keepAwake(true);
  try {
    const roots = state.roots.filter(r => r.ok);
    const lists = [];
    let found = 0;
    for (const r of roots) {
      const res = await listCandidates(r.handle, (path, n) => scanUi.listing(r.name, path, found + n), ac.signal);
      if (ac.signal.aborted) throw ABORTED;
      found += res.counts.files;
      lists.push({ r, ...res });
      await store.put('prefs', { complete: false, total: res.found.length, files: res.counts.files, heic: res.counts.heic, at: Date.now() }, statusKey(r));
    }
    const total = lists.reduce((n, l) => n + l.found.length, 0);
    const t0 = performance.now();
    let done = 0;
    for (const { r, found: cands, counts } of lists) {
      const cached = new Map((await store.byIndex('files', 'root', r.id)).map(e => [e.key, e]));
      const seen = new Set(), batch = [];
      let lastFlush = performance.now();
      const flush = async () => { lastFlush = performance.now(); if (batch.length) await store.putMany('files', batch.splice(0)); };
      scanState.flush = flush;
      await mapPool(cands, SCAN_CONCURRENCY, async c => {
        if (ac.signal.aborted) return;
        const key = fileKey(r.id, c.path, c.name);
        seen.add(key);
        if (SLOW_TEST && !cached.has(key)) await new Promise(res => setTimeout(res, SLOW_TEST));
        try {
          const { info, fresh } = await inspect(c, cached.get(key), o.video);
          if (info && fresh) batch.push(record(r, info));
        } catch { /* archivo ilegible: se omite */ }
        done++;
        scanUi.inspect(done, total, c.name, t0);
        if (batch.length >= 25 || performance.now() - lastFlush > 500) await flush();
      });
      await flush();
      if (ac.signal.aborted) throw ABORTED;
      // Lo que estaba guardado pero ya no existe en la carpeta
      const gone = [...cached.keys()].filter(k => !seen.has(k));
      if (gone.length) await store.delMany('files', gone);
      await store.put('prefs', { complete: true, total: cands.length, files: counts.files, heic: counts.heic, at: Date.now() }, statusKey(r));
    }
    await restoreAnalysis();
  } catch (e) {
    if (e === ABORTED) await restoreAnalysis();
    else alert('Error al revisar: ' + e.message);
  } finally {
    Object.assign(scanState, { running: false, flush: null });
    scanUi.show(false);
    if (!state.running) await keepAwake(false);
  }
}
// Si la app pasa a segundo plano (cambiar de app, apagar pantalla) se guarda lo revisado de inmediato.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') scanState.flush?.(); });

// Muestra el último análisis guardado sin volver a leer las carpetas. Si alguno quedó a medias,
// ofrece continuarlo (lo ya revisado no se repite).
async function restoreAnalysis() {
  const roots = state.roots.filter(r => r.ok);
  if (!roots.length) return;
  const items = [], counts = { files: 0, heic: 0 };
  let at = 0, missing = 0;
  const partial = [];
  for (const r of roots) {
    const st = await store.get('prefs', statusKey(r));
    if (!st) { missing++; continue; }
    const recs = await store.byIndex('files', 'root', r.id);
    if (!st.complete) { partial.push({ r, done: recs.length, total: st.total, reason: st.reason }); continue; }
    for (const rec of recs) items.push(toItem(r, rec));
    counts.files += st.files || 0; counts.heic += st.heic || 0;
    at = Math.max(at, st.at || 0);
  }
  const note = $('scan-note');
  if (partial.length || missing) {
    const done = partial.reduce((n, p) => n + p.done, 0), tot = partial.reduce((n, p) => n + p.total, 0);
    note.textContent = partial.some(p => p.reason === 'restore')
      ? 'Se restauraron originales: vuelve a analizar para actualizar las cifras (lo demás no se repite).'
      : partial.length
        ? `El análisis quedó a medias (${nf.format(done)} de ${nf.format(tot)} archivos revisados). Al continuar no se repite lo ya revisado.`
        : 'Hay carpetas nuevas sin analizar.';
    note.hidden = false;
    $('analyze').textContent = partial.length ? 'Continuar análisis' : 'Analizar carpetas';
    return;
  }
  note.hidden = true;
  state.analysis = { items, counts, skip: new Set(await store.keys('skip')), at };
  $('analyze').textContent = 'Volver a analizar';
  await renderAnalysis();
}

// Las carpetas guardadas solo tienen ruta y nombre: se busca el archivo justo antes de usarlo.
const dirCache = new Map();
async function resolveItem(item) {
  if (item.file && item.dir) return item;
  const dk = `${item.root.id}|${item.path}`;
  let dir = dirCache.get(dk);
  if (!dir) { dir = await getDirPath(item.root.handle, item.path, false); dirCache.set(dk, dir); }
  item.dir = dir;
  item.file = await (await dir.getFileHandle(item.name)).getFile();
  item.size = item.file.size;
  return item;
}

// Si se activan los videos después de un análisis sin ellos, se miden solo esos (con progreso).
async function measureVideos(videos) {
  const { quickProbe } = await import('./mp4.js');
  scanState.running = true;
  scanUi.show(true);
  scanUi.phase('Midiendo videos');
  $('scan-stop').hidden = true; // medir videos es rápido: no se ofrece detener
  const t0 = performance.now();
  let done = 0;
  const batch = [];
  try {
    await mapPool(videos, SCAN_CONCURRENCY, async v => {
      try {
        await resolveItem(v);
        v.meta = await quickProbe(v.file).catch(() => null);
      } catch { v.meta = null; }
      batch.push(record(v.root, v));
      scanUi.inspect(++done, videos.length, v.name, t0, 'Midiendo videos');
    });
    await store.putMany('files', batch);
  } finally {
    scanState.running = false;
    scanUi.show(false);
    $('scan-stop').hidden = false;
  }
}

// Qué archivos se procesarían con las opciones actuales.
function selection(o) {
  const { items, skip } = state.analysis;
  const photos = [], videos = [];
  const stats = { compacted: 0, compactedVideo: 0, motion: 0, pano: 0, remembered: 0 };
  for (const it of items) {
    if (it.type === 'photo' || it.type === 'png') {
      if (it.type === 'photo' ? !o.photos : !o.png) continue;
      if (it.compacted) { stats.compacted++; continue; }
      if (it.pano) { stats.pano++; continue; } // al reducirla perdería la vista 360°
      if ((it.motion || it.special) && o.motion === 'skip') { stats.motion++; continue; }
      if (skip.has(`${it.key}|${o.level}`)) { stats.remembered++; continue; }
      if (it.size < 150 * 1024) continue; // ya es pequeña
      photos.push(it);
    } else if (it.type === 'video' && o.video) {
      if (!it.meta || it.size < MIN_VIDEO) continue;
      if (it.meta.compacted) { stats.compactedVideo++; continue; }
      if (skip.has(`${it.key}|${o.level}`)) { stats.remembered++; continue; }
      videos.push(it);
    }
  }
  return { photos, videos, stats };
}

async function renderAnalysis() {
  const seq = ++renderSeq;
  const o = readOpts();
  if (o.video && !scanState.running) {
    const unmeasured = state.analysis.items.filter(i => i.type === 'video' && i.size >= MIN_VIDEO && i.meta === undefined);
    if (unmeasured.length) {
      $('analysis').hidden = true;
      await measureVideos(unmeasured);
      if (seq !== renderSeq || !state.analysis) return;
    }
  }
  const { photos, videos, stats } = selection(o);
  const { counts, at } = state.analysis;
  $('analysis').hidden = false;
  const facts = [];
  const when = at ? new Date(at).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  facts.push(`<b>${nf.format(counts.files)}</b> archivos revisados${when ? ` (análisis del ${when})` : ''}`);
  if (o.photos || o.png) facts.push(`<b>${nf.format(photos.length)}</b> fotos para compactar (${fmtBytes(sum(photos))})`);
  if (o.video) facts.push(`<b>${nf.format(videos.length)}</b> videos para compactar (${fmtBytes(sum(videos))})`);
  if (stats.compacted) facts.push(`${nf.format(stats.compacted)} fotos ya estaban compactadas`);
  if (stats.compactedVideo) facts.push(`${nf.format(stats.compactedVideo)} videos ya estaban compactados`);
  if (stats.motion) facts.push(`${nf.format(stats.motion)} fotos en movimiento o de retrato se dejan igual (cámbialo en Opciones)`);
  if (stats.pano) facts.push(`${nf.format(stats.pano)} fotos 360° se dejan igual`);
  if (stats.remembered) facts.push(`${nf.format(stats.remembered)} archivos ya no se podían reducir más`);
  if (counts.heic) facts.push(`${nf.format(counts.heic)} fotos HEIC no se pueden procesar en el navegador`);
  const hdr = photos.filter(p => p.hdr).length;
  if (hdr) facts.push(`${nf.format(hdr)} fotos Ultra HDR quedarán en versión normal (sin brillo HDR)`);
  $('facts').replaceChildren(...facts.map(li));

  const total = photos.length + videos.length;
  $('run').textContent = total ? `Compactar ${nf.format(total)} archivos` : 'Nada que compactar';
  $('run').disabled = !total;
  $('preview-btn').hidden = !photos.length;

  if (!total) { $('saving').innerHTML = 'Todo está compacto.<small>No hay nada que reducir con estas opciones.</small>'; return; }
  $('saving').innerHTML = `Calculando el ahorro…<small>Probando con algunas fotos</small>`;
  const videoEst = await estimateVideos(videos, o.level);
  const calib = photos.length ? await calibrate(photos, o.level) : null;
  if (seq !== renderSeq) return; // cambiaron las opciones mientras calculaba
  const photoOut = calib ? sum(photos) * calib.ratio : 0;
  const before = sum(photos) + sum(videos);
  const after = photoOut + videoEst;
  $('saving').innerHTML = `Liberarías ≈ ${fmtBytes(before - after)}<small>${fmtBytes(before)} → ≈ ${fmtBytes(after)}${calib ? ` · las fotos quedan en ≈ ${Math.round(calib.ratio * 100)} % de su tamaño` : ''}</small>`;
}

const sum = arr => arr.reduce((n, i) => n + i.size, 0);

async function estimateVideos(videos, level) {
  if (!videos.length) return 0;
  const { planVideo, pickCodec } = await import('./video.js');
  const hevc = (await pickCodec()) === 'hevc';
  return videos.reduce((n, v) => n + Math.min(v.size, planVideo(v.meta, level, hevc).estimated), 0);
}

// MKompact de verdad unas cuantas fotos (sin guardarlas) para estimar el ahorro y para la vista previa.
// Se guarda la promesa: si la vista previa la pide mientras se calcula, no se repite el trabajo.
function calibrate(photos, level) {
  return (state.calib[level] ??= calibrateNow(photos, level));
}
async function calibrateNow(photos, level) {
  const n = Math.min(4, photos.length);
  const picks = Array.from({ length: n }, (_, i) => photos[Math.floor((i + 0.5) * photos.length / n)]);
  const samples = await Promise.all(picks.map(async item => {
    try {
      await resolveItem(item);
      const r = await pool.run(item.file, level, readOpts().motion === 'skip');
      if (!r.buffer) return null;
      return { item, blob: new Blob([r.buffer], { type: 'image/jpeg' }), size: r.buffer.byteLength };
    } catch { return null; }
  }));
  const ok = samples.filter(Boolean);
  // Las que no bajarían al menos 20 % se quedan igual: cuentan como tamaño completo.
  const ratio = ok.length
    ? ok.reduce((a, s) => { const r = s.size / s.item.size; return a + (r <= 1 - MIN_SAVING ? r : 1); }, 0) / ok.length
    : 0.5;
  return { ratio, samples: ok };
}

// ---------- Vista previa ----------
let pvIndex = 0, pvUrls = [];
$('preview-btn').onclick = async () => {
  const o = readOpts();
  const { photos } = selection(o);
  const calib = await calibrate(photos, o.level);
  if (!calib.samples.length) return alert('No se pudo generar la vista previa.');
  showSample(calib.samples[pvIndex % calib.samples.length]);
  $('preview').showModal();
};
$('pv-next').onclick = async () => {
  const { samples } = await state.calib[readOpts().level];
  showSample(samples[++pvIndex % samples.length]);
};
$('pv-close').onclick = () => $('preview').close();
$('preview').addEventListener('close', () => { pvUrls.forEach(URL.revokeObjectURL); pvUrls = []; });
function showSample(s) {
  pvUrls.forEach(URL.revokeObjectURL);
  pvUrls = [URL.createObjectURL(s.item.file), URL.createObjectURL(s.blob)];
  $('pv-before').src = pvUrls[0];
  $('pv-after').src = pvUrls[1];
  $('pv-name').textContent = s.item.name;
  const pct = Math.round((1 - s.size / s.item.size) * 100);
  $('pv-sizes').textContent = pct >= MIN_SAVING * 100
    ? `${fmtBytes(s.item.size)} → ${fmtBytes(s.size)} (−${pct} %)`
    : `${fmtBytes(s.item.size)} · ya está comprimida: se dejará igual`;
}
$('pv-slider').oninput = e => {
  const v = e.target.value;
  $('pv-before-clip').style.clipPath = `inset(0 ${100 - v}% 0 0)`;
  $('pv-divider').style.left = `${v}%`;
};
$('pv-zoom').onclick = () => {
  const z = $('pv-stage').classList.toggle('zoom');
  $('pv-zoom').textContent = z ? 'Ajustar a pantalla' : 'Ver al 100 %';
};

// ---------- Confirmación ----------
function confirmDialog(text, title = '', fatal = false) {
  $('confirm-title').textContent = title;
  $('confirm-title').classList.toggle('fatal', fatal);
  $('confirm-text').textContent = text;
  const d = $('confirm');
  d.showModal();
  return new Promise(res => {
    $('confirm-yes').onclick = () => { d.close(); res(true); };
    $('confirm-no').onclick = () => { d.close(); res(false); };
    d.oncancel = () => res(false);
  });
}

// ---------- Proceso ----------
$('run').onclick = async () => {
  const o = readOpts();
  const { photos, videos } = selection(o);
  const n = photos.length + videos.length;
  const ok = await confirmDialog(o.trash
    ? `Se van a compactar ${nf.format(n)} archivos.\n\nLos originales se guardan en la papelera de MKompact: podrás revisar el resultado y restaurarlos. El espacio se libera cuando vacíes la papelera.`
    : `Se van a compactar ${nf.format(n)} archivos.\n\n⚠️ Los originales se BORRARÁN en cuanto se verifique cada copia. No se podrán recuperar.`,
    'Round 1', !o.trash);
  if (ok) process(photos, videos, o);
};
$('pause').onclick = () => {
  state.paused = !state.paused;
  $('pause').textContent = state.paused ? 'Continuar' : 'Pausar';
  if (!state.paused) resumeWaiters.splice(0).forEach(f => f());
};
$('stop').onclick = () => { state.stopped = true; state.paused = false; resumeWaiters.splice(0).forEach(f => f()); state.cancelVideo?.(); };
const resumeWaiters = [];
const waitIfPaused = () => state.paused ? new Promise(r => resumeWaiters.push(r)) : null;

// Anuncio de inicio: dura ~1 s y no bloquea nada (pointer-events: none).
function fight() {
  const f = $('fight');
  f.classList.remove('show');
  void f.offsetWidth; // reinicia la animación si se vuelve a pelear
  f.classList.add('show');
  clearTimeout(fight.t);
  fight.t = setTimeout(() => f.classList.remove('show'), 1200);
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* no disponible */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (state.running || scanState.running)) { wakeLock = null; keepAwake(true); }
});
// Pedir confirmación si se intenta recargar o salir a media tarea.
addEventListener('beforeunload', e => {
  if (state.running || scanState.running) { e.preventDefault(); e.returnValue = ''; }
});

async function process(photos, videos, o) {
  Object.assign(state, { running: true, paused: false, stopped: false });
  $('analysis').hidden = true; $('done').hidden = true; $('progress').hidden = false;
  $('analyze').disabled = true; $('add-root').disabled = true;
  $('pause').textContent = 'Pausar';
  fight();
  await keepAwake(true);

  const total = photos.length + videos.length;
  const totalBytes = sum(photos) + sum(videos);
  const r = { done: 0, bytesDone: 0, saved: 0, skipped: 0, ignored: 0, errors: [] };
  const t0 = performance.now();
  const update = (name, frac = 0) => {
    const doneBytes = r.bytesDone + frac;
    $('bar-fill').style.width = `${(doneBytes / totalBytes) * 100}%`;
    $('prog-count').textContent = `${nf.format(r.done)} de ${nf.format(total)}`;
    const el = (performance.now() - t0) / 1000;
    $('prog-eta').textContent = doneBytes > 0 && el > 5 ? `faltan ≈ ${fmtTime(el / doneBytes * (totalBytes - doneBytes))}` : '';
    if (name) $('prog-file').textContent = name;
    $('prog-saved').textContent = `Ahorrado: ${fmtBytes(r.saved)}`;
  };
  update('Preparando…');

  const finish = async (item, res) => {
    r.done++; r.bytesDone += item.size;
    if (res.error) r.errors.push(`${item.path ? item.path + '/' : ''}${item.name}: ${res.error}`);
    else if (res.ignored) r.ignored++;
    else if (res.skipped) { r.skipped++; await store.put('skip', 1, `${item.key}|${o.level}`); }
    else {
      r.saved += item.size - res.newSize;
      // El análisis guardado se actualiza al momento: si la app se cierra, no se vuelve a procesar.
      const oldKey = fileKey(item.root.id, item.path, item.name);
      if (res.finalName !== item.name) await store.del('files', oldKey);
      await store.put('files', record(item.root, {
        ...item, name: res.finalName, size: res.newSize, mtime: res.newMtime,
        type: item.type === 'png' ? 'photo' : item.type,
        compacted: true, motion: false, special: false, pano: false, hdr: false,
        ...(item.type === 'video' ? { meta: { ...item.meta, compacted: true } } : {}),
      }));
      if (res.trashPath) {
        await store.put('trash', {
          rootId: item.root.id, path: item.path, name: item.name, finalName: res.finalName,
          trashPath: res.trashPath, origSize: item.size, newSize: res.newSize, date: Date.now(),
        });
      }
    }
    update();
  };

  // Fotos: se comprimen en paralelo (workers) y se reemplazan una por una.
  let idx = 0;
  const photoLane = async () => {
    while (idx < photos.length && !state.stopped) {
      await waitIfPaused();
      if (state.stopped) break;
      const item = photos[idx++];
      update(item.name);
      await finish(item, await doPhoto(item, o).catch(e => ({ error: e.message })));
    }
  };
  await Promise.all(Array.from({ length: pool.size }, photoLane));

  // Videos: de uno en uno (el codificador del teléfono es uno solo).
  if (videos.length && !state.stopped) {
    const vmod = await import('./video.js');
    for (const item of videos) {
      await waitIfPaused();
      if (state.stopped) break;
      update(`🎬 ${item.name}`);
      const res = await doVideo(item, o, vmod, p => update(`🎬 ${item.name} · ${Math.round(p * 100)} %`, item.size * p))
        .catch(e => ({ error: state.stopped ? 'Detenido' : e.message }));
      state.cancelVideo = null;
      await finish(item, res);
    }
  }

  await keepAwake(false);
  Object.assign(state, { running: false });
  $('progress').hidden = true; $('done').hidden = false;
  $('analyze').disabled = false; $('add-root').disabled = false;
  const banner = state.stopped ? ['Ronda detenida', ' lost'] : r.errors.length ? ['Victory', ''] : ['Flawless victory', ''];
  $('done-title').innerHTML = `<span class="victory${banner[1]}">${banner[0]}</span>Ahorraste ${fmtBytes(r.saved)}<small>${o.trash ? 'Vacía la papelera de MKompact (abajo) para liberar el espacio.' : 'El espacio ya quedó libre.'}</small>`;
  const facts = [`<b>${nf.format(r.done - r.skipped - r.ignored - r.errors.length)}</b> archivos compactados`];
  if (r.skipped) facts.push(`${nf.format(r.skipped)} se dejaron igual porque no bajaban al menos ${MIN_SAVING * 100} %`);
  if (r.ignored) facts.push(`${nf.format(r.ignored)} se saltaron (ya compactadas, en movimiento o 360°)`);
  if (state.stopped && r.done < total) facts.push(`${nf.format(total - r.done)} quedaron pendientes`);
  $('done-facts').replaceChildren(...facts.map(li));
  $('errors').hidden = !r.errors.length;
  $('errors').querySelector('summary').textContent = `${r.errors.length} con error (el original quedó intacto)`;
  $('error-list').replaceChildren(...r.errors.map(t => { const e = document.createElement('li'); e.textContent = t; return e; }));
  state.analysis = null; state.calib = {};
  renderTrash();
  await restoreAnalysis(); // muestra lo que falta, ya con lo compactado descontado
}

async function doPhoto(item, o) {
  await resolveItem(item);
  const res = await pool.run(item.file, o.level, o.motion === 'skip');
  if (res.ignored) return { ignored: res.ignored };
  const out = res.buffer;
  if (out.byteLength > item.size * (1 - MIN_SAVING)) return { skipped: true };
  return replaceFile({
    root: item.root.handle, item, keepOriginal: o.trash,
    write: w => w.write(out),
    verify: async f => {
      if (f.size !== out.byteLength) throw new Error('La copia no se guardó completa');
      (await createImageBitmap(f)).close();
    },
  });
}

async function doVideo(item, o, vmod, onProgress) {
  await resolveItem(item);
  const size = vmod.planVideo(item.meta, o.level, false);
  const codec = await vmod.pickCodec(size.width, size.height);
  if (!codec) throw new Error(`Este teléfono no puede codificar video de ${size.width}×${size.height}`);
  const plan = vmod.planVideo(item.meta, o.level, codec === 'hevc');
  if (plan.estimated > item.size * (1 - MIN_SAVING)) return { skipped: true };
  const gps = await vmod.readLocationBoxes(item.file).catch(() => null);
  const res = await replaceFile({
    root: item.root.handle, item, keepOriginal: o.trash,
    write: w => vmod.convertVideo(item.file, plan, codec, w, onProgress, c => { state.cancelVideo = c; }),
    finalize: tmp => gps && vmod.injectLocation(tmp, gps),
    verify: async f => {
      if (f.size > item.size * (1 - MIN_SAVING)) throw new Error('No se redujo lo suficiente');
      await vmod.verifyVideo(f, item.meta.duration);
    },
  }).catch(e => {
    if (e.message === 'No se redujo lo suficiente') return { skipped: true };
    throw e;
  });
  return res;
}

// ---------- Papelera ----------
async function renderTrash() {
  const rows = [];
  for (const r of state.roots.filter(r => r.ok)) {
    const recs = await store.byIndex('trash', 'root', r.id);
    const size = recs.reduce((n, x) => n + (x.origSize || 0), 0) || await trashSize(r.handle);
    if (!size) continue;
    const e = li(`<span class="name">${esc(r.name)}<small>${fmtBytes(size)} en originales</small></span>`);
    const restoreBtn = Object.assign(document.createElement('button'), { className: 'btn secondary', textContent: 'Restaurar' });
    const emptyBtn = Object.assign(document.createElement('button'), { className: 'btn danger', textContent: 'Vaciar' });
    restoreBtn.onclick = async () => {
      const recs = await store.byIndex('trash', 'root', r.id);
      if (!await confirmDialog(`¿Regresar ${nf.format(recs.length)} originales a su lugar? Se quitarán sus versiones compactas.`, 'Restaurar')) return;
      restoreBtn.disabled = emptyBtn.disabled = true;
      let fails = 0;
      for (const rec of recs) {
        try { await restore(r.handle, rec); await store.del('trash', rec.id); } catch (e) {
          if (e.name === 'NotFoundError') await store.del('trash', rec.id); // el original ya no está en la papelera
          else fails++;
        }
      }
      if (fails) alert(`${fails} no se pudieron restaurar (quizá se movieron o borraron).`);
      if (!fails) await emptyTrash(r.handle);
      // Los originales regresaron: el análisis guardado de esta carpeta ya no corresponde.
      await store.delMany('files', recs.map(x => fileKey(r.id, x.path, x.finalName)));
      const st = await store.get('prefs', statusKey(r));
      if (st) await store.put('prefs', { ...st, complete: false, reason: 'restore' }, statusKey(r));
      invalidate(); renderTrash(); restoreAnalysis();
    };
    emptyBtn.onclick = async () => {
      if (!await confirmDialog(`¿Borrar definitivamente ${fmtBytes(size)} de originales de "${r.name}"?\n\nYa no podrás restaurarlos.`, 'Fatality', true)) return;
      restoreBtn.disabled = emptyBtn.disabled = true;
      await emptyTrash(r.handle);
      for (const rec of await store.byIndex('trash', 'root', r.id)) await store.del('trash', rec.id);
      renderTrash();
    };
    e.append(restoreBtn, emptyBtn);
    rows.push(e);
  }
  $('trash-list').replaceChildren(...rows);
  $('trash-card').hidden = !rows.length;
}

// ---------- Inicio ----------
if (!('showDirectoryPicker' in window) && !new URLSearchParams(location.search).has('opfs')) {
  $('unsupported').hidden = false;
  $('add-root').disabled = true;
}
// ---------- Actualizaciones ----------
const versionLabel = v => v ? v.replace('mkompact-', '') : 'sin instalar';
async function installedVersion() {
  try { return (await caches.keys()).find(k => k.startsWith('mkompact-')) || null; } catch { return null; }
}
async function showVersion() { $('version').textContent = `Versión instalada: ${versionLabel(await installedVersion())}`; }

$('update-check').onclick = async () => {
  const st = $('update-status');
  if (state.running || scanState.running) { st.textContent = 'Espera a que termine el proceso actual.'; return; }
  $('update-check').disabled = true;
  st.textContent = 'Buscando…';
  try {
    const txt = await (await fetch(`sw.js?t=${Date.now()}`, { cache: 'no-store' })).text();
    const latest = /VERSION = '([^']+)'/.exec(txt)?.[1];
    const current = await installedVersion();
    if (latest && latest !== current) {
      st.textContent = `Hay una versión nueva (${versionLabel(latest)}). Instalándola…`;
      await cleanInstall();
      return;
    }
    st.textContent = `Ya tienes la versión más reciente (${versionLabel(current || latest)}).`;
    $('update-reinstall').hidden = false;
  } catch {
    st.textContent = 'No se pudo revisar: ¿hay conexión a internet?';
  } finally {
    $('update-check').disabled = false;
  }
};
$('update-reinstall').onclick = () => cleanInstall();
$('update-apply').onclick = () => location.reload();

let reloading = false;
const activated = w => new Promise(res => {
  if (w.state === 'activated' || w.state === 'redundant') return res();
  w.addEventListener('statechange', () => { if (w.state === 'activated' || w.state === 'redundant') res(); });
});
// Instalación limpia: si hay versión nueva, el service worker nuevo baja todo saltándose la caché del
// navegador; si es la misma, se le pide borrar lo guardado y volver a bajarlo. Después se recarga.
// No toca IndexedDB: las carpetas, la papelera y el análisis se conservan.
async function cleanInstall() {
  if (state.running || scanState.running) return;
  reloading = true;
  $('update-status').textContent = 'Descargando la versión más reciente…';
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.update();
      const fresh = reg.installing || reg.waiting;
      if (fresh) await activated(fresh);
      else if (navigator.serviceWorker.controller) {
        await new Promise(res => {
          const onMsg = e => { if (e.data === 'reinstalled') { navigator.serviceWorker.removeEventListener('message', onMsg); res(); } };
          navigator.serviceWorker.addEventListener('message', onMsg);
          navigator.serviceWorker.controller.postMessage('reinstall');
          setTimeout(res, 60000);
        });
      }
    }
  } catch { /* aunque algo falle, la recarga trae lo de la red */ }
  location.reload();
}

async function startServiceWorker() {
  // En la PC (localhost) solo con ?sw, para que los cambios en desarrollo se vean sin caché.
  const local = location.hostname === 'localhost' && new URLSearchParams(location.search).has('sw');
  if (!('serviceWorker' in navigator) || (location.protocol !== 'https:' && !local)) return;
  const hadController = !!navigator.serviceWorker.controller;
  // Si se instala una versión nueva con la app abierta, se avisa en vez de mezclar versiones.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloading) $('update-banner').hidden = false;
    showVersion();
  });
  await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}

await loadPrefs();
await loadRoots();
await restoreAnalysis();
showVersion();
startServiceWorker();
window.__mkompact = { state, analyze, selection, readOpts, restoreAnalysis }; // para pruebas
