/* Course terrain as a stored, versioned asset - the bake's front door.

     ensureCourseTerrain   reuse the current asset if it is still right, else bake a new
                           version, store it, and point the course at it. Never throws: a
                           failure is recorded and the previous asset (if any) stays live.
     loadCourseTerrain     the current manifest, for consumers (export, live frame, admin)
     terrainStatus         resolver dry run + current asset + rebuild assessment, for admin

   Storage layout (public course-visuals bucket, beside the course's frames):
     <courseId>/terrain/v<N>/heights.png     terrain-RGB heightfield (gd-terrain-normalise grid)
     <courseId>/terrain/v<N>/mask.png        8-bit source/filled mask
     <courseId>/terrain/v<N>/manifest.json   provenance, quality, coverage, resolver log
   Database (course_terrain, one row per course): the current version, the manifest (metadata
   only - never the heights), and the last failure. The previous version's files are kept
   until the next bake so a frame exported against it never points at nothing.

   deps: { supabaseFetch, storage: { upload, download, list, remove }, bake: { fetchImpl, ... },
           sharp, terrainRgbPngFromHeights, now } */

import { resolveTerrain } from "./gd-terrain-resolver.mjs";
import { bakeCourseTerrain, encodeTerrainAsset, reuseDecision, terrainSummary, TERRAIN_FORMAT_VERSION } from "./gd-terrain-bake.mjs";

export const TERRAIN_TABLE = "course_terrain";
export const TERRAIN_BUCKET = "course-visuals";

export function terrainPaths(courseId, version) {
  const root = courseId + "/terrain/v" + version;
  return { root, heights: root + "/heights.png", mask: root + "/mask.png", manifest: root + "/manifest.json" };
}

export async function loadTerrainRow(courseId, deps) {
  const rows = await deps.supabaseFetch(TERRAIN_TABLE + "?select=*&course_id=eq." + encodeURIComponent(courseId) + "&limit=1");
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/* The current asset's manifest with its file paths, or null. */
export async function loadCourseTerrain(courseId, deps) {
  const row = await loadTerrainRow(courseId, deps);
  if (!row || row.status !== "ready" || !row.manifest) return null;
  return Object.assign({}, row.manifest, { files: { heights: row.heights_path, mask: row.mask_path, manifest: row.manifest_path } });
}

function rowFromManifest(courseId, manifest, paths) {
  const primary = manifest.sources && manifest.sources[0];
  return {
    course_id: courseId,
    terrain_version: manifest.terrainVersion,
    status: "ready",
    format_version: manifest.formatVersion,
    primary_source_id: primary ? primary.id : null,
    source_ids: manifest.sourceIds,
    quality_class: manifest.quality.class,
    green_detail: manifest.quality.greenDetail,
    confidence: manifest.quality.confidence,
    source_resolution_m: manifest.sourceResolutionM,
    grid_resolution_m: manifest.grid.metresPerPixel,
    vertical_datum: manifest.verticalDatum,
    coverage_core: manifest.coverage.core,
    resolver_fingerprint: manifest.resolverFingerprint,
    manifest,
    heights_path: paths.heights,
    mask_path: paths.mask,
    manifest_path: paths.manifest,
    last_error: null,
    last_attempt_at: manifest.generatedAt,
    generated_at: manifest.generatedAt,
    updated_at: manifest.generatedAt
  };
}

async function upsertRow(row, deps) {
  await deps.supabaseFetch(TERRAIN_TABLE + "?on_conflict=course_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([row])
  });
}

/* Keep the version just written and the one before it; older version folders go. */
async function sweepOldVersions(courseId, keepFrom, deps) {
  if (!deps.storage.list || !deps.storage.remove) return 0;
  const entries = await deps.storage.list(courseId + "/terrain/");
  const stale = entries.filter(e => e && e.id === null && /^v\d+$/.test(e.name || "") && Number(e.name.slice(1)) < keepFrom).map(e => e.name);
  let removed = 0;
  for (const dir of stale) {
    const files = await deps.storage.list(courseId + "/terrain/" + dir + "/");
    const paths = files.filter(f => f && f.id !== null && f.name).map(f => courseId + "/terrain/" + dir + "/" + f.name);
    await deps.storage.remove(paths);
    removed += paths.length;
  }
  return removed;
}

/* ensureCourseTerrain({ courseId, courseBounds, countryCode?, regionName?, force?, readOnly?, env? }, deps)
   -> { status: "reused" | "baked" | "failed" | "unavailable", manifest, decision, error? } */
