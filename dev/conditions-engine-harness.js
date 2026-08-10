/*
  Shared vm harness for the Conditions Engine tests.

  Loads the Course Data modules into a throwaway context with an in-memory
  localStorage, so engine maths and intake persistence can be exercised without
  a browser. Fixtures use deliberately simple geometry: the shot origin sits at
  lat/lng 0,0 where one degree of latitude and one degree of longitude are both
  111320 m, so every expected vector is inspectable by hand.
*/

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const EARTH_LAT_M = 111320;

const MODULES = [
  "scripts/gd-shot-snapshot.js",
  "scripts/course-data/conditions-engine/gd-conditions-tolerance-profile.js",
  "scripts/course-data/conditions-engine/gd-conditions-geometry.js",
  "scripts/course-data/conditions-engine/gd-conditions-engine.js",
  "scripts/course-data/gd-course-data-intake.js",
  "scripts/course-data/gd-course-data-comparison.js",
  "scripts/course-data/gd-course-transfer-score.js",
  "scripts/course-data/gd-course-implementation-insight.js",
  "scripts/course-data/gd-conditions-debug.js"
];

function memoryStorage() {
  const data = new Map();
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    clear() { data.clear(); },
    get size() { return data.size; }
  };
}

function load(options) {
  options = options || {};
  const pendingTimers = [];
  const storage = memoryStorage();

  const context = {
    console,
    localStorage: storage,
    // Deferred work is captured rather than executed so a test can assert that
    // submission returns before analysis has run.
    setTimeout(fn) { pendingTimers.push(fn); return pendingTimers.length; },
    clearTimeout() {}
  };
  context.window = context;
  context.window.window = context.window;
  context.window.localStorage = storage;
  if (options.gdCourseDataCanManage) {
    context.window.gdCourseDataCanManage = options.gdCourseDataCanManage;
  }

  vm.createContext(context);
  MODULES.forEach((relative) => {
    const code = fs.readFileSync(path.join(ROOT, relative), "utf8");
    vm.runInContext(code, context, { filename: path.basename(relative) });
  });

  return {
    context,
    storage,
    modules: context.window.GolfDaddy.modules,
    engine: context.window.GolfDaddyConditionsEngine,
    geometry: context.window.GolfDaddyConditionsGeometry,
    tolerances: context.window.GolfDaddyConditionsToleranceProfile,
    intake: context.window.GolfDaddyCourseDataIntake,
    comparison: context.window.GolfDaddyCourseDataComparison,
    transferScore: context.window.GolfDaddyCourseTransferScore,
    insight: context.window.GolfDaddyCourseImplementationInsight,
    debug: context.window.GolfDaddyConditionsDebug,
    snapshotBuilder: context.window.GolfDaddyShotSnapshot,
    pendingTimers,
    flushTimers() {
      const queued = pendingTimers.splice(0, pendingTimers.length);
      queued.forEach((fn) => fn());
      return queued.length;
    }
  };
}

// --- Fixture geometry -------------------------------------------------------
// Origin at 0,0. North is +lat, east is +lng. A 150 m shot due north puts the
// bubble centre at lat 150/111320.

const ORIGIN = { lat: 0, lng: 0 };
const SHOT_DISTANCE_M = 150;

function north(metres) { return metres / EARTH_LAT_M; }
function east(metres) { return metres / EARTH_LAT_M; } // cos(0 deg) === 1

const BUBBLE_CENTRE = { lat: north(SHOT_DISTANCE_M), lng: 0 };

/* Bubble 20 m wide, 30 m deep, aimed due north. Half-width 10 m, half-depth 15 m. */
function bubble(overrides) {
  return Object.assign({
    versionId: "mb_fixture",
    club: "7i",
    centerLat: BUBBLE_CENTRE.lat,
    centerLng: BUBBLE_CENTRE.lng,
    orientationDeg: 0,
    widthM: 20,
    depthM: 30,
    carryM: SHOT_DISTANCE_M,
    totalM: SHOT_DISTANCE_M + 8,
    offsetDeg: 0,
    source: "fixture"
  }, overrides || {});
}

/*
  A landing position expressed as an offset from the bubble centre in metres.
  lateralM is positive to the east (right of the due-north aim line);
  forwardM is positive to the north (long).
*/
function landingOffset(lateralM, forwardM) {
  return {
    lat: BUBBLE_CENTRE.lat + north(forwardM || 0),
    lng: BUBBLE_CENTRE.lng + east(lateralM || 0)
  };
}

const CAPTURED_AT = "2026-07-20T10:00:00.000Z";

