import { store, dbEvents } from './store.js';
import {
  ensurePermission, listCandidates, inspect, getDirPath, replaceFile, restore, emptyTrash, trashSize, TRASH, RECORD_V, typeOf,
  dateFromName,
} from './fsops.js';
import { $, nf, fmtBytes, fmtTime, esc, li } from './util.js';
import { createThumbs } from './thumbs.js';
import { createNight } from './night.js';
import { createGallery } from './gallery.js';

const LEVELS = {
  suave: { quality: 85, maxSide: 0, hint: 'Casi imperceptible. Ahorro moderado.' },
  equilibrado: { quality: 75, maxSide: 2560, hint: 'Se ve igual en el celular y en la mayoría de pantallas. Buen ahorro.' },
  maximo: { quality: 65, maxSide: 1600, hint: 'Máximo ahorro. Bien para verlas en el celular; pierde detalle al ampliar o imprimir.' },
};
const MIN_SAVING = 0.2;          // si no se ahorra al menos 20 %, se deja el original
const MIN_VIDEO = 10 * 2 ** 20;  // videos de menos de 10 MB no valen la pena
const MIN_PHOTO = 150 * 1024;    // fotos de menos de 150 KB ya son pequeñas

const state = {
  roots: [],              // { id, name, handle, ok }
  analysis: null,         // { items, counts, skip, at }
  calib: {},              // nivel+motor -> Promise<{ ratio, samples }>
  protect: new Set(),     // fileKey de archivos protegidos
  trashMap: new Map(),    // fileKey de la versión compactada -> registro de papelera
  running: false, stopped: false, cancelVideo: null,
};
let renderSeq = 0; // descarta cálculos de ahorro viejos si cambian las opciones mientras tanto
const sum = arr => arr.reduce((n, i) => n + i.size, 0);
const fileKey = (rootId, path, name) => `${rootId}|${path}|${name}`;

// ---------- Pausa (botón, o automática al salir de la app) ----------
const gate = {
  paused: false, auto: false, waiters: [], pausedAt: 0, pausedTotal: 0,
  pause(auto = false) {
    if (this.paused) return;
    Object.assign(this, { paused: true, auto, pausedAt: performance.now() });
    pauseUi();
  },
  resume() {
    if (!this.paused) return;
    this.pausedTotal += performance.now() - this.pausedAt;
    Object.assign(this, { paused: false, auto: false });
    this.waiters.splice(0).forEach(f => f());
    pauseUi();
  },
  wait() { return this.paused ? new Promise(r => this.waiters.push(r)) : null; },
  elapsed(t0) { return (performance.now() - t0 - this.pausedTotal - (this.paused ? performance.now() - this.pausedAt : 0)) / 1000; },
  reset() { Object.assign(this, { paused: false, auto: false, pausedTotal: 0 }); this.waiters.splice(0).forEach(f => f()); },
};
function pauseUi() {
  const text = !gate.paused ? '' : gate.auto
    ? 'En pausa porque saliste de la app. Continúa sola cuando regreses.'
    : 'En pausa.';
  for (const id of ['pause-note', 'scan-pause-note']) { $(id).textContent = text; $(id).hidden = !gate.paused; }
  $('pause').textContent = gate.paused ? 'Continuar' : 'Pausar';
  $('scan-pause').textContent = gate.paused ? 'Continuar' : 'Pausar';
}
// Al salir de la app (cambiar de app, apagar la pantalla) se pausa en un punto seguro y se guarda
// lo hecho; al volver continúa sola. En Modo noche la app sigue visible, así que no se pausa.
document.addEventListener('visibilitychange', () => {
  const busy = state.running || scanState.running;
  if (document.visibilityState === 'hidden') {
    scanState.flush?.();
    saveJob();
    if (busy && !gate.paused) gate.pause(true);
  } else {
    if (gate.auto) gate.resume();
    if (busy) { wakeLock = null; keepAwake(true); }
  }
});
addEventListener('pagehide', () => { scanState.flush?.(); saveJob(true); });
addEventListener('beforeunload', e => {
  if (state.running || scanState.running) { e.preventDefault(); e.returnValue = ''; }
});

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
  const send = msg => new Promise((resolve, reject) => { queue.push({ msg: { id: ++seq, ...msg }, resolve, reject }); next(); });
  return {
    size,
    run(file, o, skipSpecial = false) {
      const { quality, maxSide } = LEVELS[o.level];
      return send({ file, quality, maxSide, skipSpecial, engine: o.engine });
    },
    thumb: file => send({ type: 'thumb', file, size: 320 }),
  };
})();

