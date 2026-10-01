/* Course terrain bake: resolver plan -> adapters -> normalised Clarity heightfield + manifest.

     COURSE GEOMETRY (bounds) -> resolveTerrain -> for each planned source: adapter.fetchTerrain
       -> reprojectToGrid -> measured coverage -> anchor = first source that covers the course
       -> composite (better partial sources over it, compatible fillers under it)
       -> fillGaps (recorded) -> quality -> asset { heights, mask, manifest }

   Failure policy - terrain must never make a course unusable when a fallback exists:
     - a source that times out, rate-limits, answers garbage or does not cover the course is
       recorded in manifest.failures and the next source in the plan is tried
     - the global source is always last in the plan; only if IT fails too does the bake fail,
       and the caller (the worker) carries on with the course anyway, just without terrain

   Network, storage and image encoding are injected (deps) so the whole decision path runs in
   tests against synthetic adapters. */

import { TERRAIN_CONFIG, effectiveQualityClass, terrainCapabilities, terrainConfidence } from "./gd-terrain-config.mjs";
import { resolveTerrain, planSources, assessRebuild } from "./gd-terrain-resolver.mjs";
import { TERRAIN_SOURCES, sourceProvenance } from "./gd-terrain-sources.mjs";
import { ADAPTERS, adapterFor, TerrainError } from "./gd-terrain-adapters.mjs";
import {
  planClarityGrid, reprojectToGrid, measureCoverage, compositeLayers, fillGaps, filledRegions, heightRange
} from "./gd-terrain-normalise.mjs";

/* Bump when the asset's layout or meaning changes; assessRebuild treats an older format as
   stale. */
export const TERRAIN_FORMAT_VERSION = "clarity-terrain-1";

export class TerrainBakeError extends Error {
  constructor(message, details) { super(message); this.details = details || {}; }
}

function errorJson(sourceId, error) {
  if (error instanceof TerrainError) return error.toJSON();
  return { sourceId, code: "error", message: String(error && error.message || error).slice(0, 300) };
}

/* Is an existing asset still right for this course? Reused when it was baked from the sources
   the resolver picks today, in the current format, and its frame still contains the course
   (geometry that moved outside the baked frame needs a new fetch).

   An asset that fell back because the preferred source FAILED is retried - but not on every
   snapshot: only once the failure is RETRY_FAILED_AFTER_MS old, so an outage at a provider
   does not turn every bake into a doomed fetch. */
export const RETRY_FAILED_AFTER_MS = 24 * 60 * 60 * 1000;

export function reuseDecision(manifest, resolution, courseBounds, { now = new Date() } = {}) {
  const assessment = assessRebuild(manifest, resolution, { formatVersion: TERRAIN_FORMAT_VERSION });
  if (!manifest) return Object.assign({ reuse: false }, assessment);
  const f = manifest.frameBounds;
  const contained = f && courseBounds && courseBounds.south >= f.south && courseBounds.north <= f.north
    && courseBounds.west >= f.west && courseBounds.east <= f.east;
  if (!contained) return Object.assign({}, assessment, { reuse: false, rebuild: true, reason: "course geometry extends outside the baked terrain frame" });
  if (assessment.upgradeAvailable && manifest.formatVersion === TERRAIN_FORMAT_VERSION) {
    const best = resolution.primarySource.id;
    const failedBefore = (manifest.failures || []).some(x => x.sourceId === best);
    const age = now.getTime() - new Date(manifest.generatedAt).getTime();
    if (failedBefore && age < RETRY_FAILED_AFTER_MS) {
      return Object.assign({}, assessment, { reuse: true, rebuild: false, reason: best + " failed at the last bake; retrying after 24h" });
    }
  }
  return Object.assign({}, assessment, { reuse: !assessment.rebuild });
}

/* bakeCourseTerrain({ courseId, courseBounds, countryCode?, regionName?, terrainVersion?, env? }, deps)
   deps: { fetchImpl, sharp, sleepImpl, sources, adapters, config, now, stagedBaseUrl }
   -> { manifest, heights (Float32Array, no NaN), mask (Uint8Array), grid, resolution } */
