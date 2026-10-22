import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";
import { verifiedAdminEmail } from "./lib/gd-map-overlay-store.mjs";
import { courseVersion } from "./lib/gd-course-package-shape.mjs";
/* Course map usage: one anonymous +1 per POST, and an admin-only GET that reads the report
 * back for the Studio Course Usage page (scripts/studio/gd-admin-course-usage.js).
 *
 * POST body: {courseId, event, origin} plus, from current app builds, the optional
 * {mapType, outcome, version, waitMs, courseName} that say how the open went. Older
 * installs still send the first three only, and are counted with the rest blank.
 * The country comes from Netlify's own geo lookup on the request - the client
 * never sends it, and the IP it was derived from is never stored. No account,
 * guest id or user agent is read: this answers "which courses get used, how, and
 * from where", never "by whom". See the migrations 20261004_create_course_map_usage.sql
 * and 20261022_course_map_usage_detail.sql.
 *
 * Unauthenticated like client-errors.mjs, and for the same reason: guests play
 * too. Junk is bounded by the enums below and the table's own checks. A course id
 * with no map is counted on purpose - an open that found nothing is the case
 * most worth seeing.
 */

const EVENTS = new Set(["download", "update", "play", "delivery-failed"]);
const ORIGINS = new Set(["web", "ios", "android", "watch", "apple-watch", "garmin"]);
const MAP_TYPES = new Set(["", "full", "lite", "live"]);
const OUTCOMES = new Set(["", "cached", "ready", "prepared", "not-mapped", "failed", "timeout", "unreachable",
  "signup-required", "server-busy", "account-error", "no-package", "report-unavailable", "assets-failed", "error"]);
const VERSION = /^((W-)?v\d{1,6}\.\d{1,6})?$/;
const MAX_WAIT_MS = 10 * 60 * 1000;
const RANGES = new Set([7, 30, 90, 0]);

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }

const supabaseFetch = createSupabaseFetch({
  base: supabaseBase,
  key: supabaseKey,
  label: "course-usage"
});

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

function slug(value) { return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90); }

function countryOf(context) {
  const code = String((context && context.geo && context.geo.country && context.geo.country.code) || "").toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

/* The label a course would be handed now: its full map's if it has a published one, else
   the lite pack's (v0.N). Same rule as gd-course-package-shape.mjs, so "on the latest" on
   the page means exactly what the Course Library's "Update available" means. */
function currentVersionLabel(course) {
  const map = { objects_revision: course.objects_revision };
  const full = course.published_version && Number(course.bake_number) > 0
    ? courseVersion(map, { bake_number: course.bake_number, bake_objects_revision: course.bake_objects_revision })
    : null;
  const version = full || courseVersion(map, null);
  return version ? version.label : null;
}

/* GET (admin): course_map_usage_report for ?days=7|30|90|0 (0 = all time). */
async function readReport(req) {
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  if (!(await verifiedAdminEmail(req))) return json(403, { error: "Admin verification failed" });
  const asked = Number(new URL(req.url).searchParams.get("days"));
  const days = RANGES.has(asked) ? asked : 30;
  try {
    const report = await supabaseFetch("rpc/course_map_usage_report", {
      method: "POST",
      body: JSON.stringify({ p_days: days })
    });
    const courses = (report && Array.isArray(report.courses) ? report.courses : []).map(course => ({
      courseId: course.course_id,
      courseName: course.course_name || course.course_id,
      inDatabase: !!course.in_database,
      currentVersion: currentVersionLabel(course)
    }));
    return json(200, {
      days,
      rows: report && Array.isArray(report.rows) ? report.rows : [],
      daily: report && Array.isArray(report.daily) ? report.daily : [],
      courses,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return json(502, { error: "Could not read course usage", detail: String(error && error.message || error) });
  }
}

export default async function courseUsage(req, context) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method === "GET") return readReport(req);
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  /* Counting is never important enough to fail loudly. */
  if (!hasSupabase()) return json(202, { recorded: false, configured: false });

  let payload;
  try {
    const raw = await req.text();
    if (raw.length > 2048) return json(413, { error: "Payload too large" });
    payload = JSON.parse(raw || "{}");
  } catch (_error) {
    return json(400, { error: "Invalid JSON" });
  }

  const courseId = slug(payload && payload.courseId);
  const event = String((payload && payload.event) || "");
  const origin = String((payload && payload.origin) || "");
  if (!courseId || !EVENTS.has(event) || !ORIGINS.has(origin)) return json(400, { error: "courseId, event and origin required" });
  const mapType = String(payload.mapType || "");
  const outcome = String(payload.outcome || "");
  const version = String(payload.version || "");
  if (!MAP_TYPES.has(mapType) || !OUTCOMES.has(outcome) || !VERSION.test(version)) return json(400, { error: "Unknown mapType, outcome or version" });
  const wait = Math.round(Number(payload.waitMs));
  const waitMs = Number.isFinite(wait) ? Math.min(Math.max(wait, 0), MAX_WAIT_MS) : 0;
  const courseName = String(payload.courseName || "").replace(/\s+/g, " ").trim().slice(0, 120);

  try {
    await supabaseFetch("rpc/record_course_map_usage", {
      method: "POST",
      body: JSON.stringify({
        p_course_id: courseId, p_event: event, p_origin: origin, p_country: countryOf(context),
        p_map_type: mapType, p_outcome: outcome, p_version: version, p_wait_ms: waitMs, p_course_name: courseName
      })
    });
  } catch (_error) {
    return json(202, { recorded: false });
  }
  return json(200, { recorded: true });
}

export const config = {
  path: "/api/course-usage",
};