function snapshot(overrides) {
  return Object.assign({
    shotId: "shot-fixture-1",
    roundId: "round-fixture",
    playerId: "player-fixture",
    courseId: "course-fixture",
    holeNumber: 7,
    capturedAt: CAPTURED_AT,

    clubId: "7i",
    shotStartPosition: ORIGIN,
    shotLandingPosition: landingOffset(0, 0),
    targetPosition: BUBBLE_CENTRE,
    intendedDirection: 0,
    shotDistance: SHOT_DISTANCE_M,

    myBubbleVersionId: "mb_fixture",
    myBubbleGeometry: bubble(),
    bagVersionId: "bag-fixture",

    liveWindAvailable: false,
    liveWindSpeed: null,
    liveWindDirection: null,
    liveWindScaleLevel: null,
    liveWindSource: null,
    liveWindCapturedAt: null,
    liveWindConfidence: null,

    userSelectedWind: false,
    userWindSelection: null,
    userWindIntent: null,

    liveSlopeAvailable: false,
    liveSlopeValue: null,
    liveSlopeDirection: null,
    liveSlopeSource: null,
    liveSlopeCapturedAt: null,
    liveSlopeConfidence: null,

    userSelectedSlope: false,
    userSlopeSelection: null,
    userSlopeIntent: null,

    gpsAccuracy: 4,
    landingConfidence: "high",
    targetConfidence: "high",
    shotCaptureMethod: "next_shot_button",

    snapshotVersion: 1
  }, overrides || {});
}

/*
  Wind magnitude before directional factors:
    base  = clamp(150 * 0.045, 4, 12) = 6.75
    level 3 -> 6.75 * 3 = 20.25 m

  Profile 1.1.0 then applies the directional factors:
    pure crosswind (90 deg off line, gate open) -> 20.25 * 0.65 = 13.1625 m
    pure headwind  (0 deg off line)             -> 20.25 * 1.00 = 20.25 m
    pure tailwind  (180 deg off line)           -> 20.25 * 0.55 = 11.1375 m
*/
const WIND_BASE_M = 6.75;
const WIND_FACTORS = { head: 1, tail: 0.55, cross: 0.65, gateDegrees: 45 };

/* Wind FROM the east at level 3, across a due-north shot. The ball drifts west;
   neutralising moves the analytical position back east by 13.1625 m. */
function liveWind(overrides) {
  return Object.assign({
    liveWindAvailable: true,
    liveWindSpeed: 30,
    liveWindDirection: 90,
    liveWindScaleLevel: 3,
    liveWindSource: "Open-Meteo",
    liveWindCapturedAt: CAPTURED_AT,
    liveWindConfidence: "high"
  }, overrides || {});
}

/* Wind FROM straight ahead: a pure headwind on a due-north shot. Used where a
   correction needs to be large enough to trip the distance cap, which only a
   headwind can reach once the crosswind factor is applied. */
function headWind(overrides) {
  return Object.assign(liveWind(), { liveWindDirection: 0 }, overrides || {});
}

/* Wind FROM directly behind. */
function tailWind(overrides) {
  return Object.assign(liveWind(), { liveWindDirection: 180 }, overrides || {});
}

const EXPECTED_WIND_EFFECT_M = WIND_BASE_M * 3 * WIND_FACTORS.cross;   // 13.1625

/* Uphill elevation delta. A shot into 8 m of rise plays 8 m longer, so the
   neutral-condition position sits 8 m further north than where it finished. */
function liveSlope(overrides) {
  return Object.assign({
    liveSlopeAvailable: true,
    liveSlopeValue: 8,
    liveSlopeDirection: "uphill",
    liveSlopeSource: "open-meteo",
    liveSlopeCapturedAt: CAPTURED_AT,
    liveSlopeConfidence: "medium"
  }, overrides || {});
}

function analyse(harness, snap, bubbleOverride) {
  return harness.engine.analyse({
    shotSnapshot: snap,
    activeMyBubble: bubbleOverride || snap.myBubbleGeometry || bubble(),
    engineVersion: harness.engine.ENGINE_VERSION
  });
}

function variantOf(result, type) {
  return (result.candidateVariants || []).filter((v) => v.variantType === type)[0] || null;
}

module.exports = {
  EARTH_LAT_M,
  ORIGIN,
  SHOT_DISTANCE_M,
  BUBBLE_CENTRE,
  CAPTURED_AT,
  EXPECTED_WIND_EFFECT_M,
  WIND_BASE_M,
  WIND_FACTORS,
  load,
  north,
  east,
  bubble,
  landingOffset,
  snapshot,
  liveWind,
  headWind,
  tailWind,
  liveSlope,
  analyse,
  variantOf
};
