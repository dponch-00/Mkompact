# Genera icon-192.png e icon-512.png a partir del mismo diseño que icon.svg.
#   python icons/make_icons.py
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def hexrgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def gold_at(y, top, bottom):
    t = min(1, max(0, (y - top) / (bottom - top)))
    stops = [(0, hexrgb('#fff1b8')), (.45, hexrgb('#e0b243')), (1, hexrgb('#7a4e0e'))]
    for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
        if t <= t1:
            return lerp(c0, c1, (t - t0) / (t1 - t0))
    return stops[-1][1]


def render(size, maskable=False):
    S = 4 * size
    k = S / 512
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    bg = hexrgb('#0b0806')
    if maskable:
        d.rectangle([0, 0, S, S], fill=bg)
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=96 * k, fill=bg)
    # Para el ícono "maskable" el emblema se reduce y queda dentro de la zona segura (círculo del 80 %).
    s = .82 if maskable else 1
    c = 256 * k
    P = lambda x, y: (c + (x - 256) * k * s, c + (y - 256) * k * s)
    # núcleo rojo con degradado radial
    R = 196
    for i in range(R, 0, -2):
        t = i / R
        col = lerp(hexrgb('#b3160e'), hexrgb('#5a0606'), min(1, t / .55)) if t < .55 else lerp(hexrgb('#5a0606'), hexrgb('#1c0202'), (t - .55) / .45)
        x0, y0 = P(256 - i, 256 - 20 * (1 - t) - i)
        x1, y1 = P(256 + i, 256 - 20 * (1 - t) + i)
        d.ellipse([x0, y0, x1, y1], fill=col)
    # anillo dorado (con degradado vertical)
    ring = Image.new('L', (S, S), 0)
    rd = ImageDraw.Draw(ring)
    x0, y0 = P(256 - 208, 256 - 208); x1, y1 = P(256 + 208, 256 + 208)
    rd.ellipse([x0, y0, x1, y1], fill=255)
    x0, y0 = P(256 - 184, 256 - 184); x1, y1 = P(256 + 184, 256 + 184)
    rd.ellipse([x0, y0, x1, y1], fill=0)
    grad = Image.new('RGBA', (S, S))
    gd = ImageDraw.Draw(grad)
    top, bottom = P(0, 48)[1], P(0, 464)[1]
    for y in range(S):
        gd.line([(0, y), (S, y)], fill=gold_at(y, top, bottom) + (255,))
    im.paste(grad, (0, 0), ring)
    x0, y0 = P(256 - 168, 256 - 168); x1, y1 = P(256 + 168, 256 + 168)
    d.ellipse([x0, y0, x1, y1], outline=(224, 178, 67, 140), width=max(1, round(3 * k * s)))
    # puntas hacia el centro + rombo
    shapes = [
        [(256, 214), (214, 128), (298, 128)], [(256, 298), (214, 384), (298, 384)],
        [(214, 256), (128, 214), (128, 298)], [(298, 256), (384, 214), (384, 298)],
        [(256, 228), (284, 256), (256, 284), (228, 256)],
    ]
    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    for sh in shapes:
        md.polygon([P(x, y) for x, y in sh], fill=255)
    top, bottom = P(0, 128)[1], P(0, 384)[1]
    grad2 = Image.new('RGBA', (S, S))
    gd2 = ImageDraw.Draw(grad2)
    for y in range(S):
        gd2.line([(0, y), (S, y)], fill=gold_at(y, top, bottom) + (255,))
    im.paste(grad2, (0, 0), mask)
    return im.resize((size, size), Image.LANCZOS)


render(192).save(os.path.join(HERE, 'icon-192.png'))
render(512).save(os.path.join(HERE, 'icon-512.png'))
render(512, maskable=True).save(os.path.join(HERE, 'icon-maskable-512.png'))
print('ok')
