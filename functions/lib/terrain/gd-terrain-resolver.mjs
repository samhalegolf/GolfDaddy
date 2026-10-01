/* Terrain Resolver - which approved source(s) a course should be baked from.

   Pure: no network, no storage. It answers with a plan and the reasoning behind it, and the
   bake (gd-terrain-bake.mjs) carries the plan out. Keeping the decision separate from the
   fetch is what lets the admin page show "what would happen" without doing it, and lets a
   rebake compare the current asset against the best answer today.

   Ranking, best first, among sources that are usable for this course:
     1. coverage   - a source whose region contains the whole course beats one that only
                     reaches part of it
     2. quality    - lidar > high-resolution > regional > global (capped by resolution)
     3. resolution - finer wins
     4. priority   - the registry's tie-break
   The global source is never ranked against the rest: it is always the fallback, and the
   primary only when nothing better is usable.

   Nothing here is about any one country. Northern Ireland, New Zealand or a single estate's
   LiDAR survey are all just entries in gd-terrain-sources.mjs. */

import { TERRAIN_CONFIG, qualityRank, effectiveQualityClass } from "./gd-terrain-config.mjs";
import {
  TERRAIN_SOURCES, GLOBAL_TERRAIN_SOURCE_ID, IMPLEMENTED_SOURCE_TYPES,
  licenceGrantsStorage, configureSource, sourceProvenance, sourceFingerprint
} from "./gd-terrain-sources.mjs";
import { supportedCrs } from "./gd-terrain-crs.mjs";

const M_PER_DEG = 111320;

export function validBounds(b) {
  return !!(b && [b.south, b.west, b.north, b.east].every(v => Number.isFinite(Number(v))) && b.north > b.south && b.east > b.west);
}

