/* The overlay row and the course it belongs to, for the functions that write it.
 *
 * Two endpoints write course_map_overlays - the overlay API (a person's shapes, or an AI's
 * shapes already in pixels) and the AI scan (the same shapes, produced server-side). One
 * store, so "what a save means" (normalise, append or replace, empty deletes the row, who
 * saved it) is decided in one place and cannot drift between them. Admin verification lives
 * here too for the same reason: both endpoints must prove the caller the same way.
 *
 * Service role only: nothing in the browser reads this table. */

import { createSupabaseFetch } from "./gd-supabase-fetch.mjs";
import { normalizeOverlayFeatures, overlaySummary, OVERLAY_MAX_FEATURES } from "./gd-map-overlay-core.mjs";
import { normalizePlayOrders } from "./gd-play-order-core.mjs";

export const OVERLAYS_TABLE = "course_map_overlays";
const MAPS_TABLE = "course_maps";
const SCORECARDS_TABLE = "course_scorecards";
const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);

function env(name) { return process.env[name] || ""; }
export function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
export function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function anonKey() { return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || ""; }
export function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }
export function slug(value) { return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90); }

export const supabaseFetch = createSupabaseFetch({ base: supabaseBase, key: supabaseKey, label: "course-map-overlay" });

/* Same proof as course-maps.mjs: the bearer token is checked against /auth/v1/user and only
   the email that comes back can be an admin. Nothing in the body can grant it. */
export async function verifiedAdminEmail(req) {
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

/* Any real signed-in identity, by the same proof: the user id /auth/v1/user answers for the
   bearer token, or "". */
export async function verifiedUserId(req) {
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
    return user && user.id ? String(user.id) : "";
  } catch (error) {
    return "";
  }
}

export async function loadCourse(courseId) {
  const rows = await supabaseFetch(MAPS_TABLE + "?select=course_id,course_name,course_lat,course_lng&course_id=eq." + encodeURIComponent(courseId) + "&limit=1");
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  const lat = Number(row.course_lat), lng = Number(row.course_lng);
  return { courseId: row.course_id, name: row.course_name || "", lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null };
}

/* The shared scorecard for a course, the same row the mapper reads, keyed the same way
   (scorecardCourseKey). Null when there is none - callers treat that as "no distances to
   give", never as an error. */
export async function loadScorecard(courseName, scorecardCourseKey) {
  const key = scorecardCourseKey(courseName);
  if (!key) return null;
  try {
    const rows = await supabaseFetch(SCORECARDS_TABLE + "?select=holes_json,source,source_url&course_key=eq." + encodeURIComponent(key) + "&limit=1");
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || !Array.isArray(row.holes_json) || !row.holes_json.length) return null;
    return { holes: row.holes_json, source: row.source || "", sourceUrl: row.source_url || "" };
  } catch (e) {
    return null;
  }
}

export async function loadOverlay(courseId) {
  const rows = await supabaseFetch(OVERLAYS_TABLE + "?select=features,play_orders,status,updated_at,updated_by,ai_scan,course_map&course_id=eq." + encodeURIComponent(courseId) + "&limit=1");
  const row = Array.isArray(rows) ? rows[0] : null;
  return {
    features: normalizeOverlayFeatures(row ? row.features : []),
    playOrders: normalizePlayOrders(row ? row.play_orders : [], courseId),
    status: overlayStatus(row && row.status),
    updatedAt: row ? row.updated_at : null,
    updatedBy: row ? row.updated_by : null,
    aiScan: row && row.ai_scan && typeof row.ai_scan === "object" ? row.ai_scan : null,
    courseMap: row && row.course_map && typeof row.course_map === "object" ? row.course_map : null
  };
}

/* Draft or ready (supabase/migrations/20260929_add_course_map_overlay_status.sql). Anything
   that is not plainly "ready" is a draft - the mapper must never read a session nobody signed
   off because a value was missing or misspelt. */
export function overlayStatus(value) { return value === "ready" ? "ready" : "draft"; }

/* Marks the saved overlay ready (or back to draft) without touching its shapes. Refused when
   there is nothing saved: an empty overlay is no row, and "ready" with no shapes and no play
   orders means nothing. */
export async function writeOverlayStatus(courseId, status) {
  const saved = await loadOverlay(courseId);
  if (!saved.features.length && !saved.playOrders.length) return { error: "nothing to mark", detail: "Place some shapes or make a play order first - there is no saved overlay for this course." };
  const now = new Date().toISOString();
  await supabaseFetch(OVERLAYS_TABLE + "?course_id=eq." + encodeURIComponent(courseId), {
    method: "PATCH",
    body: JSON.stringify({ status: overlayStatus(status), updated_at: now })
  });
  return { courseId, status: overlayStatus(status), updatedAt: now };
}

