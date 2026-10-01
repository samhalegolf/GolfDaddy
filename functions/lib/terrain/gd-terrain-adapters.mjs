/* Provider adapters - the only code that knows how a provider delivers heights.

   Each adapter turns one KIND of delivery (slippy elevation tiles, an ArcGIS ImageServer
   export, Clarity-staged grid tiles) into RawTerrainData, and nothing after this file ever
   learns which kind it was:

     RawTerrainData {
       sourceId, crs,                 // the CRS the samples are laid out in
       width, height,
       heights: Float32Array,         // metres; NaN = no data (never 0, never "lowest ground")
       transform: { originX, originY, pixelSize },  // top-left CORNER of pixel (0,0), in crs
                                                   // units; pixel (i,j) centre is
                                                   // (originX + (i+.5)*pixelSize, originY - (j+.5)*pixelSize)
       verticalDatum, resolutionM,
       requests: { total, failed, missing },
       warnings: [string]
     }

   An adapter is { sourceType, canHandle(source), fetchTerrain({ source, bounds,
   desiredResolutionM }, deps) }. Adding a GeoTIFF/COG/WCS/LAS reader is one more object in
   ADAPTERS - the resolver already refuses sources whose type is not implemented
   (IMPLEMENTED_SOURCE_TYPES in gd-terrain-sources.mjs), so add it there too.

   Missing data is kept missing on purpose. The old capture path filled NoData with the
   block's lowest real ground, which makes a sea-level plateau look like measured terrain; here
   a gap stays NaN until gd-terrain-normalise.mjs decides what may fill it and records that it
   did. */

import zlib from "node:zlib";
import { TERRAIN_CONFIG } from "./gd-terrain-config.mjs";
import { projectBounds } from "./gd-terrain-crs.mjs";
import { ELEVATION_ENCODINGS, heightsFromFloat32Tiff } from "../gd-relief-core.mjs";
import { exportImageUrl } from "../gd-imagery-sources.mjs";

const TILE = 256;
const MERC_HALF = 20037508.342789244;
const PLAUSIBLE = v => Number.isFinite(v) && v > -500 && v < 9000;

export class TerrainError extends Error {
  /* code: timeout | rate-limited | network | http | malformed | decode | coverage | config */
  constructor(sourceId, code, message) {
    super(message);
    this.sourceId = sourceId;
    this.code = code;
  }
  toJSON() { return { sourceId: this.sourceId, code: this.code, message: this.message }; }
}

/* ---------- web mercator geometry --------------------------------------------------------- */

export function mercMetresPerPixel(zoom) {
  return (MERC_HALF * 2) / (TILE * Math.pow(2, zoom));
}

export function lngLatToWorldPx(lat, lng, zoom) {
  const scale = TILE * Math.pow(2, zoom);
  const r = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  return { x: ((lng + 180) / 360) * scale, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * scale };
}

/* The zoom whose ground spacing is at or just finer than the metres asked for, at a latitude. */
export function zoomForResolution(lat, metres, { minZoom = 1, maxZoom = 20 } = {}) {
  const ground = (156543.03392804097 * Math.cos(lat * Math.PI / 180));
  const z = Math.ceil(Math.log2(ground / Math.max(0.01, metres)));
  return Math.max(minZoom, Math.min(maxZoom, z));
}

/* The pixel rectangle covering WGS84 bounds at a zoom. */
export function pixelRectFor(bounds, zoom) {
  const nw = lngLatToWorldPx(bounds.north, bounds.west, zoom);
  const se = lngLatToWorldPx(bounds.south, bounds.east, zoom);
  const left = Math.floor(nw.x), top = Math.floor(nw.y);
  return { left, top, width: Math.max(1, Math.ceil(se.x) - left), height: Math.max(1, Math.ceil(se.y) - top) };
}

function mercTransform(rect, zoom) {
  const mpp = mercMetresPerPixel(zoom);
  return { originX: rect.left * mpp - MERC_HALF, originY: MERC_HALF - rect.top * mpp, pixelSize: mpp };
}

/* ---------- network --------------------------------------------------------------------- */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* One GET with timeout, retries and rate-limit handling.
     -> { buffer, contentType } on 2xx
     -> { missing: true } on 404/204 - a real hole in the source, not worth retrying
     throws TerrainError(timeout | rate-limited | network | http) once retries are spent */
