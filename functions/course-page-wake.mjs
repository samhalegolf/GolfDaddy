/* POST /api/course-page-wake { courseId }: a visitor on a public course page has done
   something (any first click or key), so start that course's Apple Watch map now.

   The Apple Watch map is the image bake (course_watch_maps; minutes per course, run by
   course-watch-maps-background.mjs). The course page used to ask for it when the page
   rendered, but a render is mostly a crawler, and the page is cached at the CDN for a day so a
   real visit rarely rendered at all. A click is a person: scripts/clarity-course-page.js posts
   here once on the first interaction, and if they go on to open the Apple Watch tab (which
   polls GET /api/course-watch-maps) the bake is that much further along.

   Public and unauthenticated, so it does as little as it can: only a course whose page is
   public, only when there is no package and no bake running (lib/gd-apple-bake-wake.mjs), and
   then the same service-secret wake the page function made. The worker checks page_public
   again on its side. */

import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";
import { appleBakeNeeded, wakeAppleBake } from "./lib/gd-apple-bake-wake.mjs";

const MAPS_TABLE = "course_maps";
const WATCH_TABLE = "course_watch_maps";

function env(name) { return process.env[name] || ""; }
const supabaseFetch = createSupabaseFetch({ base: () => env("SUPABASE_URL").replace(/\/+$/, ""), key: () => env("SUPABASE_SERVICE_ROLE_KEY"), label: "course-page-wake" });

function slug(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160);
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

/* What the page is told: "ready" (a package exists), "building" (a bake is moving), "queued"
   (woken now), or "unavailable" (the wake did not get through; the next click tries again). */
export async function coursePageWake(req, deps = {}) {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const fetchRows = deps.supabaseFetch || supabaseFetch;
  const wake = deps.wake || wakeAppleBake;
  const secret = deps.secret != null ? deps.secret : env("CLARITY_SERVICE_SECRET");
  if (!secret) return json(503, { error: "not configured" });

  let payload = {};
  try { payload = await req.json(); } catch (error) { payload = {}; }
  const courseId = slug(payload && payload.courseId);
  if (!courseId) return json(400, { error: "courseId required" });

  const maps = await fetchRows(MAPS_TABLE + "?select=course_id&course_id=eq." + encodeURIComponent(courseId) + "&published=eq.true&page_public=eq.true&limit=1");
  if (!Array.isArray(maps) || !maps.length) return json(404, { error: "not a public course page" });

  const rows = await fetchRows(WATCH_TABLE + "?select=status,ready_hole_count,progress&course_id=eq." + encodeURIComponent(courseId) + "&limit=1").catch(() => []);
  const watch = Array.isArray(rows) ? rows[0] || null : null;
  if (!appleBakeNeeded(watch)) return json(200, { courseId, apple: Number(watch.ready_hole_count) > 0 ? "ready" : "building" });

  const woken = await wake(new URL(req.url).origin, courseId, secret);
  return woken ? json(202, { courseId, apple: "queued" }) : json(503, { courseId, apple: "unavailable" });
}

export default function handler(req) { return coursePageWake(req); }

export const config = { path: "/api/course-page-wake" };
