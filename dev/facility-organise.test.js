/* Facility organise, phase 1 - FACILITY_ORGANISE_PLAN_2026-10-01.md.
 *
 * Millbrook is the case: four 18s on the ground, one card - "Remarkables/Arrow Course",
 * an 18 made of two named nines - stored with its name still HTML-encoded.
 *
 * Run: node dev/facility-organise.test.js */

const assert = require("assert");
const path = require("path");
const { replaySophiaGreen, fixture } = require("./lib/sophia-green-replay.js");

const root = path.join(__dirname, "..");
const lib = name => import("file://" + path.join(root, "functions", "lib", name));
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* A card and the ground it describes: lengths and pars from a seed, the ground measured a
   little short of the card the way OSM's straight tee-to-green always is. */
function card(name, pars, lengths) {
  return { name, holes: pars.map((par, i) => ({ hole: i + 1, par, distanceM: lengths[i] })) };
}
function groundFor(c, scale = 0.93) {
  const lengths = {};
  c.holes.forEach(row => { lengths[row.hole] = Math.round(row.distanceM * scale); });
  return lengths;
}
const P18A = [4, 5, 3, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 4, 5, 4];
const L18A = [380, 520, 160, 410, 350, 140, 540, 400, 390, 370, 180, 510, 420, 360, 150, 430, 500, 395];
const P18B = [5, 4, 4, 3, 4, 4, 5, 3, 4, 4, 4, 3, 5, 4, 4, 4, 3, 5];
const L18B = [495, 360, 345, 175, 405, 330, 520, 125, 380, 415, 300, 165, 545, 350, 375, 410, 190, 505];
const P18C = [4, 4, 3, 5, 4, 4, 3, 5, 4, 3, 4, 4, 5, 4, 3, 4, 4, 5];
const L18C = [340, 365, 120, 480, 390, 310, 170, 505, 360, 150, 330, 400, 470, 345, 185, 365, 380, 515];
const P18D = [4, 3, 4, 5, 4, 3, 4, 4, 5, 4, 4, 3, 4, 5, 3, 4, 4, 5];
const L18D = [355, 150, 395, 490, 365, 175, 340, 410, 530, 345, 385, 140, 405, 515, 165, 330, 420, 485];

test("a card's course name loses the club, the page noise and the HTML encoding", async () => {
  const { cardCourseLabel, courseNameFromCard } = await lib("gd-facility-organise-core.mjs");
  assert.deepStrictEqual(cardCourseLabel("Millbrook Resort &amp; Country Club - Remarkables/Arrow Course"), { label: "Remarkables / Arrow", parts: ["Remarkables", "Arrow"] });
  assert.strictEqual(cardCourseLabel("Te Arai Links Golf Club - North Course").label, "North Course");
  assert.strictEqual(cardCourseLabel("세종(世宗) 코스 | Par 36").label, "세종(世宗) 코스");
  assert.strictEqual(courseNameFromCard("Millbrook Resort &amp; Country Club - Remarkables/Arrow Course", "Millbrook Golf Resort"), "Millbrook Golf Resort - Remarkables / Arrow");
});

test("cards are decoded where they are read, so new ones are stored clean", async () => {
  const { toEngineCard, decodeEntities } = await lib("gd-scorecard-parse-core.mjs");
  assert.strictEqual(decodeEntities("Resort &amp; Country Club"), "Resort & Country Club");
  const parsed = { holes: [1], par: { 1: 4 }, tees: [], handicap: {}, unit: "m" };
  assert.strictEqual(toEngineCard(parsed, "Millbrook Resort &amp; Country Club").name, "Millbrook Resort & Country Club");
});

test("one card goes to the course it describes, not to whichever is listed first", async () => {
  const { matchLoopsToCards } = await lib("gd-scorecard-match-core.mjs");
  const only = card("Remarkables/Arrow Course", P18C, L18C);
  const loops = [
    { id: "course-1", lengths: groundFor(card("a", P18A, L18A)) },
    { id: "course-2", lengths: groundFor(card("b", P18B, L18B)) },
    { id: "course-3", lengths: groundFor(only) }
  ];
  const match = matchLoopsToCards(loops, [only]);
  assert.strictEqual(match.resolved, true, JSON.stringify(match));
  assert.strictEqual(match.assignment[0].loopId, "course-3");
});