export async function fetchWithRetry(url, { sourceId = "", fetchImpl, config = TERRAIN_CONFIG, sleepImpl = sleep } = {}) {
  const http = config.http;
  const doFetch = fetchImpl || fetch;
  let last = null;
  for (let attempt = 0; attempt <= http.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), http.timeoutMs);
    let response;
    try {
      response = await doFetch(url, { signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      const aborted = error && (error.name === "AbortError" || /abort/i.test(String(error.message)));
      last = new TerrainError(sourceId, aborted ? "timeout" : "network", (aborted ? "timed out" : "network error") + ": " + String(error && error.message || error).slice(0, 160));
      if (attempt < http.retries) { await sleepImpl(http.retryBaseMs * Math.pow(2, attempt)); continue; }
      throw last;
    }
    clearTimeout(timer);
    if (response.status === 404 || response.status === 204) return { missing: true };
    if (response.ok) {
      const contentType = String(response.headers && response.headers.get ? response.headers.get("content-type") || "" : "");
      return { buffer: Buffer.from(await response.arrayBuffer()), contentType };
    }
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers && response.headers.get ? response.headers.get("retry-after") : NaN);
      last = new TerrainError(sourceId, response.status === 429 ? "rate-limited" : "http", "HTTP " + response.status);
      if (attempt < http.retries) {
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(http.maxRetryAfterMs, retryAfter * 1000) : http.retryBaseMs * Math.pow(2, attempt);
        await sleepImpl(wait);
        continue;
      }
      throw last;
    }
    /* 4xx other than 404/429: the request itself is wrong (bad key, bad layer). Retrying
       cannot help. */
    throw new TerrainError(sourceId, "http", "HTTP " + response.status);
  }
  throw last || new TerrainError(sourceId, "network", "request failed");
}

async function pool(items, limit, worker) {
  let cursor = 0;
  async function pump() { while (cursor < items.length) { const i = cursor++; await worker(items[i], i); } }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, pump));
}

async function sharpOf(deps) {
  return deps.sharp || (await import("sharp")).default;
}

/* ---------- xyz-elevation: slippy tiles with heights packed into RGB ------------------------ */

/* Decode one tile's pixels under the DECLARED encoding. Pixels that decode outside plausible
   ground, sentinel pixels, and transparent pixels are NaN. A tile that is almost entirely
   implausible is a rendered picture or an error image, not elevation, and is refused whole. */
export function decodeElevationTile(raw, width, height, channels, encoding) {
  const decode = ELEVATION_ENCODINGS[encoding];
  if (!decode) throw new Error("unknown elevation encoding " + encoding);
  const heights = new Float32Array(width * height);
  /* declared: pixels the PROVIDER marks as no data (transparent, or the encoding's own NoData
     sentinel). Anything else that decodes outside plausible ground is a misread. */
  let valid = 0, declared = 0, lo = Infinity, hi = -Infinity;
  for (let i = 0, p = 0; i < heights.length; i++, p += channels) {
    if (channels === 4 && raw[p + 3] === 0) { heights[i] = NaN; declared++; continue; }
    const v = decode(raw[p], raw[p + 1], raw[p + 2]);
    if (Number.isNaN(v)) { heights[i] = NaN; declared++; continue; }
    if (PLAUSIBLE(v)) { heights[i] = v; valid++; if (v < lo) lo = v; if (v > hi) hi = v; }
    else heights[i] = NaN;
  }
  if (valid && hi - lo > 3000) throw new Error("tile spans " + Math.round(hi - lo) + "m - not elevation under " + encoding);
  /* A tile with no plausible ground that the provider did not mark as no data is a picture or
     an error image wearing the encoding - refused, not read as a hole. */
  if (!valid && declared < heights.length) throw new Error("no plausible ground under " + encoding);
  return { heights, valid };
}

function placeBlock(target, targetW, block, blockW, blockH, left, top, targetH) {
  for (let y = 0; y < blockH; y++) {
    const ty = top + y;
    if (ty < 0 || ty >= targetH) continue;
    for (let x = 0; x < blockW; x++) {
      const tx = left + x;
      if (tx < 0 || tx >= targetW) continue;
      target[ty * targetW + tx] = block[y * blockW + x];
    }
  }
}

function mercZoomFor(source, bounds, desiredResolutionM) {
  const lat = (bounds.north + bounds.south) / 2;
  const wanted = Number(desiredResolutionM) || Number(source.resolutionM) || 10;
  return Math.min(Number(source.maxUsefulZoom) || 17, zoomForResolution(lat, wanted, { minZoom: 1, maxZoom: 20 }));
}

