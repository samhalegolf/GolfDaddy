/* Play orders, locked.
 *
 * The case this exists for: Billingbear Park, two nines both numbered 1-9 in OSM. The automatic
 * split published one nine. A play order says which hole lines (or linked overlay holes) make
 * a course, in what order, and under what name - and the assertions go through the real
 * resolver, so "the payload looks right" is not mistaken for "the course comes out right".
 *
 * Run: node dev/play-order-core.test.js
 */
const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let po = null;
let core = null;

const CENTRE = { lat: 51.4454, lng: -0.8136 };
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 111320 * Math.cos(CENTRE.lat * Math.PI / 180);
function at(eastM, northM) {
  return { lat: CENTRE.lat + northM / M_PER_DEG_LAT, lng: CENTRE.lng + eastM / M_PER_DEG_LNG };
}
function geom(points) { return points.map(p => ({ lat: p.lat, lon: p.lng })); }
function circle(eastM, northM, radiusM) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * Math.PI * 2;
    pts.push(at(eastM + radiusM * Math.cos(a), northM + radiusM * Math.sin(a)));
  }
  return pts;
}
function greenWay(id, eastM, northM, ref) {
  const pts = circle(eastM, northM, 12);
  pts.push(pts[0]);
  return { type: "way", id, tags: Object.assign({ golf: "green" }, ref ? { ref: String(ref) } : {}), geometry: geom(pts) };
}
function holeWay(id, ref, from, to) {
  return { type: "way", id, tags: { golf: "hole", ref: String(ref) }, geometry: geom([at(from[0], from[1]), at(to[0], to[1])]) };
}

/* Two nines of three holes each, both numbered 1-3, side by side 600m apart - the shape of
   Billingbear at a third of the size. Every green carries its nine's number, as OSM's do. */
const NINE_A = [[0, 0, 0, 300], [100, 300, 100, 0], [200, 0, 200, 350]];
const NINE_B = [[600, 0, 600, 150], [700, 150, 700, 0], [800, 0, 800, 160]];
function payload() {
  const elements = [];
  NINE_A.forEach((h, i) => { elements.push(holeWay(100 + i, i + 1, [h[0], h[1]], [h[2], h[3]])); elements.push(greenWay(200 + i, h[2], h[3], i + 1)); });
  NINE_B.forEach((h, i) => { elements.push(holeWay(300 + i, i + 1, [h[0], h[1]], [h[2], h[3]])); elements.push(greenWay(400 + i, h[2], h[3], i + 1)); });
  elements.push({ type: "way", id: 900, tags: { golf: "bunker" }, geometry: geom(circle(0, 250, 6).concat([circle(0, 250, 6)[0]])) });
  return { elements };
}
const OLD = { id: "po-old", name: "Old Course", holes: ["osm:way/100", "osm:way/101", "osm:way/102"] };
const NEW = { id: "po-new", name: "New Course", holes: ["osm:way/300", "osm:way/301", "osm:way/302"] };

test("course ids: the pinned course keeps its id, the rest are minted once and survive a rename", () => {
  const first = po.normalizePlayOrders([OLD, NEW], "billingbear-park");
  assert.deepStrictEqual(first.map(o => o.courseId), ["billingbear-park", "billingbear-park-new-course"]);
  const renamed = po.normalizePlayOrders([first[0], Object.assign({}, first[1], { name: "The Par Three" })], "billingbear-park");
  assert.strictEqual(renamed[1].courseId, "billingbear-park-new-course", "a rename keeps the id, so rounds and visuals stay with the course");
  const reordered = po.normalizePlayOrders([renamed[1], renamed[0]], "billingbear-park");
  assert.deepStrictEqual(reordered.map(o => o.courseId), ["billingbear-park-new-course", "billingbear-park"], "the pinned id stays with the play order that holds it");
  const foreign = po.normalizePlayOrders([OLD, Object.assign({}, NEW, { courseId: "another-club" })], "billingbear-park");
  assert.strictEqual(foreign[1].courseId, "billingbear-park-new-course", "another facility's id is never accepted");
  const same = po.normalizePlayOrders([OLD, Object.assign({}, NEW, { name: "Old Course" }), Object.assign({}, NEW, { id: "x", name: "Old Course" })], "billingbear-park");
  assert.deepStrictEqual(same.map(o => o.courseId), ["billingbear-park", "billingbear-park-old-course", "billingbear-park-old-course-2"], "two names that slug alike still get two ids");
});

test("hole references are cleaned: bad ones dropped, the same hole allowed in several play orders", () => {
  const out = po.normalizePlayOrders([{ name: "  A  ", holes: ["osm:way/1", "nonsense", "link:l-abc", "osm:node/4", "osm:way/1"] }, { holes: ["osm:way/1"] }], "x");
  assert.deepStrictEqual(out[0].holes, ["osm:way/1", "link:l-abc", "osm:way/1"], "a hole may even be played twice in one order (a nine played as 18)");
  assert.strictEqual(out[0].name, "A");
  assert.strictEqual(out[1].name, "Play order 2", "an unnamed play order gets a placeholder");
  assert.deepStrictEqual(out[1].holes, ["osm:way/1"]);
});

