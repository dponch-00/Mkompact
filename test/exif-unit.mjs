// Prueba de ensureDateTaken/patchExif sin navegador:
//   node test/exif-unit.mjs && python test/exif-unit-check.py
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseJpegHeader, ensureDateTaken, patchExif, assembleJpeg } from '../js/jpeg.js';

const dir = new URL('./out/unit/', import.meta.url);
mkdirSync(dir, { recursive: true });
const plain = readFileSync(new URL('./fixtures/sin_exif.jpg', import.meta.url));
const MS = Date.UTC(2015, 5, 15, 18, 30, 0);

// TIFF escrito a mano: IFD0 { Make, Orientation=6, [ExifIFD] } y ExifIFD { ExposureTime, [DateTimeOriginal] }
function tiff({ le, withExifIfd, withDate }) {
  const buf = new Uint8Array(512), dv = new DataView(buf.buffer);
  buf.set(le ? [0x49, 0x49] : [0x4D, 0x4D]); dv.setUint16(2, 42, le); dv.setUint32(4, 8, le);
  const make = 'Acme\0', date = '2001:02:03 04:05:06\0';
  const ifd0 = [[0x010F, 2, make.length, 200], [0x0112, 3, 1, 6]];
  if (withExifIfd) ifd0.push([0x8769, 4, 1, 100]);
  const writeIfd = (at, list) => {
    dv.setUint16(at, list.length, le);
    list.forEach(([tag, type, count, val], i) => {
      const e = at + 2 + i * 12;
      dv.setUint16(e, tag, le); dv.setUint16(e + 2, type, le); dv.setUint32(e + 4, count, le);
      if (type === 3) dv.setUint16(e + 8, val, le); else dv.setUint32(e + 8, val, le);
    });
    dv.setUint32(at + 2 + list.length * 12, 0, le);
  };
  writeIfd(8, ifd0);
  if (withExifIfd) {
    const ex = [[0x829A, 5, 1, 300]]; // ExposureTime (RATIONAL) -> 1/125
    if (withDate) ex.push([0x9003, 2, date.length, 250]);
    writeIfd(100, ex);
    dv.setUint32(300, 1, le); dv.setUint32(304, 125, le);
    for (let i = 0; i < date.length; i++) buf[250 + i] = date.charCodeAt(i);
  }
  for (let i = 0; i < make.length; i++) buf[200 + i] = make.charCodeAt(i);
  const out = new Uint8Array(6 + buf.length);
  out.set([0x45, 0x78, 0x69, 0x66, 0, 0]); out.set(buf, 6);
  return out;
}

const cases = {
  le_sin_exififd: tiff({ le: true, withExifIfd: false }),
  be_sin_exififd: tiff({ le: false, withExifIfd: false }),
  le_exififd_sin_fecha: tiff({ le: true, withExifIfd: true }),
  be_exififd_sin_fecha: tiff({ le: false, withExifIfd: true }),
  be_con_fecha: tiff({ le: false, withExifIfd: true, withDate: true }),
};
for (const [name, exif] of Object.entries(cases)) {
  const fixed = patchExif(ensureDateTaken(exif, MS), 640, 480);
  const jpg = assembleJpeg(plain, fixed, 'MKompact/1 prueba');
  writeFileSync(new URL(`${name}.jpg`, dir), jpg);
  const info = parseJpegHeader(jpg);
  console.log(name, 'make=', info.make, 'orient=', info.orientation, 'bytes', exif.length, '->', fixed.length);
}
