/* Course terrain - admin visibility and control over the terrain system (functions/lib/terrain/).
   Admin only.

   GET  ?courseId=<id>
        The course's terrain panel: resolver result and log (what would be picked today and
        why every other source was or was not), the current asset (source, resolution, grid,
        green detail, version, when fetched, coverage, failures), whether a rebuild or upgrade
        is due, and its recent terrain jobs. Nothing is fetched from any provider.
   GET  ?report=sources
        Every registry entry with whether it is usable right now (and why not), plus how many
        baked courses currently use it.
   GET  ?report=upgrades[&limit=]
        Baked courses whose terrain could be better: the resolver now prefers another source,
        a source's dataset changed, or the course sits on the global fallback - grouped by
        region, so an unconfigured region is one line, not two hundred.
   POST {courseId, action: "rebuild", force?}
        Queue a terrain job for one course. force rebakes even when the asset is current.
   POST {action: "rebuild-source", sourceId, dryRun?}
        Queue terrain jobs for baked courses that `sourceId` would now improve, and published
        courses never baked whose centre it covers - at most
        TERRAIN_CONFIG.maxBatchEnqueue per call, skipping courses with a terrain job already
        live. Call again for the next batch; dryRun lists them without queueing.

   Terrain jobs run on the visual worker's queue (course_visual_jobs, kind "terrain"), so they
   inherit its claim/relay/reaper retry behaviour; a finished terrain job that produced a new
   version re-exports the course's frames when it has published ones. */

import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";
import { hasSupabase, verifiedAdminEmail, json, supabaseBase, supabaseKey } from "./lib/gd-map-overlay-store.mjs";
import { courseBoundsFor } from "./lib/gd-visual-plan-core.mjs";
import { terrainStatus, TERRAIN_TABLE } from "./lib/terrain/gd-terrain-service.mjs";
import { resolveTerrain, assessRebuild, declaredCoverage } from "./lib/terrain/gd-terrain-resolver.mjs";
import { TERRAIN_SOURCES, configureSource, licenceGrantsStorage, IMPLEMENTED_SOURCE_TYPES, sourceById } from "./lib/terrain/gd-terrain-sources.mjs";
import { TERRAIN_FORMAT_VERSION } from "./lib/terrain/gd-terrain-bake.mjs";
import { TERRAIN_CONFIG } from "./lib/terrain/gd-terrain-config.mjs";

const JOBS_TABLE = "course_visual_jobs";
const MAPS_TABLE = "course_maps";
const FRESH_MS = 20 * 60 * 1000;

const supabaseFetch = createSupabaseFetch({ base: supabaseBase, key: supabaseKey, label: "course-terrain" });

async function pingWorker(req, jobId) {
  try {
    await fetch(new URL(req.url).origin + "/.netlify/functions/course-visual-worker-background", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: jobId || null })
    }).catch(() => {});
  } catch (e) { /* the job stays queued for the sweeper */ }
}

async function loadCourse(courseId) {
  const rows = await supabaseFetch(MAPS_TABLE + "?select=course_id,course_name,objects_json,holes_json,country_code,country,region&course_id=eq." + encodeURIComponent(courseId) + "&published=eq.true&limit=1");
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  const pkg = { courseId: row.course_id, courseName: row.course_name || row.course_id, objects: row.objects_json || {}, holes: row.holes_json || {} };
  return { pkg, bounds: courseBoundsFor(pkg), countryCode: row.country_code || null, regionName: row.region || row.country || row.country_code || null };
}

/* One live terrain job per course. */
async function enqueueTerrainJob(courseId, requestedBy, recipe) {
  const freshCutoff = new Date(Date.now() - FRESH_MS).toISOString();
  const existing = await supabaseFetch(JOBS_TABLE + "?select=id,status&course_id=eq." + encodeURIComponent(courseId) + "&kind=eq.terrain&status=in.(queued,running)&updated_at=gt." + encodeURIComponent(freshCutoff) + "&limit=1");
  if (Array.isArray(existing) && existing[0]) return { job: existing[0], existing: true };
  const rows = await supabaseFetch(JOBS_TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{ course_id: courseId, kind: "terrain", status: "queued", recipe, requested_by: requestedBy }])
  });
  return { job: Array.isArray(rows) ? rows[0] : null, existing: false };
}

