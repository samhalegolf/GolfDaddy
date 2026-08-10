/* Sharp-based frame compositor - the light export path.

   Renders a hole's surface directly as bitmap operations instead of asking the engine to
   build nested SVGs of base64 (which wrapped the same pixels 4-5x over, blew librsvg's 10MB
   XML limit, and OOM-killed workers).

   Everything here is NORTH-UP mercator (renderHoleSurfaceMercator) plus the course overview.
   There used to be a second renderer that baked the play-axis framing into the pixels, a port
   of the engine's playAxisSurfaceAsset - rotated per-capture affines, lens masks, the lot. It
   is gone: Play does its own framing at runtime from (originPx, captureZoom, image), so baking
   a second copy of that maths server-side only gave it somewhere to drift out of step.

   The recipe applies as libvips primitives:
     feColorMatrix saturate        -> modulate({saturation})
     feComponentTransfer linear    -> linear(contrast, 255*(brightness-1)/2)
     terrain relief layer          -> hillshade mask laid on flattened pixels with soft-light
     floodlight / mow lines        -> tiny raster-free SVGs (librsvg's happy path)
   The only SVGs rasterized are a few KB of gradients - no embedded images anywhere. */

import sharp from "sharp";

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, Number(v))); }
function num(v, fb) { const n = Number(v); return Number.isFinite(n) ? n : fb; }

/* Normalized web-mercator world (0..1), identical to the engine's projectLatLng. */
function world(pt) {
  if (!pt) return null;
  const lat = clamp(pt.lat, -85.05112878, 85.05112878);
  const sin = Math.sin(lat * Math.PI / 180);
  return { x: (Number(pt.lng) + 180) / 360, y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) };
}
function projectedBounds(bounds) {
  if (!bounds) return null;
  const nw = world({ lat: bounds.north, lng: bounds.west });
  const se = world({ lat: bounds.south, lng: bounds.east });
  if (!nw || !se) return null;
  return { left: nw.x, top: nw.y, right: se.x, bottom: se.y };
}

/* ---- recipe ----------------------------------------------------------------------------- */

export function recipeFilter(settings) {
  const turf = settings && settings.turf || {};
  const lighting = settings && settings.lighting || {};
  const green = clamp(num(turf.greenStrength, 0.35), 0, 3.5);
  const brightnessTarget = clamp(num(lighting.brightnessTarget, 52), 5, 115);
  const contrast = clamp(num(lighting.contrastTarget, 1), 0.55, 2.2);
  return {
    saturation: 1 + green * 0.55,
    brightness: clamp(1 + (brightnessTarget - 52) / 90, 0.45, 1.75),
    contrast
  };
}
/* Relief strength, as one number.

   toneSlope/toneLift used to live here and are gone. They existed to make a multiply blend
   behave: multiply leaves white untouched, so the mask had to be biased bright and only dip
   dark in the shadows. Soft-light's neutral is mid-grey, so that same bias pushed the entire
   mask above neutral and the blend could only ever lighten - turning the slider up washed
   the hole out instead of moulding it. Under soft-light the correct and sufficient control
   is how far the mask is allowed to travel from mid-grey, which is opacity. Two of the three
   knobs were compensating for the blend, so they went with it.

   The ramp is linear from zero rather than starting at 0.26: a slider nudged just off the
   stop should show a hint of relief, not snap straight to a quarter strength. */
function terrainParams(settings) {
  const tools = settings && settings.visualTools || {};
  const strength = clamp(num(tools.holeTerrainStrength, 0.9), 0, 1.6);
  return { strength, opacity: clamp(strength * 0.6, 0, 0.96) };
}
/* Lay relief onto flattened pixels with soft-light.

   Multiply, which this used to do, can only darken. You get the shadowed side of every roll
   and nothing at all on the lit side, so ground looks smudged rather than moulded and the
   whole frame loses brightness as strength rises - turning the slider up made the hole
   dimmer instead of more three-dimensional. Soft-light darkens below mid-grey and lightens
   above it, so a ridge gets its highlight and that is what reads as raised.

   sharp has no soft-light blend, hence raw pixels. The 256x256 lookup table costs 65k
   evaluations once and saves one pow and several branches per subpixel; at 3072x3072x3
   that is the difference between milliseconds and seconds.

   Call this AFTER the imagery is flattened and BEFORE mow lines and floodlight go on. Those
   are drawn marks, not ground - shading them would be shading the annotation. */