export async function ensureCourseTerrain(input, deps) {
  const now = deps.now ? deps.now() : new Date();
  let row = null;
  try { row = await loadTerrainRow(input.courseId, deps); } catch (error) { row = null; }
  const current = row && row.status === "ready" ? row.manifest : null;
  const resolution = resolveTerrain({ bounds: input.courseBounds, countryCode: input.countryCode, regionName: input.regionName, env: input.env, sources: deps.bake && deps.bake.sources });
  const decision = reuseDecision(current, resolution, input.courseBounds, { now });
  if (current && decision.reuse && !input.force) {
    return { status: "reused", manifest: withFiles(current, row), decision };
  }
  if (input.readOnly) {
    return { status: current ? "reused" : "unavailable", manifest: current ? withFiles(current, row) : null, decision };
  }
  const version = (Number(row && row.terrain_version) || 0) + 1;
  try {
    const baked = await bakeCourseTerrain({
      courseId: input.courseId, courseBounds: input.courseBounds, countryCode: input.countryCode,
      regionName: input.regionName, terrainVersion: version, env: input.env
    }, Object.assign({ now: () => now }, deps.bake || {}));
    const encoded = await encodeTerrainAsset(baked, deps);
    const paths = terrainPaths(input.courseId, version);
    await deps.storage.upload(paths.heights, encoded.heightsPng, "image/png");
    await deps.storage.upload(paths.mask, encoded.maskPng, "image/png");
    await deps.storage.upload(paths.manifest, Buffer.from(JSON.stringify(baked.manifest)), "application/json");
    await upsertRow(rowFromManifest(input.courseId, baked.manifest, paths), deps);
    try { await sweepOldVersions(input.courseId, version - 1, deps); } catch (e) { /* best effort */ }
    return { status: "baked", manifest: Object.assign({}, baked.manifest, { files: { heights: paths.heights, mask: paths.mask, manifest: paths.manifest } }), decision };
  } catch (error) {
    const message = String(error && error.message || error).slice(0, 600);
    /* The previous asset stays live; only the failure is recorded. */
    try {
      if (row) {
        await deps.supabaseFetch(TERRAIN_TABLE + "?course_id=eq." + encodeURIComponent(input.courseId), {
          method: "PATCH", body: JSON.stringify({ last_error: message, last_attempt_at: now.toISOString(), updated_at: now.toISOString() })
        });
      } else {
        await upsertRow({ course_id: input.courseId, terrain_version: 0, status: "failed", last_error: message, last_attempt_at: now.toISOString(), updated_at: now.toISOString() }, deps);
      }
    } catch (e) { /* recording the failure must not become the failure */ }
    return { status: "failed", error: message, details: error && error.details ? { failures: error.details.failures || [], log: error.details.log || [] } : null, manifest: current ? withFiles(current, row) : null, decision };
  }
}

function withFiles(manifest, row) {
  return Object.assign({}, manifest, { files: { heights: row.heights_path, mask: row.mask_path, manifest: row.manifest_path } });
}

/* The current asset's heights, decoded - for endpoints that cut windows from it. Held per warm
   function instance (a round asks for the same course hole after hole), keyed by version so a
   rebake is picked up at once. deps: { supabaseFetch, download(path) -> Buffer, sharp,
   decodeElevation } */
const assetCache = new Map();
const ASSET_CACHE_MAX = 3;

export async function loadCourseTerrainHeights(courseId, deps) {
  const manifest = await loadCourseTerrain(courseId, deps);
  if (!manifest || !manifest.files || !manifest.files.heights) return null;
  const key = courseId + "@" + manifest.terrainVersion;
  if (assetCache.has(key)) return assetCache.get(key);
  const png = await deps.download(manifest.files.heights);
  const { data, info } = await deps.sharp(png, { limitInputPixels: false }).raw().toBuffer({ resolveWithObject: true });
  const decoded = deps.decodeElevation(data, info.width, info.height, info.channels, "terrain-rgb");
  const entry = { manifest, heights: decoded.heights };
  assetCache.set(key, entry);
  while (assetCache.size > ASSET_CACHE_MAX) assetCache.delete(assetCache.keys().next().value);
  return entry;
}

/* Everything the admin terrain panel shows for one course, with no fetching. */
export async function terrainStatus(input, deps) {
  const row = await loadTerrainRow(input.courseId, deps).catch(() => null);
  const manifest = row && row.status === "ready" ? row.manifest : null;
  const resolution = resolveTerrain({ bounds: input.courseBounds, countryCode: input.countryCode, regionName: input.regionName, env: input.env, sources: deps.bake && deps.bake.sources });
  const decision = resolution.ok ? reuseDecision(manifest, resolution, input.courseBounds, { now: deps.now ? deps.now() : new Date() }) : null;
  return {
    courseId: input.courseId,
    formatVersion: TERRAIN_FORMAT_VERSION,
    summary: terrainSummary(manifest, resolution, decision),
    lastError: row ? row.last_error || null : null,
    lastAttemptAt: row ? row.last_attempt_at || null : null,
    resolution: resolution.ok ? {
      primarySource: resolution.primarySource, fallbackSource: resolution.fallbackSource,
      strategy: resolution.strategy, expectedResolutionM: resolution.expectedResolutionM,
      candidates: resolution.candidates, upgrade: resolution.upgrade, log: resolution.log
    } : { error: resolution.error },
    manifest
  };
}
