/* Map source providers and the resolver that picks one per course/run.
 *
 *   COURSE GEO (bounds)
 *        |
 *   resolveMapSources({ imagery, terrain })      <- AUTO | EXISTING | MAPBOX, chosen separately
 *        |                    |
 *   provider.getImagery   provider.getElevation  <- independent; one failing never takes the other
 *        |                    |
 *   ImageryResult         TerrainResult           <- same shapes whatever the provider
 *        |                    |
 *   existing Clarity processing (AI scan / georef core, elevation grid)
 *
 * A provider is { id, label, supportsImagery, supportsTerrain, storable, getImagery?, getElevation? }.
 * Not every provider implements both. `storable` is the licensing fence: only a storable
 * provider's output may become stored course data. gd-imagery-sources.mjs remains the gate for
 * every automatic path (mapper chain, snapshot worker) - this module does not replace it, it
 * wraps it so a test path can ask the same registry for a picture, and so a non-storable source
 * like Mapbox can be forced for one run without ever being reachable automatically.
 *
 * Adding a provider later (Korea VWorld/NGII, another national source) is one more entry in
 * PROVIDERS - nothing downstream of the results changes. */

import { resolveImagerySource, unscannableReason } from "./gd-imagery-sources.mjs";
import { resolveTerrain, planSources } from "./terrain/gd-terrain-resolver.mjs";
import { MapSourceError, MemoryTileCache, tiledImagery, tiledElevation } from "./gd-tile-fetch.mjs";
import { createMapboxProvider, MAPBOX_PROVIDER_ID } from "./gd-mapbox-source.mjs";

export const SOURCE_CHOICES = Object.freeze(["auto", "existing", "mapbox"]);

export function normaliseChoice(value) {
  const v = String(value || "").trim().toLowerCase();
  return SOURCE_CHOICES.includes(v) ? v : "auto";
}

/* ---------- the existing registry, as a provider ---------- */

const existingCache = new MemoryTileCache();

function tileUrlFrom(template) {
  return t => template.replace(/\{ *z *\}/g, t.z).replace(/\{ *x *\}/g, t.x).replace(/\{ *y *\}/g, t.y);
}

function extensionOf(template) {
  const m = /\.([a-z0-9]+)(?:\?|$)/i.exec(String(template || "").split("?")[0] + "?");
  return m ? m[1].toLowerCase() : "img";
}

/* The registry's tiled (xyz) sources read through the same stitcher as Mapbox, so the two can
   be compared like for like. ArcGIS export sources (NAIP, 3DEP) are captured by the snapshot
   worker's own block path and are not re-implemented here: asking for one is an explicit
   "unsupported" rather than a silent second implementation. */
export function createExistingProvider(deps = {}) {
  const env = deps.env;
  const cache = deps.cache === undefined ? existingCache : deps.cache;
  const fetchImpl = deps.fetchImpl || fetch;
  async function sharpFn() { return deps.sharp || (await import("sharp")).default; }
  return {
    id: "existing",
    label: "Clarity imagery registry",
    supportsImagery: true,
    supportsTerrain: true,
    storable: true,
    async getImagery(bounds, options = {}) {
      const resolved = resolveImagerySource(bounds, { env });
      if (!resolved) throw new MapSourceError("existing", "unsupported-bounds", unscannableReason(bounds, { env }));
      const spec = resolved.imagery;
      if (spec.adapter !== "xyz") throw new MapSourceError(resolved.key, "unsupported-bounds", resolved.label + " is an " + spec.adapter + " source - only tiled sources are readable from this test path");
      return tiledImagery({
        provider: resolved.key, product: spec.layer || resolved.key, label: resolved.label,
        tilePx: 256, format: extensionOf(spec.urlTemplate),
        minZoom: Number(spec.minTrustedZoom) || 1, maxZoom: Number(spec.maxUsefulZoom) || 19,
        attribution: resolved.attribution && resolved.attribution.text || "",
        tileUrl: tileUrlFrom(spec.urlTemplate)
      }, bounds, options, { cache, fetchImpl, sharp: await sharpFn() });
    },
    async getElevation(bounds, options = {}) {
      /* The terrain resolver's best approved source for these bounds where it is a tiled one,
         else the global terrain tiles - the same registry a course bake reads. */
      const resolution = resolveTerrain({ bounds, env, marginM: 0 });
      const planned = resolution.ok ? planSources(resolution, { env }) : [];
      const dem = planned.find(s => s.sourceType === "xyz-elevation") || null;
      if (!dem) throw new MapSourceError("existing", "unsupported-bounds", "no tiled terrain source covers these bounds");
      return tiledElevation({
        provider: dem.id, product: dem.layer || dem.id, label: dem.name,
        tilePx: 256, format: extensionOf(dem.urlTemplate),
        minZoom: 1, maxZoom: Number(dem.maxUsefulZoom) || 13,
        encoding: dem.encoding,
        attribution: dem.attribution && dem.attribution.text || "",
        tileUrl: tileUrlFrom(dem.urlTemplate)
      }, bounds, options, { cache, fetchImpl, sharp: await sharpFn() });
    }
  };
}

