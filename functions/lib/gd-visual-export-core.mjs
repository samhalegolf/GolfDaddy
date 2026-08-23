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
/* The green-reading maths is shared with the phone, so it lives in scripts/ and is pinned for
   bundling by netlify.toml included_files - same arrangement as the bubble signals core. What
   crosses the boundary is a display list in metres; turning that into SVG paths is this file's
   job because the projection is. */
import greenCore from "../../scripts/gd-green-contours-core.js";

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, Number(v))); }
function num(v, fb) { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function legacyEffectToggleState(group, settings) {
  settings = settings || {};
  const turf = settings.turf || {}, lighting = settings.lighting || {}, tools = settings.visualTools || {};
  if (group === "turf") return Object.keys(turf).length > 0 || clamp(num(turf.targetPull, 1), 0, 1) > 0 || clamp(num(turf.greenStrength, 0.35), 0, 3.5) > 0.05;
  if (group === "lighting") return Object.keys(lighting).length > 0
    || Math.abs(clamp(num(lighting.brightnessTarget, 52), 0, 100) - 52) > 2
    || Math.abs(clamp(num(lighting.contrastTarget, 1), 0.55, 2.2) - 1) > 0.03
    || clamp(num(lighting.shadowLiftStrength, 0), 0, 1) > 0.02;
  if (group === "floodlight") return !!(settings.floodlight && settings.floodlight.enabled === true);
  if (group === "terrain") return clamp(num(tools.holeTerrainStrength, 0.9), 0, 1.6) > 0.02;
  if (group === "mowing") {
    const mowing = String(settings.mowingVisibility || "Unknown");
    return mowing === "Low" || mowing === "Clear" || mowing === "Prominent";
  }
  return false;
}
function visualEffectTogglesForSettings(settings) {
  settings = settings || {};
  const toggles = settings.effectToggles && typeof settings.effectToggles === "object" ? settings.effectToggles : {};
  return {
    turf: Object.prototype.hasOwnProperty.call(toggles, "turf") ? toggles.turf === true : legacyEffectToggleState("turf", settings),
    lighting: Object.prototype.hasOwnProperty.call(toggles, "lighting") ? toggles.lighting === true : legacyEffectToggleState("lighting", settings),
    floodlight: Object.prototype.hasOwnProperty.call(toggles, "floodlight") ? toggles.floodlight === true : legacyEffectToggleState("floodlight", settings),
    terrain: Object.prototype.hasOwnProperty.call(toggles, "terrain") ? toggles.terrain === true : legacyEffectToggleState("terrain", settings),
    mowing: Object.prototype.hasOwnProperty.call(toggles, "mowing") ? toggles.mowing === true : legacyEffectToggleState("mowing", settings)
  };
}
function isSourceModeSettings(settings) {
  settings = settings || {};
  if (settings.sourceMode === true) return true;
  if (settings.processing && settings.processing.sourceMode === true) return true;
  const toggles = visualEffectTogglesForSettings(settings);
  return !toggles.turf && !toggles.lighting && !toggles.floodlight && !toggles.terrain && !toggles.mowing;
}

/* ---- source-aware tone + turf targeting -------------------------------------------------

   A recipe target ("brightnessTarget: 52") means "move the measured source mean to 52", not
   "multiply everything by a number derived from 52". recipeFilter below is the OLD model - a
   flat multiplier from settings alone, blind to the source - and it stays only for the one
   thing it still legitimately owns: turf.greenStrength's decorative colour-pop, which was
   never a measured target. Brightness/contrast/turf-hue-range ownership moves here.

   This mirrors measureSurfacePixels/toneCurveLut/normaliseSurfacePixels in
   scripts/gd-course-visual-engine.js almost formula-for-formula, but is NOT shared code with
   it: that runs on canvas ImageData in the browser, this runs on Sharp raw buffers in Node,
   same split this file already has for recipeFilter vs filterForSettings. Byte-identical
   output isn't the goal - the same measured source moving toward the same targets is. */
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0, s = 0; const l = (max + min) / 2;
  if (d > 1e-9) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}
