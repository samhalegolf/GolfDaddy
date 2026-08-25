/* course-scorecard-update: the "Update Scorecards" admin action - relabel an
 * already-published multi-course facility from newly acquired scorecard
 * evidence, without rescanning geometry.
 *
 * Supabase is stubbed at the fetch layer (same harness as
 * dev/course-mapper-jobs.test.js), so this is hermetic. The live-network
 * scorecard-fetch path itself (resolveScorecard's fetchHtml -> safe-remote-url's
 * real DNS lookup) is exercised hermetically already in dev/scorecard-resolve.
 * test.js and dev/course-mapper-worker-integration.test.js; scenarios here that
 * need "acquisition attempted" stub the search endpoint to return zero
 * candidates, so fetchHtml is never reached. Scenarios that need a *found* card
 * pre-seed course_scorecards directly, exactly as a prior worker scan or a
 * prior Update Scorecards run would have left it - which is the real precondition
 * for "found the South card" here, since the resolver itself is proven elsewhere.
 *
 * Run: node dev/course-scorecard-update.test.js */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const realFetch = global.fetch;
const realEnv = Object.assign({}, process.env);

const BASE = "https://stub.supabase.co";
const ADMIN = { id: "user-admin-1", email: "samhalegolf@gmail.com" };
const PLAYER = { id: "user-player-1", email: "player@example.com" };

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/* metresToDegLat(m) placed at the same longitude turns distance() (gd-automapper-
   core.mjs) into exactly `m` metres of tee-to-green length - see its formula,
   dy = (b.lat - a.lat) * 111320 with dx = 0 when lng is unchanged. */
function metresToDegLat(m) { return m / 111320; }

function geometryFromLengths(lengths) {
  const objects = {};
  Object.keys(lengths).forEach(holeStr => {
    const hole = Number(holeStr);
    const lat0 = -36.18 + hole * 0.001;
    objects["tee-" + hole] = { id: "tee-" + hole, type: "tee", holeNumber: hole, position: { lat: lat0, lng: 174.66 } };
    objects["green-" + hole] = { id: "green-" + hole, type: "green", holeNumber: hole, position: { lat: lat0 + metresToDegLat(lengths[hole]), lng: 174.66 } };
  });
  return objects;
}

/* Te Arai's real North/South: different par count and different par-3/par-5
   positions, which is what parClassOverlap keys on. */
const NORTH_PARS = [4, 3, 4, 4, 4, 4, 3, 4, 5, 4, 5, 3, 4, 5, 3, 4, 3, 5];
const SOUTH_PARS = [5, 4, 4, 4, 3, 4, 5, 3, 4, 4, 4, 3, 5, 4, 4, 4, 3, 5];

function cardFromPars(name, pars, baseMetres) {
  const holes = pars.map((par, i) => ({ hole: i + 1, par, distanceM: baseMetres + (par - 4) * 60 + i * 3 }));
  return { name, source: "golfpass", sourceUrl: "https://example.com/" + name.toLowerCase().replace(/[^a-z]+/g, "-"), holes };
}
const NORTH_CARD = cardFromPars("Te Arai Links Golf Club - North Course", NORTH_PARS, 360);
const SOUTH_CARD = cardFromPars("Te Arai Links Golf Club - South Course", SOUTH_PARS, 380);

function lengthsFromCard(card) {
  const lengths = {};
  card.holes.forEach(h => { lengths[h.hole] = h.distanceM; });
  return lengths;
}

function scorecardRow(card, facilityKey) {
  return {
    course_key: card.name.trim().replace(/\s+/g, " ").toLowerCase(),
    course_name: card.name,
    facility_key: facilityKey,
    source: card.source,
    source_url: card.sourceUrl,
    holes_json: card.holes,
    sources_json: []
  };
}

