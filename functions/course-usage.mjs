import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";
/* Course map usage intake: one anonymous +1 per call.
 *
 * Body: {courseId, event: "download"|"play", origin: "web"|"ios"|"android"|"watch"}.
 * The country comes from Netlify's own geo lookup on the request - the client
 * never sends it, and the IP it was derived from is never stored. No account,
 * guest id or user agent is read: this answers "which courses get used, and
 * from where", never "by whom". See the migration
 * 20261004_create_course_map_usage.sql.
 *
 * Unauthenticated like client-errors.mjs, and for the same reason: guests play
 * too. Junk is bounded by the enums below and by the database function only
 * counting course ids that exist in course_maps.
 */

const EVENTS = new Set(["download", "play"]);
const ORIGINS = new Set(["web", "ios", "android", "watch"]);

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
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept"
    }
  });
}

function slug(value) { return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90); }

function countryOf(context) {
  const code = String((context && context.geo && context.geo.country && context.geo.country.code) || "").toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

export default async function courseUsage(req, context) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
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

  try {
    await supabaseFetch("rpc/record_course_map_usage", {
      method: "POST",
      body: JSON.stringify({ p_course_id: courseId, p_event: event, p_origin: origin, p_country: countryOf(context) })
    });
  } catch (_error) {
    return json(202, { recorded: false });
  }
  return json(200, { recorded: true });
}

export const config = {
  path: "/api/course-usage",
};
