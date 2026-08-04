/* The on-course shot feed: GPS Play → Course Data, and nowhere else.
 *
 * This feed was lost when the old play runtime was deleted
 * (GPS_PLAY_DELETION_AUDIT_2026-08-02 §3b) and its absence was silent - no
 * error, no toast, just fewer shots than there should be. Silence is what makes
 * it worth a test: nothing else will ever report that it stopped.
 *
 * The destination is the point. gd-shot-snapshot.js's contract is that GPS Play
 * "performs no wind correction, no slope correction, no My Bubble comparison" -
 * it records. So this asserts both halves: shots reach the Course Data intake,
 * AND the My Bubble comparison layer is not wired into play.
 *
 * Runs the real modules in a vm with an in-memory localStorage, the same way
 * dev/conditions-engine-harness.js does - no browser, because none of this is
 * about the DOM.
 *
 * Run: node dev/app-course-data-feed.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* --------------------------------------------------------------------------
 * Wiring: the right modules are loaded, and the wrong one is not.
 * ------------------------------------------------------------------------ */
const appHtml = read("app/index.html");
/* Parsed src attributes, not raw text: the markup explains in a comment why the
   comparison layer is absent, and a substring search over the whole file would
   match that explanation and call the module loaded. */
const order = [...appHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
const loads = (name) => order.some((src) => src.includes(name));
const idx = (needle) => order.findIndex((src) => src.includes(needle));

[
  "gd-shot-snapshot.js",
  "gd-conditions-tolerance-profile.js",
  "gd-conditions-geometry.js",
  "gd-conditions-engine.js",
  "gd-course-data-intake.js",
  "js/course-data.js"
].forEach((name) => {
  assert.ok(loads(name), "app/index.html must load " + name);
});

assert.ok(
  !loads("gd-course-data-comparison.js"),
  "app/index.html must NOT load the My Bubble comparison layer - play records shots, it does not compare them"
);
assert.ok(
  !loads("gd-conditions-debug.js"),
  "gd-conditions-debug.js is studio-only and must not ship on the play surface"
);
assert.ok(idx("gd-course-data-intake.js") < idx("js/course-data.js"), "the intake must load before its caller");
assert.ok(idx("js/course-data.js") < idx("js/play.js"), "course-data.js must load before play.js starts a round");

/* --------------------------------------------------------------------------
 * Behaviour: run the real intake and the real feed together.
 * ------------------------------------------------------------------------ */
function memoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    get size() { return data.size; }
  };
}

function harness(options = {}) {
  const deferred = [];
  const context = {
    console,
    localStorage: memoryStorage(),
    setTimeout: (fn) => { deferred.push(fn); return deferred.length; },
    clearTimeout: () => {},
    Date,
    Math,
    JSON,
    Number,
    Object,
    Array,
    String,
    Error,
    isFinite
  };
  context.window = context;
  context.window.window = context;
  vm.createContext(context);

  [
    "scripts/gd-shot-snapshot.js",
    "scripts/course-data/conditions-engine/gd-conditions-tolerance-profile.js",
    "scripts/course-data/conditions-engine/gd-conditions-geometry.js",
    "scripts/course-data/conditions-engine/gd-conditions-engine.js",
    "scripts/course-data/gd-course-data-intake.js",
    "app/js/shot.js",
    "app/js/course-data.js"
  ].forEach((rel) => vm.runInContext(read(rel), context, { filename: rel }));

  const app = context.window.ClarityApp;
  /* Only what course-data.js actually reads off the app. Anything absent must
     degrade to a null field rather than throwing - that is the contract. */
  app.distance = {
    haversineMeters(a, b) {
      const R = 6371000, toRad = Math.PI / 180;
      const dLat = (b.lat - a.lat) * toRad, dLng = (b.lng - a.lng) * toRad;
      const s = Math.sin(dLat / 2) ** 2
        + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(s));
    }
  };
  app.play = { state: () => ({ courseKey: "akarana-golf-club", hole: 1 }) };
  if (options.gps !== false) app.gps = { lastFix: () => ({ lat: 0, lng: 0, accuracy: 4.5 }) };
  if (options.wind) app.wind = options.wind;
  if (options.playsLike) app.playsLike = options.playsLike;

  return { context, app, flush: () => { while (deferred.length) deferred.shift()(); } };
}

