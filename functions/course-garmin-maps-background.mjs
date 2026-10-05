/* Garmin package builder (Netlify background function - 15 minute budget).

   Builds a course's Garmin watch package - the drawn map, no images - into
   course_garmin_maps. The building itself is buildGarminPackageIfStale in
   course-watch-maps.mjs, beside the image bake it shares its geometry and terrain code with.

   Nobody has to ask for it. It is woken (lib/gd-garmin-build-wake.mjs) after the normal
   course package is made - the end of a mapper run, and the end of the visual export that
   brings the elevation the terrain pieces are cut from - and by the phone when it finds the
   package missing or behind. It runs after that work has finished and never touches it.

   No sign-in, like the mapper and visual workers it follows: anyone can reach this URL, but
   all a wake can do is make it check whether the stored package is current and, only if it
   is not, rebuild it once (a lock stops two builds overlapping). */

import { buildGarminPackageIfStale, slug, hasSupabase } from "./course-watch-maps.mjs";

export default async function courseGarminMapsBackground(req) {
  if (!hasSupabase()) return new Response("supabase not configured", { status: 503 });
  let payload = {};
  try { payload = await req.json(); } catch (e) { payload = {}; }
  const courseId = slug(payload && (payload.courseId || payload.course_id));
  if (!courseId) return new Response("courseId required", { status: 400 });
  try {
    const result = await buildGarminPackageIfStale(courseId);
    console.log("[garmin-maps] " + courseId + " " + JSON.stringify(result));
  } catch (error) {
    console.log("[garmin-maps] " + courseId + " failed: " + String(error && error.message || error));
  }
  return new Response("", { status: 202 });
}
