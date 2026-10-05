/* scripts/studio/courses/map-overlay/map-overlay-shapes.js: the shapes the Mapping Overlay
 * places by eye - a fairway around a laid line, a tee box, a default round green, and two
 * overlapping bunkers merged into one.
 *
 * Run: node dev/map-overlay-shapes.test.js */
const assert = require("assert");
const path = require("path");
const shapes = require(path.join(__dirname, "..", "scripts", "studio", "courses", "map-overlay", "map-overlay-shapes.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const LAT = 54.62, LNG = -5.85;
const mLat = 1 / 111320, mLng = 1 / (111320 * Math.cos(LAT * Math.PI / 180));
/* A point dx metres east and dy metres north of the origin. */
function at(dx, dy) { return { lat: LAT + dy * mLat, lng: LNG + dx * mLng }; }
function area(ring) {
  let a = 0;
  const pts = ring.map(p => ({ x: (p.lng - LNG) / mLng, y: (p.lat - LAT) / mLat }));
  for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i].x * pts[j].y - pts[j].x * pts[i].y; }
  return Math.abs(a / 2);
}

test("a straight 300m line becomes a fairway about the chosen width, with corners to drag", () => {
  const ring = shapes.fairwayFromLine([at(0, 0), at(0, 300)], 35);
  assert.ok(ring && ring.length >= 20 && ring.length <= 42, "expected a ring with a corner every ~30m, got " + (ring && ring.length));
  assert.ok(ring.length <= shapes.MAX_POINTS, "must fit the overlay's point cap");
  const a = area(ring);
  assert.ok(a > 300 * 35 * 0.95 && a < 300 * 35 * 1.15, "area " + Math.round(a) + " is not ~" + 300 * 35);
  const xs = ring.map(p => (p.lng - LNG) / mLng);
  assert.ok(Math.abs(Math.max(...xs) - 17.5) < 0.5 && Math.abs(Math.min(...xs) + 17.5) < 0.5, "sides sit half the width out");
});

test("a long dogleg still fits under the point cap", () => {
  const ring = shapes.fairwayFromLine([at(0, 0), at(0, 350), at(250, 550)], 40);
  assert.ok(ring.length <= shapes.MAX_POINTS, "got " + ring.length);
  assert.ok(ring.length >= 30 && ring.length <= 42, "got " + ring.length);
});

test("too short a line, or one point, makes no fairway", () => {
  assert.strictEqual(shapes.fairwayFromLine([at(0, 0)], 35), null);
  assert.strictEqual(shapes.fairwayFromLine([at(0, 0), at(0, 2)], 35), null);
});

test("a tee is a round marker that faces nowhere", () => {
  const tee = shapes.teeAt(at(0, 0));
  assert.strictEqual(tee.length, 12);
  const r = tee.map(p => Math.hypot((p.lng - LNG) / mLng, (p.lat - LAT) / mLat));
  assert.ok(r.every(d => Math.abs(d - shapes.TEE_RADIUS_M) < 0.01), "every corner sits on the tee's radius");
});

test("a green is kept as a smooth curve through six handles, and reads them back exactly", () => {
  const wand = shapes.circle(at(0, 0), 14, 40);
  const { handles: n, steps } = shapes.SMOOTH.green;
  assert.strictEqual(n, 6);
  const green = shapes.smoothOutline(wand, "green");
  assert.strictEqual(green.length, n * steps);
  const handles = shapes.ringHandles(green, n, steps);
  assert.strictEqual(handles.length, n);
  handles.forEach((h, i) => assert.deepStrictEqual(h, green[i * steps]));
  assert.deepStrictEqual(shapes.smoothRing(handles, steps), green, "re-curving through the same handles changes nothing");
  const moved = handles.slice(); moved[0] = at(25, 0);
  const pulled = shapes.smoothRing(moved, steps);
  assert.ok(Math.abs((pulled[0].lng - LNG) / mLng - 25) < 1e-6, "the outline passes through a dragged handle");
});

