// Operaciones sobre carpetas del celular (File System Access API).
import { parseJpegHeader, tailHasSamsungMotion } from './jpeg.js';

export const TRASH = '.compacta-papelera';
const TMP = '.compacta-tmp';

const PHOTO = /\.(jpe?g)$/i, PNG = /\.png$/i, HEIC = /\.(heic|heif)$/i, VIDEO = /\.(mp4|mov|m4v|3gp)$/i;

export async function ensurePermission(handle, ask) {
  const opts = { mode: 'readwrite' };
  if (await handle.queryPermission(opts) === 'granted') return true;
  if (!ask) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}

// Recorre la carpeta y clasifica. Salta carpetas ocultas (incluida la papelera) y restos temporales.
export async function scan(root, onProgress, signal) {
  const items = [];
  const counts = { files: 0, heic: 0 };
  async function walk(dir, path) {
    for await (const [name, h] of dir.entries()) {
      if (signal?.aborted) return;
      if (name.startsWith('.')) {
        if (h.kind === 'file' && name.endsWith(TMP)) await recoverTmp(dir, name).catch(() => {});
        continue;
      }
      if (h.kind === 'directory') { await walk(h, path ? `${path}/${name}` : name); continue; }
      counts.files++;
      if (counts.files % 50 === 0) onProgress?.(counts.files);
      let type = PHOTO.test(name) ? 'photo' : PNG.test(name) ? 'png' : VIDEO.test(name) ? 'video' : HEIC.test(name) ? 'heic' : null;
      if (!type) continue;
      if (type === 'heic') { counts.heic++; continue; }
      const file = await h.getFile();
      const item = { dir, path, name, type, size: file.size, mtime: file.lastModified, file };
      if (type === 'photo') {
        const head = parseJpegHeader(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()));
        if (!head.isJpeg) continue;
        Object.assign(item, { width: head.width, height: head.height, motion: head.motion, hdr: head.hdr, compacted: head.compacted });
        if (!item.motion && file.size > 1024 * 1024) {
          const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 64 * 1024)).arrayBuffer());
          item.motion = tailHasSamsungMotion(tail);
        }
      }
      items.push(item);
    }
  }
  await walk(root, '');
  onProgress?.(counts.files);
  return { items, counts };
}

// Si una sesión anterior se interrumpió a medio reemplazo, deja todo en un estado sano.
async function recoverTmp(dir, tmpName) {
  const finalName = tmpName.slice(1, -TMP.length);
  const exists = await dir.getFileHandle(finalName).then(() => true, () => false);
  if (exists) await dir.removeEntry(tmpName);           // el original sigue ahí: se descarta el temporal
  else await renameFile(dir, await dir.getFileHandle(tmpName), finalName); // el original ya se había movido
}

async function getDirPath(root, path, create) {
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
export async function replaceFile({ root, item, newName, write, finalize, verify, keepOriginal }) {
  const { dir, path, name } = item;
  const tmpName = `.${newName}${TMP}`;
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
  return { finalName, newSize, trashPath };
}

// Regresa el original desde la papelera y quita la versión compacta.
export async function restore(root, rec) {
  const dir = await getDirPath(root, rec.path, true);
  const tdir = await getDirPath(await root.getDirectoryHandle(TRASH), rec.trashPath.split('/').slice(0, -1).join('/'), false);
  const th = await tdir.getFileHandle(rec.trashPath.split('/').pop());
  await dir.removeEntry(rec.finalName).catch(() => {});
  const name = await uniqueName(dir, rec.name);
  await moveFile(tdir, th, dir, name);
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
