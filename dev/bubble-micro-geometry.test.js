"use strict";

/* Bubble Signals + Micro-Geometry.
 *
 * Three things are pinned here, and the first is the one that matters most:
 *
 *   1. WITH SIGNALS DISABLED, NOTHING CHANGES. The shipped config disables the
 *      engine, and the rendered ring must come back byte-identical to the ring
 *      the same engine drew before this layer existed. That is the V1 success
 *      condition and it is checked against the real generated client, not
 *      against the core's own idea of identity.
 *
 *   2. The detector detects. Each pre-loaded scenario plants a relationship
 *      and the Signal it was planted for has to fire, on the evidence route it
 *      was planted through, without dragging any other Signal along with it.
 *
 *   3. The Control scenario is genuinely inert. Bubble-valid data, no planted
 *      relationship, and Base and Adjusted have to be the same bubble.
 *
 * Run: node dev/bubble-micro-geometry.test.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const core = require(path.join(ROOT, "scripts", "gd-bubble-signals-core.js"));
const generator = require(path.join(ROOT, "scripts", "gd-bubble-signal-test-data.js"));

let passed = 0;
const failures = [];

function ok(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log("  ok   " + label);
    return;
  }
  failures.push(label + (detail ? "\n        " + detail : ""));
  console.log("  FAIL " + label + (detail ? "\n        " + detail : ""));
}

function section(title) {
  console.log("\n" + title);
}

/* ---------------------------------------------------------------------------
   A real instance of the generated client, in node.

   The point of loading app/js/bubble-engine.js rather than re-deriving the
   maths is that the generated file is what actually ships. If the generator
   ever stops carrying the micro-geometry functions, or the adapter stops
   declaring gdMicroGeometryModel, this harness fails to boot - which is the
   correct outcome, and is not something a test of the core alone would notice.
   --------------------------------------------------------------------------- */

function haversineMeters(a, b) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function loadEngine() {
  const source = fs.readFileSync(path.join(ROOT, "app", "js", "bubble-engine.js"), "utf8");
  const sandbox = {
    console,
    /* The engine's Leaflet dependency at render time is exactly two
       constructors. latLng has to return a plain {lat,lng} the rest of the
       engine can read back, because project()'s result is fed straight into
       the next distance and bearing call. */
    L: { point: (x, y) => ({ x, y }), latLng: (lat, lng) => ({ lat, lng }) },
    Number, Math, JSON, Array, Object, String, Boolean, Date, Set, isNaN, isFinite
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.ClarityApp = { distance: { haversineMeters } };
  sandbox.GDBubbleSignalsCore = core;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "app/js/bubble-engine.js" });
  return sandbox;
}

/* A ring, in metres relative to the shot start, so two rings can be compared
   without lat/lng precision noise dominating the difference. */
function ringMetres(engine, model) {
  engine.GDBubbleEngine.setMicroGeometry(model);
  const rendered = engine.GDBubbleEngine.renderModel();
  if (!rendered) return null;
  const centre = rendered.center;
  return rendered.rings.main.map((point) => ({
    east: haversineMeters(centre, { lat: centre.lat, lng: point.lng }) * (point.lng >= centre.lng ? 1 : -1),
    north: haversineMeters(centre, { lat: point.lat, lng: centre.lng }) * (point.lat >= centre.lat ? 1 : -1)
  }));
}

function maxRingDelta(a, b) {
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    worst = Math.max(worst, Math.hypot(a[i].east - b[i].east, a[i].north - b[i].north));
  }
  return worst;
}

function primeEngine(engine) {
  const start = { lat: -36.8485, lng: 174.7633 };
  const target = { lat: -36.8472, lng: 174.7633 };   // ~145m due north
  engine.GDBubbleEngine.setBag(engine.GDBubbleEngine.defaultBagRows());
  engine.GDBubbleEngine.setBubble({ offsetDeg: 1.6, handedness: "right" });
  engine.GDBubbleEngine.setHoleContext({ hole: 1, tee: start, route: [start, target], green: target });
  engine.GDBubbleEngine.setProjection(null);
  engine.GDBubbleEngine.setShot(start, target);
}

/* ---------------------------------------------------------------------------
   1. Disabled changes nothing
   --------------------------------------------------------------------------- */

section("Shipped defaults render the bubble that shipped before this layer");

const engine = loadEngine();
ok("the generated client exposes setMicroGeometry", typeof engine.GDBubbleEngine.setMicroGeometry === "function");
primeEngine(engine);

const baseline = ringMetres(engine, null);
ok("the engine renders a ring with no model at all", Array.isArray(baseline) && baseline.length > 100);

/* The shipped config, run over data that DOES contain a planted relationship.
   Nothing may fire, because the engine is off. */
