/* What deleted courses left behind, and a button to clear it.
 *
 * GET  /api/course-orphans            -> every course id owning rows or files with
 *                                        no course_maps row, with counts and size
 * POST /api/course-orphans {courseId} -> purge that one course's leftovers
 *
 * Admin only, verified the same way course-maps.mjs verifies a delete: the bearer
 * token is exchanged at /auth/v1/user and the resulting email checked against the
 * allowlist. The client's claimed email is never trusted.
 *
 * This exists because leftovers are not cosmetic. A published course_visuals row
 * whose course_maps row is gone made /api/course-package answer "full-map-ready"
 * for a null map and 502 for that course id - and nothing in the app could show
 * that state, let alone clear it. */

import { findOrphans, purgeCourseData, formatBytes } from "./lib/gd-course-cleanup.mjs";

const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function serviceKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function anonKey() { return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY"); }

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

async function adminEmail(request, payload) {
  const bearer = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const token = bearer || String(payload && (payload.accessToken || payload.access_token) || "").trim();
  const base = supabaseBase();
  const key = anonKey() || serviceKey();
  if (!token || !base || !key) return "";
  try {
    const response = await fetch(base + "/auth/v1/user", {
      method: "GET", headers: { apikey: key, Authorization: "Bearer " + token }
    });
    if (!response.ok) return "";
    const user = await response.json();
    const verified = String(user && user.email || "").trim().toLowerCase();
    return user && user.id && ADMIN_EMAILS.has(verified) ? verified : "";
  } catch (error) {
    console.warn("course-orphans admin verification failed", error && error.message || error);
    return "";
  }
}

export default async function courseOrphans(request) {
  const base = supabaseBase();
  const key = serviceKey();
  if (!base || !key) return json(503, { error: "Supabase is not configured" });

  let payload = {};
  if (request.method === "POST") {
    try { payload = await request.json(); } catch (e) { payload = {}; }
  }
  const actor = await adminEmail(request, payload);
  if (!actor) return json(403, { error: "Admin sign-in required" });

  if (request.method === "GET") {
    try {
      const orphans = await findOrphans(base, key);
      return json(200, {
        ok: true,
        count: orphans.length,
        totalBytes: orphans.reduce((sum, o) => sum + o.bytes, 0),
        totalBytesLabel: formatBytes(orphans.reduce((sum, o) => sum + o.bytes, 0)),
        orphans: orphans.map(o => Object.assign({}, o, { bytesLabel: formatBytes(o.bytes) }))
      });
    } catch (error) {
      return json(502, { error: String(error && error.message || error).slice(0, 300) });
    }
  }

  if (request.method === "POST") {
    const courseId = String(payload && payload.courseId || "").trim();
    if (!courseId) return json(400, { error: "courseId is required" });
    /* Refuses to touch a live course. This endpoint clears leftovers; deleting a
       real course is course-maps.mjs's job and carries its own confirmation. */
    const orphans = await findOrphans(base, key).catch(() => null);
    if (!orphans) return json(502, { error: "Could not read current state" });
    if (!orphans.some(o => o.courseId === courseId)) {
      return json(409, { error: "Not an orphan - " + courseId + " either still has a course_maps row or has nothing left behind", courseId });
    }
    const result = await purgeCourseData(base, key, courseId);
    console.log("course-orphans: purged", courseId, "by", actor, JSON.stringify(result));
    return json(200, Object.assign({ ok: true, bytesLabel: formatBytes(result.bytes) }, result));
  }

  return json(405, { error: "Method not allowed" });
}

export const config = { path: "/api/course-orphans" };