function sourceReport(counts) {
  return TERRAIN_SOURCES.map(source => {
    const configured = configureSource(source);
    let usable = true, reason = "";
    if (source.enabled === false) { usable = false; reason = "disabled" + (source.disabledReason ? ": " + source.disabledReason : ""); }
    else if (!licenceGrantsStorage(source.licence)) { usable = false; reason = "licence does not grant storage"; }
    else if (!IMPLEMENTED_SOURCE_TYPES.includes(source.sourceType)) { usable = false; reason = "no adapter for " + source.sourceType; }
    else if (configured.error) { usable = false; reason = configured.error; }
    return {
      id: source.id, name: source.name, regions: source.regions, sourceType: source.sourceType,
      resolutionM: source.resolutionM, fallbackResolutionM: source.fallbackResolutionM,
      horizontalCrs: source.horizontalCrs, verticalDatum: source.verticalDatum,
      licence: source.licence && source.licence.name, qualityClass: source.qualityClass,
      priority: source.priority, datasetVersion: source.datasetVersion || null,
      usable, reason, coursesUsing: counts[source.id] || 0
    };
  });
}

/* Baked courses with what the resolver would do for them today. Reads only metadata. */
async function bakedCourses() {
  const rows = await supabaseFetch(TERRAIN_TABLE + "?select=course_id,terrain_version,status,primary_source_id,source_resolution_m,green_detail,resolver_fingerprint,format_version,last_error,generated_at,courseBounds:manifest->courseBounds,frameBounds:manifest->frameBounds,failures:manifest->failures&order=updated_at.desc&limit=2000");
  const list = Array.isArray(rows) ? rows : [];
  const ids = list.map(r => r.course_id);
  const places = {};
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150).map(id => '"' + String(id).replace(/"/g, "") + '"').join(",");
    const p = await supabaseFetch(MAPS_TABLE + "?select=course_id,country_code,country,region&course_id=in.(" + encodeURIComponent(chunk) + ")").catch(() => []);
    (Array.isArray(p) ? p : []).forEach(r => { places[r.course_id] = r; });
  }
  return list.map(row => {
    const place = places[row.course_id] || {};
    const resolution = row.courseBounds ? resolveTerrain({ bounds: row.courseBounds, countryCode: place.country_code, regionName: place.region || place.country || place.country_code }) : null;
    const manifest = row.status === "ready" ? {
      formatVersion: row.format_version, sources: row.primary_source_id ? [{ id: row.primary_source_id, name: row.primary_source_id }] : [],
      resolverFingerprint: row.resolver_fingerprint
    } : null;
    const assessment = resolution && resolution.ok ? assessRebuild(manifest, resolution, { formatVersion: TERRAIN_FORMAT_VERSION }) : null;
    return { row, place, resolution, assessment };
  });
}

async function upgradesReport(limit) {
  const all = await bakedCourses();
  const courses = [];
  const regions = {};
  for (const { row, place, resolution, assessment } of all) {
    if (!resolution || !resolution.ok) continue;
    const onGlobal = resolution.strategy === "global-only";
    if (onGlobal) {
      const key = resolution.upgrade.region || "unknown";
      regions[key] = regions[key] || { region: key, courses: 0, regionalConfigured: resolution.upgrade.regionalConfigured, reason: resolution.upgrade.reason };
      regions[key].courses++;
    }
    if (assessment && assessment.rebuild) {
      courses.push({
        courseId: row.course_id, region: place.region || place.country || place.country_code || null,
        current: row.primary_source_id, best: resolution.primarySource.id, reason: assessment.reason,
        upgradeAvailable: !!assessment.upgradeAvailable, sourceUpdated: !!assessment.sourceUpdated,
        terrainVersion: row.terrain_version, lastError: row.last_error || null
      });
    }
  }
  return {
    upgradeable: courses.slice(0, limit), upgradeableTotal: courses.length,
    globalOnlyRegions: Object.values(regions).sort((a, b) => b.courses - a.courses)
  };
}

