/* Watch Map bake worker (Netlify background function - 15 minute budget).

   functions/course-watch-maps.mjs used to bake in its own request. That held while a course
   baked in a few seconds; with terrain shading and the per-hole delivery ladder Millbrook's
   18 holes take well over a minute, and on 2026-09-21 the request was cut off at hole 11 with
   the progress column left pointing at it and no package written. This is the "seam to
   convert" its header always named: the request handler now checks the caller, marks the row
   queued, wakes this function and answers 202; the bake runs here with no clock on it.

   Everything the bake IS - generateWatchPackage, its progress writes, its storage uploads -
   still lives in course-watch-maps.mjs and is imported unchanged, so the two paths (this one
   and the handler's `sync: true` escape hatch) cannot drift.

   The caller's bearer is forwarded and re-verified here rather than trusted: this URL is
   reachable by anyone, and "admin only" has to be true at the place the work happens. */

import { generateWatchPackage, verifiedUser, slug, supabaseFetch, hasSupabase, clearProgress, MAPS_TABLE } from "./course-watch-maps.mjs";

export default async function courseWatchMapsBackground(req) {
  if (!hasSupabase()) return new Response("supabase not configured", { status: 503 });
  let payload = {};
  try { payload = await req.json(); } catch (e) { payload = {}; }
  const courseId = slug(payload && (payload.courseId || payload.course_id));
  if (!courseId) return new Response("courseId required", { status: 400 });

  const user = await verifiedUser(req);
  if (!user || !user.isAdmin) {
    /* The handler already wrote "queued" on the caller's behalf; leaving it would show a bar
       that never ends for a request that was never allowed to start. */
    await clearProgress(courseId);
    return new Response("admin only", { status: 403 });
  }

  try {
    const maps = await supabaseFetch(MAPS_TABLE + "?select=course_id,objects_json,holes_json,objects_revision,published_at,updated_at&course_id=eq." + encodeURIComponent(courseId) + "&published=eq.true&limit=1");
    const map = Array.isArray(maps) ? maps[0] : null;
    if (!map || !map.objects_json || !Object.keys(map.objects_json).length) {
      await clearProgress(courseId);
      return new Response("course has no published geometry", { status: 404 });
    }
    const row = await generateWatchPackage({ courseId, map, actorEmail: user.email });
    console.log("[watch-maps-background] " + courseId + " " + (row && row.status) + " " + (row && row.holes ? row.holes.length : 0) + " holes");
  } catch (error) {
    /* generateWatchPackage clears its own progress on the failures it knows about; this is
       the last word for anything that escaped it. Studio reads the cleared column as "done"
       and re-fetches the report, which then says what the stored package really is. */
    await clearProgress(courseId);
    console.log("[watch-maps-background] " + courseId + " failed: " + String(error && error.message || error));
  }
  return new Response("", { status: 202 });
}
