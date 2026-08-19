#!/usr/bin/env python3
"""Generate the native app icons and splash screens from the Clarity brand mark.

Run after the brand mark changes:   python3 dev/generate-app-icons.py

Everything below is derived from one master file so the iOS icon, the Android
launcher icons and the splash can never drift apart again -- which is exactly
what Apple flagged under guideline 2.3.8 when the Capacitor placeholder icon
shipped in build 740.
"""

import os
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(ROOT, "dev", "image-originals", "brand-cg-logo-white-g.png")

# The mark is drawn on its own near-black field. The splash uses the app's
# background colour from capacitor.config.json so there is no seam at boot.
FIELD = (6, 6, 6)
SPLASH_BG = (5, 8, 6)


def flattened():
    """The master mark as an opaque RGB square (iOS rejects icons with alpha)."""
    master = Image.open(MASTER).convert("RGBA")
    base = Image.new("RGBA", master.size, FIELD + (255,))
    return Image.alpha_composite(base, master).convert("RGB")


def cutout(flat):
    """The mark alone, keyed off its near-black field, cropped to its bounds."""
    a = np.array(flat).astype(int)
    lum = a.max(axis=2)
    alpha = np.clip((lum - 8) / 24.0, 0.0, 1.0) * 255.0
    rgba = np.dstack([a, alpha]).astype("uint8")
    img = Image.fromarray(rgba, "RGBA")
    return img.crop(img.getbbox())


def centred(mark, canvas_px, bg, scale):
    """Mark centred on a square canvas, longest side at `scale` of the canvas."""
    target = int(canvas_px * scale)
    ratio = target / max(mark.size)
    sized = mark.resize(
        (max(1, round(mark.width * ratio)), max(1, round(mark.height * ratio))),
        Image.LANCZOS,
    )
    canvas = Image.new("RGBA", (canvas_px, canvas_px), bg)
    canvas.paste(
        sized,
        ((canvas_px - sized.width) // 2, (canvas_px - sized.height) // 2),
        sized,
    )
    return canvas


def write(img, *parts):
    path = os.path.join(ROOT, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG")
    print("  " + os.path.relpath(path, ROOT))


flat = flattened()
mark = cutout(flat)
print("master mark:", mark.size)

# --- iOS ---------------------------------------------------------------
# Single 1024 universal slot, which is what modern Xcode wants. No alpha.
print("iOS app icon:")
write(flat.resize((1024, 1024), Image.LANCZOS),
      "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset", "AppIcon-512@2x.png")

# The splash is centre-cropped to the device, so the mark stays well inside
# the narrowest safe column (~46% of the canvas on a tall phone).
print("iOS splash:")
splash = centred(mark, 2732, SPLASH_BG + (255,), 0.22).convert("RGB")
for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
    write(splash, "ios", "App", "App", "Assets.xcassets", "Splash.imageset", name)

# --- Android -----------------------------------------------------------
# Legacy (API < 26) icons are pre-masked; adaptive foregrounds must keep the
# mark inside the centre 66% safe zone or the launcher mask clips it.
LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
FOREGROUND = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}

print("Android launcher icons:")
for density, size in LEGACY.items():
    square = flat.resize((size, size), Image.LANCZOS)
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

# Android splash screens are per-density AND per-orientation, and unlike the iOS
# one they are used at their own aspect ratio rather than centre-cropped - so the
# mark is sized against the SHORT edge to stay comfortable in both.
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
