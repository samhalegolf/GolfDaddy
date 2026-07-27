/* Covers the shared scorecard store: the read path, the identity check on writes,
   the quality gate that stops a thin parse displacing a complete one, and the
   guarantee that a contributor's own scores never leave the device.

   Supabase is stubbed at the fetch layer, so the suite is hermetic. */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const realFetch = global.fetch;

function holes(count, options = {}) {
  return Array.from({ length: count }, (_, i) => ({
    hole: i + 1,
    par: 4,
    index: i + 1,
    metres: options.withDistance === false ? null : 300 + i,
    tees: {},
    score: options.withScores ? 5 : null,
    putts: options.withScores ? 2 : null
  }));
}

function scorecard(overrides = {}) {
  return Object.assign({
    courseName: "Akarana Golf Club",
    source: "website",
    provider: "Akarana",
    sourceUrl: "https://www.akaranagolf.co.nz/hole-by-hole",
    holes: holes(18)
  }, overrides);
}

/* Routes the two Supabase surfaces the function touches. `rows` is what a read of
   course_scorecards returns; `user` is what /auth/v1/user returns. */
function stubSupabase({ rows = [], user = null } = {}) {
  const writes = [];
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/auth/v1/user")) {
      if (!user) return new Response("{}", { status: 401 });
      return new Response(JSON.stringify(user), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (href.includes("/rest/v1/course_scorecards")) {
      if ((options.method || "GET").toUpperCase() === "POST") {
        writes.push(JSON.parse(options.body));
        return new Response("", { status: 201 });
      }
      return new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error("unstubbed URL " + href);
  };
  return writes;
}

function get(query) {
  return new Request("https://caddy.claritygolf.app/api/scorecard-store?" + query, { method: "GET" });
}

function post(body, token) {
  return new Request("https://caddy.claritygolf.app/api/scorecard-store", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
    body: JSON.stringify(body)
  });
}

const USER = { id: "11111111-2222-3333-4444-555555555555", email: "player@example.com" };

