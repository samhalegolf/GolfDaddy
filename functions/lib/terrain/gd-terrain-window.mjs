/* Heights for one window of the map - the shared read path for every endpoint that shades or
   meshes on demand (live-terrain-frame, relief-tile, relief-preview).

   Two ways in, in this order:
     1. the course's BAKED terrain asset, when the caller names a course and the asset covers
        the window - Clarity-owned bytes, no provider contacted
     2. the terrain resolver's plan for the window's bounds, source by source until one covers
        it (the same registry, adapters and resampling the bake uses) - for ground no course
        asset covers yet

   A window is a target grid in the normaliser's shape: { zoom, originPx, width, height,
   stepX?, stepY? } - web-mercator pixels at an integer zoom, optionally coarser than them.
   Output heights are sampled at that grid's pixel centres; nodata never comes back as ground. */

import { TERRAIN_CONFIG } from "./gd-terrain-config.mjs";
import { resolveTerrain, planSources } from "./gd-terrain-resolver.mjs";
import { TERRAIN_SOURCES, sourceProvenance } from "./gd-terrain-sources.mjs";
import { ADAPTERS, adapterFor, mercMetresPerPixel, zoomForResolution } from "./gd-terrain-adapters.mjs";
import { reprojectToGrid, fillGaps, heightRange, gridPixelLatLng } from "./gd-terrain-normalise.mjs";

const MERC_HALF = 20037508.342789244;

/* WGS84 bounds of a target grid, with a margin of `padPx` grid pixels. */
export function gridBounds(grid, padPx = 0) {
  const nw = gridPixelLatLng(grid, -0.5 - padPx, -0.5 - padPx);
  const se = gridPixelLatLng(grid, grid.width - 0.5 + padPx, grid.height - 0.5 + padPx);
  return { north: nw.lat, west: nw.lng, south: se.lat, east: se.lng };
}

/* A baked asset is just another raw grid in EPSG:3857. */
export function assetAsRaw(manifest, heights) {
  const g = manifest.grid;
  const mpp = mercMetresPerPixel(g.captureZoom);
  return {
    sourceId: "clarity-asset", crs: "EPSG:3857", width: g.width, height: g.height, heights,
    transform: { originX: g.originPx.x * mpp - MERC_HALF, originY: MERC_HALF - g.originPx.y * mpp, pixelSize: mpp }
  };
}

function windowCovered(manifest, bounds) {
  const b = manifest && manifest.grid && manifest.grid.bounds;
  return !!b && bounds.south >= b.south && bounds.north <= b.north && bounds.west >= b.west && bounds.east <= b.east;
}

/* The zoom at which a source's real samples sit - what a tile/window should read it at. */
export function nativeZoomFor(source, latitude) {
  if (Number(source.maxUsefulZoom) > 0) return Number(source.maxUsefulZoom);
  return zoomForResolution(latitude, Number(source.resolutionM) || 10, { minZoom: 1, maxZoom: 20 });
}

/* terrainForWindow({ grid, asset?: { manifest, heights }, env? }, deps)
   -> { heights, from: "asset" | "provider", source, sampleM, range, tried }, heights null when
      nothing could answer */
export async function terrainForWindow(input, deps = {}) {
  const grid = input.grid;
  const bounds = gridBounds(grid);
  const latitude = (bounds.north + bounds.south) / 2;
  const tried = [];

  if (input.asset && input.asset.manifest && input.asset.heights && windowCovered(input.asset.manifest, bounds)) {
    const m = input.asset.manifest;
    const heights = reprojectToGrid(assetAsRaw(m, input.asset.heights), grid);
    const primary = m.sources && m.sources[0];
    return {
      heights, from: "asset",
      source: primary ? { id: primary.id, name: primary.name, attribution: primary.attribution } : null,
      sampleM: Number(m.sourceResolutionM) || null,
      quality: m.quality, terrainVersion: m.terrainVersion,
      range: heightRange(heights), tried
    };
  }
  if (input.asset && input.asset.manifest) tried.push("course asset (window outside it)");

  const config = deps.config || TERRAIN_CONFIG;
  const sources = deps.sources || TERRAIN_SOURCES;
  const resolution = resolveTerrain({ bounds, env: input.env, sources, config, marginM: 0 });
  if (!resolution.ok) return { heights: null, tried: [resolution.error] };
  /* A couple of grid pixels of margin so the resampler has neighbours at the edge. */
  const fetchBounds = gridBounds(grid, 3);
  for (const source of planSources(resolution, { env: input.env, sources })) {
    const adapter = adapterFor(source, deps.adapters || ADAPTERS);
    if (!adapter) { tried.push(source.id + " (no adapter)"); continue; }
    try {
      const raw = await adapter.fetchTerrain({ source, bounds: fetchBounds, zoom: Math.min(grid.zoom, nativeZoomFor(source, latitude)) }, deps);
      const heights = reprojectToGrid(raw, grid);
      let valid = 0;
      for (let i = 0; i < heights.length; i++) if (Number.isFinite(heights[i])) valid++;
      /* A window is small; it must be essentially whole, or the next source answers it. */
      if (valid < heights.length * 0.98) { tried.push(source.id + " (covers " + Math.round(valid / heights.length * 100) + "%)"); continue; }
      fillGaps(heights, new Uint8Array(heights.length), grid.width, grid.height);
      const metresAtZoom = mercMetresPerPixel(raw.zoom || grid.zoom) * Math.cos(latitude * Math.PI / 180);
      return {
        heights, from: "provider",
        source: sourceProvenance(source),
        sampleM: Math.max(Number(source.resolutionM) || 0, raw.zoom ? metresAtZoom : 0),
        range: heightRange(heights), tried
      };
    } catch (error) {
      tried.push(source.id + " (" + String(error && error.message || error).slice(0, 80) + ")");
    }
  }
  return { heights: null, tried };
}