function hueChannel(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
function hslToRgb(h, s, l) {
  h = (((Number(h) || 0) % 360) + 360) % 360 / 360; s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100;
  if (s <= 1e-9) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [Math.round(hueChannel(p, q, h + 1 / 3) * 255), Math.round(hueChannel(p, q, h) * 255), Math.round(hueChannel(p, q, h - 1 / 3) * 255)];
}
function histogramPercentile(hist, total, fraction) {
  if (!total) return 0;
  const target = total * clamp(fraction, 0, 1); let run = 0;
  for (let i = 0; i < hist.length; i++) { run += hist[i]; if (run >= target) return i; }
  return hist.length - 1;
}
function turfBand(settings) {
  const turf = settings && settings.turf || {};
  const lo = num(turf.hueMin, 86), hi = num(turf.hueMax, 142);
  /* Measure across a band wider than the target so off-target turf is still caught and pulled in. */
  const pad = Math.max(24, (hi - lo) * 0.8);
  return { min: Math.max(0, lo - pad), max: Math.min(360, hi + pad) };
}
/* Sampled histogram pass, not a full one - the correction pass below still touches every
   pixel, but measuring only needs a representative distribution, and this file's images run
   up to EXPORT_RENDITION_PX square. Stride grows with image size so a 3072x3072 export costs
   about the same measurement work as a 1024x1024 preview. */
function measureSurfaceBuffer(buffer, width, height, channels, band) {
  const step = Math.max(1, Math.round(Math.sqrt(Math.max(1, width * height)) / 800)) * channels;
  const lum = new Array(101).fill(0), turfHue = new Array(361).fill(0), turfSat = new Array(101).fill(0), turfLum = new Array(101).fill(0);
  let total = 0, turfTotal = 0, lumSum = 0, turfHueSum = 0;
  for (let i = 0; i + channels - 1 < buffer.length; i += step) {
    const hsl = rgbToHsl(buffer[i], buffer[i + 1], buffer[i + 2]);
    const li = Math.round(clamp(hsl.l, 0, 100));
    lum[li]++; total++; lumSum += hsl.l;
    if (hsl.h >= band.min && hsl.h <= band.max && hsl.s >= 8) {
      turfHue[Math.round(clamp(hsl.h, 0, 360))]++;
      turfSat[Math.round(clamp(hsl.s, 0, 100))]++;
      turfLum[li]++;
      turfTotal++; turfHueSum += hsl.h;
    }
  }
  const span = (hist, count) => ({ p50: histogramPercentile(hist, count, 0.5) });
  return {
    sampled: total,
    luma: { mean: total ? lumSum / total : 0, p1: histogramPercentile(lum, total, 0.01), p99: histogramPercentile(lum, total, 0.99) },
    turf: {
      coverage: total ? turfTotal / total : 0,
      sampled: turfTotal,
      hue: Object.assign({ mean: turfTotal ? turfHueSum / turfTotal : 0 }, span(turfHue, turfTotal)),
      saturation: span(turfSat, turfTotal),
      luma: span(turfLum, turfTotal)
    }
  };
}
/* Tone curve in LUMINANCE space (0-100), not per channel - per-channel clipping wrecks colour
   on saturated pixels. H/S pass through untouched; only L moves. */
function toneCurveLut(stats, settings) {
  const lighting = settings && settings.lighting || {};
  const shadowFloor = clamp(num(lighting.shadowFloor, 14), 0, 60);
  const highlightCeiling = clamp(num(lighting.highlightCeiling, 92), shadowFloor + 5, 100);
  const brightnessTarget = clamp(num(lighting.brightnessTarget, 52), shadowFloor, highlightCeiling);
  const contrast = clamp(num(lighting.contrastTarget, 1.04), 0.55, 2.2);
  const black = clamp(stats.luma.p1 || 0, 0, 100);
  const white = clamp(stats.luma.p99 || 100, black + 1, 100);
  const mean = clamp(stats.luma.mean || 50, black, white);
  const wanted = clamp((brightnessTarget - shadowFloor) / Math.max(1e-6, highlightCeiling - shadowFloor), 0.02, 0.98);
  const actual = clamp((mean - black) / Math.max(1e-6, white - black), 0.02, 0.98);
  let gamma = Math.log(wanted) / Math.log(actual);
  if (!Number.isFinite(gamma) || gamma <= 0) gamma = 1;
  gamma = clamp(gamma, 0.35, 3);
  const lut = new Array(101);
  /* A flat/near-flat source has no range to stretch - shift it onto the target instead. */
  if (white - black < 2) {
    const shift = brightnessTarget - mean;
    for (let i = 0; i <= 100; i++) lut[i] = clamp(i + shift, 0, 100);
    return { lut, blackPoint: black, whitePoint: white, measuredMean: mean, gamma: 1, shadowFloor, highlightCeiling, brightnessTarget, contrast };
  }
  for (let i = 0; i <= 100; i++) {
    const x = clamp((i - black) / Math.max(1e-6, white - black), 0, 1);
    let y = Math.pow(x, gamma);
    y = 0.5 + (y - 0.5) * contrast;
    lut[i] = clamp(shadowFloor + clamp(y, 0, 1) * (highlightCeiling - shadowFloor), 0, 100);
  }
  return { lut, blackPoint: black, whitePoint: white, measuredMean: mean, gamma, shadowFloor, highlightCeiling, brightnessTarget, contrast };
}
/* Range guardrail, not a stretch - turf already inside [lo,hi] is left exactly as it is;
   pull=1 sits out-of-range values on the boundary, pull<1 keeps some of the excursion. */
function constrainToRange(value, lo, hi, pull) {
  if (lo > hi) { const s = lo; lo = hi; hi = s; }
  if (value >= lo && value <= hi) return value;
  const edge = value < lo ? lo : hi;
  return edge + (value - edge) * (1 - clamp(pull, 0, 1));
}
/* Measure once, then a single pass: tone-map L, and where the pixel is turf drag H/S/L onto the
   recipe's authored targets. Mutates `buffer` in place and returns the plan for diagnostics -
   compact summary stats only, never pixel arrays. */
/* Shadow lift, spatial - mirrors the engine's shadowSurroundFill exactly (see that
   comment): dark pixels blend toward a coarse colour field built from the non-shadow
   pixels around them, so a lifted shadow looks like the ground it sits in rather than
   bright black. Strength 0 is exact identity. */
function shadowSurroundFill(pixels, width, height, channels, settings) {
  const lighting = settings && settings.lighting || {};
  const strength = clamp(num(lighting.shadowLiftStrength, 0), 0, 1);
  const threshold = clamp(num(lighting.shadowLiftThreshold, 30), 0, 60);
  if (strength <= 0) return { applied: false, reason: "strength-zero" };
  if (!width || !height) return { applied: false, reason: "no-dimensions" };
  const luma = (base) => {
    const r = pixels[base], g = pixels[base + 1], b = pixels[base + 2];
    return (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255 * 100;
  };
  const cell = Math.max(8, Math.round(Math.min(width, height) / 48));
  const gw = Math.max(1, Math.ceil(width / cell)), gh = Math.max(1, Math.ceil(height / cell));
  const sums = new Float64Array(gw * gh * 3), counts = new Float64Array(gw * gh);
  const globalSum = [0, 0, 0];
  let globalCount = 0, darkCount = 0, total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = (y * width + x) * channels;
      if (channels === 4 && pixels[base + 3] < 8) continue;
      total++;
      if (luma(base) < threshold) { darkCount++; continue; }
      const gi = Math.floor(y / cell) * gw + Math.floor(x / cell);
      sums[gi * 3] += pixels[base]; sums[gi * 3 + 1] += pixels[base + 1]; sums[gi * 3 + 2] += pixels[base + 2];
      counts[gi]++;
      globalSum[0] += pixels[base]; globalSum[1] += pixels[base + 1]; globalSum[2] += pixels[base + 2];
      globalCount++;
    }
  }
  if (!globalCount) return { applied: false, reason: "everything-dark" };
  let field = new Float64Array(gw * gh * 3), filled = new Uint8Array(gw * gh);
  for (let gi = 0; gi < gw * gh; gi++) {
    if (counts[gi]) {
      field[gi * 3] = sums[gi * 3] / counts[gi]; field[gi * 3 + 1] = sums[gi * 3 + 1] / counts[gi]; field[gi * 3 + 2] = sums[gi * 3 + 2] / counts[gi];
      filled[gi] = 1;
    }
  }
  let passes = gw + gh, changed = true;
  while (changed && passes-- > 0) {
    changed = false;
    const nextField = Float64Array.from(field), nextFilled = Uint8Array.from(filled);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const gi = gy * gw + gx;
      if (filled[gi]) continue;
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = gx + dx, ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const ni = ny * gw + nx;
        if (!filled[ni]) continue;
        sr += field[ni * 3]; sg += field[ni * 3 + 1]; sb += field[ni * 3 + 2]; n++;
      }
      if (n) { nextField[gi * 3] = sr / n; nextField[gi * 3 + 1] = sg / n; nextField[gi * 3 + 2] = sb / n; nextFilled[gi] = 1; changed = true; }
    }
    field = nextField; filled = nextFilled;
  }
  for (let gi = 0; gi < gw * gh; gi++) if (!filled[gi]) { field[gi * 3] = globalSum[0] / globalCount; field[gi * 3 + 1] = globalSum[1] / globalCount; field[gi * 3 + 2] = globalSum[2] / globalCount; }
  const smooth = new Float64Array(gw * gh * 3);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const ni = ny * gw + nx;
      sr += field[ni * 3]; sg += field[ni * 3 + 1]; sb += field[ni * 3 + 2]; n++;
    }
    const si = gy * gw + gx;
    smooth[si * 3] = sr / n; smooth[si * 3 + 1] = sg / n; smooth[si * 3 + 2] = sb / n;
  }
  const sample = (px, py, ch) => {
    const fx = clamp(px / cell - 0.5, 0, gw - 1), fy = clamp(py / cell - 0.5, 0, gh - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const a = smooth[(y0 * gw + x0) * 3 + ch], b = smooth[(y0 * gw + x1) * 3 + ch];
    const c = smooth[(y1 * gw + x0) * 3 + ch], d = smooth[(y1 * gw + x1) * 3 + ch];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = (y * width + x) * channels;
      if (channels === 4 && pixels[base + 3] < 8) continue;
      const l = luma(base);
      if (l >= threshold) continue;
      const t = strength * clamp((threshold - l) / Math.max(1e-6, threshold), 0, 1);
      pixels[base] = Math.round(pixels[base] + (sample(x, y, 0) - pixels[base]) * t);
      pixels[base + 1] = Math.round(pixels[base + 1] + (sample(x, y, 1) - pixels[base + 1]) * t);
      pixels[base + 2] = Math.round(pixels[base + 2] + (sample(x, y, 2) - pixels[base + 2]) * t);
    }
  }
  return { applied: true, model: "surround-fill", threshold, strength: +strength.toFixed(3), cell, darkCoverage: total ? +(darkCount / total).toFixed(3) : 0 };
}
function normaliseSurfaceBuffer(buffer, width, height, channels, settings) {
  const toggles = visualEffectTogglesForSettings(settings);
  const band = turfBand(settings);
  const before = measureSurfaceBuffer(buffer, width, height, channels, band);
  if (isSourceModeSettings(settings)) {
    return {
      shadowFill: { applied: false, reason: "source-mode" },
      tone: { applied: false, reason: "source-mode" },
      turf: { applied: false, reason: "source-mode" },
      before: { luma: before.luma, turf: { coverage: before.turf.coverage, hue: before.turf.hue, saturation: before.turf.saturation, luma: before.turf.luma } },
      after: { luma: before.luma, turf: { coverage: before.turf.coverage, hue: before.turf.hue, saturation: before.turf.saturation, luma: before.turf.luma } },
      model: "source-identity",
      sourceMode: true,
      effectToggles: toggles
    };
  }
  const tone = toneCurveLut(before, settings);
  const lut = tone.lut;
  const toneMap = l => toggles.lighting ? lut[Math.round(clamp(l, 0, 100))] : clamp(l, 0, 100);
  const turfCfg = settings && settings.turf || {};
  const hueMin = num(turfCfg.hueMin, 86), hueMax = num(turfCfg.hueMax, 142);
  const satMin = num(turfCfg.saturationMin, 28), satMax = num(turfCfg.saturationMax, 66);
  const lumMin = num(turfCfg.brightnessMin, 30), lumMax = num(turfCfg.brightnessMax, 72);
  const pull = clamp(num(turfCfg.targetPull, 1), 0, 1);
  const hasTurf = !!(before.turf && before.turf.sampled) && toggles.turf;
  for (let i = 0; i + channels - 1 < buffer.length; i += channels) {
    const hsl = rgbToHsl(buffer[i], buffer[i + 1], buffer[i + 2]);
    let h = hsl.h, s = hsl.s, l = toneMap(hsl.l);
    if (hasTurf && hsl.h >= band.min && hsl.h <= band.max && hsl.s >= 8) {
      h = constrainToRange(h, hueMin, hueMax, pull);
      s = constrainToRange(s, satMin, satMax, pull);
      l = constrainToRange(l, lumMin, lumMax, pull);
    }
    const rgb = hslToRgb(h, clamp(s, 0, 100), clamp(l, 0, 100));
    buffer[i] = rgb[0]; buffer[i + 1] = rgb[1]; buffer[i + 2] = rgb[2];
  }
  const shadowFill = toggles.lighting
    ? shadowSurroundFill(buffer, width, height, channels, settings)
    : { applied: false, reason: "lighting-disabled" };
  const after = measureSurfaceBuffer(buffer, width, height, channels, band);
  return {
    shadowFill,
    tone: toggles.lighting
      ? { applied: true, blackPoint: +tone.blackPoint.toFixed(2), whitePoint: +tone.whitePoint.toFixed(2), measuredMean: +tone.measuredMean.toFixed(2), gamma: +tone.gamma.toFixed(3), shadowFloor: tone.shadowFloor, highlightCeiling: tone.highlightCeiling, brightnessTarget: tone.brightnessTarget, contrast: tone.contrast }
      : { applied: false, reason: "lighting-disabled", measuredMean: +tone.measuredMean.toFixed(2) },
    turf: hasTurf ? { applied: true, hue: [hueMin, hueMax], saturation: [satMin, satMax], luma: [lumMin, lumMax], pull: +pull.toFixed(3), coverage: +before.turf.coverage.toFixed(3) } : { applied: false, reason: toggles.turf ? "no-turf-pixels" : "turf-disabled" },
    before: { luma: before.luma, turf: { coverage: before.turf.coverage, hue: before.turf.hue, saturation: before.turf.saturation, luma: before.turf.luma } },
    after: { luma: after.luma, turf: { coverage: after.turf.coverage, hue: after.turf.hue, saturation: after.turf.saturation, luma: after.turf.luma } },
    model: "measure-and-drag-to-target",
    sourceMode: false,
    effectToggles: toggles
  };
}

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
  const toggles = visualEffectTogglesForSettings(settings);
  if (isSourceModeSettings(settings)) return { saturation: 1, brightness: 1, contrast: 1 };
  const turf = settings && settings.turf || {};
  const lighting = settings && settings.lighting || {};
  const green = clamp(num(turf.greenStrength, 0.35), 0, 3.5);
  const brightnessTarget = clamp(num(lighting.brightnessTarget, 52), 5, 115);
  const contrast = clamp(num(lighting.contrastTarget, 1), 0.55, 2.2);
  return {
    saturation: toggles.turf ? 1 + green * 0.55 : 1,
    brightness: toggles.lighting ? clamp(1 + (brightnessTarget - 52) / 90, 0.45, 1.75) : 1,
    contrast: toggles.lighting ? contrast : 1
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
  if (isSourceModeSettings(settings)) return { strength: 0, opacity: 0 };
  const toggles = visualEffectTogglesForSettings(settings);
  const tools = settings && settings.visualTools || {};
  const strength = toggles.terrain ? clamp(num(tools.holeTerrainStrength, 0.9), 0, 1.6) : 0;
  return { strength, opacity: clamp(strength * 0.6, 0, 0.96) };
}
/* Green contours. Follows terrainParams: off in source mode, off with the terrain toggle (it is
   the same elevation being drawn, so a user who turned terrain off does not want it back here),
   and one number worth exposing.

   arrowMinSlopePercent is THE knob. Everything else about this layer is a locked drawing
   decision, but "how steep does ground have to be before an arrow is honest" is a judgement
   about the course and the player, not about the rendering. */
