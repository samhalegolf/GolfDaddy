/* Two 18s on one property must publish as two courses, not one fragment.
 *
 * Built as the Te Arai Links case in miniature: two loops whose holes interleave
 * in space, each numbered 1-18. That layout is what broke selectNearestLoop -
 * it chose per hole number, so "nearest to the pin" flipped between courses hole
 * by hole and produced a set belonging to neither. The fixture deliberately
 * places matching hole numbers close enough that a per-number nearest choice
 * would still mix them, so a regression cannot pass by accident.
 *
 * Run: node dev/multi-course-separation.test.js */

const assert = require("assert");
const path = require("path");
const root = path.join(__dirname, "..");

const NORTH = { lat: -36.1830, lng: 174.6560 };
const SOUTH = { lat: -36.1880, lng: 174.6620 };

/* A hole as OSM tags it: a way running tee to green, with its number on `ref`. */
function holeWay(id, number, origin, step) {
  const start = { lat: origin.lat + step * 0.0004, lng: origin.lng + step * 0.0004 };
  const end = { lat: start.lat + 0.0012, lng: start.lng + 0.0009 };
  return { type: "way", id, tags: { golf: "hole", ref: String(number) }, geometry: [start, { lat: (start.lat + end.lat) / 2, lng: (start.lng + end.lng) / 2 }, end] };
}

function greenWay(id, origin, step) {
  const at = { lat: origin.lat + step * 0.0004 + 0.0012, lng: origin.lng + step * 0.0004 + 0.0009 };
  return {
    type: "way", id, tags: { golf: "green" },
    geometry: [at, { lat: at.lat + 0.0002, lng: at.lng }, { lat: at.lat + 0.0002, lng: at.lng + 0.0002 }, { lat: at.lat, lng: at.lng + 0.0002 }]
  };
}

function ringAround(origin, pad) {
  return [
    { lat: origin.lat - pad, lng: origin.lng - pad },
    { lat: origin.lat + 0.009, lng: origin.lng - pad },
    { lat: origin.lat + 0.009, lng: origin.lng + 0.009 },
    { lat: origin.lat - pad, lng: origin.lng + 0.009 },
    { lat: origin.lat - pad, lng: origin.lng - pad }
  ];
}

function buildPayload({ withPolygons }) {
  const elements = [];
  for (let n = 1; n <= 18; n++) {
    elements.push(holeWay(1000 + n, n, NORTH, n));
    elements.push(holeWay(2000 + n, n, SOUTH, n));
    elements.push(greenWay(3000 + n, NORTH, n));
    elements.push(greenWay(4000 + n, SOUTH, n));
  }
  if (withPolygons) {
    elements.push({ type: "way", id: 9001, tags: { golf: "course", name: "North Course", holes: 18 }, geometry: ringAround(NORTH, 0.002) });
    elements.push({ type: "way", id: 9002, tags: { golf: "course", name: "South Course", holes: 18 }, geometry: ringAround(SOUTH, 0.002) });
  } else {
    elements.push({ type: "way", id: 9003, tags: { leisure: "golf_course", name: "The Whole Property" }, geometry: ringAround(SOUTH, 0.02) });
  }
  return { elements };
}

