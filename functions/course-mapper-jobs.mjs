/* Server-side AutoMapper job queue API. Structural sibling of course-visual-jobs.mjs, kept as
   a SEPARATE table/endpoint rather than a third `kind` on course_visual_jobs: geometry
   resolution (this) and image rendering (course-visual-jobs.mjs) are different
   responsibilities with different failure modes, and folding them together would couple two
   pipelines' status/dedupe/rate-limit rules for no benefit.

   POST {courseId, kind:"automap"} (ANY signed-in player) -> enqueues a mapping run and pings
   the background worker. This is the app's only way to start a mapping run - there is no
   admin-authored recipe path here the way there is for visual jobs, because AutoMapper takes
   no authoring input.
   POST {courseId, kind:"nudge"} (admin only) -> requeues a stalled run.
   GET ?courseId=... -> recent jobs plus a derived mapping state for that course, readable by
   players so the app can poll cheaply while it plays over live tiles + a Lite Geometry Pack.

   The worker itself is functions/course-mapper-worker-background.mjs. */

import { MAPPER_VERSION } from "./lib/gd-automapper-core.mjs";

const TABLE = "course_mapper_jobs";
const MAPS_TABLE = "course_maps";
const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);

/* Mirrors course-visual-jobs.mjs's AUTO_RATE_* - a player tap is cheap for them, and an
   Overpass query plus green-shape analysis is not free for us or for the shared Overpass
   endpoint, so the open POST path is rate limited on top of the one-live-job-per-course
   dedupe. */
const AUTO_RATE_WINDOW_MS = 30 * 60 * 1000;
const AUTO_RATE_MAX_PER_USER = 5;

/* Same reasoning as course-visual-jobs.mjs's STALL_SECONDS: the worker heartbeats between
   OSM fetch, per-hole resolution and green-shape refinement, so silence this long is a dead
   invocation, not a slow one. */
const STALL_SECONDS = 120;

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function anonKey() { return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || ""; }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }

async function verifiedUser(req, payload) {
  const header = String((req && req.headers && typeof req.headers.get === "function" && req.headers.get("authorization")) || "");
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const token = bearer || String(payload && (payload.accessToken || payload.access_token) || "").trim();
  if (!token) return null;
  const base = supabaseBase();
  const key = anonKey() || supabaseKey();
  if (!base || !key) return null;
  try {
    const response = await fetch(base + "/auth/v1/user", { method: "GET", headers: { apikey: key, Authorization: "Bearer " + token } });
    if (!response.ok) return null;
    const user = await response.json();
    if (!user || !user.id) return null;
    const email = String(user.email || "").trim().toLowerCase();
    return { id: String(user.id), email, isAdmin: ADMIN_EMAILS.has(email) };
  } catch (error) {
    return null;
  }
}

async function supabaseFetch(path, options = {}) {
  if (!hasSupabase()) throw new Error("Supabase is not configured");
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

function slug(value) { return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90); }

function hasGeometryPayload(map) {
  if (!map) return false;
  const objects = map.objects_json && typeof map.objects_json === "object" ? map.objects_json : {};
  const holes = map.holes_json && typeof map.holes_json === "object" ? map.holes_json : {};
  return Object.keys(objects).length > 0 || Object.keys(holes).length > 0;
}

/* Derived from what EXISTS over what the job queue last said, same reasoning as
   course-visual-jobs.mjs's courseBuildState: a course with published geometry is playable
   (over the live map, as a Lite Geometry Pack) no matter what the queue says.

     geometry-ready  - course_maps has published geometry; the app can render a Lite pack
     running/queued  - a mapping run is in flight; the app plays live tiles with no overlay yet
     failed          - the last run failed and nothing is in flight
     none            - never mapped; a player selecting this course may start one */
async function mapperBuildState(courseId) {
  const [jobRows, mapRows] = await Promise.all([
    supabaseFetch(TABLE + "?select=id,kind,status,error,result,mapper_version,created_at,updated_at&course_id=eq." + encodeURIComponent(courseId) + "&order=created_at.desc&limit=8").catch(() => []),
    supabaseFetch(MAPS_TABLE + "?select=course_id,published,geometry_version,objects_json,holes_json&course_id=eq." + encodeURIComponent(courseId) + "&published=eq.true&limit=1").catch(() => [])
  ]);
  const jobs = Array.isArray(jobRows) ? jobRows : [];
  const map = Array.isArray(mapRows) ? mapRows[0] : null;
  const live = jobs.find(job => job.status === "running") || jobs.find(job => job.status === "queued");
  const hasGeometry = hasGeometryPayload(map);
  let state;
  if (hasGeometry) state = "geometry-ready";
  else if (live) state = live.status === "running" ? "running" : "queued";
  else if (jobs.length && jobs[0].status === "failed") state = "failed";
  else state = "none";
  const stalledSeconds = live && live.updated_at
    ? Math.max(0, Math.round((Date.now() - new Date(live.updated_at).getTime()) / 1000))
    : null;
  return {
    state,
    hasGeometry,
    geometryVersion: map ? (map.geometry_version || null) : null,
    currentMapperVersion: MAPPER_VERSION,
    building: !!live,
    stalledSeconds,
    stalled: live && live.status === "running" && stalledSeconds != null && stalledSeconds > STALL_SECONDS,
    progress: live && live.result && live.result.progress || null,
    lastError: !live && jobs.length && jobs[0].status === "failed" ? String(jobs[0].error || "").slice(0, 300) : null,
    jobs
  };
}

/* Upserts a minimal course_maps row carrying only identity/location columns, so a course
   with no prior geometry still has somewhere for the worker to read a center point from.
   `on_conflict=id` with a partial body only overwrites the columns present here - existing
   objects_json/holes_json on a course that already has geometry are left untouched. Mirrors
   the "published::"+courseId id convention functions/course-maps.mjs uses, so a row created
   here and a row later published through the normal course-maps flow are the same record. */
