// IndexedDB mínimo: carpetas autorizadas, papelera y archivos que no conviene volver a intentar.
const DB = 'compacta', VERSION = 1;
let dbp;

function db() {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('roots', { keyPath: 'id' });
      d.createObjectStore('trash', { keyPath: 'id', autoIncrement: true }).createIndex('root', 'rootId');
      d.createObjectStore('skip');
      d.createObjectStore('prefs');
    };
    r.onsuccess = () => res(r.result);
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
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const store = {
  all: name => tx(name, 'readonly', s => req(s.getAll())),
  get: (name, key) => tx(name, 'readonly', s => req(s.get(key))),
  put: (name, value, key) => tx(name, 'readwrite', s => req(key === undefined ? s.put(value) : s.put(value, key))),
  del: (name, key) => tx(name, 'readwrite', s => req(s.delete(key))),
  byIndex: (name, index, key) => tx(name, 'readonly', s => req(s.index(index).getAll(key))),
  keys: name => tx(name, 'readonly', s => req(s.getAllKeys())),
};
