#!/usr/bin/env node
"use strict";

/* Cross-platform Bubble parity fixtures — the JavaScript half.
 *
 * WHY THIS FILE EXISTS
 *
 * app/js/bubble-engine.js is GENERATED: dev/generate-bubble-engine-client.js
 * copies ~55 functions byte-for-byte out of scripts/gd-app-core.js, and
 * dev/fresh-app-boot.test.js fails the build if any copy has drifted. That is
 * this codebase's answer to "the same maths on two surfaces", and it works
 * because both surfaces are JavaScript.
 *
 * The Watch Bubble Engine will be Swift. No generator produces Swift from
 * JavaScript, so at that boundary the verbatim-copy protection simply stops
 * existing — two engines, hand-kept in step, with nothing checking. This
 * codebase has already been there once: WatchMap.swift's header says the
 * projection is pinned on the JavaScript side by
 * dev/watch-map-projection.test.js, and that file has never existed.
 *
 * So the fixtures come FIRST, before the Swift engine, and they are one file
 * read by both sides:
 *
 *   dev/fixtures/bubble-engine-parity.json   the inputs and the expectations
 *   dev/bubble-engine-parity.test.js         this file — runs them through
 *                                            app/js/bubble-engine.js
 *   ios/WatchBubbleEngine/Tests/…            reads the SAME file, by path,
 *                                            never a copy
 *
 * A copied fixture is a second source of truth and defeats the whole point.
 *
 * REGENERATING. `node dev/bubble-engine-parity.test.js --update` rewrites the
 * expectations from the current engine. That is a deliberate act, like re-running
 * the client generator: it means "the engine's answer changed on purpose", the
 * diff is the review, and bubbleEngineVersion in the fixture should be bumped
 * with it. Running the test normally never writes.
 *
 * WHAT IS PINNED. Only the subset that is meant to cross to the wrist — club
 * selection, pattern derivation, orientation and the resulting geometry.
 * Deliberately absent: wind (needs live conditions the wrist has no source
 * for), micro-geometry (built but ships off), and the display pixel clamp
 * (that is framing, and framing is the Framing Engine's). No projection is
 * installed on the engine here, which is exactly the un-clamped path.
 *
 * NOT the bag roof. gdClampBubbleCenterToBagRoof, gdBubbleRoofMaxDistanceM,
 * gdBubbleForwardDistanceFromStart and gdBubbleDepthForRoof are defined in
 * gd-app-core.js, copied into the client by the generator, and called by
 * NOTHING — the clamp was taken out of the render path deliberately and
 * dev/fresh-app-boot.test.js pins its absence ("bag reach must not shift the
 * completed Driver bubble centre"). The 'beyond-bag-reach' case below records
 * what the engine really does with an out-of-range target, so that a Watch
 * engine which "helpfully" ported the dead clamp fails here rather than
 * quietly disagreeing with the phone on every long aim.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const FIXTURE = path.join(__dirname, "fixtures", "bubble-engine-parity.json");
const UPDATE = process.argv.includes("--update");

/* ---------------------------------------------------------------- the engine */

/* Same sandbox dev/fresh-app-boot.test.js boots the client engine in: a window,
   the real distance library, and the two Leaflet constructors the verbatim
   copies reference by name. localStorage answers null throughout, so the bag
   firmness preset is the shipped default and a fixture cannot depend on a
   machine's stored settings. */
function bootEngine() {
  const distanceLib = require(path.join(ROOT, "app", "js", "distance.js"));
  const sandbox = {
    console,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: { body: { classList: { contains: () => false } } },
    L: {
      latLng: (lat, lng) => ({ lat, lng }),
      point: (x, y) => ({ x, y, distanceTo(o) { return Math.hypot(o.x - x, o.y - y); } })
    }
  };
  sandbox.window = sandbox;
  sandbox.window.ClarityApp = { distance: distanceLib };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "app", "js", "bubble-engine.js"), "utf8"),
    sandbox, { filename: "bubble-engine.js" });
  return { engine: sandbox.window.GDBubbleEngine, distance: distanceLib };
}

const { engine, distance } = bootEngine();

/* ---------------------------------------------------------------- running a case */

function round(value, places) {
  const factor = Math.pow(10, places);
  return Math.round(Number(value) * factor) / factor;
}
function coordinate(point) {
  return { lat: round(point.lat, 7), lng: round(point.lng, 7) };
}

/* Compass bearing, player -> target, for the fixture to pin the orientation the
   Bubble is laid down against. Cosine-corrected, matching the frame the Watch
   puts its own fix into (ShotView.swift's WristDistances). */
