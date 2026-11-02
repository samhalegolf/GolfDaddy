/* "Email me when this course is ready."

   When a player's course scan fails, or comes back with holes missing, the app offers to tell
   them when the map is done (scripts/gd-course-map-notify.js). The player types the address
   they want told - no account needed - and the tap lands here as POST {courseId, courseName,
   email}. The request is stored in course_map_notify_requests, one row per address per
   course. A signed-in player's bearer token, when the app has one, links the row to their
   user id as well; a bad or missing token just leaves it unlinked.

   Sending is not done here. sendReadyCourseMapNotifications() is run by
   course-mapper-sweeper.mjs every 3 minutes: it asks buildCoursePackage() - the same readiness
   answer the app itself plays from - whether each waiting course now has a COMPLETE playable
   map, and emails everyone waiting on one that does. Complete, not merely published: a scan
   that resolved 17 of 18 holes publishes what it found (Sugar Ridge, 2026-10-12), and the
   player who asked to hear when the course is ready was looking at exactly that map when they
   asked. Checking readiness rather than hooking the mapper worker means a course fixed by hand
   in Studio notifies people exactly like one a later scan fixed.

   An address with no Clarity account is asked to sign up in that email: the course is ready,
   and an account is how they play it.

   The same POST with {kind: "garmin"} is "email me when my Garmin map is ready": offered by
   the app when a Garmin asked for a course whose Garmin package is still being built (a
   course mapped and teed off on in the same minute - Springfield, 2026-11-02). It is only
   stored when the server agrees a build is under way: the course has a published map and no
   usable Garmin package yet. Those rows live in garmin_map_notify_requests, and
   sendReadyGarminMapNotifications() emails them from the same sweep once course_garmin_maps
   holds a package a watch can be sent. */

import { buildCoursePackage } from "./course-package.mjs";
import emailNotification from "./email-notification.js";
import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";
import authUtils from "./auth-utils.js";
import { courseSlug } from "./lib/gd-course-slug.mjs";

const TABLE = "course_map_notify_requests";
const GARMIN_TABLE = "garmin_map_notify_requests";
/* An address can wait on a handful of courses, not the whole directory: every pending course
   costs the sweeper a package read on every run. */
const MAX_PENDING_PER_EMAIL = 20;
/* Courses checked per sweep. The oldest requests go first, so a backlog drains in order. */
const SWEEP_BATCH = 200;
const READY_STATUSES = new Set(["lite-geo-ready", "full-map-ready"]);

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function anonKey() { return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || ""; }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }

const supabaseFetch = createSupabaseFetch({ base: supabaseBase, key: supabaseKey, label: "course-map-notify" });

/* Same id normalisation course-package.mjs applies, so the row and the package agree on
   which course this is. */
function slug(value) { return courseSlug(value).slice(0, 90); }
function text(value, limit) { const input = String(value || "").trim(); return input.length > limit ? input.slice(0, limit) : input; }
export function cleanEmail(value) { const input = text(value, 240).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? input : ""; }

export async function verifiedUser(req) {
  const header = String((req && req.headers && typeof req.headers.get === "function" && req.headers.get("authorization")) || "");
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const base = supabaseBase();
  const key = anonKey() || supabaseKey();
  if (!base || !key) return null;
  try {
    const response = await fetch(base + "/auth/v1/user", { method: "GET", headers: { apikey: key, Authorization: "Bearer " + token } });
    if (!response.ok) return null;
    const user = await response.json();
    const email = String(user && user.email || "").trim().toLowerCase();
    if (!user || !user.id || !email) return null;
    const meta = user.user_metadata || {};
    return { id: String(user.id), email, name: text(meta.name || meta.full_name, 120) };
  } catch (error) {
    return null;
  }
}

export default async function courseMapNotify(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  let payload = {};
  try { payload = await req.json(); } catch (error) { return json(400, { error: "Invalid JSON" }); }
  const courseId = slug(payload && (payload.courseId || payload.course_id));
  if (!courseId) return json(400, { error: "courseId required" });
  const email = cleanEmail(payload && payload.email);
  if (!email) return json(400, { error: "Enter a valid email address" });
  const courseName = text(payload.courseName, 160);
  const garmin = payload.kind === "garmin";
  const table = garmin ? GARMIN_TABLE : TABLE;
  const user = await verifiedUser(req);

  if (garmin) {
    let state;
    try { state = await garminBuildState(courseId); } catch (error) {
      console.warn("course-map-notify: could not check the Garmin build", error && error.message || error);
      return json(502, { error: "Could not save your request" });
    }
    /* Already built between the phone asking and the player tapping: nothing to wait for. */
    if (state === "ready") return json(200, { requested: false, ready: true, courseId });
    if (state !== "building") return json(409, { error: "This course has no map to build a Garmin map from yet" });
  }

  try {
    const pending = await supabaseFetch(table + "?select=course_id&email=eq." + encodeURIComponent(email) + "&notified_at=is.null&limit=" + (MAX_PENDING_PER_EMAIL + 1));
    const list = Array.isArray(pending) ? pending : [];
    if (list.length >= MAX_PENDING_PER_EMAIL && !list.some(row => row.course_id === courseId)) {
      return json(429, { error: "That address is already waiting on " + MAX_PENDING_PER_EMAIL + " courses" });
    }
    /* An upsert, so asking again is harmless, and asking again after being told re-arms the
       row: notified_at goes back to null. */
    await supabaseFetch(table + "?on_conflict=course_id,email", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        course_id: courseId,
        course_name: courseName || null,
        user_id: user ? user.id : null,
        email,
        recipient_name: user && user.name || null,
        created_at: new Date().toISOString(),
        notified_at: null
      })
    });
    return json(200, { requested: true, courseId, email });
  } catch (error) {
    console.warn("course-map-notify: could not save request", error && error.message || error);
    return json(502, { error: "Could not save your request" });
  }
}

