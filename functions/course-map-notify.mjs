/* "Email me when this course is ready."

   When a player's course scan fails, the app offers to tell them when the map is done
   (scripts/gd-course-map-notify.js). A signed-in player's tap lands here as
   POST {courseId, courseName} with their Supabase bearer token; the request is stored against
   their verified user id and email - never an address the browser supplies - in
   course_map_notify_requests, one row per player per course.

   Sending is not done here. sendReadyCourseMapNotifications() is run by
   course-mapper-sweeper.mjs every 3 minutes: it asks buildCoursePackage() - the same readiness
   answer the app itself plays from - whether each waiting course now has a playable map, and
   emails everyone waiting on one that does. Checking readiness rather than hooking the mapper
   worker means a course fixed by hand in Studio notifies people exactly like one a later scan
   fixed. */

import { buildCoursePackage } from "./course-package.mjs";
import emailNotification from "./email-notification.js";
import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";

const TABLE = "course_map_notify_requests";
/* A player can wait on a handful of courses, not the whole directory: every pending course
   costs the sweeper a package read on every run. */
const MAX_PENDING_PER_USER = 20;
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
function slug(value) { return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90); }
function text(value, limit) { const input = String(value || "").trim(); return input.length > limit ? input.slice(0, limit) : input; }

async function verifiedUser(req) {
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
  const user = await verifiedUser(req);
  if (!user) return json(401, { error: "Sign in to get notified" });
  let payload = {};
  try { payload = await req.json(); } catch (error) { return json(400, { error: "Invalid JSON" }); }
  const courseId = slug(payload && (payload.courseId || payload.course_id));
  if (!courseId) return json(400, { error: "courseId required" });
  const courseName = text(payload.courseName, 160);

  try {
    const pending = await supabaseFetch(TABLE + "?select=course_id&user_id=eq." + encodeURIComponent(user.id) + "&notified_at=is.null&limit=" + (MAX_PENDING_PER_USER + 1));
    const list = Array.isArray(pending) ? pending : [];
    if (list.length >= MAX_PENDING_PER_USER && !list.some(row => row.course_id === courseId)) {
      return json(429, { error: "You're already waiting on " + MAX_PENDING_PER_USER + " courses" });
    }
    /* An upsert, so asking again is harmless, and asking again after being told re-arms the
       row: notified_at goes back to null. */
    await supabaseFetch(TABLE + "?on_conflict=course_id,user_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        course_id: courseId,
        course_name: courseName || null,
        user_id: user.id,
        email: user.email,
        recipient_name: user.name || null,
        created_at: new Date().toISOString(),
        notified_at: null
      })
    });
    return json(200, { requested: true, courseId, email: user.email });
  } catch (error) {
    console.warn("course-map-notify: could not save request", error && error.message || error);
    return json(502, { error: "Could not save your request" });
  }
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
  const byCourse = new Map();
  for (const row of rows) {
    if (!byCourse.has(row.course_id)) byCourse.set(row.course_id, []);
    byCourse.get(row.course_id).push(row);
  }
  let sent = 0, failed = 0;
  for (const [courseId, waiting] of byCourse) {
    let pkg = null;
    try { pkg = await buildCoursePackage(courseId); } catch (error) { pkg = null; }
    if (!pkg || !READY_STATUSES.has(pkg.status)) continue;
    const courseName = (waiting.find(row => row.course_name) || {}).course_name || "";
    for (const row of waiting) {
      let result;
      try {
        result = await emailNotification.sendCourseMapReadyEmail({ to: row.email, recipientName: row.recipient_name, courseName });
      } catch (error) {
        failed++;
        console.warn("course-map-notify: send failed for " + courseId, error && error.status, error && error.message);
        /* A rejection the provider will repeat (a bad address) is stamped so it is not retried
           every three minutes forever. Rate limits and outages stay pending for the next run. */
        const status = Number(error && error.status) || 0;
        if (status >= 400 && status < 500 && status !== 429) await markNotified(row.id);
        continue;
      }
      /* Email not configured: leave the row waiting rather than claim it was sent. */
      if (!result || !result.sent) { failed++; continue; }
      await markNotified(row.id);
      sent++;
    }
  }
  return { checked: byCourse.size, sent, failed };
}

async function markNotified(id) {
  try {
    await supabaseFetch(TABLE + "?id=eq." + encodeURIComponent(id), {
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
