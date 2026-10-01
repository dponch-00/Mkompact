// IndexedDB mínimo: carpetas autorizadas, papelera, archivos que no conviene volver a intentar
// y el resultado del análisis de cada archivo (para no perder el avance si se recarga la app).
const DB = 'mkompact', VERSION = 3;
let dbp;

// Avisos para la interfaz:
//  blocked(true/false): otra ventana con una versión anterior tiene la base abierta y no deja actualizarla
//  versionchange(): una versión más nueva necesita la base; esta ventana la suelta y debe recargarse
export const dbEvents = { blocked: null, versionchange: null };

function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = e => {
      const d = r.result;
      if (e.oldVersion < 1) {
        d.createObjectStore('roots', { keyPath: 'id' });
        d.createObjectStore('trash', { keyPath: 'id', autoIncrement: true }).createIndex('root', 'rootId');
        d.createObjectStore('skip');
        d.createObjectStore('prefs');
      }
      if (e.oldVersion < 2) {
        // key = `${rootId}|${path}|${name}`
        d.createObjectStore('files', { keyPath: 'key' }).createIndex('root', 'rootId');
      }
      if (e.oldVersion < 3) {
        d.createObjectStore('protect'); // clave = fileKey; MKompact nunca toca esos archivos
        d.createObjectStore('thumbs');  // clave = fileKey|tamaño|fecha -> { blob, orient }
      }
    };
    r.onblocked = () => dbEvents.blocked?.(true);
    r.onsuccess = () => {
      dbEvents.blocked?.(false);
      const d = r.result;
      d.onversionchange = () => { d.close(); dbp = null; dbEvents.versionchange?.(); };
      res(d);
    };
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const store = {
  all: name => tx(name, 'readonly', s => req(s.getAll())),
  get: (name, key) => tx(name, 'readonly', s => req(s.get(key))),
  put: (name, value, key) => tx(name, 'readwrite', s => req(key === undefined ? s.put(value) : s.put(value, key))),
  del: (name, key) => tx(name, 'readwrite', s => req(s.delete(key))),
  byIndex: (name, index, key) => tx(name, 'readonly', s => req(s.index(index).getAll(key))),
  keysByIndex: (name, index, key) => tx(name, 'readonly', s => req(s.index(index).getAllKeys(key))),
  keys: name => tx(name, 'readonly', s => req(s.getAllKeys())),
  // Varias escrituras en una sola transacción (mucho más rápido que una por una).
  putMany: (name, values) => tx(name, 'readwrite', s => { for (const v of values) s.put(v); }),
  delMany: (name, keys) => tx(name, 'readwrite', s => { for (const k of keys) s.delete(k); }),
  // Para almacenes sin keyPath (la clave va aparte): marca varias claves con el mismo valor.
  setKeys: (name, keys, value = 1) => tx(name, 'readwrite', s => { for (const k of keys) s.put(value, k); }),
};