export async function rebuildForSource(sourceId, { dryRun, requestedBy, now = Date.now() } = {}) {
  const source = sourceById(sourceId);
  if (!source) return { error: "unknown terrain source " + sourceId, status: 404 };
  const all = await bakedCourses();
  /* Baked courses for which this source is now the resolver's pick and the asset is not
     already from it at the current version... */
  const candidates = all.filter(({ row, resolution, assessment }) =>
    resolution && resolution.ok && resolution.primarySource.id === sourceId && assessment && assessment.rebuild)
    .map(({ row }) => row.course_id);
  /* ...plus published courses never baked at all whose centre the source covers (the terrain
     job resolves them properly from their geometry). */
  const baked = new Set(all.map(({ row }) => row.course_id));
  const published = await supabaseFetch(MAPS_TABLE + "?select=course_id,course_lat,course_lng&published=eq.true&limit=5000").catch(() => []);
  const e = 1e-5;
  (Array.isArray(published) ? published : []).forEach(c => {
    const lat = Number(c.course_lat), lng = Number(c.course_lng);
    if (baked.has(c.course_id) || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (declaredCoverage(source, { north: lat + e, south: lat - e, west: lng - e, east: lng + e }) !== "none") candidates.push(c.course_id);
  });
  const batch = candidates.slice(0, TERRAIN_CONFIG.maxBatchEnqueue);
  if (dryRun) return { sourceId, candidates: candidates.length, batch, enqueued: [] };
  const enqueued = [];
  for (const courseId of batch) {
    const { job, existing } = await enqueueTerrainJob(courseId, requestedBy, { force: false, reason: "source:" + sourceId, requestedAt: new Date(now).toISOString() });
    if (job && !existing) enqueued.push({ courseId, jobId: job.id });
  }
  return { sourceId, candidates: candidates.length, enqueued, remaining: Math.max(0, candidates.length - batch.length) };
}

export default async function courseTerrain(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  const admin = await verifiedAdminEmail(req);
  if (!admin) return json(403, { error: "Admin verification failed" });

  if (req.method === "GET") {
    const params = new URL(req.url).searchParams;
    const report = String(params.get("report") || "");
    if (report === "sources") {
      const rows = await supabaseFetch(TERRAIN_TABLE + "?select=primary_source_id&status=eq.ready&limit=5000").catch(() => []);
      const counts = {};
      (Array.isArray(rows) ? rows : []).forEach(r => { if (r.primary_source_id) counts[r.primary_source_id] = (counts[r.primary_source_id] || 0) + 1; });
      return json(200, { sources: sourceReport(counts), config: TERRAIN_CONFIG });
    }
    if (report === "upgrades") {
      const limit = Math.max(1, Math.min(500, Number(params.get("limit")) || 100));
      return json(200, await upgradesReport(limit));
    }
    const courseId = String(params.get("courseId") || "").trim();
    if (!courseId) return json(400, { error: "courseId or report is required" });
    const course = await loadCourse(courseId);
    if (!course) return json(404, { error: "No published course " + courseId });
    if (!course.bounds) return json(422, { error: "Course has no play-ready geometry to bound its terrain" });
    const status = await terrainStatus({ courseId, courseBounds: course.bounds, countryCode: course.countryCode, regionName: course.regionName }, { supabaseFetch });
    const jobs = await supabaseFetch(JOBS_TABLE + "?select=id,status,error,result,recipe,requested_by,created_at,updated_at&course_id=eq." + encodeURIComponent(courseId) + "&kind=eq.terrain&order=created_at.desc&limit=5").catch(() => []);
    return json(200, Object.assign(status, { courseName: course.pkg.courseName, region: course.regionName, jobs: Array.isArray(jobs) ? jobs : [] }));
  }

  if (req.method === "POST") {
    let payload = {};
    try { payload = await req.json(); } catch (e) { payload = {}; }
    const action = String(payload.action || "rebuild");
    if (action === "rebuild-source") {
      const result = await rebuildForSource(String(payload.sourceId || ""), { dryRun: payload.dryRun === true, requestedBy: admin });
      if (result.error) return json(result.status || 400, { error: result.error });
      if (result.enqueued && result.enqueued.length) await pingWorker(req, result.enqueued[0].jobId);
      return json(202, result);
    }
    if (action !== "rebuild") return json(400, { error: "unknown action " + action });
    const courseId = String(payload.courseId || "").trim();
    if (!courseId) return json(400, { error: "courseId is required" });
    const course = await loadCourse(courseId);
    if (!course) return json(404, { error: "No published course " + courseId });
    const { job, existing } = await enqueueTerrainJob(courseId, admin, { force: payload.force === true, reason: "admin" });
    if (!job) return json(500, { error: "could not queue the terrain job" });
    if (!existing) await pingWorker(req, job.id);
    return json(202, { job, existing });
  }

  return json(405, { error: "Method not allowed" });
}

export const config = {
  path: "/api/course-terrain"
};