export async function bakeCourseTerrain(input, deps = {}) {
  const config = deps.config || TERRAIN_CONFIG;
  const sources = deps.sources || TERRAIN_SOURCES;
  const adapters = deps.adapters || ADAPTERS;
  const resolution = resolveTerrain({ bounds: input.courseBounds, countryCode: input.countryCode, regionName: input.regionName, env: input.env, sources, config });
  if (!resolution.ok) throw new TerrainBakeError(resolution.error, { resolution });
  const planned = planSources(resolution, { env: input.env, sources });
  const log = resolution.log.slice();
  const failures = [];
  const fetched = [];
  let grid = planClarityGrid(resolution.frameBounds, planned[0] && planned[0].resolutionM, config);

  let anchorIndex = -1;
  for (let i = 0; i < planned.length; i++) {
    const source = planned[i];
    const adapter = adapterFor(source, adapters);
    if (!adapter) { failures.push({ sourceId: source.id, code: "config", message: "no adapter for " + source.sourceType }); continue; }
    let raw;
    try {
      raw = await adapter.fetchTerrain({ source, bounds: resolution.frameBounds, desiredResolutionM: source.resolutionM }, deps);
    } catch (error) {
      failures.push(errorJson(source.id, error));
      log.push(source.name + " — fetch failed: " + (error && error.message || error));
      continue;
    }
    const heights = reprojectToGrid(raw, grid);
    const coverage = measureCoverage(heights, grid, resolution.courseBounds);
    fetched.push({ source, raw, heights, coverage, requests: raw.requests, warnings: raw.warnings || [] });
    log.push(source.name + " — fetched " + raw.width + "x" + raw.height + " (" + raw.crs + "), core " + Math.round(coverage.core * 100) + "%, frame " + Math.round(coverage.frame * 100) + "%");
    if (coverage.core >= config.minCoreCoverage && coverage.frame >= config.minUsableFraction) {
      anchorIndex = fetched.length - 1;
      break;
    }
    failures.push({ sourceId: source.id, code: "coverage", message: "covers " + Math.round(coverage.core * 100) + "% of the course (needs " + Math.round(config.minCoreCoverage * 100) + "%)" });
  }

  /* No source reached full course coverage. Use the best partial one only if it is the last
     resort (better some real ground than none). */
  if (anchorIndex < 0) {
    const usable = fetched.filter(f => f.coverage.frame >= config.minUsableFraction);
    if (!usable.length) throw new TerrainBakeError("no terrain source produced usable ground", { failures, log, resolution });
    anchorIndex = fetched.indexOf(usable[usable.length - 1]);
    log.push("no source covers the whole course — using " + fetched[anchorIndex].source.name + " with gaps filled");
  }

  /* Sources ranked above the anchor that delivered SOME ground can still win where they have
     it (composite), and the global can fill under the anchor - both subject to datum checks.
     Sources fetched only as far as the anchor; fillers below it are fetched now if the anchor
     left gaps in the frame. */
  const anchor = fetched[anchorIndex];
  const above = fetched.slice(0, anchorIndex).filter(f => f.coverage.frame > 0);
  if (anchor.coverage.frame < 1) {
    for (const source of planned.slice(planned.indexOf(anchor.source) + 1)) {
      if (!datumsMatch(anchor.source, source)) continue;
      const adapter = adapterFor(source, adapters);
      if (!adapter) continue;
      try {
        const raw = await adapter.fetchTerrain({ source, bounds: resolution.frameBounds, desiredResolutionM: source.resolutionM }, deps);
        const heights = reprojectToGrid(raw, grid);
        fetched.push({ source, raw, heights, coverage: measureCoverage(heights, grid, resolution.courseBounds), requests: raw.requests, warnings: raw.warnings || [], filler: true });
      } catch (error) {
        failures.push(errorJson(source.id, error));
      }
    }
  }
  const layersInOrder = [...above, anchor, ...fetched.filter(f => f.filler)];

  /* Grid at the finest resolution actually used - not the resolution of a primary that
     failed, which would store a 25m answer on a 0.5m grid. */
  const bestResolution = Math.min(...layersInOrder.map(f => Number(f.source.resolutionM) || 30));
  const finalGrid = planClarityGrid(resolution.frameBounds, bestResolution, config);
  if (finalGrid.zoom !== grid.zoom || finalGrid.width !== grid.width) {
    grid = finalGrid;
    for (const f of layersInOrder) f.heights = reprojectToGrid(f.raw, grid);
  }

  /* The anchor's datum governs: put it first for compositing purposes, but let better partial
     sources still win where they have data - ordering in compositeLayers is preference. */
  const datumAnchor = { verticalDatum: anchor.source.verticalDatum };
  const layers = layersInOrder.map(f => ({ id: f.source.id, heights: f.heights, verticalDatum: f.source.verticalDatum }));
  const blendable = layers.filter((l, i) => layersInOrder[i] === anchor || datumsMatch(datumAnchor, l));
  const skippedAbove = layers.filter(l => !blendable.includes(l));
  /* compositeLayers checks datums against its first layer; with incompatible better sources
     already removed, the first layer shares the anchor's datum. */
  const composed = compositeLayers(blendable, grid);
  for (const s of skippedAbove) composed.skipped.push({ id: s.id, reason: "vertical datum " + (s.verticalDatum || "unknown") + " cannot be blended with " + (anchor.source.verticalDatum || "unknown") });
  for (const s of composed.skipped) log.push(s.id + " — not blended: " + s.reason);

  const coverage = measureCoverage(composed.heights, grid, resolution.courseBounds);
  const { filledFraction } = fillGaps(composed.heights, composed.mask, grid.width, grid.height);
  const range = heightRange(composed.heights);

  const usedSources = composed.used.filter(u => u.pixels > 0).map(u => {
    const f = layersInOrder.find(l => l.source.id === u.id);
    return Object.assign(sourceProvenance(f.source), {
      role: f === anchor ? "primary" : (layersInOrder.indexOf(f) < layersInOrder.indexOf(anchor) ? "detail" : "fill"),
      pixelFraction: Math.round(u.fraction * 10000) / 10000,
      maskValue: blendable.findIndex(l => l.id === u.id) + 1,
      requests: f.requests || null,
      warnings: (f.warnings || []).slice(0, 5)
    });
  }).sort((a, b) => (a.role === "primary" ? -1 : b.role === "primary" ? 1 : 0));
  const primary = anchor.source;
  const sourceResolutionM = Number(primary.resolutionM);
  const fallbackResolutionM = Math.max(Number(primary.fallbackResolutionM) || sourceResolutionM, ...usedSources.filter(s => s.role === "fill").map(s => s.fallbackResolutionM || s.resolutionM));
  const qualityClass = effectiveQualityClass(primary.qualityClass, sourceResolutionM, config);
  const capabilities = terrainCapabilities({ resolutionM: sourceResolutionM, fallbackResolutionM, coreCoverage: coverage.core }, config);
  const now = (deps.now ? deps.now() : new Date()).toISOString();
  const anchorIsGlobal = !!(resolution.candidates.find(c => c.id === primary.id) || {}).global;

  const manifest = {
    formatVersion: TERRAIN_FORMAT_VERSION,
    courseId: input.courseId,
    terrainVersion: Number(input.terrainVersion) || 1,
    generatedAt: now,
    grid: {
      projection: grid.projection, encoding: "terrain-rgb", captureZoom: grid.zoom,
      originPx: grid.originPx, width: grid.width, height: grid.height,
      bounds: grid.bounds, metresPerPixel: grid.metresPerPixel
    },
    courseBounds: resolution.courseBounds,
    frameBounds: resolution.frameBounds,
    marginM: config.marginM,
    elevationRange: range,
    horizontalCrs: "EPSG:3857",
    sourceCrs: [...new Set(layersInOrder.map(f => f.raw.crs))],
    verticalDatum: primary.verticalDatum || null,
    sources: usedSources,
    sourceIds: usedSources.map(s => s.id),
    sourceResolutionM,
    fallbackResolutionM,
    coverage: {
      core: round4(coverage.core), frame: round4(coverage.frame), filledFraction: round4(filledFraction),
      declared: resolution.coverage.primary
    },
    filledRegions: filledRegions(composed.mask, grid.width, grid.height),
    quality: {
      class: qualityClass,
      confidence: terrainConfidence({ resolutionM: sourceResolutionM, fallbackResolutionM, coreCoverage: coverage.core, filledFraction }),
      greenDetail: capabilities.greenDetail,
      capabilities
    },
    strategy: usedSources.length > 1 ? "composite" : anchorIsGlobal ? (resolution.strategy === "global-only" ? "global-only" : "fallback") : "single",
    resolver: {
      selected: resolution.primarySource && resolution.primarySource.id,
      fallback: resolution.fallbackSource && resolution.fallbackSource.id,
      strategy: resolution.strategy,
      expectedResolutionM: resolution.expectedResolutionM,
      upgrade: resolution.upgrade
    },
    resolverFingerprint: resolution.fingerprint,
    failures,
    log
  };
  return { manifest, heights: composed.heights, mask: composed.mask, grid, resolution };
}

