/* "Organise facility" - phase 1 of FACILITY_ORGANISE_PLAN_2026-10-01.md.
 *
 * Reads every published course under a facility and every card stored for it, asks
 * planFacilityOrganise (lib/gd-facility-organise-core.mjs) what each card describes, applies
 * the renames it is confident about, and stores the whole plan - including the combinations,
 * splits and unexplained courses that wait for phase 2 and an admin's approval.
 *
 * It finds no new cards (Update Scorecards does that), never touches geometry, never enqueues
 * a mapping run and never changes a course_id.
 *
 * POST /api/facility-organise  { courseId, apply? }  - admin-auth gated. apply:false is a dry run.
 * GET  /api/facility-organise?courseId=…             - the latest stored plan for that facility. */

import { planFacilityOrganise } from "./lib/gd-facility-organise-core.mjs";
import { courseLengthsFromPublishedGeometry } from "./lib/gd-scorecard-match-core.mjs";
import { renamePatch } from "./lib/gd-course-rename-core.mjs";
import { splitCourseName } from "./lib/gd-automapper-core.mjs";
import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";

const MAPS_TABLE = "course_maps";
const SCORECARDS_TABLE = "course_scorecards";
const RUNS_TABLE = "facility_organise_runs";
const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function anonKey() { return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || ""; }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }

const supabaseFetch = createSupabaseFetch({ base: supabaseBase, key: supabaseKey, label: "facility-organise" });

/* Same proof-of-identity rule as course-scorecard-update.mjs: only an email verified against
   /auth/v1/user is trusted. */
async function verifiedAdminEmail(req, payload) {
  const header = String((req && req.headers && typeof req.headers.get === "function" && req.headers.get("authorization")) || "");
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const token = bearer || String(payload && (payload.accessToken || payload.access_token) || "").trim();
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

const ROW_COLUMNS = "course_id,course_name,course_aliases,facility_key,facility_name,hole_count,holes_json,objects_json,published";

async function loadFacility(courseId) {
  const rows = await supabaseFetch(MAPS_TABLE + "?select=" + ROW_COLUMNS + "&course_id=eq." + encodeURIComponent(courseId) + "&limit=1");
  const asked = Array.isArray(rows) ? rows[0] : null;
  if (!asked) return null;
  const facilityKey = asked.facility_key || asked.course_id;
  const members = asked.facility_key
    ? await supabaseFetch(MAPS_TABLE + "?select=" + ROW_COLUMNS + "&facility_key=eq." + encodeURIComponent(facilityKey) + "&published=eq.true")
    : [asked];
  const children = (Array.isArray(members) ? members : []).filter(row => row && row.course_id);
  if (!children.some(row => row.course_id === asked.course_id)) children.push(asked);
  const pinned = children.find(row => row.course_id === facilityKey) || asked;
  const facilityName = children.map(row => row.facility_name).find(Boolean)
    || splitCourseName(pinned.course_name || "").facility || pinned.course_name || facilityKey;
  return { facilityKey, facilityName, children };
}

async function loadCards(facilityKey) {
  const rows = await supabaseFetch(SCORECARDS_TABLE + "?select=course_key,course_name,holes_json&facility_key=eq." + encodeURIComponent(facilityKey)).catch(() => []);
  return (Array.isArray(rows) ? rows : [])
    .filter(row => Array.isArray(row.holes_json) && row.holes_json.length)
    .map(row => ({
      name: row.course_name,
      holes: row.holes_json.map(hole => ({ hole: hole.hole, par: hole.par, distanceM: hole.metres ?? hole.distanceM ?? null }))
    }));
}

function holeCountOf(row) {
  const fromHoles = Object.keys(row.holes_json || {}).length;
  return fromHoles || Number(row.hole_count) || 0;
}

export async function organiseFacility(courseId, { apply = true, actor = "" } = {}) {
  const facility = await loadFacility(courseId);
  if (!facility) return { status: 404, body: { error: "No published course found for " + courseId } };
  const cards = await loadCards(facility.facilityKey);
  const plan = planFacilityOrganise({
    facilityKey: facility.facilityKey,
    facilityName: facility.facilityName,
    rows: facility.children.map(row => ({
      courseId: row.course_id, name: row.course_name, aliases: row.course_aliases || [],
      holeCount: holeCountOf(row), lengths: courseLengthsFromPublishedGeometry(row.objects_json)
    })),
    cards
  });

  const applied = [];
  if (apply) {
    for (const change of plan.changes) {
      if (change.type !== "rename" || !change.auto) continue;
      const row = facility.children.find(child => child.course_id === change.courseId);
      /* renamePatch re-checks the rule against the row as it stands, and keeps the old name
         as an alias so nothing that referred to it is lost. */
      const patch = row && renamePatch(row, change.to);
      if (!patch) continue;
      await supabaseFetch(MAPS_TABLE + "?course_id=eq." + encodeURIComponent(row.course_id), {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch)
      });
      applied.push({ type: "rename", courseId: row.course_id, from: row.course_name, to: patch.course_name });
    }
    await supabaseFetch(RUNS_TABLE, {
      method: "POST", headers: { Prefer: "return=minimal" },
      body: JSON.stringify([{ facility_key: facility.facilityKey, plan, applied, requested_by: actor || null }])
    }).catch(error => console.warn("facility-organise: could not store the run", error && error.message || error));
  }

  return { status: 200, body: { facilityKey: facility.facilityKey, facilityName: facility.facilityName, plan, applied, message: messageFor(plan, applied, apply) } };
}

function messageFor(plan, applied, apply) {
  if (!plan.summary.cards) return "No course cards stored for this facility yet. Run Update Scorecards first.";
  const parts = [];
  parts.push(apply ? applied.length + " course" + (applied.length === 1 ? "" : "s") + " renamed" : plan.summary.renames + " rename" + (plan.summary.renames === 1 ? "" : "s") + " ready");
  if (plan.summary.waiting) parts.push(plan.summary.waiting + " change" + (plan.summary.waiting === 1 ? "" : "s") + " waiting for approval");
  return parts.join(", ") + ".";
}

export default async function facilityOrganise(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (!hasSupabase()) return json(503, { error: "Not configured" });

  let payload = {};
  if (req.method === "POST") {
    try { payload = await req.json(); } catch (error) { return json(400, { error: "Invalid JSON" }); }
  } else if (req.method !== "GET") {
    return json(405, { error: "Method not allowed" });
  }
  const adminEmail = await verifiedAdminEmail(req, payload);
  if (!adminEmail) return json(403, { error: "Admin session required" });

  const url = new URL(req.url);
  const courseId = String((payload && payload.courseId) || url.searchParams.get("courseId") || "").trim();
  if (!courseId) return json(400, { error: "courseId required" });

  if (req.method === "GET") {
    const facility = await loadFacility(courseId).catch(() => null);
    if (!facility) return json(404, { error: "No published course found for " + courseId });
    const runs = await supabaseFetch(RUNS_TABLE + "?select=plan,applied,requested_by,created_at&facility_key=eq." + encodeURIComponent(facility.facilityKey) + "&order=created_at.desc&limit=1").catch(() => []);
    return json(200, { facilityKey: facility.facilityKey, run: Array.isArray(runs) && runs[0] ? runs[0] : null });
  }

  const result = await organiseFacility(courseId, { apply: payload.apply !== false, actor: "admin:" + adminEmail });
  return json(result.status, result.body);
}

export const config = {
  path: "/api/facility-organise"
};
