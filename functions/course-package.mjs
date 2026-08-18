/* Unified course-package endpoint: the ONE logical request the app makes for course
   readiness, per the course-package architecture doc. Composes course_maps (geometry),
   course_visuals (published imagery), course_visual_jobs and course_mapper_jobs (build
   state) into a single response shaped as Full Map Package / Lite Geometry Pack /
   Processing / Manual Action Required / None.

   Deliberately reads all four tables directly with Promise.all rather than calling
   course-maps.mjs/course-visuals.mjs/course-visual-jobs.mjs/course-mapper-jobs.mjs over
   HTTP: this codebase's Netlify Functions are already flat and self-contained (each with its
   own supabaseFetch helper), course-visual-jobs.mjs's own courseBuildState() already reads
   two tables directly in one function, and there is no other caller that would benefit from
   these four reads staying behind separate HTTP boundaries - only latency and an
   architectural pattern nothing else in the codebase uses would be gained by orchestrating
   over HTTP instead.

   On a "none" state this endpoint DOES trigger AutoMapper (stage 5 of the migration plan) -
   the doc's "if geometry missing, server runs AutoMapper and saves geometry" - but only for
   an authenticated caller that supplies courseLat/courseLng (an anonymous or location-less
   request still gets a truthful "none" back, matching course-visual-jobs.mjs's own pattern of
   requiring a verified identity before any write). Before enqueueing, it checks for a nearby
   already-mapped course under a different id/name (courseIdentity/nearbyKnownCourses from
   gd-automapper-core.mjs) - the server-side duplicate-course-matching responsibility the
   architecture doc assigns here, so two players' slightly different names/ids for the same
   course don't each get their own mapper job and their own copy of the same geometry. */

import { deriveCoursePackageState, shapeLitePackage, shapeFullPackage, hasGeometryPayload } from "./lib/gd-course-package-shape.mjs";
import { nearbyKnownCourses, classifyCourseRelationship } from "./lib/gd-automapper-core.mjs";
import { enqueueMapperJob } from "./course-mapper-jobs.mjs";

const MAPS_TABLE = "course_maps";
const VISUALS_TABLE = "course_visuals";
const VISUAL_JOBS_TABLE = "course_visual_jobs";
const MAPPER_JOBS_TABLE = "course_mapper_jobs";
const ASSUMED_COURSE_MATCH_RADIUS_M = 4000; // same radius the client AutoMapper uses (gd-course-library-pin-lock.js:33)

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function anonKey() { return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || ""; }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }

async function supabaseFetch(path) {
  const response = await fetch(supabaseBase() + "/rest/v1/" + path, {
    headers: { apikey: supabaseKey(), Authorization: "Bearer " + supabaseKey(), "Content-Type": "application/json" }
  });
  const textBody = await response.text();
  let body = null;
  try { body = textBody ? JSON.parse(textBody) : null; } catch (e) { body = textBody; }
  if (!response.ok) throw new Error("Supabase " + response.status + ": " + (typeof body === "string" ? body : JSON.stringify(body)));
  return body;
}

/* Verifies the caller's Supabase session, same pattern as course-visual-jobs.mjs and
   course-mapper-jobs.mjs - read is public, but only a real signed-in identity may trigger a
   write (a mapper job) as a side effect of what is otherwise a read endpoint. */
async function verifiedUserId(req) {
  const header = String((req && req.headers && typeof req.headers.get === "function" && req.headers.get("authorization")) || "");
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const base = supabaseBase();
  const key = anonKey() || supabaseKey();
  if (!base || !key) return null;
  try {
    const response = await fetch(base + "/auth/v1/user", { method: "GET", headers: { apikey: key, Authorization: "Bearer " + token } });
    if (!response.ok) return null;
    const user = await response.json();
    return user && user.id ? String(user.id) : null;
  } catch (error) {
    return null;
  }
}

function slug(value) { return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90); }

/* A generous bounding box narrows the candidate set before the exact-distance check in
   nearbyKnownCourses - avoids a full-table scan while staying wide enough that
   ASSUMED_COURSE_MATCH_RADIUS_M (4000m, roughly 0.036 degrees of latitude) is never clipped. */
async function findDuplicateCourseWithGeometry(courseId, courseName, center) {
  const pad = 0.06;
  const rows = await supabaseFetch(
    MAPS_TABLE + "?select=course_id,course_name,course_lat,course_lng,objects_json,holes_json&published=eq.true" +
    "&course_lat=gte." + (center.lat - pad) + "&course_lat=lte." + (center.lat + pad) +
    "&course_lng=gte." + (center.lng - pad) + "&course_lng=lte." + (center.lng + pad) + "&limit=50"
  ).catch(() => []);
  const candidates = (Array.isArray(rows) ? rows : [])
    .filter(row => row.course_id !== courseId && hasGeometryPayload(row))
    .map(row => ({ courseId: row.course_id, courseName: row.course_name, courseLat: row.course_lat, courseLng: row.course_lng }));
  const nearby = nearbyKnownCourses(center, candidates, ASSUMED_COURSE_MATCH_RADIUS_M);
  /* Proximity alone is NOT duplication. Every course at a 36-hole facility sits within
     ASSUMED_COURSE_MATCH_RADIUS_M of its siblings, so taking the nearest mapped course meant
     the second course at a facility was permanently shadowed by the first: it was handed the
     sibling's geometry and never enqueued a job of its own. Only redirect when the candidate
     is genuinely the same course under a different id/name.

     The courseId fallback matters for callers that send a location but no display name - ids
     here are slugs of the name ("taupo-golf-club-centennial"), so un-slugging the hyphens
     recovers enough for the facility/label split to work. */
  const request = { courseId, courseName: courseName || String(courseId || "").replace(/-+/g, " ") };
  return nearby.find(candidate => classifyCourseRelationship(request, candidate) === "duplicate") || null;
}

