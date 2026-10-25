/* OPCD / GSPro export - Studio's door to functions/lib/gd-opcd-export-job.mjs. Admin only.

   GET  ?courseId=<id>
        {courseId, courseName, terrain: {ready, qualityClass, sourceResolutionM, terrainVersion}
         | null, latest: the newest finished export with a public URL per file | null,
         jobs: the course's recent export jobs}
   POST {courseId}
        Queue an export. Runs on the visual worker's queue (course_visual_jobs, kind
        "opcd_export") so it inherits the claim/reaper behaviour; one live job per course.
        A course with no terrain asset gets one baked as the first step of the job.

   The files land in the public course-visuals bucket under <courseId>/opcd/<version>/, so
   the URLs here are plain storage URLs - the same way the frames and terrain are read. */

import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";
import { hasSupabase, verifiedAdminEmail, json, supabaseBase, supabaseKey } from "./lib/gd-map-overlay-store.mjs";
import { createSupabaseStorage } from "./lib/gd-supabase-storage.mjs";
import { loadTerrainRow, TERRAIN_BUCKET } from "./lib/terrain/gd-terrain-service.mjs";
import { OPCD_EXPORT_KIND } from "./lib/gd-opcd-export-core.mjs";

const JOBS_TABLE = "course_visual_jobs";
const MAPS_TABLE = "course_maps";
const FRESH_MS = 20 * 60 * 1000;

const supabaseFetch = createSupabaseFetch({ base: supabaseBase, key: supabaseKey, label: "course-opcd-export" });
const storage = createSupabaseStorage({ base: supabaseBase, key: supabaseKey, bucket: TERRAIN_BUCKET });

async function pingWorker(req, jobId) {
  try {
    await fetch(new URL(req.url).origin + "/.netlify/functions/course-visual-worker-background", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: jobId || null })
    }).catch(() => {});
  } catch (e) { /* the sweeper picks it up */ }
}

async function loadCourse(courseId) {
  const rows = await supabaseFetch(MAPS_TABLE + "?select=course_id,course_name&course_id=eq." + encodeURIComponent(courseId) + "&published=eq.true&limit=1");
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function recentJobs(courseId) {
  const rows = await supabaseFetch(JOBS_TABLE + "?select=id,status,error,result,requested_by,created_at,updated_at&course_id=eq." + encodeURIComponent(courseId) + "&kind=eq." + OPCD_EXPORT_KIND + "&order=created_at.desc&limit=6").catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

function withUrls(result) {
  if (!result || !Array.isArray(result.files)) return null;
  return Object.assign({}, result, { files: result.files.map(f => Object.assign({}, f, { url: storage.publicUrl(f.path) })) });
}

export default async function courseOpcdExport(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  const admin = await verifiedAdminEmail(req);
  if (!admin) return json(403, { error: "Admin verification failed" });

  if (req.method === "GET") {
    const courseId = String(new URL(req.url).searchParams.get("courseId") || "").trim();
    if (!courseId) return json(400, { error: "courseId is required" });
    const course = await loadCourse(courseId);
    if (!course) return json(404, { error: "No published course " + courseId });
    const [terrainRow, jobs] = await Promise.all([loadTerrainRow(courseId, { supabaseFetch }).catch(() => null), recentJobs(courseId)]);
    const done = jobs.find(j => j.status === "done" && j.result && Array.isArray(j.result.files));
    return json(200, {
      courseId, courseName: course.course_name || courseId,
      terrain: terrainRow ? {
        ready: terrainRow.status === "ready", qualityClass: terrainRow.quality_class || null,
        sourceResolutionM: terrainRow.source_resolution_m || null, terrainVersion: terrainRow.terrain_version || null
      } : null,
      latest: done ? Object.assign({ jobId: done.id, finishedAt: done.updated_at }, withUrls(done.result)) : null,
      jobs: jobs.map(j => ({ id: j.id, status: j.status, error: j.error || null, requestedBy: j.requested_by || null, createdAt: j.created_at, updatedAt: j.updated_at, progress: j.result && j.result.progress || null, version: j.result && j.result.version || null }))
    });
  }

  if (req.method === "POST") {
    let payload = {};
    try { payload = await req.json(); } catch (e) { payload = {}; }
    const courseId = String(payload.courseId || "").trim();
    if (!courseId) return json(400, { error: "courseId is required" });
    const course = await loadCourse(courseId);
    if (!course) return json(404, { error: "No published course " + courseId });
    const freshCutoff = new Date(Date.now() - FRESH_MS).toISOString();
    const existing = await supabaseFetch(JOBS_TABLE + "?select=id,status&course_id=eq." + encodeURIComponent(courseId) + "&kind=eq." + OPCD_EXPORT_KIND + "&status=in.(queued,running)&updated_at=gt." + encodeURIComponent(freshCutoff) + "&limit=1");
    if (Array.isArray(existing) && existing[0]) return json(202, { job: existing[0], existing: true });
    const rows = await supabaseFetch(JOBS_TABLE, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{ course_id: courseId, kind: OPCD_EXPORT_KIND, status: "queued", recipe: { requestedAt: new Date().toISOString() }, requested_by: admin }])
    });
    const job = Array.isArray(rows) ? rows[0] : null;
    if (!job) return json(500, { error: "could not queue the export" });
    await pingWorker(req, job.id);
    return json(202, { job, existing: false });
  }

  return json(405, { error: "Method not allowed" });
}

export const config = {
  path: "/api/course-opcd-export"
};
