/* Sharp-based frame compositor - the light export path.

   Renders a hole's play frame directly as bitmap operations instead of asking the engine to
   build nested SVGs of base64 (which wrapped the same pixels 4-5x over, blew librsvg's 10MB
   XML limit, and OOM-killed workers). The layout math is a faithful port of the engine's
   playAxisSurfaceAsset: identical axis, padding, margins, and per-capture affine, so frames
   land exactly where the browser sandbox puts them. The recipe applies as libvips primitives:
     feColorMatrix saturate        -> modulate({saturation})
     feComponentTransfer linear    -> linear(contrast, 255*(brightness-1)/2)
     terrain multiply layer        -> greyscale+linear hillshade composited blend:multiply
     floodlight / mow lines        -> tiny raster-free SVGs (librsvg's happy path)
   The only SVGs rasterized are a few KB of gradients - no embedded images anywhere. */

import sharp from "sharp";

const FRAME_ASPECT = 9 / 16;

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
function terrainParams(settings) {
  const tools = settings && settings.visualTools || {};
  const strength = clamp(num(tools.holeTerrainStrength, 0.9), 0, 1.6);
  return {
    strength,
    opacity: clamp(0.26 + strength * 0.46, 0.26, 0.96),
    toneSlope: clamp(1.05 + strength * 0.16, 1.05, 1.32),
    toneLift: clamp(0.14 - strength * 0.02, 0.08, 0.14)
  };
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

/* ---- play-axis frame layout (port of playAxisSurfaceAsset) ------------------------------ */

function frameAxis(pins, captures, width) {
  const tee = world(pins.tee);
  const green = world(pins.green);
  if (!tee || !green) return null;
  const dx = green.x - tee.x, dy = green.y - tee.y;
  const axisLen = Math.sqrt(dx * dx + dy * dy);
  if (!Number.isFinite(axisLen) || axisLen <= 1e-12) return null;
  const ux = dx / axisLen, uy = dy / axisLen, px = -uy, py = ux;
  const axisPoints = [];
  const push = (w) => { if (w) axisPoints.push({ cross: (w.x - tee.x) * px + (w.y - tee.y) * py, along: (w.x - tee.x) * ux + (w.y - tee.y) * uy }); };
  [pins.tee, pins.green, ...(pins.route || []), ...(pins.greenShape || [])].forEach(pt => push(world(pt)));
  captures.forEach(({ entry }) => {
    const pb = projectedBounds(entry.bounds);
    if (!pb) return;
    const capW = Math.max(1, Number(entry.width) || 1);
    const capH = Math.max(1, Number(entry.height) || 1);
    /* Like the engine: the LENS corners frame the axis, not the capture's axis-aligned cover
       (which is ~4x the lens for rotated corridors and would shrink everything to a stamp). */
    const lens = Array.isArray(entry.lensLocalCorners) && entry.lensLocalCorners.length >= 4
      ? entry.lensLocalCorners
      : [{ x: 0, y: 0 }, { x: capW, y: 0 }, { x: capW, y: capH }, { x: 0, y: capH }];
    lens.forEach(p => push({
      x: pb.left + (p.x / capW) * (pb.right - pb.left),
      y: pb.top + (p.y / capH) * (pb.bottom - pb.top)
    }));
  });
  if (axisPoints.length < 2) return null;
  let minCross = Math.min(...axisPoints.map(p => p.cross));
  let maxCross = Math.max(...axisPoints.map(p => p.cross));
  let minAlong = Math.min(...axisPoints.map(p => p.along));
  let maxAlong = Math.max(...axisPoints.map(p => p.along));
  let alongSpan = Math.max(axisLen, maxAlong - minAlong, 1e-12);
  let crossSpan = Math.max(maxCross - minCross, axisLen * 0.42, 1e-12);
  const crossPad = Math.max(crossSpan * 0.12, axisLen * 0.08);
  const alongPad = Math.max(alongSpan * 0.08, axisLen * 0.06);
  minCross -= crossPad; maxCross += crossPad; minAlong -= alongPad; maxAlong += alongPad;
  crossSpan = Math.max(1e-12, maxCross - minCross);
  alongSpan = Math.max(1e-12, maxAlong - minAlong);
  const height = Math.round(width / FRAME_ASPECT);
  const marginX = width * 0.07, marginY = height * 0.06;
  const scale = Math.min((width - marginX * 2) / crossSpan, (height - marginY * 2) / alongSpan);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return {
    origin: tee, ux, uy, px, py,
    centerCross: (minCross + maxCross) / 2,
    centerAlong: (minAlong + maxAlong) / 2,
    scale, width, height
  };
}

function frameProject(axis, pt) {
  const w = world(pt);
  if (!w) return null;
  const dx = w.x - axis.origin.x, dy = w.y - axis.origin.y;
  const cross = dx * axis.px + dy * axis.py;
  const along = dx * axis.ux + dy * axis.uy;
  return { x: axis.width / 2 + (cross - axis.centerCross) * axis.scale, y: axis.height / 2 - (along - axis.centerAlong) * axis.scale };
}

/* Engine group matrix: capture-local logical pixel -> frame pixel. */
function captureMatrix(axis, entry) {
  const pb = projectedBounds(entry.bounds);
  if (!pb) return null;
  const capW = Math.max(1, Number(entry.width) || 1);
  const capH = Math.max(1, Number(entry.height) || 1);
  const spanX = Math.max(1e-12, pb.right - pb.left);
  const spanY = Math.max(1e-12, pb.bottom - pb.top);
  const { origin, ux, uy, px, py, scale, width, height, centerCross, centerAlong } = axis;
  const baseCross = (pb.left - origin.x) * px + (pb.top - origin.y) * py;
  const baseAlong = (pb.left - origin.x) * ux + (pb.top - origin.y) * uy;
  return {
    a: spanX / capW * px * scale,
    b: -(spanX / capW) * ux * scale,
    c: spanY / capH * py * scale,
    d: -(spanY / capH) * uy * scale,
    e: width / 2 + (baseCross - centerCross) * scale,
    f: height / 2 - (baseAlong - centerAlong) * scale,
    capW, capH
  };
}
function applyMatrix(m, x, y) { return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }; }

