#!/usr/bin/env node
"use strict";

/* Studio's Garmin Preview draws a hole with a port of the watch's own Monkey C
   (scripts/studio/gps-play/garmin-preview/garmin-watch-render.js). A port drifts
   quietly, so the pieces that can be checked without a screen are pinned here:
   the projection against the generator's maths, the palette against the
   constants the watch carries, the camera's clamping rule, the wind and layup
   rules, and one whole frame drawn through a recording canvas so the draw order
   and the interaction path (finger -> image point -> coordinate -> engine) are
   exercised end to end. */
const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const R = require(path.join(ROOT, "scripts/studio/gps-play/garmin-preview/garmin-watch-render.js"));
const core = require(path.join(ROOT, "scripts/gd-watch-map-core.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* A real hole's frame from a small synthetic geometry: a 380 m par 4 at Millbrook's latitude. */
function sampleFrame() {
  const tee = { lat: -45.0310, lng: 168.7210 };
  const green = { lat: -45.0276, lng: 168.7222 };
  const box = (c, dLat, dLng) => [
    { lat: c.lat - dLat, lng: c.lng - dLng }, { lat: c.lat - dLat, lng: c.lng + dLng },
    { lat: c.lat + dLat, lng: c.lng + dLng }, { lat: c.lat + dLat, lng: c.lng - dLng }
  ];
  const mid = { lat: (tee.lat + green.lat) / 2, lng: (tee.lng + green.lng) / 2 };
  const geometry = {
    tee, green, route: [tee, mid, green],
    greenShape: box(green, 0.00012, 0.00018),
    fairways: [box(mid, 0.0012, 0.00025)],
    bunkers: [box({ lat: green.lat - 0.0002, lng: green.lng - 0.0003 }, 0.00005, 0.00006)],
    water: [], trees: [box({ lat: mid.lat, lng: mid.lng + 0.0007 }, 0.0004, 0.0002)], hazards: [], waste: []
  };
  const frame = core.buildWatchHoleFrame(core.WATCH_MAP_RECIPE_V1, geometry);
  assert.ok(frame.ok, "the sample frame must build");
  return { frame, geometry };
}

test("the device table is complete and leads with the AMOLED watches", () => {
  assert.ok(R.DEVICES.length >= 10);
  R.DEVICES.forEach((d) => {
    ["id", "name", "width", "height", "shape", "amoled", "touch", "patternFill", "scaledBitmap"].forEach((k) => assert.ok(k in d, d.id + " lacks " + k));
    assert.ok(d.width >= 200 && d.height >= 200);
    assert.ok(["round", "rectangle"].includes(d.shape));
  });
  assert.strictEqual(R.DEVICES[0].amoled, true);
  const ids = R.DEVICES.map((d) => d.id);
  assert.strictEqual(new Set(ids).size, ids.length, "device ids are unique");
  const s62 = R.DEVICES.find((d) => d.id === "approachs62");
  assert.strictEqual(s62.scaledBitmap, false, "the S62 draws a picture 1:1 (CIQ 3.0)");
  assert.strictEqual(s62.patternFill, false);
});

test("the spatial reference port agrees with the generator and round-trips", () => {
  const { frame, geometry } = sampleFrame();
  const sr = new R.SpatialReference(frame.spatialReference);
  assert.ok(sr.isUsable());
  [geometry.tee, geometry.green, geometry.route[1]].forEach((p) => {
    const mine = sr.imagePoint(p.lat, p.lng);
    const theirs = core.projectLatLngToImage(frame.spatialReference, p.lat, p.lng);
    assert.ok(Math.abs(mine.x - theirs.x) < 1e-6 && Math.abs(mine.y - theirs.y) < 1e-6, "imagePoint matches the generator");
    const back = sr.coordinate(mine.x, mine.y);
    assert.ok(Math.abs(back.lat - p.lat) < 1e-9 && Math.abs(back.lng - p.lng) < 1e-9, "coordinate() inverts imagePoint()");
  });
  const teeImg = sr.imagePoint(geometry.tee.lat, geometry.tee.lng);
  const greenImg = sr.imagePoint(geometry.green.lat, geometry.green.lng);
  assert.ok(greenImg.y < teeImg.y, "the bake runs tee at the bottom, green at the top");
  assert.ok(!new R.SpatialReference({ version: 2, refZoom: 20, imageWidth: 10, imageHeight: 10, transform: { a: 1, b: 0, tx: 0, ty: 0 } }).isUsable(), "a newer recipe is unusable, not approximately usable");
});

test("the package palette becomes the watch's base palette by the phone's own rule", () => {
  /* GarminSessionManager.BASE_PALETTE was worked out from WATCH_MAP_RECIPE_V1.colors with
     watch-map-delivery.js cleanPalette (x0.8 / x1.22); the port carries the same constants. */
  assert.deepStrictEqual(R.cleanPalette(core.WATCH_MAP_RECIPE_V1.colors), R.BASE_PALETTE);
  assert.strictEqual(R.mapPalette(false, { r: 0x123456 }), R.MIP_PALETTE, "a MIP screen ignores the package palette");
  const tinted = R.mapPalette(true, { r: 0x123456, nonsense: 1 });
  assert.strictEqual(tinted.r, 0x123456);
  assert.strictEqual(tinted.f, R.BASE_PALETTE.f);
  assert.ok(!("nonsense" in tinted));
  assert.strictEqual(R.cleanPalette(null), null);
});

test("the camera never shows background past an edge and centres the focus when it can", () => {
  /* axisOrigin: a scaled image shorter than the view is centred; a longer one keeps the view
     covered - no further right/down than 0, no further left/up than view - image. */
  assert.strictEqual(R.Camera.axisOrigin(200, 454, 100), 127);
  assert.strictEqual(R.Camera.axisOrigin(1000, 454, 500), 454 / 2 - 500);
  assert.strictEqual(R.Camera.axisOrigin(1000, 454, 10), 0, "a focus near the top pins the top edge");
  assert.strictEqual(R.Camera.axisOrigin(1000, 454, 990), 454 - 1000, "a focus near the bottom pins the bottom edge");

  const { frame } = sampleFrame();
  const sr = new R.SpatialReference(frame.spatialReference);
  const W = sr.imageWidth, H = sr.imageHeight;
  const player = { x: W / 2, y: H - 40 }, green = { x: W / 2, y: 60 };
  const play = R.Camera.play(player, green, W, H, 454, 454);
  assert.ok(play.scale <= 3.0 && play.scale >= 454 / W - 1e-9, "play framing fills the width and never passes 3x");
  assert.strictEqual(play.rotation, 0);
  const py = play.place(player.x, player.y, W, H, 454, 454)[1];
  assert.ok(py > 227 && py <= 454, "the player sits low on the screen, on the glass");
  const back = play.imagePointFromView(100, 300, W, H, 454, 454);
  const again = play.place(back.x, back.y, W, H, 454, 454);
  assert.ok(Math.abs(again[0] - 100) < 1e-9 && Math.abs(again[1] - 300) < 1e-9, "imagePointFromView inverts place() unturned");
});

test("the shot framing fits the Bubble with the target in the middle and the shot straight up", () => {
  const { frame } = sampleFrame();
  const sr = new R.SpatialReference(frame.spatialReference);
  const W = sr.imageWidth, H = sr.imageHeight;
  /* A second shot from the left rough, aiming up and to the right: on the bake the line is
     diagonal; on the glass it must be vertical. The Bubble reaches 60 px either side of the
     target on the bake. */
  const player = { x: 60, y: 900 }, target = { x: 260, y: 500 };
  const cam = R.Camera.shot(player, target, 120, W, H, 454, 454);
  const t = cam.place(target.x, target.y, W, H, 454, 454), p = cam.place(player.x, player.y, W, H, 454, 454);
  assert.ok(Math.abs(t[0] - 227) < 1e-9 && Math.abs(t[1] - 227) < 1e-9, "target at the centre: " + t);
  assert.ok(Math.abs(p[0] - 227) < 1e-6 && p[1] > 227, "the player is straight below the target: " + p);
  assert.ok(Math.abs(cam.scale - (0.6 * 454) / 120) < 1e-9, "the Bubble takes 60% of the glass: " + cam.scale);
  const reach = cam.place(target.x + 60, target.y, W, H, 454, 454);
  assert.ok(Math.abs(Math.hypot(reach[0] - 227, reach[1] - 227) - 0.3 * 454) < 1e-6, "the ring's edge lands 30% of the glass from the middle, turned or not");
  assert.ok(p[1] > 454, "a drive's player is off the bottom of the glass: " + p[1]);
  assert.strictEqual(cam.clampsToImage, false);
  /* Round trip through the turned affine, and a screen-up nudge goes up the shot on the bake. */
  const back = cam.imagePointFromView(300, 100, W, H, 454, 454);
  const again = cam.place(back.x, back.y, W, H, 454, 454);
  assert.ok(Math.abs(again[0] - 300) < 1e-9 && Math.abs(again[1] - 100) < 1e-9, "imagePointFromView inverts place() turned");
  const up = cam.imageDirection(0, -10);
  const along = { x: target.x - player.x, y: target.y - player.y }, len = Math.hypot(along.x, along.y);
  assert.ok(Math.abs(up[0] - along.x / len * 10) < 1e-9 && Math.abs(up[1] - along.y / len * 10) < 1e-9, "screen up is along the shot: " + up);
  /* A tiny Bubble caps at 3x, where a chip's player is on the glass. */
  const chip = R.Camera.shot({ x: 200, y: 520 }, { x: 200, y: 500 }, 10, W, H, 454, 454);
  assert.strictEqual(chip.scale, 3.0);
  assert.ok(chip.place(200, 520, W, H, 454, 454)[1] < 454 && chip.place(200, 520, W, H, 454, 454)[1] > 227, "a chip's player is on the glass, below the target");
  assert.strictEqual(R.Camera.shot(player, target, null, W, H, 454, 454).scale, 3.0, "no extent at all: the ceiling");
  assert.strictEqual(R.Camera.shot(target, target, 120, W, H, 454, 454).rotation, 0.0, "a player on the target has no direction to turn to");
  /* The same point in both halves of the affine. */
  const f = cam.frame(W, H, 454, 454);
  assert.ok(Math.abs(Math.hypot(f[2], f[3]) - cam.scale) < 1e-9, "the affine carries the scale");
  /* The Bubble's reach: twice the farthest ring point from the target, so a ring sat off to one
     side is still whole; a Driver's worth of ground when there is no ring yet. */
  const geoTarget = sr.coordinate(target.x, target.y);
  const ring = Array.from({ length: 24 }, (_, i) => R.Geo.project(R.Geo.project(geoTarget, Math.PI / 2, 5), (i / 24) * Math.PI * 2, 20));
  const farthest = Math.max.apply(null, ring.map((g) => { const q = sr.imagePoint(g.lat, g.lng); return Math.hypot(q.x - target.x, q.y - target.y); }));
  assert.ok(Math.abs(R.Camera.bubbleExtent(ring, target, sr) - 2 * farthest) < 1e-9, "twice the farthest ring point");
  assert.ok(Math.abs(R.Camera.bubbleExtent(null, target, sr) - 55 / (sr.metresPerPixel != null ? sr.metresPerPixel : 0.5)) < 1e-9, "55 m with no ring");
});

test("the chord of a round face narrows towards the top and a rectangle does not", () => {
  const top = R.Layout.chromeTopY(454);
  assert.strictEqual(top, 31);
  const half = R.Layout.chordHalfWidthPx("round", top, top + 22, 454, 454);
  assert.ok(Math.abs(half - 227 * Math.sqrt(1 - Math.pow(196 / 227, 2))) < 1e-9 && half < 227, "the chrome row is inset from the bezel on a round face");
  assert.strictEqual(R.Layout.chordHalfWidthPx("rectangle", 0, 22, 320, 360), 160);
  assert.strictEqual(R.Layout.chordHalfWidthPx("round", -5, 0, 454, 454), 0, "nothing fits above the glass");
});

test("wind: a headwind plays longer, calm has no ghost, levels follow wind.js thresholds", () => {
  const player = { lat: -45.0310, lng: 168.7210 }, target = { lat: -45.0296, lng: 168.7210 };
  assert.strictEqual(R.windEffect(null, player, target, 150), null);
  assert.strictEqual(R.windEffect({ fromDeg: 0, kmh: 3 }, player, target, 150).level, 0);
  const head = R.windEffect({ fromDeg: 0, kmh: 20 }, player, target, 150);   // blowing from the north, shot due north
  assert.strictEqual(head.level, 2);
  assert.ok(head.alongM > 6 && Math.abs(head.alongM - 150 * 0.045 * 2) < 1e-6, "into the wind is + metres");
  assert.ok(head.ghost.lat < target.lat, "the ghost is carried back towards the player");
  const tail = R.windEffect({ fromDeg: 180, kmh: 30 }, player, target, 150);
  assert.strictEqual(tail.level, 3);
  assert.ok(tail.alongM < 0 && tail.ghost.lat > target.lat);
  assert.strictEqual(R.playsLikeM(150, null, head, false), null, "nothing to add: no plays number");
  assert.ok(Math.abs(R.playsLikeM(150, 4, head, true) - (150 + 4 + head.alongM)) < 1e-9);
  assert.strictEqual(R.formatDistance(150.4, false), "150m");
  assert.strictEqual(R.formatDistance(150, true), "164y");
});

test("the default target is the green in reach, else a layup down the route at the bag's edge", () => {
  const tee = { lat: -45.0310, lng: 168.7210 }, green = { lat: -45.0276, lng: 168.7222 };
  const route = [tee, { lat: -45.0293, lng: 168.7216 }, green];
  assert.strictEqual(R.defaultTarget(tee, green, route, null), null, "no bag, no answer");
  const near = { lat: -45.0285, lng: 168.7219 };
  assert.strictEqual(R.defaultTarget(near, green, route, 230), green, "in reach: the green itself");
  const layup = R.defaultTarget(tee, green, route, 230);
  assert.ok(layup, "a layup is found");
  const d = R.Geo.distance(tee, layup);
  assert.ok(d <= 233 && d >= 230 * 0.58, "the layup sits at the bag's edge, never past it: " + d);
  assert.ok(R.Geo.distance(tee, green) > 233, "and the green really was out of reach");
  const clamped = R.clampedToBag(green, tee, 100);
  assert.ok(Math.abs(R.Geo.distance(tee, clamped) - 100) < 0.01, "a drag past the bag lands at its edge");
});

test("a report hole decodes into boxed rings, packed trees and a skeleton the face can read", () => {
  const { frame, geometry } = sampleFrame();
  const hole = { holeNumber: 7, spatialReference: frame.spatialReference, reference: frame.reference, outlines: frame.outlines, trees: frame.trees, terrain: null, palette: core.WATCH_MAP_RECIPE_V1.colors };
  const shapes = R.decodeShapes(hole);
  assert.ok(shapes.f.length === 1 && shapes.b.length === 1 && shapes.g, "fairway, bunker and green rings");
  assert.strictEqual(shapes.t.length, 0);
  shapes.f.concat(shapes.b, [shapes.g]).forEach((ring) => {
    assert.ok(ring.p.length >= 6 && ring.box.length === 4 && ring.box[0] <= ring.box[2] && ring.box[1] <= ring.box[3]);
  });
  assert.ok(shapes.c.length > 0, "the tree area placed trees");
  const sk = R.skeletonHole(hole);
  assert.strictEqual(sk.n, 7);
  assert.ok(sk.t && sk.s.length >= 3 && sk.s.length <= 16);
  const distances = R.skeletonDistances(sk, geometry.tee);
  assert.ok(distances.front <= distances.centre && distances.centre <= distances.back);
  assert.ok(Math.abs(distances.centre - R.Geo.distance(geometry.tee, geometry.green)) < 1e-6);
  const line = R.skeletonLine(sk);
  assert.strictEqual(line[0], sk.t);
  assert.strictEqual(line[line.length - 1], sk.g);
});

/* A canvas context that only records. Enough for Dc; what matters is that the frame draws
   without throwing and in the watch's order. */
function recordingContext() {
  const calls = [];
  const ctx = { font: "", textAlign: "", textBaseline: "", fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "", imageSmoothingEnabled: true, imageSmoothingQuality: "" };
  ["fillRect", "beginPath", "moveTo", "lineTo", "closePath", "fill", "stroke", "arc", "arcTo", "fillText", "drawImage"].forEach((name) => {
    ctx[name] = function () { calls.push({ name, args: Array.prototype.slice.call(arguments), fill: ctx.fillStyle, stroke: ctx.strokeStyle }); };
  });
  ctx.measureText = (text) => ({ width: String(text).length * 9 });
  ctx.createPattern = () => "pattern";
  return { ctx, calls };
}

test("a whole frame draws, in the watch's order, and a drag moves the target through the engine", () => {
  const { frame, geometry } = sampleFrame();
  const hole = { holeNumber: 7, spatialReference: frame.spatialReference, reference: frame.reference, outlines: frame.outlines, trees: frame.trees, terrain: null, palette: core.WATCH_MAP_RECIPE_V1.colors };
  const record = { holeNumber: 7, spatialReference: new R.SpatialReference(frame.spatialReference), greenLat: geometry.green.lat, greenLng: geometry.green.lng, shapes: R.decodeShapes(hole), skeleton: R.skeletonHole(hole), path: "", palette: R.cleanPalette(hole.palette) };
  const player = geometry.tee;
  const moves = [];
  /* A stand-in engine: a ring of eight points 20 m round the target. */
  const bubbleFor = (target) => ({
    target, targetDistanceM: R.Geo.distance(player, target), club: { club: "7i", carryM: 155, totalM: 165 }, centre: target,
    ring: Array.from({ length: 168 }, (_, i) => R.Geo.project(target, (i / 168) * Math.PI * 2, 20))
  });
  const session = {
    scene: { hasRound: () => true, shotLocked: () => false, suggestedClub: () => null, courseKey: () => "sample" },
    currentHole: () => 7,
    manifestHole: (n) => (n === 7 ? record : null),
    packageVersion: () => 1,
    bitmapFor: () => null,
    outlinesFor: () => record.shapes,
    mapPalette: () => R.mapPalette(true, record.palette),
    playerPoint: () => player,
    localBubble: () => session.playState.bubble || bubbleFor(session.aimTarget()),
    aimTarget: () => R.defaultTarget(player, geometry.green, R.skeletonLine(record.skeleton), 230),
    greenDistances: () => R.skeletonDistances(record.skeleton, player),
    holeLine: () => R.skeletonLine(record.skeleton),
    bagMaxTotalM: () => 230,
    windEffect: (p, t, flat) => R.windEffect({ fromDeg: 0, kmh: 20 }, p, t, flat),
    playsLikeM: (p, t, flat, effect) => R.playsLikeM(flat, 3, effect, true),
    playsBubble: (local, playsM) => ({ bubble: bubbleFor(R.Geo.project(player, R.Geo.trueBearing(player, local.target), playsM)), shiftLat: 0, shiftLng: 0 }),
    playState: { target: null, bubble: null, moveTarget(c) { moves.push(c); this.target = c; this.bubble = bubbleFor(c); return this.bubble; }, clear() { this.target = null; this.bubble = null; } },
    canCompute: () => true,
    sendAim: (t) => { session.sent = t; },
    yards: () => false
  };
  const device = R.DEVICES[0];
  const face = new R.MapFace(session, device, () => null);
  const { ctx, calls } = recordingContext();
  face.onUpdate(ctx);
  assert.ok(face.trace && /^map frame: hole 7 /.test(face.trace), face.trace);
  assert.ok(face.camera && face.camera.scale > 0);
  /* The shot framing: the Bubble fitted to the glass, the target in the middle, the player
     straight below it. */
  const sr = record.spatialReference;
  const local = session.localBubble(), targetImg = sr.imagePoint(local.target.lat, local.target.lng);
  const targetOn = face.camera.place(targetImg.x, targetImg.y, sr.imageWidth, sr.imageHeight, device.width, device.height);
  assert.ok(Math.abs(targetOn[0] - 227) < 1e-6 && Math.abs(targetOn[1] - 227) < 1e-6, "target in the middle: " + targetOn);
  const playerOn = face.camera.place(sr.imagePoint(player.lat, player.lng).x, sr.imagePoint(player.lat, player.lng).y, sr.imageWidth, sr.imageHeight, device.width, device.height);
  assert.ok(Math.abs(playerOn[0] - 227) < 1e-6 && playerOn[1] > 227, "player straight below the target: " + playerOn);
  const farthestPx = R.Camera.bubbleExtent(local.ring, targetImg, sr) / 2;
  const reachOn = Math.max.apply(null, local.ring.map((g) => { const q = sr.imagePoint(g.lat, g.lng), on = face.camera.place(q.x, q.y, sr.imageWidth, sr.imageHeight, device.width, device.height); return Math.hypot(on[0] - 227, on[1] - 227); }));
  assert.ok(Math.abs(reachOn - Math.min(0.3 * 454, 3 * farthestPx)) < 1e-6, "the ring fills 60% of the glass, or the 3x ceiling: " + reachOn);
  const fills = calls.filter((c) => c.name === "fillRect");
  assert.strictEqual(fills[0].fill, "#000000", "cleared black first, as onUpdate does");
  assert.strictEqual(fills[1].fill, "#315833", "then the rough, for a drawn map");
  const texts = calls.filter((c) => c.name === "fillText").map((c) => c.args[0]);
  assert.ok(texts.includes("H7"), "hole number in the chrome: " + texts.join(","));
  assert.ok(texts.some((t) => /^\d+m$/.test(t)), "distance to the green in the chrome");
  assert.ok(texts.includes("7I"), "the club label, upper case");
  assert.ok(texts.some((t) => /^plays \d+m$/.test(t)), "the plays button, since slope and applied wind add to the number");
  assert.ok(face.playsBox, "the plays button has a hit box");

  /* A finger on the glass: the target follows it through image point -> coordinate -> engine. */
  face.dragStart(227, 150);
  assert.strictEqual(face.aiming, true);
  assert.ok(moves.length >= 2, "the seed move, then the finger's");
  const last = moves[moves.length - 1];
  const img = record.spatialReference.imagePoint(last.lat, last.lng);
  const on = face.camera.place(img.x, img.y, record.spatialReference.imageWidth, record.spatialReference.imageHeight, device.width, device.height);
  assert.ok(Math.abs(on[0] - 227) < 0.5 && Math.abs(on[1] - 150) < 0.5, "the target is under the finger: " + on);
  face.dragEnd();
  assert.strictEqual(face.aiming, false);
  assert.strictEqual(session.sent, last, "AIM_AT once, on release, with the final target");

  /* The plays button toggles on a tap inside its box and the frame still draws. */
  assert.ok(face.hitPlays(face.playsBox[0] + 1, face.playsBox[1] + 1));
  face.togglePlays();
  face.onUpdate(ctx);
  assert.strictEqual(face.playsMode, true);

  /* A MIP watch without pattern fills falls back to the solid colours, and one with them
     asks for a texture. */
  const s62 = new R.MapFace(session, R.DEVICES.find((d) => d.id === "approachs62"), () => null);
  s62.onUpdate(recordingContext().ctx);
  const f7 = new R.MapFace(session, R.DEVICES.find((d) => d.id === "fenix7"), () => null);
  f7.onUpdate(recordingContext().ctx);
  /* Trees: the sprite loader is asked once per [set][type][size], with the AMOLED set here. */
  const asked = [];
  const sprites = new R.MapFace(session, device, (amoled, type, size) => { asked.push([amoled, type, size]); return null; });
  sprites.onUpdate(recordingContext().ctx);
  assert.ok(asked.length > 0 && asked.every((a) => a[0] === true && a[1] >= 0 && a[1] < 4 && a[2] >= 0 && a[2] < 5));
});

let failed = 0;
tests.forEach(({ name, fn }) => {
  try { fn(); console.log("ok   - " + name); }
  catch (error) { failed += 1; console.log("FAIL - " + name + "\n       " + (error && error.stack || error)); }
});
if (failed) { console.log(failed + " failing"); process.exit(1); }
console.log(tests.length + " passing");
