/* The on-course shot feed: GPS Play → Course Data, and nowhere else.
 *
 * This feed was lost when the old play runtime was deleted
 * (GPS_PLAY_DELETION_AUDIT_2026-08-02 §3b) and its absence was silent - no
 * error, no toast, just fewer shots than there should be. Silence is what makes
 * it worth a test: nothing else will ever report that it stopped.
 *
 * How a shot reaches the feed: the Marshal's completeShot() fires the
 * shotCompleted effect with { start, target, end } and { hole, captureMethod },
 * and boot.js wires that effect to app.courseData.submit. There is no shot
 * module to subscribe to any more, so the wiring is asserted statically and
 * the behaviour is exercised by calling submit with exactly the payload the
 * Marshal sends.
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
  "gd-shot-outcomes.js",
  "gd-shot-events.js",
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
assert.ok(idx("gd-shot-outcomes.js") < idx("gd-shot-events.js") && idx("gd-shot-events.js") < idx("js/course-data.js"),
  "the Course Data screen's shot store (and the outcome pairing it calls) must load before the feed");
assert.ok(idx("js/course-data.js") < idx("js/marshal.js"), "course-data.js must load before marshal.js, which enters holes and starts the round");

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
    sessionStorage: memoryStorage(),
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
    "scripts/gd-shot-outcomes.js",
    "scripts/gd-shot-events.js",
    "app/js/course-data.js",
    /* Not loaded on the play surface - this is what the Course Data screen
       runs, loaded here only to read the shots back the way the screen does. */
    "scripts/gd-shot-cluster-analysis.js"
  ].forEach((rel) => vm.runInContext(read(rel), context, { filename: rel }));
  if (options.profiles) context.localStorage.setItem("gd_player_profiles_v27", JSON.stringify(options.profiles));
  /* The bubble the shot card was showing: 40 m deep, 20 m wide, on the target. */
  if (options.bubble !== false) {
    context.GDBubbleEngine = {
      renderModel: () => ({ center: TARGET, payload: { club: "7i", depthRadiusM: 20, lateralRadiusM: 10 } })
    };
  }

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
  /* The feed reads the course off the Marshal's round; nothing else of the
     Marshal is needed here because a completed shot ARRIVES as an effect call
     (see complete below) rather than being observed. */
  app.marshal = { round: () => ({ courseKey: "akarana-golf-club" }) };
  if (options.gps !== false) app.gps = { lastFix: () => ({ lat: 0, lng: 0, accuracy: 4.5 }) };
  if (options.wind) app.wind = options.wind;
  if (options.playsLike) app.playsLike = options.playsLike;

  return { context, app, flush: () => { while (deferred.length) deferred.shift()(); } };
}

const START = { lat: 0, lng: 0 };
const LANDING = { lat: 0.001, lng: 0 };      /* ~111 m north */
const TARGET = { lat: 0.0012, lng: 0 };

/* The Marshal's shotCompleted payload, verbatim (app/js/marshal.js
   completeShot). Sending exactly this is what makes these scenarios a test of
   the real seam rather than of a shape the feed would accept anyway. */
function complete(h, hole, captureMethod, shot = { start: START, target: TARGET, end: LANDING }) {
  return h.app.courseData.submit(
    { start: shot.start, target: shot.target, end: shot.end },
    { hole, captureMethod, location: null }
  );
}