test("Billingbear: two nines numbered 1-3 twice publish as two courses of three", () => {
  const loops = po.playOrderLoops(payload(), [], [OLD, NEW], { pinnedCourseId: "billingbear-park", facilityName: "Billingbear Park Golf Course" });
  assert.strictEqual(loops.length, 2);
  assert.deepStrictEqual(loops.map(l => l.name), ["Billingbear Park Golf Course - Old Course", "Billingbear Park Golf Course - New Course"]);
  assert.deepStrictEqual(loops.map(l => l.courseId), ["billingbear-park", "billingbear-park-new-course"]);
  loops.forEach(loop => {
    const hole = loop.payload.elements.filter(e => e.tags && e.tags.golf === "hole");
    assert.strictEqual(hole.length, 3, "only this play order's hole lines are in its payload");
    const geometry = core.resolveCourseGeometry(loop.payload, loop.courseId, loop.centre, [], []);
    assert.deepStrictEqual(Object.keys(geometry.holes).sort(), ["1", "2", "3"], loop.name + " resolves all three holes");
  });
  const oldGreen = core.resolveCourseGeometry(loops[0].payload, "billingbear-park", loops[0].centre, [], []).holes["1"].greenCenter;
  const want = at(0, 300);
  assert.ok(Math.abs(oldGreen.lat - want.lat) < 0.0002 && Math.abs(oldGreen.lng - want.lng) < 0.0002, "the Old Course's hole 1 green is on the Old Course");
});

test("a different play order over the same holes renumbers them, and stale green numbers do not block it", () => {
  /* Back nine first: OSM's hole 3 green on nine B carries ref=3 but is now hole 1. */
  const order = { id: "po-x", name: "Reverse", holes: ["osm:way/302", "osm:way/301", "osm:way/300"] };
  const loop = po.playOrderLoops(payload(), [], [order], { pinnedCourseId: "c" })[0];
  const geometry = core.resolveCourseGeometry(loop.payload, "c", loop.centre, [], []);
  assert.deepStrictEqual(Object.keys(geometry.holes).sort(), ["1", "2", "3"]);
  const first = geometry.holes["1"].greenCenter;
  const want = at(800, 160);
  assert.ok(Math.abs(first.lat - want.lat) < 0.0002 && Math.abs(first.lng - want.lng) < 0.0002, "hole 1 is OSM's hole 3 of nine B");
  assert.ok(loop.payload.elements.filter(e => e.tags.golf === "green").every(e => e.tags.ref == null), "every green number is taken off");
});

test("a linked overlay hole becomes a numbered hole line; an incomplete one is reported, not guessed", () => {
  const features = [
    { id: "t1", kind: "tee", link: "l-a", points: circle(1200, 0, 4) },
    { id: "g1", kind: "green", link: "l-a", points: circle(1200, 140, 12) },
    { id: "g2", kind: "green", link: "l-b", points: circle(1300, 140, 12) }
  ];
  const order = { id: "po-p3", name: "Par 3", holes: ["link:l-a", "link:l-b", "link:l-missing", "osm:way/77"] };
  const built = po.playOrderPayload({ elements: [] }, features, order);
  assert.deepStrictEqual(built.holes.map(h => h.found), [true, false, false, false]);
  assert.deepStrictEqual(built.holes.slice(1).map(h => h.reason), ["link-has-no-tee", "link-not-found", "osm-hole-not-in-payload"]);
  const line = built.payload.elements.find(e => e.tags.golf === "hole");
  assert.strictEqual(line.tags.ref, "1");
});

test("the payload's overlay shapes on a linked hole take that hole's number", async () => {
  const overlay = await import(path.join(root, "functions", "lib", "gd-map-overlay-core.mjs"));
  const features = [
    { id: "t1", kind: "tee", link: "l-a", hole: 7, points: circle(1200, 0, 4) },
    { id: "g1", kind: "green", link: "l-a", hole: 7, points: circle(1200, 140, 12) }
  ];
  const merged = overlay.mergeOverlayIntoPayload({ elements: [] }, features);
  const loop = po.playOrderLoops(merged, features, [{ id: "a", name: "A", holes: ["link:l-a"] }], { pinnedCourseId: "c" })[0];
  const green = loop.payload.elements.find(e => e.tags["clarity:overlay"] === "g1");
  assert.strictEqual(green.tags.ref, "1", "hole 7 on the overlay is hole 1 of this play order");
  assert.strictEqual(loop.payload.elements.filter(e => e.tags.golf === "hole").length, 1, "the overlay's own derived hole-7 line is replaced, not kept beside it");
  const geometry = core.resolveCourseGeometry(loop.payload, "c", loop.centre, [], []);
  assert.deepStrictEqual(Object.keys(geometry.holes), ["1"]);
});

test("the pinned course comes first, and an empty play order is left out", () => {
  const orders = po.normalizePlayOrders([OLD, NEW], "billingbear-park");
  const loops = po.playOrderLoops(payload(), [], [orders[1], orders[0], { id: "e", name: "Empty", holes: [] }], { pinnedCourseId: "billingbear-park" });
  assert.deepStrictEqual(loops.map(l => l.courseId), ["billingbear-park", "billingbear-park-new-course"]);
  assert.deepStrictEqual(loops.map(l => l.index), [0, 1]);
  assert.strictEqual(po.playOrderCourseName("Billingbear Park New Course", "Billingbear Park"), "Billingbear Park New Course", "the facility is not said twice");
});

(async () => {
  po = await import(path.join(root, "functions", "lib", "gd-play-order-core.mjs"));
  core = await import(path.join(root, "functions", "lib", "gd-automapper-core.mjs"));
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.stack || error)); }
  }
  console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " play order checks");
  process.exit(failed ? 1 : 0);
})();
