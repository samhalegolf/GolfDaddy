/* Mapping overlay API: the hand-drawn fairways and hole lines the mapper reads for a course.
 *
 * GET  ?courseId=...[&osm=1]  (admin) -> { course, overlay, aiScan, osm? }
 *      overlay is the saved feature list (empty when none). With osm=1 the response also
 *      carries what OSM has on this ground - greens, fairways, tees, hole lines - as plain
 *      {lat,lng} rings, so Studio can draw the missing fairways against the greens the mapper
 *      will actually link them to. That is the same query the mapper runs (osmGuideQuery over
 *      the same scope), through the same throttled client, so the picture cannot differ from
 *      the mapper's.
 * POST {courseId, features:[...]}  (admin) -> saves the overlay, normalised. An empty list
 *      deletes the row: "no overlay" is the absence of a row, not a row holding [].
 * POST {courseId, courseMap: {mediaType, data, name, width, height} | null}  (admin) -> stores
 *      or removes the club's course map for the course; the AI scan sends it as a second
 *      image. Touches nothing else on the row.
 * POST {courseId, georef, features:[...], units?, append?}  (admin) -> the same, but the
 *      features are in IMAGE PIXELS - an AI's answer about a satellite picture - and georef
 *      says where that picture is (gd-overlay-georef-core.mjs: a frame's playSurface,
 *      centre+zoom, or bounds). They are converted to lat/lng here, stamped source:"ai", and
 *      saved. append:true keeps the shapes already saved and adds these, for an AI run one
 *      picture at a time; the default replaces, like a hand-drawn save. The response carries
 *      what was dropped and why, so a bad answer is visible rather than silently thinner.
 *
 * The overlay is read by functions/course-mapper-worker-background.mjs and merged into the
 * Overpass payload (functions/lib/gd-map-overlay-core.mjs). Saving here changes nothing on
 * the course until a mapper run is requested through /api/course-mapper-jobs. */

import { fetchOverpass } from "./lib/gd-overpass-client.mjs";
import { osmQueryScope, osmGuideQuery, osmGuidePointsFromElement } from "./lib/gd-automapper-core.mjs";
import { overlaySummary } from "./lib/gd-map-overlay-core.mjs";
import { aiShapesToOverlay } from "./lib/gd-overlay-georef-core.mjs";
import { hasSupabase, slug, verifiedAdminEmail, loadCourse, loadOverlay, saveOverlay, normalizeCourseMap, writeCourseMap, publicCourseMap, json } from "./lib/gd-map-overlay-store.mjs";

/* The AI scan's state, for a poller: everything on it but the picture, which is a megabyte
   of base64 no caller needs back. */
function publicAiScan(aiScan) {
  if (!aiScan || typeof aiScan !== "object") return null;
  const out = Object.assign({}, aiScan);
  delete out.image;
  return out;
}

/* OSM's golf features near the course, as display rings. Only the kinds worth drawing against:
   greens are what a fairway gets linked to, and existing fairways/holes/tees show what does
   NOT need drawing. Bunkers and water are left out - they are noise at drawing zoom. */
const OSM_DISPLAY_KINDS = { green: "greens", fairway: "fairways", tee: "tees", hole: "holes" };
async function loadOsmContext(course) {
  const scope = osmQueryScope({}, { lat: course.lat, lng: course.lng });
  const payload = await fetchOverpass(osmGuideQuery(scope));
  const out = { greens: [], fairways: [], tees: [], holes: [], elements: 0 };
  ((payload && payload.elements) || []).forEach(element => {
    out.elements += 1;
    const golf = String((element && element.tags && element.tags.golf) || "").toLowerCase();
    const bucket = OSM_DISPLAY_KINDS[golf];
    if (!bucket) return;
    const points = osmGuidePointsFromElement(element);
    if (points.length < 2) return;
    out[bucket].push({ id: (element.type || "way") + "/" + element.id, ref: String((element.tags.ref || element.tags.name || "")).slice(0, 12), points });
  });
  return out;
}

export default async function courseMapOverlay(req) {
  if (req.method === "OPTIONS") return json(204, null);
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });

  const admin = await verifiedAdminEmail(req);
  if (!admin) return json(403, { error: "Admin verification failed" });

  if (req.method === "GET") {
    const url = new URL(req.url);
    const courseId = slug(url.searchParams.get("courseId"));
    if (!courseId) return json(400, { error: "courseId required" });
    const course = await loadCourse(courseId);
    if (!course) return json(404, { error: "no course_maps row for " + courseId });
    const overlay = await loadOverlay(courseId);
    const body = {
      courseId, course,
      overlay: { features: overlay.features, updatedAt: overlay.updatedAt, updatedBy: overlay.updatedBy },
      aiScan: publicAiScan(overlay.aiScan),
      courseMap: publicCourseMap(overlay.courseMap),
      summary: overlaySummary(overlay.features)
    };
    if (url.searchParams.get("osm") === "1") {
      if (course.lat == null || course.lng == null) body.osm = { error: "course has no centre" };
      else body.osm = await loadOsmContext(course).catch(error => ({ error: String(error && error.message || error).slice(0, 200) }));
    }
    return json(200, body);
  }

  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  let payload;
  try { payload = await req.json(); } catch (e) { return json(400, { error: "Invalid JSON" }); }
  const courseId = slug(payload && (payload.courseId || payload.course_id));
  if (!courseId) return json(400, { error: "courseId required" });
  const course = await loadCourse(courseId);
  if (!course) return json(404, { error: "no course_maps row for " + courseId, detail: "An overlay belongs to a course the picker already knows. Add the course first." });
  /* A course map save is its own request and touches nothing else on the row: {courseMap}
     stores it, {courseMap: null} removes it. */
  if (payload && Object.prototype.hasOwnProperty.call(payload, "courseMap")) {
    const courseMap = normalizeCourseMap(payload.courseMap);
    if (payload.courseMap && !courseMap) return json(400, { error: "bad course map", detail: "image/jpeg, image/png or image/webp, base64, under ~1MB" });
    await writeCourseMap(courseId, courseMap);
    return json(200, { courseId, courseMap: publicCourseMap(courseMap) });
  }
  let raw = payload && Array.isArray(payload.features) ? payload.features : [];
  let converted = null;
  if (payload && payload.georef) {
    converted = aiShapesToOverlay(raw, payload.georef, { units: payload.units });
    if (converted.error) return json(400, { error: "bad georef", detail: converted.error });
    raw = converted.features;
  }
  const saved = await saveOverlay({ courseId, features: raw, savedBy: admin, append: !!(converted && payload.append) });
  if (saved.error) return json(400, saved);
  return json(200, Object.assign(saved, {
    dropped: saved.dropped + (converted ? converted.dropped.length : 0),
    converted: converted ? { georef: converted.georef, dropped: converted.dropped, pixels: converted.pixels } : undefined
  }));
}

export const config = {
  path: "/api/course-map-overlay"
};
