/* Server-side AutoMapper worker (Netlify background function). Structural sibling of
   course-visual-worker-background.mjs's claim/finish pattern.

   Claims a queued course_mapper_jobs row, reads the course's center point from course_maps,
   queries Overpass for OSM golf-course geometry around it, resolves hole guides into
   tee/green/fairway objects (functions/lib/gd-automapper-core.mjs - a from-scratch port of
   the client AutoMapper's pure geometry pipeline), and writes the result into
   course_maps.objects_json/holes_json/geometry_version.

   When OSM exposes shapes but no hole NUMBERS (hasNumberingIssue), falls through to the
   Native Geometry Resolver (functions/lib/gd-geometry-resolver-core.mjs) - a separate
   algorithm that infers numbering from geometry + scorecard evidence. This mirrors the
   client's old two-stage mapping (AutoMapper, then the native resolver as its own fallback)
   entirely server-side, so nothing client-side needs to run either stage anymore. */

import { fetchOverpass } from "./lib/gd-overpass-client.mjs";
import { osmQueryScope, osmGuideQuery, resolveCourseGeometry, resolveGuidesIntoObjects, classifyCourseRelationship, courseFootprintFrame, osmCourseHoleCountTag, scopeContainsFrame, osmScopeFrame, expandOsmFrame, MAPPER_VERSION } from "./lib/gd-automapper-core.mjs";
import { hasNumberingIssue, resolveCourseGeometryForAutoMapper, guideFromResolvedHole } from "./lib/gd-geometry-resolver-core.mjs";
import { courseBoundsFor } from "./lib/gd-visual-plan-core.mjs";
import { resolveImagerySource, unscannableReason } from "./lib/gd-imagery-sources.mjs";

const JOBS_TABLE = "course_mapper_jobs";
const MAPS_TABLE = "course_maps";
const SCORECARDS_TABLE = "course_scorecards";
const VISUAL_JOBS_TABLE = "course_visual_jobs";

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }

async function supabaseFetch(path, options = {}) {
  const headers = Object.assign({
    apikey: supabaseKey(),
    Authorization: "Bearer " + supabaseKey(),
    "Content-Type": "application/json"
  }, options.headers || {});
  const response = await fetch(supabaseBase() + "/rest/v1/" + path, Object.assign({}, options, { headers }));
  const textBody = await response.text();
  let body = null;
  try { body = textBody ? JSON.parse(textBody) : null; } catch (e) { body = textBody; }
  if (!response.ok) throw new Error("Supabase " + response.status + ": " + (typeof body === "string" ? body : JSON.stringify(body)));
  return body;
}

/* status=eq.queued in the filter makes the claim atomic - two workers racing the same row
   can't both flip it to running. Identical pattern to course-visual-worker-background.mjs's
   claimJob(). */
async function claimJob(jobId) {
  const filter = jobId ? "id=eq." + encodeURIComponent(jobId) + "&" : "";
  const rows = await supabaseFetch(JOBS_TABLE + "?" + filter + "status=eq.queued&order=created_at.asc&limit=1", { method: "GET" });
  const job = Array.isArray(rows) ? rows[0] : null;
  if (!job) return null;
  const claimed = await supabaseFetch(JOBS_TABLE + "?id=eq." + job.id + "&status=eq.queued", {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "running", updated_at: new Date().toISOString() })
  });
  return Array.isArray(claimed) && claimed.length ? claimed[0] : null;
}

async function finishJob(id, patch) {
  await supabaseFetch(JOBS_TABLE + "?id=eq." + id, {
    method: "PATCH",
    body: JSON.stringify(Object.assign({ updated_at: new Date().toISOString() }, patch))
  });
}

async function heartbeatJob(job, progress) {
  await supabaseFetch(JOBS_TABLE + "?id=eq." + job.id, {
    method: "PATCH",
    body: JSON.stringify({ updated_at: new Date().toISOString(), result: { progress, attempts: job.result && Number(job.result.attempts) || 0 } })
  }).catch(() => {});
}