function stubWorld({ maps, scorecards, sessions }) {
  const calls = { mapPatches: [], scorecardWrites: [], searchCalls: 0 };
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();
    if (url.includes("/auth/v1/user")) {
      const header = String((options.headers && options.headers.Authorization) || "");
      const token = header.replace(/^Bearer /, "");
      const user = sessions && sessions[token];
      return user ? jsonResponse(200, user) : jsonResponse(401, { error: "bad token" });
    }
    if (url.includes("/.netlify/functions/scorecard-search")) {
      calls.searchCalls += 1;
      return jsonResponse(200, { results: [] }); // no candidates - fetchHtml (real DNS) is never reached
    }
    const rest = url.split("/rest/v1/")[1] || "";
    const table = rest.split("?")[0];
    if (table === "course_maps") {
      if (method === "GET") {
        if (rest.includes("course_id=eq.")) {
          const id = decodeURIComponent(rest.match(/course_id=eq\.([^&]+)/)[1]);
          return jsonResponse(200, maps.filter(m => m.course_id === id));
        }
        if (rest.includes("facility_key=eq.")) {
          const key = decodeURIComponent(rest.match(/facility_key=eq\.([^&]+)/)[1]);
          return jsonResponse(200, maps.filter(m => m.facility_key === key && m.published));
        }
        return jsonResponse(200, []);
      }
      if (method === "PATCH") {
        const id = decodeURIComponent(rest.match(/course_id=eq\.([^&]+)/)[1]);
        const body = JSON.parse(options.body || "{}");
        calls.mapPatches.push({ courseId: id, body });
        const row = maps.find(m => m.course_id === id);
        if (row) Object.assign(row, body);
        return jsonResponse(200, [row].filter(Boolean));
      }
    }
    if (table === "course_scorecards") {
      if (method === "GET") return jsonResponse(200, scorecards);
      if (method === "POST") { calls.scorecardWrites.push(JSON.parse(options.body || "[]")); return jsonResponse(200, []); }
    }
    return jsonResponse(200, []);
  };
  return calls;
}

function post(courseId, token) {
  return {
    method: "POST",
    url: "https://clarity.example/api/course-scorecard-update",
    headers: { get: name => (String(name).toLowerCase() === "authorization" && token ? "Bearer " + token : null) },
    json: async () => ({ courseId })
  };
}

function teAraiMaps() {
  return [
    {
      course_id: "te-rai", course_name: "Te Arai Links - Course 1", facility_key: "te-rai", published: true,
      course_aliases: ["Te Arai Links"], region: "Auckland", country: "New Zealand",
      objects_json: geometryFromLengths(lengthsFromCard(NORTH_CARD)), holes_json: {}
    },
    {
      course_id: "course-2", course_name: "Te Arai Links - Course 2", facility_key: "te-rai", published: true,
      course_aliases: ["Te Arai Links"], region: "Auckland", country: "New Zealand",
      objects_json: geometryFromLengths(lengthsFromCard(SOUTH_CARD)), holes_json: {}
    }
  ];
}

let handler = null;
async function call(request) {
  const response = await handler(request);
  return { status: response.status, body: JSON.parse(await response.text()) };
}

/* ---------- admin gate --------------------------------------------------- */

test("an unverified caller is refused before anything is read", async () => {
  const calls = stubWorld({ maps: teAraiMaps(), scorecards: [], sessions: { "player-token": PLAYER } });
  const res = await call(post("te-rai", "player-token"));
  assert.strictEqual(res.status, 403);
  assert.strictEqual(calls.mapPatches.length, 0);
});

/* ---------- Te Arai: 1 of 2 cards found, labels stay provisional --------- */

test("only the North card stored: reports the shortfall and leaves Course 1/2 alone", async () => {
  const maps = teAraiMaps();
  const calls = stubWorld({ maps, scorecards: [scorecardRow(NORTH_CARD, "te-rai")], sessions: { "admin-token": ADMIN } });
  const res = await call(post("te-rai", "admin-token"));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.want, 2);
  assert.strictEqual(res.body.distinct, 1);
  assert.strictEqual(res.body.resolved, false);
  assert.strictEqual(res.body.renamed.length, 0);
  assert.ok(res.body.message.includes("1 of 2"), res.body.message);
  assert.strictEqual(calls.mapPatches.length, 0, "no rename without both cards");
  assert.strictEqual(maps[0].course_name, "Te Arai Links - Course 1");
  assert.strictEqual(maps[1].course_name, "Te Arai Links - Course 2");
});

/* ---------- Te Arai: both cards found -> confident rename ---------------- */

test("both cards found: matches confidently and safely renames both siblings", async () => {
  const maps = teAraiMaps();
  const geometryBefore = [JSON.stringify(maps[0].objects_json), JSON.stringify(maps[1].objects_json)];
  const scorecards = [scorecardRow(NORTH_CARD, "te-rai"), scorecardRow(SOUTH_CARD, "te-rai")];
  const calls = stubWorld({ maps, scorecards, sessions: { "admin-token": ADMIN } });
  const res = await call(post("course-2", "admin-token")); // triggered from either sibling
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.want, 2);
  assert.strictEqual(res.body.distinct, 2);
  assert.strictEqual(res.body.resolved, true);
  assert.strictEqual(res.body.renamed.length, 2);
  assert.ok(res.body.message.includes("updated"), res.body.message);

  const north = maps.find(m => m.course_id === "te-rai");
  const south = maps.find(m => m.course_id === "course-2");
  assert.strictEqual(north.course_name, NORTH_CARD.name);
  assert.strictEqual(south.course_name, SOUTH_CARD.name);
  assert.ok(north.course_aliases.includes("Te Arai Links - Course 1"), "old provisional name kept as an alias");
  assert.ok(south.course_aliases.includes("Te Arai Links - Course 2"));

  /* Identity and geometry are outside the patch entirely. */
  calls.mapPatches.forEach(patch => {
    assert.ok(!("course_id" in patch.body));
    assert.ok(!("osm_course_ref" in patch.body));
    assert.ok(!("facility_key" in patch.body));
    assert.ok(!("objects_json" in patch.body));
    assert.ok(!("holes_json" in patch.body));
  });
  assert.strictEqual(JSON.stringify(north.objects_json), geometryBefore[0]);
  assert.strictEqual(JSON.stringify(south.objects_json), geometryBefore[1]);
  assert.strictEqual(north.facility_key, "te-rai");
  assert.strictEqual(south.facility_key, "te-rai");
});