function softLightTable(opacity) {
  const table = new Uint8Array(256 * 256);
  for (let s = 0; s < 256; s++) {
    /* Fold opacity into the shade rather than cross-fading the result: pulling the mask
       toward mid-grey is exactly "less relief", and it keeps this to one pass. */
    const shade = 0.5 + (s / 255 - 0.5) * opacity;
    for (let b = 0; b < 256; b++) {
      const base = b / 255;
      const d = base <= 0.25 ? ((16 * base - 12) * base + 4) * base : Math.sqrt(base);
      const v = shade <= 0.5
        ? base - (1 - 2 * shade) * base * (1 - base)
        : base + (2 * shade - 1) * (d - base);
      table[s * 256 + b] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  return table;
}

function applyRelief(rgb, mask, opacity, channels) {
  if (!mask || !(opacity > 0)) return rgb;
  const table = softLightTable(opacity);
  const pixels = Math.min(mask.length, Math.floor(rgb.length / channels));
  for (let i = 0, p = 0; i < pixels; i++, p += channels) {
    const row = mask[i] * 256;
    rgb[p] = table[row + rgb[p]];
    rgb[p + 1] = table[row + rgb[p + 1]];
    rgb[p + 2] = table[row + rgb[p + 2]];
  }
  return rgb;
}

/* Flatten imagery, lay relief on the ground, then draw the overlays on top. One helper so
   the three renderers cannot drift apart on ordering, which is exactly how the old multiply
   ended up in three slightly different shapes. */
async function flattenWithRelief({ width, height, background, composites, relief, overlays, quality }) {
  let surface = sharp({ create: { width, height, channels: 3, background }, limitInputPixels: false })
    .composite(composites);
  if (relief) {
    const flat = await surface.raw().toBuffer({ resolveWithObject: true });
    applyRelief(flat.data, relief.data, relief.opacity, flat.info.channels);
    surface = sharp(flat.data, { raw: { width: flat.info.width, height: flat.info.height, channels: flat.info.channels }, limitInputPixels: false });
  }
  if (overlays && overlays.length) surface = surface.composite(overlays);
  return surface.jpeg({ quality }).toBuffer();
}

function mowingOpacity(value) {
  value = String(value || "");
  if (value === "Low") return 0.12;
  if (value === "Clear") return 0.28;
  if (value === "Prominent") return 0.48;
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, 0, 0.6) : 0;
}
function floodlightSettings(settings) {
  const f = settings && settings.floodlight || {};
  return {
    enabled: f.enabled === true,
    ambientLevel: clamp(num(f.ambientLevel, 24), 0, 100),
    litLevel: clamp(num(f.litLevel, 64), 0, 100),
    throwOff: clamp(num(f.throwOff, 0.35), 0, 1),
    spread: clamp(num(f.spread, 0.45), 0.05, 1),
    greenPool: clamp(num(f.greenPool, 0.8), 0, 1),
    greenPoolRadius: clamp(num(f.greenPoolRadius, 0.22), 0.05, 1)
  };
}

/* ---- light-effect SVGs (gradients only, never any raster) ------------------------------- */

/* size is just {width, height}; project maps a lat/lng onto those pixels. */
function floodlightSvg(size, pins, cfg, project) {
  const w = size.width, h = size.height;
  const dark = clamp(Math.pow((100 - cfg.ambientLevel) / 100, 1.15), 0, 1);
  const lit = clamp(cfg.litLevel / 100, 0, 1);
  const tee = project(pins.tee);
  const green = project(pins.green);
  let defs = "", maskContent = '<rect width="100%" height="100%" fill="white"/>';
  if (tee && green) {
    const route = (pins.route || []).map(pt => project(pt)).filter(Boolean);
    const pts = route.length >= 2 ? route : [tee, green];
    const corridorWidth = Math.max(24, w * (0.07 + cfg.spread * 0.6));
    const edgeStop = clamp(0.35 + (1 - cfg.throwOff) * 0.5, 0.35, 0.85);
    defs += '<radialGradient id="pool"><stop offset="0" stop-color="black" stop-opacity="' + lit + '"/><stop offset="' + edgeStop + '" stop-color="black" stop-opacity="' + (lit * 0.82) + '"/><stop offset="1" stop-color="black" stop-opacity="0"/></radialGradient>';
    const poolR = corridorWidth * 0.72;
    const step = Math.max(24, poolR * 0.6);
    const samples = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const len = Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y));
      const n = Math.max(1, Math.ceil(len / step));
      for (let s = 0; s <= n; s++) samples.push({ x: a.x + (b.x - a.x) * s / n, y: a.y + (b.y - a.y) * s / n });
    }
    samples.slice(0, 64).forEach(p => { maskContent += '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + poolR.toFixed(1) + '" fill="url(#pool)"/>'; });
    const shapePts = (pins.greenShape || []).map(pt => project(pt)).filter(Boolean);
    let poolCenter = green, greenExtent = 0;
    if (shapePts.length >= 3) {
      poolCenter = { x: shapePts.reduce((s, p) => s + p.x, 0) / shapePts.length, y: shapePts.reduce((s, p) => s + p.y, 0) / shapePts.length };
      shapePts.forEach(p => { greenExtent = Math.max(greenExtent, Math.hypot(p.x - poolCenter.x, p.y - poolCenter.y)); });
    }
    if (!greenExtent) greenExtent = corridorWidth * 0.5;
    const radius = Math.max(16, greenExtent * (1.2 + cfg.greenPoolRadius * 2.5));
    defs += '<radialGradient id="gpool" gradientUnits="userSpaceOnUse" cx="' + poolCenter.x.toFixed(1) + '" cy="' + poolCenter.y.toFixed(1) + '" r="' + radius.toFixed(1) + '"><stop offset="0" stop-color="black" stop-opacity="' + (lit * cfg.greenPool) + '"/><stop offset=".7" stop-color="black" stop-opacity="' + (lit * cfg.greenPool * 0.45) + '"/><stop offset="1" stop-color="black" stop-opacity="0"/></radialGradient>';
    maskContent += '<rect width="100%" height="100%" fill="url(#gpool)"/>';
  }
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><defs>' + defs + '<mask id="m">' + maskContent + '</mask></defs><rect width="100%" height="100%" fill="#04070b" opacity="' + dark + '" mask="url(#m)"/></svg>');
}

function mowSvg(width, height, opacity) {
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><defs><pattern id="mow" width="24" height="24" patternUnits="userSpaceOnUse" patternTransform="rotate(108)"><path d="M0 0 L0 24" stroke="rgba(255,255,255,' + (0.2 * opacity / 0.28).toFixed(3) + ')" stroke-width="1"/></pattern></defs><rect width="100%" height="100%" fill="url(#mow)"/></svg>');
}

function unworld(x, y) {
  const lng = x * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y;
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

/* North-up mercator hole surface - the frame GPS PLAY consumes. The v19 captured-surface
   pipeline models a surface as (originPx, captureZoom, image): lat/lng projects to surface
   pixels via mercator at captureZoom minus originPx. This renders the styled hole exactly on
   that grid (fractional captureZoom encodes the downscale), so the client can hand it to the
   existing renderer as a manifest with ONE tile - no new client-side projection code at all.
   Rotation-free compositing also makes it the cheapest render in the family. */
export async function renderHoleSurfaceMercator({ pins, captures, terrain, settings, maxDim = 2048, quality = 82 }) {
  const rects = captures.map(item => ({ item, pb: projectedBounds(item.entry.bounds) })).filter(r => r.pb);
  if (!rects.length) throw new Error("no positioned captures for mercator surface");
  const merged = {
    left: Math.min(...rects.map(r => r.pb.left)),
    top: Math.min(...rects.map(r => r.pb.top)),
    right: Math.max(...rects.map(r => r.pb.right)),
    bottom: Math.max(...rects.map(r => r.pb.bottom))
  };
  const spanPx19 = Math.max((merged.right - merged.left), (merged.bottom - merged.top)) * 256 * Math.pow(2, 19);
  const f = Math.min(1, maxDim / Math.max(1, spanPx19));
  /* captureZoom MUST be an integer. The GPS play renderer anchors the frame image to the map
     at this zoom while it projects the tee/green/ball markers independently; the locally
     captured surfaces it was built for are always whole-number zooms (z19/z20), and a
     fractional zoom (e.g. 18.58) desynchronises the image from the markers - the exact "tee is
     in the bushes" drift seen on cloud frames while local scans line up. Floor keeps the frame
     at or under maxDim (never upscales past the source) at the cost of up to one half-step of
     resolution; correctness over sharpness. */
  const captureZoom = Math.max(1, Math.floor(19 + Math.log2(f)));
  const scalePx = 256 * Math.pow(2, captureZoom);
  const originPx = { x: merged.left * scalePx, y: merged.top * scalePx };
  const W = Math.max(64, Math.round((merged.right - merged.left) * scalePx));
  const H = Math.max(64, Math.round((merged.bottom - merged.top) * scalePx));
  const fRecipe = recipeFilter(settings);
  const composites = [];
  rects.sort((a, b) => (num(a.item.entry.stitchLayer, 10) - num(b.item.entry.stitchLayer, 10)) || (num(a.item.entry.segmentIndex, 999) - num(b.item.entry.segmentIndex, 999)));
  for (const { item, pb } of rects) {
    const left = Math.round(pb.left * scalePx - originPx.x);
    const top = Math.round(pb.top * scalePx - originPx.y);
    const w = Math.max(1, Math.round((pb.right - pb.left) * scalePx));
    const h = Math.max(1, Math.round((pb.bottom - pb.top) * scalePx));
    const cropLeft = Math.max(0, -left), cropTop = Math.max(0, -top);
    const visW = Math.min(w - cropLeft, W - Math.max(0, left));
    const visH = Math.min(h - cropTop, H - Math.max(0, top));
    if (visW <= 0 || visH <= 0) continue;
    let layer = sharp(item.buffer, { limitInputPixels: false }).resize({ width: w, height: h, fit: "fill" })
      .linear(fRecipe.contrast, 255 * ((fRecipe.brightness - 1) / 2))
      .modulate({ saturation: fRecipe.saturation });
    if (cropLeft || cropTop || visW < w || visH < h) layer = sharp(await layer.raw().toBuffer(), { raw: { width: w, height: h, channels: 3 }, limitInputPixels: false }).extract({ left: cropLeft, top: cropTop, width: visW, height: visH });
    const buf = await layer.raw().toBuffer({ resolveWithObject: true });
    composites.push({ input: buf.data, raw: { width: buf.info.width, height: buf.info.height, channels: buf.info.channels }, left: Math.max(0, left), top: Math.max(0, top) });
  }
  const terrainCfg = terrainParams(settings);
  let reliefMask = null;
  if (terrain && terrainCfg.strength > 0.02) {
    const pb = projectedBounds(terrain.entry.bounds);
    if (pb) {
      const left = Math.round(pb.left * scalePx - originPx.x);
      const top = Math.round(pb.top * scalePx - originPx.y);
      const w = Math.max(1, Math.round((pb.right - pb.left) * scalePx));
      const h = Math.max(1, Math.round((pb.bottom - pb.top) * scalePx));
      /* The relief reference covers the whole course - clip it to the hole window. */
      const cropLeft = Math.max(0, -left), cropTop = Math.max(0, -top);
      const visW = Math.min(w - cropLeft, W - Math.max(0, left));
      const visH = Math.min(h - cropTop, H - Math.max(0, top));
      if (visW > 0 && visH > 0) {
        let terrainLayer = sharp(terrain.buffer, { limitInputPixels: false }).resize({ width: w, height: h, fit: "fill" }).ensureAlpha();
        if (cropLeft || cropTop || visW < w || visH < h) {
          terrainLayer = sharp(await terrainLayer.png().toBuffer(), { limitInputPixels: false }).extract({ left: cropLeft, top: cropTop, width: visW, height: visH });
        }
        const placed = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 128, g: 128, b: 128 } }, limitInputPixels: false })
          .composite([{ input: await terrainLayer.png().toBuffer(), left: Math.max(0, left), top: Math.max(0, top) }])
          .greyscale()
          .toColourspace("b-w")
          .raw().toBuffer({ resolveWithObject: true });
        reliefMask = { data: placed.data, opacity: terrainCfg.opacity };
      }
    }
  }
  const mercProject = (pt) => { const wp = world(pt); return wp ? { x: wp.x * scalePx - originPx.x, y: wp.y * scalePx - originPx.y } : null; };
  const overlays = [];
  const mow = mowingOpacity(settings && settings.mowingVisibility);
  if (mow > 0) overlays.push({ input: mowSvg(W, H, mow), blend: "over" });
  const flood = floodlightSettings(settings);
  if (flood.enabled) overlays.push({ input: floodlightSvg({ width: W, height: H }, pins, flood, mercProject), blend: "over" });
  const toneChannel = v => Math.round(Math.min(255, Math.max(0, v * fRecipe.contrast + 255 * ((fRecipe.brightness - 1) / 2))));
  const jpeg = await flattenWithRelief({
    width: W, height: H,
    background: { r: toneChannel(16), g: toneChannel(19), b: toneChannel(15) },
    composites, relief: reliefMask, overlays, quality
  });
  const nw = unworld(merged.left, merged.top);
  const se = unworld(merged.right, merged.bottom);
  return {
    jpeg,
    width: W,
    height: H,
    captureZoom,
    originPx,
    bounds: { north: nw.lat, west: nw.lng, south: se.lat, east: se.lng }
  };
}

