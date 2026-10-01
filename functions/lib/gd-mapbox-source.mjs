/* Mapbox as an upstream map source: satellite imagery and Terrain-DEM elevation, nothing else.
 *
 * DEV / TEST ONLY - NOT A SCAN SOURCE.
 *
 * Mapbox's Product Terms forbid tracing or otherwise deriving data from the Services except
 * for non-commercial use or OpenStreetMap; deriving commercial data from the imagery needs a
 * separate Mapbox Commercial Satellite licence, and caching is limited (30 days, on the
 * requesting device). Clarity stores and ships what it derives, so Mapbox fails the gate in
 * gd-imagery-sources.mjs on every count and is deliberately NOT an entry in IMAGERY_SOURCES:
 * resolveImagerySource can never return it, so the mapper, the snapshot worker and every
 * automatic path are untouched by this file.
 *
 * What it is for: forcing Mapbox on ONE course from the admin test path, to judge whether its
 * imagery is good enough where our licensed sources are absent (South Korea first). Every
 * result carries storable:false, and the AI scan treats a Mapbox picture as a dry run - shapes
 * are shown, never saved to the overlay. If a commercial agreement is ever signed, the licence
 * block below is where it gets recorded, and adding a registry entry is the separate, visible
 * decision that makes Mapbox a real source.
 *
 * API, per Mapbox's documentation (docs.mapbox.com was not reachable from the environment
 * this was written in - re-check these against the pages below before relying on them):
 *
 *   Raster Tiles API      https://docs.mapbox.com/api/maps/raster-tiles/
 *     GET https://api.mapbox.com/v4/{tileset_id}/{zoom}/{x}/{y}{@2x}.{format}?access_token=
 *     The "v4" is part of the current Raster Tiles API path, not a legacy endpoint: it is
 *     the documented way to read a raster TILESET's own pixels. The newer Static Tiles API
 *     (styles/v1/.../tiles) renders a STYLE, which is a picture of a map, not the source.
 *     @2x returns 512px tiles - the same ground at twice the pixels.
 *
 *   Satellite tileset     https://docs.mapbox.com/data/tilesets/reference/mapbox-satellite/
 *     tileset id mapbox.satellite; formats jpg70/jpg80/jpg90/png. Resolution varies by
 *     region; we cap at z19 (with @2x that is ~0.12-0.15m/px at golf latitudes - finer than
 *     any satellite source actually resolves) and selectZoom rarely asks for that much.
 *
 *   Terrain-DEM v1        https://docs.mapbox.com/data/tilesets/reference/mapbox-terrain-dem-v1/
 *     tileset id mapbox.mapbox-terrain-dem-v1, the recommended replacement for Terrain-RGB v1
 *     (mapbox.terrain-rgb). 512px tiles, max zoom 14. MUST be requested as pngraw - any other
 *     format is lossy-compressed and the low bits of every height are noise.
 *     Decoding:  height = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)   metres
 *     which is gd-relief-core's "terrain-rgb" encoding, used here unchanged.
 *
 *   Rate limits / errors  https://docs.mapbox.com/api/guides/#rate-limits
 *     Raster Tiles API default 100,000 requests/minute. 401 bad/missing token, 403 token
 *     not allowed (scopes or URL restrictions), 404 no tile / no tileset, 422 bad zoom or
 *     format, 429 rate limited (X-Rate-Limit-* headers).
 *
 *   Attribution           https://docs.mapbox.com/help/getting-started/attribution/
 *     Satellite needs "© Mapbox © OpenStreetMap" and "© Maxar" for the imagery.
 *
 *   Terms                 https://www.mapbox.com/legal/product-terms
 *
 * Config: MAPBOX_PUBLIC_TOKEN, a public "pk." token, set on the Netlify site like every other
 * key here. No default in code. A secret "sk." token is refused outright - nothing this file
 * does needs one, and accepting one would put it in tile URLs. */

import { MapSourceError, MemoryTileCache, tiledImagery, tiledElevation } from "./gd-tile-fetch.mjs";

export const MAPBOX_PROVIDER_ID = "mapbox";
export const MAPBOX_TOKEN_ENV = "MAPBOX_PUBLIC_TOKEN";
export const MAPBOX_API_BASE = "https://api.mapbox.com/v4";
export const MAPBOX_SATELLITE_PRODUCT = "mapbox.satellite";
export const MAPBOX_TERRAIN_PRODUCT = "mapbox.mapbox-terrain-dem-v1";
/* Bumped when the way tiles are requested changes, so warm caches cannot serve the old shape. */
export const MAPBOX_CACHE_VERSION = "v1";

