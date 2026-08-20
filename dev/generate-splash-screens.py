#!/usr/bin/env python3
"""Generate the iOS and Android splash screens from the Clarity header/badge
mark.

Master: dev/image-originals/brand-cg-logo-white-g.png -- the same "kept
original" dev/optimise-image-assets.js resizes for the in-app header logo,
auth-card mark and transactional-email logo (assets/brand/cg-logo-white-g.png).

Renamed from generate-app-icons.py, which originally also wrote the iOS
Assets.xcassets icon and the Android mipmap launcher icons from this same
master. The app icon is a distinct brand mark now (a different master, see
dev/generate-app-icons-clarity-caddy.py) -- keeping both scripts writing the
same output files from two different sources was exactly the kind of drift
this tooling was built to prevent (see APP_REVIEW_FIXES_2026-08-19.md).

Run after the header/splash mark changes:
    python3 dev/generate-splash-screens.py
"""

import os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(ROOT, "dev", "image-originals", "brand-cg-logo-white-g.png")

# The splash uses the app's own launch background colour from
# capacitor.config.json, so there is no seam at boot -- independent of
# whatever field colour the mark itself sits on.
SPLASH_BG = (5, 8, 6)


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


def write(img, *parts):
    path = os.path.join(ROOT, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG")
    print("  " + os.path.relpath(path, ROOT))


master = Image.open(MASTER).convert("RGBA")
field = field_color(master)
mark = cutout(master, field)
print("field colour:", field, "#%02X%02X%02X" % field)
print("splash mark:", mark.size)

# iOS splash is centre-cropped to the device, so the mark stays well inside
# the narrowest safe column (~46% of the canvas on a tall phone).
print("iOS splash:")
target = int(2732 * 0.22)
ratio = target / max(mark.size)
sized = mark.resize((max(1, round(mark.width * ratio)), max(1, round(mark.height * ratio))), Image.LANCZOS)
canvas = Image.new("RGBA", (2732, 2732), SPLASH_BG + (255,))
canvas.paste(sized, ((2732 - sized.width) // 2, (2732 - sized.height) // 2), sized)
splash = canvas.convert("RGB")
for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
    write(splash, "ios", "App", "App", "Assets.xcassets", "Splash.imageset", name)

# Android splash screens are per-density AND per-orientation, and unlike the
# iOS one they are used at their own aspect ratio rather than centre-cropped
# -- so the mark is sized against the SHORT edge to stay comfortable in both.
SPLASH = {
    "drawable": (480, 320),
    "drawable-land-mdpi": (480, 320), "drawable-port-mdpi": (320, 480),
    "drawable-land-hdpi": (800, 480), "drawable-port-hdpi": (480, 800),
    "drawable-land-xhdpi": (1280, 720), "drawable-port-xhdpi": (720, 1280),
    "drawable-land-xxhdpi": (1600, 960), "drawable-port-xxhdpi": (960, 1600),
    "drawable-land-xxxhdpi": (1920, 1280), "drawable-port-xxxhdpi": (1280, 1920),
}

print("Android splash:")
for folder, (w, h) in SPLASH.items():
    short = min(w, h)
    ratio = (short * 0.30) / max(mark.size)
    sized = mark.resize((max(1, round(mark.width * ratio)), max(1, round(mark.height * ratio))), Image.LANCZOS)
    canvas = Image.new("RGBA", (w, h), SPLASH_BG + (255,))
    canvas.paste(sized, ((w - sized.width) // 2, (h - sized.height) // 2), sized)
    write(canvas.convert("RGB"), "android", "app", "src", "main", "res", folder, "splash.png")

print("done")