/* ---------- resolution ---------- */

export function defaultProviders(deps = {}) {
  return { existing: createExistingProvider(deps), [MAPBOX_PROVIDER_ID]: createMapboxProvider(deps) };
}

/* Which provider serves each role.
     existing - the licensed registry; for imagery, null with a reason when nothing covers it
     mapbox   - Mapbox, forced. Never substituted: a forced source that fails shows its failure.
     auto     - today identical to existing. AUTO must only ever pick a STORABLE provider, so it
                can never land on Mapbox while Mapbox is display-only. Country-based choice
                belongs here later, not in the callers. */
export function resolveMapSources(request = {}, { bounds, env, providers } = {}) {
  const table = providers || defaultProviders({ env });
  function pick(role, choiceRaw) {
    const choice = normaliseChoice(choiceRaw);
    const id = choice === "mapbox" ? MAPBOX_PROVIDER_ID : "existing";
    const provider = table[id] || null;
    const supports = provider && (role === "imagery" ? provider.supportsImagery : provider.supportsTerrain);
    if (!supports) return { role, choice, forced: choice !== "auto", provider: null, reason: id + " does not supply " + role };
    if (choice === "auto" && !provider.storable) return { role, choice, forced: false, provider: null, reason: "auto never selects a non-storable source" };
    return { role, choice, forced: choice !== "auto", provider, storable: !!provider.storable, reason: "" };
  }
  return { imagery: pick("imagery", request.imagery), terrain: pick("terrain", request.terrain), bounds };
}

function failure(provider, error) {
  if (error instanceof MapSourceError) return error.toJSON();
  return { provider: provider && provider.id || "", code: "http", message: String(error && error.message || error) };
}

/* Runs both roles side by side. Each comes back as { ok, result } or { ok:false, error } -
   imagery failing never discards a good terrain result and vice versa. */
export async function acquireMapSources(selection, options = {}) {
  const run = async (pickRole, fn, opts) => {
    if (!pickRole.provider) return { ok: false, error: { provider: "", code: "unsupported-bounds", message: pickRole.reason } };
    try { return { ok: true, result: await fn.call(pickRole.provider, selection.bounds, opts || {}) }; }
    catch (error) { return { ok: false, error: failure(pickRole.provider, error) }; }
  };
  const [imagery, terrain] = await Promise.all([
    run(selection.imagery, selection.imagery.provider && selection.imagery.provider.getImagery, options.imagery),
    run(selection.terrain, selection.terrain.provider && selection.terrain.provider.getElevation, options.terrain)
  ]);
  return { imagery, terrain };
}

/* Provenance for whatever is recorded about a run: what was used, never how to reach it (no
   URLs, no tokens). */
export function provenanceFor(acquired, generatedAt = new Date().toISOString()) {
  const im = acquired.imagery && acquired.imagery.ok ? acquired.imagery.result : null;
  const te = acquired.terrain && acquired.terrain.ok ? acquired.terrain.result : null;
  return {
    imageryProvider: im ? im.source.provider : null,
    imageryProduct: im ? im.source.product : null,
    imageryZoom: im ? im.zoom : null,
    imageryMetresPerPixel: im ? Math.round(im.metresPerPixel * 1000) / 1000 : null,
    imageryBounds: im ? im.bounds : null,
    terrainProvider: te ? te.source.provider : null,
    terrainProduct: te ? te.source.product : null,
    terrainZoom: te ? te.zoom : null,
    terrainMetresPerSample: te ? Math.round(te.metresPerSample * 100) / 100 : null,
    generatedAt
  };
}