async function ensureCourseCenter(courseId, payload) {
  const lat = Number(payload && payload.courseLat);
  const lng = Number(payload && payload.courseLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  try {
    await supabaseFetch(MAPS_TABLE + "?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{
        id: "published::" + courseId,
        course_id: courseId,
        course_name: String(payload.courseName || courseId).slice(0, 200),
        course_lat: lat,
        course_lng: lng,
        published: true
      }])
    });
  } catch (error) {
    console.warn("course-mapper-jobs: ensureCourseCenter failed", courseId, error && error.message || error);
  }
}

/* The core "start a mapping run for this course" logic, factored out so
   functions/course-package.mjs can trigger it directly on a cache miss (stage 5 of the
   migration plan) without an internal HTTP round-trip - same reasoning as
   course-visual-worker-background.mjs writing straight to its jobs table instead of calling
   its own sibling endpoint over HTTP. userId is required (the rate limit and
   requested_by provenance are both keyed to it); callers without a verified user must not
   reach this function. */
export async function enqueueMapperJob({ courseId, courseLat, courseLng, courseName, userId, origin }) {
  await ensureCourseCenter(courseId, { courseLat, courseLng, courseName });

  const state = await mapperBuildState(courseId);
  if (state.hasGeometry && state.geometryVersion === MAPPER_VERSION) {
    return { deduped: true, state: state.state, geometryVersion: state.geometryVersion };
  }
  if (state.building) return { deduped: true, state: state.state };

  const since = new Date(Date.now() - AUTO_RATE_WINDOW_MS).toISOString();
  const recent = await supabaseFetch(TABLE + "?select=id&requested_by=eq." + encodeURIComponent("auto:" + userId) + "&created_at=gt." + encodeURIComponent(since) + "&limit=" + (AUTO_RATE_MAX_PER_USER + 1));
  if (Array.isArray(recent) && recent.length >= AUTO_RATE_MAX_PER_USER) return { rateLimited: true, state: state.state };

  const freshCutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const existing = await supabaseFetch(TABLE + "?select=id,status&course_id=eq." + encodeURIComponent(courseId) + "&kind=eq.automap&status=in.(queued,running)&updated_at=gt." + encodeURIComponent(freshCutoff) + "&limit=1");
  if (Array.isArray(existing) && existing.length) return { deduped: true, job: existing[0], state: "queued" };

  const inserted = await supabaseFetch(TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{ course_id: courseId, kind: "automap", status: "queued", mapper_version: MAPPER_VERSION, requested_by: "auto:" + userId }])
  });
  const job = Array.isArray(inserted) ? inserted[0] : inserted;
  await pingWorkerAt(origin, job && job.id || null);
  return { queued: true, job, state: "queued" };
}

export default async function courseMapperJobs(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url);
    const courseId = slug(url.searchParams.get("courseId") || url.searchParams.get("course_id"));
    if (!courseId) return json(400, { error: "courseId required" });
    return json(200, Object.assign({ courseId }, await mapperBuildState(courseId)));
  }

  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  let payload;
  try { payload = await req.json(); } catch (e) { return json(400, { error: "Invalid JSON" }); }

  const requestedKind = String(payload && payload.kind || "automap");
  const nudge = requestedKind === "nudge";
  const user = await verifiedUser(req, payload);
  if (!user) return json(401, { error: "Sign in required" });
  /* Only "automap" may be enqueued by an ordinary player. "nudge" is an operator action on a
     stuck run, same split as course-visual-jobs.mjs's export/nudge paths. */
  if (nudge && !user.isAdmin) return json(403, { error: "Admin verification failed" });
  const kind = "automap";

  const courseId = slug(payload && (payload.courseId || payload.course_id));
  if (!courseId) return json(400, { error: "courseId required" });

  if (nudge) {
    const state = await mapperBuildState(courseId);
    let requeued = 0;
    if (state.stalled) {
      const cutoff = new Date(Date.now() - STALL_SECONDS * 1000).toISOString();
      const revived = await supabaseFetch(TABLE + "?course_id=eq." + encodeURIComponent(courseId) + "&status=eq.running&updated_at=lt." + encodeURIComponent(cutoff), {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ status: "queued", error: null, updated_at: new Date().toISOString() })
      });
      requeued = Array.isArray(revived) ? revived.length : 0;
    }
    await pingWorkerAt(new URL(req.url).origin);
    return json(200, Object.assign({ nudged: true, requeued }, await mapperBuildState(courseId)));
  }

  const result = await enqueueMapperJob({
    courseId,
    courseLat: payload && payload.courseLat,
    courseLng: payload && payload.courseLng,
    courseName: payload && payload.courseName,
    userId: user.id,
    origin: new URL(req.url).origin
  });
  if (result.rateLimited) return json(429, { error: "too many course mapping runs started recently", state: result.state });
  if (result.deduped) return json(200, Object.assign({ deduped: true }, result));
  return json(202, { job: result.job, state: "queued" });
}

/* AWAITED, not fire-and-forget - see course-visual-jobs.mjs's pingWorker for why: serverless
   freezes the process the moment the handler returns. */
async function pingWorkerAt(origin, jobId) {
  try {
    await fetch(origin + "/.netlify/functions/course-mapper-worker-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: jobId || null })
    }).catch(() => {});
  } catch (e) { /* queued job remains sweepable */ }
}

export const config = {
  path: "/api/course-mapper-jobs",
};

function json(status, body) {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept,Authorization"
    }
  });
}

export const __courseMapperJobsTest = { mapperBuildState, hasGeometryPayload, MAPPER_VERSION };
