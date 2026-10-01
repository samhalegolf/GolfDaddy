/* Sophia Green CC: three nines, no OSM hole numbers, three par-36 cards that look almost alike.
 *
 * Mapper job 0037932e (2026-10-01) published it as three nines dealt from across the whole site -
 * green-to-next-tee walks of 700-1500m - under ids "cc-37-178n-127-708e", "par-36" and "par-36",
 * so one nine overwrote another. These replay that job through the real worker and pin down:
 * the ground is split into routed loops before the cards are read, holes start at the mapped
 * tees, siblings get facility-scoped ids, and card titles lose their "| Par 36". */

const assert = require("assert");
const path = require("path");
const { replaySophiaGreen, greenToNextTeeHops, fixture } = require("./lib/sophia-green-replay.js");

const root = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("the three nines publish as three rows under facility-scoped ids", async () => {
  const { job, maps } = await replaySophiaGreen();
  assert.strictEqual(job.status, "done", job.error);
  /* Which nine carries which name is the cards' call, and these three cards are near twins;
     what is fixed is one row per nine, each under the facility with a romanised name. */
  const ids = [...maps.keys()];
  assert.strictEqual(ids.length, 3, "one row per nine - the live run wrote two of them to par-36: " + JSON.stringify(ids));
  assert.ok(ids.includes(fixture.courseId), "the pinned nine keeps the row the scan was asked for");
  const names = ["sejong", "yeogang", "hwanghak"];
  ids.filter(id => id !== fixture.courseId).forEach(id => {
    assert.ok(names.some(name => id === fixture.courseId + "-" + name), "facility-scoped, romanised: " + id);
  });
  maps.forEach(row => assert.strictEqual(Object.keys(row.holes_json || {}).length, 9, row.course_id + " has nine holes"));
  ids.forEach(id => assert.strictEqual(maps.get(id).facility_key, fixture.courseId));
});

test("each nine stays on its own ground", async () => {
  const { maps, job } = await replaySophiaGreen();
  const ground = job.result.diagnostics.unnumberedSeparation.groundFirst;
  assert.strictEqual(ground.used, true, "the ground was split before the cards were read");
  /* The split itself: three loops, every walk in each a normal green-to-tee transfer. */
  assert.strictEqual(ground.loops.length, 3);
  ground.loops.forEach(loop => loop.walksM.forEach(walk => assert.ok(walk <= 500, "loop walks " + JSON.stringify(loop.walksM))));
  /* The published nines. Where a hole line is too rough for its card in walking order the card
     orders the loop's holes itself, so a walk can run across the loop - but never off it, as
     the live run's 1000-1500m hops did. */
  maps.forEach(row => {
    const hops = greenToNextTeeHops(row);
    assert.strictEqual(hops.length, 8);
    hops.forEach(hop => assert.ok(hop != null && hop <= 700, row.course_id + " walks " + JSON.stringify(hops)));
  });
});

test("holes start at the mapped tees, so the ground measures like its cards", async () => {
  const { job } = await replaySophiaGreen();
  const warnings = (job.result.diagnostics.resolverStatus || {}).warnings || [];
  assert.ok(!warnings.some(w => /scale differs/.test(w)), "the live run read the site as 32% short of its cards: " + JSON.stringify(warnings));
});

test("course names drop the card title's par suffix and keep a Latin-script alias", async () => {
  const { maps } = await replaySophiaGreen();
  maps.forEach(row => {
    assert.ok(!/par\s*\d/i.test(row.course_name), row.course_name);
  });
  const sibling = [...maps.values()].find(row => row.course_id !== fixture.courseId);
  const card = fixture.cards.find(c => c.name === sibling.course_aliases.find(alias => /\| Par 36$/.test(alias)));
  assert.ok(card, "the card's own title stays findable: " + JSON.stringify(sibling.course_aliases));
  assert.strictEqual(sibling.course_name, card.name.replace(" | Par 36", ""));
  const romanised = sibling.course_id.slice(fixture.courseId.length + 1);
  assert.ok(sibling.course_aliases.some(alias => alias.toLowerCase() === romanised), "a Latin-script alias: " + JSON.stringify(sibling.course_aliases));
});

