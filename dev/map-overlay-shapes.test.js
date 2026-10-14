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

test("kinds that are not smooth or softened come back untouched", () => {
  const ring = shapes.circle(at(0, 0), 15, 10);
  assert.strictEqual(shapes.smoothOutline(ring, "tee"), ring);
  assert.strictEqual(shapes.smoothOutline(ring, "hazard"), ring);
});

test("a fairway, water or waste wand edge is softened: the stair-steps go, the shape stays", () => {
  /* A 40m x 200m fairway traced a 0.4m pixel at a time: every corner a stair-step, with a
     one-pixel spur sticking out every few metres. */
  const px = 0.4, traced = [];
  const edge = (t) => 20 + 2 * Math.sin(t / 15);
  for (let y = -100; y < 100; y += px) traced.push(at(Math.round(edge(y) / px) * px + (Math.round(y / px) % 9 === 0 ? px : 0), y));
  for (let y = 100; y > -100; y -= px) traced.push(at(-Math.round(edge(y) / px) * px, y));
  ["fairway", "water", "waste"].forEach(kind => {
    const soft = shapes.smoothOutline(traced, kind);
    assert.notStrictEqual(soft, traced, kind + " should be softened");
    assert.ok(soft.length < traced.length / 4, kind + ": far fewer corners than the trace, got " + soft.length);
    assert.ok(soft.length <= shapes.DETAIL_MAX_POINTS);
    assert.ok(Math.abs(area(soft) - area(traced)) / area(traced) < 0.02, kind + ": softening keeps its size");
    /* No corner turns sharply along the long sides: the steps and spurs are gone. */
    const xy = soft.map(p => ({ x: (p.lng - LNG) / mLng, y: (p.lat - LAT) / mLat }));
    xy.forEach((p, i) => {
      if (Math.abs(p.y) > 80) return;
      const a = xy[(i - 1 + xy.length) % xy.length], b = xy[(i + 1) % xy.length];
      const u = { x: p.x - a.x, y: p.y - a.y }, v = { x: b.x - p.x, y: b.y - p.y };
      const turn = Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y)))));
      assert.ok(turn < 0.35, kind + ": a jagged corner survived at y=" + p.y.toFixed(1) + " (" + (turn * 180 / Math.PI).toFixed(0) + " degrees)");
    });
  });
});