test("a bunker is kept as a smooth curve through a few handles too, far fewer than the wand's corners", () => {
  const { handles: n, steps } = shapes.SMOOTH.bunker;
  assert.ok(n <= 8, "a bunker should be moved by a handful of points, got " + n);
  const wand = shapes.circle(at(0, 0), 6, 16);
  const bunker = shapes.smoothOutline(wand, "bunker");
  assert.strictEqual(bunker.length, n * steps);
  assert.ok(bunker.length <= shapes.MAX_POINTS);
  const handles = shapes.ringHandles(bunker, n, steps);
  handles.forEach((h, i) => assert.deepStrictEqual(h, bunker[i * steps]));
  assert.ok(Math.abs(area(bunker) - area(wand)) / area(wand) < 0.06, "smoothing keeps the bunker's size");
});

test("kinds that are not smooth come back untouched", () => {
  const ring = shapes.circle(at(0, 0), 15, 10);
  assert.strictEqual(shapes.smoothOutline(ring, "water"), ring);
  assert.strictEqual(shapes.smoothOutline(ring, "tee"), ring);
});

test("a water hazard drawn round by hand keeps its shape in a few corners", () => {
  /* A wobbly hand-drawn loop round a 40x20m pond: 400 points, each a little off the ellipse. */
  const drawn = [];
  for (let i = 0; i < 400; i++) {
    const a = (i / 400) * Math.PI * 2, wobble = 1 + 0.01 * Math.sin(i * 7);
    drawn.push(at(Math.cos(a) * 20 * wobble, Math.sin(a) * 10 * wobble));
  }
  drawn.push(drawn[0]);
  const ring = shapes.simplifyOutline(drawn, shapes.WATER_MAX_POINTS);
  assert.ok(ring && ring.length >= 8 && ring.length <= shapes.WATER_MAX_POINTS, "got " + (ring && ring.length));
  const painted = Math.PI * 20 * 10;
  assert.ok(Math.abs(area(ring) - painted) / painted < 0.06, "area " + area(ring).toFixed(1) + " vs " + painted.toFixed(1));
  assert.strictEqual(shapes.simplifyOutline([at(0, 0), at(5, 0)]), null, "two points outline nothing");
  assert.strictEqual(shapes.simplifyOutline([at(0, 0), at(5, 0), at(10, 0)]), null, "a straight scribble outlines nothing");
});

test("smaller and bigger scale a shape about its middle", () => {
  const tee = shapes.teeAt(at(10, 10));
  const bigger = shapes.scaleAbout(tee, 1.5);
  assert.ok(Math.abs(area(bigger) / area(tee) - 2.25) < 0.01, "1.5x across is 2.25x the area");
  const a = shapes.centroid(tee), b = shapes.centroid(bigger);
  assert.ok(shapes.distanceM(a, b) < 0.01, "it stays where it was");
});

test("two overlapping bunkers merge into one outline covering both", () => {
  const a = shapes.circle(at(0, 0), 6, 16), b = shapes.circle(at(8, 0), 6, 16);
  const merged = shapes.mergeOverlapping(a, b);
  assert.ok(merged && merged.length >= 3 && merged.length <= shapes.MAX_POINTS, "got " + (merged && merged.length));
  /* Two r=6 discs 8m apart cover ~201m2; the 16-gons a little less. */
  assert.ok(area(merged) > 190 && area(merged) < 205, "merged area " + area(merged).toFixed(1));
  const xs = merged.map(p => (p.lng - LNG) / mLng);
  assert.ok(Math.min(...xs) < -5.5 && Math.max(...xs) > 13.5, "the outline must reach both ends");
});

test("bunkers that do not overlap are not merged", () => {
  assert.strictEqual(shapes.mergeOverlapping(shapes.circle(at(0, 0), 6), shapes.circle(at(20, 0), 6)), null);
});

