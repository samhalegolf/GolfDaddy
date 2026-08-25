/* Regression: a multi-course facility must not inherit a course-specific qualifier
 * from the initially-selected course onto every discovered sibling.
 *
 * Te Arai Links is the real case. The player searched "Te Arai Links Golf Club -
 * North Course", the mapper separated the site into two loops, and neither loop's
 * OSM polygon carried a name (the routing-fallback case, not the polygon-named
 * one dev/multi-course-separation.test.js covers). publishSeparatedLoops then built
 * each provisional course_name by gluing the raw SEARCHED name onto "Course N" -
 * so both siblings published as "... - North Course - Course 1/2", making the
 * second course look like another North Course before anything had identified it.
 *
 * The fix strips the course-specific label out of the searched name via
 * splitCourseName before it becomes the provisional base, and leaves the
 * already-working evidence-based naming (OSM polygon name, scorecard match) alone -
 * this file also proves that path still tells the two courses apart once it has
 * enough evidence to.
 *
 * Run: node dev/multi-course-naming.test.js */

const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const realFetch = global.fetch;
const realEnv = Object.assign({}, process.env);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/* Records every write to course_maps; answers every other Supabase call with
 * "nothing on file", which is enough for publishSeparatedLoops to run end to end
 * without a real database - findExistingLoopRow falls back to the derived id,
 * heartbeatJob's failure is swallowed by its own .catch(). */
function stubSupabase(patches) {
  global.fetch = async (url, options = {}) => {
    url = String(url);
    const method = String(options.method || "GET").toUpperCase();
    const rest = url.split("/rest/v1/")[1] || "";
    const table = rest.split("?")[0];
    if (table === "course_maps" && (method === "PATCH" || method === "POST")) {
      const body = JSON.parse(options.body || "{}");
      patches.push(Array.isArray(body) ? body[0] : body);
      return jsonResponse(200, Array.isArray(body) ? body : [body]);
    }
    return jsonResponse(200, []);
  };
}

/* A straight north-south OSM hole way of an exact length in metres - matches the
 * equirectangular approximation gd-automapper-core.mjs's distance() itself uses,
 * so lengths fed in here come back out of loopLengthsFromOsm unchanged. */
function holeWayOfLength(id, number, origin, metres) {
  return {
    type: "way",
    id,
    tags: { golf: "hole", ref: String(number) },
    geometry: [
      { lat: origin.lat, lon: origin.lng },
      { lat: origin.lat + metres / 111320, lon: origin.lng }
    ]
  };
}

function loopFromLengths(originLat, lengths) {
  const origin = { lat: originLat, lng: 174.65 };
  const elements = Object.keys(lengths).map(hole => holeWayOfLength(Number(hole) * 10, hole, origin, lengths[hole]));
  return { payload: { elements }, centre: origin };
}

/* Te Arai's own par split (North 72, South 71) in miniature: North's short holes
 * fall on 2/5/8, South's on 3/6/9 - the parClassOverlap signal the real matcher
 * leans on hardest. */
const NORTH_CARD = {
  name: "North Course",
  holes: [
    { hole: 1, par: 4, distanceM: 380 }, { hole: 2, par: 3, distanceM: 150 },
    { hole: 3, par: 5, distanceM: 500 }, { hole: 4, par: 4, distanceM: 390 },
    { hole: 5, par: 3, distanceM: 160 }, { hole: 6, par: 4, distanceM: 410 },
    { hole: 7, par: 4, distanceM: 400 }, { hole: 8, par: 3, distanceM: 170 },
    { hole: 9, par: 5, distanceM: 520 }
  ]
};
const SOUTH_CARD = {
  name: "South Course",
  holes: [
    { hole: 1, par: 4, distanceM: 370 }, { hole: 2, par: 4, distanceM: 395 },
    { hole: 3, par: 3, distanceM: 140 }, { hole: 4, par: 5, distanceM: 510 },
    { hole: 5, par: 4, distanceM: 380 }, { hole: 6, par: 3, distanceM: 155 },
    { hole: 7, par: 4, distanceM: 405 }, { hole: 8, par: 5, distanceM: 515 },
    { hole: 9, par: 3, distanceM: 145 }
  ]
};
/* Same shape as its matching card (short holes on the same numbers, offset +5m so
   the loop and the card are never literally identical) - the relative fingerprint
   matchLoopsToCards is built to read. */
const NORTH_LOOP_LENGTHS = { 1: 385, 2: 155, 3: 505, 4: 395, 5: 165, 6: 415, 7: 405, 8: 175, 9: 525 };
const SOUTH_LOOP_LENGTHS = { 1: 375, 2: 400, 3: 145, 4: 515, 5: 385, 6: 160, 7: 410, 8: 520, 9: 150 };

let worker = null;