test("today's placeholder names count as placeholders, so a real name can replace them", async () => {
  const { isProvisionalCourseName, shouldRename } = await lib("gd-course-rename-core.mjs");
  assert.strictEqual(isProvisionalCourseName("Millbrook Golf Resort - Course 2 - 6264m West"), true);
  assert.strictEqual(isProvisionalCourseName("TPC Sawgrass - Course 5 - 3314m South-East"), true);
  assert.strictEqual(isProvisionalCourseName("Te Arai Links Golf Club - North Course"), false);
  assert.strictEqual(shouldRename("Millbrook Golf Resort - Course 2 - 6264m West", "Millbrook Golf Resort - Remarkables / Arrow"), true);
});

test("Millbrook: the one card names its 18, the 18 is flagged as two nines, the rest wait for a person", async () => {
  const { planFacilityOrganise } = await lib("gd-facility-organise-core.mjs");
  const remarkablesArrow = card("Millbrook Resort &amp; Country Club - Remarkables/Arrow Course", P18C, L18C);
  const rows = [
    { courseId: "millbrook-remarkables-18", name: "Millbrook Golf Resort - Course 1 - 6298m North-West", holeCount: 18, lengths: groundFor(card("a", P18A, L18A)) },
    { courseId: "millbrook-remarkables-18-course-2", name: "Millbrook Golf Resort - Course 2 - 6724m East", holeCount: 18, lengths: groundFor(card("b", P18B, L18B)) },
    { courseId: "millbrook-remarkables-18-course-3", name: "Millbrook Golf Resort - Course 3 - 6264m West", holeCount: 18, lengths: groundFor(remarkablesArrow) },
    { courseId: "millbrook-remarkables-18-course-4", name: "Millbrook Golf Resort - Course 4 - 5564m East", holeCount: 18, lengths: groundFor(card("d", P18D, L18D)) }
  ];
  const plan = planFacilityOrganise({ facilityKey: "millbrook-remarkables-18", facilityName: "Millbrook Golf Resort", rows, cards: [remarkablesArrow] });
  const renames = plan.changes.filter(change => change.type === "rename");
  assert.deepStrictEqual(renames.map(r => [r.courseId, r.to, r.auto]), [["millbrook-remarkables-18-course-3", "Millbrook Golf Resort - Remarkables / Arrow", true]]);
  const split = plan.changes.find(change => change.type === "split");
  assert.ok(split && split.courseId === "millbrook-remarkables-18-course-3" && split.front === "Remarkables" && split.back === "Arrow" && split.auto === false);
  const review = plan.changes.filter(change => change.type === "review").map(change => change.courseId).sort();
  assert.deepStrictEqual(review, ["millbrook-remarkables-18", "millbrook-remarkables-18-course-2", "millbrook-remarkables-18-course-4"]);
  assert.ok(plan.changes.filter(change => change.type !== "rename").every(change => change.auto === false), "phase 1 only ever applies renames");
});

test("nines and combination cards: each nine named from the cards that share it, combinations listed", async () => {
  const { planFacilityOrganise } = await lib("gd-facility-organise-core.mjs");
  const nineA = card("A", P18A.slice(0, 9), L18A.slice(0, 9));
  const nineB = card("B", P18B.slice(0, 9), L18B.slice(0, 9));
  const nineC = card("C", P18C.slice(0, 9), L18C.slice(0, 9));
  const combo = (name, front, back) => ({ name, holes: front.holes.concat(back.holes.map(row => ({ ...row, hole: row.hole + 9 }))) });
  const cards = [combo("Club - Lakes/Hills Course", nineA, nineB), combo("Club - Hills/Forest Course", nineB, nineC)];
  const rows = [
    { courseId: "club", name: "Club - Course 1 - 3100m North", holeCount: 9, lengths: groundFor(nineA) },
    { courseId: "club-course-2", name: "Club - Course 2 - 3200m East", holeCount: 9, lengths: groundFor(nineB) },
    { courseId: "club-course-3", name: "Club - Course 3 - 3000m South", holeCount: 9, lengths: groundFor(nineC) }
  ];
  const plan = planFacilityOrganise({ facilityKey: "club", facilityName: "Club", rows, cards });
  const names = Object.fromEntries(plan.changes.filter(c => c.type === "rename").map(c => [c.courseId, c.to]));
  assert.deepStrictEqual(names, { club: "Club - Lakes", "club-course-2": "Club - Hills", "club-course-3": "Club - Forest" });
  const combos = plan.changes.filter(c => c.type === "combination").map(c => [c.name, c.frontCourseId, c.backCourseId]);
  assert.deepStrictEqual(combos, [["Club - Lakes / Hills", "club", "club-course-2"], ["Club - Hills / Forest", "club-course-2", "club-course-3"]]);
});