test("a tiny wand edge is left as it is rather than eased away", () => {
  const ring = shapes.circle(at(0, 0), 1, 8);
  assert.strictEqual(shapes.softenOutline(ring), ring);
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

/* A fairway along the bottom of the picture, rough above it, and on the rough: a row of
   textured dark-green crowns, a dark grey-blue shadow, and a dark but smooth patch of rough. */
const NEAR_PLAY = {
  w: 300, h: 200, fairway: [{ x: -5, y: 120 }, { x: 305, y: 120 }, { x: 305, y: 205 }, { x: -5, y: 205 }],
  crowns: [{ x: 40, y: 80, r: 12 }, { x: 90, y: 75, r: 12 }, { x: 140, y: 82, r: 12 }],
  shadow: { x: 200, y: 80, r: 14 }, smooth: { x: 255, y: 70, r: 16 }
};
function nearPlayImage() {
  const { w, h, crowns, shadow, smooth } = NEAR_PLAY;
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 23;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const inDisc = (x, y, c) => Math.hypot(x - c.x, y - c.y) <= c.r;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let rgb, n;
    if (crowns.some(c => inDisc(x, y, c))) { rgb = [40, 75, 35]; n = (rnd() - 0.5) * 50; }
    else if (inDisc(x, y, shadow)) { rgb = [45, 50, 62]; n = (rnd() - 0.5) * 40; }
    else if (inDisc(x, y, smooth)) { rgb = [45, 75, 35]; n = (rnd() - 0.5) * 4; }
    else if (y >= 120) { rgb = [110, 160, 75]; n = (rnd() - 0.5) * 12; }
    else { rgb = [85, 125, 60]; n = (rnd() - 0.5) * 12; }
    data[i] = rgb[0] + n; data[i + 1] = rgb[1] + n; data[i + 2] = rgb[2] + n; data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

test("the band near play runs along the fairway, clear of it and of the other surfaces", () => {
  const { w, h, fairway } = NEAR_PLAY;
  const bunker = [{ x: 150, y: 60 }, { x: 170, y: 60 }, { x: 170, y: 80 }, { x: 150, y: 80 }];
  const wood = [{ x: 250, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 50 }, { x: 250, y: 50 }];
  const band = shapes.playBand(w, h, { play: [fairway], surfaces: [bunker], woods: [wood], bandPx: 100, clearPx: 10 });
  const at = (x, y) => band[y * w + x];
  assert.strictEqual(at(100, 150), 0, "nothing on the fairway itself");
  assert.strictEqual(at(100, 115), 0, "nothing within the clearance of its edge");
  assert.strictEqual(at(100, 100), 1, "the rough beside it is looked at");
  assert.strictEqual(at(100, 10), 0, "nothing past the band");
  assert.strictEqual(at(160, 70), 0, "nothing on a bunker");
  assert.strictEqual(at(160, 55), 0, "nor within the clearance of one");
  assert.strictEqual(at(270, 40), 0, "nor inside a wood already drawn");
});

test("trees near play: crowns beside the fairway are found with no samples - not the shadow, not the smooth rough, nothing on the turf", () => {
  const { w, h, fairway, crowns } = NEAR_PLAY;
  const image = nearPlayImage();
  const turf = shapes.ringsMask(w, h, [fairway]);
  const band = shapes.playBand(w, h, { play: [fairway], bandPx: 100, clearPx: 10 });
  const auto = shapes.autoTreeModel(image, turf, band, { radiusPx: 12 });
  assert.ok(auto.model, "no crown colour learnt: " + auto.reason);
  const found = shapes.treeFinder(image, auto.model, { radiusPx: 12, inside: auto.allow }).find(shapes.TREE_FINDER_LEVELS[2]);
  crowns.forEach(c => assert.ok(found.some(t => Math.hypot(t.x - c.x, t.y - c.y) < 5), "missed the crown at " + c.x + "," + c.y + ": " + JSON.stringify(found)));
  assert.strictEqual(found.length, crowns.length, "found " + JSON.stringify(found));
  assert.ok(found.every(t => t.y < 120), "a tree on the turf");
});

test("trees near play: no turf to learn from, or nothing tree-like in the band, finds nothing", () => {
  const { w, h, fairway } = NEAR_PLAY;
  const image = nearPlayImage();
  const band = shapes.playBand(w, h, { play: [fairway], bandPx: 100, clearPx: 10 });
  assert.strictEqual(shapes.autoTreeModel(image, new Uint8Array(w * h), band, { radiusPx: 12 }).reason, "no-turf");
  const bare = shapes.autoTreeModel(image, shapes.ringsMask(w, h, [fairway]), shapes.playBand(w, h, { play: [fairway], bandPx: 20, clearPx: 10 }), { radiusPx: 12 });
  assert.strictEqual(bare.model, null, "the strip next to the fairway is plain rough");
});

test("a run's trees at every sensitivity: each level holds the stricter ones and adds to them", () => {
  const crowns = [{ x: 40, y: 40, r: 10 }, { x: 120, y: 60, r: 9 }, { x: 70, y: 140, r: 11 }, { x: 160, y: 150, r: 10 }];
  const image = treesImage(200, 200, crowns);
  const finder = shapes.treeFinder(image, shapes.colourModel(shapes.circleSamples(image, crowns[0], 7, 1)), { radiusPx: 10 });
  const nested = shapes.nestedTrees(finder);
  assert.ok(nested.every(t => t.l >= 0 && t.l < shapes.TREE_FINDER_LEVELS.length), "every tree knows the strictest level that finds it");
  const at = level => nested.filter(t => t.l <= level).length;
  for (let l = 1; l < shapes.TREE_FINDER_LEVELS.length; l++) assert.ok(at(l) >= at(l - 1), "looser never finds fewer");
  assert.ok(Math.abs(at(2) - finder.find(shapes.TREE_FINDER_LEVELS[2]).length) <= 1, "a level holds what the finder finds at it");
  crowns.forEach(c => assert.ok(nested.some(t => Math.hypot(t.x - c.x, t.y - c.y) < 4), "the crown at " + c.x + "," + c.y));
});

test("trees near play: each sensitivity asks its own darkness and texture, so More finds more and Less fewer", () => {
  /* Crowns from plainly a tree (dark, busy) to barely one (a little darker than the rough,
     a little busy), on rough beside a fairway. */
  const w = 400, h = 200, data = new Uint8ClampedArray(w * h * 4);
  let seed = 31;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const crowns = [
    { x: 40, y: 70, rgb: [40, 75, 35], amp: 50 }, { x: 110, y: 70, rgb: [50, 85, 40], amp: 40 },
    { x: 180, y: 70, rgb: [60, 95, 45], amp: 30 }, { x: 250, y: 70, rgb: [66, 102, 48], amp: 24 },
    { x: 320, y: 70, rgb: [70, 106, 50], amp: 20 }
  ];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, c = crowns.find(k => Math.hypot(x - k.x, y - k.y) <= 12);
    const rgb = c ? c.rgb : y >= 120 ? [110, 160, 75] : [85, 125, 60], n = (rnd() - 0.5) * (c ? c.amp : 12);
    data[i] = rgb[0] + n; data[i + 1] = rgb[1] + n; data[i + 2] = rgb[2] + n; data[i + 3] = 255;
  }
  const image = { width: w, height: h, data };
  const fairway = [{ x: -5, y: 120 }, { x: 405, y: 120 }, { x: 405, y: 205 }, { x: -5, y: 205 }];
  const auto = shapes.autoTreeModel(image, shapes.ringsMask(w, h, [fairway]), shapes.playBand(w, h, { play: [fairway], bandPx: 100, clearPx: 10 }), { radiusPx: 12 });
  const nested = shapes.nestedTrees(shapes.treeFinder(image, auto.model, { radiusPx: 12, insideAt: auto.allowAt }));
  const at = l => nested.filter(t => t.l <= l).length;
  assert.ok(at(0) < at(2) && at(2) < at(5), "strict " + at(0) + ", default " + at(2) + ", loose " + at(5));
  assert.ok(nested.filter(t => t.l === 0).every(t => crowns.slice(3).every(c => Math.hypot(t.x - c.x, t.y - c.y) >= 12)), "the strictest never keeps the faintest crowns");
  assert.ok(nested.every(t => crowns.some(c => Math.hypot(t.x - c.x, t.y - c.y) < 12)), "even the loosest finds crowns, not rough");
});

test("tree heights: a canopy grid lines up with the picture, and gates the crowns", () => {
  /* A picture at zoom 18 whose top-left is world pixel (1000, 2000); a Web Mercator grid of
     4 x 4 one-metre cells starting exactly there, tall only in its top-left cell. */
  const z = 18, world = 256 * Math.pow(2, z), C = 2 * Math.PI * 6378137, mpp = C / world;
  const cap = { width: 8, height: 8, z, ox: 1000, oy: 2000 };
  const x0 = (1000 / world - 0.5) * C, y0 = (0.5 - 2000 / world) * C;
  const heights = new Uint8Array(16);
  heights[0] = 9;
  const grid = { crs: "EPSG:3857", x0, y0, dx: 1, dy: -1, width: 4, height: 4, heights };
  const mask = shapes.heightMask(cap, [grid], 3);
  const cell = Math.floor(1 / mpp);
  assert.strictEqual(mask[0], 1, "the tall cell's corner pixel is tall");
  assert.strictEqual(mask[(cell - 1) * 8 + cell - 1], 1, "and so is the rest of that metre");
  assert.strictEqual(mask[(cell + 1) * 8 + cell + 1], 0, "the next metre is not");
  assert.strictEqual(shapes.heightMask(cap, [Object.assign({}, grid, { heights: new Uint8Array(16) })], 3), null, "all zero is no data, not no trees");

  const { w, h, fairway, crowns } = NEAR_PLAY;
  const image = nearPlayImage();
  const tall = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.hypot(x - crowns[0].x, y - crowns[0].y) <= 16) tall[y * w + x] = 1;
  const auto = shapes.autoTreeModel(image, shapes.ringsMask(w, h, [fairway]), shapes.playBand(w, h, { play: [fairway], bandPx: 100, clearPx: 10 }), { radiusPx: 12, tall });
  const found = shapes.treeFinder(image, auto.model, { radiusPx: 12, inside: auto.allow }).find(shapes.TREE_FINDER_LEVELS[2]);
  assert.strictEqual(found.length, 1, "only the crown that stands tall: " + JSON.stringify(found));
  const byHeight = shapes.treesInMask(tall, w, h, { radiusPx: 12 });
  assert.ok(byHeight.length === 1 && Math.hypot(byHeight[0].x - crowns[0].x, byHeight[0].y - crowns[0].y) < 3, "a tree from its height alone");
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

const SEAM_LAT = -35, SEAM_K = Math.cos(SEAM_LAT * Math.PI / 180);
const seamLL = (x, y) => ({ lat: SEAM_LAT + y / 111320, lng: 170 + x / (111320 * SEAM_K) });
const seamXY = p => ({ x: (p.lng - 170) * 111320 * SEAM_K, y: (p.lat - SEAM_LAT) * 111320 });
const seamRect = (x0, y0, x1, y1) => [seamLL(x0, y0), seamLL(x1, y0), seamLL(x1, y1), seamLL(x0, y1)];
const sharedCorners = (a, b) => { const keys = new Set(b.map(shapes.pointKey)); return a.filter(p => keys.has(shapes.pointKey(p))); };

test("a small gap between two areas closes in the middle, as one shared seam", () => {
  const out = shapes.seamPair(seamRect(0, 0, 100, 60), seamRect(103, -20, 200, 80));
  assert.ok(out && out.seams === 1, "they must seam");
  const shared = sharedCorners(out.a, out.b);
  assert.ok(shared.length >= 2, "the seam is the very same corners in both");
  shared.forEach(p => assert.ok(Math.abs(seamXY(p).x - 101.5) < 0.05, "the seam runs down the middle of the gap"));
  assert.deepStrictEqual(out.a[0], seamRect(0, 0, 100, 60)[0], "a corner the seam never reached keeps its exact coordinates");
});

test("a thin overlap splits down its middle; a wide gap or a shape inside another is left alone", () => {
  const out = shapes.seamPair(seamRect(0, 0, 100, 60), seamRect(98, -20, 200, 80));
  assert.ok(out, "a thin overlap must seam");
  const xs = out.a.map(p => seamXY(p).x);
  assert.ok(Math.max(...xs) < 99.05, "the first shape stops at the middle of the overlap");
  assert.ok(Math.min(...out.b.map(p => seamXY(p).x)) > 97.95, "the second keeps no more than it had");
  assert.strictEqual(shapes.seamPair(seamRect(0, 0, 100, 60), seamRect(108, -20, 200, 80)), null, "8m apart is not a seam");
  assert.strictEqual(shapes.seamPair(seamRect(0, 0, 100, 60), seamRect(10, 10, 30, 30)), null, "a pond in a waste area is not a seam");
});

test("a wiggly edge seams as one line, and corners shared with a third shape stay put", () => {
  const wiggle = [];
  for (let i = 0; i <= 40; i++) wiggle.push(seamLL(103 + 2 * Math.sin(i / 3), 60 - i * 2));
  const b = wiggle.concat([seamLL(200, -20), seamLL(200, 60)]);
  const a = seamRect(0, 0, 100, 60);
  const out = shapes.seamPair(a, b);
  assert.ok(out && out.seams === 1, "got " + (out && out.seams));
  const locked = shapes.seamPair(a, b, { lockedA: [false, true, true, false] });
  assert.ok(!locked || (locked.a.some(p => shapes.pointKey(p) === shapes.pointKey(a[1])) && locked.a.some(p => shapes.pointKey(p) === shapes.pointKey(a[2]))), "locked corners must survive");
});

test("a seam dragged on one side moves the other side with it", () => {
  const out = shapes.seamPair(seamRect(0, 0, 100, 60), seamRect(103, -20, 200, 80));
  const runs = shapes.weldRuns(out.b, out.a);
  assert.ok(runs.length === 1 && runs[0].g.length >= 2);
  const at = out.a.findIndex(p => sharedCorners([p], out.b).length);
  const moved = out.a.map(p => ({ lat: p.lat, lng: p.lng }));
  const from = moved.map((p, i) => i);
  moved[at] = seamLL(110, seamXY(moved[at]).y);
  /* A corner put in along the seam is taken by the other side too. */
  const mid = seamLL(105, 30);
  moved.splice(at + 1, 0, mid);
  from.splice(at + 1, 0, -1);
  const b = shapes.applyWeld(out.b, runs, moved, from);
  assert.strictEqual(sharedCorners(moved, b).length, sharedCorners(out.a, out.b).length + 1);
  assert.ok(b.some(p => shapes.pointKey(p) === shapes.pointKey(mid)));
});

/* ---- ↑ ↓ on a green or fairway, and the collar ---- */
const RC = { lat: 55.04, lng: -7.29 };
const RK = Math.cos(RC.lat * Math.PI / 180);
function rLL(x, y) { return { lat: RC.lat + y / 111320, lng: RC.lng + x / (111320 * RK) }; }
function rXY(p) { return { x: (p.lng - RC.lng) * 111320 * RK, y: (p.lat - RC.lat) * 111320 }; }
function rSpan(ring) {
  const xy = ring.map(rXY);
  return { w: Math.max(...xy.map(p => p.x)) - Math.min(...xy.map(p => p.x)), h: Math.max(...xy.map(p => p.y)) - Math.min(...xy.map(p => p.y)) };
}
function rArea(ring) {
  const xy = ring.map(rXY);
  let a = 0;
  for (let i = 0; i < xy.length; i++) { const p = xy[i], q = xy[(i + 1) % xy.length]; a += p.x * q.y - q.x * p.y; }
  return Math.abs(a / 2);
}
const LONG_GREEN = Array.from({ length: 48 }, (_, i) => { const a = i / 48 * 2 * Math.PI; return rLL(Math.cos(a) * 15, Math.sin(a) * 6); });

test("bigger and smaller move a green's whole edge the same distance - a long green stays long", () => {
  const big = rSpan(shapes.reshapeOutline([LONG_GREEN], { growM: 2 }));
  const small = rSpan(shapes.reshapeOutline([LONG_GREEN], { growM: -2 }));
  assert.ok(Math.abs(big.w - 34) < 0.8 && Math.abs(big.h - 16) < 0.8, "2m bigger all round: " + JSON.stringify(big));
  assert.ok(Math.abs(small.w - 26) < 0.8 && Math.abs(small.h - 8) < 0.8, "2m smaller all round: " + JSON.stringify(small));
  assert.strictEqual(shapes.reshapeOutline([LONG_GREEN], { growM: -7 }), null, "shrunk past nothing is nothing");
});

test("smoothing a fairway bridges a tree's cut-in and leaves the rest of the edge where it was", () => {
  const notched = [rLL(-50, -15), rLL(50, -15), rLL(50, 15), rLL(3, 15), rLL(3, 5), rLL(-3, 5), rLL(-3, 15), rLL(-50, 15)];
  const smoothed = shapes.reshapeOutline([notched], { closeM: 5 });
  assert.ok(rArea(smoothed) > 2970, "the 6m cut-in fills: " + rArea(smoothed).toFixed(0));
  const span = rSpan(smoothed);
  assert.ok(Math.abs(span.w - 100) < 1 && Math.abs(span.h - 30) < 1, "no wider or longer than it was: " + JSON.stringify(span));
});

test("a collar rings the green and necks out to its fairway", () => {
  const ring = shapes.reshapeOutline([LONG_GREEN], { growM: 2 });
  const collar = shapes.collarOutline(LONG_GREEN, ring, rLL(60, 0), { neckM: 8 });
  const xy = collar.map(rXY);
  assert.ok(Math.max(...xy.map(p => p.x)) >= 60, "the neck reaches the fairway");
  assert.ok(Math.min(...xy.map(p => p.x)) <= -16.5, "the collar runs right round the green");
  assert.ok(shapes.insideLatLngRing(RC, collar), "the green sits inside its collar");
  const lonely = shapes.collarOutline(LONG_GREEN, ring, null, {});
  assert.ok(Math.abs(rSpan(lonely).w - 34) < 1, "with no fairway it is just the ring");
});

let failed = 0;
tests.forEach(t => {
  try { t.fn(); console.log("  ok  " + t.name); }
  catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.message)); }
});
console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " map overlay shape checks");
process.exit(failed ? 1 : 0);
