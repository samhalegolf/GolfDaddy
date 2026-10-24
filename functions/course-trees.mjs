/* A course's trees (course_trees, see lib/gd-course-trees-core.mjs) for Studio. Admin only.
 *
 * GET  ?courseId=          -> {courseId, row: {trees, level, status, imagery, run, publishedAt,
 *                             publishedBy} | null, job: the latest tree run {status, error,
 *                             stage, updatedAt} | null}
 * GET  ?summary=1          -> how far the tree backlog has got: {published, done, waiting,
 *                             running, failedToday}
 * POST {courseId, action: "publish", trees, level}
 *                          -> Studio's edits, live: the trees ([lat, lng, radius, level,
 *                             fromHeight] each) and the sensitivity they are shown at. The row
 *                             is marked edited, so an automatic run leaves it alone after.
 *
 * Starting a run is the mapper queue's: POST /api/course-mapper-jobs {courseId, kind:
 * "find_trees"}. */

import { packTrees, unpackTrees, TREES_TABLE } from "./lib/gd-course-trees-store.mjs";
import { TREE_KIND } from "./lib/gd-tree-queue.mjs";
import { wakeGarminBuild } from "./lib/gd-garmin-build-wake.mjs";
import { hasSupabase, slug, verifiedAdminEmail, supabaseFetch, json } from "./lib/gd-map-overlay-store.mjs";

const MAPS_TABLE = "course_maps";
const JOBS_TABLE = "course_mapper_jobs";
/* gd-map-overlay-core OVERLAY_MAX_TREES, with room for a facility's worth. */
const MAX_TREES = 6000;
const LEVELS = 6;

function rowShape(row) {
  if (!row) return null;
  return { trees: row.trees || [], level: row.level, status: row.status, imagery: row.imagery || null, run: row.run || null, publishedAt: row.published_at || null, publishedBy: row.published_by || null };
}

async function latestJob(courseId) {
  const rows = await supabaseFetch(JOBS_TABLE + "?select=status,error,result,updated_at&course_id=eq." + encodeURIComponent(courseId) + "&kind=eq." + TREE_KIND + "&order=created_at.desc&limit=1").catch(() => []);
  const job = Array.isArray(rows) ? rows[0] : null;
  if (!job) return null;
  return { status: job.status, error: job.error || null, stage: job.result && job.result.progress && job.result.progress.stage || null, updatedAt: job.updated_at };
}

async function summary() {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [published, done, jobs] = await Promise.all([
    supabaseFetch(MAPS_TABLE + "?select=course_id&published=eq.true&limit=5000").catch(() => []),
    supabaseFetch(TREES_TABLE + "?select=course_id&limit=5000").catch(() => []),
    supabaseFetch(JOBS_TABLE + "?select=course_id,status&kind=eq." + TREE_KIND + "&created_at=gt." + encodeURIComponent(dayAgo) + "&limit=5000").catch(() => [])
  ]);
  const ids = new Set((Array.isArray(published) ? published : []).map(r => r.course_id));
  const withTrees = (Array.isArray(done) ? done : []).filter(r => ids.has(r.course_id)).length;
  const today = Array.isArray(jobs) ? jobs : [];
  return {
    published: ids.size,
    done: withTrees,
    waiting: ids.size - withTrees,
    running: today.filter(j => j.status === "running" || j.status === "queued").length,
    failedToday: today.filter(j => j.status === "failed").length
  };
}

export default async function courseTrees(req) {
  if (req.method === "OPTIONS") return json(204, null);
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  const admin = await verifiedAdminEmail(req);
  if (!admin) return json(403, { error: "Admin verification failed" });

  if (req.method === "GET") {
    const q = new URL(req.url).searchParams;
    if (q.get("summary") === "1") return json(200, await summary());
    const courseId = slug(q.get("courseId"));
    if (!courseId) return json(400, { error: "courseId required" });
    const [rows, job] = await Promise.all([
      supabaseFetch(TREES_TABLE + "?select=*&course_id=eq." + encodeURIComponent(courseId) + "&limit=1").catch(() => []),
      latestJob(courseId)
    ]);
    return json(200, { courseId, row: rowShape(Array.isArray(rows) ? rows[0] : null), job });
  }

  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  let payload;
  try { payload = await req.json(); } catch (e) { return json(400, { error: "Invalid JSON" }); }
  const courseId = slug(payload && payload.courseId);
  if (!courseId) return json(400, { error: "courseId required" });
  if (payload.action !== "publish") return json(400, { error: "action must be publish" });
  const trees = unpackTrees(payload.trees);
  if (trees.length > MAX_TREES) return json(400, { error: "too many trees", detail: "At most " + MAX_TREES + " trees a course." });
  const level = Math.max(0, Math.min(LEVELS - 1, Math.round(Number(payload.level))));
  if (!Number.isFinite(level)) return json(400, { error: "level required" });
  const map = await supabaseFetch(MAPS_TABLE + "?select=course_id&course_id=eq." + encodeURIComponent(courseId) + "&limit=1").catch(() => []);
  if (!Array.isArray(map) || !map.length) return json(404, { error: "no course_maps row for " + courseId });
  const now = new Date().toISOString();
  const saved = await supabaseFetch(TREES_TABLE + "?on_conflict=course_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{ course_id: courseId, trees: packTrees(trees), level, status: "edited", published_at: now, published_by: admin, updated_at: now }])
  });
  /* The Garmin package rebuilds itself with them; the Apple Watch maps follow their next
     Generate. */
  let origin = "";
  try { origin = new URL(req.url).origin; } catch (e) { origin = ""; }
  await wakeGarminBuild(origin, courseId);
  return json(200, { courseId, row: rowShape(Array.isArray(saved) ? saved[0] : null) });
}

export const config = {
  path: "/api/course-trees"
};
