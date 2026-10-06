/* "Update Scorecards" - the post-scan admin action.
 *
 * A multi-course facility can publish correct geometry - Te Arai's two 18s both
 * resolved and published cleanly - and still carry provisional names, "Course 1"
 * and "Course 2", because naming needs a scorecard for EACH course and the scan
 * that found the geometry may only have found one card, or none. Re-scanning to
 * fix a label would be wrong twice over: it repeats expensive Overpass/geometry
 * work the course does not need, and it risks the geometry the admin explicitly
 * does not want touched.
 *
 * This does the other half on its own: search more broadly for the facility's
 * scorecards (the shared engine in gd-scorecard-resolve.mjs, same one the mapper
 * worker uses), then hand what it finds to lib/gd-facility-scorecards, which
 * matches the cards against the geometry already published for each sibling
 * course and renames only when that match is confident. It never queries
 * Overpass, never writes objects_json/holes_json, never enqueues a
 * course_mapper_jobs row - see course-mapper-jobs.mjs for that path instead.
 *
 * POST /api/course-scorecard-update  { courseId }   - admin-auth gated
 */

import { resolveScorecard, distinctCards, distinctCardCount, shouldReplaceFacilityCard } from "./lib/gd-scorecard-resolve.mjs";
import { loadFacilityChildren, facilityNameOf, fetchFacilityRows, cardsFromRows, storeFacilityCards, relabelFacility } from "./lib/gd-facility-scorecards.mjs";
import politeFetch from "./lib/gd-polite-fetch.js";
import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";
const { createPoliteHtmlFetcher } = politeFetch;

const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);
const RESOLVE_BUDGET_MS = 12000;

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function anonKey() { return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || ""; }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }

const supabaseFetch = createSupabaseFetch({
  base: supabaseBase,
  key: supabaseKey,
  label: "course-scorecard-update"
});

/* Same proof-of-identity rule as course-maps.mjs/course-mapper-jobs.mjs: the
   caller's Supabase access token is verified against /auth/v1/user, and only the
   verified email is trusted - a body-supplied actor cannot grant admin. */
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
    console.warn("scorecard update admin verification failed", error && error.message || error);
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
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept,Authorization"
    }
  });
}

/* Same well-mannered page reader the mapper worker uses - see lib/gd-polite-fetch. */
const fetchPageHtml = createPoliteHtmlFetcher();

async function searchScorecardPages(name, region, origin, signal) {
  if (!origin) return [];
  const response = await fetch(origin + "/.netlify/functions/scorecard-search", {
    method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, region })
  });
  if (!response.ok) return [];
  const payload = await response.json().catch(() => null);
  return ((payload && payload.results) || []).map(result => ({ url: result.url, name: result.title || "" }));
}

export default async function courseScorecardUpdate(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!hasSupabase()) return json(503, { error: "Not configured" });

  let payload;
  try { payload = await req.json(); } catch (error) { return json(400, { error: "Invalid JSON" }); }

  const adminEmail = await verifiedAdminEmail(req, payload);
  if (!adminEmail) return json(403, { error: "Admin session required" });

  const courseId = String((payload && payload.courseId) || "").trim();
  if (!courseId) return json(400, { error: "courseId required" });

  const facility = await loadFacilityChildren(supabaseFetch, courseId).catch(() => null);
  if (!facility) return json(404, { error: "No published course found for " + courseId });
  const { facilityKey, children } = facility;
  const want = children.length;

  const pinned = children.find(row => row.course_id === courseId) || children[0];
  const facilityName = facilityNameOf(pinned, courseId);

  let cards = cardsFromRows(await fetchFacilityRows(supabaseFetch, facilityKey));
  let acquireReason = null;
  if (distinctCardCount(cards) < want) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), RESOLVE_BUDGET_MS) : null;
    const origin = new URL(req.url).origin;
    try {
      const resolved = await resolveScorecard(
        { courseName: facilityName, region: pinned.region, country: pinned.country },
        {
          fetchHtml: url => fetchPageHtml(url, controller ? controller.signal : undefined),
          search: (name, region) => searchScorecardPages(name, region, origin, controller ? controller.signal : undefined),
          /* A scrape never overwrites a confirmed or high-confidence row. */
          writeStore: (key, name, foundCards) => storeFacilityCards(supabaseFetch, {
            cards: foundCards, name, facilityKey, filter: shouldReplaceFacilityCard
          })
        },
        { want }
      );
      acquireReason = resolved.reason || null;
      /* Merge rather than replace - a facility whose store already had the North
         card should not lose it just because this run's own read of `cards`
         happened before the write above landed. */
      cards = distinctCards(cards.concat(resolved.cards || []));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const relabel = await relabelFacility(supabaseFetch, { children, cards });
  return json(200, Object.assign({ facilityKey }, relabel, { reason: acquireReason || relabel.reason || null }));
}

export const config = {
  path: "/api/course-scorecard-update"
};
