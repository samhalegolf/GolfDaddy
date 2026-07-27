/* Shared store for scorecards resolved from club websites.
 *
 * Resolving a scorecard means fetching and parsing a club's own site through
 * /api/scorecard-fetch - slow, fragile, and exactly the same work for every
 * player at that course. It was cached in localStorage, so each device paid the
 * cost once and paid it again after every reinstall, and a course whose site was
 * down that morning had no scorecard for anyone.
 *
 * GET  /api/scorecard-store?courseKey=... -> the cached scorecard, or found:false
 * POST /api/scorecard-store               -> contribute one, authenticated
 *
 * Reads are open; writes need a verified Supabase user. Trusting the client's
 * parse outright would let one bad extraction become everyone's scorecard, so a
 * write has to clear a quality gate and then beat what is already stored.
 */

const TABLE = "course_scorecards";
const MAX_HOLES = 36;
const MIN_HOLES = 9;

function env(name) {
  return process.env[name] || "";
}

function supabaseBase() {
  return env("SUPABASE_URL").replace(/\/+$/, "");
}

function supabaseKey() {
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

function anonKey() {
  return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || "";
}

function hasSupabase() {
  return !!(supabaseBase() && supabaseKey());
}

async function supabaseFetch(path, options = {}) {
  if (!hasSupabase()) throw new Error("Supabase is not configured");
  const response = await fetch(supabaseBase() + "/rest/v1/" + path, Object.assign({}, options, {
    headers: Object.assign({
      apikey: supabaseKey(),
      Authorization: "Bearer " + supabaseKey(),
      "Content-Type": "application/json"
    }, options.headers || {})
  }));
  const bodyText = await response.text();
  let body = null;
  if (bodyText) {
    try { body = JSON.parse(bodyText); } catch (_error) { body = bodyText; }
  }
  if (!response.ok) {
    const error = new Error("Supabase request failed");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

/* Identity is proven, not asserted - the caller's access token is validated
   against /auth/v1/user. Any signed-in player may contribute; the quality gate
   below, not the identity, is what protects the stored row. */
async function verifiedUserId(req, payload) {
  const header = String((req && req.headers && typeof req.headers.get === "function" && req.headers.get("authorization")) || "");
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const token = bearer || String((payload && (payload.accessToken || payload.access_token)) || "").trim();
  if (!token) return "";
  const base = supabaseBase();
  const key = anonKey() || supabaseKey();
  if (!base || !key) return "";
  try {
    const response = await fetch(base + "/auth/v1/user", {
      method: "GET",
      headers: { apikey: key, Authorization: "Bearer " + token }
    });
    if (!response.ok) return "";
    const user = await response.json();
    return String((user && user.id) || "");
  } catch (error) {
    console.warn("scorecard store user verification failed", (error && error.message) || error);
    return "";
  }
}

function json(status, body, cacheControl) {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControl || "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept,Authorization"
    }
  });
}

function text(value, max) {
  const clean = value == null ? "" : String(value).replace(/\s+/g, " ").trim();
  return max ? clean.slice(0, max) : clean;
}