test("a bunker inside another merges to the bigger one", () => {
  const merged = shapes.mergeOverlapping(shapes.circle(at(0, 0), 10, 16), shapes.circle(at(1, 0), 3, 16));
  assert.ok(Math.abs(area(merged) - area(shapes.circle(at(0, 0), 10, 16))) < 8, "area " + area(merged).toFixed(1));
});

test("a default green is a round ring of the requested size", () => {
  const ring = shapes.circle(at(0, 0), 14, 16);
  assert.strictEqual(ring.length, 16);
  const a = area(ring);
  assert.ok(a > Math.PI * 14 * 14 * 0.95 && a < Math.PI * 14 * 14, "area " + a);
});

/* A striped fairway band on darker rough, with noise: what the line wand is for. */
function bandImage(w, h, halfWidth) {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, centre = 150 + 0.2 * (x - 200), n = (rnd() - 0.5) * 30;
    const stripe = Math.floor(x / 12) % 2 ? 14 : 0;
    if (Math.abs(y - centre) < halfWidth) { data[i] = 95 + stripe + n; data[i + 1] = 165 + stripe + n; data[i + 2] = 70 + n; }
    else { data[i] = 60 + n; data[i + 1] = 95 + n; data[i + 2] = 45 + n; }
    data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

test("the line wand grows a line out to the band it runs down, not past it", () => {
  const image = bandImage(400, 300, 30);
  const line = [{ x: 40, y: 118 }, { x: 360, y: 182 }];
  const out = shapes.growFromLine(image, line, { reachPx: 80, blurPx: 2, openPx: 2 });
  assert.ok(out.candidates.length >= 1, "no edge found: " + out.reason);
  const area = out.areas[out.pick];
  /* The band is 60px across and runs the width of the picture (~408px along its slope). */
  assert.ok(area > 60 * 408 * 0.8 && area < 60 * 408 * 1.2, "area " + area);
  /* Every corner sits on the band's edge (30px either side of its centre line), give or take
     the blur and the simplification. */
  const off = out.candidates[out.pick].map(p => Math.abs(p.y - (150 + 0.2 * (p.x - 200))));
  assert.ok(Math.max(...off) < 36, "a corner strayed off the band: " + Math.max(...off).toFixed(1) + "px from its middle");
});

test("the line wand stops at its reach when the colour runs on", () => {
  const image = bandImage(400, 300, 400);
  const out = shapes.growFromLine(image, [{ x: 150, y: 150 }, { x: 250, y: 150 }], { reachPx: 20, blurPx: 1 });
  const area = out.areas[out.pick];
  assert.ok(area < (100 + 40) * 40 * 1.1, "grew past its reach: " + area);
});

test("a single tree is a small ring of its radius, and reads its radius back", () => {
  const tree = shapes.treeAt(at(0, 0));
  assert.ok(tree.length <= 12, "a tree must stay light - a course holds hundreds");
  assert.ok(Math.abs(shapes.ringRadiusM(tree) - shapes.TREE_RADIUS_M) < 0.01);
  assert.ok(Math.abs(shapes.ringRadiusM(shapes.treeAt(at(0, 0), 7)) - 7) < 0.01);
});

test("a cluster oval fills the box it was stretched across", () => {
  const oval = shapes.ellipseInBox(at(0, 0), at(60, 20));
  const xs = oval.map(p => (p.lng - LNG) / mLng), ys = oval.map(p => (p.lat - LAT) / mLat);
  assert.ok(Math.abs(Math.min(...xs)) < 0.2 && Math.abs(Math.max(...xs) - 60) < 0.2, "spans the box east to west");
  assert.ok(Math.abs(Math.min(...ys)) < 0.5 && Math.abs(Math.max(...ys) - 20) < 0.5, "spans the box north to south");
  const round = shapes.ellipseInBox(at(0, 0), at(60, 20), true);
  assert.ok(Math.abs(shapes.ringRadiusM(round) - 30) < 0.5, "round: as wide as the longer side");
});

/* Grass with round dark-green crowns on it, a few px of noise. */
function treesImage(w, h, crowns) {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, n = (rnd() - 0.5) * 16;
    const tree = crowns.some(c => Math.hypot(x - c.x, y - c.y) <= c.r);
    if (tree) { data[i] = 35 + n; data[i + 1] = 70 + n; data[i + 2] = 30 + n; }
    else { data[i] = 120 + n; data[i + 1] = 165 + n; data[i + 2] = 80 + n; }
    data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

test("the tree finder finds trees that look like the sampled one, and leaves placed ones alone", () => {
  const crowns = [{ x: 40, y: 40, r: 10 }, { x: 120, y: 60, r: 9 }, { x: 70, y: 140, r: 11 }, { x: 160, y: 150, r: 10 }];
  const image = treesImage(200, 200, crowns);
  const model = shapes.colourModel(shapes.circleSamples(image, crowns[0], 7, 1));
  const finder = shapes.treeFinder(image, model, { radiusPx: 10, avoid: [crowns[0]] });
  const found = finder.find(shapes.TREE_FINDER_LEVELS[2]);
  assert.strictEqual(found.length, 3, "found " + JSON.stringify(found));
  crowns.slice(1).forEach(c => {
    assert.ok(found.some(t => Math.hypot(t.x - c.x, t.y - c.y) < 4 && Math.abs(t.r - c.r) < 4), "missed the tree at " + c.x + "," + c.y);
  });
});

test("the tree finder only looks inside its box, and spaces a row of trees out", () => {
  const row = [];
  for (let x = 30; x <= 170; x += 14) row.push({ x, y: 100, r: 9 });
  const image = treesImage(200, 200, row.concat([{ x: 100, y: 30, r: 10 }]));
  const model = shapes.colourModel(shapes.circleSamples(image, row[0], 6, 1));
  const found = shapes.treeFinder(image, model, { radiusPx: 9, box: { x0: 0, y0: 70, x1: 200, y1: 130 } }).find(shapes.TREE_FINDER_LEVELS[2]);
  assert.ok(found.every(t => t.y > 70 && t.y < 130), "a tree outside the box was found");
  assert.ok(found.length >= 6 && found.length <= 12, "a row of 11 crowns: found " + found.length);
});

test("the area wand pushes a rough drawn shape out to the patch it sits in", () => {
  /* A sandy patch 100 x 60 on grass; the hand drew a smaller blob inside it. */
  const w = 200, h = 160, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, sand = x >= 50 && x < 150 && y >= 50 && y < 110;
    data[i] = sand ? 205 : 90; data[i + 1] = sand ? 185 : 150; data[i + 2] = sand ? 140 : 70; data[i + 3] = 255;
  }
  const drawn = [{ x: 70, y: 65 }, { x: 120, y: 62 }, { x: 128, y: 95 }, { x: 75, y: 98 }];
  const out = shapes.growFromArea({ width: w, height: h, data }, drawn, { reachPx: 40, blurPx: 1 });
  assert.ok(out.candidates.length >= 1, "no edge: " + out.reason);
  const area = out.areas[out.pick];
  assert.ok(area > 100 * 60 * 0.9 && area < 100 * 60 * 1.15, "area " + area);
});

test("the colour wand selects the connected patch of the colour pressed on, more with more tolerance", () => {
  const w = 120, h = 80, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const patch = x >= 20 && x < 60 && y >= 20 && y < 60;
    const near = x >= 60 && x < 80 && y >= 20 && y < 60;
    data[i] = patch ? 200 : near ? 185 : 80; data[i + 1] = patch ? 180 : near ? 168 : 140; data[i + 2] = patch ? 130 : near ? 120 : 60; data[i + 3] = 255;
  }
  const field = shapes.colourField({ width: w, height: h, data }, 0);
  const count = m => m.reduce((a, v) => a + v, 0);
  const tight = shapes.floodSelect(field, 30, 30, 5);
  assert.strictEqual(count(tight), 40 * 40, "just the patch");
  const loose = shapes.floodSelect(field, 30, 30, 30);
  assert.strictEqual(count(loose), 60 * 40, "the patch and the similar ground next to it");
  const ring = shapes.maskOutline(tight, w, h, 48);
  assert.ok(ring && ring.length >= 4 && ring.length <= 48);
});

