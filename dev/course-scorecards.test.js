/* course-scorecards: the card row's server half - list a facility's cards, rename one.
 *
 * Hermetic - Supabase and auth are a stubbed global.fetch, the same world as
 * dev/course-scorecard-upload.test.js.
 *
 * Run: node dev/course-scorecards.test.js */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const realFetch = global.fetch;
const realEnv = Object.assign({}, process.env);

const ADMIN = { id: "user-admin-1", email: "samhalegolf@gmail.com" };
const PLAYER = { id: "user-player-1", email: "player@example.com" };

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const EIGHTEEN = Array.from({ length: 18 }, (_, i) => ({ hole: i + 1, par: [4, 4, 3, 5, 4, 4, 3, 4, 5][i % 9] }));
const PAR_THREE = Array.from({ length: 9 }, (_, i) => ({ hole: i + 1, par: 3 }));

function foyle() {
  return {
    maps: [
      { course_id: "foyle-golf-club", course_name: "Foyle Golf Club", facility_key: "foyle-golf-club", published: true, objects_json: {}, course_aliases: [] },
      { course_id: "foyle-golf-club-course-2", course_name: "Foyle Golf Club - Course 2", facility_key: "foyle-golf-club", published: true, objects_json: {}, course_aliases: [] }
    ],
    scorecards: [
      { course_key: "foyle golf club", course_name: "Foyle Golf Club", facility_key: "foyle-golf-club", source: "manual-upload", holes_json: EIGHTEEN, sources_json: [{}] },
      { course_key: "foyle golf club - course 2", course_name: "Foyle Golf Club - Course 2", facility_key: "foyle-golf-club", source: "manual-upload", holes_json: PAR_THREE, sources_json: [{}] }
    ]
  };
}

function stubWorld({ maps, scorecards }) {
  const calls = { mapPatches: [], cardPatches: [], cardDeletes: [] };
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();
    if (url.includes("/auth/v1/user")) {
      const token = String((options.headers && options.headers.Authorization) || "").replace(/^Bearer /, "");
      return token === "admin-token" ? jsonResponse(200, ADMIN) : token === "player-token" ? jsonResponse(200, PLAYER) : jsonResponse(401, {});
    }
    const rest = url.split("/rest/v1/")[1] || "";
    const table = rest.split("?")[0];
    const eq = field => { const m = rest.match(new RegExp(field + "=eq\\.([^&]+)")); return m ? decodeURIComponent(m[1]) : null; };
    if (table === "course_maps") {
      if (method === "GET") {
        if (eq("course_id")) return jsonResponse(200, maps.filter(m => m.course_id === eq("course_id")));
        return jsonResponse(200, maps.filter(m => m.facility_key === eq("facility_key")));
      }
      if (method === "PATCH") {
        const body = JSON.parse(options.body);
        calls.mapPatches.push({ courseId: eq("course_id"), body });
        Object.assign(maps.find(m => m.course_id === eq("course_id")), body);
        return jsonResponse(204, null);
      }
    }
    if (table === "course_scorecards") {
      if (method === "GET") {
        if (eq("course_key")) return jsonResponse(200, scorecards.filter(r => r.course_key === eq("course_key")));
        return jsonResponse(200, scorecards.filter(r => r.facility_key === eq("facility_key")));
      }
      if (method === "PATCH") {
        const body = JSON.parse(options.body);
        calls.cardPatches.push({ key: eq("course_key"), body });
        Object.assign(scorecards.find(r => r.course_key === eq("course_key")), body);
        return jsonResponse(204, null);
      }
      if (method === "DELETE") {
        calls.cardDeletes.push({ key: eq("course_key"), facilityKey: eq("facility_key") });
        for (let i = scorecards.length - 1; i >= 0; i--) {
          if (scorecards[i].course_key === eq("course_key") && (!eq("facility_key") || scorecards[i].facility_key === eq("facility_key"))) scorecards.splice(i, 1);
        }
        return jsonResponse(204, null);
      }
    }
    return jsonResponse(200, []);
  };
  return calls;
}