(async function run() {
  const { default: handler } = await import(path.join(root, "functions", "scorecard-store.mjs"));

  /* ---------- configuration ---------- */

  const savedEnv = {
    url: process.env.SUPABASE_URL,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    anon: process.env.SUPABASE_ANON_KEY
  };
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  let res = await handler(get("courseKey=akarana golf club"));
  assert.strictEqual(res.status, 503, "an unconfigured store says so rather than failing obscurely");

  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  process.env.SUPABASE_ANON_KEY = "anon-key";

  /* ---------- reads ---------- */

  stubSupabase({ rows: [] });
  res = await handler(get(""));
  assert.strictEqual(res.status, 400, "a course key is required");

  stubSupabase({ rows: [] });
  let body = await (await handler(get("courseKey=akarana golf club"))).json();
  assert.strictEqual(body.found, false, "a miss is reported as a miss, not an error");

  stubSupabase({
    rows: [{
      course_key: "akarana golf club",
      course_name: "Akarana Golf Club",
      source: "website",
      provider: "Akarana",
      source_url: "https://www.akaranagolf.co.nz/hole-by-hole",
      hole_count: 18,
      distance_count: 18,
      holes_json: holes(18),
      sources_json: [],
      updated_at: "2026-07-28T00:00:00.000Z"
    }]
  });
  res = await handler(get("courseKey=Akarana Golf Club"));
  body = await res.json();
  assert.strictEqual(body.found, true, "a stored scorecard is returned");
  assert.strictEqual(body.scorecard.holes.length, 18, "all holes come back");
  assert.strictEqual(body.scorecard.source, "website", "provenance survives the round trip");
  assert.strictEqual(body.scorecard.sourceUrl, "https://www.akaranagolf.co.nz/hole-by-hole", "the originating URL survives too");
  assert.match(res.headers.get("cache-control") || "", /max-age/, "reads are cacheable");

  /* ---------- writes: identity ---------- */

  stubSupabase({ rows: [], user: null });
  res = await handler(post({ courseKey: "akarana golf club", scorecard: scorecard() }));
  assert.strictEqual(res.status, 401, "an anonymous caller cannot write");

  stubSupabase({ rows: [], user: null });
  res = await handler(post({ courseKey: "akarana golf club", scorecard: scorecard() }, "bogus-token"));
  assert.strictEqual(res.status, 401, "an unverifiable token cannot write");

  /* ---------- writes: quality gate ---------- */

  stubSupabase({ rows: [], user: USER });
  res = await handler(post({ courseKey: "akarana golf club", scorecard: scorecard({ holes: holes(4) }) }, "token"));
  assert.strictEqual(res.status, 422, "a stub of a scorecard is refused");

  stubSupabase({ rows: [], user: USER });
  const missingPar = holes(18);
  missingPar[7].par = null;
  res = await handler(post({ courseKey: "akarana golf club", scorecard: scorecard({ holes: missingPar }) }, "token"));
  assert.strictEqual(res.status, 422, "a card with a missing par is refused");

  stubSupabase({ rows: [], user: USER });
  const misnumbered = holes(18);
  misnumbered[5].hole = 99;
  res = await handler(post({ courseKey: "akarana golf club", scorecard: scorecard({ holes: misnumbered }) }, "token"));
  assert.strictEqual(res.status, 422, "a card with holes out of order is refused");

  /* ---------- writes: stored, and scores stripped ---------- */

  let writes = stubSupabase({ rows: [], user: USER });
  res = await handler(post({
    courseKey: "Akarana Golf Club",
    scorecard: scorecard({ holes: holes(18, { withScores: true }) })
  }, "token"));
  body = await res.json();
  assert.strictEqual(body.stored, true, "a complete scorecard is stored");
  assert.strictEqual(writes.length, 1, "exactly one upsert");
  assert.strictEqual(writes[0].course_key, "akarana golf club", "the key is normalised to lower case");
  assert.strictEqual(writes[0].hole_count, 18, "hole count is recorded");
  assert.strictEqual(writes[0].distance_count, 18, "distance count is recorded");
  assert.strictEqual(writes[0].resolved_by, USER.id, "the verified user id is recorded");
  const leaked = writes[0].holes_json.filter(hole => hole.score != null || hole.putts != null);
  assert.strictEqual(leaked.length, 0, "the contributor's own scores are never stored");

  /* ---------- writes: only better cards replace ---------- */

  const existingComplete = {
    course_key: "akarana golf club",
    hole_count: 18,
    distance_count: 18,
    holes_json: holes(18),
    sources_json: [],
    updated_at: "2026-07-28T00:00:00.000Z"
  };

  writes = stubSupabase({ rows: [existingComplete], user: USER });
  body = await (await handler(post({
    courseKey: "akarana golf club",
    scorecard: scorecard({ holes: holes(18, { withDistance: false }) })
  }, "token"))).json();
  assert.strictEqual(body.stored, false, "a distance-less card cannot displace one with distances");
  assert.strictEqual(writes.length, 0, "and nothing is written");

  writes = stubSupabase({ rows: [existingComplete], user: USER });
  body = await (await handler(post({ courseKey: "akarana golf club", scorecard: scorecard() }, "token"))).json();
  assert.strictEqual(body.stored, false, "an equally good card does not churn the row");

  writes = stubSupabase({
    rows: [Object.assign({}, existingComplete, { distance_count: 4 })],
    user: USER
  });
  body = await (await handler(post({ courseKey: "akarana golf club", scorecard: scorecard() }, "token"))).json();
  assert.strictEqual(body.stored, true, "a card with more distances replaces a thinner one");
  assert.strictEqual(writes.length, 1, "and it is written once");

  /* ---------- method guard ---------- */

  stubSupabase({ rows: [], user: USER });
  res = await handler(new Request("https://caddy.claritygolf.app/api/scorecard-store", { method: "DELETE" }));
  assert.strictEqual(res.status, 405, "unsupported methods are refused");

  process.env.SUPABASE_URL = savedEnv.url || "";
  process.env.SUPABASE_SERVICE_ROLE_KEY = savedEnv.service || "";
  process.env.SUPABASE_ANON_KEY = savedEnv.anon || "";
  global.fetch = realFetch;
  console.log("scorecard-store tests passed");
})().catch(error => {
  global.fetch = realFetch;
  console.error(error);
  process.exit(1);
});