function greenContourParams(settings) {
  if (isSourceModeSettings(settings)) return { enabled: false };
  const toggles = visualEffectTogglesForSettings(settings);
  if (!toggles.terrain) return { enabled: false };
  const tools = settings && settings.visualTools || {};
  if (tools.greenContours === false) return { enabled: false };
  return {
    enabled: true,
    arrowMinSlopePercent: clamp(num(tools.greenContourArrowMinSlope, greenCore.CONTOUR_DEFAULTS.arrowMinSlopePercent), 0, 12),
    opacity: clamp(num(tools.greenContourOpacity, 1), 0, 1)
  };
}

/* Render the shared display list as SVG paths.
   The metres->pixels step goes through the caller's projector - the SAME mercProject that
   placed the imagery - so the lines land on the turf they were measured from rather than on a
   second projection rule that could drift from it. */
function greenContourSvg(surface, W, H, project, options) {
  const drawing = greenCore.buildGreenDrawing(surface, options);
  if (!drawing) return null;
  const frame = surface.frame;
  const toPx = (m) => project(frame.toLatLng(m.x, m.y));
  const f1 = (n) => Number(n).toFixed(1);
  const parts = [];

  for (const run of drawing.runs) {
    const px = run.points.map(toPx).filter(Boolean);
    if (px.length < 2) continue;
    const d = "M" + px.map(p => f1(p.x) + " " + f1(p.y)).join("L");
    if (run.haloWidthPx > 0) {
      parts.push('<path d="' + d + '" stroke="' + run.haloColour + '" stroke-opacity="' +
        run.haloAlpha.toFixed(3) + '" stroke-width="' + run.haloWidthPx.toFixed(2) + '"/>');
    }
    parts.push('<path d="' + d + '" stroke="' + run.colour + '" stroke-opacity="' +
      run.alpha.toFixed(3) + '" stroke-width="' + run.widthPx.toFixed(2) + '"/>');
  }

  for (const arrow of drawing.arrows) {
    const tail = toPx(arrow.tail), head = toPx(arrow.head);
    if (!tail || !head) continue;
    const wings = greenCore.arrowWings(tail, head);
    const d = "M" + f1(tail.x) + " " + f1(tail.y) + "L" + f1(head.x) + " " + f1(head.y) +
              "M" + f1(wings[0].x) + " " + f1(wings[0].y) + "L" + f1(head.x) + " " + f1(head.y) +
              "L" + f1(wings[1].x) + " " + f1(wings[1].y);
    parts.push('<path d="' + d + '" stroke="' + arrow.haloColour + '" stroke-opacity="' +
      arrow.haloAlpha.toFixed(3) + '" stroke-width="' + arrow.haloWidthPx.toFixed(2) + '"/>');
    parts.push('<path d="' + d + '" stroke="' + arrow.colour + '" stroke-opacity="' +
      arrow.alpha.toFixed(3) + '" stroke-width="' + arrow.widthPx.toFixed(2) + '"/>');
  }

  if (!parts.length) return null;
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H +
    '" viewBox="0 0 ' + W + ' ' + H + '"><g fill="none" stroke-linecap="round" ' +
    'stroke-linejoin="round">' + parts.join("") + '</g></svg>');
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