const xyzAdapter = {
  sourceType: "xyz-elevation",
  canHandle(source) { return !!(source && source.sourceType === "xyz-elevation" && source.urlTemplate && ELEVATION_ENCODINGS[source.encoding]); },
  async fetchTerrain({ source, bounds, desiredResolutionM, zoom: forcedZoom }, deps = {}) {
    const config = deps.config || TERRAIN_CONFIG;
    const sharp = await sharpOf(deps);
    let zoom = Number.isInteger(forcedZoom) ? forcedZoom : mercZoomFor(source, bounds, desiredResolutionM);
    let rect = pixelRectFor(bounds, zoom);
    /* Bounded fetch: a course never needs more than a few hundred tiles. */
    while ((Math.ceil((rect.left + rect.width) / TILE) - Math.floor(rect.left / TILE)) * (Math.ceil((rect.top + rect.height) / TILE) - Math.floor(rect.top / TILE)) > 900 && zoom > 1) {
      zoom -= 1; rect = pixelRectFor(bounds, zoom);
    }
    const heights = new Float32Array(rect.width * rect.height).fill(NaN);
    const tiles = [];
    for (let ty = Math.floor(rect.top / TILE); ty <= Math.floor((rect.top + rect.height - 1) / TILE); ty++) {
      for (let tx = Math.floor(rect.left / TILE); tx <= Math.floor((rect.left + rect.width - 1) / TILE); tx++) tiles.push({ tx, ty });
    }
    const requests = { total: tiles.length, failed: 0, missing: 0 };
    const warnings = [];
    let firstError = null;
    await pool(tiles, config.http.concurrency, async ({ tx, ty }) => {
      const url = source.urlTemplate.replace(/\{ *z *\}/g, zoom).replace(/\{ *x *\}/g, tx).replace(/\{ *y *\}/g, ty);
      let got;
      try { got = await fetchWithRetry(url, { sourceId: source.id, fetchImpl: deps.fetchImpl, config, sleepImpl: deps.sleepImpl }); }
      catch (error) { requests.failed++; firstError = firstError || error; return; }
      if (got.missing) { requests.missing++; return; }
      try {
        const { data, info } = await sharp(got.buffer).raw().toBuffer({ resolveWithObject: true });
        const decoded = decodeElevationTile(data, info.width, info.height, info.channels, source.encoding);
        placeBlock(heights, rect.width, decoded.heights, info.width, info.height, tx * TILE - rect.left, ty * TILE - rect.top, rect.height);
      } catch (error) {
        requests.failed++;
        if (warnings.length < 5) warnings.push("tile " + zoom + "/" + tx + "/" + ty + " undecodable: " + String(error && error.message || error).slice(0, 120));
      }
    });
    /* Every request failed for a network reason: that is an outage, and it is the caller's to
       record and fall back from - not an empty grid to pretend with. */
    if (requests.failed === requests.total && firstError) throw firstError;
    if (requests.failed + requests.missing === requests.total) {
      throw new TerrainError(source.id, requests.missing === requests.total ? "coverage" : "malformed", "no usable tiles (" + requests.missing + " missing, " + requests.failed + " failed)");
    }
    return {
      sourceId: source.id, crs: "EPSG:3857", width: rect.width, height: rect.height, heights,
      transform: mercTransform(rect, zoom), zoom,
      verticalDatum: source.verticalDatum || null, resolutionM: source.resolutionM,
      requests, warnings
    };
  }
};

/* ---------- arcgis-image-server: exportImage as float32 TIFF ------------------------------- */

