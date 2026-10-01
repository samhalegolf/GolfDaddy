/* Web-mercator tile maths and stitching for "give me one picture of these bounds".
 *
 * Provider-agnostic on purpose. A provider (gd-mapbox-source.mjs today, GSI or VWorld later)
 * supplies only "how do I fetch tile z/x/y"; everything about WHICH tiles, how they join, and
 * how the result maps back to the ground lives here, once. The rest of Clarity receives one
 * raster plus a georeference and never learns how many tiles made it.
 *
 * Pixel space. Everything is done in the same 256px-tile world pixels gd-visual-plan-core's
 * projectPoint uses. A tile set served at tilePx = 256 * ratio (512px "@2x" tiles) at zoom z
 * is exactly the 256px world at "pixel zoom" z + log2(ratio) - so @2x needs no special case,
 * and the georeference this hands out is the same playSurface shape
 * (originPx / captureZoom / outputDimensions) gd-overlay-georef-core already speaks.
 *
 * Exactness. The crop is snapped OUTWARD to whole pixels, and the bounds returned are the
 * bounds of those pixel edges - not the bounds that were asked for. That is the only way the
 * pixel <-> lat/lng transform can be exact: a picture whose stated bounds are half a pixel
 * off its real edges drifts by that half pixel everywhere. The difference from the request is
 * at most one source pixel per edge and is reported, never hidden.
 *
 * Pure apart from the injected fetchTile and sharp, so the maths is testable without a network.
 */

import { projectPoint, unprojectPoint } from "./gd-visual-plan-core.mjs";

const EARTH_CIRCUMFERENCE_M = 40075016.686;
export const MAX_LAT = 85.05112878;

function finite(v) { return Number.isFinite(Number(v)); }

export function validBounds(b) {
  return !!(b && [b.south, b.west, b.north, b.east].every(finite)
    && Number(b.north) > Number(b.south) && Number(b.east) > Number(b.west)
    && Math.abs(Number(b.north)) <= MAX_LAT && Math.abs(Number(b.south)) <= MAX_LAT
    && Math.abs(Number(b.west)) <= 180 && Math.abs(Number(b.east)) <= 180);
}

/* ---------- tile <-> geography ---------- */

/* Fractional tile coordinates. Floor them for the tile index. */
export function lngToTileX(lng, zoom) { return (Number(lng) + 180) / 360 * Math.pow(2, zoom); }
export function latToTileY(lat, zoom) {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, Number(lat)));
  const rad = clamped * Math.PI / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, zoom);
}
export function tileXToLng(x, zoom) { return x / Math.pow(2, zoom) * 360 - 180; }
export function tileYToLat(y, zoom) {
  const n = Math.PI - 2 * Math.PI * y / Math.pow(2, zoom);
  return 180 / Math.PI * Math.atan(Math.sinh(n));
}

/* The ground one tile covers. */
export function tileBounds(x, y, zoom) {
  return { north: tileYToLat(y, zoom), south: tileYToLat(y + 1, zoom), west: tileXToLng(x, zoom), east: tileXToLng(x + 1, zoom) };
}

/* Every tile intersecting the bounds, row by row from the north-west. */
export function tilesForBounds(bounds, zoom) {
  if (!validBounds(bounds)) return [];
  const n = Math.pow(2, zoom);
  const x0 = Math.max(0, Math.floor(lngToTileX(bounds.west, zoom)));
  const x1 = Math.min(n - 1, Math.floor(lngToTileX(bounds.east, zoom) - 1e-9));
  const y0 = Math.max(0, Math.floor(latToTileY(bounds.north, zoom)));
  const y1 = Math.min(n - 1, Math.floor(latToTileY(bounds.south, zoom) - 1e-9));
  const tiles = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ z: zoom, x, y });
  return tiles;
}

/* Ground metres per pixel of a tilePx tile at a latitude. */
export function metresPerPixel(lat, zoom, tilePx = 256) {
  return EARTH_CIRCUMFERENCE_M * Math.cos(Number(lat) * Math.PI / 180) / (tilePx * Math.pow(2, zoom));
}

function pixelZoom(zoom, tilePx) { return zoom + Math.log2(tilePx / 256); }