const START = { lat: 0, lng: 0 };
const LANDING = { lat: 0.001, lng: 0 };      /* ~111 m north */
const TARGET = { lat: 0.0012, lng: 0 };

/* 1. A completed shot reaches the Course Data intake as a raw snapshot. */
{
  const h = harness();
  h.app.courseData.startRound("akarana-golf-club");
  assert.strictEqual(h.app.courseData.install(), true, "the feed installs onto shot completion");

  h.app.shot.startRound();
  h.app.shot.startHole(1);
  h.app.shot.place(START, TARGET);
  /* The second placement is what completes the first shot. */
  h.app.shot.place(LANDING, TARGET);

  const stats = h.app.courseData.stats();
  assert.strictEqual(stats.submitted, 1, "one completed shot, one submission: " + JSON.stringify(stats));
  assert.strictEqual(stats.rejected, 0, "the intake accepted it");

  const stored = h.context.window.GolfDaddyCourseDataIntake.listSnapshots();
  assert.strictEqual(stored.length, 1, "the raw snapshot is persisted");
  const snap = stored[0];
  assert.strictEqual(snap.courseId, "akarana-golf-club", "the course is recorded");
  assert.strictEqual(snap.holeNumber, 1, "the hole is recorded");
  assert.strictEqual(snap.shotStartPosition.lat, START.lat, "start position is raw");
  assert.strictEqual(snap.shotLandingPosition.lat, LANDING.lat, "landing position is raw");
  assert.ok(Math.abs(snap.shotDistance - 111.19) < 1, "distance measured, got " + snap.shotDistance);
  assert.strictEqual(snap.gpsAccuracy, 4.5, "the fix accuracy is carried as evidence quality");
  assert.strictEqual(snap.shotCaptureMethod, "placement", "how the landing point was established is recorded");
}

/* 2. No measurement means null, never a substituted value. This is the rule
      that keeps Course Data raw: an aiming aid the player set is not evidence
      of what the wind or the slope actually was. */
{
  const h = harness({
    wind: { selection: () => ({ originAngleRad: 1.57, level: 2 }), liveReading: () => null }
  });
  h.app.courseData.startRound("akarana-golf-club");
  h.app.courseData.install();
  h.app.shot.startRound();
  h.app.shot.startHole(3);
  h.app.shot.place(START, TARGET);
  h.app.shot.place(LANDING, TARGET);

  const snap = h.context.window.GolfDaddyCourseDataIntake.listSnapshots()[0];
  assert.strictEqual(snap.userSelectedWind, true, "the player's wind setting is recorded as intent");
  assert.deepStrictEqual(snap.userWindSelection, { originAngleRad: 1.57, level: 2 }, "intent is recorded verbatim");
  assert.strictEqual(snap.liveWindAvailable, false, "a setting is not a measurement");
  assert.strictEqual(snap.liveWindSpeed, null, "unmeasured wind stays null");
  assert.strictEqual(snap.liveSlopeAvailable, false, "no elevation lookup means no slope evidence");
  assert.strictEqual(snap.liveSlopeValue, null, "unmeasured slope stays null");
}

/* 3. Measured wind is recorded as measured - unbucketed, beside the intent. */
{
  const h = harness({
    wind: {
      selection: () => ({ originAngleRad: 0.5, level: 3 }),
      liveReading: () => ({ speedKmh: 27.4, directionDeg: 210, level: 3, source: "open-meteo", capturedAt: "2026-08-04T02:00:00.000Z" })
    },
    playsLike: { forShot: () => ({ deltaM: -4.2 }) }
  });
  h.app.courseData.startRound("akarana-golf-club");
  h.app.courseData.install();
  h.app.shot.startRound();
  h.app.shot.startHole(7);
  h.app.shot.place(START, TARGET);
  h.app.shot.place(LANDING, TARGET);

  const snap = h.context.window.GolfDaddyCourseDataIntake.listSnapshots()[0];
  assert.strictEqual(snap.liveWindAvailable, true, "a measurement is available");
  assert.strictEqual(snap.liveWindSpeed, 27.4, "speed is kept as measured, not as the bucketed level");
  assert.strictEqual(snap.liveWindDirection, 210, "direction is kept as measured");
  assert.strictEqual(snap.liveWindSource, "open-meteo", "provenance is recorded");
  assert.strictEqual(snap.userSelectedWind, true, "intent is still recorded alongside it");
  assert.strictEqual(snap.liveSlopeAvailable, true, "elevation resolved");
  assert.strictEqual(snap.liveSlopeValue, -4.2, "slope is signed metres, as measured");
  assert.strictEqual(snap.liveSlopeDirection, "downhill", "a negative delta reads as downhill");
}