const planted = generator.scenario("rollout-character");
const shippedConfig = core.defaultConfig();
const shippedDetected = core.detectSignals(planted.rows, shippedConfig);
const shippedGeometry = core.buildMicroGeometry(shippedDetected, shippedConfig);

ok("the shipped config disables the engine", shippedConfig.enabled === false);
ok("every Signal ships disabled", Object.keys(shippedConfig.signals).every((id) => shippedConfig.signals[id].enabled === false));
ok("no Signal fires under the shipped config", shippedDetected.every((r) => !r.fired),
  shippedDetected.filter((r) => r.fired).map((r) => r.id).join(", "));
ok("the shipped config produces identity geometry", core.isIdentityGeometry(shippedGeometry),
  JSON.stringify(shippedGeometry));

const shippedRing = ringMetres(engine, shippedGeometry);
ok("the rendered ring is unchanged under the shipped config", maxRingDelta(baseline, shippedRing) === 0,
  "max delta " + maxRingDelta(baseline, shippedRing).toFixed(9) + "m");

/* Explicit identity, and explicit null, must land in the same place too. */
ok("explicit identity geometry renders the same ring",
  maxRingDelta(baseline, ringMetres(engine, core.identityGeometry())) === 0);
ok("setMicroGeometry(null) renders the same ring",
  maxRingDelta(baseline, ringMetres(engine, null)) === 0);

/* ---------------------------------------------------------------------------
   2. Enabled geometry actually moves the ring, in the right place
   --------------------------------------------------------------------------- */

section("An approved model moulds the ring where the regions say");

const rightBiased = core.identityGeometry();
rightBiased.right = 1.02;
rightBiased.longRight = 1.01;
const moulded = ringMetres(engine, rightBiased);

ok("a right-side model changes the ring", maxRingDelta(baseline, moulded) > 0.05,
  "max delta " + maxRingDelta(baseline, moulded).toFixed(4) + "m");

/* The ring is built as rel = 0..2pi with x along the shot and y to its right,
   and the shot here points due north - so the Right region is the ring's
   easternmost point and Left is its westernmost. If this assertion ever fails,
   the region model and the engine's ring have stopped agreeing about which way
   is which, which is the single most damaging way this layer could break. */
function extreme(ring, key, sign) {
  return ring.reduce((best, point) => (sign * point[key] > sign * best[key] ? point : best), ring[0]);
}
const baseRight = extreme(baseline, "east", 1).east;
const mouldRight = extreme(moulded, "east", 1).east;
const baseLeft = extreme(baseline, "east", -1).east;
const mouldLeft = extreme(moulded, "east", -1).east;

ok("the Right region pushes the ring further right", mouldRight > baseRight + 0.05,
  baseRight.toFixed(3) + "m -> " + mouldRight.toFixed(3) + "m");
ok("the untouched Left region does not move", Math.abs(mouldLeft - baseLeft) < 0.05,
  baseLeft.toFixed(3) + "m -> " + mouldLeft.toFixed(3) + "m");

/* Axis: only Curvature Bias may ask, and only for half a degree. */
const tilted = core.identityGeometry();
tilted.axisAdjustmentDeg = 0.5;
ok("a half-degree axis correction changes the ring", maxRingDelta(baseline, ringMetres(engine, tilted)) > 0.01);

const overTilted = core.identityGeometry();
overTilted.axisAdjustmentDeg = 40;
ok("an out-of-range axis value is clamped, not obeyed",
  maxRingDelta(ringMetres(engine, tilted), ringMetres(engine, overTilted)) === 0);

/* A corrupt cached model must render the plain bubble rather than something. */
ok("a model missing its regions is refused",
  maxRingDelta(baseline, ringMetres(engine, { axisAdjustmentDeg: 0 })) === 0);

/* ---------------------------------------------------------------------------
   3. Interpolation
   --------------------------------------------------------------------------- */

section("Region interpolation");

const sample = core.identityGeometry();
core.REGIONS.forEach((name, index) => { sample[name] = 1 + index * 0.001; });
ok("the curve passes exactly through every control value",
  core.REGIONS.every((name, index) => Math.abs(core.microGeometryFactor(sample, (index * Math.PI) / 4, 1) - sample[name]) < 1e-12));
ok("the curve is continuous across the 2pi wrap",
  Math.abs(core.microGeometryFactor(sample, 2 * Math.PI - 1e-6, 1) - core.microGeometryFactor(sample, 0, 1)) < 1e-5);
ok("a negative angle resolves to the same point as its positive twin",
  Math.abs(core.microGeometryFactor(sample, -Math.PI / 2, 1) - core.microGeometryFactor(sample, (3 * Math.PI) / 2, 1)) < 1e-12);
ok("exaggeration scales the departure from 1, not the value",
  Math.abs(core.microGeometryFactor(sample, Math.PI / 2, 10) - (1 + (sample.right - 1) * 10)) < 1e-12);
