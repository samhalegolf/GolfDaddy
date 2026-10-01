/* RawTerrainData (any provider, any CRS) -> the Clarity heightfield.

   The Clarity grid is the convention the rest of the app already speaks: a rectangle of
   web-mercator pixels at an integer zoom (originPx + captureZoom + width/height), heights in
   metres. The bake crops hole elevation from it with the same arithmetic it crops imagery, the
   phone's mesh and green fit read it unchanged, and nothing downstream knows what CRS or
   format a provider used.

   Pure - no network, no sharp - so every rule here is testable on synthetic grids:
     planClarityGrid    where the grid sits and how fine it is
     reprojectToGrid    sample a raw grid (any supported CRS) onto it; nodata stays NaN
     measureCoverage    how much of the course / frame a layer actually has
     compositeLayers    best source wins per pixel; lower sources only fill gaps, and only when
                        their vertical datum is the same - never across an unknown offset
     fillGaps           nearest real ground into what is left, RECORDED in the mask so anything
                        that measures (green fit) can refuse invented ground */

import { TERRAIN_CONFIG } from "./gd-terrain-config.mjs";
import { fromLngLat, normaliseCrs } from "./gd-terrain-crs.mjs";
import { lngLatToWorldPx, mercMetresPerPixel, zoomForResolution } from "./gd-terrain-adapters.mjs";
import { datumsCompatible } from "./gd-terrain-resolver.mjs";

const TILE = 256;
const MERC_HALF = 20037508.342789244;
export const MASK_NONE = 0;
export const MASK_FILLED = 255;

function latAt(py, z) {
  const n = Math.PI * (1 - (2 * py) / (TILE * Math.pow(2, z)));
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}
function lngAt(px, z) {
  return (px / (TILE * Math.pow(2, z))) * 360 - 180;
}

/* The grid for a frame. Sample spacing is the best source's resolution over `oversample`
   (a smooth mesh wants a little more than the raw spacing), bounded by minSampleM, and the
   zoom steps coarser until the grid fits maxSidePx. */
export function planClarityGrid(frameBounds, sourceResolutionM, config = TERRAIN_CONFIG) {
  const lat = (frameBounds.north + frameBounds.south) / 2;
  const want = Math.max(config.minSampleM, (Number(sourceResolutionM) || 10) / config.oversample);
  let zoom = zoomForResolution(lat, want, { minZoom: config.minZoom, maxZoom: config.maxZoom });
  let rect;
  for (;;) {
    const nw = lngLatToWorldPx(frameBounds.north, frameBounds.west, zoom);
    const se = lngLatToWorldPx(frameBounds.south, frameBounds.east, zoom);
    rect = { left: Math.floor(nw.x), top: Math.floor(nw.y) };
    rect.width = Math.max(2, Math.ceil(se.x) - rect.left);
    rect.height = Math.max(2, Math.ceil(se.y) - rect.top);
    if ((rect.width <= config.maxSidePx && rect.height <= config.maxSidePx) || zoom <= config.minZoom) break;
    zoom -= 1;
  }
  const bounds = {
    north: latAt(rect.top, zoom), south: latAt(rect.top + rect.height, zoom),
    west: lngAt(rect.left, zoom), east: lngAt(rect.left + rect.width, zoom)
  };
  const metresPerPixel = mercMetresPerPixel(zoom) * Math.cos(lat * Math.PI / 180);
  return { projection: "EPSG:3857", zoom, originPx: { x: rect.left, y: rect.top }, width: rect.width, height: rect.height, bounds, metresPerPixel };
}

/* A grid may be coarser than its zoom's pixels: stepX/stepY world pixels per grid pixel (the
   live frame's DEM grid spans a window at the picture's zoom with fewer samples). Default 1. */
function steps(grid) {
  return { sx: Number(grid.stepX) || 1, sy: Number(grid.stepY) || 1 };
}

/* Grid pixel (i, j) centre -> lat/lng. */
export function gridPixelLatLng(grid, i, j) {
  const { sx, sy } = steps(grid);
  return { lat: latAt(grid.originPx.y + (j + 0.5) * sy, grid.zoom), lng: lngAt(grid.originPx.x + (i + 0.5) * sx, grid.zoom) };
}

function cubicWeights(t) {
  const t2 = t * t, t3 = t2 * t;
  return [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2];
}

/* Height at a fractional raw-pixel position (sample space: integer = pixel centre).
   Catmull-Rom where all 16 neighbours are real (smooth, exact at samples), bilinear over the
   real ones near a gap edge, NaN where less than half the bilinear weight is real ground. */
