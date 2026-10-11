/* The card row on a course: which scorecards the resolver has for this facility, and
 * what each one is called.
 *
 * A card's name is what the resolver names a course from, so renaming a card here is
 * how an admin names the courses under a parent: "Course 2" becomes "Par 3", the card
 * row and the course it belongs to both take "Foyle Golf Club - Par 3". The card is
 * stored under its name (course_key), and a player's scorecard is looked up by the
 * course's name, so the two are renamed together or the lookup would miss.
 *
 * GET  /api/course-scorecards?courseId=      the facility's cards, oldest first
 * POST /api/course-scorecards { courseId, key, label }   rename one card
 *   admin-auth gated, like the upload beside it. */

import { loadFacilityChildren, facilityNameOf, fetchFacilityRows, cardsFromRows, relabelFacility, SCORECARDS_TABLE, MAPS_TABLE } from "./lib/gd-facility-scorecards.mjs";
import { distinctCards, scorecardCourseKey, facilityCardLabel, facilityCardFullName } from "./lib/gd-scorecard-resolve.mjs";
import { verifiedAdminEmail } from "./lib/gd-map-overlay-store.mjs";
import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }

const supabaseFetch = createSupabaseFetch({
  base: supabaseBase,
  key: supabaseKey,
  label: "course-scorecards"
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

/* One card as the row shows it. */
export function describeCard(row, facilityName) {
  const holes = Array.isArray(row.holes_json) ? row.holes_json : [];
  return {
    key: row.course_key,
    name: row.course_name || "",
    label: facilityCardLabel(row.course_name, facilityName),
    holes: holes.length,
    par: holes.reduce((sum, hole) => sum + (Number(hole.par) || 0), 0),
    source: row.source || "",
    updatedAt: row.updated_at || null
  };
}

async function listCards(facilityKey, facilityName) {
  const rows = await supabaseFetch(SCORECARDS_TABLE + "?select=course_key,course_name,holes_json,source,updated_at,created_at&facility_key=eq."
    + encodeURIComponent(facilityKey) + "&order=created_at.asc");
  return (Array.isArray(rows) ? rows : [])
    .filter(row => Array.isArray(row.holes_json) && row.holes_json.length)
    .map(row => describeCard(row, facilityName));
}

/* The course a card belongs to by name - the one the player's lookup would find it
   under. A provisional course ("Course 2 - 2198m East") has no such card; matching
   by geometry (relabelFacility) names that one instead. */
function courseNamedFor(children, cardKey) {
  return children.find(row => scorecardCourseKey(row.course_name) === cardKey) || null;
}

async function renameCard({ facilityKey, facilityName, children, key, label, adminEmail }) {
  const rows = await fetchFacilityRows(supabaseFetch, facilityKey);
  const row = rows.find(item => item.course_key === key);
  if (!row) return json(404, { error: "That card is not stored under this course" });
  if (label === facilityCardLabel(row.course_name, facilityName)) {
    return json(200, { card: { key, name: row.course_name, label }, renamed: [], message: "Name unchanged." });
  }

  const name = facilityCardFullName(label, facilityName);
  const nextKey = scorecardCourseKey(name);
  if (!label || nextKey === scorecardCourseKey(facilityName) && key !== nextKey) {
    return json(400, { error: "Give the card a name of its own" });
  }
  if (nextKey !== key) {
    const taken = await supabaseFetch(SCORECARDS_TABLE + "?select=course_key&course_key=eq." + encodeURIComponent(nextKey) + "&limit=1").catch(() => []);
    if (Array.isArray(taken) && taken.length) return json(409, { error: "Another card is already called " + name });
  }

  /* Named by an admin, so a later scrape of the same card cannot rename it back
     (shouldReplaceFacilityCard keeps a confirmed card). */
  const sources = Array.isArray(row.sources_json) ? row.sources_json.slice() : [];
  sources[0] = Object.assign({}, sources[0] || {}, {
    resolution: Object.assign({}, (sources[0] && sources[0].resolution) || {}, { confirmed: true, confidence: 1, by: adminEmail, at: new Date().toISOString() })
  });
  await supabaseFetch(SCORECARDS_TABLE + "?course_key=eq." + encodeURIComponent(key), {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ course_key: nextKey, course_name: name, sources_json: sources, updated_at: new Date().toISOString() })
  });

  /* The course it belongs to takes the same name - the admin said so, so this is not
     the cautious shouldRename a scraped name goes through. The old name is kept as an
     alias so anything stored under it still resolves. */
  const renamed = [];
  const course = courseNamedFor(children, key);
  if (course && course.course_name !== name) {
    const aliases = Array.isArray(course.course_aliases) ? course.course_aliases : [];
    await supabaseFetch(MAPS_TABLE + "?course_id=eq." + encodeURIComponent(course.course_id), {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        course_name: name,
        course_aliases: [...new Set([course.course_name, ...aliases].filter(Boolean).filter(alias => alias !== name))].slice(0, 12),
        updated_at: new Date().toISOString()
      })
    });
    renamed.push({ courseId: course.course_id, from: course.course_name, to: name });
  } else if (!course) {
    const cards = cardsFromRows(await fetchFacilityRows(supabaseFetch, facilityKey));
    const relabel = await relabelFacility(supabaseFetch, { children, cards: distinctCards(cards) });
    renamed.push(...(relabel.renamed || []));
  }

  return json(200, {
    card: { key: nextKey, name, label: facilityCardLabel(name, facilityName) },
    renamed,
    message: "Card named " + name + "." + (renamed.length ? " Course renamed to match." : "")
  });
}

export default async function courseScorecards(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "GET" && req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!hasSupabase()) return json(503, { error: "Not configured" });

  const adminEmail = await verifiedAdminEmail(req);
  if (!adminEmail) return json(403, { error: "Admin session required" });

  let payload = {};
  if (req.method === "POST") {
    try { payload = await req.json(); } catch (error) { return json(400, { error: "Invalid JSON" }); }
  }
  const courseId = String((req.method === "GET" ? new URL(req.url).searchParams.get("courseId") : payload.courseId) || "").trim();
  if (!courseId) return json(400, { error: "courseId required" });

  const facility = await loadFacilityChildren(supabaseFetch, courseId).catch(() => null);
  if (!facility) return json(404, { error: "No published course found for " + courseId });
  const { facilityKey, children, pinned } = facility;
  const facilityName = facilityNameOf(pinned, courseId);

  if (req.method === "GET") {
    return json(200, { facilityKey, facilityName, cards: await listCards(facilityKey, facilityName) });
  }
  return renameCard({
    facilityKey, facilityName, children,
    key: String(payload.key || "").trim(),
    label: String(payload.label || "").replace(/\s+/g, " ").trim().slice(0, 120),
    adminEmail
  });
}

export const config = {
  path: "/api/course-scorecards"
};
