/* Fetching tiled imagery and elevation for a map source: HTTP, errors, cache.
 *
 * Shared by every tiled provider (gd-mapbox-source.mjs, and the registry's own xyz sources
 * through gd-map-sources.mjs) so "what a failed tile means" is decided once. A provider is
 * just a description - its tile URL, tile size, zoom range, and how its DEM is encoded - and
 * everything here turns that into either a finished result or an explicit MapSourceError.
 *
 * Failure is always explicit. Nothing here falls back to another source: whether a failure
 * may fall back is the caller's decision (gd-map-sources resolveMapSources), and a forced
 * source must show its real failure. */

import { selectZoom, stitchPlan, stitch, georefFor, metresPerPixel, validBounds } from "./gd-tile-mosaic-core.mjs";
import { elevationGridFromRaw } from "./gd-elevation-grid-core.mjs";

/* ---------- errors ---------- */

/* code is one of:
     not-configured    no token/key for the provider
     unauthorized      401 - bad or missing token
     forbidden         403 - token lacks scope, URL restriction, or account problem
     rate-limited      429 after retries
     missing-tile      404 - no tile there (outside coverage, or beyond the tileset's zoom)
     bad-request       400/422 - the provider refused the request shape
     http              any other non-2xx
     timeout           no answer in time
     network           connection failed
     malformed         bytes that do not decode as the expected image
     unsupported-bounds  bounds unusable or too large for the tile budget
     partial           some tiles failed (the detail names the first failure's code)
     terrain-decode    tiles arrived but do not decode as elevation */
export class MapSourceError extends Error {
  constructor(provider, code, message, extra = {}) {
    super(message);
    this.name = "MapSourceError";
    this.provider = provider;
    this.code = code;
    Object.assign(this, extra);
  }
  toJSON() {
    return { provider: this.provider, code: this.code, message: this.message, status: this.status || null, failedTiles: this.failedTiles || null, totalTiles: this.totalTiles || null };
  }
}

/* Never let a token reach a log, an error message, or stored metadata. */
export function redactUrl(url) {
  return String(url || "").replace(/([?&](?:access_token|api|token|key)=)[^&]+/gi, "$1[redacted]");
}

/* ---------- cache ---------- */

/* An in-process cache, keyed provider/product/version/z/x/y@ratio. It lives as long as the
   function instance stays warm, which is what stops a development session re-downloading the
   same tiles on every run - and no longer.

   Deliberately NOT a persistent store (Netlify Blobs, Supabase storage). Mapbox's terms limit
   caching its content, and a persistent tile store would also be the first step towards
   coupling Clarity to a provider's tiles - the cache must stay replaceable. Anything with
   get/set can be injected instead. */
export class MemoryTileCache {
  constructor({ maxBytes = 48 * 1024 * 1024, ttlMs = 12 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
    this.maxBytes = maxBytes; this.ttlMs = ttlMs; this.now = now;
    this.map = new Map(); this.bytes = 0; this.hits = 0; this.misses = 0;
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit || this.now() - hit.at > this.ttlMs) {
      if (hit) { this.map.delete(key); this.bytes -= hit.buffer.length; }
      this.misses++;
      return null;
    }
    /* Re-insert so Map order is least-recently-used first. */
    this.map.delete(key); this.map.set(key, hit);
    this.hits++;
    return hit.buffer;
  }
  set(key, buffer) {
    if (!buffer || buffer.length > this.maxBytes) return;
    const old = this.map.get(key);
    if (old) { this.map.delete(key); this.bytes -= old.buffer.length; }
    this.map.set(key, { buffer, at: this.now() });
    this.bytes += buffer.length;
    for (const [k, v] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(k); this.bytes -= v.buffer.length;
    }
  }
}

export function tileCacheKey({ provider, product, version, z, x, y, ratio, format }) {
  return [provider, product, version || "v1", z, x, y + "@" + (ratio || 1) + "x." + (format || "img")].join("/");
}

/* ---------- HTTP ---------- */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function classifyStatus(status) {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "missing-tile";
  if (status === 429) return "rate-limited";
  if (status === 400 || status === 422) return "bad-request";
  return "http";
}

/* One tile, with a timeout and a small retry for the failures that are worth one: rate
   limiting and server errors. Retry-After is honoured up to maxBackoffMs - a sync function has
   seconds, not minutes, so a long wait is reported as rate-limited rather than slept through.
   Auth and not-found failures are never retried; they will not change in 500ms. */
export async function fetchTileBytes(url, { provider, fetchImpl = fetch, timeoutMs = 6000, retries = 1, backoffMs = 400, maxBackoffMs = 2000 } = {}) {
  let attempt = 0;
  for (;;) {
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
      if (attempt < retries) { attempt++; await sleep(backoffMs); continue; }
      throw new MapSourceError(provider, timedOut ? "timeout" : "network", (timedOut ? "tile timed out after " + timeoutMs + "ms" : "tile request failed: " + String(error && error.message || error)) + " - " + redactUrl(url));
    }
    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) throw new MapSourceError(provider, "malformed", "empty tile body - " + redactUrl(url));
      return buffer;
    }
    const code = classifyStatus(response.status);
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < retries) {
      const after = Number(response.headers && response.headers.get && response.headers.get("retry-after"));
      const wait = Number.isFinite(after) && after > 0 ? after * 1000 : backoffMs * (attempt + 1);
      if (wait <= maxBackoffMs) { attempt++; await sleep(wait); continue; }
    }
    let detail = "";
    try { detail = (await response.text()).slice(0, 200); } catch (e) { detail = ""; }
    throw new MapSourceError(provider, code, "HTTP " + response.status + " for " + redactUrl(url) + (detail ? " - " + detail.replace(/\s+/g, " ") : ""), { status: response.status });
  }
}

