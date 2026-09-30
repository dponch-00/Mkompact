# Verifica con PIL los JPEG generados por test/exif-unit.mjs.
import os, sys
from PIL import Image

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'unit')
from datetime import datetime, timedelta, timezone


def to_utc(stamp, offset):
    # Fecha local + OffsetTimeOriginal -> UTC, para no depender de la zona horaria de esta PC
    sign = -1 if offset.startswith('-') else 1
    h, m = offset[1:].split(':')
    tz = timezone(sign * timedelta(hours=int(h), minutes=int(m)))
    return datetime.strptime(stamp, '%Y:%m:%d %H:%M:%S').replace(tzinfo=tz).astimezone(timezone.utc)


expected_new = 'NUEVA'  # 2015-06-15 18:30:00 UTC
fails = 0
for name, want_date, want_exp in [
    ('le_sin_exififd', expected_new, None),
    ('be_sin_exififd', expected_new, None),
    ('le_exififd_sin_fecha', expected_new, 1 / 125),
    ('be_exififd_sin_fecha', expected_new, 1 / 125),
    ('be_con_fecha', '2001:02:03 04:05:06', 1 / 125),
]:
    im = Image.open(os.path.join(D, name + '.jpg'))
    ex = im.getexif()
    e2 = ex.get_ifd(0x8769)
    exp = e2.get(0x829A)
    got = (ex.get(0x010F), ex.get(0x0112), e2.get(0x9003), float(exp) if exp is not None else None)
    if want_date == expected_new:
        date_ok = bool(e2.get(0x9011)) and to_utc(got[2], e2.get(0x9011)) == datetime(2015, 6, 15, 18, 30, tzinfo=timezone.utc)
    else:
        date_ok = got[2] == want_date
    ok = got[0] == 'Acme' and got[1] == 1 and date_ok and (want_exp is None or abs(got[3] - want_exp) < 1e-9)
    offset_ok = True
    print(('ok    ' if ok and offset_ok else 'FALLA ') + name, got, 'offset', e2.get(0x9011))
    fails += not (ok and offset_ok)
print('TODO BIEN' if not fails else f'{fails} FALLAS')
sys.exit(1 if fails else 0)
