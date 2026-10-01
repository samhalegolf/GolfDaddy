/* Test bakes - the normal capture + bake, from a test-only source (Mapbox), into a private
 * sandbox. Admin only. See lib/gd-test-bake-core.mjs for what makes a bake a test.
 *
 * POST {courseId, source:"mapbox"}
 *   Queues a test-snapshot job for the course's current published geometry. The worker
 *   chains the test export itself. -> 202 {run, job}
 * GET ?courseId=...
 *   -> {runs:[...], latest:{...} | null, retentionDays}
 *   runs: recent test runs with their stage, status, progress and error.
 *   latest: the newest finished run's frames, as signed links that expire in an hour - the
 *   test bucket is private, so these links are the only way to see them.
 *
 * Nothing here touches the course's published visuals. */

import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";
import { hasSupabase, slug, verifiedAdminEmail, json, supabaseBase, supabaseKey } from "./lib/gd-map-overlay-store.mjs";
import { newTestRun, TEST_BAKE_BUCKET, TEST_BAKE_RETENTION_DAYS, TEST_SNAPSHOT_KIND, TEST_EXPORT_KIND, TEST_BAKE_SOURCES } from "./lib/gd-test-bake-core.mjs";
import { mapboxStatus } from "./lib/gd-mapbox-source.mjs";

const JOBS_TABLE = "course_visual_jobs";
const MAPS_TABLE = "course_maps";
const SIGNED_URL_SECONDS = 3600;
/* A test job untouched for this long belongs to a dead worker and does not block a new run -
   the same rule course-visual-jobs.mjs uses for live jobs. */
const FRESH_MS = 20 * 60 * 1000;

const supabaseFetch = createSupabaseFetch({ base: supabaseBase, key: supabaseKey, label: "course-test-bakes" });

async function pingWorker(req, jobId) {
  try {
    await fetch(new URL(req.url).origin + "/.netlify/functions/course-visual-worker-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: jobId || null })
    }).catch(() => {});
  } catch (e) { /* the job stays queued for the sweeper */ }
}