export async function renderOverview({ backdrop, terrain, settings, width = 1440, quality = 80 }) {
  /* Everything happens AT the output size. sharp applies resize before composite regardless
     of call order, so mixing them in one pipeline shrank the base under a full-size overlay
     ("image to composite must have same dimensions or smaller"). Downscaling first also makes
     every subsequent op cheaper. */
  const f = recipeFilter(settings);
  const baseSmall = await sharp(backdrop.buffer, { limitInputPixels: false })
    .resize({ width, withoutEnlargement: true })
    .linear(f.contrast, 255 * ((f.brightness - 1) / 2))
    .modulate({ saturation: f.saturation })
    .jpeg({ quality: 95 }).toBuffer();
  const bMeta = await sharp(baseSmall).metadata();
  let base = sharp(baseSmall, { limitInputPixels: false });
  const terrainCfg = terrainParams(settings);
  if (terrain && terrainCfg.strength > 0.02) {
    const shaded = await sharp(terrain.buffer, { limitInputPixels: false })
      .resize({ width: bMeta.width, height: bMeta.height, fit: "fill" })
      .greyscale()
      .toColourspace("b-w")
      .raw().toBuffer({ resolveWithObject: true });
    const flat = await base.raw().toBuffer({ resolveWithObject: true });
    applyRelief(flat.data, shaded.data, terrainCfg.opacity, flat.info.channels);
    base = sharp(flat.data, { raw: { width: flat.info.width, height: flat.info.height, channels: flat.info.channels }, limitInputPixels: false });
  }
  const jpeg = await base.jpeg({ quality }).toBuffer();
  return { jpeg, width: bMeta.width, height: bMeta.height };
}
