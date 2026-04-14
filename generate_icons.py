"""
Run once to generate PNG icons for the extension:
    python3 generate_icons.py

Requires: Pillow  (pip install Pillow)
"""

import math

try:
    from PIL import Image, ImageDraw
except ImportError:
    raise SystemExit("Please install Pillow first: pip install Pillow")

import os

SIZES = [16, 32, 48, 128]
OUT_DIR = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(OUT_DIR, exist_ok=True)


def draw_clock_icon(size: int) -> Image.Image:
    scale = 4  # super-sample for anti-aliasing
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    cx, cy, r = s // 2, s // 2, s // 2 - scale

    # Outer circle – indigo gradient approximated as flat color
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(79, 70, 229, 255))

    # Inner white circle
    ri = int(r * 0.72)
    d.ellipse([cx - ri, cy - ri, cx + ri, cy + ri], fill=(255, 255, 255, 255))

    # Clock hands
    lw = max(1, scale)

    def hand(angle_deg, length_frac):
        angle = math.radians(angle_deg - 90)
        length = ri * length_frac
        x2 = cx + length * math.cos(angle)
        y2 = cy + length * math.sin(angle)
        d.line([cx, cy, x2, y2], fill=(79, 70, 229, 255), width=lw)

    hand(0, 0.65)    # 12 o'clock (hour hand)
    hand(90, 0.80)   # 3 o'clock (minute hand)

    # Center dot
    dr = max(1, scale // 2)
    d.ellipse([cx - dr, cy - dr, cx + dr, cy + dr], fill=(79, 70, 229, 255))

    # Downsample
    img = img.resize((size, size), Image.LANCZOS)
    return img


for sz in SIZES:
    icon = draw_clock_icon(sz)
    path = os.path.join(OUT_DIR, f"icon{sz}.png")
    icon.save(path, "PNG")
    print(f"  Created {path}")

print("Done! All icons generated.")
