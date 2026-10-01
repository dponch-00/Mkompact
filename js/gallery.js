// Galería para ver y elegir archivos, al estilo de Google Photos / Files by Google:
//  - cuadrícula agrupada por mes, con casilla para seleccionar el mes completo
//  - tocar abre el visor; mantener presionado entra a selección y permite arrastrar sobre varias
//  - filtros por estado (por compactar, en papelera, compactadas, protegidas) y tipo; orden por fecha o peso
//  - visor para revisar una por una (deslizar), con comparación antes/después de las compactadas
import { $, nf, fmtBytes, fmtDate, fmtDuration, esc, el, pushLayer, popLayer } from './util.js';

const MONTH = new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric' });
const FILTERS = [
  ['pending', 'Por compactar'], ['trash', 'En papelera'], ['compacted', 'Compactadas'],
  ['protected', 'Protegidas'], ['all', 'Todas'],
];
const REASONS = {
  motion: 'En movimiento o retrato: no se toca (cámbialo en Opciones)', pano: 'Foto 360°: no se toca',
  small: 'Ya es pequeña', remembered: 'Ya no se podía reducir más', heavy: 'Video muy corto o pequeño',
  unmeasured: 'Video sin medir (activa Videos en Opciones)', off: 'Tipo desactivado en Opciones',
};

/**
 * api: {
 *   items(): lista de archivos del análisis
 *   flags(item): { pending, compacted, inTrash, protected, reason }
 *   thumbs, resolveItem, trashFile(item) -> File del original en la papelera
 *   compact(items), protect(items, on), restore(items), approve(items), refresh()
 * }
 */
