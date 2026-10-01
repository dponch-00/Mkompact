// Utilidades de interfaz compartidas por la app y la galería.
export const $ = id => document.getElementById(id);
export const nf = new Intl.NumberFormat('es-MX');
export const fmtBytes = b => {
  if (b < 1024 ** 2) return `${nf.format(Math.round(b / 1024))} KB`;
  if (b < 1024 ** 3) return `${nf.format(Math.round(b / 1024 ** 2))} MB`;
  return `${(b / 1024 ** 3).toLocaleString('es-MX', { maximumFractionDigits: 1 })} GB`;
};
export const fmtTime = s => s < 60 ? `${Math.max(1, Math.round(s))} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
export const fmtDuration = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
export const fmtDate = ms => new Date(ms).toLocaleString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const li = html => { const e = document.createElement('li'); e.innerHTML = html; return e; };

// Crea un elemento: el('button', { className: 'btn', onclick }, 'Texto', otroNodo)
export function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter(k => k != null && k !== false));
  return e;
}

// Pila de pantallas encimadas (galería, visor…): el gesto "atrás" de Android cierra la de arriba
// en vez de salir de la app.
const layers = [];
export function pushLayer(close) {
  layers.push(close);
  history.pushState({ mkLayer: layers.length }, '');
}
export function popLayer(n = 1) {
  n = Math.min(n, layers.length);
  if (n) history.go(-n);
}
// Un solo "popstate" puede cerrar varias capas (history.go(-2)): se cierran hasta la profundidad actual.
addEventListener('popstate', e => {
  const depth = e.state?.mkLayer ?? 0;
  while (layers.length > depth) layers.pop()();
});
