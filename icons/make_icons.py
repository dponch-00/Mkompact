# Genera el ícono "MK" (SVG y PNG) a partir de la fuente Cinzel incluida en fonts/.
#   python -m pip install fonttools brotli   (una sola vez)
#   python icons/make_icons.py
import os, tempfile
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageChops

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT = 'MK'
GOLD = [(0, '#fff3c4'), (.42, '#f0c24b'), (.75, '#b07d18'), (1, '#6e4a08')]
GLOW = '#ff3d0a'
OUTLINE = '#2b1a02'

font = instantiateVariableFont(TTFont(os.path.join(HERE, '..', 'fonts', 'cinzel.woff2')), {'wght': 900})
font.flavor = None
TTF = os.path.join(tempfile.gettempdir(), 'mkompact-cinzel-900.ttf')
font.save(TTF)
glyphs, cmap, upm = font.getGlyphSet(), font.getBestCmap(), font['head'].unitsPerEm
rgb = lambda h: tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def layout(size, box):
    """Letras centradas en un cuadro: (glifos, x de cada letra en unidades, escala, x izquierda, línea base)."""
    names = [cmap[ord(c)] for c in TEXT]
    xs, x = [], 0
    for n in names:
        xs.append(x)
        x += glyphs[n].width - upm * .02  # un poco más juntas que el espaciado normal
    bp = BoundsPen(glyphs)
    for n, ox in zip(names, xs):
        glyphs[n].draw(TransformPen(bp, (1, 0, 0, 1, ox, 0)))
    x0, y0, x1, y1 = bp.bounds
    scale = box * size / (x1 - x0)
    left = (size - (x1 - x0) * scale) / 2 - x0 * scale
    base = size / 2 + (y1 + y0) / 2 * scale
    return names, xs, scale, left, base


def svg(path_out, size=512, box=.74):
    names, xs, s, left, base = layout(size, box)
    pen = SVGPathPen(glyphs)
    for n, ox in zip(names, xs):
        glyphs[n].draw(TransformPen(pen, (s, 0, 0, -s, left + ox * s, base)))
    d = pen.getCommands()
    stops = ''.join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in GOLD)
    open(path_out, 'w', encoding='utf-8').write(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">{stops}</linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="{size * .03:.1f}"/></filter>
  </defs>
  <rect width="{size}" height="{size}" rx="{size * .19:.0f}" fill="#000"/>
  <path d="{d}" fill="{GLOW}" opacity=".55" filter="url(#glow)"/>
  <path d="{d}" fill="url(#g)" stroke="{OUTLINE}" stroke-width="{size * .008:.1f}" paint-order="stroke"/>
</svg>
''')


def gold_fill(S):
    col = Image.new('RGB', (1, S))
    for y in range(S):
        t = y / (S - 1)
        for (t0, c0), (t1, c1) in zip(GOLD, GOLD[1:]):
            if t <= t1:
                k = (t - t0) / (t1 - t0)
                a, b = rgb(c0), rgb(c1)
                col.putpixel((0, y), tuple(round(a[i] + (b[i] - a[i]) * k) for i in range(3)))
                break
    return col.resize((S, S))


def png(path_out, size, rounded=True, box=.74):
    S = size * 4  # se dibuja a 4x y se reduce: bordes suaves
    names, xs, s, left, base = layout(S, box)
    f = ImageFont.truetype(TTF, size=round(upm * s))
    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    for ch, ox in zip(TEXT, xs):
        md.text((left + ox * s, base), ch, font=f, fill=255, anchor='ls')
    bg = Image.new('L', (S, S), 0)
    if rounded:
        ImageDraw.Draw(bg).rounded_rectangle([0, 0, S - 1, S - 1], radius=S * .19, fill=255)
    else:
        bg.paste(255, (0, 0, S, S))
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    img.paste((0, 0, 0, 255), (0, 0), bg)
    glow = mask.filter(ImageFilter.GaussianBlur(S * .03)).point(lambda v: int(v * .55))
    img.paste(rgb(GLOW) + (255,), (0, 0), ImageChops.multiply(glow, bg))
    img.paste(rgb(OUTLINE) + (255,), (0, 0), mask.filter(ImageFilter.MaxFilter(max(3, int(S * .008) | 1))))
    img.paste(gold_fill(S).convert('RGBA'), (0, 0), mask)
    img.resize((size, size), Image.LANCZOS).save(path_out)


svg(os.path.join(HERE, 'icon.svg'))
png(os.path.join(HERE, 'icon-192.png'), 192)
png(os.path.join(HERE, 'icon-512.png'), 512)
png(os.path.join(HERE, 'icon-maskable-512.png'), 512, rounded=False, box=.6)  # dentro de la zona segura
print('ok')