function bearingDeg(from, to) {
  const north = (to.lat - from.lat) * 111320;
  const east = (to.lng - from.lng) * 111320 * Math.cos(((from.lat + to.lat) / 2) * Math.PI / 180);
  return round((Math.atan2(east, north) * 180 / Math.PI + 360) % 360, 2);
}

/* Eight points around the ring rather than all 168. The ring is a closed
   ellipse sampled at a fixed resolution, so eight evenly-spaced points pin its
   size, its tilt AND its handedness — while a 168-point expectation would make
   every fixture unreadable and every diff unreviewable. The index step is
   derived, not hard-coded, so a change to the engine's ring resolution shows up
   as a changed sample rather than a silent re-alignment. */
const RING_SAMPLES = 8;
function sampleRing(ring) {
  const step = ring.length / RING_SAMPLES;
  const out = [];
  for (let i = 0; i < RING_SAMPLES; i += 1) out.push(coordinate(ring[Math.round(i * step) % ring.length]));
  return out;
}

function run(input) {
  /* Order matters and mirrors the play surface: the hole, then who is playing,
     then where they are standing and what they are aiming at. */
  engine.setBag(input.bag || []);
  engine.setBubble(input.bubble || null);
  engine.clearWind();
  engine.setMicroGeometry(null);
  engine.setHoleContext({
    hole: input.hole.number,
    tee: input.hole.tee,
    green: input.hole.green,
    route: input.hole.route || []
  });

  const player = input.player;
  /* The default target rule, asked before a target is placed — this is what
     §8 of the spec has the wrist recompute on hole change and Reset. */
  engine.setShot(player, null);
  const defaultTarget = engine.targetForGreenCentre(input.hole.green, { hole: input.hole.number });

  const target = input.target || defaultTarget;
  engine.setShot(player, target);
  const model = engine.renderModel();
  assert.ok(model, "the engine must answer for a placed shot");

  const payload = model.payload;
  return {
    /* The bag the phone would actually put on the wire — the engine's own
       playable bag, which for a player with no account bag is the 13-club
       ghost stand-in rather than the empty list the input shows. Recorded
       because the WRIST never derives a ghost bag: it is sent one, and the
       Swift side must start from the same clubs or it is testing a different
       question. */
    bagSent: engine.playableBag().map(function (row) {
      return { club: row.club, carryM: row.baseCarry, totalM: row.totalM };
    }),
    defaultTarget: coordinate(defaultTarget),
    targetDistanceM: round(model.distanceM, 3),
    shotBearingDeg: bearingDeg(player, target),
    club: payload.club,
    carryM: round(payload.baseCarry, 2),
    totalM: round(payload.totalM, 2),
    aimOffsetDeg: round(payload.aimOffsetDeg, 3),
    aimOffsetM: round(payload.aimOffsetM, 3),
    clusterWidthM: round(payload.clusterWidthM, 2),
    clusterDepthM: round(payload.clusterDepthM, 2),
    clusterTiltDeg: round(payload.clusterTiltDeg, 3),
    visualWidthM: round(payload.visual.visualWidthM, 2),
    visualDepthM: round(payload.visual.visualDepthM, 2),
    visualTiltDeg: round(payload.visual.visualTiltDeg, 3),
    ghostBag: !!payload.ghostBag,
    bubbleCentre: coordinate(model.center),
    ringSampleCount: RING_SAMPLES,
    ringResolution: model.rings.main.length,
    ringSample: sampleRing(model.rings.main)
  };
}

/* ---------------------------------------------------------------- comparing */

/* Per-field, because "within 0.1" means different things to a metre, a degree
   and a latitude. A single global epsilon would be either too loose to catch a
   real disagreement in degrees or too tight to survive one in metres. */
function toleranceFor(key, tolerances) {
  if (key === "bubbleCentre" || key === "defaultTarget" || key === "ringSample") return tolerances.coordinate;
  if (key.endsWith("Deg")) return tolerances.degrees;
  if (key === "targetDistanceM") return tolerances.distanceM;
  if (key.endsWith("M") || key.endsWith("MetresM")) return tolerances.metres;
  return 0;
}