/* Flatten imagery, measure + normalise it toward the recipe's targets, lay relief on the
   normalised ground, then draw the overlays on top. One helper so the renderers cannot drift
   apart on ordering - measure the real aerial pixels BEFORE anything artificial (relief, mow
   lines, floodlight) touches them, exactly like the browser engine's pipeline.

   The raw-buffer roundtrip used to be conditional on `relief` being present; now it always
   happens, because normalisation needs the real flattened pixels regardless. Relief - when
   present - runs on the SAME buffer normalisation just wrote, no extra full-res allocation. */
async function flattenWithRelief({ width, height, background, composites, relief, settings, overlays, quality }) {
  const surface = sharp({ create: { width, height, channels: 3, background }, limitInputPixels: false })
    .composite(composites);
  const flat = await surface.raw().toBuffer({ resolveWithObject: true });
  if (isSourceModeSettings(settings)) {
    const jpeg = await sharp(flat.data, { raw: { width: flat.info.width, height: flat.info.height, channels: flat.info.channels }, limitInputPixels: false })
      .jpeg({ quality }).toBuffer();
    return {
      jpeg,
      diagnostics: {
        shadowFill: { applied: false, reason: "source-mode" },
        tone: { applied: false, reason: "source-mode" },
        turf: { applied: false, reason: "source-mode" },
        model: "source-identity",
        sourceMode: true,
        effectToggles: visualEffectTogglesForSettings(settings)
      }
    };
  }
  const diagnostics = normaliseSurfaceBuffer(flat.data, flat.info.width, flat.info.height, flat.info.channels, settings);
  if (relief) applyRelief(flat.data, relief.data, relief.opacity, flat.info.channels);
  let out = sharp(flat.data, { raw: { width: flat.info.width, height: flat.info.height, channels: flat.info.channels }, limitInputPixels: false });
  /* greenStrength is a decorative colour-pop, not a measured target - it stays a flat
     modulate, applied after normalisation/relief so it never fights the tone curve. */
  const fRecipe = recipeFilter(settings);
  out = out.modulate({ saturation: fRecipe.saturation });
  if (overlays && overlays.length) out = out.composite(overlays);
  const jpeg = await out.jpeg({ quality }).toBuffer();
  return { jpeg, diagnostics };
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
  if (isSourceModeSettings(settings)) return { enabled: false, ambientLevel: 24, litLevel: 64, throwOff: 0.35, spread: 0.45, greenPool: 0.8, greenPoolRadius: 0.22 };
  const toggles = visualEffectTogglesForSettings(settings);
  const f = settings && settings.floodlight || {};
  return {
    enabled: toggles.floodlight && f.enabled === true,
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
export async function renderHoleSurfaceMercator({ pins, captures, terrain, greenSurface, settings, maxDim = 2048, quality = 82 }) {
  const rects = captures.map(item => ({ item, pb: projectedBounds(item.entry.bounds) })).filter(r => r.pb);
  if (!rects.length) throw new Error("no positioned captures for mercator surface");
  const merged = {
    left: Math.min(...rects.map(r => r.pb.left)),
    top: Math.min(...rects.map(r => r.pb.top)),
    right: Math.max(...rects.map(r => r.pb.right)),
    bottom: Math.max(...rects.map(r => r.pb.bottom))
  };
  const spanPx19 = Math.max((merged.right - merged.left), (merged.bottom - merged.top)) * 256 * Math.pow(2, 19);
  const f = maxDim / Math.max(1, spanPx19);
  /* captureZoom MUST be an integer. The GPS play renderer anchors the frame image to the map
     at this zoom while it projects the tee/green/ball markers independently; the locally
     captured surfaces it was built for are always whole-number zooms (z19/z20), and a
     fractional zoom (e.g. 18.58) desynchronises the image from the markers - the exact "tee is
     in the bushes" drift seen on cloud frames while local scans line up. Floor keeps the frame
     at or under maxDim at the cost of up to one half-step of resolution; correctness over
     sharpness.

     "Never upscales past the source" used to be enforced by clamping f at 1, which also made
     z19 an unreachable ceiling and left short holes rendering at a third of the budget they
     were allowed (see frameZoomFor). The honest bound is the sharpest capture actually in
     hand: render at the resolution of the real pixels, never above it. Deriving it from the
     captures rather than recomputing the planner's guess also means the two cannot drift. */
  const shotZoom = Math.max(1, ...rects.map(r => num(r.item.entry.captureZoom, 19)));
  const captureZoom = Math.max(1, Math.min(shotZoom, Math.floor(19 + Math.log2(f))));
  const scalePx = 256 * Math.pow(2, captureZoom);
  const originPx = { x: merged.left * scalePx, y: merged.top * scalePx };
  const W = Math.max(64, Math.round((merged.right - merged.left) * scalePx));
  const H = Math.max(64, Math.round((merged.bottom - merged.top) * scalePx));
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
    /* No colour/tone transform here anymore - tiles composite in raw, and the WHOLE flattened
       surface gets measured and moved toward the recipe's targets in flattenWithRelief, once,
       instead of every tile getting the same blind multiplier regardless of its own exposure. */
    /* extract chains onto the resize rather than round-tripping through a full-size raw
       buffer: sharp applies an extract declared after a resize to the resized image, so this
       is the same crop for one allocation instead of two. It also drops a hardcoded
       channels:3 that would have mangled any capture arriving with an alpha channel. */
    let layer = sharp(item.buffer, { limitInputPixels: false }).resize({ width: w, height: h, fit: "fill" });
    if (cropLeft || cropTop || visW < w || visH < h) layer = layer.extract({ left: cropLeft, top: cropTop, width: visW, height: visH });
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
        /* Same chained-extract as the imagery loop above, and the layer is handed to composite
           as raw rather than as PNG. Cropping through PNG cost a full encode AND decode of a
           frame-sized layer, and the placement cost a second encode - three passes over the
           biggest buffer in the function purely to move bytes between two sharp pipelines.
           ensureAlpha stays, so the blend is byte-identical to before. */
        let terrainLayer = sharp(terrain.buffer, { limitInputPixels: false }).resize({ width: w, height: h, fit: "fill" }).ensureAlpha();
        if (cropLeft || cropTop || visW < w || visH < h) {
          terrainLayer = terrainLayer.extract({ left: cropLeft, top: cropTop, width: visW, height: visH });
        }
        const terrainRaw = await terrainLayer.raw().toBuffer({ resolveWithObject: true });
        const placed = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 128, g: 128, b: 128 } }, limitInputPixels: false })
          .composite([{
            input: terrainRaw.data,
            raw: { width: terrainRaw.info.width, height: terrainRaw.info.height, channels: terrainRaw.info.channels },
            left: Math.max(0, left), top: Math.max(0, top)
          }])
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
  /* Green contours, drawn through the SAME mercProject that placed the imagery, so the lines
     land on the turf they were measured from rather than on a second projection that could
     drift from it. Sits in `overlays` and therefore after relief and tone normalisation - the
     drawing must not be measured as if it were aerial pixels, or the tone curve would chase
     ink it put there itself. The confidence gate already ran in the worker; a green that failed
     it arrives as null and nothing is drawn. */
  const contourCfg = greenContourParams(settings);
  if (greenSurface && contourCfg.enabled) {
    const svg = greenContourSvg(greenSurface, W, H, mercProject, {
      arrowMinSlopePercent: contourCfg.arrowMinSlopePercent,
      opacity: contourCfg.opacity
    });
    if (svg) overlays.push({ input: svg, blend: "over" });
  }
  /* The "void" behind any capture that doesn't reach the hole window. Same dark near-black-green
     ratio as before, now scaled off the recipe's shadow floor target instead of a blind
     brightness multiplier - unchanged at the old default (shadowFloor 14 -> scale 1). */
  const lighting = settings && settings.lighting || {};
  const voidScale = clamp(num(lighting.shadowFloor, 14), 0, 60) / 14;
  const background = { r: Math.round(clamp(16 * voidScale, 0, 255)), g: Math.round(clamp(19 * voidScale, 0, 255)), b: Math.round(clamp(15 * voidScale, 0, 255)) };
  const frame = await flattenWithRelief({
    width: W, height: H,
    background,
    composites, relief: reliefMask, settings, overlays, quality
  });
  const nw = unworld(merged.left, merged.top);
  const se = unworld(merged.right, merged.bottom);
  return {
    jpeg: frame.jpeg,
    width: W,
    height: H,
    captureZoom,
    originPx,
    bounds: { north: nw.lat, west: nw.lng, south: se.lat, east: se.lng },
    diagnostics: frame.diagnostics
  };
}

export async function renderOverview({ backdrop, terrain, settings, width = 1440, quality = 80 }) {
  /* Everything happens AT the output size - downscaling first makes every subsequent op
     cheaper, and gives normalisation the same pixel count the published frame will actually
     have rather than measuring detail that gets thrown away anyway. */
  const f = recipeFilter(settings);
  const resized = await sharp(backdrop.buffer, { limitInputPixels: false })
    .resize({ width, withoutEnlargement: true })
    .raw().toBuffer({ resolveWithObject: true });
  const diagnostics = normaliseSurfaceBuffer(resized.data, resized.info.width, resized.info.height, resized.info.channels, settings);
  const bMeta = { width: resized.info.width, height: resized.info.height };
  /* greenStrength is decorative, not a measured target - flat modulate, after normalisation. */
  let base = sharp(resized.data, { raw: { width: resized.info.width, height: resized.info.height, channels: resized.info.channels }, limitInputPixels: false })
    .modulate({ saturation: f.saturation });
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
  return { jpeg, width: bMeta.width, height: bMeta.height, diagnostics };
}