test("the endpoint applies only the safe renames, keeps the old name, and stores the run", async () => {
  const realFetch = global.fetch;
  const realEnv = Object.assign({}, process.env);
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
  const remarkablesArrow = card("Millbrook Resort &amp; Country Club - Remarkables/Arrow Course", P18C, L18C);
  const objectsFor = (id, c) => {
    const objects = {};
    c.holes.forEach(row => {
      const lat = -45 + row.hole * 0.01;
      objects[id + "t" + row.hole] = { type: "tee", holeNumber: row.hole, position: { lat, lng: 168.8 } };
      objects[id + "g" + row.hole] = { type: "green", holeNumber: row.hole, position: { lat: lat + row.distanceM * 0.93 / 111320, lng: 168.8 } };
    });
    return objects;
  };
  const rows = [
    { course_id: "mb", course_name: "Millbrook Golf Resort - Course 1 - 6298m North-West", facility_key: "mb", facility_name: "Millbrook Golf Resort", hole_count: 18, objects_json: objectsFor("a", card("a", P18A, L18A)), holes_json: {}, course_aliases: [] },
    { course_id: "mb-course-2", course_name: "Millbrook Golf Resort - Course 2 - 6264m West", facility_key: "mb", facility_name: "Millbrook Golf Resort", hole_count: 18, objects_json: objectsFor("c", remarkablesArrow), holes_json: {}, course_aliases: [] }
  ];
  const writes = [];
  global.fetch = async (url, init = {}) => {
    url = String(url);
    const method = String(init.method || "GET").toUpperCase();
    const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.includes("/rest/v1/course_maps") && method === "GET") return ok(url.includes("facility_key=eq.") ? rows : rows.filter(r => url.includes("course_id=eq." + r.course_id + "&")));
    if (url.includes("/rest/v1/course_scorecards")) return ok([{ course_key: "x", course_name: remarkablesArrow.name, holes_json: remarkablesArrow.holes.map(h => ({ hole: h.hole, par: h.par, metres: h.distanceM })) }]);
    writes.push({ url, method, body: init.body ? JSON.parse(init.body) : null });
    return ok([]);
  };
  try {
    const { organiseFacility } = await import("file://" + path.join(root, "functions", "facility-organise.mjs"));
    const result = await organiseFacility("mb", { apply: true, actor: "admin:test" });
    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    const patch = writes.find(w => w.method === "PATCH");
    assert.ok(patch && patch.url.includes("course_id=eq.mb-course-2"), JSON.stringify(writes.map(w => w.url)));
    assert.strictEqual(patch.body.course_name, "Millbrook Golf Resort - Remarkables / Arrow");
    assert.ok(patch.body.course_aliases.includes("Millbrook Golf Resort - Course 2 - 6264m West"), "the old name is kept as an alias");
    assert.strictEqual(writes.filter(w => w.method === "PATCH").length, 1, "nothing but the safe rename is written to course_maps");
    const run = writes.find(w => w.url.includes("facility_organise_runs"));
    assert.ok(run && run.body[0].facility_key === "mb" && run.body[0].applied.length === 1);
  } finally {
    global.fetch = realFetch;
    process.env = realEnv;
  }
});

test("a rescan keeps each course on the id of the row on its own ground", async () => {
  const first = await replaySophiaGreen();
  /* Last scan's rows, under ids that say nothing about which nine they are. */
  const previous = [...first.maps.values()].filter(row => row.course_id !== fixture.courseId)
    .map((row, i) => Object.assign({}, row, { course_id: "earlier-row-" + (i + 1), id: "published::earlier-row-" + (i + 1), facility_key: fixture.courseId }));
  const second = await replaySophiaGreen({ existingMaps: previous });
  const ids = [...second.maps.keys()].sort();
  assert.deepStrictEqual(ids, [fixture.courseId, "earlier-row-1", "earlier-row-2"].sort(), "no new ids minted: " + JSON.stringify(ids));
  previous.forEach(row => {
    const now = second.maps.get(row.course_id);
    const metres = Math.hypot((now.course_lat - row.course_lat) * 111320, (now.course_lng - row.course_lng) * 88000);
    assert.ok(metres < 100, row.course_id + " moved " + Math.round(metres) + "m - it was given another course's id");
  });
});

(async function run() {
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
  if (failures) {
    console.error("facility-organise FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("facility-organise passed: " + tests.length + " checks");
})();