function compare(actual, expected, tolerances, name, failures) {
  Object.keys(expected).forEach(key => {
    const want = expected[key], got = actual[key];
    const tolerance = toleranceFor(key, tolerances);
    if (key === "bagSent") {
      const got = actual[key] || [];
      if (got.length !== want.length) {
        failures.push(`${name}: ${key} expected ${want.length} clubs, got ${got.length}`);
        return;
      }
      want.forEach((club, i) => {
        if (got[i].club !== club.club || got[i].carryM !== club.carryM || got[i].totalM !== club.totalM) {
          failures.push(`${name}: ${key}[${i}] expected ${JSON.stringify(club)}, got ${JSON.stringify(got[i])}`);
        }
      });
      return;
    }
    if (typeof want === "number") {
      if (!(Math.abs(got - want) <= tolerance)) {
        failures.push(`${name}: ${key} expected ${want} ± ${tolerance}, got ${got}`);
      }
    } else if (typeof want === "string" || typeof want === "boolean") {
      if (got !== want) failures.push(`${name}: ${key} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    } else if (Array.isArray(want)) {
      if (!Array.isArray(got) || got.length !== want.length) {
        failures.push(`${name}: ${key} expected ${want.length} entries, got ${got && got.length}`);
        return;
      }
      want.forEach((point, i) => {
        if (Math.abs(got[i].lat - point.lat) > tolerance || Math.abs(got[i].lng - point.lng) > tolerance) {
          failures.push(`${name}: ${key}[${i}] expected ${JSON.stringify(point)} ± ${tolerance}, got ${JSON.stringify(got[i])}`);
        }
      });
    } else if (want && typeof want === "object") {
      if (Math.abs(got.lat - want.lat) > tolerance || Math.abs(got.lng - want.lng) > tolerance) {
        failures.push(`${name}: ${key} expected ${JSON.stringify(want)} ± ${tolerance}, got ${JSON.stringify(got)}`);
      }
    }
  });
}

/* ---------------------------------------------------------------- the wire payload

   The EXACT bytes app/js/watch-player-delivery.js puts on the radio, recorded
   so the Swift side decodes what the phone actually sends rather than what its
   own types happen to describe.

   This exists because that gap shipped. The Swift snapshot types carried a
   `version` on the nested bag and bubble; the JavaScript never sent one; the
   Watch rejected every snapshot with "watch player snapshot rejected" and the
   phone re-sent forever. Both sides had passing tests — because the Swift test
   built its JSON by hand, to match its own structs. A hand-written payload
   tests the reader against the reader. */
function wirePayload() {
  const delivery = require(path.join(ROOT, "app", "js", "watch-player-delivery.js"));
  const engineVersion = require(path.join(ROOT, "app", "js", "caddy-watch.js")).BUBBLE_ENGINE_VERSION;
  return {
    accountBag: delivery.__test.snapshotFrom(
      [{ club: "Driver", baseCarry: 205, totalM: 228 }, { club: "7i", baseCarry: 138, totalM: 148 }],
      { offsetDeg: 3.2 }, "right", engineVersion),
    noMyBubble: delivery.__test.snapshotFrom(
      [{ club: "Driver", baseCarry: 205, totalM: 228 }], null, "left", engineVersion),
    ghostBag: delivery.__test.snapshotFrom(
      [{ club: "Driver", baseCarry: 230, totalM: 255, ghostBag: true }], { offsetDeg: 0 }, "right", engineVersion)
  };
}

/* ---------------------------------------------------------------- go */

const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const failures = [];

fixture.cases.forEach(entry => {
  const actual = run(entry.input);
  if (UPDATE) { entry.expect = actual; return; }
  assert.ok(entry.expect, entry.name + " has no expectation — run with --update to record one");
  compare(actual, entry.expect, fixture.tolerances, entry.name, failures);
});

if (UPDATE) {
  fixture.playerWire = wirePayload();
  fs.writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + "\n");
  console.log("bubble-engine parity: recorded " + fixture.cases.length + " cases from the current engine");
  console.log("  Review the diff. This is the file the Swift engine is held to.");
  process.exit(0);
}

/* Guards on the fixture itself. A parity file that stops covering the corners,
   or quietly loses its version, protects nothing while still passing. */
assert.ok(fixture.bubbleEngineVersion, "the fixture must name the engine version it describes");
/* The recorded wire payload must still be what the module produces. If this
   fails the shape on the radio has changed and the Swift decoder needs to
   change with it — which is the whole point of recording it. */
assert.deepStrictEqual(fixture.playerWire, wirePayload(),
  "the recorded wire payload no longer matches what watch-player-delivery.js sends");
assert.ok(fixture.cases.length >= 8, "expected at least 8 parity cases, found " + fixture.cases.length);
["ghost-bag", "no-my-bubble", "left-handed", "beyond-bag-reach"].forEach(required => {
  assert.ok(fixture.cases.some(entry => entry.name === required),
    "the corners are the point: no '" + required + "' case in the fixture");
});

if (failures.length) {
  console.log("— Bubble engine parity (JavaScript) —");
  failures.forEach(line => console.log("  FAIL  " + line));
  console.log("\n" + failures.length + " parity mismatch(es).");
  console.log("If the engine changed on purpose: node dev/bubble-engine-parity.test.js --update, review the diff, bump bubbleEngineVersion.");
  process.exit(1);
}

console.log("bubble-engine parity passed: " + fixture.cases.length + " cases against "
  + fixture.bubbleEngineVersion + " (JavaScript side)");
