/* Server-side AutoMapper worker (Netlify background function). Structural sibling of
   course-visual-worker-background.mjs's claim/finish pattern.

   Claims a queued course_mapper_jobs row, reads the course's center point from course_maps,
   queries Overpass for OSM golf-course geometry around it, resolves hole guides into
   tee/green/fairway objects (functions/lib/gd-automapper-core.mjs - a from-scratch port of
   the client AutoMapper's pure geometry pipeline), and writes the result into
   course_maps.objects_json/holes_json/geometry_version. */

import { fetchOverpass } from "./lib/gd-overpass-client.mjs";
import { osmQueryScope, osmGuideQuery, resolveCourseGeometry, MAPPER_VERSION } from "./lib/gd-automapper-core.mjs";

const JOBS_TABLE = "course_mapper_jobs";
const MAPS_TABLE = "course_maps";

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

async function saveResolvedGeometry(courseId, geometry) {
  await supabaseFetch(MAPS_TABLE + "?course_id=eq." + encodeURIComponent(courseId), {
    method: "PATCH",
    body: JSON.stringify({ objects_json: geometry.objects, holes_json: geometry.holes, geometry_version: MAPPER_VERSION, updated_at: new Date().toISOString() })
  });
}

/* fetch OSM golf geometry -> resolve into tee/green/fairway objects -> persist. Real pipeline
   for stage 3 of the migration plan; replaces the stage 2 stub that only proved claim/
   heartbeat mechanics. */
async function runMapperJob(job) {
  const course = await loadCourseCenter(job.course_id);
  if (!course) throw new Error("course " + job.course_id + " has no known location in " + MAPS_TABLE + " - cannot query Overpass");
  await heartbeatJob(job, { stage: "querying-overpass" });
  const scope = osmQueryScope({}, course.center);
  const query = osmGuideQuery(scope);
  const payload = await fetchOverpass(query);
  await heartbeatJob(job, { stage: "resolving-geometry" });
  const existingObjects = Object.values(course.objects || {}).filter(Boolean);
  const geometry = resolveCourseGeometry(payload, course.courseId, course.center, existingObjects);
  if (!geometry.holesResolved) throw new Error("no OSM hole geometry found within range of " + course.courseId);
  await saveResolvedGeometry(course.courseId, geometry);
  return {
    courseId: course.courseId,
    mapperVersion: MAPPER_VERSION,
    guidesFound: geometry.guidesFound,
    greensFound: geometry.greensFound,
    holesResolved: geometry.holesResolved,
    saved: geometry.saved,
    polygons: geometry.polygons,
    fallbacks: geometry.fallbacks
  };
}

export default async function courseMapperWorker(req) {
  if (!supabaseBase() || !supabaseKey()) return new Response("supabase not configured", { status: 503 });
  let payload = {};
  try { payload = await req.json(); } catch (e) { payload = {}; }
  await reapStaleJobs();
  let job = await claimJob(payload && payload.jobId || null);
  while (job) {
    try {
      const result = await runMapperJob(job);
      await finishJob(job.id, { status: "done", result, error: null });
    } catch (error) {
      console.error("course-mapper-worker job failed", job.id, error);
      await finishJob(job.id, { status: "failed", error: String(error && error.message || error).slice(0, 900) }).catch(() => {});
    }
    job = await claimJob(null);
  }
  return new Response("ok", { status: 200 });
}

export const __courseMapperWorkerTest = { claimJob, finishJob, heartbeatJob, reapStaleJobs, runMapperJob };