/* A Garmin package a watch can be sent: the same test the phone's GET applies before it
   hands a package over (course-watch-maps.mjs garminReport). */
const GARMIN_USABLE = "garmin_package_version=gt.0&ready_hole_count=gt.0";

/* "ready" (a usable Garmin package exists), "building" (the course has a published map and
   no usable package yet - the state the phone's GET answers "building" for), or "none". */
async function garminBuildState(courseId) {
  const id = encodeURIComponent(courseId);
  const [built, map] = await Promise.all([
    supabaseFetch("course_garmin_maps?select=course_id&course_id=eq." + id + "&" + GARMIN_USABLE + "&limit=1"),
    supabaseFetch("course_maps?select=course_id&course_id=eq." + id + "&published=eq.true&limit=1")
  ]);
  if (Array.isArray(built) && built.length) return "ready";
  return Array.isArray(map) && map.length ? "building" : "none";
}

/* Whether an address already has a Clarity account, so the ready email can say "open
   Clarity" to a player and "sign up" to everyone else. Unknown counts as no account: the
   worst case is a player being offered a sign-up form that recognises their address. */
async function hasAccount(address) {
  try { return !!(await authUtils.findAccountByEmail(address)); } catch (error) { return false; }
}

/* Run by the sweeper. Returns a small summary for its response body; never throws. */
export async function sendReadyCourseMapNotifications() {
  if (!hasSupabase()) return { checked: 0, sent: 0, reason: "no supabase" };
  let rows;
  try {
    rows = await supabaseFetch(TABLE + "?select=id,course_id,course_name,email,recipient_name&notified_at=is.null&order=created_at.asc&limit=" + SWEEP_BATCH);
  } catch (error) {
    return { checked: 0, sent: 0, reason: String(error && error.message || error).slice(0, 200) };
  }
  rows = Array.isArray(rows) ? rows : [];
  const byCourse = groupByCourse(rows);
  const tally = { sent: 0, failed: 0 };
  for (const [courseId, waiting] of byCourse) {
    let pkg = null;
    try { pkg = await buildCoursePackage(courseId); } catch (error) { pkg = null; }
    if (!pkg || !READY_STATUSES.has(pkg.status) || pkg.readiness !== "complete") continue;
    await emailWaiting(TABLE, courseId, waiting, emailNotification.sendCourseMapReadyEmail, tally);
  }
  return { checked: byCourse.size, sent: tally.sent, failed: tally.failed };
}

/* Run by the sweeper beside the course-ready pass. One read for every waiting course's Garmin
   package rather than one per course. Returns a small summary; never throws. */
export async function sendReadyGarminMapNotifications() {
  if (!hasSupabase()) return { checked: 0, sent: 0, reason: "no supabase" };
  let rows, built;
  try {
    rows = await supabaseFetch(GARMIN_TABLE + "?select=id,course_id,course_name,email,recipient_name&notified_at=is.null&order=created_at.asc&limit=" + SWEEP_BATCH);
    rows = Array.isArray(rows) ? rows : [];
    const byCourse = groupByCourse(rows);
    if (!byCourse.size) return { checked: 0, sent: 0, failed: 0 };
    const ids = [...byCourse.keys()].map(id => encodeURIComponent(id)).join(",");
    built = await supabaseFetch("course_garmin_maps?select=course_id&" + GARMIN_USABLE + "&course_id=in.(" + ids + ")");
    const ready = new Set((Array.isArray(built) ? built : []).map(row => row.course_id));
    const tally = { sent: 0, failed: 0 };
    for (const [courseId, waiting] of byCourse) {
      if (ready.has(courseId)) await emailWaiting(GARMIN_TABLE, courseId, waiting, emailNotification.sendGarminMapReadyEmail, tally);
    }
    return { checked: byCourse.size, sent: tally.sent, failed: tally.failed };
  } catch (error) {
    return { checked: 0, sent: 0, reason: String(error && error.message || error).slice(0, 200) };
  }
}

function groupByCourse(rows) {
  const byCourse = new Map();
  for (const row of rows) {
    if (!byCourse.has(row.course_id)) byCourse.set(row.course_id, []);
    byCourse.get(row.course_id).push(row);
  }
  return byCourse;
}

/* Emails everyone waiting on one ready course and stamps each row that went. */
async function emailWaiting(table, courseId, waiting, send, tally) {
  const courseName = (waiting.find(row => row.course_name) || {}).course_name || "";
  for (const row of waiting) {
    let result;
    try {
      result = await send({ to: row.email, recipientName: row.recipient_name, courseName, hasAccount: await hasAccount(row.email) });
    } catch (error) {
      tally.failed++;
      console.warn("course-map-notify: send failed for " + courseId, error && error.status, error && error.message);
      /* A rejection the provider will repeat (a bad address) is stamped so it is not retried
         every three minutes forever. Rate limits and outages stay pending for the next run. */
      const status = Number(error && error.status) || 0;
      if (status >= 400 && status < 500 && status !== 429) await markNotified(table, row.id);
      continue;
    }
    /* Email not configured: leave the row waiting rather than claim it was sent. */
    if (!result || !result.sent) { tally.failed++; continue; }
    await markNotified(table, row.id);
    tally.sent++;
  }
}

async function markNotified(table, id) {
  try {
    await supabaseFetch(table + "?id=eq." + encodeURIComponent(id), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ notified_at: new Date().toISOString() })
    });
  } catch (error) {
    console.warn("course-map-notify: could not stamp " + id, error && error.message || error);
  }
}

export const config = {
  path: "/api/course-map-notify",
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