test("the line wand refuses a line off the picture", () => {
  const out = shapes.growFromLine(bandImage(50, 50, 10), [{ x: -100, y: -100 }, { x: -90, y: -100 }], { reachPx: 10 });
  assert.strictEqual(out.candidates.length, 0);
});

function wigglyRing(n, r, bumps) {
  const out = [];
  for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI, rr = r + r * 0.08 * Math.sin(a * bumps); out.push({ x: 500 + rr * Math.cos(a), y: 500 + rr * Math.sin(a) }); }
  return out;
}

test("a detailed outline shows a few key corners, not every corner", () => {
  const ring = wigglyRing(200, 200, 9);
  const keys = shapes.keyCorners(ring);
  assert.ok(keys.length >= 8 && keys.length <= 24, "got " + keys.length);
  keys.forEach((k, i) => assert.ok(i === 0 || k > keys[i - 1], "key corners come in order"));
  assert.deepStrictEqual(shapes.keyCorners([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }, { x: 0, y: 300 }]), [0, 1, 2, 3], "a square keeps its four corners");
});

test("a grab on the edge bends it smoothly there, and only there", () => {
  const sq = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }, { x: 0, y: 300 }];
  const at = shapes.nearestOnRing(sq, { x: 150, y: 4 });
  assert.strictEqual(at.segment, 0);
  const bend = shapes.bendRing(sq, at, { keys: [0, 1, 2, 3], maxReachPx: 40 });
  const moved = bend.ring.map((p, i) => ({ x: p.x, y: p.y + 20 * bend.weights[i] }));
  const grabbed = moved.find(p => Math.abs(p.x - 150) < 1e-6);
  assert.ok(grabbed && Math.abs(grabbed.y - 20) < 1e-6, "the grabbed point follows the pointer");
  moved.forEach(p => { if (Math.abs(p.x - 150) > 40) assert.ok(Math.abs(p.y) < 1e-6 || p.y === 300, "beyond the reach nothing moves"); });
  assert.ok(moved.filter(p => p.y > 0.5 && p.y < 19.5).length >= 4, "it bends as a curve, not a tent");
  assert.deepStrictEqual(moved[0], { x: 0, y: 0 }, "the first corner stays first");
  const tidy = shapes.tidyBend(moved, bend.added);
  assert.ok(tidy.length < moved.length && tidy.length > 4, "the flat corners the bend put in go again");
});

test("a key corner dragged keeps the edges either side straight", () => {
  const sq = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }, { x: 0, y: 300 }];
  const bend = shapes.bendRing(sq, { index: 1 }, { keys: [0, 1, 2, 3] });
  assert.deepStrictEqual(bend.weights, [0, 1, 0, 0]);
  const dense = [];
  for (let i = 0; i < 30; i++) dense.push({ x: i * 10, y: 0 });
  dense.push({ x: 300, y: 150 }, { x: 0, y: 150 });
  const b2 = shapes.bendRing(dense, { index: 15 }, { keys: [0, 29, 30, 31] });
  const w = b2.weights;
  assert.ok(Math.abs(w[15] - 1) < 1e-9 && w[0] === 0 && w[29] === 0, "the key corners either side stay put");
  assert.ok(Math.abs(w[8] - (8 / 15)) < 1e-9, "the stretch between follows in proportion");
});

let failed = 0;
tests.forEach(t => {
  try { t.fn(); console.log("  ok  " + t.name); }
  catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.message)); }
});
console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " map overlay shape checks");
process.exit(failed ? 1 : 0);