/* ---------- the plan: which tiles, and where the crop sits inside them ---------- */

/* Everything about one stitched picture except the bytes. */
export function stitchPlan(bounds, zoom, tilePx = 256) {
  if (!validBounds(bounds)) return { error: "bounds are unusable" };
  const pz = pixelZoom(zoom, tilePx);
  const nw = projectPoint(bounds.north, bounds.west, pz);
  const se = projectPoint(bounds.south, bounds.east, pz);
  /* Outward to whole pixels - see the header on why the returned bounds are these edges. */
  const left = Math.floor(nw.x), top = Math.floor(nw.y);
  const right = Math.ceil(se.x), bottom = Math.ceil(se.y);
  const tx0 = Math.floor(left / tilePx), ty0 = Math.floor(top / tilePx);
  const tx1 = Math.floor((right - 1) / tilePx), ty1 = Math.floor((bottom - 1) / tilePx);
  const tiles = [];
  for (let y = ty0; y <= ty1; y++) for (let x = tx0; x <= tx1; x++) {
    tiles.push({ z: zoom, x, y, left: (x - tx0) * tilePx, top: (y - ty0) * tilePx });
  }
  const outNw = unprojectPoint(left, top, pz);
  const outSe = unprojectPoint(right, bottom, pz);
  return {
    zoom, tilePx, pixelZoom: pz, tiles,
    sheet: { width: (tx1 - tx0 + 1) * tilePx, height: (ty1 - ty0 + 1) * tilePx },
    crop: { left: left - tx0 * tilePx, top: top - ty0 * tilePx, width: right - left, height: bottom - top },
    originPx: { x: left, y: top },
    bounds: { north: outNw.lat, west: outNw.lng, south: outSe.lat, east: outSe.lng },
    requestedBounds: { north: Number(bounds.north), south: Number(bounds.south), west: Number(bounds.west), east: Number(bounds.east) }
  };
}

/* The coarsest zoom whose crop is at least targetPx on its long side - so the picture has the
   detail asked for without fetching more than it needs - capped at what the source resolves
   and at a tile budget. A region too big for the budget even at minZoom is refused rather
   than silently delivered blurry: "unsupported bounds" is an answer the caller can act on. */
export function selectZoom(bounds, options = {}) {
  if (!validBounds(bounds)) return { error: "bounds are unusable" };
  const tilePx = Number(options.tilePx) || 256;
  const targetPx = Math.max(64, Number(options.targetPx) || 1568);
  const minZoom = Math.max(0, Math.round(Number(options.minZoom) || 0));
  const maxZoom = Math.max(minZoom, Math.round(Number(options.maxZoom) || 19));
  const maxTiles = Math.max(1, Math.round(Number(options.maxTiles) || 64));
  let chosen = maxZoom;
  for (let z = minZoom; z <= maxZoom; z++) {
    const plan = stitchPlan(bounds, z, tilePx);
    if (Math.max(plan.crop.width, plan.crop.height) >= targetPx) { chosen = z; break; }
  }
  while (chosen >= minZoom) {
    const plan = stitchPlan(bounds, chosen, tilePx);
    if (plan.tiles.length <= maxTiles) return { zoom: chosen, plan };
    chosen -= 1;
  }
  return { error: "bounds need more than " + maxTiles + " tiles even at zoom " + minZoom };
}

/* ---------- pixel <-> ground for a finished picture ---------- */

/* The georeference for an output picture, in the playSurface shape gd-overlay-georef-core
   reads exactly. When the picture was resized after the crop, the scale folds into the zoom:
   half the pixels is one zoom level down, and the origin scales with it. */
export function georefFor(plan, width, height) {
  const scale = width / plan.crop.width;
  return {
    playSurface: {
      originPx: { x: plan.originPx.x * scale, y: plan.originPx.y * scale },
      captureZoom: plan.pixelZoom + Math.log2(scale),
      outputDimensions: { width, height }
    }
  };
}

export function pixelToLatLng(georef, px) {
  const s = georef.playSurface;
  return unprojectPoint(s.originPx.x + Number(px.x), s.originPx.y + Number(px.y), s.captureZoom);
}
export function latLngToPixel(georef, point) {
  const s = georef.playSurface;
  const p = projectPoint(Number(point.lat), Number(point.lng), s.captureZoom);
  return { x: p.x - s.originPx.x, y: p.y - s.originPx.y };
}