/* Many tile failures, one error. When every failure shares a cause (all 401s for a bad
   token) that cause IS the error; otherwise it is "partial" and names the first. */
function tileFailure(provider, failed, total) {
  const codes = failed.map(f => (f.error && f.error.code) || "http");
  const first = failed[0].error || {};
  const same = codes.every(c => c === codes[0]);
  const code = same && failed.length === total ? codes[0] : "partial";
  const message = (code === "partial" ? failed.length + " of " + total + " tiles failed (first: " + codes[0] + ")" : codes[0] + " on all " + total + " tiles")
    + ": " + String(first.message || first);
  return new MapSourceError(provider, code, message, { status: first.status || null, failedTiles: failed.length, totalTiles: total });
}

/* A source description's tile fetcher, through the cache. */
function cachedFetcher(source, { cache, fetchImpl }) {
  return async tile => {
    const key = tileCacheKey({ provider: source.provider, product: source.product, version: source.cacheVersion, z: tile.z, x: tile.x, y: tile.y, ratio: source.tilePx / 256, format: source.format });
    const hit = cache && cache.get(key);
    if (hit) return hit;
    const buffer = await fetchTileBytes(source.tileUrl(tile), { provider: source.provider, fetchImpl, ...(source.http || {}) });
    if (cache) cache.set(key, buffer);
    return buffer;
  };
}

/* ---------- results ---------- */

/* Satellite/aerial picture of the bounds.

   source: { provider, product, tilePx, format, minZoom, maxZoom, tileUrl(t), attribution }
   options: { targetPx (long side wanted), maxOutputPx, maxPixels, maxTiles }

   -> ImageryResult { image, mediaType, width, height, bounds, requestedBounds, zoom,
                      pixelRatio, tilesRequested, metresPerPixel, georef, source, fetchedAt } */
export async function tiledImagery(source, bounds, options, deps) {
  if (!validBounds(bounds)) throw new MapSourceError(source.provider, "unsupported-bounds", "bounds are unusable");
  const targetPx = Number(options.targetPx) || 1568;
  const picked = selectZoom(bounds, { tilePx: source.tilePx, targetPx, minZoom: source.minZoom, maxZoom: source.maxZoom, maxTiles: options.maxTiles || 64 });
  if (picked.error) throw new MapSourceError(source.provider, "unsupported-bounds", picked.error);
  const plan = picked.plan;
  const out = await stitch(plan, { fetchTile: cachedFetcher(source, deps), sharp: deps.sharp, format: "jpeg", quality: 88, maxOutputPx: Number(options.maxOutputPx) || targetPx, maxPixels: Number(options.maxPixels) || 0 });
  if (out.failed) throw tileFailure(source.provider, out.failed, plan.tiles.length);
  const georef = georefFor(plan, out.width, out.height);
  const midLat = (plan.bounds.north + plan.bounds.south) / 2;
  return {
    image: out.buffer,
    mediaType: "image/jpeg",
    width: out.width,
    height: out.height,
    bounds: plan.bounds,
    requestedBounds: plan.requestedBounds,
    zoom: plan.zoom,
    pixelRatio: plan.tilePx / 256,
    tilesRequested: plan.tiles.length,
    metresPerPixel: metresPerPixel(midLat, georef.playSurface.captureZoom),
    georef,
    source: { provider: source.provider, product: source.product, label: source.label || "", attribution: source.attribution || "" },
    fetchedAt: new Date().toISOString()
  };
}

/* Elevation grid of the bounds, at the source's sharpest zoom that fits the tile budget.
   Native samples - no resizing, which would invent heights between real ones.

   -> TerrainResult { heights, width, height, bounds, requestedBounds, georef, metresPerSample,
                      minElevation, maxElevation, zoom, tilesRequested, encoding, source, fetchedAt } */
export async function tiledElevation(source, bounds, options, deps) {
  if (!validBounds(bounds)) throw new MapSourceError(source.provider, "unsupported-bounds", "bounds are unusable");
  const maxTiles = options.maxTiles || 16;
  let zoom = source.maxZoom;
  let plan = stitchPlan(bounds, zoom, source.tilePx);
  while (plan.tiles.length > maxTiles && zoom > (source.minZoom || 0)) { zoom--; plan = stitchPlan(bounds, zoom, source.tilePx); }
  if (plan.tiles.length > maxTiles) throw new MapSourceError(source.provider, "unsupported-bounds", "terrain bounds need more than " + maxTiles + " tiles");
  const out = await stitch(plan, { fetchTile: cachedFetcher(source, deps), sharp: deps.sharp, format: "raw" });
  if (out.failed) throw tileFailure(source.provider, out.failed, plan.tiles.length);
  const georef = georefFor(plan, out.width, out.height);
  const midLat = (plan.bounds.north + plan.bounds.south) / 2;
  const grid = elevationGridFromRaw(out.buffer, {
    width: out.width, height: out.height, channels: out.channels,
    encoding: source.encoding, georef, bounds: plan.bounds,
    metresPerSample: metresPerPixel(midLat, plan.pixelZoom),
    source: { provider: source.provider, product: source.product, label: source.label || "", attribution: source.attribution || "" }
  });
  if (grid.error) throw new MapSourceError(source.provider, "terrain-decode", grid.error);
  return Object.assign(grid, {
    requestedBounds: plan.requestedBounds,
    zoom: plan.zoom,
    tilesRequested: plan.tiles.length,
    fetchedAt: new Date().toISOString()
  });
}