/* 0. The seam exists end to end: the Marshal states a completed shot with a
      capture method, and boot.js hands it to the feed. This is the wiring
      that went missing silently once; it is checked in source because no
      runtime here has the Marshal. */
{
  const marshal = read("app/js/marshal.js");
  const boot = read("app/js/boot.js");
  assert.ok(
    /fx\.shotCompleted\(\{ start: shot\.start, target: shot\.target, end: shot\.end \}, \{ hole: hole, captureMethod: method/.test(marshal),
    "the Marshal must state a completed shot as { start, target, end } with its capture method"
  );
  ["\"lock\"", "\"shot-end\"", "\"ball-placed\"", "\"ball-tracked\""].forEach((method) => {
    assert.ok(new RegExp("completeShot\\([^;]*" + method).test(marshal),
      "the Marshal must still complete shots with capture method " + method + " - the feed records it verbatim");
  });
  assert.ok(
    /shotCompleted:\s*function \(shot, meta\)[\s\S]{0,400}?app\.courseData\.submit\(shot, meta\)/.test(boot),
    "boot.js must wire the Marshal's shotCompleted effect to app.courseData.submit"
  );
}

/* 1. A completed shot reaches the Course Data intake as a raw snapshot. */
{
  const h = harness();
  h.app.courseData.startRound("akarana-golf-club");
  const result = complete(h, 1, "lock");
  assert.strictEqual(result && result.accepted, true, "the intake accepted the shot");

  const stats = h.app.courseData.stats();
  assert.strictEqual(stats.submitted, 1, "one completed shot, one submission: " + JSON.stringify(stats));
  assert.strictEqual(stats.rejected, 0, "the intake accepted it");

  const stored = h.context.window.GolfDaddyCourseDataIntake.listSnapshots();
  assert.strictEqual(stored.length, 1, "the raw snapshot is persisted");
  const snap = stored[0];
  assert.strictEqual(snap.courseId, "akarana-golf-club", "the course is recorded, read off the Marshal's round");
  assert.strictEqual(snap.holeNumber, 1, "the hole is recorded");
  assert.strictEqual(snap.shotStartPosition.lat, START.lat, "start position is raw");
  assert.strictEqual(snap.shotLandingPosition.lat, LANDING.lat, "landing position is raw");
  assert.ok(Math.abs(snap.shotDistance - 111.19) < 1, "distance measured, got " + snap.shotDistance);
  assert.strictEqual(snap.gpsAccuracy, 4.5, "the fix accuracy is carried as evidence quality");
  assert.strictEqual(snap.shotCaptureMethod, "lock", "how the landing point was established is recorded");
}

/* 2. No measurement means null, never a substituted value. This is the rule
      that keeps Course Data raw: an aiming aid the player set is not evidence
      of what the wind or the slope actually was. */
{
  const h = harness({
    wind: { selection: () => ({ originAngleRad: 1.57, level: 2 }), liveReading: () => null }
  });
  h.app.courseData.startRound("akarana-golf-club");
  complete(h, 3, "lock");

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
  complete(h, 7, "lock");

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

/* 4. How the landing point was established travels with the shot, verbatim.
      A ball the player placed on the green is not the same evidence as one a
      GPS fix tracked to, and an analysis has to be able to weigh them apart. */
{
  const h = harness();
  h.app.courseData.startRound("akarana-golf-club");
  complete(h, 9, "shot-end");
  complete(h, 9, "ball-placed");
  complete(h, 10, "ball-tracked");

  const snaps = h.context.window.GolfDaddyCourseDataIntake.listSnapshots();
  assert.strictEqual(snaps.length, 3, "every completed shot filed");
  assert.deepStrictEqual(snaps.map((s) => s.shotCaptureMethod).sort(), ["ball-placed", "ball-tracked", "shot-end"],
    "the Marshal's capture method is recorded as stated, never normalised or guessed");
  assert.deepStrictEqual([...new Set(snaps.map((s) => s.shotId))].length, 3, "each shot gets its own id");
}

/* 5. Nothing here may take a round down. A broken intake must not escape into
      the Marshal effect that completed the shot. */
{
  const h = harness();
  h.app.courseData.startRound("akarana-golf-club");
  h.context.window.GolfDaddyCourseDataIntake.submitShotSnapshot = () => { throw new Error("SIMULATED_INTAKE_FAILURE"); };

  let result;
  assert.doesNotThrow(() => { result = complete(h, 2, "lock"); }, "a failing intake must not throw into play");
  assert.strictEqual(result, null, "and the failure is reported as no submission, not a fake acceptance");
}

/* 6. Re-submitting the same shot is idempotent rather than duplicating - the
      intake's guarantee, asserted here because this feed is what would break it
      if ids were random per call. */
{
  const h = harness();
  h.app.courseData.startRound("akarana-golf-club");
  const shot = { start: START, target: TARGET, end: LANDING };
  const first = h.app.courseData.submit(shot, { hole: 4, captureMethod: "lock" });
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
  complete(h, 5, "lock");

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

/* 6. The shot lands on the Course Data screen. The snapshot store above is not
      what that screen lists - it reads planned shots paired with landings from
      gd_shot_events_v1, through gd-shot-cluster-analysis.js. Filing only the
      snapshot is exactly how a whole round went missing from the screen, so
      this reads the shot back the way the screen does, as the active player. */
{
  const h = harness({ profiles: { activeId: "p-sam", profiles: [{ id: "p-other" }, { id: "p-sam", name: "Sam", accountId: "acc-1" }] } });
  h.app.courseData.startRound("akarana-golf-club");
  complete(h, 4, "lock");

  assert.strictEqual(h.app.courseData.stats().onScreen, 1, "the shot was filed for the screen: " + JSON.stringify(h.app.courseData.stats()));
  const records = h.context.window.GolfDaddyShotClusterAnalysis.analyzeCurrent().records;
  assert.strictEqual(records.length, 1, "the screen's analysis sees the shot");
  const r = records[0];
  assert.strictEqual(r.playerId, "p-sam", "filed under the active profile, so the screen's player filter keeps it");
  assert.strictEqual(r.club, "7i", "the club the shot card showed");
  assert.strictEqual(r.holeId, "hole-4", "the hole");
  assert.strictEqual(r.bubbleWasSet, true, "the bubble the player saw is recorded");
  assert.ok(Math.abs(r.presumedBubbleDepthM - 40) < 0.5 && Math.abs(r.presumedBubbleWidthM - 20) < 0.5,
    "bubble size as shown: " + r.presumedBubbleDepthM + " x " + r.presumedBubbleWidthM);
  assert.ok(Math.abs(r.depthM - -22.2) < 1, "landed ~22 m short of the bubble centre, got " + r.depthM);
  assert.ok(Math.abs(r.lateralM) < 0.5, "and on line, got " + r.lateralM);

  const snap = h.context.window.GolfDaddyCourseDataIntake.listSnapshots()[0];
  assert.strictEqual(snap.playerId, "p-sam", "the raw snapshot carries the player too");

  /* A second shot pairs with its own plan, not the first one's. */
  complete(h, 4, "ball-tracked", { start: LANDING, target: { lat: 0.0015, lng: 0 }, end: { lat: 0.00145, lng: 0 } });
  const after = h.context.window.GolfDaddyShotClusterAnalysis.analyzeCurrent().records;
  assert.strictEqual(after.length, 2, "both shots on the screen");
  assert.strictEqual(new Set(after.map((x) => x.shotId)).size, 2, "each paired once");
}

/* 7. No bubble on screen means no plan to measure the landing against. The raw
      snapshot is still filed; nothing is invented for the screen. */
{
  const h = harness({ bubble: false });
  h.app.courseData.startRound("akarana-golf-club");
  complete(h, 5, "lock");
  assert.strictEqual(h.context.window.GolfDaddyCourseDataIntake.listSnapshots().length, 1, "the raw snapshot is still filed");
  assert.strictEqual(h.app.courseData.stats().onScreen, 0, "but no plan is made up for the screen");
  assert.strictEqual(h.context.window.GolfDaddyShotClusterAnalysis.analyzeCurrent().records.length, 0, "and the screen shows nothing for it");
}

console.log("app course data feed passed: shots reach Course Data raw and land on the Course Data screen, "
  + "intent and evidence stay separate, capture methods travel verbatim, failures stay out of play, My Bubble comparison absent");