function request(method, body, token, query) {
  return {
    method,
    url: "https://clarity.example/api/course-scorecards" + (query || ""),
    headers: { get: name => (String(name).toLowerCase() === "authorization" && token ? "Bearer " + token : null) },
    json: async () => body
  };
}
async function parse(res) { return { status: res.status, body: JSON.parse(await res.text()) }; }

let handler;

test("a player cannot see or rename cards", async () => {
  stubWorld(foyle());
  assert.strictEqual((await handler(request("GET", null, "player-token", "?courseId=foyle-golf-club"))).status, 403);
  assert.strictEqual((await handler(request("POST", { courseId: "foyle-golf-club", key: "foyle golf club", label: "X" }, "player-token"))).status, 403);
});

test("the facility's cards are listed with their labels: the bare facility card is Course 1", async () => {
  stubWorld(foyle());
  const res = await parse(await handler(request("GET", null, "admin-token", "?courseId=foyle-golf-club-course-2")));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.cards.map(c => [c.label, c.holes, c.par]), [["Course 1", 18, 72], ["Course 2", 9, 27]]);
});

test("renaming a card renames the course it belongs to, keeping the old name as an alias", async () => {
  const world = foyle();
  const calls = stubWorld(world);
  const res = await parse(await handler(request("POST", { courseId: "foyle-golf-club", key: "foyle golf club - course 2", label: "Par 3" }, "admin-token")));
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(calls.cardPatches[0].body.course_key, "foyle golf club - par 3");
  assert.strictEqual(calls.cardPatches[0].body.course_name, "Foyle Golf Club - Par 3");
  assert.strictEqual(calls.cardPatches[0].body.sources_json[0].resolution.confirmed, true, "an admin's name is not undone by the next scrape");
  const course = world.maps.find(m => m.course_id === "foyle-golf-club-course-2");
  assert.strictEqual(course.course_name, "Foyle Golf Club - Par 3");
  assert.deepStrictEqual(course.course_aliases, ["Foyle Golf Club - Course 2"]);
});

test("an unchanged label writes nothing; a taken name is a 409; an empty one a 400", async () => {
  const calls = stubWorld(foyle());
  const same = await parse(await handler(request("POST", { courseId: "foyle-golf-club", key: "foyle golf club", label: "Course 1" }, "admin-token")));
  assert.strictEqual(same.status, 200);
  assert.strictEqual(calls.cardPatches.length, 0, "Course 1 on the facility's own card is a default, not a rename");
  assert.strictEqual((await handler(request("POST", { courseId: "foyle-golf-club", key: "foyle golf club", label: "Course 2" }, "admin-token"))).status, 409);
  assert.strictEqual((await handler(request("POST", { courseId: "foyle-golf-club", key: "foyle golf club", label: "  " }, "admin-token"))).status, 400);
});

test("a card from another facility cannot be renamed through this course", async () => {
  stubWorld(foyle());
  assert.strictEqual((await handler(request("POST", { courseId: "foyle-golf-club", key: "elsewhere", label: "X" }, "admin-token"))).status, 404);
});

test("the card stored under this course's own name is marked as GPS Play's, and opens as rows", async () => {
  stubWorld(foyle());
  const res = await parse(await handler(request("GET", null, "admin-token", "?courseId=foyle-golf-club")));
  assert.deepStrictEqual(res.body.cards.map(c => c.gps), [true, false]);
  assert.strictEqual(res.body.cards[0].card.holes.length, 18);
  assert.deepStrictEqual(res.body.cards[0].card.tees, [], "par only - no distance rows");
});

