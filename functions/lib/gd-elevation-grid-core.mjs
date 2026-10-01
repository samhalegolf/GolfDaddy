/* A geographic elevation grid: decoded heights in metres plus the georeference that makes a
 * sample a place. Any DEM source ends up here - Mapbox Terrain-DEM today, whatever replaces
 * it later - so slope, plays-like and contour work downstream never learns where the heights
 * came from.
 *
 * Measurements, not pictures. gd-relief-core turns the same heights into shading; this keeps
 * them as numbers and answers questions about them:
 *   elevationAt(grid, lat, lng)  - bilinear between the four surrounding samples
 *   gradientAt(grid, lat, lng)   - slope (degrees and percent) and aspect (downhill bearing)
 *   elevationChange(grid, a, b)  - tee-to-green, shot uphill/downhill
 *
 * Samples are pixel CENTRES: sample (i, j) sits at pixel (i + 0.5, j + 0.5) of the grid's
 * georeference, which is the convention terrain tiles are encoded with. Lookups outside the
 * grid clamp to the edge rather than inventing ground. */

import { decodeElevation } from "./gd-relief-core.mjs";
import { pixelToLatLng, latLngToPixel } from "./gd-tile-mosaic-core.mjs";

const DEG = Math.PI / 180;

/* Raw RGB(A) pixels -> grid. The encoding is DECLARED by the source and must be the one that
   decodes: decodeElevation will happily find another encoding that lands in a plausible range,
   which is the right behaviour for relief shading and the wrong one for a measurement - a
   source that silently changed format must fail here, not produce heights from the wrong
   formula. */
export function elevationGridFromRaw(raw, { width, height, channels, encoding, georef, bounds, metresPerSample, source }) {
  let decoded;
  try { decoded = decodeElevation(raw, width, height, channels, encoding); }
  catch (error) { return { error: "terrain decoding failed: " + (error && error.message || error) }; }
  if (encoding && decoded.encoding !== encoding) {
    return { error: "terrain decoding failed: tiles decode as " + decoded.encoding + ", not the declared " + encoding };
  }
  return {
    heights: decoded.heights,
    width, height, georef, bounds,
    metresPerSample,
    minElevation: decoded.min,
    maxElevation: decoded.max,
    encoding: decoded.encoding,
    source: source || null
  };
}

function sample(grid, i, j) {
  const x = Math.max(0, Math.min(grid.width - 1, i));
  const y = Math.max(0, Math.min(grid.height - 1, j));
  return grid.heights[y * grid.width + x];
}

/* Height at a pixel position of the grid (fractional, pixel-edge origin). */
export function elevationAtPixel(grid, px, py) {
  const fx = Number(px) - 0.5, fy = Number(py) - 0.5;
  const i = Math.floor(fx), j = Math.floor(fy);
  const tx = fx - i, ty = fy - j;
  const top = sample(grid, i, j) * (1 - tx) + sample(grid, i + 1, j) * tx;
  const bottom = sample(grid, i, j + 1) * (1 - tx) + sample(grid, i + 1, j + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

export function elevationAt(grid, lat, lng) {
  if (!grid || !grid.heights) return null;
  const p = latLngToPixel(grid.georef, { lat, lng });
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return elevationAtPixel(grid, p.x, p.y);
}

/* Slope and aspect from a central difference one sample either side. Aspect is the compass
   bearing the ground falls TOWARDS (0 = north, 90 = east), which is the way a ball rolls. */
export function gradientAt(grid, lat, lng) {
  if (!grid || !grid.heights) return null;
  const p = latLngToPixel(grid.georef, { lat, lng });
  const m = Number(grid.metresPerSample) || 1;
  const dzdx = (elevationAtPixel(grid, p.x + 1, p.y) - elevationAtPixel(grid, p.x - 1, p.y)) / (2 * m);
  /* +y is south in pixel space; flip so dzdy is the rise going north. */
  const dzdy = (elevationAtPixel(grid, p.x, p.y - 1) - elevationAtPixel(grid, p.x, p.y + 1)) / (2 * m);
  const rise = Math.hypot(dzdx, dzdy);
  const aspect = rise > 0 ? (Math.atan2(-dzdx, -dzdy) / DEG + 360) % 360 : null;
  return { slopeDeg: Math.atan(rise) / DEG, slopePercent: rise * 100, aspectDeg: aspect };
}

/* b minus a: positive means b is uphill of a. */
export function elevationChange(grid, a, b) {
  const za = elevationAt(grid, a.lat, a.lng), zb = elevationAt(grid, b.lat, b.lng);
  return za == null || zb == null ? null : zb - za;
}

/* The grid's centre, as a lat/lng - convenient for a diagnostic "sample at centre". */
export function gridCentre(grid) {
  return pixelToLatLng(grid.georef, { x: grid.width / 2, y: grid.height / 2 });
}

/* Largest jump between neighbouring samples - a smoothness check for diagnostics. A real DEM
   at a few metres per sample moves centimetres to a few metres between neighbours; a seam or a
   misdecoded tile shows up as tens or hundreds. */
export function maxNeighbourStep(grid) {
  let max = 0;
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
    const v = grid.heights[y * grid.width + x];
    if (x + 1 < grid.width) max = Math.max(max, Math.abs(grid.heights[y * grid.width + x + 1] - v));
    if (y + 1 < grid.height) max = Math.max(max, Math.abs(grid.heights[(y + 1) * grid.width + x] - v));
  }
  return max;
}