ok("identity geometry interpolates to 1 everywhere at any exaggeration",
  [0, 1, 2, 3, 4, 5].every((i) => core.microGeometryFactor(core.identityGeometry(), i, 10) === 1));

/* ---------------------------------------------------------------------------
   4. Detection, through the real pipeline
   --------------------------------------------------------------------------- */

section("Pre-loaded scenarios detect what they planted");

generator.SCENARIOS.forEach((preset) => {
  const result = generator.scenario(preset.id);
  const detection = result.detection;

  ok(preset.id + ": generated data is Bubble-eligible", result.eligibility.eligible,
    result.eligibility.failureCount + " row(s) outside the window");

  if (preset.spec.relationship === "none") {
    ok(preset.id + ": no Signal fires", detection.controlClean === true,
      detection.detected.filter((r) => r.fired).map((r) => r.id + "(" + r.evidenceStrength + ")").join(", "));
    ok(preset.id + ": Base and Adjusted are the same bubble", core.isIdentityGeometry(detection.geometry),
      JSON.stringify(detection.geometry));
    return;
  }

  ok(preset.id + ": the planted Signal fires", detection.targetFired,
    detection.targetRecord
      ? "evidence " + detection.targetRecord.evidenceStrength + ", reason " + (detection.targetRecord.reason || "-")
      : "no record");
  ok(preset.id + ": no other Signal is dragged along", detection.unexpectedSignals.length === 0,
    detection.unexpectedSignals.join(", "));
  ok(preset.id + ": the adjusted geometry is not identity", !core.isIdentityGeometry(detection.geometry));
});

/* The GCQuad case exists to prove the alias layer: no Face-to-Path column at
   all, and Curvature Bias still resolves - through Spin Axis. */
const ballOnly = generator.scenario("curvature-bias-ball-only");
ok("Curvature Bias resolves from Spin Axis when Face-to-Path is absent",
  ballOnly.detection.targetRecord.route === "spin_axis",
  "route was " + ballOnly.detection.targetRecord.route);
ok("the GCQuad export really has no Face-to-Path column",
  ballOnly.rows.every((row) => row.faceToPath === null));

/* Direction Progression is scoped to the longer clubs, exactly as the spec's
   worked example reads. */
const progression = generator.scenario("direction-progression");
ok("Direction Progression applies to the longer clubs only",
  progression.detection.targetRecord.appliesToClubs.length > 0
  && !progression.detection.targetRecord.appliesToClubs.includes("PW"),
  progression.detection.targetRecord.appliesToClubs.join(" "));

/* ---------------------------------------------------------------------------
   5. Confidence: weak evidence needs more of it, not a different model
   --------------------------------------------------------------------------- */

section("Evidence routes are weighted, not blacklisted");

const strongSpec = { relationship: "curvature_bias", provider: "trackman", shots: 14, clubs: 3, strength: "medium", seed: 4242 };
/* Garmin R10 measures spin axis, but radar-derived - so it reaches the same
   observation by a route the confidence table rates far lower. That is the
   comparison section 12 is about: same Signal, same trend, weaker route. */
const weakSpec = Object.assign({}, strongSpec, { provider: "garmin_r10" });
const strong = generator.generateAndVerify(strongSpec);
const weak = generator.generateAndVerify(weakSpec);

ok("a strong source establishes the trend on this sample", strong.detection.targetFired);
ok("the same trend on a weak source does not", !weak.detection.targetFired,
  "evidence " + (weak.detection.targetRecord && weak.detection.targetRecord.evidenceStrength));
ok("the weak source is asked for a bigger sample",
  weak.detection.targetRecord.requiredShots > strong.detection.targetRecord.requiredShots,
  strong.detection.targetRecord.requiredShots + " -> " + weak.detection.targetRecord.requiredShots);
ok("and for a stronger trend",
  weak.detection.targetRecord.effectiveThreshold > strong.detection.targetRecord.effectiveThreshold,
  strong.detection.targetRecord.effectiveThreshold + " -> " + weak.detection.targetRecord.effectiveThreshold);

/* The bug this pins: authority used to multiply into evidence strength, which
   made a low-authority route unfirable at ANY sample size rather than merely
   demanding. Weak evidence is supposed to need more evidence, not be refused. */
const weakButPersistent = generator.generateAndVerify(Object.assign({}, weakSpec, { shots: 80, clubs: 4 }));
ok("a weak source with enough consistent evidence is eventually allowed to speak",
  weakButPersistent.detection.targetFired,
  "evidence " + (weakButPersistent.detection.targetRecord && weakButPersistent.detection.targetRecord.evidenceStrength)
  + " vs threshold " + (weakButPersistent.detection.targetRecord && weakButPersistent.detection.targetRecord.effectiveThreshold));