export function sampleRaw(raw, fx, fy) {
  const W = raw.width, H = raw.height, h = raw.heights;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  if (x0 < -1 || y0 < -1 || x0 > W - 1 || y0 > H - 1) return NaN;
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? NaN : h[y * W + x];
  const tx = fx - x0, ty = fy - y0;
  let all = x0 >= 1 && y0 >= 1 && x0 + 2 < W && y0 + 2 < H;
  if (all) {
    const wx = cubicWeights(tx), wy = cubicWeights(ty);
    let v = 0;
    outer: for (let m = 0; m < 4; m++) {
      for (let n = 0; n < 4; n++) {
        const s = at(x0 - 1 + n, y0 - 1 + m);
        if (!Number.isFinite(s)) { all = false; break outer; }
        v += wy[m] * wx[n] * s;
      }
    }
    if (all) return v;
  }
  const corners = [[x0, y0, (1 - tx) * (1 - ty)], [x0 + 1, y0, tx * (1 - ty)], [x0, y0 + 1, (1 - tx) * ty], [x0 + 1, y0 + 1, tx * ty]];
  let sum = 0, weight = 0;
  for (const [x, y, w] of corners) {
    const s = at(x, y);
    if (Number.isFinite(s) && w > 0) { sum += s * w; weight += w; }
  }
  return weight >= 0.5 ? sum / weight : NaN;
}

/* Sample a raw grid onto the Clarity grid. For EPSG:3857 raw data the mapping is exact
   arithmetic; for any other CRS the projected position is computed on a coarse lattice (every
   LATTICE pixels) and interpolated between - over a few tens of metres the projection is
   linear to well under a centimetre, and it avoids millions of datum transforms. */
const LATTICE = 16;
export function reprojectToGrid(raw, grid) {
  const out = new Float32Array(grid.width * grid.height).fill(NaN);
  const t = raw.transform;
  const crs = normaliseCrs(raw.crs);
  const toSample = (X, Y) => [(X - t.originX) / t.pixelSize - 0.5, (t.originY - Y) / t.pixelSize - 0.5];
  const { sx, sy } = steps(grid);
  if (crs === "EPSG:3857") {
    const mpp = mercMetresPerPixel(grid.zoom);
    for (let j = 0; j < grid.height; j++) {
      const Y = MERC_HALF - (grid.originPx.y + (j + 0.5) * sy) * mpp;
      for (let i = 0; i < grid.width; i++) {
        const X = (grid.originPx.x + (i + 0.5) * sx) * mpp - MERC_HALF;
        const [fx, fy] = toSample(X, Y);
        out[j * grid.width + i] = sampleRaw(raw, fx, fy);
      }
    }
    return out;
  }
  const lw = Math.ceil(grid.width / LATTICE) + 1, lh = Math.ceil(grid.height / LATTICE) + 1;
  const lx = new Float64Array(lw * lh), ly = new Float64Array(lw * lh);
  for (let b = 0; b < lh; b++) for (let a = 0; a < lw; a++) {
    const ll = { lat: latAt(grid.originPx.y + Math.min(grid.height, b * LATTICE) * sy, grid.zoom), lng: lngAt(grid.originPx.x + Math.min(grid.width, a * LATTICE) * sx, grid.zoom) };
    const p = fromLngLat(crs, ll.lat, ll.lng);
    lx[b * lw + a] = p[0]; ly[b * lw + a] = p[1];
  }
  for (let j = 0; j < grid.height; j++) {
    const gy = (j + 0.5) / LATTICE, b = Math.min(lh - 2, Math.floor(gy)), v = gy - b;
    for (let i = 0; i < grid.width; i++) {
      const gx = (i + 0.5) / LATTICE, a = Math.min(lw - 2, Math.floor(gx)), u = gx - a;
      const k00 = b * lw + a, k10 = k00 + 1, k01 = k00 + lw, k11 = k01 + 1;
      const X = (lx[k00] * (1 - u) + lx[k10] * u) * (1 - v) + (lx[k01] * (1 - u) + lx[k11] * u) * v;
      const Y = (ly[k00] * (1 - u) + ly[k10] * u) * (1 - v) + (ly[k01] * (1 - u) + ly[k11] * u) * v;
      const [fx, fy] = toSample(X, Y);
      out[j * grid.width + i] = sampleRaw(raw, fx, fy);
    }
  }
  return out;
}