/* Jobs stuck "running" belong to a worker that died mid-run. Same reasoning and cutoff as
   course-visual-worker-background.mjs's reapStaleJobs, sized to this job's much shorter
   expected runtime (one Overpass fetch + per-hole resolution, not a multi-minute tile
   snapshot). */
async function reapStaleJobs() {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  try {
    const stale = await supabaseFetch(JOBS_TABLE + "?select=id,result&status=eq.running&updated_at=lt." + encodeURIComponent(cutoff));
    for (const row of Array.isArray(stale) ? stale : []) {
      const attempts = (row.result && Number(row.result.attempts) || 0) + 1;
      const patch = attempts >= 8
        ? { status: "failed", error: "stale-running-reaped: worker died mid-job " + attempts + " times", updated_at: new Date().toISOString() }
        : { status: "queued", error: null, result: Object.assign({}, row.result || {}, { attempts }), updated_at: new Date().toISOString() };
      await supabaseFetch(JOBS_TABLE + "?id=eq." + row.id, { method: "PATCH", body: JSON.stringify(patch) });
    }
  } catch (e) { /* reaping is best-effort */ }
}

async function loadCourseCenter(courseId) {
  const rows = await supabaseFetch(MAPS_TABLE + "?select=course_id,course_name,course_lat,course_lng,objects_json,holes_json&course_id=eq." + encodeURIComponent(courseId) + "&limit=1");
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  const lat = Number(row.course_lat), lng = Number(row.course_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { courseId: row.course_id, courseName: row.course_name, center: { lat, lng }, objects: row.objects_json || {}, holes: row.holes_json || {} };
}

/* The Overpass sweep around a course centre also covers any sibling course at the same
   facility, and both come back with holes numbered 1-18. Handing those sibling centres to
   resolveCourseGeometry lets it drop guides that belong to the neighbour instead of letting
   them compete for the same hole slots. Sibling rows do NOT need geometry of their own - an
   unmapped sibling still has a centre, and that is all the partition needs.

   Bounding box first to keep this off a full-table scan, same shape as
   course-package.mjs's findDuplicateCourseWithGeometry. */
const SIBLING_SEARCH_PAD_DEG = 0.06;

async function loadSiblingCentres(course) {
  const { center } = course;
  const rows = await supabaseFetch(
    MAPS_TABLE + "?select=course_id,course_name,course_lat,course_lng" +
    "&course_lat=gte." + (center.lat - SIBLING_SEARCH_PAD_DEG) + "&course_lat=lte." + (center.lat + SIBLING_SEARCH_PAD_DEG) +
    "&course_lng=gte." + (center.lng - SIBLING_SEARCH_PAD_DEG) + "&course_lng=lte." + (center.lng + SIBLING_SEARCH_PAD_DEG) + "&limit=50"
  ).catch(() => []);
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row.course_id !== course.courseId)
    .filter(row => classifyCourseRelationship(course, { courseId: row.course_id, courseName: row.course_name }) === "sibling")
    .map(row => ({ lat: Number(row.course_lat), lng: Number(row.course_lng) }))
    .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

async function saveResolvedGeometry(courseId, geometry) {
  const holeCount = Object.keys(geometry.holes || {}).length || null;
  const written = await supabaseFetch(MAPS_TABLE + "?course_id=eq." + encodeURIComponent(courseId), {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      objects_json: geometry.objects,
      holes_json: geometry.holes,
      geometry_version: MAPPER_VERSION,
      /* Denormalised for /api/course-library, which reports hole counts from this column
         rather than reading holes_json. course-maps.mjs writes it on every Studio publish;
         the mapper did not, so a course that had only ever been auto-mapped reported zero
         holes there while Studio - which derives from holes_json - showed eighteen. */
      hole_count: holeCount,
      updated_at: new Date().toISOString()
    })
  });
  /* The PATCH filters on course_id and does not upsert, so with no row it writes nothing and
     still returns 200. Saying "saved" then would be a lie the job result carries forever. */
  if (!Array.isArray(written) || !written.length) {
    throw new Error("course " + courseId + " has no course_maps row to save geometry into");
  }
  return holeCount;
}