test("a searched course-specific qualifier is not inherited by every sibling", async () => {
  const patches = [];
  stubSupabase(patches);
  const job = { id: "job-1" };
  const course = {
    courseId: "te-arai-links-golf-club-north-course",
    courseName: "Te Arai Links Golf Club - North Course",
    center: { lat: -36.183, lng: 174.656 },
    scorecardCards: []
  };
  const loops = [
    { payload: { elements: [] }, centre: { lat: -36.183, lng: 174.656 } },
    { payload: { elements: [] }, centre: { lat: -36.188, lng: 174.662 } }
  ];

  await worker.publishSeparatedLoops(job, course, loops, null, null, "https://example.test");

  assert.strictEqual(patches.length, 2, "both siblings publish a row");
  const names = patches.map(p => p.course_name);
  assert.notStrictEqual(names[0], names[1], "the two siblings must not end up with the same name");
  names.forEach(name => {
    assert.ok(!/north course/i.test(name), "no provisional name may carry the searched course's own qualifier: got \"" + name + "\"");
  });
  assert.deepStrictEqual(names, ["Te Arai Links Golf Club - Course 1", "Te Arai Links Golf Club - Course 2"],
    "the facility half of the searched name, not the whole thing, backs the provisional label");

  /* Identity is untouched by the naming fix - the pinned row keeps the id it was
     scanned under, and the searched name survives as an alias rather than vanishing. */
  assert.strictEqual(patches[0].course_id, course.courseId);
  assert.ok(patches[0].course_aliases.includes(course.courseName),
    "the originally-searched name is preserved as an alias, not discarded");
});

test("a name with no course-specific qualifier splits to itself, unchanged", async () => {
  const patches = [];
  stubSupabase(patches);
  const job = { id: "job-2" };
  const course = {
    courseId: "muriwai-golf-club",
    courseName: "Muriwai Golf Club",
    center: { lat: -36.8, lng: 174.45 },
    scorecardCards: []
  };
  const loops = [{ payload: { elements: [] }, centre: { lat: -36.8, lng: 174.45 } }];

  await worker.publishSeparatedLoops(job, course, loops, null, null, "https://example.test");

  assert.strictEqual(patches.length, 1);
  /* Still unnamed, so nameLoopsFromCards still hands it a provisional "Course 1" -
     the point here is that splitCourseName leaves a bare facility name alone
     rather than mangling a name with no course-specific label to strip. */
  assert.strictEqual(patches[0].course_name, "Muriwai Golf Club - Course 1");
});

test("once scorecard evidence resolves the loops, real distinct names win over provisional ones", async () => {
  const { matchLoopsToCards } = await import("file://" + path.join(root, "functions", "lib", "gd-scorecard-match-core.mjs"));
  const north = loopFromLengths(-36.183, NORTH_LOOP_LENGTHS);
  const south = loopFromLengths(-36.188, SOUTH_LOOP_LENGTHS);

  /* The pure matcher, unit-tested directly: this is the "existing evidence" the
     provisional stage defers to before falling back to Course 1/Course 2. */
  const { loopLengthsFromOsm } = await import("file://" + path.join(root, "functions", "lib", "gd-scorecard-match-core.mjs"));
  const direct = matchLoopsToCards(
    [
      { id: "loop-0", lengths: loopLengthsFromOsm(north.payload.elements) },
      { id: "loop-1", lengths: loopLengthsFromOsm(south.payload.elements) }
    ],
    [NORTH_CARD, SOUTH_CARD]
  );
  assert.strictEqual(direct.resolved, true, "distinct par-3 layouts and matching rank order must resolve confidently");
  const byLoop = new Map(direct.assignment.map(p => [p.loopId, p.cardName]));
  assert.strictEqual(byLoop.get("loop-0"), "North Course");
  assert.strictEqual(byLoop.get("loop-1"), "South Course");

  /* End to end through the worker: nameLoopsFromCards must use this match to
     replace the provisional label, and publishSeparatedLoops must publish the
     real name it found rather than a facility-plus-"Course N" guess - the two
     courses must never both be identified as North. */
  const patches = [];
  stubSupabase(patches);
  const job = { id: "job-3" };
  const course = {
    courseId: "te-arai-links-golf-club-north-course",
    courseName: "Te Arai Links Golf Club - North Course",
    center: { lat: -36.183, lng: 174.656 },
    scorecardCards: [NORTH_CARD, SOUTH_CARD]
  };
  const loops = [north, south];

  await worker.publishSeparatedLoops(job, course, loops, null, null, "https://example.test");

  const names = patches.map(p => p.course_name);
  assert.deepStrictEqual(names.sort(), ["North Course", "South Course"],
    "resolved scorecard evidence names each course for real, not as two Norths");
  assert.notStrictEqual(names[0], names[1]);
  /* Identity still untouched - only the display name moved. */
  assert.strictEqual(patches[0].course_id, course.courseId, "the pinned course keeps its original id");
  assert.ok(patches[1].course_id, "the sibling still gets a stable id of its own");
});

(async function run() {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub";
  const mod = await import(path.join(root, "functions", "course-mapper-worker-background.mjs"));
  worker = mod.__courseMapperWorkerTest;
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
    console.error("multi-course-naming FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("multi-course-naming passed: " + tests.length + " checks");
})();
