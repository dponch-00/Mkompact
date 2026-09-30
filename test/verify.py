# Revisa los archivos exportados a test/out/ contra sus originales en la papelera.
#   python test/verify.py
import os, subprocess, sys
from PIL import Image, ImageOps, ImageChops, ImageStat

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
TRASH = os.path.join(OUT, '.compacta-papelera')
fails = 0


def check(cond, msg):
    global fails
    print(('  ok   ' if cond else '  FALLA ') + msg)
    if not cond:
        fails += 1


for rel in ['IMG_rotada.jpg', 'sub/PXL_sub.jpg', 'sin_exif.jpg', 'SAMSUNG_normal.jpg', 'Screenshot_1.jpg']:
    new_p = os.path.join(OUT, rel)
    orig_rel = rel.replace('Screenshot_1.jpg', 'Screenshot_1.png')
    orig_p = os.path.join(TRASH, orig_rel)
    if not (os.path.exists(new_p) and os.path.exists(orig_p)):
        print(f'{rel}: no está (se omitió)')
        continue
    print(rel)
    new, orig = Image.open(new_p), Image.open(orig_p)
    ne, oe = new.getexif(), orig.getexif()
    check(ne.get(0x0112) in (None, 1), f'orientación = {ne.get(0x0112)}')
    for tag, name in [(0x010F, 'Make'), (0x0110, 'Model')]:
        check(ne.get(tag) == oe.get(tag), f'{name} = {ne.get(tag)!r}')
    check(ne.get_ifd(0x8825) == oe.get_ifd(0x8825), 'GPS igual al original')
    dto = ne.get_ifd(0x8769).get(0x9003)
    check(bool(dto) and (oe.get_ifd(0x8769).get(0x9003) in (None, dto)), f'fecha de captura = {dto}')
    check(bool(new.info.get('comment', b'').startswith(b'Compacta/1')), 'marca Compacta')
    # Comparación visual: el original girado según EXIF debe verse igual que la versión nueva.
    upright = ImageOps.exif_transpose(orig).convert('RGB')
    check(abs(upright.width / upright.height - new.width / new.height) < 0.01,
          f'proporción {upright.size} -> {new.size}')
    a = upright.resize((96, 96)).convert('L')
    b = new.convert('RGB').resize((96, 96)).convert('L')
    diff = ImageStat.Stat(ImageChops.difference(a, b)).mean[0]
    check(diff < 4, f'diferencia visual media {diff:.2f}')


def probe(p):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:format_tags=creation_time,location,comment',
                        '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'default=nw=1', p],
                       capture_output=True, text=True)
    return r.stdout


for rel, orig_rel in [('VID_2021.mp4', 'VID_2021.mp4'), ('sub/VID_rot.mp4', 'sub/VID_rot.mov')]:
    new_p, orig_p = os.path.join(OUT, rel), os.path.join(TRASH, orig_rel)
    if not os.path.exists(new_p):
        continue
    print(rel)
    n, o = probe(new_p), probe(orig_p)
    get = lambda s, k: next((l.split('=', 1)[1] for l in s.splitlines() if l.startswith(k + '=')), None)
    check(get(n, 'TAG:creation_time') == get(o, 'TAG:creation_time'), f"fecha = {get(n, 'TAG:creation_time')}")
    check(abs(float(get(n, 'duration')) - float(get(o, 'duration'))) < 0.2, f"duración = {get(n, 'duration')}")
    check(('codec_type=audio' in n) == ('codec_type=audio' in o), 'audio conservado')
    check((get(n, 'TAG:comment') or '').startswith('Compacta/1'), 'marca Compacta')
    dec = subprocess.run(['ffmpeg', '-v', 'error', '-i', new_p, '-f', 'null', '-'], capture_output=True, text=True)
    check(dec.returncode == 0 and not dec.stderr.strip(), 'se decodifica completo sin errores')

print('\n' + ('TODO BIEN' if not fails else f'{fails} FALLAS'))
sys.exit(1 if fails else 0)