// ---------- Preferencias ----------
function readOpts() {
  return {
    level: document.querySelector('input[name=level]:checked')?.value || 'equilibrado',
    photos: $('opt-photos').checked, png: $('opt-png').checked, video: $('opt-video').checked,
    motion: document.querySelector('input[name=motion]:checked').value,
    trash: $('opt-trash').checked,
    engine: $('opt-mozjpeg').checked ? 'mozjpeg' : 'native',
  };
}
async function loadPrefs() {
  const p = await store.get('prefs', 'opts') || {};
  (document.querySelector(`input[name=level][value="${p.level}"]`) || document.querySelector('input[name=level][value=equilibrado]')).checked = true;
  if (p.photos !== undefined) $('opt-photos').checked = p.photos;
  if (p.png !== undefined) $('opt-png').checked = p.png;
  if (p.video !== undefined) $('opt-video').checked = p.video;
  if (p.trash !== undefined) $('opt-trash').checked = p.trash;
  $('opt-mozjpeg').checked = p.engine === 'mozjpeg';
  const motion = document.querySelector(`input[name=motion][value="${p.motion}"]`);
  if (motion) motion.checked = true;
  $('level-hint').textContent = LEVELS[readOpts().level].hint;
}
document.addEventListener('change', e => {
  if (!e.target.closest('main .card')) return;
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
const scanState = { running: false, abort: null, flush: null };
const ABORTED = new Error('aborted');
const statusKey = root => `scan:${root.id}`;

// Lo que se guarda en IndexedDB de cada archivo (sin File ni handles).
const record = (root, info) => ({
  v: RECORD_V, key: fileKey(root.id, info.path, info.name), rootId: root.id,
  path: info.path, name: info.name, type: info.type, size: info.size, mtime: info.mtime, taken: info.taken || info.mtime,
  ...(info.type === 'photo' ? { motion: info.motion, special: info.special, pano: info.pano, hdr: info.hdr, compacted: info.compacted } : {}),
  ...('meta' in info ? { meta: info.meta } : {}),
});
// fk = clave del archivo; key = clave para recordar los que "no se pudieron reducir" (cambia si el archivo cambia)
// Los análisis hechos con versiones anteriores no guardaban la fecha: se toma del nombre o del archivo.
const toItem = (root, rec) => ({
  ...rec, root, fk: rec.key, key: `${root.id}|${rec.path}/${rec.name}|${rec.size}|${rec.mtime}`,
  taken: rec.taken || dateFromName(rec.name) || rec.mtime || 0,
});

async function mapPool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) await fn(list[i++]); }));
}

// Interfaz del progreso del análisis (con actualizaciones agrupadas por cuadro para no frenar).
const scanUi = {
  text: '',
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
    this.text = `Buscando archivos · ${nf.format(n)}`;
  },
  pending: null,
  inspect(done, total, name, t0, label = 'Revisando fotos y videos') {
    this.pending = { done, total, name, t0, label };
    const el = gate.elapsed(t0);
    const eta = done > 20 && el > 3 ? `faltan ≈ ${fmtTime(el / done * (total - done))}` : '';
    this.text = `${label} · ${nf.format(done)} de ${nf.format(total)}${eta ? ' · ' + eta : ''}`;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const { done, total, name, t0, label } = this.pending;
      $('scan-bar').classList.remove('indeterminate');
      this.phase(label);
      $('scan-fill').style.width = `${total ? done / total * 100 : 100}%`;
      $('scan-count').textContent = `${nf.format(done)} de ${nf.format(total)} · ${total ? Math.floor(done / total * 100) : 100} %`;
      const el = gate.elapsed(t0);
      $('scan-eta').textContent = done > 20 && el > 3 ? `faltan ≈ ${fmtTime(el / done * (total - done))}` : '';
      $('scan-file').textContent = name;
    });
  },
};

$('analyze').onclick = () => analyze();
$('scan-stop').onclick = () => { gate.resume(); scanState.abort?.abort(); };
$('scan-pause').onclick = () => gate.paused ? gate.resume() : gate.pause();

