/* Mapping overlay API: the hand-drawn fairways and hole lines the mapper reads for a course.
 *
 * GET  ?courseId=...[&osm=1]  (admin) -> { course, overlay, osm? }
 *      overlay is the saved feature list (empty when none). With osm=1 the response also
 *      carries what OSM has on this ground - greens, fairways, tees, hole lines - as plain
 *      {lat,lng} rings, so Studio can draw the missing fairways against the greens the mapper
 *      will actually link them to. That is the same query the mapper runs (osmGuideQuery over
 *      the same scope), through the same throttled client, so the picture cannot differ from
 *      the mapper's.
 * POST {courseId, features:[...]}  (admin) -> saves the overlay, normalised. An empty list
 *      deletes the row: "no overlay" is the absence of a row, not a row holding [].
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

import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";
import { fetchOverpass } from "./lib/gd-overpass-client.mjs";
import { osmQueryScope, osmGuideQuery, osmGuidePointsFromElement } from "./lib/gd-automapper-core.mjs";
import { normalizeOverlayFeatures, overlaySummary, OVERLAY_MAX_FEATURES } from "./lib/gd-map-overlay-core.mjs";
import { aiShapesToOverlay } from "./lib/gd-overlay-georef-core.mjs";

const TABLE = "course_map_overlays";
const MAPS_TABLE = "course_maps";
const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function anonKey() { return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || ""; }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }
function slug(value) { return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90); }

/* Same proof as course-maps.mjs: the bearer token is checked against /auth/v1/user and only
   the email that comes back can be an admin. Nothing in the body can grant it. */
async function verifiedAdminEmail(req) {
  const header = String((req && req.headers && typeof req.headers.get === "function" && req.headers.get("authorization")) || "");
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return "";
  const base = supabaseBase();
  const key = anonKey() || supabaseKey();
  if (!base || !key) return "";
  try {
    const response = await fetch(base + "/auth/v1/user", { method: "GET", headers: { apikey: key, Authorization: "Bearer " + token } });
    if (!response.ok) return "";
    const user = await response.json();
    const verified = String(user && user.email || "").trim().toLowerCase();
    return user && user.id && ADMIN_EMAILS.has(verified) ? verified : "";
  } catch (error) {
    return "";
  }
}

const supabaseFetch = createSupabaseFetch({ base: supabaseBase, key: supabaseKey, label: "course-map-overlay" });

async function loadCourse(courseId) {
  const rows = await supabaseFetch(MAPS_TABLE + "?select=course_id,course_name,course_lat,course_lng&course_id=eq." + encodeURIComponent(courseId) + "&limit=1");
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  const lat = Number(row.course_lat), lng = Number(row.course_lng);
  return { courseId: row.course_id, name: row.course_name || "", lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null };
}

async function loadOverlay(courseId) {
  const rows = await supabaseFetch(TABLE + "?select=features,updated_at,updated_by&course_id=eq." + encodeURIComponent(courseId) + "&limit=1");
  const row = Array.isArray(rows) ? rows[0] : null;
  return {
    features: normalizeOverlayFeatures(row ? row.features : []),
    updatedAt: row ? row.updated_at : null,
    updatedBy: row ? row.updated_by : null
  };
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
    const body = { courseId, course, overlay, summary: overlaySummary(overlay.features) };
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
  let raw = payload && Array.isArray(payload.features) ? payload.features : [];
  let converted = null;
  if (payload && payload.georef) {
    converted = aiShapesToOverlay(raw, payload.georef, { units: payload.units });
    if (converted.error) return json(400, { error: "bad georef", detail: converted.error });
    raw = converted.features;
    if (payload.append) {
      const saved = await loadOverlay(courseId);
      /* Saved ids win: a re-run over the same picture replaces its own earlier shapes rather
         than stacking a second copy under a fresh id. */
      const incoming = new Set(raw.map(f => f.id));
      raw = saved.features.filter(f => !incoming.has(f.id)).concat(raw);
    }
  }
  if (raw.length > OVERLAY_MAX_FEATURES) return json(400, { error: "too many features", detail: "At most " + OVERLAY_MAX_FEATURES + " features per course." });
  const features = normalizeOverlayFeatures(raw);
  /* Features the caller sent but that did not survive normalisation are reported, not
     silently dropped: a two-point "fairway" is a drawing slip the operator wants to hear about. */
  const dropped = raw.length - features.length + (converted ? converted.dropped.length : 0);

  if (!features.length) {
    await supabaseFetch(TABLE + "?course_id=eq." + encodeURIComponent(courseId), { method: "DELETE" });
    return json(200, { courseId, overlay: { features: [], updatedAt: null, updatedBy: null }, summary: overlaySummary([]), dropped, deleted: true });
  }
  const now = new Date().toISOString();
  const written = await supabaseFetch(TABLE + "?on_conflict=course_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ course_id: courseId, features, updated_by: admin, updated_at: now })
  });
  const row = Array.isArray(written) ? written[0] : null;
  return json(200, {
    courseId,
    overlay: { features, updatedAt: row ? row.updated_at : now, updatedBy: admin },
    summary: overlaySummary(features),
    dropped,
    converted: converted ? { georef: converted.georef, dropped: converted.dropped, pixels: converted.pixels } : undefined
  });
}

export const config = {
  path: "/api/course-map-overlay"
};

function json(status, body) {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept,Authorization"
    }
  });
}