/* ---------- stitching ---------- */

/* Fetches every tile in the plan through the provider's fetchTile, joins them, crops to the
   exact pixel bounds, and optionally scales down so the long side fits maxOutputPx and the
   area fits maxPixels (the AI scan's two limits - see map-overlay-page.js AI_MAX_*).

   All-or-nothing. A stitched picture with a missing tile is a picture with a hole in it, and
   a georeferenced hole is a confident wrong answer - so any tile failure fails the whole
   picture, carrying every tile's error for the caller to classify. fetchTile resolves to a
   Buffer or throws.

   Tiles are placed at whole-tile offsets on one sheet and the crop is taken from the sheet, so
   there is no per-tile resampling and nothing that could open a seam. */
export async function stitch(plan, { fetchTile, sharp, concurrency = 8, format = "jpeg", quality = 88, maxOutputPx = 0, maxPixels = 0, channels = 3 }) {
  const results = new Array(plan.tiles.length);
  let cursor = 0;
  async function pump() {
    while (cursor < plan.tiles.length) {
      const i = cursor++;
      const t = plan.tiles[i];
      try { results[i] = { ok: true, tile: t, buffer: await fetchTile(t) }; }
      catch (error) { results[i] = { ok: false, tile: t, error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, plan.tiles.length) }, pump));
  const failed = results.filter(r => !r.ok);
  if (failed.length) return { failed, fetched: results.length - failed.length };

  /* Each tile must decode and be the size the plan assumed. A tile that is the wrong size
     would land at the right offset and still be wrong. */
  const layers = [];
  const malformed = [];
  for (const r of results) {
    let meta;
    try { meta = await sharp(r.buffer).metadata(); } catch (error) { meta = null; }
    if (!meta || meta.width !== plan.tilePx || meta.height !== plan.tilePx) {
      malformed.push({ ok: false, tile: r.tile, error: Object.assign(new Error(meta ? "tile is " + meta.width + "x" + meta.height + ", expected " + plan.tilePx : "tile does not decode as an image"), { code: "malformed" }) });
      continue;
    }
    layers.push({ input: r.buffer, left: r.tile.left, top: r.tile.top });
  }
  if (malformed.length) return { failed: malformed, fetched: results.length - malformed.length };

  const sheet = await sharp({
    create: { width: plan.sheet.width, height: plan.sheet.height, channels, background: { r: 0, g: 0, b: 0 } },
    limitInputPixels: false
  }).composite(layers).png().toBuffer();

  let pipeline = sharp(sheet, { limitInputPixels: false }).extract(plan.crop);
  let width = plan.crop.width, height = plan.crop.height;
  const f = Math.min(1,
    maxOutputPx ? maxOutputPx / Math.max(width, height) : 1,
    maxPixels ? Math.sqrt(maxPixels / (width * height)) : 1);
  if (f < 1) {
    /* Height follows width's own scale to the nearest pixel (the georef derives its scale from
       width alone, so the vertical stays within half a pixel), and width steps down until
       rounding cannot push the result back over either limit. */
    const cw = plan.crop.width, ch = plan.crop.height;
    width = Math.max(1, Math.floor(cw * f));
    height = Math.max(1, Math.round(ch * width / cw));
    while (width > 1 && ((maxPixels && width * height > maxPixels) || (maxOutputPx && Math.max(width, height) > maxOutputPx))) {
      width -= 1;
      height = Math.max(1, Math.round(ch * width / cw));
    }
    /* Exact dimensions, not "fit inside": the georef's scale is derived from width alone, so
       height must follow the same factor to the pixel. */
    pipeline = sharp(await pipeline.png().toBuffer(), { limitInputPixels: false }).resize(width, height, { fit: "fill" });
  }
  if (format === "raw") {
    const { data, info } = await pipeline.removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height, channels: info.channels, fetched: results.length };
  }
  const buffer = format === "png" ? await pipeline.png().toBuffer() : await pipeline.jpeg({ quality }).toBuffer();
  return { buffer, width, height, fetched: results.length };
}
