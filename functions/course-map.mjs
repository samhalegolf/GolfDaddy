/* Course map - Studio's door to the course map and the outline that trims it
   (lib/gd-course-surface-core.mjs). Admin only.

   GET  ?courseId=<id>
        {courseId, boundary | null, surface | null, jobs: the course's recent course map jobs}
        The surface is also on the public /api/course-visuals record (course_surface), which is
        where Play will read it; this answer adds the jobs, for Studio's progress line.
   POST {courseId, action: "build"}
        Queue a course map build. Runs on the visual worker's queue (course_visual_jobs, kind
        "course_surface"). One queued job per course; a running one does not count, since it
        may have read an outline that has changed since.
   POST {courseId, action: "boundary", ring: [{lat, lng}, ...] | null}
        Save the outline (null clears it) and queue a build, so the course map is cut to it.

   The worker also queues a build after every published export, so the course map follows
   the hole frames without anyone asking. */

import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";
import { hasSupabase, verifiedAdminEmail, json, supabaseBase, supabaseKey } from "./lib/gd-map-overlay-store.mjs";
import { COURSE_SURFACE_KIND, normaliseBoundary } from "./lib/gd-course-surface-core.mjs";

const JOBS_TABLE = "course_visual_jobs";
const VISUALS_TABLE = "course_visuals";

const supabaseFetch = createSupabaseFetch({ base: supabaseBase, key: supabaseKey, label: "course-map" });

async function pingWorker(req, jobId) {
  try {
    await fetch(new URL(req.url).origin + "/.netlify/functions/course-visual-worker-background", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: jobId || null })
    }).catch(() => {});
  } catch (e) { /* the sweeper picks it up */ }
}

async function loadVisual(courseId) {
  const rows = await supabaseFetch(VISUALS_TABLE + "?select=course_id,course_boundary,course_surface&course_id=eq." + encodeURIComponent(courseId) + "&limit=1");
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function recentJobs(courseId) {
  const rows = await supabaseFetch(JOBS_TABLE + "?select=id,status,error,result,requested_by,created_at,updated_at&course_id=eq." + encodeURIComponent(courseId) + "&kind=eq." + COURSE_SURFACE_KIND + "&order=created_at.desc&limit=6").catch(() => []);
  return (Array.isArray(rows) ? rows : []).map(j => ({
    id: j.id, status: j.status, error: j.error || null, requestedBy: j.requested_by || null,
    createdAt: j.created_at, updatedAt: j.updated_at,
    stage: j.result && j.result.progress && j.result.progress.stage || null,
    unchanged: !!(j.result && j.result.unchanged)
  }));
}

async function queueBuild(req, courseId, requestedBy) {
  const existing = await supabaseFetch(JOBS_TABLE + "?select=id,status&course_id=eq." + encodeURIComponent(courseId) + "&kind=eq." + COURSE_SURFACE_KIND + "&status=eq.queued&limit=1");
  if (Array.isArray(existing) && existing[0]) return { job: existing[0], existing: true };
  const rows = await supabaseFetch(JOBS_TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{ course_id: courseId, kind: COURSE_SURFACE_KIND, status: "queued", recipe: { requestedAt: new Date().toISOString() }, requested_by: requestedBy }])
  });
  const job = Array.isArray(rows) ? rows[0] : null;
  if (!job) throw new Error("could not queue the course map");
  await pingWorker(req, job.id);
  return { job, existing: false };
}

export default async function courseMap(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  const admin = await verifiedAdminEmail(req);
  if (!admin) return json(403, { error: "Admin verification failed" });

  if (req.method === "GET") {
    const courseId = String(new URL(req.url).searchParams.get("courseId") || "").trim();
    if (!courseId) return json(400, { error: "courseId is required" });
    const [visual, jobs] = await Promise.all([loadVisual(courseId), recentJobs(courseId)]);
    return json(200, {
      courseId,
      boundary: visual && visual.course_boundary || null,
      surface: visual && visual.course_surface || null,
      jobs
    });
  }

  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  let payload = {};
  try { payload = await req.json(); } catch (e) { payload = {}; }
  const courseId = String(payload.courseId || "").trim();
  if (!courseId) return json(400, { error: "courseId is required" });
  const visual = await loadVisual(courseId);
  if (!visual) return json(404, { error: "No published visuals for " + courseId + " - scan the course first" });
  const action = String(payload.action || "");

  if (action === "build") {
    return json(202, await queueBuild(req, courseId, admin));
  }

  if (action === "boundary") {
    let boundary = null;
    if (payload.ring != null) {
      try {
        const ok = normaliseBoundary(payload.ring);
        boundary = { ring: ok.ring, areaM2: ok.areaM2, savedBy: admin, savedAt: new Date().toISOString() };
      } catch (error) {
        return json(400, { error: error.message });
      }
    }
    await supabaseFetch(VISUALS_TABLE + "?course_id=eq." + encodeURIComponent(courseId), {
      method: "PATCH",
      body: JSON.stringify({ course_boundary: boundary })
    });
    const queued = await queueBuild(req, courseId, admin);
    return json(200, { boundary, job: queued.job, existing: queued.existing });
  }

  return json(400, { error: "action must be build or boundary" });
}

export const config = {
  path: "/api/course-map"
};