/* ---- capture layer: mask (lens), scale, rotate, position -------------------------------- */

async function captureLayer(axis, entry, buffer, tone) {
  const m = captureMatrix(axis, entry);
  if (!m) return null;
  const meta = await sharp(buffer).metadata();
  const bufW = meta.width, bufH = meta.height;
  const k = m.capW / bufW; /* logical px per buffer px */
  let image = sharp(buffer).ensureAlpha();
  const lens = Array.isArray(entry.lensLocalCorners) && entry.lensLocalCorners.length >= 4 ? entry.lensLocalCorners : null;
  if (lens) {
    const pts = lens.map(p => (p.x / k) + "," + (p.y / k)).join(" ");
    const maskSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="' + bufW + '" height="' + bufH + '"><polygon points="' + pts + '" fill="white"/></svg>');
    const masked = await image.composite([{ input: maskSvg, blend: "dest-in" }]).raw().toBuffer();
    image = sharp(masked, { raw: { width: bufW, height: bufH, channels: 4 }, limitInputPixels: false });
  }
  /* Uniform scale + rotation (the matrix is orthogonal by construction). Tone applies here,
     per layer, inside the same pipeline - per-pixel ops commute with compositing, so this is
     identical to toning the finished composite while saving two full-canvas encode/decode
     round-trips. Intermediates stay RAW: no PNG/JPEG churn between stages. */
  const s = Math.hypot(m.a, m.b) * k;
  const angleDeg = Math.atan2(m.b, m.a) * 180 / Math.PI;
  const scaledW = Math.max(1, Math.round(bufW * s));
  const scaledH = Math.max(1, Math.round(bufH * s));
  image = image.resize({ width: scaledW, height: scaledH, fit: "fill" })
    .rotate(angleDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
  if (tone) image = image.linear(tone.contrast, 255 * ((tone.brightness - 1) / 2)).modulate({ saturation: tone.saturation });
  const rotated = await image.raw().toBuffer({ resolveWithObject: true });
  const rW = rotated.info.width, rH = rotated.info.height;
  /* Position: the rotated output's bbox top-left equals the transformed rect's bbox. */
  const corners = [[0, 0], [m.capW, 0], [m.capW, m.capH], [0, m.capH]].map(([x, y]) => applyMatrix(m, x, y));
  const left = Math.round(Math.min(...corners.map(c => c.x)));
  const top = Math.round(Math.min(...corners.map(c => c.y)));
  /* Bleed deliberately overflows the frame; sharp requires overlays to fit inside the canvas,
     so clip each layer to its visible intersection and clamp the offset. */
  const cropLeft = Math.max(0, -left), cropTop = Math.max(0, -top);
  const visW = Math.min(rW - cropLeft, axis.width - Math.max(0, left));
  const visH = Math.min(rH - cropTop, axis.height - Math.max(0, top));
  if (visW <= 0 || visH <= 0) return null;
  const needsCrop = cropLeft || cropTop || visW < rW || visH < rH;
  const clipped = needsCrop
    ? await sharp(rotated.data, { raw: { width: rW, height: rH, channels: rotated.info.channels }, limitInputPixels: false }).extract({ left: cropLeft, top: cropTop, width: visW, height: visH }).raw().toBuffer({ resolveWithObject: true })
    : rotated;
  return {
    input: clipped.data,
    raw: { width: clipped.info.width, height: clipped.info.height, channels: clipped.info.channels },
    left: Math.max(0, left), top: Math.max(0, top),
    layer: num(entry.stitchLayer, 10), segment: num(entry.segmentIndex, 999), id: String(entry.id || "")
  };
}

/* ---- light-effect SVGs (gradients only, never any raster) ------------------------------- */

function floodlightSvg(axis, pins, cfg, projectOverride) {
  const project = projectOverride || ((pt) => frameProject(axis, pt));
  const w = axis.width, h = axis.height;
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

/* ---- renderers -------------------------------------------------------------------------- */

export async function renderHoleFrame({ pins, captures, terrain, settings, width = 1440, quality = 82 }) {
  const axis = frameAxis(pins, captures, width);
  if (!axis) throw new Error("play axis could not be derived (missing tee/green)");
  const f = recipeFilter(settings);
  const layers = [];
  for (const item of captures) {
    const layer = await captureLayer(axis, item.entry, item.buffer, f);
    if (layer) layers.push(layer);
  }
  if (!layers.length) throw new Error("no renderable capture layers");
  layers.sort((a, b) => a.layer - b.layer || a.segment - b.segment || a.id.localeCompare(b.id));
  const composites = layers.map(l => ({ input: l.input, raw: l.raw, left: l.left, top: l.top }));
  /* Terrain relief: hillshade placed with the same matrix, desaturated, multiplied. */
  const terrainCfg = terrainParams(settings);
  if (terrain && terrainCfg.strength > 0.02) {
    const layer = await captureLayer(axis, terrain.entry, terrain.buffer, null);
    if (layer) {
      /* greyscale() collapses to a b-w colourspace; force back to srgb so the raw buffer has
         the channel count the final composite expects. */
      const shaded = await sharp({ create: { width: axis.width, height: axis.height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } }, limitInputPixels: false })
        .composite([{ input: layer.input, raw: layer.raw, left: layer.left, top: layer.top }])
        .greyscale()
        .toColourspace("srgb")
        .linear(terrainCfg.toneSlope, 255 * terrainCfg.toneLift)
        .ensureAlpha(terrainCfg.opacity)
        .raw().toBuffer({ resolveWithObject: true });
      composites.push({ input: shaded.data, raw: { width: shaded.info.width, height: shaded.info.height, channels: shaded.info.channels }, blend: "multiply" });
    }
  }
  const mow = mowingOpacity(settings && settings.mowingVisibility);
  if (mow > 0) composites.push({ input: mowSvg(axis.width, axis.height, mow), blend: "over" });
  const flood = floodlightSettings(settings);
  if (flood.enabled) composites.push({ input: floodlightSvg(axis, pins, flood), blend: "over" });
  /* Background pushed through the same tone math the layers got, then ONE composite pass and
     ONE encode - the double full-canvas JPEG round-trip was a third of the render time. */
  const toneChannel = v => Math.round(Math.min(255, Math.max(0, v * f.contrast + 255 * ((f.brightness - 1) / 2))));
  const jpeg = await sharp({ create: { width: axis.width, height: axis.height, channels: 3, background: { r: toneChannel(16), g: toneChannel(19), b: toneChannel(15) } }, limitInputPixels: false })
    .composite(composites)
    .jpeg({ quality }).toBuffer();
  return {
    jpeg,
    width: axis.width,
    height: axis.height,
    playAxis: { origin: axis.origin, ux: axis.ux, uy: axis.uy, px: axis.px, py: axis.py, centerCross: axis.centerCross, centerAlong: axis.centerAlong, scale: axis.scale, width: axis.width, height: axis.height }
  };
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
        const placed = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } }, limitInputPixels: false })
          .composite([{ input: await terrainLayer.png().toBuffer(), left: Math.max(0, left), top: Math.max(0, top) }])
          .greyscale()
          .toColourspace("srgb")
          .linear(terrainCfg.toneSlope, 255 * terrainCfg.toneLift)
          .ensureAlpha(terrainCfg.opacity)
          .raw().toBuffer({ resolveWithObject: true });
        composites.push({ input: placed.data, raw: { width: placed.info.width, height: placed.info.height, channels: placed.info.channels }, blend: "multiply" });
      }
    }
  }
  const mercProject = (pt) => { const wp = world(pt); return wp ? { x: wp.x * scalePx - originPx.x, y: wp.y * scalePx - originPx.y } : null; };
  const mow = mowingOpacity(settings && settings.mowingVisibility);
  if (mow > 0) composites.push({ input: mowSvg(W, H, mow), blend: "over" });
  const flood = floodlightSettings(settings);
  if (flood.enabled) composites.push({ input: floodlightSvg({ width: W, height: H }, pins, flood, mercProject), blend: "over" });
  const toneChannel = v => Math.round(Math.min(255, Math.max(0, v * fRecipe.contrast + 255 * ((fRecipe.brightness - 1) / 2))));
  const jpeg = await sharp({ create: { width: W, height: H, channels: 3, background: { r: toneChannel(16), g: toneChannel(19), b: toneChannel(15) } }, limitInputPixels: false })
    .composite(composites)
    .jpeg({ quality }).toBuffer();
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
      .toColourspace("srgb")
      .linear(terrainCfg.toneSlope, 255 * terrainCfg.toneLift)
      .ensureAlpha(terrainCfg.opacity)
      .raw().toBuffer({ resolveWithObject: true });
    base = base.composite([{ input: shaded.data, raw: { width: shaded.info.width, height: shaded.info.height, channels: shaded.info.channels }, blend: "multiply" }]);
  }
  const jpeg = await base.jpeg({ quality }).toBuffer();
  return { jpeg, width: bMeta.width, height: bMeta.height };
}