async function signPaths(paths) {
  if (!paths.length) return {};
  const response = await fetch(supabaseBase() + "/storage/v1/object/sign/" + TEST_BAKE_BUCKET, {
    method: "POST",
    headers: { apikey: supabaseKey(), Authorization: "Bearer " + supabaseKey(), "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: SIGNED_URL_SECONDS, paths })
  });
  if (!response.ok) return {};
  const rows = await response.json();
  const out = {};
  (Array.isArray(rows) ? rows : []).forEach(row => {
    if (row && row.path && row.signedURL) out[row.path] = supabaseBase() + "/storage/v1" + row.signedURL;
  });
  return out;
}

async function readFramesIndex(root) {
  const response = await fetch(supabaseBase() + "/storage/v1/object/" + TEST_BAKE_BUCKET + "/" + root + "/frames/index.json", {
    headers: { apikey: supabaseKey(), Authorization: "Bearer " + supabaseKey() }
  });
  if (!response.ok) return null;
  try { return await response.json(); } catch (e) { return null; }
}

/* Jobs -> runs. A run is one snapshot and the export it chained, sharing a testRun.runId. */
function groupRuns(jobs) {
  const runs = new Map();
  for (const job of jobs) {
    const run = job.recipe && job.recipe.testRun;
    if (!run || !run.runId) continue;
    const entry = runs.get(run.runId) || { runId: run.runId, root: run.root, source: run.source, requestedAt: run.requestedAt, requestedBy: run.requestedBy, snapshot: null, export: null };
    const slot = job.kind === TEST_SNAPSHOT_KIND ? "snapshot" : "export";
    if (!entry[slot]) entry[slot] = { status: job.status, error: job.error || null, progress: job.result && job.result.progress || null, result: job.status === "done" ? job.result : null, updatedAt: job.updated_at };
    runs.set(run.runId, entry);
  }
  return [...runs.values()].map(run => {
    const stage = run.export ? "bake" : "capture";
    const current = run.export || run.snapshot || {};
    const failed = (run.snapshot && run.snapshot.status === "failed") || (run.export && run.export.status === "failed");
    const done = !!(run.export && run.export.status === "done");
    return Object.assign(run, { stage, status: failed ? "failed" : done ? "done" : current.status || "queued", error: failed ? (run.export && run.export.error) || (run.snapshot && run.snapshot.error) : null });
  });
}

async function latestFrames(run) {
  const index = await readFramesIndex(run.root);
  if (!index) return null;
  const holes = Array.isArray(index.holes) ? index.holes : [];
  const paths = [];
  if (index.overview && index.overview.path) paths.push(index.overview.path);
  holes.forEach(h => {
    if (h.path) paths.push(h.path);
    if (h.greenFrame && h.greenFrame.path) paths.push(h.greenFrame.path);
  });
  const signed = await signPaths(paths);
  return {
    runId: run.runId,
    requestedAt: run.requestedAt,
    source: index.source || null,
    overview: index.overview ? { url: signed[index.overview.path] || null, width: index.overview.width, height: index.overview.height } : null,
    holes: holes.map(h => ({
      holeNumber: h.holeNumber, width: h.width, height: h.height,
      url: signed[h.path] || null,
      greenUrl: h.greenFrame && signed[h.greenFrame.path] || null,
      elevation: h.playSurface && h.playSurface.elevation ? { min: h.playSurface.elevation.elevationRange && h.playSurface.elevation.elevationRange.min, max: h.playSurface.elevation.elevationRange && h.playSurface.elevation.elevationRange.max, metresPerPixel: h.playSurface.elevation.metresPerPixel } : null
    })),
    linksExpireInSeconds: SIGNED_URL_SECONDS
  };
}

export default async function courseTestBakes(req) {
  if (req.method === "OPTIONS") return json(204, null);
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  const admin = await verifiedAdminEmail(req);
  if (!admin) return json(403, { error: "Admin verification failed" });

  if (req.method === "GET") {
    const courseId = slug(new URL(req.url).searchParams.get("courseId"));
    if (!courseId) return json(400, { error: "courseId required" });
    const jobs = await supabaseFetch(JOBS_TABLE + "?select=id,kind,status,error,result,recipe,created_at,updated_at&course_id=eq." + encodeURIComponent(courseId) + "&kind=in.(" + TEST_SNAPSHOT_KIND + "," + TEST_EXPORT_KIND + ")&order=created_at.desc&limit=20").catch(() => []);
    const runs = groupRuns(Array.isArray(jobs) ? jobs : []);
    const finished = runs.find(run => run.status === "done");
    return json(200, {
      courseId, runs: runs.slice(0, 6),
      latest: finished ? await latestFrames(finished) : null,
      retentionDays: TEST_BAKE_RETENTION_DAYS,
      mapboxConfigured: mapboxStatus().configured
    });
  }

  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  let payload;
  try { payload = await req.json(); } catch (e) { return json(400, { error: "Invalid JSON" }); }
  const courseId = slug(payload && payload.courseId);
  const source = String(payload && payload.source || "mapbox");
  if (!courseId) return json(400, { error: "courseId required" });
  if (!TEST_BAKE_SOURCES.includes(source)) return json(400, { error: "unknown test source " + source });
  const status = mapboxStatus();
  if (!status.configured) return json(503, { error: "Mapbox is not configured", detail: status.reason });

  /* Same "is there anything to shoot" rule as the live auto path: judged by content. */
  const maps = await supabaseFetch(MAPS_TABLE + "?select=course_id,objects_json,holes_json&course_id=eq." + encodeURIComponent(courseId) + "&published=eq.true&limit=1");
  const map = Array.isArray(maps) ? maps[0] : null;
  const holeCount = map && map.holes_json && typeof map.holes_json === "object" ? Object.keys(map.holes_json).length : 0;
  if (!holeCount) return json(404, { error: "course has no published hole geometry to bake" });

  const fresh = new Date(Date.now() - FRESH_MS).toISOString();
  const live = await supabaseFetch(JOBS_TABLE + "?select=id,kind,status,recipe&course_id=eq." + encodeURIComponent(courseId) + "&kind=in.(" + TEST_SNAPSHOT_KIND + "," + TEST_EXPORT_KIND + ")&status=in.(queued,running)&updated_at=gt." + encodeURIComponent(fresh) + "&limit=1");
  if (Array.isArray(live) && live.length) return json(200, { deduped: true, job: live[0], run: live[0].recipe && live[0].recipe.testRun || null });

  const run = newTestRun({ courseId, source, requestedBy: admin });
  const inserted = await supabaseFetch(JOBS_TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{ course_id: courseId, kind: TEST_SNAPSHOT_KIND, status: "queued", recipe: { testRun: run }, requested_by: admin }])
  });
  const job = Array.isArray(inserted) ? inserted[0] : inserted;
  await pingWorker(req, job && job.id);
  return json(202, { run, job: job ? { id: job.id, kind: job.kind, status: job.status } : null, retentionDays: TEST_BAKE_RETENTION_DAYS });
}

export const config = {
  path: "/api/course-test-bakes"
};
