#!/usr/bin/env python3
"""Generate the native (iOS + Android) app icon from the Clarity Caddy app
icon master.

Master: dev/image-originals/brand-clarity-app-icon.png -- the same "kept
original" dev/optimise-image-assets.js resizes for the web favicon /
apple-touch-icon (assets/brand/clarity-app-icon.png). This script covers what
that one doesn't: the iOS Assets.xcassets icon and the Android mipmap
launcher icons (legacy + round + adaptive foreground), plus the adaptive
icon's background colour resource, which has to match the mark's own field
or the round/adaptive launcher shows a seam of the old colour around it.

Deliberately separate from dev/generate-app-icons.py, which drives the
in-app header logo (assets/brand/cg-logo-white-g.png) and both splash
screens from a different master file -- the header logo and the app icon
are different brand marks and must not be forced back onto one shared
source.

Run after the app icon master changes:
    python3 dev/generate-app-icons-clarity-caddy.py
"""

import os
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(ROOT, "dev", "image-originals", "brand-clarity-app-icon.png")


def field_color(master):
    """The mark's flat background fill, detected as the modal opaque colour
    (coarsely quantised to absorb anti-aliasing noise) rather than
    hand-picked, so a future re-run on a redrawn master finds the right
    field on its own."""
    a = np.array(master.convert("RGBA"))
    opaque = a[a[..., 3] > 250][:, :3]
    quant = (opaque // 4 * 4)
    vals, counts = np.unique(quant, axis=0, return_counts=True)
    mode = vals[np.argmax(counts)]
    return tuple(int(v) for v in mode)


def flattened(master, field):
    """The master as an opaque RGBA square -- alpha composited onto its own
    field colour so the transparent corners fill in seamlessly (iOS also
    rejects an icon that carries alpha)."""
    base = Image.new("RGBA", master.size, field + (255,))
    return Image.alpha_composite(base, master.convert("RGBA"))


def cutout(master, field):
    """The mark alone, keyed off its own field colour, cropped to its
    bounds. Soft alpha falloff around the threshold so the edge
    anti-aliases instead of banding."""
    a = np.array(master.convert("RGBA")).astype(float)
    rgb, alpha = a[..., :3], a[..., 3]
    dist = np.sqrt(((rgb - np.array(field)) ** 2).sum(axis=2))
    NEAR, FAR = 14.0, 30.0
    keep = np.clip((dist - NEAR) / (FAR - NEAR), 0.0, 1.0) * 255.0
    out_alpha = np.minimum(alpha, keep)
    rgba = np.dstack([a[..., :3], out_alpha]).astype("uint8")
    img = Image.fromarray(rgba, "RGBA")
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def centred(mark, canvas_px, bg, scale):
    target = int(canvas_px * scale)
    ratio = target / max(mark.size)
    sized = mark.resize(
        (max(1, round(mark.width * ratio)), max(1, round(mark.height * ratio))),
        Image.LANCZOS,
    )
    canvas = Image.new("RGBA", (canvas_px, canvas_px), bg)
    canvas.paste(sized, ((canvas_px - sized.width) // 2, (canvas_px - sized.height) // 2), sized)
    return canvas


def write(img, *parts):
    path = os.path.join(ROOT, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG")
    print("  " + os.path.relpath(path, ROOT))


master = Image.open(MASTER).convert("RGBA")
field = field_color(master)
print("field colour:", field, "#%02X%02X%02X" % field)

flat = flattened(master, field)
mark = cutout(master, field)
print("master mark:", mark.size)

# --- iOS ---------------------------------------------------------------
print("iOS app icon:")
write(flat.resize((1024, 1024), Image.LANCZOS).convert("RGB"),
      "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset", "AppIcon-512@2x.png")

# --- Android -------------------------------------------------------------
LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
FOREGROUND = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}

print("Android launcher icons:")
for density, size in LEGACY.items():
    square = flat.resize((size, size), Image.LANCZOS).convert("RGB")
    write(square, "android", "app", "src", "main", "res", "mipmap-" + density, "ic_launcher.png")

    circle = square.convert("RGBA")
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    circle.putalpha(mask.resize((size, size), Image.LANCZOS))
    write(circle, "android", "app", "src", "main", "res", "mipmap-" + density, "ic_launcher_round.png")

print("Android adaptive foregrounds:")
for density, size in FOREGROUND.items():
    write(centred(mark, size, (0, 0, 0, 0), 0.56),
          "android", "app", "src", "main", "res", "mipmap-" + density, "ic_launcher_foreground.png")

# Adaptive icon background colour resource -- must match the mark's own
# field or the launcher mask shows a seam of the old colour around the icon.
bg_path = os.path.join(ROOT, "android", "app", "src", "main", "res", "values", "ic_launcher_background.xml")
hexcolor = "#%02X%02X%02X" % field
with open(bg_path, "w") as f:
    f.write(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<resources>\n"
        "    <!-- Matches the app icon mark's own field colour (see\n"
        "         dev/generate-app-icons-clarity-caddy.py). -->\n"
        '    <color name="ic_launcher_background">' + hexcolor + "</color>\n"
        "</resources>\n"
    )
print("Android adaptive background:", hexcolor)

# --- Web landing page (welcome.html shows this at 82x82) -----------------
write(flat.resize((256, 256), Image.LANCZOS).convert("RGB"), "assets", "landing", "clarity-app-icon.png")

print("done")