const arcgisAdapter = {
  sourceType: "arcgis-image-server",
  canHandle(source) { return !!(source && source.sourceType === "arcgis-image-server" && source.endpoint && source.encoding === "float32"); },
  async fetchTerrain({ source, bounds, desiredResolutionM, zoom: forcedZoom }, deps = {}) {
    const config = deps.config || TERRAIN_CONFIG;
    const zoom = Number.isInteger(forcedZoom) ? forcedZoom : mercZoomFor(source, bounds, desiredResolutionM);
    const rect = pixelRectFor(bounds, zoom);
    const block = Number(source.blockPx) || 2048;
    const blocks = [];
    for (let y = 0; y < rect.height; y += block) for (let x = 0; x < rect.width; x += block) {
      blocks.push({ left: rect.left + x, top: rect.top + y, width: Math.min(block, rect.width - x), height: Math.min(block, rect.height - y) });
    }
    const heights = new Float32Array(rect.width * rect.height).fill(NaN);
    const requests = { total: blocks.length, failed: 0, missing: 0 };
    const warnings = [];
    let firstError = null;
    const spec = { endpoint: source.endpoint, format: source.format || "tiff", renderingRule: source.renderingRule, apiKey: source.apiKey, adapter: "arcgis-export" };
    await pool(blocks, Math.min(4, config.http.concurrency), async b => {
      let got;
      try { got = await fetchWithRetry(exportImageUrl(spec, b, zoom), { sourceId: source.id, fetchImpl: deps.fetchImpl, config, sleepImpl: deps.sleepImpl }); }
      catch (error) { requests.failed++; firstError = firstError || error; return; }
      if (got.missing) { requests.missing++; return; }
      /* ArcGIS answers some errors as HTTP 200 with a JSON body. */
      if (/json|html|text/i.test(got.contentType) || (got.buffer[0] === 0x7b)) {
        requests.failed++;
        if (warnings.length < 5) warnings.push("block " + b.left + "," + b.top + " answered " + (got.contentType || "non-image") + ": " + got.buffer.toString("utf8", 0, 120));
        return;
      }
      try {
        const decoded = await heightsFromFloat32Tiff(got.buffer);
        /* 3DEP marks water and unflown ground with a huge negative sentinel: nodata, not ground. */
        for (let i = 0; i < decoded.heights.length; i++) if (!PLAUSIBLE(decoded.heights[i])) decoded.heights[i] = NaN;
        placeBlock(heights, rect.width, decoded.heights, decoded.width, decoded.height, b.left - rect.left, b.top - rect.top, rect.height);
      } catch (error) {
        /* 3DEP intermittently returns a valid-looking TIFF with a malformed internal tile.
           That block stays NaN; the rest of the course is still good. */
        requests.failed++;
        if (warnings.length < 5) warnings.push("block " + b.left + "," + b.top + " undecodable: " + String(error && error.message || error).slice(0, 120));
      }
    });
    if (requests.failed === requests.total && firstError) throw firstError;
    if (requests.failed + requests.missing === requests.total) {
      throw new TerrainError(source.id, "malformed", "no usable blocks (" + requests.missing + " missing, " + requests.failed + " failed)");
    }
    return {
      sourceId: source.id, crs: "EPSG:3857", width: rect.width, height: rect.height, heights,
      transform: mercTransform(rect, zoom), zoom,
      verticalDatum: source.verticalDatum || null, resolutionM: source.resolutionM,
      requests, warnings
    };
  }
};

/* ---------- clarity-staged: a provider's bulk download, re-tiled once into our storage ------

   For providers that publish files rather than a service (OSNI's zipped TXT sheets). The
   staging script (scripts/terrain/stage-terrain-source.mjs) reads the provider's download
   ONCE, validates it and writes fixed-size tiles in the provider's own CRS:

     <bucket>/<sourceId>/<datasetVersion>/index.json
       { formatVersion: 1, sourceId, datasetVersion, crs, verticalDatum, resolutionM,
         tileSizeM, pixelSize, tiles: { "<col>_<row>": { path, width, height, originX, originY } } }
     <bucket>/<sourceId>/<datasetVersion>/tiles/<col>_<row>.f32.gz
       gzip of little-endian Float32 heights, row-major from the north-west, NaN = nodata

   A course reads only the handful of tiles under its frame - never the country. */

export function stagedTileKeys(index, nativeRect) {
  const size = Number(index.tileSizeM);
  const keys = [];
  for (let col = Math.floor(nativeRect.minX / size); col <= Math.floor(nativeRect.maxX / size); col++) {
    for (let row = Math.floor(nativeRect.minY / size); row <= Math.floor(nativeRect.maxY / size); row++) keys.push(col + "_" + row);
  }
  return keys;
}

export function encodeStagedTile(heights) {
  const buf = Buffer.from(heights.buffer, heights.byteOffset, heights.byteLength);
  return zlib.gzipSync(buf);
}

export function decodeStagedTile(buffer, width, height) {
  const raw = zlib.gunzipSync(buffer);
  if (raw.length !== width * height * 4) throw new Error("staged tile is " + raw.length + " bytes, expected " + width * height * 4);
  const copy = new Uint8Array(raw.length);
  copy.set(raw);
  return new Float32Array(copy.buffer);
}