async function loadCoursePackageRows(courseId) {
  const [mapRows, visualRows, visualJobRows, mapperJobRows] = await Promise.all([
    supabaseFetch(MAPS_TABLE + "?select=course_id,course_name,published,geometry_version,published_at,updated_at,objects_json,holes_json&course_id=eq." + encodeURIComponent(courseId) + "&published=eq.true&limit=1").catch(() => []),
    supabaseFetch(VISUALS_TABLE + "?select=published_version,current_version,status,diagnostics,uploaded_assets,updated_at&course_id=eq." + encodeURIComponent(courseId) + "&limit=1").catch(() => []),
    supabaseFetch(VISUAL_JOBS_TABLE + "?select=id,kind,status,created_at,updated_at&course_id=eq." + encodeURIComponent(courseId) + "&order=created_at.desc&limit=5").catch(() => []),
    supabaseFetch(MAPPER_JOBS_TABLE + "?select=id,kind,status,error,created_at,updated_at&course_id=eq." + encodeURIComponent(courseId) + "&order=created_at.desc&limit=5").catch(() => [])
  ]);
  return {
    map: Array.isArray(mapRows) ? mapRows[0] || null : null,
    visual: Array.isArray(visualRows) ? visualRows[0] || null : null,
    visualJobs: Array.isArray(visualJobRows) ? visualJobRows : [],
    mapperJobs: Array.isArray(mapperJobRows) ? mapperJobRows : []
  };
}

export async function buildCoursePackage(courseId) {
  const rows = await loadCoursePackageRows(courseId);
  const state = deriveCoursePackageState(rows);
  if (state === "full-map-ready") return shapeFullPackage(rows.map, rows.visual);
  if (state === "lite-geo-ready") {
    const liveVisualJob = rows.visualJobs.find(j => j.status === "running" || j.status === "queued");
    return shapeLitePackage(rows.map, liveVisualJob ? liveVisualJob.status : "none");
  }
  if (state === "manual-required") {
    const lastMapperJob = rows.mapperJobs[0] || null;
    return { courseId, status: "manual-required", reason: (lastMapperJob && lastMapperJob.error) || "manual correction required" };
  }
  /* Terminal like manual-required, and for the same reason: the server has already tried and
     said why it could not. Answering "none" here instead made buildCoursePackageWithTrigger
     re-enqueue the identical doomed job on every poll (see deriveCoursePackageState). The
     error travels in `reason` so the client's debug report can show the actual failure
     instead of nothing. */
  if (state === "failed") {
    const lastMapperJob = rows.mapperJobs[0] || null;
    return { courseId, status: "failed", reason: (lastMapperJob && lastMapperJob.error) || "mapping run failed" };
  }
  if (state === "processing") {
    const live = rows.mapperJobs.find(j => j.status === "running" || j.status === "queued") || rows.visualJobs.find(j => j.status === "running" || j.status === "queued");
    return { courseId, status: "processing", stage: live ? live.kind : null };
  }
  return { courseId, status: "none" };
}

/* Wraps buildCoursePackage with the one write this read endpoint may trigger: on "none",
   check for a nearby already-mapped duplicate first (never start a second mapper job for a
   course that already exists under a different id/name), then - only for a verified caller
   who supplied a location - enqueue a mapping run and answer "processing" immediately rather
   than blocking this request on it (same fire-and-poll shape as course-visual-jobs.mjs's auto
   path). Left as a separate function from buildCoursePackage so tests can exercise the pure
   read path without needing to stub identity/enqueue plumbing. */
export async function buildCoursePackageWithTrigger(courseId, { center, courseName, userId, origin } = {}) {
  const result = await buildCoursePackage(courseId);
  if (result.status !== "none") return result;
  if (center) {
    const duplicate = await findDuplicateCourseWithGeometry(courseId, courseName, center);
    if (duplicate) {
      const canonical = await buildCoursePackage(duplicate.courseId);
      return Object.assign({}, canonical, { redirectedFrom: courseId });
    }
  }
  if (!userId || !center) return result;
  const enqueued = await enqueueMapperJob({ courseId, courseLat: center.lat, courseLng: center.lng, courseName, userId, origin });
  if (enqueued.rateLimited) return Object.assign({}, result, { triggerError: "rate-limited" });
  return { courseId, status: "processing", stage: "automap" };
}

export default async function coursePackage(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "GET") return json(405, { error: "Method not allowed" });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  const url = new URL(req.url);
  const courseId = slug(url.searchParams.get("courseId") || url.searchParams.get("course_id"));
  if (!courseId) return json(400, { error: "courseId required" });
  const lat = Number(url.searchParams.get("courseLat"));
  const lng = Number(url.searchParams.get("courseLng"));
  const center = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  const courseName = url.searchParams.get("courseName") || "";
  const userId = await verifiedUserId(req);
  const result = await buildCoursePackageWithTrigger(courseId, { center, courseName, userId, origin: url.origin });
  return json(200, result);
}

export const config = {
  path: "/api/course-package",
};

function json(status, body) {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      /* Every branch of this response reflects live build state (processing/queued jobs,
         freshly published packages) - caching it would mean a client polling while
         "processing" could get served a stale "none" or an old package version. */
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept"
    }
  });
}