function courseKey(value) {
  return text(value, 200).toLowerCase();
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* Distances live in several shapes depending on which parser produced the hole,
   so check all of them before calling a hole distance-less. */
function holeDistance(hole) {
  const direct = number(hole && (hole.metres != null ? hole.metres : hole.distanceM));
  if (direct != null) return direct;
  const tees = (hole && hole.tees) || {};
  for (const tee of Object.values(tees)) {
    const value = number(tee && (tee.metres != null ? tee.metres : tee.distanceM));
    if (value != null) return value;
  }
  return null;
}

function distanceCount(holes) {
  return (holes || []).filter(hole => holeDistance(hole) != null).length;
}

/* Normalises and validates an incoming scorecard. Returns null when it is not
   good enough to be worth sharing - a half-parsed card cached globally is worse
   than no cache, because every device then trusts it instead of re-resolving. */
function usableScorecard(input) {
  const holes = Array.isArray(input && input.holes) ? input.holes : [];
  if (holes.length < MIN_HOLES || holes.length > MAX_HOLES) return null;

  const clean = [];
  for (let i = 0; i < holes.length; i += 1) {
    const hole = holes[i] || {};
    const par = number(hole.par);
    /* Par is the one field the whole card is useless without. */
    if (par == null || par < 3 || par > 6) return null;
    const holeNumber = number(hole.hole);
    if (holeNumber !== i + 1) return null;
    const index = number(hole.index);
    clean.push({
      hole: i + 1,
      par: Math.round(par),
      index: index == null ? null : Math.round(index),
      metres: holeDistance(hole),
      tees: hole.tees && typeof hole.tees === "object" ? hole.tees : {},
      sourceUrl: text(hole.sourceUrl, 500)
    });
  }

  return {
    holes: clean,
    holeCount: clean.length,
    distanceCount: distanceCount(clean)
  };
}

function rowToScorecard(row) {
  return {
    courseKey: text(row.course_key, 200),
    courseName: text(row.course_name, 200),
    source: text(row.source, 60) || "shared",
    provider: text(row.provider, 120),
    sourceUrl: text(row.source_url, 500),
    holes: Array.isArray(row.holes_json) ? row.holes_json : [],
    scorecardSources: Array.isArray(row.sources_json) ? row.sources_json : [],
    resolvedAt: text(row.updated_at, 40),
    error: ""
  };
}

async function readScorecard(key) {
  const rows = await supabaseFetch(
    TABLE + "?select=*&course_key=eq." + encodeURIComponent(key) + "&limit=1"
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export default async function scorecardStore(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (!hasSupabase()) {
    return json(503, { error: "Scorecard store is not configured", configured: false });
  }

  if (req.method === "GET") {
    const key = courseKey(new URL(req.url).searchParams.get("courseKey"));
    if (!key) return json(400, { error: "courseKey required" });
    try {
      const row = await readScorecard(key);
      if (!row) return json(200, { found: false, courseKey: key });
      /* Short shared cache. A scorecard changes when a club rebuilds a hole,
         which is a once-in-years event, so a minute of CDN reuse costs nothing
         and spares the database a request per player per round. */
      return json(200, { found: true, scorecard: rowToScorecard(row) }, "public, max-age=60, s-maxage=300");
    } catch (error) {
      return json(error.status || 502, {
        error: "Could not read the shared scorecard",
        details: error.body || error.message || String(error)
      });
    }
  }

  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  let payload;
  try {
    payload = await req.json();
  } catch (error) {
    return json(400, { error: "Invalid JSON" });
  }

  const key = courseKey(payload && (payload.courseKey || (payload.scorecard && payload.scorecard.courseKey)));
  if (!key) return json(400, { error: "courseKey required" });

  const userId = await verifiedUserId(req, payload);
  if (!userId) return json(401, { error: "Sign-in required to contribute a scorecard" });

  const incoming = payload && payload.scorecard;
  const usable = usableScorecard(incoming);
  if (!usable) return json(422, { error: "Scorecard is incomplete", courseKey: key });

  try {
    const existing = await readScorecard(key);
    if (existing) {
      /* Only let a contribution through when it is genuinely better. Ranking on
         holes first and distances second means a complete-but-distance-less card
         cannot displace a complete one that has yardages. */
      const better =
        usable.holeCount > Number(existing.hole_count || 0) ||
        (usable.holeCount === Number(existing.hole_count || 0) &&
          usable.distanceCount > Number(existing.distance_count || 0));
      if (!better) {
        return json(200, { stored: false, reason: "existing scorecard is at least as complete", courseKey: key });
      }
    }

    const row = {
      course_key: key,
      course_name: text(incoming.courseName || (payload && payload.courseName), 200),
      source: text(incoming.source, 60),
      provider: text(incoming.provider, 120),
      source_url: text(incoming.sourceUrl, 500),
      hole_count: usable.holeCount,
      distance_count: usable.distanceCount,
      holes_json: usable.holes,
      sources_json: Array.isArray(incoming.scorecardSources) ? incoming.scorecardSources.slice(0, 10) : [],
      resolved_by: userId,
      updated_at: new Date().toISOString()
    };

    await supabaseFetch(TABLE + "?on_conflict=course_key", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row)
    });

    return json(200, {
      stored: true,
      courseKey: key,
      holeCount: usable.holeCount,
      distanceCount: usable.distanceCount
    });
  } catch (error) {
    return json(error.status || 502, {
      error: "Could not store the shared scorecard",
      details: error.body || error.message || String(error)
    });
  }
}

export const config = {
  path: "/api/scorecard-store"
};
