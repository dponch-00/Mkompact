// Operaciones sobre carpetas del celular (File System Access API).
import { readJpegInfo } from './jpeg.js';
import { quickProbe } from './mp4.js';

export const TRASH = '.mkompact-papelera';
const TMP = '.mkompact-tmp';

const PHOTO = /\.(jpe?g)$/i, PNG = /\.png$/i, HEIC = /\.(heic|heif)$/i, VIDEO = /\.(mp4|mov|m4v|3gp)$/i;

// Nombre que tendrá el archivo compactado (las capturas PNG pasan a JPG, los videos a MP4).
export function targetName(name) {
  return name.replace(/\.png$/i, '.jpg').replace(/\.(mov|m4v|3gp)$/i, '.mp4');
}

export async function ensurePermission(handle, ask) {
  const opts = { mode: 'readwrite' };
  if (await handle.queryPermission(opts) === 'granted') return true;
  if (!ask) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}

// Versión de lo que se guarda por archivo: al cambiarla, el siguiente análisis vuelve a leer los datos.
export const RECORD_V = 2;

// Fecha a partir del nombre que ponen las cámaras y apps de Android:
// 20220920_160509.jpg, IMG_20220920_160509.jpg, PXL_20220920_160509123.jpg, Screenshot_20220920-160509.png,
// VID_20220920_160509.mp4, IMG-20220920-WA0001.jpg (WhatsApp: solo el día)
export function dateFromName(name) {
  let m = /(?:^|\D)(20\d{2}|19\d{2})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/.exec(name);
  if (m) {
    const [, y, mo, d, h, mi, s] = m.map(Number);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h < 24 && mi < 60 && s < 60) return new Date(y, mo - 1, d, h, mi, s).getTime();
  }
  m = /(?:^|\D)(20\d{2})(\d{2})(\d{2})(?:\D|$)/.exec(name);
  if (m) {
    const [, y, mo, d] = m.map(Number);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return new Date(y, mo - 1, d, 12).getTime();
  }
  return 0;
}

export const typeOf = name =>
  PHOTO.test(name) ? 'photo' : PNG.test(name) ? 'png' : VIDEO.test(name) ? 'video' : HEIC.test(name) ? 'heic' : null;

// Fase 1: lista los archivos de la carpeta (sin abrirlos). Salta carpetas ocultas, incluida la papelera,
// y recupera restos temporales de una sesión interrumpida.
export async function listCandidates(root, onDir, signal) {
  const found = [];
  const counts = { files: 0, heic: 0 };
  async function walk(dir, path) {
    onDir?.(path, counts.files);
    const tmps = [];
    for await (const [name, h] of dir.entries()) {
      if (signal?.aborted) return;
      if (name.startsWith('.')) {
        if (h.kind === 'file' && name.endsWith(TMP)) tmps.push(name);
        continue;
      }
      if (h.kind === 'directory') { await walk(h, path ? `${path}/${name}` : name); continue; }
      counts.files++;
      const type = typeOf(name);
      if (type === 'heic') counts.heic++;
      else if (type) found.push({ dir, handle: h, path, name, type });
    }
    // Se recuperan después de recorrer: borrar o renombrar durante la iteración puede saltarse entradas.
    for (const t of tmps) await recoverTmp(dir, t).catch(() => {});
  }
  await walk(root, '');
  return { found, counts };
}

// Fase 2: datos de un archivo. Si ya se había revisado y no cambió (mismo tamaño y fecha),
// se reutiliza el resultado guardado sin volver a leer el contenido.
export async function inspect(c, cached, wantVideo) {
  const file = await c.handle.getFile();
  const same = cached && cached.v === RECORD_V && cached.size === file.size && cached.mtime === file.lastModified;
  const info = {
    v: RECORD_V, path: c.path, name: c.name, type: c.type, size: file.size, mtime: file.lastModified,
    taken: dateFromName(c.name) || file.lastModified,
  };
  if (c.type === 'photo') {
    if (same && 'compacted' in cached) return { file, info: { ...cached, ...info, taken: cached.taken }, fresh: false };
    const head = await readJpegInfo(file);
    if (!head.isJpeg) return { file, info: null, fresh: true };
    const { motion, special, pano, hdr, compacted } = head;
    return { file, info: { ...info, motion, special, pano, hdr, compacted, taken: head.taken || info.taken }, fresh: true };
  }
  if (c.type === 'video') {
    if (same && (cached.meta !== undefined || !wantVideo)) return { file, info: { ...cached, ...info, taken: cached.taken }, fresh: false };
    if (!wantVideo) return { file, info, fresh: !same };
    const meta = await quickProbe(file).catch(() => null);
    return { file, info: { ...info, meta, taken: meta?.created || info.taken }, fresh: true };
  }
  return { file, info, fresh: !same }; // png
}