function datumsMatch(a, b) {
  const da = String(a && a.verticalDatum || ""), db = String(b && b.verticalDatum || "");
  return !!da && da === db && da !== "mixed-msl";
}

function round4(v) { return Math.round(v * 10000) / 10000; }

/* The asset's bytes. Heights go out as terrain-RGB PNG - the format every consumer (export
   crop, phone mesh, green fit, watch maps) already decodes - and the mask as an 8-bit
   greyscale PNG: 0 nothing, 1..254 which manifest.sources entry (maskValue) the height came
   from, 255 filled from nearest ground. */
export async function encodeTerrainAsset(baked, { sharp, terrainRgbPngFromHeights }) {
  const heightsPng = await terrainRgbPngFromHeights(baked.heights, baked.grid.width, baked.grid.height);
  const maskPng = await sharp(Buffer.from(baked.mask.buffer, baked.mask.byteOffset, baked.mask.byteLength),
    { raw: { width: baked.grid.width, height: baked.grid.height, channels: 1 }, limitInputPixels: false })
    .toColourspace("b-w").png({ compressionLevel: 9 }).toBuffer();
  return { heightsPng, maskPng };
}

/* Admin summary of an asset, the shape the debug panel shows. */
export function terrainSummary(manifest, resolution, rebuild) {
  if (!manifest) {
    return {
      asset: null,
      resolverResult: resolution && resolution.primarySource ? resolution.primarySource.name : null,
      fallback: resolution && resolution.fallbackSource ? resolution.fallbackSource.name : null,
      upgrade: resolution ? resolution.upgrade : null,
      rebuild: rebuild || null,
      log: resolution ? resolution.log : []
    };
  }
  const primary = manifest.sources && manifest.sources[0];
  return {
    asset: "v" + manifest.terrainVersion,
    resolverResult: resolution && resolution.primarySource ? resolution.primarySource.name : null,
    bakedFrom: primary ? primary.name : null,
    sourceResolutionM: manifest.sourceResolutionM,
    finalGridM: Math.round(manifest.grid.metresPerPixel * 100) / 100,
    fallback: resolution && resolution.fallbackSource ? resolution.fallbackSource.name : null,
    greenDetail: manifest.quality.greenDetail,
    qualityClass: manifest.quality.class,
    confidence: manifest.quality.confidence,
    coverage: manifest.coverage,
    verticalDatum: manifest.verticalDatum,
    fetched: manifest.generatedAt,
    failures: manifest.failures,
    upgrade: resolution ? resolution.upgrade : null,
    rebuild: rebuild || null,
    log: resolution ? resolution.log : manifest.log
  };
}