test("a row another facility owns is never adopted and overwritten", async () => {
  const foreign = ["sejong", "yeogang", "hwanghak"].map(name => ({ course_id: fixture.courseId + "-" + name, course_name: "Someone else's course", facility_key: "another-club", holes_json: { 1: {} } }));
  const { job, maps } = await replaySophiaGreen({ existingMaps: foreign });
  foreign.forEach(row => {
    assert.strictEqual(maps.get(row.course_id).course_name, "Someone else's course");
    assert.strictEqual(maps.get(row.course_id).facility_key, "another-club");
  });
  const failed = (job.result.diagnostics.unnumberedSeparation.failedChildren || []);
  assert.strictEqual(failed.length, 2, "both siblings' clashes are recorded, not silent: " + JSON.stringify(failed));
});

test("ground loops: the assignment's cycles become loops of the right size", async () => {
  const { partitionLoops, minCostAssignment, loopTour, walkCost } = await import(path.join(root, "functions", "lib", "gd-ground-loops-core.mjs"));
  /* Two rings of four holes, 100m between holes inside a ring and 1km between rings. */
  const ring = index => Math.floor(index / 4);
  const matrix = Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => {
    if (i === j) return 0;
    if (ring(i) !== ring(j)) return walkCost(1000);
    return walkCost((j - i + 4) % 4 === 1 ? 100 : 400);
  }));
  const successor = minCostAssignment(matrix.map((row, i) => row.map((v, j) => (i === j ? 1e9 : v))));
  successor.forEach((next, i) => assert.strictEqual(ring(next), ring(i), "successor stays in its ring"));
  const split = partitionLoops(matrix, { loops: 2, holesPerLoop: 4 });
  assert.ok(split);
  split.groups.forEach(group => {
    assert.strictEqual(new Set(group.order.map(ring)).size, 1, "a loop is one ring: " + JSON.stringify(group.order));
    assert.strictEqual(group.cost, 400);
  });
  assert.strictEqual(loopTour([0, 1, 2, 3], matrix).cost, 400);
  assert.strictEqual(partitionLoops(matrix, { loops: 3, holesPerLoop: 4 }), null, "fewer holes than the loops need is no answer");
  assert.strictEqual(partitionLoops(matrix, { loops: 1, holesPerLoop: 4 }), null, "holes left over beyond the spare is no answer");
  assert.ok(partitionLoops(matrix, { loops: 1, holesPerLoop: 4, spare: 4 }), "within the spare it is");
});

test("resolver: a fairway is one green's, and a par 3 is played from a tee", async () => {
  const { resolverHoleCandidates } = await import(path.join(root, "functions", "lib", "gd-geometry-resolver-core.mjs"));
  const { mergeOverlayIntoPayload } = await import(path.join(root, "functions", "lib", "gd-map-overlay-core.mjs"));
  const overlay = fixture.features.map(([id, kind, hole, points]) => ({ id, kind, hole, points: points.map(([lat, lng]) => ({ lat, lng })) }));
  const payload = mergeOverlayIntoPayload({ elements: [] }, overlay);
  const { primary } = resolverHoleCandidates({ osmPayload: payload, courseId: "sophia", course: { courseId: "sophia", courseCentre: fixture.centre }, courseCentre: fixture.centre });
  assert.strictEqual(primary.length, 27, "one hole line per green");
  const owned = primary.filter(c => !c.evidence.includes("borrowed-fairway")).flatMap(c => c.featureKeys.slice(1));
  assert.strictEqual(new Set(owned).size, owned.length, "no fairway or tee starts two holes");
  assert.ok(primary.filter(c => c.evidence.includes("tee-to-green")).length >= 4, "the par 3s are tee-to-green lines");
});

test("alert-utils takes a blob store handed in, so the mapper worker can ship its own", async () => {
  const alerts = require(path.join(root, "functions", "alert-utils.js"));
  const keys = [];
  alerts.useBlobStore(() => ({ get: async () => null, setJSON: async key => { keys.push(key); } }));
  const realFetch = global.fetch;
  const realEnv = Object.assign({}, process.env);
  process.env.CLAUDE_MAPPER_ROUTINE_URL = "https://api.anthropic.com/v1/claude_code/routines/abc/fire";
  process.env.CLAUDE_MAPPER_ROUTINE_TOKEN = "token";
  global.fetch = async () => ({ ok: true, json: async () => ({ claude_code_session_id: "s" }) });
  try {
    const result = await alerts.fireClaudeRoutine({ text: "x" });
    assert.strictEqual(result.fired, true);
    assert.deepStrictEqual(keys, ["claude_routine:global"], "the throttle went through the store that was handed in");
  } finally {
    global.fetch = realFetch;
    process.env = realEnv;
  }
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
    console.error("multi-nine-ground-first FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("multi-nine-ground-first passed: " + tests.length + " checks");
})();