/* ---------- duplicate evidence: same card under two keys is still 1 ------ */

test("the same North card stored under two key spellings still counts as one distinct card", async () => {
  const maps = teAraiMaps();
  const scorecards = [
    scorecardRow(NORTH_CARD, "te-rai"),
    Object.assign(scorecardRow(NORTH_CARD, "te-rai"), { course_key: "te arai links", course_name: "Te Arai Links" })
  ];
  const calls = stubWorld({ maps, scorecards, sessions: { "admin-token": ADMIN } });
  const res = await call(post("te-rai", "admin-token"));
  assert.strictEqual(res.body.distinct, 1, "two rows, one actual course");
  assert.strictEqual(res.body.resolved, false);
  assert.strictEqual(calls.mapPatches.length, 0);
});

/* ---------- 2 cards found, but the geometry cannot tell them apart ------- */

test("2 cards found but the match is not confident enough: no rename", async () => {
  const maps = teAraiMaps();
  /* Both siblings given the SAME geometry profile - genuinely indistinguishable
     from geometry alone, so no assignment beats its own swap and margin is 0. */
  const sharedGeometry = geometryFromLengths(lengthsFromCard(SOUTH_CARD));
  maps[0].objects_json = sharedGeometry;
  maps[1].objects_json = sharedGeometry;
  const scorecards = [scorecardRow(NORTH_CARD, "te-rai"), scorecardRow(SOUTH_CARD, "te-rai")];
  const calls = stubWorld({ maps, scorecards, sessions: { "admin-token": ADMIN } });
  const res = await call(post("te-rai", "admin-token"));
  assert.strictEqual(res.body.distinct, 2);
  assert.strictEqual(res.body.resolved, false);
  assert.strictEqual(res.body.renamed.length, 0);
  assert.ok(res.body.message.includes("not confident enough"), res.body.message);
  assert.strictEqual(calls.mapPatches.length, 0);
  assert.strictEqual(maps[0].course_name, "Te Arai Links - Course 1");
  assert.strictEqual(maps[1].course_name, "Te Arai Links - Course 2");
});

/* ---------- want is derived from the facility, not hardcoded ------------- */

test("a single-course facility (no facility_key) wants exactly 1 card", async () => {
  const maps = [{
    course_id: "pupuke", course_name: "Pupuke Golf Club", facility_key: null, published: true,
    course_aliases: [], region: "Auckland", country: "New Zealand",
    objects_json: geometryFromLengths(lengthsFromCard(NORTH_CARD)), holes_json: {}
  }];
  const scorecards = [scorecardRow(Object.assign({}, NORTH_CARD, { name: "Pupuke Golf Club - Championship Course" }), "pupuke")];
  const calls = stubWorld({ maps, scorecards, sessions: { "admin-token": ADMIN } });
  const res = await call(post("pupuke", "admin-token"));
  assert.strictEqual(res.body.want, 1);
  assert.strictEqual(res.body.distinct, 1);
  assert.strictEqual(res.body.resolved, true);
  assert.strictEqual(maps[0].course_name, "Pupuke Golf Club - Championship Course");
});

(async function run() {
  process.env.SUPABASE_URL = BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub";
  process.env.SUPABASE_ANON_KEY = "anon-stub";
  handler = (await import(path.join(root, "functions", "course-scorecard-update.mjs"))).default;
  let failures = 0;
  for (const item of tests) {
    try {
      await item.fn();
      console.log("  ok  " + item.name);
    } catch (error) {
      failures += 1;
      console.error("  FAIL  " + item.name + "\n        " + (error && error.stack || error));
    }
  }
  global.fetch = realFetch;
  process.env = realEnv;
  if (failures) {
    console.error("course-scorecard-update FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("course-scorecard-update passed: " + tests.length + " checks");
})();