/* Pixel rectangle of WGS84 bounds on the grid, clamped. */
export function gridRectFor(grid, bounds) {
  const nw = lngLatToWorldPx(bounds.north, bounds.west, grid.zoom);
  const se = lngLatToWorldPx(bounds.south, bounds.east, grid.zoom);
  const x0 = Math.max(0, Math.floor(nw.x - grid.originPx.x)), y0 = Math.max(0, Math.floor(nw.y - grid.originPx.y));
  const x1 = Math.min(grid.width, Math.ceil(se.x - grid.originPx.x)), y1 = Math.min(grid.height, Math.ceil(se.y - grid.originPx.y));
  return { x0, y0, x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}

/* Fraction of real (finite) samples over the course itself and over the whole frame. */
export function measureCoverage(heights, grid, courseBounds) {
  let frameValid = 0;
  for (let i = 0; i < heights.length; i++) if (Number.isFinite(heights[i])) frameValid++;
  const r = gridRectFor(grid, courseBounds);
  let coreValid = 0, coreTotal = 0;
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) {
    coreTotal++;
    if (Number.isFinite(heights[y * grid.width + x])) coreValid++;
  }
  return { core: coreTotal ? coreValid / coreTotal : 0, frame: heights.length ? frameValid / heights.length : 0 };
}

/* Layers in preference order: [{ id, heights, verticalDatum }]. The first is the anchor. A later
   layer fills only pixels still empty, and only when its datum matches the anchor's - two DEMs
   on different vertical references differ by an unknown constant, and splicing them draws a
   step along the seam that reads as a real bank or ridge. Skipped layers are reported.

   -> { heights, mask (Uint8: layer index + 1, 0 = none), used: [{ id, pixels }], skipped } */
export function compositeLayers(layers, grid) {
  const n = grid.width * grid.height;
  const heights = new Float32Array(n).fill(NaN);
  const mask = new Uint8Array(n);
  const used = [], skipped = [];
  const anchor = layers[0];
  layers.forEach((layer, index) => {
    if (index > 0 && !datumsCompatible(anchor, layer)) {
      skipped.push({ id: layer.id, reason: "vertical datum " + (layer.verticalDatum || "unknown") + " cannot be blended with " + (anchor.verticalDatum || "unknown") });
      return;
    }
    let pixels = 0;
    for (let i = 0; i < n; i++) {
      if (mask[i] !== MASK_NONE) continue;
      const v = layer.heights[i];
      if (Number.isFinite(v)) { heights[i] = v; mask[i] = Math.min(254, index + 1); pixels++; }
    }
    used.push({ id: layer.id, pixels, fraction: pixels / n });
  });
  return { heights, mask, used, skipped };
}

/* Nearest real ground into every empty pixel - a multi-source flood from the edge of the real
   data, so a filled pixel takes the value of the closest measured ground rather than a global
   minimum or zero. A REPAIR for drawing, never a measurement: every filled pixel is marked
   MASK_FILLED. Returns the filled fraction; throws when there is no real ground at all. */
export function fillGaps(heights, mask, width, height) {
  const n = width * height;
  const queue = new Int32Array(n);
  let head = 0, tail = 0, holes = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(heights[i])) { holes++; continue; }
    const x = i % width, y = (i / width) | 0;
    if ((x > 0 && !Number.isFinite(heights[i - 1])) || (x < width - 1 && !Number.isFinite(heights[i + 1]))
      || (y > 0 && !Number.isFinite(heights[i - width])) || (y < height - 1 && !Number.isFinite(heights[i + width]))) queue[tail++] = i;
  }
  if (!holes) return { filledFraction: 0 };
  if (holes === n) throw new Error("no real ground to fill from");
  let filled = 0;
  while (head < tail) {
    const i = queue[head++];
    const v = heights[i];
    const x = i % width, y = (i / width) | 0;
    const visit = k => { if (!Number.isFinite(heights[k])) { heights[k] = v; mask[k] = MASK_FILLED; filled++; queue[tail++] = k; } };
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (y > 0) visit(i - width);
    if (y < height - 1) visit(i + width);
  }
  return { filledFraction: filled / n };
}

/* Filled rectangles in grid pixels, coarse (cell x cell), for consumers that check a green's
   box against "invented ground" - the shape the export's green-fit guard already reads. */
export function filledRegions(mask, width, height, cell = 32, limit = 400) {
  const out = [];
  for (let y0 = 0; y0 < height; y0 += cell) for (let x0 = 0; x0 < width; x0 += cell) {
    let hit = false;
    for (let y = y0; y < Math.min(height, y0 + cell) && !hit; y++) {
      for (let x = x0; x < Math.min(width, x0 + cell); x++) if (mask[y * width + x] === MASK_FILLED) { hit = true; break; }
    }
    if (hit) out.push({ x: x0, y: y0, w: Math.min(cell, width - x0), h: Math.min(cell, height - y0), reason: "no source data (filled from nearest ground)" });
    /* A frame that is mostly filled is reported by coverage.filledFraction; past the limit the
       list would only bloat the manifest, so one rectangle stands for the whole grid. */
    if (out.length > limit) return [{ x: 0, y: 0, w: width, h: height, reason: "extensive gaps (filled from nearest ground)" }];
  }
  return out;
}

export function heightRange(heights) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < heights.length; i++) { const v = heights[i]; if (v < min) min = v; if (v > max) max = v; }
  return { min, max };
}
