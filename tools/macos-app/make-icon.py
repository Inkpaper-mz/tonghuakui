#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════
#  同花亏 · .app 图标生成（1024×1024 PNG）
#  用法： python3 make-icon.py 输出路径.png
#  需要 Pillow（macOS 上也可用系统 /usr/bin/python3 + 内置字体）
# ═══════════════════════════════════════════════════════════════
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print('需要 Pillow：pip3 install Pillow', file=sys.stderr)
    sys.exit(2)

OUT = sys.argv[1] if len(sys.argv) > 1 else 'icon-1024.png'
S = 1024

FONT_CANDIDATES = [
    ('/System/Library/Fonts/STHeiti Medium.ttc', 0),
    ('/System/Library/Fonts/Hiragino Sans GB.ttc', 0),
    ('/System/Library/Fonts/Supplemental/Songti.ttc', 0),
    ('/Library/Fonts/Arial Unicode.ttf', 0),
]

TOP = (245, 78, 84)
BOTTOM = (176, 14, 22)


def load_font(size):
    for path, idx in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size, index=idx)
        except Exception:
            continue
    return ImageFont.load_default()


def center_text(draw, box, text, font, fill):
    x0, y0, x1, y1 = box
    l, t, r, b = draw.textbbox((0, 0), text, font=font)
    draw.text((x0 + (x1 - x0 - (r - l)) / 2 - l,
               y0 + (y1 - y0 - (b - t)) / 2 - t), text, font=font, fill=fill)


img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

# ── 圆角矩形（macOS Big Sur 之后的图标规范：留边 + 连续圆角）──
pad = int(S * 0.075)
radius = int(S * 0.225)

# 竖向渐变
grad = Image.new('RGB', (1, S))
gd = ImageDraw.Draw(grad)
for y in range(S):
    k = y / (S - 1)
    gd.point((0, y), fill=tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * k) for i in range(3)))
grad = grad.resize((S, S))

mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([pad, pad, S - pad, S - pad], radius=radius, fill=255)
img.paste(grad, (0, 0), mask)

# ── 顶部高光 ──
hl = Image.new('L', (S, S), 0)
ImageDraw.Draw(hl).rounded_rectangle([pad, pad, S - pad, int(S * 0.52)], radius=radius, fill=58)
img.paste(Image.new('RGB', (S, S), (255, 255, 255)), (0, 0), hl)

# ── 右下角暗角，增强体积感 ──
sh = Image.new('L', (S, S), 0)
ImageDraw.Draw(sh).rounded_rectangle([pad, int(S * 0.55), S - pad, S - pad], radius=radius, fill=46)
img.paste(Image.new('RGB', (S, S), (0, 0, 0)), (0, 0), sh)

# ── 主体文字「亏」 ──
d = ImageDraw.Draw(img)
box = (pad, pad, S - pad, S - pad)
font = load_font(int(S * 0.60))
center_text(d, (box[0], box[1] + int(S * 0.035), box[2], box[3] + int(S * 0.035)), '亏', font, (120, 8, 14, 150))
center_text(d, box, '亏', font, (255, 255, 255, 255))

# ── 底部一条 K 线点缀（红涨绿跌的小色块）──
bar_y = int(S * 0.79)
bar_h = int(S * 0.075)
x = int(S * 0.30)
widths = [int(S * 0.035)] * 6
colors = [(255, 255, 255, 210), (255, 255, 255, 150), (255, 255, 255, 210),
          (255, 255, 255, 110), (255, 255, 255, 180), (255, 255, 255, 210)]
for w, c in zip(widths, colors):
    d.rounded_rectangle([x, bar_y, x + w, bar_y + bar_h], radius=w // 3, fill=c)
    x += w + int(S * 0.018)

img.save(OUT, 'PNG')
print(OUT)