/* The club's course map for this course, or null to remove it. {mediaType, data (base64),
   name, width, height}. Stored on the overlay row like the scan state - one row per course,
   created if the course has no overlay yet - and read by the AI scan as its second image. */
const COURSE_MAP_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const COURSE_MAP_MAX_CHARS = 1500000;
export function normalizeCourseMap(raw) {
  if (!raw || typeof raw !== "object") return null;
  const mediaType = String(raw.mediaType || "").toLowerCase();
  const data = String(raw.data || "").replace(/^data:[^,]+,/, "");
  if (!COURSE_MAP_TYPES.has(mediaType) || !data || data.length > COURSE_MAP_MAX_CHARS) return null;
  return {
    mediaType, data,
    name: String(raw.name || "").slice(0, 80),
    width: Number.isFinite(Number(raw.width)) ? Math.round(Number(raw.width)) : null,
    height: Number.isFinite(Number(raw.height)) ? Math.round(Number(raw.height)) : null,
    savedAt: new Date().toISOString()
  };
}
export async function writeCourseMap(courseId, courseMap) {
  await supabaseFetch(OVERLAYS_TABLE + "?on_conflict=course_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ course_id: courseId, course_map: courseMap })
  });
  return courseMap;
}
/* What a caller is told about the map: everything but the picture. */
export function publicCourseMap(courseMap) {
  if (!courseMap) return null;
  const out = Object.assign({}, courseMap);
  delete out.data;
  return out;
}

/* Saves a feature list as the course's overlay. append:true keeps what is saved and adds
   these, incoming ids winning over saved ones (a re-run over the same picture replaces its
   own earlier shapes rather than stacking a second copy). playOrders, when given, replaces the
   saved play orders; left out (the AI scan) they are kept as they are. An overlay with no
   shapes and no play orders deletes the row: "no overlay" is the absence of a row, not a row
   holding []. Every save puts the overlay back to draft: a shape or play order changed after
   sign-off has not been signed off. Returns the API's response shape so both endpoints answer
   identically. */
export async function saveOverlay({ courseId, features: raw, playOrders: rawOrders, savedBy, append }) {
  let list = Array.isArray(raw) ? raw : [];
  if (append) {
    const saved = await loadOverlay(courseId);
    const incoming = new Set(list.map(f => f && f.id));
    list = saved.features.filter(f => !incoming.has(f.id)).concat(list);
  }
  if (list.length > OVERLAY_MAX_FEATURES) return { error: "too many features", detail: "At most " + OVERLAY_MAX_FEATURES + " features per course." };
  const features = normalizeOverlayFeatures(list);
  /* Features the caller sent but that did not survive normalisation are reported, not
     silently dropped: a two-point "fairway" is a drawing slip the operator wants to hear about. */
  const dropped = list.length - features.length;
  const playOrders = Array.isArray(rawOrders) ? normalizePlayOrders(rawOrders, courseId) : (await loadOverlay(courseId)).playOrders;
  if (!features.length && !playOrders.length) {
    await supabaseFetch(OVERLAYS_TABLE + "?course_id=eq." + encodeURIComponent(courseId), { method: "DELETE" });
    return { courseId, overlay: { features: [], playOrders: [], status: "draft", updatedAt: null, updatedBy: null }, summary: overlaySummary([]), dropped, deleted: true };
  }
  const now = new Date().toISOString();
  const written = await supabaseFetch(OVERLAYS_TABLE + "?on_conflict=course_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ course_id: courseId, features, play_orders: playOrders, status: "draft", updated_by: savedBy, updated_at: now })
  });
  const row = Array.isArray(written) ? written[0] : null;
  return { courseId, overlay: { features, playOrders, status: "draft", updatedAt: row ? row.updated_at : now, updatedBy: savedBy }, summary: overlaySummary(features), dropped };
}

/* The AI scan's state, on the same row, touching nothing else on it. The row is created if
   the course has no overlay yet; merge-duplicates updates only the columns given, so a
   status write never disturbs saved features. */
export async function writeAiScan(courseId, aiScan) {
  await supabaseFetch(OVERLAYS_TABLE + "?on_conflict=course_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ course_id: courseId, ai_scan: aiScan })
  });
  return aiScan;
}

export function json(status, body) {
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