/* course_scorecards.course_key is the course's DISPLAY NAME, lowercased and whitespace-
   collapsed - NOT the dash-slugged course_id every other table uses. This has to match
   gdScorecardCourseKey() (scripts/inline/gd-gps-scorecard-owner-v1.js:49) exactly or every
   lookup here misses a scorecard that is sitting right there under a different-looking key. */
function scorecardCourseKey(courseName) {
  return String(courseName || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/* Read-only: this worker never scrapes a club website itself (that parsing lives client-side
   and needs a DOM parser this runtime doesn't have) - it only reads what someone has already
   shared to course_scorecards. No shared scorecard yet means the geometry resolver runs
   without one and correctly reports geometry-resolved-numbering-unavailable rather than
   guessing hole numbers. */
async function fetchScorecardEvidence(courseName) {
  const key = scorecardCourseKey(courseName);
  if (!key) return null;
  try {
    const rows = await supabaseFetch(SCORECARDS_TABLE + "?select=holes_json,source,source_url,sources_json&course_key=eq." + encodeURIComponent(key) + "&limit=1");
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || !Array.isArray(row.holes_json) || !row.holes_json.length) return null;
    return { holes: row.holes_json, source: row.source || "", sourceUrl: row.source_url || "", sources: Array.isArray(row.sources_json) ? row.sources_json : [] };
  } catch (e) {
    return null;
  }
}

/* How many holes the shared scorecard actually lists - distinct valid hole numbers, since a
   card row per tee-set would otherwise double-count. */
function scorecardHoleCount(evidence) {
  if (!evidence || !Array.isArray(evidence.holes)) return null;
  const seen = new Set();
  evidence.holes.forEach(row => {
    const n = Number(row && (row.holeNumber ?? row.hole ?? row.number));
    if (Number.isFinite(n) && n >= 1 && n <= 45) seen.add(Math.round(n));
  });
  return seen.size || null;
}

/* fetch OSM golf geometry -> resolve into tee/green/fairway objects -> persist.

   Query area, in order of preference: the course's own footprint bbox when it spills outside
   the default 1400m circle (long thin courses - Omaha Beach lost holes 7-9 to the circle),
   otherwise the circle as before. After resolution the hole count is checked against the best
   available expectation (shared scorecard, else the OSM course polygon's holes=N tag): coming
   up short triggers one retry on a wider frame, and if STILL short, the Native Geometry
   Resolver runs with OSM hole numbers ignored - numbering worked out from geometry +
   scorecard instead - and its answer is used when it covers more holes. A scan that remains
   short saves what it has but carries a loud warning on the job result instead of silently
   publishing a partial course. The resolver also still runs in its original case: OSM has
   shapes but no hole numbers at all. */
const WIDER_RETRY_PAD_M = 700;

async function runMapperJob(job) {
  const course = await loadCourseCenter(job.course_id);
  if (!course) throw new Error("course " + job.course_id + " has no known location in " + MAPS_TABLE + " - cannot query Overpass");
  await heartbeatJob(job, { stage: "querying-overpass" });
  let scope = osmQueryScope({}, course.center);
  let payload = await fetchOverpass(osmGuideQuery(scope));
  const queryStages = ["around:" + scope.radiusM];
  const footprint = courseFootprintFrame(payload);
  if (footprint && !scopeContainsFrame(scope, footprint)) {
    scope = osmQueryScope({ osmFrame: footprint }, course.center);
    payload = await fetchOverpass(osmGuideQuery(scope));
    queryStages.push("footprint-bbox");
  }
  await heartbeatJob(job, { stage: "resolving-geometry" });
  const existingObjects = Object.values(course.objects || {}).filter(Boolean);
  const siblingCentres = await loadSiblingCentres(course).catch(() => []);
  let geometry = resolveCourseGeometry(payload, course.courseId, course.center, existingObjects, siblingCentres);

  const scorecardEvidence = await fetchScorecardEvidence(course.courseName);
  const expectedHoles = scorecardHoleCount(scorecardEvidence) || osmCourseHoleCountTag(payload) || null;
  const warnings = [];

  if (expectedHoles && geometry.holesResolved < expectedHoles) {
    await heartbeatJob(job, { stage: "retry-wider-frame" });
    const widerFrame = expandOsmFrame(osmScopeFrame(scope, course.center), WIDER_RETRY_PAD_M);
    if (widerFrame) {
      const widerPayload = await fetchOverpass(osmGuideQuery(osmQueryScope({ osmFrame: widerFrame }, course.center)));
      const widerGeometry = resolveCourseGeometry(widerPayload, course.courseId, course.center, existingObjects, siblingCentres);
      if (widerGeometry.holesResolved > geometry.holesResolved) {
        geometry = widerGeometry;
        payload = widerPayload;
        queryStages.push("wider-retry");
      }
    }
  }

  let resolverStatus = null;
  const numberingIssue = !geometry.holesResolved && hasNumberingIssue({ osmPayload: payload });
  const shortOfExpected = !!(expectedHoles && geometry.holesResolved < expectedHoles);
  if (numberingIssue || shortOfExpected) {
    await heartbeatJob(job, { stage: "geometry-resolver" });
    const result = await resolveCourseGeometryForAutoMapper({
      osmPayload: payload,
      courseId: course.courseId,
      course: { courseId: course.courseId, courseName: course.courseName, courseCentre: course.center },
      courseCentre: course.center,
      expectedHoleCount: expectedHoles || undefined,
      scorecardHoles: scorecardEvidence ? scorecardEvidence.holes : [],
      scorecardEvidence: scorecardEvidence || {}
    });
    resolverStatus = { status: result.status, confidence: result.confidence, warnings: result.warnings, hadScorecard: !!scorecardEvidence, trigger: numberingIssue ? "no-osm-numbering" : "short-of-expected" };
    const guides = (result.holes || []).map(hole => guideFromResolvedHole(hole, result)).filter(Boolean);
    /* The resolver's numbering (scorecard-derived, OSM refs ignored) only replaces the
       OSM-numbered answer when it genuinely covers MORE holes - a lower-coverage resolver run
       must not clobber good numbered geometry. In the no-numbering case anything it found is
       strictly better than the nothing OSM numbering produced. */
    if (guides.length > geometry.holesResolved) {
      const resolverGreens = (result.debugEvidence && result.debugEvidence.greenCandidates || []).map(green => ({ center: green.centre, shape: green.polygon }));
      const base = numberingIssue ? Object.values(geometry.objects) : existingObjects;
      const merged = resolveGuidesIntoObjects(guides, course.courseId, resolverGreens, base);
      geometry = Object.assign({}, geometry, merged, { holesResolved: guides.length });
    }
  }
  if (!geometry.holesResolved) {
    const reason = resolverStatus ? "geometry resolver status: " + resolverStatus.status + (resolverStatus.hadScorecard ? "" : " (no shared scorecard found)") : "no OSM hole geometry within range";
    throw new Error("no numbered hole geometry found for " + course.courseId + " (" + reason + ")");
  }
  if (expectedHoles && geometry.holesResolved < expectedHoles) {
    warnings.push("expected " + expectedHoles + " holes (" + (scorecardHoleCount(scorecardEvidence) ? "shared scorecard" : "OSM holes tag") + ") but resolved " + geometry.holesResolved + " - published incomplete after wider retry" + (resolverStatus ? " and geometry resolver" : ""));
  }
  await saveResolvedGeometry(course.courseId, geometry);
  return {
    courseId: course.courseId,
    mapperVersion: MAPPER_VERSION,
    guidesFound: geometry.guidesFound,
    greensFound: geometry.greensFound,
    holesResolved: geometry.holesResolved,
    saved: geometry.saved,
    polygons: geometry.polygons,
    fallbacks: geometry.fallbacks,
    queryStages,
    expectedHoles,
    warnings: warnings.length ? warnings : undefined,
    resolverStatus,
    /* Same bounds the visual planner would compute for this geometry - carried on the result
       so chainVisualSnapshot below can run the licensing check without re-reading the row it
       just wrote, and so a job's record shows what ground the mapper actually covered. */
    courseBounds: courseBoundsFor({ courseId: course.courseId, objects: geometry.objects, holes: geometry.holes })
  };
}

/* The missing link in the hands-off chain: a successful mapping run used to end right here,
   so a brand-new course got geometry but no frames until a player happened to REOPEN it -
   the app's own kind:"auto" visual request had already been refused ("no published
   geometry") while mapping was still running, and it does not retry. Enqueue the snapshot
   the moment geometry lands; the visual worker auto-chains the export, which completes
   select course -> automap -> snapshot -> export -> frames with nobody in Studio.

   Same shape as the two existing auto-enqueue hooks (course-maps.mjs publish -> snapshot,
   visual worker snapshot -> export): deduped against a live snapshot, and warn-only - the
   mapping job it rides on has already succeeded and must never be failed by queue trouble.

   Licensing is checked first only to avoid queueing a job whose one possible outcome is
   "imagery-source-unavailable" (the visual worker stays the real gate) - an unlicensed-region
   course keeps its geometry and plays live tiles, exactly as before. No confidence gate
   beyond the ones that already exist: the mapper fails outright without numbered holes, and
   the visual planner only shoots play-ready holes and refuses an empty plan. */
async function chainVisualSnapshot(courseId, courseBounds, origin) {
  const source = resolveImagerySource(courseBounds);
  if (!source) return { chained: false, reason: "imagery-source-unavailable: " + unscannableReason(courseBounds) };
  const existing = await supabaseFetch(VISUAL_JOBS_TABLE + "?select=id&course_id=eq." + encodeURIComponent(courseId) + "&kind=eq.snapshot&status=in.(queued,running)&limit=1");
  if (Array.isArray(existing) && existing.length) return { chained: false, reason: "snapshot-already-live" };
  await supabaseFetch(VISUAL_JOBS_TABLE, {
    method: "POST",
    body: JSON.stringify([{ course_id: courseId, kind: "snapshot", status: "queued", requested_by: "auto-after-automap" }])
  });
  /* Wake the visual worker now rather than waiting for its 10-minute sweeper. Awaited with a
     swallow, same reasoning as course-visual-jobs.mjs's pingWorker: a lost ping only means
     the queued job waits for the sweep. */
  if (origin) {
    await fetch(origin + "/.netlify/functions/course-visual-worker-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    }).catch(() => {});
  }
  return { chained: true };
}

export default async function courseMapperWorker(req) {
  if (!supabaseBase() || !supabaseKey()) return new Response("supabase not configured", { status: 503 });
  let payload = {};
  try { payload = await req.json(); } catch (e) { payload = {}; }
  let origin = "";
  try { origin = new URL(req.url).origin; } catch (e) { origin = ""; }
  await reapStaleJobs();
  let job = await claimJob(payload && payload.jobId || null);
  while (job) {
    try {
      const result = await runMapperJob(job);
      /* Chained BEFORE finishJob so the outcome rides on the job's own result row - a course
         whose frames never appeared should say why in the same place everything else about
         the run is recorded. The catch keeps the contract above: geometry saved means the
         job is "done", whatever the visual queue thought of it. */
      result.visualChain = await chainVisualSnapshot(job.course_id, result.courseBounds, origin)
        .catch(error => ({ chained: false, reason: String(error && error.message || error).slice(0, 300) }));
      await finishJob(job.id, { status: "done", result, error: null });
    } catch (error) {
      console.error("course-mapper-worker job failed", job.id, error);
      await finishJob(job.id, { status: "failed", error: String(error && error.message || error).slice(0, 900) }).catch(() => {});
    }
    job = await claimJob(null);
  }
  return new Response("ok", { status: 200 });
}

export const __courseMapperWorkerTest = { claimJob, finishJob, heartbeatJob, reapStaleJobs, runMapperJob, chainVisualSnapshot };
