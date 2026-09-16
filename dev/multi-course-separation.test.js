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

  /* ---------- Fancourt: nested outlines, spilled holes, a course with no outline, and
     the club next door (FANCOURT_SCAN_INVESTIGATION_2026-09-16.md) ------------------ */

  /* A course as a continuous routing: nine holes out along one row, a short walk north,
     nine holes back along the next, so 18's green sits a walk from 1's tee as at any
     club. `unnumbered` keeps a hole's way in the payload but leaves its number off the
     tags - Fancourt's hole 3. Each hole spans 0.0013 of longitude (~120m) start to start. */
  function chainedCourse(idBase, origin, { unnumbered = [] } = {}) {
    const ways = [];
    const way = (n, start, end) => {
      const tags = { golf: "hole" };
      if (!unnumbered.includes(n)) tags.ref = String(n);
      ways.push({ type: "way", id: idBase + n, tags, geometry: [start, { lat: (start.lat + end.lat) / 2, lng: (start.lng + end.lng) / 2 }, end] });
    };
    for (let n = 1; n <= 9; n++) {
      const start = { lat: origin.lat, lng: origin.lng + (n - 1) * 0.0013 };
      way(n, start, { lat: start.lat + 0.0009, lng: start.lng + 0.0010 });
    }
    for (let n = 10; n <= 18; n++) {
      const start = { lat: origin.lat + 0.0015, lng: origin.lng + (18 - n) * 0.0013 + 0.0010 };
      way(n, start, { lat: start.lat - 0.0009, lng: start.lng - 0.0010 });
    }
    return ways;
  }
  function box(south, west, north, east) {
    return [{ lat: south, lng: west }, { lat: north, lng: west }, { lat: north, lng: east }, { lat: south, lng: east }, { lat: south, lng: west }];
  }
  const ESTATE = { lat: -33.9680, lng: 22.4000 };
  function fancourt({ withNeighbour = true } = {}) {
    const elements = [];
    /* West 18 runs out to ~22.4124 and back. The Links outline starts east of hole 3, so
       holes 1, 2 on the way out and 16, 17, 18 on the way back spill outside it while
       sitting inside the estate outline. Hole 3 is drawn but carries no number. */
    chainedCourse(1000, ESTATE, { unnumbered: [3] }).forEach(way => elements.push(way));
    elements.push({ type: "way", id: 9101, tags: { leisure: "golf_course", name: "The Links at Fancourt" }, geometry: box(-33.9700, 22.4038, -33.9645, 22.4130) });
    elements.push({ type: "way", id: 9100, tags: { leisure: "golf_course", name: "Fancourt Golf Estate" }, geometry: box(-33.9740, 22.3980, -33.9620, 22.4160) });
    /* East 18: outside both Fancourt outlines, no outline of its own. */
    chainedCourse(2000, { lat: -33.9680, lng: 22.4300 }).forEach(way => elements.push(way));
    if (withNeighbour) {
      /* The club next door: its own outline, wholly outside the estate outline. */
      chainedCourse(3000, { lat: -33.9550, lng: 22.4400 }).forEach(way => elements.push(way));
      elements.push({ type: "way", id: 9102, tags: { leisure: "golf_course", name: "George Golf Club" }, geometry: box(-33.9580, 22.4380, -33.9520, 22.4660) });
      elements.push(greenWay(3900, { lat: -33.9550, lng: 22.4400 }, 1));
    }
    return { elements };
  }

  const fc = core.separateLoops(fancourt(), ESTATE);
  assert.strictEqual(fc.length, 2, "the two Fancourt courses, and only those, separate");
  const links = fc.find(loop => loop.name === "The Links at Fancourt");
  const east = fc.find(loop => loop.method === "routing");
  assert(links && east, "one course by its outline, one by routing");
  assert.deepStrictEqual(links.holeNumbers, [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    "holes that spill past the course outline rejoin it by routing continuity - the facility outline is not a course");
  assert.strictEqual(east.holeNumbers.length, 18, "a course nobody drew an outline for is not dropped");
  assert.strictEqual(east.contiguous, true);
  assert.deepStrictEqual(fc.excluded.map(entry => [entry.name, entry.holes, entry.contiguous]), [["George Golf Club", 18, true]],
    "the club next door is set aside and said so, never published as a sibling");
  const ownHoles = loop => loop.payload.elements.filter(e => e.tags && e.tags.golf === "hole" && e.tags.ref).map(e => e.id);
  assert(ownHoles(links).every(id => id > 1000 && id < 2000), "a loop's payload carries its own numbered holes only");
  assert(ownHoles(east).every(id => id > 2000 && id < 3000), "not another course's, and not the neighbour's");
  assert(links.payload.elements.some(e => e.id === 1003), "the unnumbered hole way travels with the loop it sits in");
  assert.deepStrictEqual(core.holeGapFrames(links.payload).map(gap => gap.missing), [[3]],
    "the gap is hole 3, anchored on this course's own holes 2 and 4");
  assert(!east.payload.elements.some(e => e.id === 3900), "the neighbour's greens go with the neighbour");

  /* Same site with no neighbour in the sweep: nothing excluded, same two courses. */
  const fcAlone = core.separateLoops(fancourt({ withNeighbour: false }), ESTATE);
  assert.strictEqual(fcAlone.length, 2);
  assert.deepStrictEqual(fcAlone.excluded, []);

  /* Nesting is what makes an outline a facility. With no course outline inside it, the
     estate outline is just an outline, and the single course inside it is not split. */
  const lone = { elements: chainedCourse(1000, ESTATE).concat([
    { type: "way", id: 9100, tags: { leisure: "golf_course", name: "Fancourt Golf Estate" }, geometry: box(-33.9740, 22.3980, -33.9620, 22.4160) }
  ]) };
  assert.strictEqual(core.separateLoops(lone, ESTATE), null, "one course inside one outline is one course");

  /* ---------- the widen gate reads the sweep's reach in either mode ------- */
  const around = core.osmQueryScope({}, NORTH);
  assert.strictEqual(core.osmScopeReachM(around, NORTH), around.radiusM, "around mode answers with its radius");
  const bbox = core.osmQueryScope({ osmFrame: { south: -33.9751, west: 22.3931, north: -33.9463, east: 22.4317 } }, NORTH);
  const reach = core.osmScopeReachM(bbox, NORTH);
  assert.strictEqual(bbox.radiusM, undefined, "bbox mode carries no radius - which is what made the old gate 2326 > undefined");
  assert(reach > 1500 && reach < 1700, "Fancourt's footprint frame reaches ~1.6km from its middle, got " + reach);
  assert(2326 > reach, "so the 2326m separation seen there now fires the widen");
  const workerSource = require("fs").readFileSync(path.join(root, "functions", "course-mapper-worker-background.mjs"), "utf8");
  assert(!workerSource.includes("> scope.radiusM"), "the worker no longer compares against a field bbox mode never sets");
  assert(workerSource.includes("osmScopeReachM(scope, course.center)"), "and asks the scope how far it reached instead");

  console.log("multi-course separation tests passed");
})().catch(error => { console.error(error); process.exit(1); });
