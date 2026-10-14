/* Queueing a tree run (functions/lib/gd-course-trees-core.mjs) on the mapper's job queue.
 *
 * Its own kind on course_mapper_jobs, run by course-mapper-worker-background like the other
 * maintenance kinds: it reads the course objects and the published frames, writes only the
 * course_trees row, and never touches geometry or visuals. The worker takes one only when no
 * player work is waiting, so a tree run never holds up a scan.
 *
 * Queued from three places: after a course's frames are published (the visual worker), after
 * an automatic map that will get no frames (no free imagery there, so the run reads Esri), and
 * from Studio. The worker also chips through published courses that have never had a run, one
 * an invocation (claimTreeBackfill there).
 *
 * Each caller passes its own supabaseFetch. */

export const TREE_KIND = "find_trees";
const JOBS_TABLE = "course_mapper_jobs";
/* A run queued or running more recently than this is the same run asked for twice. */
const DEDUPE_MS = 30 * 60 * 1000;

/* {queued, job} or {deduped, job}. force: run even over trees someone has edited in Studio
   (the run itself checks - see runTreeJob). now: wake the worker for this job straight away
   (Studio's Run trees) rather than leaving it for the worker's next idle moment. */
export async function queueTreeRun(supabaseFetch, { courseId, requestedBy, origin, force = false, now = false }) {
  if (!courseId) return { error: "courseId required" };
  const cutoff = new Date(Date.now() - DEDUPE_MS).toISOString();
  const existing = await supabaseFetch(JOBS_TABLE + "?select=id,status&course_id=eq." + encodeURIComponent(courseId)
    + "&kind=eq." + TREE_KIND + "&status=in.(queued,running)&updated_at=gt." + encodeURIComponent(cutoff) + "&limit=1").catch(() => null);
  if (Array.isArray(existing) && existing.length) return { deduped: true, job: existing[0] };
  const inserted = await supabaseFetch(JOBS_TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{ course_id: courseId, kind: TREE_KIND, status: "queued", requested_by: requestedBy || null, result: force ? { force: true } : null }])
  });
  const job = Array.isArray(inserted) ? inserted[0] : inserted;
  await wakeMapperWorker(origin, now ? job && job.id : null);
  return { queued: true, job };
}

/* Awaited, never fire-and-forget - a serverless process freezes when its handler returns.
   A lost wake only means the job waits for the sweeper (every three minutes). */
export async function wakeMapperWorker(origin, jobId) {
  if (!origin) return false;
  try {
    const response = await fetch(origin + "/.netlify/functions/course-mapper-worker-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(jobId ? { jobId } : {})
    });
    return response.status === 202 || response.ok;
  } catch (error) {
    return false;
  }
}