(async () => {
  const core = await import("file://" + path.join(root, "functions", "lib", "gd-automapper-core.mjs"));
  const fit = await import("file://" + path.join(root, "functions", "lib", "gd-course-fit-core.mjs"));

  /* ---------- the macron that made "Te Arai Links" into "te-rai" ---------- */
  assert.strictEqual(core.slug("Te Ārai Links"), "te-arai-links", "diacritics normalise rather than vanish");
  assert.strictEqual(core.slug("Château de Chailly"), "chateau-de-chailly", "accents normalise");
  assert.strictEqual(core.slug("Royal Auckland"), "royal-auckland", "plain names are unchanged");

  /* ---------- the collision is real, and is now a router not an error ------ */
  const collision = core.detectHoleNumberCollision(buildPayload({ withPolygons: true }));
  assert.strictEqual(collision.multiLoop, true, "two 18s collide on every hole number");
  assert.strictEqual(collision.loops, 2, "exactly two loops");
  assert.strictEqual(collision.distinctNumbers, 18, "collapsing would have published 18 holes from 36");

  /* ---------- containment: the polygons already in the payload ------------ */
  const byPolygon = core.separateLoops(buildPayload({ withPolygons: true }), NORTH);
  assert.strictEqual(byPolygon.length, 2, "both courses returned, neither discarded");
  assert(byPolygon.every(loop => loop.method === "containment"), "polygons are preferred over routing");
  byPolygon.forEach(loop => {
    assert.strictEqual(loop.holeNumbers.length, 18, "each course keeps all 18 of its holes");
    assert.strictEqual(loop.contiguous, true, "and they run 1..18");
  });
  assert.deepStrictEqual(
    byPolygon.map(loop => loop.name).sort(),
    ["North Course", "South Course"],
    "each course carries its own OSM name, so nothing has to be invented"
  );
  assert.strictEqual(byPolygon[0].name, "North Course", "the pinned loop sorts first");
  assert(byPolygon.every(loop => loop.osmRef), "each carries a stable OSM identity for rescans");

  /* Greens must be partitioned too. selectNearestLoop filtered golf=hole only and
     passed the rest through, so 16 mixed guides competed against all 32 greens
     from both courses - which is why 16 guides resolved to six holes. */
  byPolygon.forEach(loop => {
    const greens = loop.payload.elements.filter(e => e.tags && e.tags.golf === "green");
    assert.strictEqual(greens.length, 18, "a loop sees its own greens only, not the whole site's");
  });

  /* ---------- routing: one polygon over both courses ---------------------- */
  const byRouting = core.separateLoops(buildPayload({ withPolygons: false }), NORTH);
  assert.strictEqual(byRouting.length, 2, "interleaved courses still separate without polygons");
  assert(byRouting.every(loop => loop.method === "routing"), "fallback engaged");
  byRouting.forEach(loop => {
    assert.strictEqual(loop.contiguous, true, "routing continuity keeps each chain on its own course");
    assert.strictEqual(loop.holeNumbers.length, 18, "no holes lost to the other loop");
  });

  /* ---------- contiguity, the check that needed no scorecard -------------- */
  assert.strictEqual(core.loopIsContiguous([1, 2, 3]), true);
  assert.strictEqual(core.loopIsContiguous([9, 10, 12, 13, 16, 17]), false, "the set Te Arai actually published");
  assert.strictEqual(core.loopIsContiguous([2, 3, 4]), false, "a set that does not start at 1");
  assert.strictEqual(core.loopIsContiguous([]), false);

  const teArai = fit.courseFitVerdict({
    collision: { multiLoop: false },
    expectedHoles: null,
    holesResolved: 6,
    holeNumbers: [9, 10, 12, 13, 16, 17],
    courseBounds: { north: -36.182826, south: -36.188137, east: 174.664435, west: 174.6557111 }
  });
  assert.strictEqual(teArai.trusted, false, "the published Te Arai map is now refused");
  assert.strictEqual(teArai.reason, "holes-not-contiguous");
  assert.deepStrictEqual(teArai.detail.missing, [1, 2, 3, 4, 5, 6, 7, 8, 11, 14, 15]);
  assert(fit.courseFitMessage(teArai).includes("not complete"), "the player is told why");

  /* No scorecard, no OSM holes tag, small span - every other rule is blind here,
     which is the whole point of the contiguity rule. */
  const spanOnly = fit.courseFitVerdict({
    collision: { multiLoop: false }, expectedHoles: null, holesResolved: 6, courseBounds: teArai.courseBounds
  });
  assert.strictEqual(spanOnly.trusted, true, "without hole numbers the old rules still pass it - as they did");

  const clean = fit.courseFitVerdict({
    collision: { multiLoop: false },
    holesResolved: 18,
    holeNumbers: Array.from({ length: 18 }, (_, i) => i + 1),
    courseBounds: { north: -36.11, south: -36.13, east: 174.62, west: 174.61 }
  });
  assert.strictEqual(clean.trusted, true, "a real 18 is not disturbed");

  /* ---------- a single course must not be split -------------------------- */
  const single = { elements: [] };
  for (let n = 1; n <= 18; n++) single.elements.push(holeWay(5000 + n, n, NORTH, n));
  assert.strictEqual(core.detectHoleNumberCollision(single).multiLoop, false, "one course does not collide");
  assert.strictEqual(core.separateLoops(single, NORTH), null, "and separation declines to invent a second one");

  console.log("multi-course separation tests passed");
})().catch(error => { console.error(error); process.exit(1); });