function stagedBaseUrl(source, deps) {
  if (deps.stagedBaseUrl) return deps.stagedBaseUrl.replace(/\/+$/, "");
  const base = String((deps.env || process.env).SUPABASE_URL || "").replace(/\/+$/, "");
  if (!base) throw new TerrainError(source.id, "config", "SUPABASE_URL is not set, staged terrain cannot be read");
  return base + "/storage/v1/object/public/" + ((source.staged && source.staged.bucket) || "terrain-sources");
}

const stagedAdapter = {
  sourceType: "clarity-staged",
  canHandle(source) { return !!(source && source.sourceType === "clarity-staged" && source.datasetVersion); },
  async fetchTerrain({ source, bounds }, deps = {}) {
    const config = deps.config || TERRAIN_CONFIG;
    const root = stagedBaseUrl(source, deps) + "/" + source.id + "/" + source.datasetVersion;
    const got = await fetchWithRetry(root + "/index.json", { sourceId: source.id, fetchImpl: deps.fetchImpl, config, sleepImpl: deps.sleepImpl });
    if (got.missing) throw new TerrainError(source.id, "config", "staged index not found for " + source.id + "@" + source.datasetVersion);
    let index;
    try { index = JSON.parse(got.buffer.toString("utf8")); } catch (e) { throw new TerrainError(source.id, "malformed", "staged index is not JSON"); }
    if (!index || !index.tiles || !(index.pixelSize > 0) || !(index.tileSizeM > 0)) throw new TerrainError(source.id, "malformed", "staged index is missing tiles/pixelSize/tileSizeM");
    if (index.crs && index.crs !== source.horizontalCrs) {
      throw new TerrainError(source.id, "malformed", "staged CRS " + index.crs + " does not match the registry's " + source.horizontalCrs);
    }
    const px = Number(index.pixelSize);
    const native = projectBounds(source.horizontalCrs, bounds);
    /* Snap the output grid to the staged pixel grid so no sample is resampled twice. */
    const originX = Math.floor(native.minX / px) * px - px, originY = Math.ceil(native.maxY / px) * px + px;
    const width = Math.ceil((native.maxX - originX) / px) + 1, height = Math.ceil((originY - native.minY) / px) + 1;
    if (width * height > 25e6) throw new TerrainError(source.id, "coverage", "staged window is unreasonably large (" + width + "x" + height + ")");
    const heights = new Float32Array(width * height).fill(NaN);
    const keys = stagedTileKeys(index, native);
    const present = keys.filter(k => index.tiles[k]);
    const requests = { total: present.length, failed: 0, missing: keys.length - present.length };
    const warnings = [];
    let firstError = null;
    await pool(present, config.http.concurrency, async key => {
      const tile = index.tiles[key];
      let res;
      try { res = await fetchWithRetry(root + "/" + tile.path, { sourceId: source.id, fetchImpl: deps.fetchImpl, config, sleepImpl: deps.sleepImpl }); }
      catch (error) { requests.failed++; firstError = firstError || error; return; }
      if (res.missing) { requests.missing++; return; }
      let data;
      try { data = decodeStagedTile(res.buffer, tile.width, tile.height); }
      catch (error) { requests.failed++; warnings.push("staged tile " + key + " corrupt: " + String(error.message).slice(0, 100)); return; }
      const left = Math.round((tile.originX - originX) / px), top = Math.round((originY - tile.originY) / px);
      placeBlock(heights, width, data, tile.width, tile.height, left, top, height);
    });
    if (present.length && requests.failed === present.length && firstError) throw firstError;
    if (!present.length || requests.failed + (requests.missing - (keys.length - present.length)) === present.length) {
      throw new TerrainError(source.id, "coverage", "no staged tiles under this course");
    }
    return {
      sourceId: source.id, crs: source.horizontalCrs, width, height, heights,
      transform: { originX, originY, pixelSize: px },
      verticalDatum: index.verticalDatum || source.verticalDatum || null,
      resolutionM: Number(index.resolutionM) || source.resolutionM,
      requests, warnings
    };
  }
};

export const ADAPTERS = Object.freeze([xyzAdapter, arcgisAdapter, stagedAdapter]);

export function adapterFor(source, adapters = ADAPTERS) {
  return adapters.find(a => a.canHandle(source)) || null;
}