export const MAPBOX_LICENSE = Object.freeze({
  name: "Mapbox Product Terms (display only - no commercial derivatives without a Commercial Satellite licence)",
  url: "https://www.mapbox.com/legal/product-terms",
  storage: false, derivatives: false, redistribution: false, commercial: false,
  attributionRequired: true
});

const SATELLITE_ATTRIBUTION = "© Mapbox © OpenStreetMap © Maxar";
const TERRAIN_ATTRIBUTION = "© Mapbox";

/* One cache per function instance, shared by every request it serves. */
const sharedCache = new MemoryTileCache();

function envStore(env) { return env || (typeof process !== "undefined" && process.env) || {}; }

/* The token, or "" when it is missing or is the wrong kind. */
export function mapboxToken(env) {
  const token = String(envStore(env)[MAPBOX_TOKEN_ENV] || "").trim();
  return token.startsWith("pk.") ? token : "";
}

/* Safe to log and safe to return to a browser: says whether, never what. */
export function mapboxStatus(env) {
  const raw = String(envStore(env)[MAPBOX_TOKEN_ENV] || "").trim();
  if (!raw) return { configured: false, reason: MAPBOX_TOKEN_ENV + " is not set" };
  if (raw.startsWith("sk.")) return { configured: false, reason: MAPBOX_TOKEN_ENV + " holds a secret (sk.) token - use a public pk. token" };
  if (!raw.startsWith("pk.")) return { configured: false, reason: MAPBOX_TOKEN_ENV + " is not a Mapbox public token" };
  return { configured: true, reason: "" };
}

export function mapboxTileUrl(product, tile, { token, retina = true, format }) {
  return MAPBOX_API_BASE + "/" + product + "/" + tile.z + "/" + tile.x + "/" + tile.y + (retina ? "@2x" : "") + "." + format
    + "?access_token=" + encodeURIComponent(token);
}

function satelliteSource(token) {
  return {
    provider: MAPBOX_PROVIDER_ID, product: MAPBOX_SATELLITE_PRODUCT, label: "Mapbox Satellite",
    tilePx: 512, format: "jpg90", minZoom: 1, maxZoom: 19, cacheVersion: MAPBOX_CACHE_VERSION,
    attribution: SATELLITE_ATTRIBUTION,
    tileUrl: t => mapboxTileUrl(MAPBOX_SATELLITE_PRODUCT, t, { token, format: "jpg90" })
  };
}

function terrainSource(token) {
  return {
    provider: MAPBOX_PROVIDER_ID, product: MAPBOX_TERRAIN_PRODUCT, label: "Mapbox Terrain-DEM v1",
    tilePx: 512, format: "pngraw", minZoom: 1, maxZoom: 14, cacheVersion: MAPBOX_CACHE_VERSION,
    encoding: "terrain-rgb", attribution: TERRAIN_ATTRIBUTION,
    tileUrl: t => mapboxTileUrl(MAPBOX_TERRAIN_PRODUCT, t, { token, format: "pngraw" })
  };
}

/* The provider. deps are injectable for tests: env, fetchImpl, sharp, cache. */
export function createMapboxProvider(deps = {}) {
  const env = deps.env;
  const cache = deps.cache === undefined ? sharedCache : deps.cache;
  const fetchImpl = deps.fetchImpl || fetch;
  async function sharpFn() { return deps.sharp || (await import("sharp")).default; }
  function requireToken() {
    const status = mapboxStatus(env);
    if (!status.configured) throw new MapSourceError(MAPBOX_PROVIDER_ID, "not-configured", status.reason);
    return mapboxToken(env);
  }
  return {
    id: MAPBOX_PROVIDER_ID,
    label: "Mapbox",
    supportsImagery: true,
    supportsTerrain: true,
    /* The fence. Anything that would store a derivative must check this and refuse. */
    storable: false,
    license: MAPBOX_LICENSE,
    products: { imagery: MAPBOX_SATELLITE_PRODUCT, terrain: MAPBOX_TERRAIN_PRODUCT },
    status: () => mapboxStatus(env),
    async getImagery(bounds, options = {}) {
      const token = requireToken();
      return tiledImagery(satelliteSource(token), bounds, options, { cache, fetchImpl, sharp: await sharpFn() });
    },
    async getElevation(bounds, options = {}) {
      const token = requireToken();
      return tiledElevation(terrainSource(token), bounds, options, { cache, fetchImpl, sharp: await sharpFn() });
    }
  };
}