// Si una sesión anterior se interrumpió a medio reemplazo, deja todo en un estado sano.
// El temporal se llama como el ORIGINAL (".foto.png.mkompact-tmp"), así se sabe si el original sigue ahí.
async function recoverTmp(dir, tmpName) {
  const origName = tmpName.slice(1, -TMP.length);
  const exists = await dir.getFileHandle(origName).then(() => true, () => false);
  if (exists) await dir.removeEntry(tmpName);  // no se alcanzó a reemplazar: se descarta el temporal
  else await renameFile(dir, await dir.getFileHandle(tmpName), await uniqueName(dir, targetName(origName)));
}

export async function getDirPath(root, path, create) {
  let d = root;
  for (const part of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(part, { create });
  return d;
}

async function copyInto(srcFile, dir, name) {
  const h = await dir.getFileHandle(name, { create: true });
  const w = await h.createWritable();
  await srcFile.stream().pipeTo(w);
  return h;
}

// move() aún no funciona en todas las carpetas reales de Android: si falla se copia y se borra.
async function moveFile(srcDir, srcHandle, dstDir, dstName) {
  try { await srcHandle.move(dstDir, dstName); return; } catch { /* sin soporte */ }
  await copyInto(await srcHandle.getFile(), dstDir, dstName);
  await srcDir.removeEntry(srcHandle.name);
}
const renameFile = (dir, h, newName) => moveFile(dir, h, dir, newName);

async function uniqueName(dir, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 0; ; i++) {
    const n = i ? `${base} (${i})${ext}` : name;
    const taken = await dir.getFileHandle(n).then(() => true, () => false);
    if (!taken) return n;
  }
}

async function trashDir(root) {
  const t = await root.getDirectoryHandle(TRASH, { create: true });
  // .nomedia: la galería no muestra los originales guardados en la papelera
  await t.getFileHandle('.nomedia').catch(() => t.getFileHandle('.nomedia', { create: true }));
  return t;
}

/**
 * Reemplazo seguro de un archivo:
 *  1. escribe la versión nueva en un temporal oculto junto al original
 *  2. la verifica
 *  3. mueve el original a la papelera (o lo borra)
 *  4. le da al temporal el nombre final
 */
export async function replaceFile({ root, item, write, finalize, verify, keepOriginal }) {
  const { dir, path, name } = item;
  const newName = targetName(name);
  const tmpName = `.${name}${TMP}`;
  const tmp = await dir.getFileHandle(tmpName, { create: true });
  try {
    const w = await tmp.createWritable();
    // Mediabunny cierra el stream por su cuenta (queda bloqueado por su writer); las fotos no.
    try { await write(w); if (!w.locked) await w.close(); } catch (e) { await w.abort().catch(() => {}); throw e; }
    await finalize?.(tmp);
    const outFile = await tmp.getFile();
    await verify(outFile);
  } catch (e) {
    await dir.removeEntry(tmpName).catch(() => {});
    throw e;
  }
  const newSize = (await tmp.getFile()).size;
  const orig = await dir.getFileHandle(name);
  let trashPath = null;
  if (keepOriginal) {
    const tdir = await getDirPath(await trashDir(root), path, true);
    const tname = await uniqueName(tdir, name);
    await moveFile(dir, orig, tdir, tname);
    trashPath = path ? `${path}/${tname}` : tname;
  } else {
    await dir.removeEntry(name);
  }
  const finalName = newName === name ? name : await uniqueName(dir, newName);
  await renameFile(dir, tmp, finalName);
  const final = await (await dir.getFileHandle(finalName)).getFile();
  return { finalName, newSize, newMtime: final.lastModified, trashPath };
}

// Regresa el original desde la papelera y quita la versión compacta.
export async function restore(root, rec) {
  const dir = await getDirPath(root, rec.path, true);
  const tdir = await getDirPath(await root.getDirectoryHandle(TRASH), rec.trashPath.split('/').slice(0, -1).join('/'), false);
  const th = await tdir.getFileHandle(rec.trashPath.split('/').pop());
  await dir.removeEntry(rec.finalName).catch(() => {});
  const name = await uniqueName(dir, rec.name);
  await moveFile(tdir, th, dir, name);
  return name;
}

export async function emptyTrash(root) {
  await root.removeEntry(TRASH, { recursive: true }).catch(e => { if (e.name !== 'NotFoundError') throw e; });
}

export async function trashSize(root) {
  let total = 0;
  async function walk(d) {
    for await (const [, h] of d.entries()) {
      if (h.kind === 'file') total += (await h.getFile()).size;
      else await walk(h);
    }
  }
  try { await walk(await root.getDirectoryHandle(TRASH)); } catch { /* no hay papelera */ }
  return total;
}