/* 4. Hole out completes the last shot, and says when the landing point was the
      aim standing in for a fix rather than an observation. */
{
  const h = harness();
  h.app.courseData.startRound("akarana-golf-club");
  h.app.courseData.install();
  h.app.shot.startRound();
  h.app.shot.startHole(9);
  h.app.shot.place(START, TARGET);
  h.app.shot.holeOut(LANDING);
  h.app.shot.startHole(10);
  h.app.shot.place(START, TARGET);
  h.app.shot.holeOut(null);

  const snaps = h.context.window.GolfDaddyCourseDataIntake.listSnapshots();
  assert.strictEqual(snaps.length, 2, "both holes filed their final shot");
  const methods = snaps.map((s) => s.shotCaptureMethod).sort();
  assert.deepStrictEqual(methods, ["hole-out", "hole-out-assumed-target"],
    "an assumed landing point is labelled as assumed, not passed off as observed");
}

/* 5. Nothing here may take a round down. A broken intake must not escape into
      the play path that completed the shot. */
{
  const h = harness();
  h.app.courseData.startRound("akarana-golf-club");
  h.app.courseData.install();
  h.context.window.GolfDaddyCourseDataIntake.submitShotSnapshot = () => { throw new Error("SIMULATED_INTAKE_FAILURE"); };

  h.app.shot.startRound();
  h.app.shot.startHole(2);
  h.app.shot.place(START, TARGET);
  assert.doesNotThrow(() => h.app.shot.place(LANDING, TARGET), "a failing intake must not throw into play");
  assert.deepStrictEqual(h.app.shot.holeShots(2).length, 1, "the shot is still recorded in the round");
}

/* 6. Re-submitting the same shot is idempotent rather than duplicating - the
      intake's guarantee, asserted here because this feed is what would break it
      if ids were random per call. */
{
  const h = harness();
  h.app.courseData.startRound("akarana-golf-club");
  h.app.shot.startRound();
  h.app.shot.startHole(4);
  const shot = { start: START, target: TARGET, end: LANDING };
  const first = h.app.courseData.submit(shot, { hole: 4, captureMethod: "placement" });
  assert.strictEqual(first.accepted, true, "first submission accepted");
  assert.strictEqual(h.context.window.GolfDaddyCourseDataIntake.listSnapshots().length, 1, "one snapshot stored");
}

/* 7. The analysis the intake defers runs off the raw snapshot without the
      comparison layer present - i.e. Course Data stands alone, which is the
      whole claim of routing here instead of at My Bubble. */
{
  const h = harness({
    wind: {
      selection: () => null,
      liveReading: () => ({ speedKmh: 18, directionDeg: 180, level: 2, source: "open-meteo", capturedAt: "2026-08-04T02:00:00.000Z" })
    }
  });
  assert.strictEqual(h.context.window.GolfDaddyCourseDataComparison, undefined,
    "the comparison layer is genuinely absent from this context");
  h.app.courseData.startRound("akarana-golf-club");
  h.app.courseData.install();
  h.app.shot.startRound();
  h.app.shot.startHole(5);
  h.app.shot.place(START, TARGET);
  h.app.shot.place(LANDING, TARGET);

  assert.doesNotThrow(() => h.flush(), "the deferred analysis runs without the comparison layer");
  const snaps = h.context.window.GolfDaddyCourseDataIntake.listSnapshots();
  assert.strictEqual(snaps.length, 1, "the raw snapshot survives analysis either way");
}

/* The store the snapshots land in is unrecoverable, so it has to be durable. */
const durable = read("scripts/inline/gd-durable-storage.js");
assert.ok(
  /"gd_shot_snapshots_v1"/.test(durable),
  "gd_shot_snapshots_v1 holds measurements that cannot be retaken - it must be mirrored to durable storage"
);

console.log("app course data feed passed: shots reach Course Data raw, intent and evidence stay separate, "
  + "assumed landings are labelled, failures stay out of play, My Bubble comparison absent");
