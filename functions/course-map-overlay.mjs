/* Mapping overlay API: the hand-drawn fairways and hole lines the mapper reads for a course.
 *
 * GET  ?courseId=...[&osm=1]  (admin) -> { course, overlay, aiScan, osm?, objects?, lastRun? }
 *      overlay is the saved feature list (empty when none) and its status, draft or ready.
 *      With osm=1 the response also carries everything Studio needs to draw against:
 *        osm      - what OSM has on this ground - greens, fairways, tees, bunkers, hole lines -
 *                   as plain {lat,lng} rings. That is the same query the mapper runs
 *                   (osmGuideQuery over the same scope), through the same throttled client, so
 *                   it is exactly what the last run collected from OSM.
 *        objects  - what the course already has saved (course_maps.objects_json), as reference
 *                   rings and points. A failed run writes nothing, so this is whatever an
 *                   earlier run or Collect Extra Objects left.
 *        lastRun  - the latest mapper job: its status, error and the counts it recorded, so a
 *                   drawer opened on a failed course says why it failed.
 *      All three are for display. None of it is copied into the overlay.
 * POST {courseId, features:[...]}  (admin) -> saves the overlay, normalised. An empty list
 *      deletes the row: "no overlay" is the absence of a row, not a row holding [].
 * POST {courseId, status: "draft" | "ready"}  (admin) -> marks the saved overlay. The mapper
 *      reads only a ready overlay; any shape save puts it back to draft.
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
import { hasSupabase, slug, verifiedAdminEmail, loadCourse, loadOverlay, saveOverlay, writeOverlayStatus, normalizeCourseMap, writeCourseMap, publicCourseMap, supabaseFetch, json } from "./lib/gd-map-overlay-store.mjs";

/* The AI scan's state, for a poller: everything on it but the picture, which is a megabyte
   of base64 no caller needs back. */
function publicAiScan(aiScan) {
  if (!aiScan || typeof aiScan !== "object") return null;
  const out = Object.assign({}, aiScan);
  delete out.image;
  return out;
}

/* OSM's golf features near the course, as display rings. Greens are what a fairway gets linked
   to; existing fairways/holes/tees/bunkers show what does NOT need drawing. Water is left out -
   it is noise at drawing zoom and there is no tool to place it. */
const OSM_DISPLAY_KINDS = { green: "greens", fairway: "fairways", tee: "tees", hole: "holes", bunker: "bunkers" };
async function loadOsmContext(course) {
  const scope = osmQueryScope({}, { lat: course.lat, lng: course.lng });
  const payload = await fetchOverpass(osmGuideQuery(scope));
  const out = { greens: [], fairways: [], tees: [], holes: [], bunkers: [], elements: 0 };
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

/* The course's saved objects, for drawing against. A ring where the object has a shape, a point
   where it only has a position (the mapper stores tees and fairway targets as points). */
const OBJECT_DISPLAY_TYPES = new Set(["green", "tee", "fairway", "fairway_area", "bunker", "water"]);
function cleanRing(shape) {
  return (Array.isArray(shape) ? shape : []).map(p => ({ lat: Number(p && p.lat), lng: Number(p && (p.lng != null ? p.lng : p.lon)) }))
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}
async function loadCourseObjects(courseId) {
  const rows = await supabaseFetch("course_maps?select=objects_json&course_id=eq." + encodeURIComponent(courseId) + "&limit=1");
  const objects = Object.values((Array.isArray(rows) && rows[0] && rows[0].objects_json) || {});
  const out = [];
  objects.forEach(object => {
    const type = String(object && object.type || "");
    if (!OBJECT_DISPLAY_TYPES.has(type)) return;
    const hole = Number(object.holeNumber) || null;
    const points = cleanRing(object.shape);
    if (points.length >= 3) { out.push({ type, hole, points }); return; }
    const at = cleanRing([object.position])[0];
    if (at) out.push({ type, hole, point: at });
  });
  return out;
}

/* The latest mapper job for the course, trimmed to what the drawer shows: did it fail, why, and
   what did it find. Maintenance jobs are included - "the last thing that ran" is the question. */
async function loadLastRun(courseId) {
  const rows = await supabaseFetch("course_mapper_jobs?select=kind,status,error,result,updated_at&course_id=eq." + encodeURIComponent(courseId) + "&order=created_at.desc&limit=1");
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  const diagnostics = (row.result && row.result.diagnostics) || {};
  return {
    kind: row.kind, status: row.status, error: row.error || null, finishedAt: row.updated_at,
    osmFeatures: diagnostics.osmFeatures || null,
    overlay: diagnostics.overlay || null,
    resolverStatus: diagnostics.resolverStatus || null,
    scorecardResolve: diagnostics.scorecardResolve || null
  };
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
      overlay: { features: overlay.features, status: overlay.status, updatedAt: overlay.updatedAt, updatedBy: overlay.updatedBy },
      aiScan: publicAiScan(overlay.aiScan),
      courseMap: publicCourseMap(overlay.courseMap),
      summary: overlaySummary(overlay.features)
    };
    if (url.searchParams.get("osm") === "1") {
      if (course.lat == null || course.lng == null) body.osm = { error: "course has no centre" };
      else body.osm = await loadOsmContext(course).catch(error => ({ error: String(error && error.message || error).slice(0, 200) }));
      body.objects = await loadCourseObjects(courseId).catch(() => []);
      body.lastRun = await loadLastRun(courseId).catch(() => null);
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
  /* Draft or ready is its own request too, and never touches the shapes. */
  if (payload && Object.prototype.hasOwnProperty.call(payload, "status") && !Array.isArray(payload.features)) {
    if (payload.status !== "draft" && payload.status !== "ready") return json(400, { error: "status must be draft or ready" });
    const marked = await writeOverlayStatus(courseId, payload.status);
    if (marked.error) return json(400, marked);
    return json(200, marked);
  }
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