test("a card edited by hand is saved over the stored one, checked, and marked manual and confirmed", async () => {
  const world = foyle();
  const calls = stubWorld(world);
  const card = { tees: ["White", "Red"], holes: Array.from({ length: 9 }, (_, i) => ({ hole: i + 1, par: 3, index: i + 1, distances: [120 + i, 100 + i] })) };
  const res = await parse(await handler(request("POST", { courseId: "foyle-golf-club", key: "foyle golf club - course 2", action: "save", card }, "admin-token")));
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const patch = calls.cardPatches[0].body;
  assert.strictEqual(patch.holes_json[0].metres, 120);
  assert.deepStrictEqual(patch.holes_json[0].tees, { White: { metres: 120 }, Red: { metres: 100 } });
  assert.strictEqual(patch.source, "manual-upload", "a manual card stays manual");
  assert.strictEqual(patch.sources_json[0].resolution.edited, true);
  const bad = Object.assign({}, card, { holes: card.holes.map((h, i) => i === 3 ? Object.assign({}, h, { par: 9 }) : h) });
  const refused = await parse(await handler(request("POST", { courseId: "foyle-golf-club", key: "foyle golf club - course 2", action: "save", card: bad }, "admin-token")));
  assert.strictEqual(refused.status, 400);
  assert.match(refused.body.error, /Hole 4 needs a par/);
});

test("a card is deleted from the store, scoped to its facility, and the list no longer shows it", async () => {
  const world = foyle();
  const calls = stubWorld(world);
  const res = await parse(await handler(request("POST", { courseId: "foyle-golf-club", key: "foyle golf club - course 2", action: "delete" }, "admin-token")));
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(res.body.deleted, { key: "foyle golf club - course 2", name: "Foyle Golf Club - Course 2" });
  assert.match(res.body.message, /Deleted Foyle Golf Club - Course 2\./);
  assert.doesNotMatch(res.body.message, /GPS Play/, "the second card is not GPS Play's");
  assert.deepStrictEqual(calls.cardDeletes, [{ key: "foyle golf club - course 2", facilityKey: "foyle-golf-club" }]);
  assert.strictEqual(calls.cardPatches.length, 0, "nothing is patched on a delete");
  assert.strictEqual(calls.mapPatches.length, 0, "the course keeps its name");
  const list = await parse(await handler(request("GET", null, "admin-token", "?courseId=foyle-golf-club")));
  assert.deepStrictEqual(list.body.cards.map(card => card.key), ["foyle golf club"]);
});

test("deleting GPS Play's own card says so; a player, a missing key and another facility's key delete nothing", async () => {
  const world = foyle();
  const calls = stubWorld(world);
  assert.strictEqual((await handler(request("POST", { courseId: "foyle-golf-club", key: "foyle golf club", action: "delete" }, "player-token"))).status, 403);
  assert.strictEqual((await handler(request("POST", { courseId: "foyle-golf-club", key: "", action: "delete" }, "admin-token"))).status, 404);
  world.scorecards.push({ course_key: "elsewhere", course_name: "Elsewhere", facility_key: "elsewhere", source: "manual-upload", holes_json: PAR_THREE, sources_json: [{}] });
  assert.strictEqual((await handler(request("POST", { courseId: "foyle-golf-club", key: "elsewhere", action: "delete" }, "admin-token"))).status, 404);
  assert.strictEqual(calls.cardDeletes.length, 0);
  const gps = await parse(await handler(request("POST", { courseId: "foyle-golf-club", key: "foyle golf club", action: "delete" }, "admin-token")));
  assert.strictEqual(gps.status, 200);
  assert.match(gps.body.message, /GPS Play's card for Foyle Golf Club/);
  assert.strictEqual(world.scorecards.some(row => row.course_key === "elsewhere"), true, "the other facility's card is untouched");
});

(async function run() {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub";
  process.env.SUPABASE_ANON_KEY = "anon-stub";
  handler = (await import(path.join(root, "functions", "course-scorecards.mjs"))).default;
  let failures = 0;
  for (const item of tests) {
    try { await item.fn(); console.log("  ok  " + item.name); }
    catch (error) { failures += 1; console.error("  FAIL  " + item.name + "\n        " + (error && error.stack || error)); }
  }
  global.fetch = realFetch;
  process.env = realEnv;
  if (failures) { console.error("course-scorecards FAILED: " + failures + " of " + tests.length); process.exit(1); }
  console.log("course-scorecards passed: " + tests.length + " checks");
})();
