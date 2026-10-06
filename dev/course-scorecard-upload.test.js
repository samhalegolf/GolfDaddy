/* course-scorecard-upload: the drop zone's server half.
 *
 * Hermetic - Supabase and auth are a stubbed global.fetch, same world as
 * dev/course-scorecard-update.test.js. The pasted fixture is the real tab-separated
 * card an admin copies out of a web table.
 *
 * Run: node dev/course-scorecard-upload.test.js */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const realFetch = global.fetch;
const realEnv = Object.assign({}, process.env);

const BASE = "https://stub.supabase.co";
const ADMIN = { id: "user-admin-1", email: "samhalegolf@gmail.com" };
const PLAYER = { id: "user-player-1", email: "player@example.com" };

const PASTED = [
  "Hole\t1\t2\t3\t4\t5\t6\t7\t8\t9\tOut\t",
  "Par\t4\t3\t4\t4\t3\t4\t4\t5\t4\t35\t",
  "SI\t11\t15\t9\t5\t17\t3\t13\t7\t1\t\t",
  "Yards\t300\t119\t333\t381\t141\t405\t360\t492\t455\t2,986\t",
  "Hole\t10\t11\t12\t13\t14\t15\t16\t17\t18\tIn\tTotal",
  "Par\t4\t4\t4\t4\t3\t5\t4\t3\t4\t35\t70",
  "SI\t8\t6\t10\t18\t4\t2\t16\t12\t14\t\t",
  "Yards\t334\t317\t341\t325\t241\t475\t290\t237\t301\t2,861\t5,847"
].join("\n");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

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

/* The pasted card's own yardages in metres, so the published geometry matches it. */
const PASTED_YARDS = [300, 119, 333, 381, 141, 405, 360, 492, 455, 334, 317, 341, 325, 241, 475, 290, 237, 301];
const PASTED_LENGTHS = Object.fromEntries(PASTED_YARDS.map((y, i) => [i + 1, Math.round(y * 0.9144)]));

function singleCourseMap(name) {
  return { course_id: "pasted-links", course_name: name, facility_key: null, published: true, objects_json: geometryFromLengths(PASTED_LENGTHS), course_aliases: [] };
}

function stubWorld({ maps, scorecards, sessions }) {
  const calls = { mapPatches: [], scorecardWrites: [] };
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();
    if (url.includes("/auth/v1/user")) {
      const header = String((options.headers && options.headers.Authorization) || "");
      const user = sessions && sessions[header.replace(/^Bearer /, "")];
      return user ? jsonResponse(200, user) : jsonResponse(401, { error: "bad token" });
    }
    const rest = url.split("/rest/v1/")[1] || "";
    const table = rest.split("?")[0];
    if (table === "course_maps") {
      if (method === "GET") {
        if (rest.includes("course_id=eq.")) {
          const id = decodeURIComponent(rest.match(/course_id=eq\.([^&]+)/)[1]);
          return jsonResponse(200, maps.filter(m => m.course_id === id));
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
      if (method === "POST") {
        const rows = JSON.parse(options.body || "[]");
        calls.scorecardWrites.push(rows);
        /* Upsert: the next GET sees what was written. */
        rows.forEach(row => {
          const index = scorecards.findIndex(old => old.course_key === row.course_key);
          if (index === -1) scorecards.push(row); else scorecards[index] = row;
        });
        return jsonResponse(200, []);
      }
    }
    return jsonResponse(200, []);
  };
  return calls;
}

function post(body, token) {
  return {
    method: "POST",
    url: "https://clarity.example/api/course-scorecard-upload",
    headers: { get: name => (String(name).toLowerCase() === "authorization" && token ? "Bearer " + token : null) },
    json: async () => body
  };
}

async function parse(res) { return { status: res.status, body: JSON.parse(await res.text()) }; }

let handler;

test("a player cannot upload", async () => {
  stubWorld({ maps: [singleCourseMap("Pasted Links")], scorecards: [], sessions: { "player-token": PLAYER } });
  const res = await parse(await handler(post({ courseId: "pasted-links", files: [{ text: PASTED }] }, "player-token")));
  assert.strictEqual(res.status, 403);
});

test("an unknown course is a 404", async () => {
  stubWorld({ maps: [], scorecards: [], sessions: { "admin-token": ADMIN } });
  const res = await parse(await handler(post({ courseId: "nowhere", files: [{ text: PASTED }] }, "admin-token")));
  assert.strictEqual(res.status, 404);
});

test("a pasted tab-separated card is read, stored as manual and named for the facility", async () => {
  const scorecards = [];
  const calls = stubWorld({ maps: [singleCourseMap("Pasted Links")], scorecards, sessions: { "admin-token": ADMIN } });
  const res = await parse(await handler(post({ courseId: "pasted-links", files: [{ name: "", mediaType: "text/plain", text: PASTED }] }, "admin-token")));
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.cards.length, 1);
  assert.strictEqual(res.body.cards[0].holes, 18);
  assert.strictEqual(res.body.cards[0].par, 70);
  assert.strictEqual(res.body.cards[0].distances, 18);
  assert.strictEqual(res.body.cards[0].strokeIndexes, 18);
  assert.strictEqual(res.body.stored, 1);
  assert.strictEqual(calls.scorecardWrites.length, 1);
  const row = calls.scorecardWrites[0][0];
  assert.strictEqual(row.source, "manual-upload", "an admin's card is marked manual so a scrape cannot replace it");
  assert.strictEqual(row.facility_key, "pasted-links", "keyed to the course's facility so Update Scorecards and Organise see it");
  assert.strictEqual(row.course_name, "Pasted Links", "a card with no printed name takes the facility's");
  assert.strictEqual(row.hole_count, 18);
  assert.strictEqual(row.holes_json[0].metres, 274);
  assert.strictEqual(row.sources_json[0].resolution.confirmed, true);
  assert.strictEqual(res.body.want, 1);
  assert.strictEqual(res.body.distinct, 1);
  assert.match(res.body.message, /^Read 1 card \(18 holes\)\. Stored\./);
});

