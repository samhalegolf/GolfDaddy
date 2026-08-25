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
 * worker uses), match what it finds against the geometry already published for
 * each sibling course, and rename only when that match is confident. It never
 * queries Overpass, never writes objects_json/holes_json, never enqueues a
 * course_mapper_jobs row - see course-mapper-jobs.mjs for that path instead.
 *
 * POST /api/course-scorecard-update  { courseId }   - admin-auth gated
 */

import { resolveScorecard, distinctCards, distinctCardCount, facilityScorecardRow } from "./lib/gd-scorecard-resolve.mjs";
import { matchLoopsToCards, courseLengthsFromPublishedGeometry } from "./lib/gd-scorecard-match-core.mjs";
import { renamePatch } from "./lib/gd-course-rename-core.mjs";
import { splitCourseName } from "./lib/gd-automapper-core.mjs";
import pkg from "./lib/safe-remote-url.js";
const { safeRemoteUrl, resolvesToPublicAddress } = pkg;

const MAPS_TABLE = "course_maps";
const SCORECARDS_TABLE = "course_scorecards";
const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);
const RESOLVE_BUDGET_MS = 12000;

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function anonKey() { return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || ""; }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }

async function supabaseFetch(path, options = {}) {
  if (!hasSupabase()) throw new Error("Supabase is not configured");
  const headers = Object.assign({
    apikey: supabaseKey(),
    Authorization: "Bearer " + supabaseKey(),
    "Content-Type": "application/json"
  }, options.headers || {});
  const response = await fetch(supabaseBase() + "/rest/v1/" + path, Object.assign({}, options, { headers }));
  const bodyText = await response.text();
  let body = null;
  if (bodyText) { try { body = JSON.parse(bodyText); } catch (_e) { body = bodyText; } }
  if (!response.ok) {
    const error = new Error("Supabase request failed");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

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

async function fetchPageHtml(url, signal) {
  const target = safeRemoteUrl(url);
  if (!target) throw new Error("unsafe or unsupported url");
  if (!(await resolvesToPublicAddress(target))) throw new Error("url does not resolve to a public address");
  const response = await fetch(target.href, {
    signal, redirect: "follow",
    headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "ClarityCaddie/1.0 (+https://caddy.claritygolf.app)" }
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return (await response.text()).slice(0, 650000);
}

async function searchScorecardPages(name, region, origin, signal) {
  if (!origin) return [];
  const response = await fetch(origin + "/.netlify/functions/scorecard-search", {
    method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, region })
  });
  if (!response.ok) return [];
  const payload = await response.json().catch(() => null);
  return ((payload && payload.results) || []).map(result => ({ url: result.url, name: result.title || "" }));
}

/* Every distinct card stored under a facility - same shape and query as the
   worker's fetchFacilityScorecardEvidence, kept separate because this function
   does not share an HTTP client with the worker (deliberate, see course-package.
   mjs's header comment: every function here owns its own request plumbing). */
async function fetchFacilityCards(facilityKey) {
  if (!facilityKey) return [];
  const rows = await supabaseFetch(SCORECARDS_TABLE + "?select=course_key,course_name,holes_json,source,source_url,sources_json&facility_key=eq." + encodeURIComponent(facilityKey)).catch(() => []);
  return (Array.isArray(rows) ? rows : [])
    .filter(row => Array.isArray(row.holes_json) && row.holes_json.length)
    .map(row => ({ name: row.course_name, holes: row.holes_json, source: row.source, sourceUrl: row.source_url }));
}

async function loadFacilityChildren(courseId) {
  const rows = await supabaseFetch(
    MAPS_TABLE + "?select=course_id,course_name,course_lat,course_lng,facility_key,course_aliases,objects_json,holes_json,region,country,published&course_id=eq." + encodeURIComponent(courseId) + "&limit=1"
  );
  const pinned = Array.isArray(rows) ? rows[0] : null;
  if (!pinned) return null;
  const facilityKey = pinned.facility_key || pinned.course_id;
  if (!pinned.facility_key) return { facilityKey, children: [pinned] };
  const siblings = await supabaseFetch(
    MAPS_TABLE + "?select=course_id,course_name,course_lat,course_lng,facility_key,course_aliases,objects_json,holes_json,region,country,published&facility_key=eq." + encodeURIComponent(facilityKey) + "&published=eq.true"
  );
  const children = (Array.isArray(siblings) ? siblings : []).filter(row => row && row.course_id);
  /* The pinned row's own facility_key already equals facilityKey (the worker
     stamps it on every sibling including itself), so it is normally already in
     `children` - this only guards a row that predates that write. */
  if (!children.some(row => row.course_id === pinned.course_id)) children.push(pinned);
  return { facilityKey, children };
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

  const facility = await loadFacilityChildren(courseId).catch(() => null);
  if (!facility) return json(404, { error: "No published course found for " + courseId });
  const { facilityKey, children } = facility;
  const want = children.length;

  const pinned = children.find(row => row.course_id === courseId) || children[0];
  const facilityName = splitCourseName(pinned.course_name || "").facility || pinned.course_name || courseId;

  let cards = await fetchFacilityCards(facilityKey);
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
          writeStore: async (key, name, foundCards) => {
            const existing = await fetchFacilityRows(facilityKey);
            const rows = distinctCards(foundCards).map(card => facilityScorecardRow(card, name, facilityKey, existing)).filter(Boolean);
            if (!rows.length) return;
            await supabaseFetch(SCORECARDS_TABLE + "?on_conflict=course_key", {
              method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(rows)
            });
          }
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

  const distinct = distinctCardCount(cards);
  const loops = children.map(row => ({ id: row.course_id, lengths: courseLengthsFromPublishedGeometry(row.objects_json) }));
  /* matchLoopsToCards can confidently name ONE course from a single card even
     when the facility has two - "shorter side governs" is right for a resolver
     naming whatever it can, but wrong for a facility-level rename: a player
     seeing one sibling renamed to "North Course" while the other still reads
     "Course 2" is a worse, more confusing state than leaving both provisional.
     So evidence for every expected course is required before matching is even
     attempted, not only before the message is chosen. */
  const match = distinct >= want
    ? matchLoopsToCards(loops, distinctCards(cards))
    : { resolved: false, reason: "insufficient-evidence", assignment: [] };

  const renamed = [];
  if (match.resolved) {
    for (const pair of match.assignment) {
      const row = children.find(child => child.course_id === pair.loopId);
      if (!row || !pair.cardName) continue;
      const patch = renamePatch(row, pair.cardName);
      if (!patch) continue;
      await supabaseFetch(MAPS_TABLE + "?course_id=eq." + encodeURIComponent(row.course_id), {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch)
      });
      renamed.push({ courseId: row.course_id, from: row.course_name, to: patch.course_name });
    }
  }

  const message = distinct < want
    ? "Found " + distinct + " of " + want + " required course card" + (want === 1 ? "" : "s") + ". Labels unchanged."
    : !match.resolved
      ? distinct + " card" + (distinct === 1 ? "" : "s") + " found but match was not confident enough. Labels unchanged."
      : renamed.length
        ? "Found " + distinct + " distinct course card" + (distinct === 1 ? "" : "s") + ". Course labels updated."
        : "Found " + distinct + " distinct course card" + (distinct === 1 ? "" : "s") + ". Labels already up to date.";

  return json(200, {
    facilityKey, want, distinct, resolved: !!match.resolved,
    reason: acquireReason || match.reason || null,
    renamed, message
  });
}

async function fetchFacilityRows(facilityKey) {
  if (!facilityKey) return [];
  const rows = await supabaseFetch(SCORECARDS_TABLE + "?select=course_key,course_name,holes_json&facility_key=eq." + encodeURIComponent(facilityKey)).catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

export const config = {
  path: "/api/course-scorecard-update"
};