export function createGallery(api) {
  const g = { filter: 'pending', type: 'all', sort: 'new', selecting: false, sel: new Set(), list: [], cells: [] };
  const grid = $('g-grid'), bar = $('g-bar');
  let observer;

  // ---------- Abrir / cerrar ----------
  function open(filter = 'pending') {
    g.filter = filter;
    $('gallery').hidden = false;
    document.body.classList.add('no-scroll');
    pushLayer(close);
    render();
  }
  function close() {
    if ($('gallery').hidden) return;
    exitSelection(false);
    $('gallery').hidden = true;
    document.body.classList.remove('no-scroll');
    observer?.disconnect();
    grid.replaceChildren();
    api.onClose?.();
  }
  $('g-back').onclick = () => popLayer();

  // ---------- Filtros ----------
  function renderChips() {
    const all = api.items();
    const counts = Object.fromEntries(FILTERS.map(([k]) => [k, 0]));
    for (const it of all) {
      const f = api.flags(it);
      counts.all++;
      if (f.pending) counts.pending++;
      if (f.inTrash) counts.trash++;
      if (f.compacted) counts.compacted++;
      if (f.protected) counts.protected++;
    }
    $('g-status').replaceChildren(...FILTERS.map(([k, label]) => el('button', {
      className: 'chip' + (g.filter === k ? ' on' : ''), textContent: `${label} · ${nf.format(counts[k])}`,
      onclick: () => { g.filter = k; exitSelection(false); render(); },
    })));
    $('g-status').querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    for (const b of $('g-type').querySelectorAll('.chip')) b.classList.toggle('on', b.dataset.type === g.type);
  }
  $('g-type').onclick = e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    g.type = b.dataset.type; exitSelection(false); render();
  };
  $('g-sort').onchange = e => { g.sort = e.target.value; render(); };

  function visible() {
    const pred = {
      pending: f => f.pending, trash: f => f.inTrash, compacted: f => f.compacted,
      protected: f => f.protected, all: () => true,
    }[g.filter];
    const out = api.items().filter(it =>
      (g.type === 'all' || (g.type === 'video' ? it.type === 'video' : it.type !== 'video')) && pred(api.flags(it)));
    const t = it => it.taken || 0;
    const cmp = {
      new: (a, b) => t(b) - t(a), old: (a, b) => t(a) - t(b), big: (a, b) => b.size - a.size,
    }[g.sort];
    return out.sort(cmp);
  }

  // ---------- Cuadrícula ----------
  function render() {
    renderChips();
    observer?.disconnect();
    g.list = visible();
    g.cells = [];
    const total = g.list.reduce((n, i) => n + i.size, 0);
    $('g-summary').textContent = g.list.length ? `${nf.format(g.list.length)} archivos · ${fmtBytes(total)}` : '';
    const frag = document.createDocumentFragment();
    if (!g.list.length) {
      frag.append(el('p', { className: 'g-empty', textContent: 'No hay archivos con este filtro.' }));
    }
    // Grupos: por mes si se ordena por fecha; uno solo si se ordena por peso
    let group = null, groupKey = null;
    g.list.forEach((it, i) => {
      const d = new Date(it.taken);
      const valid = !Number.isNaN(d.getTime()) && it.taken > 0;
      const key = g.sort === 'big' ? 'all' : valid ? `${d.getFullYear()}-${d.getMonth()}` : 'none';
      if (key !== groupKey) {
        groupKey = key;
        const month = valid ? MONTH.format(d) : 'sin fecha';
        const label = g.sort === 'big' ? 'Más pesados primero' : month.charAt(0).toUpperCase() + month.slice(1);
        group = { start: i, end: i, bytes: 0, head: null, body: el('div', { className: 'g-cells' }) };
        const check = el('button', { className: 'g-check', title: 'Seleccionar todo el grupo' });
        check.setAttribute('aria-label', `Seleccionar ${label}`);
        const meta = el('small');
        group.head = el('div', { className: 'g-head' }, check, el('span', { textContent: label }), meta);
        group.meta = meta;
        const grp = group;
        check.onclick = () => toggleRange(grp.start, grp.end);
        frag.append(el('section', { className: 'g-group' }, group.head, group.body));
      }
      group.end = i;
      group.bytes += it.size;
      group.meta.textContent = `${nf.format(group.end - group.start + 1)} · ${fmtBytes(group.bytes)}`;
      const cell = makeCell(it, i);
      g.cells[i] = cell;
      group.body.append(cell);
    });
    grid.replaceChildren(frag);
    grid.scrollTop = 0;
    observer = new IntersectionObserver(onVisible, { root: grid, rootMargin: '600px 0px' });
    for (const c of g.cells) observer.observe(c);
    updateSelectionUi();
  }

  function makeCell(it, i) {
    const f = api.flags(it);
    const img = el('img', { alt: '', decoding: 'async' });
    const badges = el('span', { className: 'badges' },
      f.protected && el('span', { className: 'bdg prot', title: 'Protegida', textContent: '🛡' }),
      f.inTrash ? el('span', { className: 'bdg trash', title: 'Compactada; el original sigue en la papelera', textContent: '↺' })
        : f.compacted && el('span', { className: 'bdg done', title: 'Compactada', textContent: '✓' }),
      it.type === 'video' && el('span', { className: 'bdg vid', textContent: '▶' + (it.meta?.duration ? ' ' + fmtDuration(it.meta.duration) : '') }),
      (it.motion || it.special) && el('span', { className: 'bdg', title: 'En movimiento / retrato', textContent: '◉' }),
      it.pano && el('span', { className: 'bdg', textContent: '360' }),
    );
    const cell = el('div', { className: 'cell' + (g.sel.has(i) ? ' sel' : ''), tabIndex: 0 },
      img, badges, el('span', { className: 'size', textContent: fmtBytes(it.size) }), el('span', { className: 'tick' }));
    cell.dataset.i = i;
    cell.setAttribute('role', 'button');
    cell.setAttribute('aria-label', `${it.name}, ${fmtBytes(it.size)}`);
    return cell;
  }

  function onVisible(entries) {
    for (const e of entries) {
      const cell = e.target, it = g.list[cell.dataset.i];
      if (e.isIntersecting) {
        if (cell.dataset.loaded) continue;
        const req = api.thumbs.request(it);
        cell._req = req;
        req.promise.then(t => {
          const img = cell.querySelector('img');
          img.src = t.url;
          img.className = 'o' + (t.orient || 1);
          cell.dataset.loaded = 1;
        }, () => { if (!cell._req?.cancelledByScroll) cell.classList.add('nothumb'); });
      } else if (!cell.dataset.loaded && cell._req) {
        cell._req.cancelledByScroll = true;
        cell._req.cancel();
        cell._req = null;
      }
    }
  }

  // ---------- Selección ----------
  function enterSelection() {
    if (g.selecting) return;
    g.selecting = true;
    $('gallery').classList.add('selecting');
  }
  function exitSelection(rerender = true) {
    g.selecting = false;
    g.sel.clear();
    $('gallery').classList.remove('selecting');
    for (const c of grid.querySelectorAll('.cell.sel')) c.classList.remove('sel');
    if (rerender) updateSelectionUi(); else bar.hidden = true;
  }
  function setSel(i, on) {
    if (on) g.sel.add(i); else g.sel.delete(i);
    g.cells[i]?.classList.toggle('sel', on);
  }
  function toggleRange(a, b) {
    enterSelection();
    let all = true;
    for (let i = a; i <= b; i++) if (!g.sel.has(i)) { all = false; break; }
    for (let i = a; i <= b; i++) setSel(i, !all);
    updateSelectionUi();
  }
  $('g-select').onclick = () => { if (g.selecting) exitSelection(); else { enterSelection(); updateSelectionUi(); } };
  $('g-all').onclick = () => toggleRange(0, g.list.length - 1);

  function selectedItems() { return [...g.sel].sort((a, b) => a - b).map(i => g.list[i]); }

  function updateSelectionUi() {
    $('g-select').textContent = g.selecting ? 'Cancelar' : 'Seleccionar';
    $('g-all').hidden = !g.selecting || !g.list.length;
    // Casilla del grupo marcada si todo el grupo está seleccionado
    for (const head of grid.querySelectorAll('.g-head')) {
      const cells = head.nextElementSibling.children;
      head.classList.toggle('full', g.selecting && cells.length > 0 && [...cells].every(c => g.sel.has(+c.dataset.i)));
    }
    if (!g.selecting) { bar.hidden = true; return; }
    const items = selectedItems();
    const flags = items.map(api.flags);
    $('g-count').textContent = items.length
      ? `${nf.format(items.length)} seleccionados · ${fmtBytes(items.reduce((n, i) => n + i.size, 0))}`
      : 'Toca o arrastra para seleccionar';
    const canCompact = items.filter((it, k) => !flags[k].compacted && !flags[k].protected && !it.pano);
    const show = {
      'g-compact': canCompact.length, 'g-protect': flags.some(f => !f.protected), 'g-unprotect': flags.some(f => f.protected),
      'g-restore': flags.some(f => f.inTrash), 'g-approve': flags.some(f => f.inTrash),
    };
    for (const [id, on] of Object.entries(show)) $(id).hidden = !on;
    $('g-compact').textContent = `Compactar ${nf.format(canCompact.length)}`;
    bar.hidden = false;
  }

  async function act(fn) {
    const items = selectedItems();
    if (!items.length) return;
    bar.classList.add('busy');
    try { await fn(items); } finally { bar.classList.remove('busy'); }
  }
  $('g-compact').onclick = () => act(async items => {
    const ok = items.filter(it => { const f = api.flags(it); return !f.compacted && !f.protected && !it.pano; });
    if (await api.compact(ok)) { exitSelection(false); popLayer(); }
  });
  $('g-protect').onclick = () => act(async items => { await api.protect(items, true); afterAction(); });
  $('g-unprotect').onclick = () => act(async items => { await api.protect(items, false); afterAction(); });
  $('g-restore').onclick = () => act(async items => { if (await api.restore(items.filter(i => api.flags(i).inTrash))) afterAction(); });
  $('g-approve').onclick = () => act(async items => { if (await api.approve(items.filter(i => api.flags(i).inTrash))) afterAction(); });

  async function afterAction() {
    await api.refresh();
    exitSelection(false);
    const top = grid.scrollTop;
    render();
    grid.scrollTop = top;
  }

  // ---------- Gestos: tocar, mantener presionado, arrastrar ----------
  const press = { timer: 0, x: 0, y: 0, i: -1, dragging: false, anchor: -1, mode: true, snapshot: null, lastY: 0 };
  const cellAt = (x, y) => document.elementFromPoint(x, y)?.closest?.('.cell');

  grid.addEventListener('pointerdown', e => {
    const cell = e.target.closest('.cell');
    if (!cell || e.button > 0) return;
    Object.assign(press, { x: e.clientX, y: e.clientY, i: +cell.dataset.i, dragging: false, lastY: e.clientY });
    clearTimeout(press.timer);
    press.timer = setTimeout(() => startDrag(press.i), 450);
  });
  function startDrag(i) {
    press.timer = 0;
    enterSelection();
    press.dragging = true;
    press.anchor = i;
    press.mode = !g.sel.has(i);
    press.snapshot = new Set(g.sel);
    setSel(i, press.mode);
    navigator.vibrate?.(15);
    updateSelectionUi();
    autoScroll();
  }
  function dragTo(x, y) {
    press.lastY = y;
    const cell = cellAt(x, y);
    if (!cell) return;
    const j = +cell.dataset.i, a = Math.min(press.anchor, j), b = Math.max(press.anchor, j);
    // Lo que quedó fuera del rango vuelve a como estaba al empezar a arrastrar
    for (const k of [...g.sel, ...press.snapshot]) if (k < a || k > b) setSel(k, press.snapshot.has(k));
    for (let k = a; k <= b; k++) setSel(k, press.mode);
    updateSelectionUi();
  }
  // Al arrastrar cerca del borde, la cuadrícula se desplaza sola
  function autoScroll() {
    if (!press.dragging) return;
    const r = grid.getBoundingClientRect(), edge = 70;
    const dy = press.lastY < r.top + edge ? -12 : press.lastY > r.bottom - edge ? 12 : 0;
    if (dy) { grid.scrollTop += dy; dragTo(press.x, press.lastY); }
    requestAnimationFrame(autoScroll);
  }
  grid.addEventListener('pointermove', e => {
    if (press.timer && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) { clearTimeout(press.timer); press.timer = 0; press.i = -1; }
    if (press.dragging && e.pointerType === 'mouse') { press.x = e.clientX; dragTo(e.clientX, e.clientY); }
  });
  // En pantallas táctiles, una vez que empieza el arrastre se impide el desplazamiento de la página
  grid.addEventListener('touchmove', e => {
    if (!press.dragging) return;
    e.preventDefault();
    const t = e.touches[0];
    press.x = t.clientX;
    dragTo(t.clientX, t.clientY);
  }, { passive: false });
  const endPress = e => {
    if (press.timer) {
      clearTimeout(press.timer); press.timer = 0;
      if (press.i >= 0 && e.type !== 'pointercancel') {
        if (g.selecting) { setSel(press.i, !g.sel.has(press.i)); updateSelectionUi(); }
        else viewer.open(press.i);
      }
    }
    press.dragging = false;
    press.i = -1;
  };
  grid.addEventListener('pointerup', endPress);
  grid.addEventListener('pointercancel', endPress);
  grid.addEventListener('contextmenu', e => e.preventDefault());
  grid.addEventListener('keydown', e => {
    const cell = e.target.closest('.cell');
    if (!cell || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    const i = +cell.dataset.i;
    if (g.selecting) { setSel(i, !g.sel.has(i)); updateSelectionUi(); } else viewer.open(i);
  });

  // ---------- Visor: revisar una por una ----------
  const viewer = (() => {
    const v = { i: -1, urls: [], open: false };
    const stage = $('v-stage');

    function show(i) {
      v.i = i;
      const it = g.list[i];
      const f = api.flags(it);
      v.urls.forEach(URL.revokeObjectURL); v.urls = [];
      $('v-name').textContent = it.name;
      $('v-pos').textContent = `${nf.format(i + 1)} de ${nf.format(g.list.length)}`;
      const where = [it.root.name, it.path].filter(Boolean).join('/');
      const state = f.protected ? '🛡 Protegida' : f.inTrash ? '↺ Compactada · el original está en la papelera'
        : f.compacted ? '✓ Compactada' : f.pending ? 'Por compactar' : (REASONS[f.reason] || 'Se deja igual');
      $('v-info').innerHTML = `${esc(it.taken ? fmtDate(it.taken) : 'Sin fecha')} · ${esc(where)}<br>${esc(state)}`;
      stage.replaceChildren(el('div', { className: 'v-loading', textContent: 'Cargando…' }));
      $('v-compare').hidden = true;
      for (const [id, on] of Object.entries({
        'v-protect': !f.protected, 'v-unprotect': f.protected, 'v-restore': f.inTrash, 'v-approve': f.inTrash,
        'v-compact': !f.compacted && !f.protected && !it.pano,
      })) $(id).hidden = !on;
      $('v-prev').disabled = i <= 0;
      $('v-next').disabled = i >= g.list.length - 1;
      load(it, f, i);
    }

    async function load(it, f, i) {
      try {
        await api.resolveItem(it);
        if (v.i !== i) return;
        const url = URL.createObjectURL(it.file);
        v.urls.push(url);
        if (it.type === 'video') {
          stage.replaceChildren(el('video', { src: url, controls: true, playsInline: true, className: 'v-media' }));
          $('v-sizes').textContent = fmtBytes(it.file.size);
          return;
        }
        if (!f.inTrash) {
          stage.replaceChildren(el('img', { src: url, alt: it.name, className: 'v-media' }));
          $('v-sizes').textContent = fmtBytes(it.file.size);
          return;
        }
        // Compactada con el original guardado: comparación lado a lado con deslizador
        const orig = await api.trashFile(it);
        if (v.i !== i) return;
        const ourl = URL.createObjectURL(orig);
        v.urls.push(ourl);
        const after = el('img', { src: url, alt: 'Compactada' });
        const beforeImg = el('img', { src: ourl, alt: 'Original' });
        const clip = el('div', { className: 'pv-before' }, beforeImg);
        const divider = el('div', { className: 'pv-divider' });
        stage.replaceChildren(el('div', { className: 'pv-wrap v-compare-wrap' }, after, clip, divider,
          el('span', { className: 'pv-lbl l', textContent: 'Original' }), el('span', { className: 'pv-lbl r', textContent: 'Compactada' })));
        const slider = $('v-slider');
        slider.value = 50;
        slider.oninput = () => { clip.style.clipPath = `inset(0 ${100 - slider.value}% 0 0)`; divider.style.left = `${slider.value}%`; };
        slider.oninput();
        $('v-compare').hidden = false;
        $('v-sizes').textContent = `${fmtBytes(orig.size)} → ${fmtBytes(it.file.size)} (−${Math.round((1 - it.file.size / orig.size) * 100)} %)`;
      } catch (e) {
        if (v.i === i) stage.replaceChildren(el('div', { className: 'v-loading', textContent: 'No se pudo abrir: ' + e.message }));
      }
    }

    function openAt(i) {
      $('viewer').hidden = false;
      v.open = true;
      pushLayer(closeNow);
      show(i);
    }
    function closeNow() {
      $('viewer').hidden = true;
      v.open = false;
      stage.replaceChildren();
      v.urls.forEach(URL.revokeObjectURL); v.urls = [];
      // la celda puede haber cambiado de estado
      if (v.changed) { v.changed = false; afterAction(); }
    }
    const go = d => { const j = v.i + d; if (j >= 0 && j < g.list.length) show(j); };
    $('v-close').onclick = () => popLayer();
    $('v-prev').onclick = () => go(-1);
    $('v-next').onclick = () => go(1);
    addEventListener('keydown', e => {
      if (!v.open) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    });
    // Deslizar a los lados para pasar de una a otra (fuera del deslizador de comparación)
    let sx = 0, sy = 0;
    stage.addEventListener('pointerdown', e => { sx = e.clientX; sy = e.clientY; });
    stage.addEventListener('pointerup', e => {
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
    });

    // Acciones sobre la foto actual; al restaurar o aprobar pasa sola a la siguiente (como Slidebox)
    const single = async (fn, advance) => {
      const it = g.list[v.i];
      if (!await fn([it])) return;
      v.changed = true;
      await api.refresh();
      if (advance && v.i < g.list.length - 1) show(v.i + 1); else show(v.i);
    };
    $('v-protect').onclick = () => single(async items => { await api.protect(items, true); return true; }, false);
    $('v-unprotect').onclick = () => single(async items => { await api.protect(items, false); return true; }, false);
    $('v-restore').onclick = () => single(api.restore, true);
    $('v-approve').onclick = () => single(api.approve, true);
    $('v-compact').onclick = async () => {
      const it = g.list[v.i];
      if (await api.compact([it])) popLayer(2); // cierra visor y galería: se ve el progreso
    };
    return { open: openAt };
  })();

  return { open, close, render };
}