/* Course bounds grown by a margin in metres. */
export function padBoundsM(bounds, metres) {
  const lat = (bounds.north + bounds.south) / 2;
  const dLat = metres / M_PER_DEG;
  const dLng = metres / (M_PER_DEG * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
  return { south: bounds.south - dLat, north: bounds.north + dLat, west: bounds.west - dLng, east: bounds.east + dLng };
}

function boxContains(box, b) {
  return b.south >= box.south && b.north <= box.north && b.west >= box.west && b.east <= box.east;
}
function boxIntersects(box, b) {
  return b.south < box.north && b.north > box.south && b.west < box.east && b.east > box.west;
}

function pointInRing(ring, lng, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function samplePoints(b) {
  const pts = [];
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
    pts.push([b.west + (b.east - b.west) * i / 4, b.south + (b.north - b.south) * j / 4]);
  }
  return pts;
}

/* "full" | "partial" | "none" for the course against a source's DECLARED coverage. Measured
   coverage (what actually came back from the provider) is checked again after the fetch. */
export function declaredCoverage(source, bounds) {
  const c = source.coverage || {};
  if (c.type === "global") return "full";
  if (c.type === "region" && Array.isArray(c.bboxes)) {
    if (c.bboxes.some(box => boxContains(box, bounds))) return "full";
    return c.bboxes.some(box => boxIntersects(box, bounds)) ? "partial" : "none";
  }
  if (c.type === "polygon" && Array.isArray(c.rings)) {
    const inside = samplePoints(bounds).map(([lng, lat]) => c.rings.some(r => pointInRing(r, lng, lat)));
    if (inside.every(Boolean)) return "full";
    if (inside.some(Boolean)) return "partial";
    const vertexInside = c.rings.some(r => r.some(([lng, lat]) => lat >= bounds.south && lat <= bounds.north && lng >= bounds.west && lng <= bounds.east));
    return vertexInside ? "partial" : "none";
  }
  return "none";
}

/* Why a source cannot be used at all, independent of where the course is. */
function unusableReason(source, env) {
  if (source.enabled === false) return "disabled" + (source.disabledReason ? " (" + source.disabledReason + ")" : "");
  if (source.draft === true) return "draft entry, endpoints unverified";
  if (!licenceGrantsStorage(source.licence)) return "licence does not grant storage, derivatives and redistribution";
  if (!IMPLEMENTED_SOURCE_TYPES.includes(source.sourceType)) return "no adapter for source type " + source.sourceType;
  if (!supportedCrs(source.horizontalCrs)) return "horizontal CRS " + source.horizontalCrs + " is not supported";
  const configured = configureSource(source, env);
  if (configured.error) return configured.error;
  return "";
}

function effectiveClass(source) {
  return effectiveQualityClass(source.qualityClass, source.resolutionM);
}

function compareCandidates(a, b) {
  const cov = (a.coverage === "full" ? 0 : 1) - (b.coverage === "full" ? 0 : 1);
  if (cov) return cov;
  const q = qualityRank(effectiveClass(b.source)) - qualityRank(effectiveClass(a.source));
  if (q) return q;
  const r = (Number(a.source.resolutionM) || 999) - (Number(b.source.resolutionM) || 999);
  if (r) return r;
  return (Number(b.source.priority) || 0) - (Number(a.source.priority) || 0);
}

/* Two sources may be blended only when their heights mean the same thing. Unknown datums
   never blend: an unexplained offset between two DEMs draws a cliff along the seam. */
export function datumsCompatible(a, b) {
  const da = String(a && a.verticalDatum || ""), db = String(b && b.verticalDatum || "");
  return !!da && da === db && da !== "mixed-msl";
}

/* resolve({ bounds, countryCode?, regionName?, env?, sources?, config? })

   bounds is the AUTHORITATIVE course extent (tees, greens, routes) - the margin is added here
   so every caller gets the same frame. Returns:
     { ok, courseBounds, frameBounds, primarySource, fallbackSource, plan, candidates,
       coverage, expectedResolutionM, strategy, upgrade, log, fingerprint } */
export function resolveTerrain(input = {}) {
  const config = input.config || TERRAIN_CONFIG;
  const sources = Array.isArray(input.sources) ? input.sources : TERRAIN_SOURCES;
  const log = [];
  if (!validBounds(input.bounds)) {
    return { ok: false, error: "course bounds are unusable", log: ["course bounds are unusable"] };
  }
  const courseBounds = input.bounds;
  const frameBounds = padBoundsM(courseBounds, Number.isFinite(input.marginM) ? input.marginM : config.marginM);

  const candidates = [];
  let global = null;
  for (const source of sources) {
    const coverage = declaredCoverage(source, courseBounds);
    const reason = unusableReason(source, input.env);
    const isGlobal = source.id === GLOBAL_TERRAIN_SOURCE_ID || (source.coverage && source.coverage.type === "global");
    let status = "accepted", why = "";
    if (coverage === "none") { status = "rejected"; why = "outside coverage"; }
    else if (reason) { status = "rejected"; why = reason; }
    const entry = { id: source.id, name: source.name, status, reason: why, coverage, source,
      resolutionM: source.resolutionM, qualityClass: effectiveClass(source), global: isGlobal };
    candidates.push(entry);
    if (isGlobal && status === "accepted" && !global) global = entry;
  }

  const regional = candidates.filter(c => c.status === "accepted" && !c.global).sort(compareCandidates);
  regional.forEach((c, i) => { c.rank = i + 1; });

  const selectedResolution = Number((regional[0] || global || {}).resolutionM) || Infinity;
  for (const c of candidates) {
    if (c.global) continue;
    if (c.status === "rejected") {
      /* A better-resolution source that is unusable is worth calling out: it is the most
         likely thing an admin wants to fix. */
      const better = c.coverage !== "none" && Number(c.resolutionM) < selectedResolution;
      log.push(c.name + " — " + c.reason + (better ? " (better resolution than the selected source)" : ""));
    } else {
      log.push(c.name + " — accepted (" + c.coverage + " coverage, " + c.resolutionM + "m, " + c.qualityClass + ", rank " + c.rank + ")");
    }
  }
  log.push(global ? global.name + " — available as fallback" : "global fallback — UNAVAILABLE");

  const primary = regional[0] || global;
  if (!primary) {
    log.push("selected — nothing (no usable source)");
    return { ok: false, error: "no usable terrain source", courseBounds, frameBounds, candidates: candidates.map(publicCandidate), log };
  }
  const fallback = primary === global ? null : global;

  /* Fetch order: the primary, then any other regional source that could fill gaps, then the
     global. A later source is only ever used where an earlier one has no ground - and only
     blended in when the datums agree (gd-terrain-normalise.mjs enforces that again). */
  const plan = [primary, ...regional.filter(c => c !== primary), ...(fallback ? [fallback] : [])];
  const partialPrimary = primary.coverage === "partial";
  const blendable = partialPrimary && plan.slice(1).some(c => datumsCompatible(primary.source, c.source));
  const strategy = primary === global ? "global-only" : blendable ? "composite" : "single-with-fallback";
  log.push("selected — " + primary.name + (fallback ? " (fallback: " + fallback.name + ")" : "") + ", strategy " + strategy);

  const upgrade = upgradeOpportunity(candidates, primary, input);
  if (upgrade.opportunity) log.push("terrain upgrade opportunity — " + upgrade.reason);

  return {
    ok: true,
    courseBounds,
    frameBounds,
    primarySource: sourceProvenance(primary.source),
    fallbackSource: fallback ? sourceProvenance(fallback.source) : null,
    plan: plan.map(c => c.id),
    candidates: candidates.map(publicCandidate),
    coverage: { primary: primary.coverage },
    expectedResolutionM: Number(primary.source.resolutionM) || null,
    strategy,
    upgrade,
    log,
    fingerprint: plan.map(c => sourceFingerprint(c.source)).join("+")
  };
}

function publicCandidate(c) {
  return { id: c.id, name: c.name, status: c.status, reason: c.reason, coverage: c.coverage,
    resolutionM: c.resolutionM, qualityClass: c.qualityClass, global: c.global, rank: c.rank || null };
}

/* Is there something better this course could have? Either a source that covers it but is
   unusable right now, or no regional source at all - the latter is the cue for a research
   agent or developer to find one and add it to the registry. */
function upgradeOpportunity(candidates, primary, input) {
  const region = String(input.regionName || input.countryCode || "unknown");
  if (!primary.global) return { opportunity: false, region, regionalConfigured: true, reason: "" };
  const blocked = candidates.filter(c => !c.global && c.coverage !== "none" && c.status === "rejected");
  if (blocked.length) {
    return { opportunity: true, region, regionalConfigured: true,
      reason: blocked.map(c => c.name + " covers this course but is " + c.reason).join("; ") };
  }
  return { opportunity: true, region, regionalConfigured: false, reason: "no regional terrain source configured for " + region };
}

/* The registry entries a course's resolver result would actually read from, resolved against
   the environment - for the bake. */
export function planSources(resolution, { env, sources } = {}) {
  const table = Array.isArray(sources) ? sources : TERRAIN_SOURCES;
  return (resolution.plan || []).map(id => {
    const entry = table.find(s => s.id === id);
    const configured = entry ? configureSource(entry, env) : { error: "unknown source " + id };
    return configured.source || null;
  }).filter(Boolean);
}

/* Should the course's current asset be rebuilt? Compares what it was baked from against what
   the resolver would pick today.
     upToDate        - same sources, same versions, same format
     upgradeAvailable- the resolver now prefers a better source than the asset used
     sourceUpdated   - same source, but its dataset/version changed
   An asset baked from the fallback because the primary FAILED counts as upgradeable: the
   primary may well work now. */
export function assessRebuild(manifest, resolution, { formatVersion } = {}) {
  if (!manifest) return { upToDate: false, rebuild: true, reason: "no terrain asset yet" };
  if (!resolution || !resolution.ok) return { upToDate: true, rebuild: false, reason: "resolver has no usable source" };
  const reasons = [];
  if (formatVersion && manifest.formatVersion !== formatVersion) reasons.push("asset format " + manifest.formatVersion + " -> " + formatVersion);
  const used = (manifest.sources || []).map(s => s.id);
  const best = resolution.primarySource && resolution.primarySource.id;
  let upgradeAvailable = false, sourceUpdated = false;
  if (best && used[0] !== best) {
    upgradeAvailable = true;
    reasons.push("better source available: " + resolution.primarySource.name + " (asset uses " + (manifest.sources && manifest.sources[0] ? manifest.sources[0].name : "nothing") + ")");
  } else if (manifest.resolverFingerprint && manifest.resolverFingerprint !== resolution.fingerprint) {
    sourceUpdated = true;
    reasons.push("terrain source updated since the asset was baked");
  }
  return { upToDate: !reasons.length, rebuild: !!reasons.length, upgradeAvailable, sourceUpdated, reason: reasons.join("; ") };
}