async function analyze() {
  if (scanState.running || state.running) return;
  invalidate();
  $('done').hidden = true;
  const o = readOpts();
  const ac = new AbortController();
  Object.assign(scanState, { running: true, abort: ac });
  gate.reset(); pauseUi();
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
        await gate.wait();
        if (ac.signal.aborted) return;
        const key = fileKey(r.id, c.path, c.name);
        seen.add(key);
        if (SLOW_TEST && cached.get(key)?.v !== RECORD_V) await new Promise(res => setTimeout(res, SLOW_TEST));
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
    gate.reset(); pauseUi();
    scanUi.show(false);
    night.refresh();
    if (!state.running) await keepAwake(false);
  }
}

async function loadMarks() {
  state.protect = new Set(await store.keys('protect'));
  state.trashMap = new Map((await store.all('trash')).map(t => [fileKey(t.rootId, t.path, t.finalName), t]));
}

// Muestra el último análisis guardado sin volver a leer las carpetas. Si alguno quedó a medias,
// ofrece continuarlo (lo ya revisado no se repite).
async function restoreAnalysis() {
  const roots = state.roots.filter(r => r.ok);
  if (!roots.length) return;
  await loadMarks();
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
  await renderJob();
}

// Las carpetas guardadas solo tienen ruta y nombre: se busca el archivo justo antes de usarlo.
const dirCache = new Map();
async function dirOf(root, path) {
  const dk = `${root.id}|${path}`;
  let dir = dirCache.get(dk);
  if (!dir) { dir = await getDirPath(root.handle, path, false); dirCache.set(dk, dir); }
  return dir;
}
async function resolveItem(item) {
  if (item.file && item.dir) return item;
  item.dir = await dirOf(item.root, item.path);
  item.file = await (await item.dir.getFileHandle(item.name)).getFile();
  item.size = item.file.size;
  return item;
}

// Si se activan los videos después de un análisis sin ellos, se miden solo esos (con progreso).
async function measureVideos(videos) {
  const { quickProbe } = await import('./mp4.js');
  scanState.running = true;
  scanUi.show(true);
  scanUi.phase('Midiendo videos');
  $('scan-actions').hidden = true; // medir videos es rápido: no se ofrece pausar ni detener
  const t0 = performance.now();
  let done = 0;
  const batch = [];
  try {
    await mapPool(videos, SCAN_CONCURRENCY, async v => {
      try {
        await resolveItem(v);
        v.meta = await quickProbe(v.file).catch(() => null);
        if (v.meta?.created) v.taken = v.meta.created;
      } catch { v.meta = null; }
      batch.push(record(v.root, v));
      scanUi.inspect(++done, videos.length, v.name, t0, 'Midiendo videos');
    });
    await store.putMany('files', batch);
  } finally {
    scanState.running = false;
    scanUi.show(false);
    $('scan-actions').hidden = false;
  }
}

// ---------- Estado de cada archivo ----------
// pending: se compactaría con las opciones actuales; reason: por qué no (si no).
function flagsOf(it, o = readOpts()) {
  const prot = state.protect.has(it.fk);
  const trash = state.trashMap.get(it.fk) || null;
  const compacted = it.type === 'video' ? !!it.meta?.compacted : !!it.compacted;
  let pending = false, reason = null;
  if (!compacted && !prot) {
    const skip = state.analysis?.skip.has(`${it.key}|${o.level}`);
    if (it.type === 'video') {
      reason = !o.video ? 'off' : it.meta === undefined ? 'unmeasured' : (!it.meta || it.size < MIN_VIDEO) ? 'heavy' : skip ? 'remembered' : null;
    } else {
      reason = (it.type === 'photo' ? !o.photos : !o.png) ? 'off' : it.pano ? 'pano'
        : (it.motion || it.special) && o.motion === 'skip' ? 'motion' : skip ? 'remembered' : it.size < MIN_PHOTO ? 'small' : null;
    }
    pending = !reason;
  }
  return { pending, compacted, inTrash: !!trash, trash, protected: prot, reason };
}