test("an upload replaces a scraped card for the same course", async () => {
  const scraped = { course_key: "pasted links", course_name: "Pasted Links", facility_key: "pasted-links", source: "golfpass", source_url: "https://example.com/x",
    holes_json: PASTED_YARDS.map((y, i) => ({ hole: i + 1, par: 4, index: null, metres: Math.round(y * 0.9144) + 5, tees: {} })), sources_json: [{ source: "golfpass" }] };
  const scorecards = [scraped];
  const calls = stubWorld({ maps: [singleCourseMap("Pasted Links")], scorecards, sessions: { "admin-token": ADMIN } });
  const res = await parse(await handler(post({ courseId: "pasted-links", files: [{ text: PASTED }] }, "admin-token")));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.scorecardWrites.length, 1);
  assert.strictEqual(calls.scorecardWrites[0][0].course_key, "pasted links", "same key, so the upsert overwrites the scrape");
  assert.strictEqual(scorecards.length, 1);
  assert.strictEqual(scorecards[0].source, "manual-upload");
  assert.strictEqual(scorecards[0].holes_json[0].par, 4);
  assert.strictEqual(scorecards[0].holes_json[1].par, 3, "the admin's pars, not the scrape's");
});

test("a file with no table in it is a 422 that says so", async () => {
  stubWorld({ maps: [singleCourseMap("Pasted Links")], scorecards: [], sessions: { "admin-token": ADMIN } });
  const res = await parse(await handler(post({ courseId: "pasted-links", files: [
    { name: "notes.txt", mediaType: "text/plain", text: "A lovely par 70." },
    { name: "card.pdf", mediaType: "application/pdf", text: "" },
    { name: "card.xlsx", mediaType: "", text: "" }
  ] }, "admin-token")));
  assert.strictEqual(res.status, 422);
  assert.deepStrictEqual(res.body.rejected.map(r => r.name + ":" + r.reason), ["notes.txt:no-card-found", "card.xlsx:unsupported-format", "card.pdf:pdf-export-as-text"]);
});

test("an empty upload is a 400", async () => {
  stubWorld({ maps: [singleCourseMap("Pasted Links")], scorecards: [], sessions: { "admin-token": ADMIN } });
  const res = await parse(await handler(post({ courseId: "pasted-links", files: [] }, "admin-token")));
  assert.strictEqual(res.status, 400);
});

test("a front nine on its own is stored as a nine-hole card", async () => {
  const front = PASTED.split("\n").slice(0, 4).join("\n");
  const calls = stubWorld({ maps: [singleCourseMap("Pasted Links")], scorecards: [], sessions: { "admin-token": ADMIN } });
  const res = await parse(await handler(post({ courseId: "pasted-links", files: [{ text: front }] }, "admin-token")));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.cards[0].holes, 9);
  assert.strictEqual(res.body.stored, 1, "nine contiguous holes is a complete nine-hole card");
  assert.strictEqual(calls.scorecardWrites[0][0].hole_count, 9);
});

(async function run() {
  process.env.SUPABASE_URL = BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub";
  process.env.SUPABASE_ANON_KEY = "anon-stub";
  handler = (await import(path.join(root, "functions", "course-scorecard-upload.mjs"))).default;
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
    console.error("course-scorecard-upload FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("course-scorecard-upload passed: " + tests.length + " checks");
})();