ok("but it still moves the bubble less than the strong source would",
  weakButPersistent.detection.targetRecord.effectStrength < 1);

/* A monitor that cannot measure the observation at all is a different case
   from a weak one: there is no route, so there is no modifier, at any sample. */
const noRoute = generator.generateAndVerify({ relationship: "curvature_bias", provider: "toptracer", shots: 120, clubs: 5, strength: "high", seed: 4243 });
ok("a source that cannot measure the observation reports no route",
  !noRoute.detection.targetFired && noRoute.detection.targetRecord.reason === "no_curvature_route",
  noRoute.detection.targetRecord.reason);

/* ---------------------------------------------------------------------------
   6. Caps
   --------------------------------------------------------------------------- */

section("Production stays subtle by construction");

const allOn = core.resolveConfig({
  enabled: true,
  signals: Object.keys(core.defaultConfig().signals).reduce((out, id) => {
    /* Ask every Signal for ten times its allowance at once. */
    out[id] = { enabled: true, evidenceThreshold: 0, maxEffectPct: 40, axisAdjustmentDeg: 40 };
    return out;
  }, {})
});
const loud = core.buildMicroGeometry(core.detectSignals(generator.scenario("rollout-character").rows, allOn), allOn);

ok("no region exceeds the configured ceiling",
  core.REGIONS.every((name) => Math.abs(loud[name] - 1) * 100 <= allOn.caps.maxRegionPct + 1e-9),
  JSON.stringify(loud));
ok("the whole shape's total departure is bounded",
  core.REGIONS.reduce((sum, name) => sum + Math.abs(loud[name] - 1) * 100, 0) <= allOn.caps.maxTotalRegionPct + 1e-6);
ok("the axis correction is bounded at half a degree",
  Math.abs(loud.axisAdjustmentDeg) <= 0.5 + 1e-9, String(loud.axisAdjustmentDeg));

/* ---------------------------------------------------------------------------
   7. Payload contract
   --------------------------------------------------------------------------- */

section("The versioned payload the phone hydrates");

const model = core.buildPlayerModel({
  rows: progression.rows,
  config: core.resolveConfig(Object.assign({}, core.defaultConfig(), {
    enabled: true,
    signals: Object.assign({}, core.defaultConfig().signals, {
      direction_progression: Object.assign({}, core.defaultConfig().signals.direction_progression, { enabled: true })
    })
  })),
  offsetDeg: 1.4,
  handedness: "right",
  generatedAt: "2026-08-15T00:00:00.000Z"
});
const compact = core.compactModel(model);

ok("the payload states its model version", compact.bubbleModelVersion === core.MODEL_VERSION);
ok("the payload carries base, geometry, signals and projection",
  !!compact.base && !!compact.geometry && !!compact.signals && !!compact.projection);
ok("the compact payload leaves the detection reasoning behind", compact.detected === undefined);
ok("the full model keeps it for Studio", Array.isArray(model.detected) && model.detected.length === 5);
ok("the aim is passed through untouched", compact.base.offsetDeg === 1.4);
ok("the projection names representative clubs", compact.projection.representativeClubs.length >= 3,
  JSON.stringify(compact.projection.representativeClubs));
ok("a version-matched payload is usable", core.modelIsUsable(compact));
ok("a payload from a future build is refused",
  !core.modelIsUsable(Object.assign({}, compact, { bubbleModelVersion: core.MODEL_VERSION + 1 })));

/* ---------------------------------------------------------------------------
   8. Seeding
   --------------------------------------------------------------------------- */

section("Reproducibility");

const seededA = generator.generate({ relationship: "curvature_bias", provider: "trackman", shots: 12, clubs: 3, seed: 99 });
const seededB = generator.generate({ relationship: "curvature_bias", provider: "trackman", shots: 12, clubs: 3, seed: 99 });
ok("the same seed produces the same shots byte for byte",
  JSON.stringify(seededA.rows.map((r) => [r.carryDistance, r.offlineDistance, r.faceToPath]))
  === JSON.stringify(seededB.rows.map((r) => [r.carryDistance, r.offlineDistance, r.faceToPath])));
const seededC = generator.generate({ relationship: "curvature_bias", provider: "trackman", shots: 12, clubs: 3, seed: 100 });
ok("a different seed produces different shots",
  JSON.stringify(seededA.rows.map((r) => r.carryDistance)) !== JSON.stringify(seededC.rows.map((r) => r.carryDistance)));
ok("an unseeded run returns the seed it used", Number.isFinite(generator.generate({ shots: 4 }).seed));

/* ---------------------------------------------------------------------------

   --------------------------------------------------------------------------- */

console.log("");
if (failures.length) {
  console.log(failures.length + " failing, " + passed + " passing");
  process.exit(1);
}
console.log(passed + " asserted, 0 failing");