// Qué archivos se procesarían con las opciones actuales.
function selection(o) {
  const photos = [], videos = [];
  const stats = { compacted: 0, compactedVideo: 0, motion: 0, pano: 0, remembered: 0, protected: 0 };
  for (const it of state.analysis.items) {
    const f = flagsOf(it, o);
    if (f.pending) (it.type === 'video' ? videos : photos).push(it);
    else if (f.protected) stats.protected++;
    else if (f.compacted) stats[it.type === 'video' ? 'compactedVideo' : 'compacted']++;
    else if (f.reason in stats) stats[f.reason]++;
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
  if (stats.protected) facts.push(`🛡 ${nf.format(stats.protected)} archivos protegidos: no se tocan`);
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
  const calib = photos.length ? await calibrate(photos, o) : null;
  if (seq !== renderSeq) return; // cambiaron las opciones mientras calculaba
  const photoOut = calib ? sum(photos) * calib.ratio : 0;
  const before = sum(photos) + sum(videos);
  const after = photoOut + videoEst;
  $('saving').innerHTML = `Liberarías ≈ ${fmtBytes(before - after)}<small>${fmtBytes(before)} → ≈ ${fmtBytes(after)}${calib ? ` · las fotos quedan en ≈ ${Math.round(calib.ratio * 100)} % de su tamaño` : ''}</small>`;
}

async function estimateVideos(videos, level) {
  if (!videos.length) return 0;
  const { planVideo, pickCodec } = await import('./video.js');
  const hevc = (await pickCodec()) === 'hevc';
  return videos.reduce((n, v) => n + Math.min(v.size, planVideo(v.meta, level, hevc).estimated), 0);
}

// Compacta de verdad unas cuantas fotos (sin guardarlas) para estimar el ahorro y para la vista previa.
// Se guarda la promesa: si la vista previa la pide mientras se calcula, no se repite el trabajo.
function calibrate(photos, o) {
  return (state.calib[`${o.level}|${o.engine}`] ??= calibrateNow(photos, o));
}
async function calibrateNow(photos, o) {
  const n = Math.min(4, photos.length);
  const picks = Array.from({ length: n }, (_, i) => photos[Math.floor((i + 0.5) * photos.length / n)]);
  const samples = await Promise.all(picks.map(async item => {
    try {
      await resolveItem(item);
      const r = await pool.run(item.file, o, o.motion === 'skip');
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
  const calib = await calibrate(photos, o);
  if (!calib.samples.length) return alert('No se pudo generar la vista previa.');
  showSample(calib.samples[pvIndex % calib.samples.length]);
  $('preview').showModal();
};
$('pv-next').onclick = async () => {
  const o = readOpts();
  const { samples } = await state.calib[`${o.level}|${o.engine}`];
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
const trashText = o => o.trash
  ? 'Los originales se guardan en la papelera de MKompact: podrás revisarlos uno por uno y restaurarlos. El espacio se libera cuando apruebes o vacíes la papelera.'
  : '⚠️ Los originales se BORRARÁN en cuanto se verifique cada copia. No se podrán recuperar.';

// ---------- Proceso ----------
$('run').onclick = async () => {
  const o = readOpts();
  const { photos, videos } = selection(o);
  const n = photos.length + videos.length;
  if (await confirmDialog(`Se van a compactar ${nf.format(n)} archivos.\n\n${trashText(o)}`, 'Round 1', !o.trash)) process(photos, videos, o);
};
$('pause').onclick = () => gate.paused ? gate.resume() : gate.pause();
$('stop').onclick = () => { state.stopped = true; gate.resume(); state.cancelVideo?.(); };

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

// La compactación en curso se guarda como "trabajo": si la app se cierra, al volver se ofrece continuarla.
const job = { keys: null, opts: null, explicit: false, dirty: false, last: 0 };
function saveJob(force = false) {
  if (!job.keys || (!job.dirty && !force)) return;
  if (!force && performance.now() - job.last < 1000) return;
  job.dirty = false; job.last = performance.now();
  store.put('prefs', { keys: [...job.keys], opts: job.opts, explicit: job.explicit, at: Date.now() }, 'job').catch(() => {});
}
async function renderJob() {
  const saved = state.running ? null : await store.get('prefs', 'job');
  // Se descuenta lo que ya quedó compactado (el trabajo guardado puede ir hasta 1 s atrasado)
  const keys = new Set(saved?.keys || []);
  const items = saved && state.analysis ? state.analysis.items.filter(i => keys.has(i.fk) && !flagsOf(i, saved.opts).compacted) : [];
  if (saved && !items.length) await store.del('prefs', 'job');
  $('job-note').hidden = !items.length;
  if (!items.length) return;
  $('job-text').textContent = `Quedó una compactación pendiente: ${nf.format(items.length)} archivos (${fmtBytes(sum(items))}). Lo ya compactado está guardado.`;
  $('job-resume').onclick = () => {
    $('job-note').hidden = true;
    process(items.filter(i => i.type !== 'video'), items.filter(i => i.type === 'video' && i.meta), saved.opts, { explicit: saved.explicit });
  };
  $('job-discard').onclick = async () => { await store.del('prefs', 'job'); $('job-note').hidden = true; };
}

async function process(photos, videos, o, { explicit = false } = {}) {
  Object.assign(state, { running: true, stopped: false });
  gate.reset(); pauseUi();
  $('analysis').hidden = true; $('done').hidden = true; $('job-note').hidden = true; $('progress').hidden = false;
  $('analyze').disabled = true; $('add-root').disabled = true;
  fight();
  await keepAwake(true);
  Object.assign(job, { keys: new Set([...photos, ...videos].map(i => i.fk)), opts: o, explicit, dirty: true });
  saveJob(true);

  const total = photos.length + videos.length;
  const videoBytes = sum(videos);
  const r = { done: 0, saved: 0, skipped: 0, ignored: 0, errors: [], photosDone: 0, videoBytesDone: 0, t: { compress: 0, save: 0, n: 0 } };
  const t0 = performance.now();
  let tVideo = 0, current = '', frac = 0, curSize = 0;
  const eta = () => {
    if (r.photosDone < photos.length) {
      const el = gate.elapsed(t0);
      if (r.photosDone < 3 || el < 5) return '';
      const s = el / r.photosDone * (photos.length - r.photosDone);
      return `faltan ≈ ${fmtTime(s)} de fotos${videos.length ? ` + ${nf.format(videos.length)} videos` : ''}`;
    }
    if (!videos.length || !tVideo) return '';
    const el = gate.elapsed(tVideo), doneB = r.videoBytesDone + frac;
    return doneB > 0 && el > 10 ? `faltan ≈ ${fmtTime(el / doneB * (videoBytes - doneB))}` : 'midiendo velocidad…';
  };
  const update = (name, f = 0, size = 0) => {
    frac = f; curSize = size || curSize;
    if (name) current = name;
    const doneUnits = r.done + (f && curSize ? f / curSize : 0);
    $('bar-fill').style.width = `${Math.min(100, doneUnits / total * 100)}%`;
    $('prog-count').textContent = `${nf.format(r.done)} de ${nf.format(total)}`;
    $('prog-eta').textContent = eta();
    $('prog-file').textContent = current;
    $('prog-saved').textContent = `Ahorrado: ${fmtBytes(r.saved)}`;
  };
  nightText = () => state.running
    ? `MKompact · ${nf.format(r.done)} de ${nf.format(total)} · ${eta() || 'trabajando'} · ahorrado ${fmtBytes(r.saved)}`
    : `MKompact · listo · ahorraste ${fmtBytes(r.saved)}`;
  update('Preparando…');

  const finish = async (item, res) => {
    r.done++;
    if (item.type === 'video') r.videoBytesDone += item.size; else r.photosDone++;
    if (res.error) r.errors.push(`${item.path ? item.path + '/' : ''}${item.name}: ${res.error}`);
    else if (res.ignored) r.ignored++;
    else if (res.skipped) { r.skipped++; await store.put('skip', 1, `${item.key}|${o.level}`); }
    else {
      r.saved += item.size - res.newSize;
      if (res.t) { r.t.compress += res.t.compress; r.t.save += res.t.save; r.t.n++; }
      if (res.trashPath) {
        await store.put('trash', {
          rootId: item.root.id, path: item.path, name: item.name, finalName: res.finalName,
          trashPath: res.trashPath, origSize: item.size, newSize: res.newSize, date: Date.now(),
        });
      }
      // El análisis guardado se actualiza al momento: si la app se cierra, no se vuelve a procesar.
      if (res.finalName !== item.name) await store.del('files', item.fk);
      await store.put('files', record(item.root, {
        ...item, name: res.finalName, size: res.newSize, mtime: res.newMtime,
        type: item.type === 'png' ? 'photo' : item.type,
        compacted: true, motion: false, special: false, pano: false, hdr: false,
        ...(item.type === 'video' ? { meta: { ...item.meta, compacted: true } } : {}),
      }));
    }
    job.keys.delete(item.fk); job.dirty = true; saveJob();
    update();
  };

  // Fotos: se comprimen en paralelo (workers) y se guardan una por una.
  let idx = 0;
  const photoLane = async () => {
    while (idx < photos.length && !state.stopped) {
      await gate.wait();
      if (state.stopped) break;
      const item = photos[idx++];
      update(item.name);
      await finish(item, await doPhoto(item, o, explicit).catch(e => ({ error: e.message })));
    }
  };
  await Promise.all(Array.from({ length: pool.size }, photoLane));

  // Videos: de uno en uno (el codificador del teléfono es uno solo).
  if (videos.length && !state.stopped) {
    const vmod = await import('./video.js');
    tVideo = performance.now();
    for (const item of videos) {
      await gate.wait();
      if (state.stopped) break;
      update(`🎬 ${item.name}`);
      const res = await doVideo(item, o, vmod, p => update(`🎬 ${item.name} · ${Math.round(p * 100)} %`, item.size * p, item.size))
        .catch(e => ({ error: state.stopped ? 'Detenido' : e.message }));
      state.cancelVideo = null;
      await finish(item, res);
    }
  }

  if (!state.stopped && !job.keys.size) await store.del('prefs', 'job');
  else saveJob(true);
  job.keys = null;
  Object.assign(state, { running: false });
  gate.reset(); pauseUi();
  $('progress').hidden = true; $('done').hidden = false;
  $('analyze').disabled = false; $('add-root').disabled = false;
  const banner = state.stopped ? ['Ronda detenida', ' lost'] : r.errors.length ? ['Victory', ''] : ['Flawless victory', ''];
  $('done-title').innerHTML = `<span class="victory${banner[1]}">${banner[0]}</span>Ahorraste ${fmtBytes(r.saved)}<small>${o.trash ? 'Revisa lo compactado y aprueba o vacía la papelera (abajo) para liberar el espacio.' : 'El espacio ya quedó libre.'}</small>`;
  const facts = [`<b>${nf.format(r.done - r.skipped - r.ignored - r.errors.length)}</b> archivos compactados`];
  if (r.skipped) facts.push(`${nf.format(r.skipped)} se dejaron igual porque no bajaban al menos ${MIN_SAVING * 100} %`);
  if (r.ignored) facts.push(`${nf.format(r.ignored)} se saltaron (ya compactadas, en movimiento o 360°)`);
  if (state.stopped && r.done < total) facts.push(`${nf.format(total - r.done)} quedaron pendientes: puedes continuar después`);
  if (r.t.n) facts.push(`Promedio por foto: ${((r.t.compress + r.t.save) / r.t.n / 1000).toFixed(1)} s (comprimir ${(r.t.compress / r.t.n / 1000).toFixed(1)} s · guardar ${(r.t.save / r.t.n / 1000).toFixed(1)} s)`);
  $('done-facts').replaceChildren(...facts.map(li));
  $('errors').hidden = !r.errors.length;
  $('errors').querySelector('summary').textContent = `${r.errors.length} con error (el original quedó intacto)`;
  $('error-list').replaceChildren(...r.errors.map(t => { const e = document.createElement('li'); e.textContent = t; return e; }));
  state.analysis = null; state.calib = {};
  night.refresh();
  await keepAwake(false);
  renderTrash();
  await restoreAnalysis(); // muestra lo que falta, ya con lo compactado descontado
}

async function doPhoto(item, o, explicit) {
  await resolveItem(item);
  const res = await pool.run(item.file, o, !explicit && o.motion === 'skip');
  if (res.ignored) return { ignored: res.ignored };
  const out = res.buffer;
  if (out.byteLength > item.size * (1 - MIN_SAVING)) return { skipped: true };
  const t1 = performance.now();
  const saved = await replaceFile({
    root: item.root.handle, item, keepOriginal: o.trash,
    write: w => w.write(out),
    // Se compara byte por byte lo escrito con lo comprimido: tan seguro como decodificar y mucho más rápido.
    verify: async f => {
      if (f.size !== out.byteLength) throw new Error('La copia no se guardó completa');
      const a = new Uint8Array(await f.arrayBuffer()), b = new Uint8Array(out);
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) throw new Error('La copia guardada no coincide');
    },
  });
  return { ...saved, t: { compress: res.ms || 0, save: performance.now() - t1 } };
}

async function doVideo(item, o, vmod, onProgress) {
  await resolveItem(item);
  const size = vmod.planVideo(item.meta, o.level, false);
  const codec = await vmod.pickCodec(size.width, size.height);
  if (!codec) throw new Error(`Este teléfono no puede codificar video de ${size.width}×${size.height}`);
  const plan = vmod.planVideo(item.meta, o.level, codec === 'hevc');
  if (plan.estimated > item.size * (1 - MIN_SAVING)) return { skipped: true };
  const gps = await vmod.readLocationBoxes(item.file).catch(() => null);
  return replaceFile({
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
}

// ---------- Papelera: restaurar, aprobar, vaciar ----------
const rootById = id => state.roots.find(r => r.id === id);

// Regresa originales a su lugar y actualiza el análisis guardado de esos archivos.
async function restoreRecs(recs) {
  let fails = 0;
  for (const rec of recs) {
    const root = rootById(rec.rootId);
    if (!root) { fails++; continue; }
    try {
      const name = await restore(root.handle, rec);
      await store.del('trash', rec.id);
      await store.del('files', fileKey(root.id, rec.path, rec.finalName));
      const dir = await dirOf(root, rec.path);
      const { info } = await inspect({ dir, handle: await dir.getFileHandle(name), path: rec.path, name, type: typeOf(name) }, null, readOpts().video);
      if (info) await store.put('files', record(root, info));
    } catch (e) {
      if (e.name === 'NotFoundError') await store.del('trash', rec.id); // el original ya no está en la papelera
      else fails++;
    }
  }
  if (fails) alert(`${fails} no se pudieron restaurar (quizá se movieron o borraron).`);
  return true;
}

// Aprobar: el original de la papelera se borra definitivamente (se libera su espacio).
async function approveRecs(recs) {
  for (const rec of recs) {
    const root = rootById(rec.rootId);
    if (!root) continue;
    try {
      const parts = rec.trashPath.split('/');
      const name = parts.pop();
      const tdir = await getDirPath(await root.handle.getDirectoryHandle(TRASH), parts.join('/'), false);
      await tdir.removeEntry(name);
    } catch (e) { if (e.name !== 'NotFoundError') { alert('No se pudo borrar un original: ' + e.message); return false; } }
    await store.del('trash', rec.id);
  }
  return true;
}

async function renderTrash() {
  const rows = [];
  let anyRecs = false;
  for (const r of state.roots.filter(r => r.ok)) {
    const recs = await store.byIndex('trash', 'root', r.id);
    anyRecs ||= recs.length > 0;
    const size = recs.reduce((n, x) => n + (x.origSize || 0), 0) || await trashSize(r.handle);
    if (!size) continue;
    const e = li(`<span class="name">${esc(r.name)}<small>${nf.format(recs.length)} originales · ${fmtBytes(size)}</small></span>`);
    const restoreBtn = Object.assign(document.createElement('button'), { className: 'btn secondary', textContent: 'Restaurar todo' });
    const emptyBtn = Object.assign(document.createElement('button'), { className: 'btn danger', textContent: 'Vaciar' });
    restoreBtn.onclick = async () => {
      if (!await confirmDialog(`¿Regresar ${nf.format(recs.length)} originales a su lugar? Se quitarán sus versiones compactas.`, 'Restaurar')) return;
      restoreBtn.disabled = emptyBtn.disabled = true;
      await restoreRecs(recs);
      if (!(await store.byIndex('trash', 'root', r.id)).length) await emptyTrash(r.handle);
      renderTrash(); restoreAnalysis();
    };
    emptyBtn.onclick = async () => {
      if (!await confirmDialog(`¿Borrar definitivamente ${fmtBytes(size)} de originales de "${r.name}"?\n\nYa no podrás restaurarlos.`, 'Fatality', true)) return;
      restoreBtn.disabled = emptyBtn.disabled = true;
      await emptyTrash(r.handle);
      await store.delMany('trash', recs.map(x => x.id));
      renderTrash(); restoreAnalysis();
    };
    e.append(restoreBtn, emptyBtn);
    rows.push(e);
  }
  $('trash-list').replaceChildren(...rows);
  $('trash-card').hidden = !rows.length;
  $('trash-review').hidden = !anyRecs || !state.analysis;
}

// ---------- Galería ----------
const thumbs = createThumbs({ resolveItem, pool });
const gallery = createGallery({
  items: () => state.analysis?.items || [],
  flags: it => flagsOf(it),
  thumbs, resolveItem,
  trashFile: async it => {
    const rec = state.trashMap.get(it.fk);
    const parts = rec.trashPath.split('/');
    const name = parts.pop();
    const tdir = await getDirPath(await it.root.handle.getDirectoryHandle(TRASH), parts.join('/'), false);
    return (await tdir.getFileHandle(name)).getFile();
  },
  async compact(items) {
    if (state.running || scanState.running) { alert('Espera a que termine el proceso actual.'); return false; }
    if (!items.length) return false;
    const o = readOpts();
    const { quickProbe } = await import('./mp4.js');
    for (const v of items.filter(i => i.type === 'video' && i.meta === undefined)) {
      await resolveItem(v).catch(() => {});
      v.meta = v.file ? await quickProbe(v.file).catch(() => null) : null;
    }
    const photos = items.filter(i => i.type !== 'video'), videos = items.filter(i => i.type === 'video' && i.meta);
    const special = photos.filter(i => i.motion || i.special).length;
    const text = `Se van a compactar ${nf.format(photos.length + videos.length)} archivos seleccionados.`
      + (special ? `\n\n${nf.format(special)} son fotos en movimiento o retratos: quedarán como foto fija.` : '')
      + `\n\n${trashText(o)}`;
    if (!await confirmDialog(text, 'Round 1', !o.trash)) return false;
    process(photos, videos, o, { explicit: true });
    return true;
  },
  async protect(items, on) {
    const keys = items.map(i => i.fk);
    if (on) await store.setKeys('protect', keys); else await store.delMany('protect', keys);
    for (const k of keys) on ? state.protect.add(k) : state.protect.delete(k);
  },
  async restore(items) {
    const recs = items.map(i => state.trashMap.get(i.fk)).filter(Boolean);
    if (!recs.length) return false;
    if (recs.length > 1 && !await confirmDialog(`¿Regresar ${nf.format(recs.length)} originales a su lugar? Se quitarán sus versiones compactas.`, 'Restaurar')) return false;
    for (const i of items) thumbs.forget(i);
    return restoreRecs(recs);
  },
  async approve(items) {
    const recs = items.map(i => state.trashMap.get(i.fk)).filter(Boolean);
    if (!recs.length) return false;
    const bytes = recs.reduce((n, x) => n + (x.origSize || 0), 0);
    if (!await confirmDialog(`¿Aprobar ${recs.length === 1 ? 'esta versión compactada' : `${nf.format(recs.length)} versiones compactadas`}?\n\nSe borra${recs.length === 1 ? ' el original' : 'n los originales'} de la papelera y se liberan ${fmtBytes(bytes)}. No se puede deshacer.`, 'Fatality', true)) return false;
    return approveRecs(recs);
  },
  async refresh() { await restoreAnalysis(); renderTrash(); },
  onClose() { if (state.analysis) renderAnalysis(); },
});
$('gallery-btn').onclick = () => gallery.open('pending');
$('trash-review').onclick = () => gallery.open('trash');

// ---------- Modo noche ----------
let nightText = () => 'MKompact';
const night = createNight(() => scanState.running ? `MKompact · ${scanUi.text}` : nightText());
for (const id of ['night-btn', 'scan-night']) $(id).onclick = () => night.enter();

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

// ---------- Base de datos compartida con otras ventanas ----------
dbEvents.blocked = on => { $('db-blocked').hidden = !on; };
dbEvents.versionchange = () => { $('update-banner').hidden = false; };
$('db-close-others').onclick = () => {
  const sw = navigator.serviceWorker?.controller;
  if (sw) sw.postMessage('reload-others');
  else alert('Cierra las otras pestañas o ventanas de MKompact y vuelve a abrir esta.');
};

// ---------- Inicio ----------
if (!('showDirectoryPicker' in window) && !new URLSearchParams(location.search).has('opfs')) {
  $('unsupported').hidden = false;
  $('add-root').disabled = true;
}
await loadPrefs();
await loadRoots();
await restoreAnalysis();
renderTrash();
showVersion();
startServiceWorker();
window.__mkompact = { state, analyze, selection, readOpts, restoreAnalysis, gallery, gate, night, flagsOf }; // para pruebas
