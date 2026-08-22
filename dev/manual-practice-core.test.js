// The Manual Practice seam: a plotted observation -> canonical Practice
// evidence.
//
// What must not drift here is what the conversion is allowed to claim. A dot on
// a plot knows where it finished and nothing else, so this file holds the
// conversion to two measurements, a stable calibration, honest provenance, and
// a classification that survives the boundary instead of being deleted at it.
//
// Run: node dev/manual-practice-core.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const core = require(path.join(ROOT, 'scripts', 'gd-manual-practice-core.js'));
require(path.join(ROOT, 'scripts', 'gd-launch-monitor-alias-registry.js'));
const registry = globalThis.GolfDaddyLaunchMonitorAliasRegistry;

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('ok  -', msg);
  else { console.error('FAIL:', msg); failures += 1; }
}
function near(a, b, tolerance, msg) {
  const ok = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
  assert(ok, msg + (ok ? '' : ` (got ${a}, expected ~${b} +-${tolerance})`));
}

/* The three app functions the seam is allowed to read, stubbed so the whole
   conversion runs headlessly. */
const BAG = { PW: 120, '7i': 150, '4i': 190 };
const BUBBLE = {
  PW: { widthM: 18, depthM: 16 },
  '7i': { widthM: 26, depthM: 22 },
  '4i': { widthM: 34, depthM: 28 }
};
const deps = {
  clubBaselineM: (club) => BAG[club],
  generatedBubbleForClub: (club) => BUBBLE[club] || null,
  metricForKey: (key, value) => {
    const config = registry.metricConfig(key);
    if (!config) return null;
    return {
      rawLabel: config.label,
      candidateMetric: config.candidateMetric,
      rawValue: String(value),
      value: Number(value),
      unit: config.unit,
      confidence: config.confidence
    };
  }
};

function session(observations, extra = {}) {
  return Object.assign({
    sessionId: 'session-1',
    playerId: 'player-1',
    playerName: 'Tester',
    accountId: 'account-1',
    createdAt: '2026-08-22T09:00:00.000Z',
    updatedAt: '2026-08-22T09:30:00.000Z',
    observations
  }, extra);
}

function obs(id, club, x, y, classification = 'representative') {
  return { observationId: id, clubId: club, x, y, classification, createdAt: '2026-08-22T09:10:00.000Z' };
}

function metric(group, candidateMetric) {
  const found = (group.metrics || []).find((item) => item.candidateMetric === candidateMetric);
  return found ? found.value : undefined;
}

function groupsFor(observations) {
  return core.manualSessionToLibraryPayload(session(observations), deps).clubGroups;
}

// ---- calibration is explicit, deterministic and versioned ----

const cal = core.resolveManualPracticePlotCalibration('7i', deps);
assert(cal.expectedCarryM === 150, 'the expected carry is the bag baseline, not a manual-only number');
assert(cal.lateralHalfSpanM === 13 && cal.depthHalfSpanM === 11, 'the half-spans are half the generated bubble');
assert(cal.calibrationSource === 'club_baseline+generated_bubble', 'the calibration says where both halves came from');
assert(cal.calibrationVersion === core.CALIBRATION_VERSION, 'the calibration is stamped with its version');
assert(
  JSON.stringify(core.resolveManualPracticePlotCalibration('7i', deps)) === JSON.stringify(cal),
  'the same club calibrates to the same numbers every time'
);

const noBubble = core.resolveManualPracticePlotCalibration('7i', { clubBaselineM: () => 150 });
assert(
  noBubble.calibrationSource === 'club_baseline+carry_ratio',
  'with no generated bubble the span falls back to a carry ratio, and says so'
);
const noBag = core.resolveManualPracticePlotCalibration('9i', {});
assert(noBag.expectedCarryM === 155 && noBag.calibrationSource === 'fallback_carry+carry_ratio', 'the last-resort calibration is named too');
assert(
  core.resolveManualPracticePlotCalibration('7i', { clubBaselineM: () => { throw new Error('boom'); } }).expectedCarryM > 0,
  'a throwing bag resolver still yields a usable calibration rather than a crash'
);

// ---- the conversion itself ----

const centre = groupsFor([obs('a', '7i', 0, 0)])[0];
assert(metric(centre, 'offline') === 0, 'a centre plot is zero offline');
assert(metric(centre, 'carryDistance') === 150, 'a centre plot carries the bag distance');
assert(centre.expectedDistanceM === 150, 'expectedDistanceM is the bag baseline, so depth reads as carry-minus-bag');
assert(
  centre.expectedDistanceM === metric(centre, 'carryDistance'),
  'a centre plot happens to match, which is the only case where it should'
);

const [left, right] = groupsFor([obs('a', '7i', -1, 0), obs('b', '7i', 1, 0)]);
assert(metric(left, 'offline') === -13, 'a full-left plot is the negative lateral half-span');
assert(metric(right, 'offline') === 13, 'a full-right plot is the positive half-span');
assert(metric(left, 'offline') === -metric(right, 'offline'), 'left and right are mirror images');

const [long, short] = groupsFor([obs('a', '7i', 0, 1), obs('b', '7i', 0, -1)]);
assert(metric(long, 'carryDistance') === 161, 'a long plot carries the baseline plus the depth half-span');
assert(metric(short, 'carryDistance') === 139, 'a short plot carries the baseline minus it');
assert(long.expectedDistanceM === short.expectedDistanceM, 'both are still measured against the same bag distance');

// ---- a different club is a different scale, because the club is ----

const [wedge, iron] = groupsFor([obs('a', 'PW', 0.5, 0), obs('b', '4i', 0.5, 0)]);
assert(metric(wedge, 'offline') === 4.5, 'the wedge uses the wedge half-span');
assert(metric(iron, 'offline') === 8.5, 'the long iron uses its own');
assert(wedge.expectedDistanceM === 120 && iron.expectedDistanceM === 190, 'each club is measured against its own bag distance');
assert(
  metric(wedge, 'offline') < metric(iron, 'offline'),
  'the same normalised plot is fewer metres on the shorter club'
);

// ---- nothing is invented ----

const INVENTED = ['ballSpeed', 'clubSpeed', 'totalSpin', 'backspin', 'sideSpin', 'spinAxis', 'faceAngle', 'clubPath', 'faceToPath', 'launchDirection', 'launch', 'smashFactor', 'dynamicLoft'];
const anyGroup = groupsFor([obs('a', '7i', 0.3, 0.1)])[0];
assert(anyGroup.metrics.length === 2, 'a plotted dot produces exactly two measurements');
INVENTED.forEach((key) => {
  assert(metric(anyGroup, key) === undefined, `${key} is not fabricated from a plotted dot`);
});

// ---- provenance is truthful and complete ----

const stamped = groupsFor([obs('obs-7', '7i', 0.4, -0.2)])[0];
assert(stamped.source === 'manual_practice', 'the evidence says it was plotted by hand');
assert(stamped.provenance.manualPractice === true, 'and says so again where a reader of the store will see it');
assert(stamped.provenance.observationId === 'obs-7' && stamped.provenance.sessionId === 'session-1', 'the observation and session it came from are kept');
assert(stamped.provenance.plot.x === 0.4 && stamped.provenance.plot.y === -0.2, 'the original plot coordinates are kept');
assert(
  stamped.provenance.calibration.calibrationVersion === core.CALIBRATION_VERSION &&
  stamped.provenance.calibration.expectedCarryM === 150,
  'the calibration that produced these metres is stored with them, so they cannot be silently reinterpreted'
);
assert(stamped.playerId === 'player-1' && stamped.accountId === 'account-1', 'the player scope rides on the evidence');
assert(stamped.provenance.geometryPresetId === null, 'geometryPresetId stays a nullable hook');
assert(stamped.shotId === 'manual-obs-7', 'the shot id traces back to the observation');
assert(stamped.timestamp === '2026-08-22T09:10:00.000Z', 'the observation keeps its own timestamp');

// ---- classification survives the boundary ----

const [rep, dis] = groupsFor([obs('a', '7i', 0.1, 0), obs('b', '7i', 0.9, 0.6, 'disrupted')]);
assert(rep.provenance.classification === 'representative' && dis.provenance.classification === 'disrupted', 'both classifications cross the boundary');
assert(dis.metrics.length === 2, 'a disrupted shot is still real evidence with real metrics');
assert(rep.excludeFromPrimaryPattern === false, 'a representative shot counts toward the primary pattern');
assert(dis.excludeFromPrimaryPattern === true, 'a disrupted shot is retained but excluded from it');
assert(rep.analysisLane === core.PRIMARY_LANE, 'representative evidence takes the per-club cluster lane');
assert(dis.analysisLane === core.DISRUPTED_LANE, 'disrupted evidence does not');
assert(
  core.classificationOf({ classification: 'DISRUPTED' }) === 'disrupted' && core.classificationOf({}) === 'representative',
  'classification defaults to representative and is case-insensitive'
);

// ---- the payload is a normal practice import ----

const payload = core.manualSessionToLibraryPayload(session([obs('a', '7i', 0, 0), obs('b', 'PW', 0.2, 0)]), deps);
assert(payload.inputType === core.INPUT_TYPE, 'the payload declares the manual input type');
assert(payload.sourceIdentity.providerGuess === 'manual_practice', 'no launch monitor is named for shots no monitor saw');
assert(payload.clubGroups.length === 2, 'every observation becomes a club group');
assert(Object.keys(payload.calibrations).sort().join(',') === '7i,PW', 'the calibration used for each club is kept on the payload');
assert(core.manualSessionToLibraryPayload({}, deps).clubGroups.length === 0, 'an empty session converts to an empty payload rather than throwing');

// ---- the trusted override restates the anchor, it does not re-analyse ----

const analysis = {
  acceptedShots: [{ club: '7i' }],
  clusters: [{ club: '7i', shots: 6 }],
  methods: {
    resultScaledCluster: { method: 'result_scaled_cluster', status: 'needs_more_data', anchorDeg: null, clubClusters: [{ club: '7i', countedShots: 6 }], showToUser: false },
    deliveryCluster: { method: 'delivery_cluster', status: 'needs_more_data' }
  },
  recommendation: { status: 'needs_more_data', offsetDeg: null, evidence: [], showToUser: false }
};
const overridden = core.applyTrustedOverrideToAnalysis(analysis, { club: '7i', offsetDeg: 2.6, createdAt: '2026-08-22T10:00:00.000Z', createdBy: 'coach-1' });
assert(overridden.recommendation.offsetDeg === 2.6, 'the override sets the offset the coach stated');
assert(overridden.recommendation.source === 'coach_manual_override', 'and stamps where that offset came from');
assert(overridden.methods.resultScaledCluster.showToUser === true, 'the override is shown to the user');
assert(
  overridden.methods.resultScaledCluster.clubClusters === analysis.methods.resultScaledCluster.clubClusters,
  'cluster membership still comes from the pipeline - the override does not fabricate one'
);
assert(overridden.acceptedShots === analysis.acceptedShots, 'the evidence is untouched');
assert(
  overridden.recommendation.evidence.includes('result_scaled_cluster'),
  'the override reaches the Bubble down the same evidence path a normal result does'
);
assert(overridden.override.createdBy === 'coach-1' && overridden.override.createdAt === '2026-08-22T10:00:00.000Z', 'who set it and when are kept');
assert(analysis.recommendation.offsetDeg === null, 'the original analysis object is not mutated');
assert(core.applyTrustedOverrideToAnalysis(analysis, { offsetDeg: 'nonsense' }) === analysis, 'an override without a real offset changes nothing');
assert(core.applyTrustedOverrideToAnalysis(analysis, null) === analysis, 'no override changes nothing');

// ---- the seam has to line up with the pipeline it feeds ----

const libraryText = fs.readFileSync(path.join(ROOT, 'scripts', 'gd-launch-monitor-data.js'), 'utf8');
const displayLane = libraryText.slice(
  libraryText.indexOf('function captureDisplayLane'),
  libraryText.indexOf('function captureCanDisplay')
);
assert(
  displayLane.includes("'" + core.INPUT_TYPE + "'"),
  `the manual inputType (${core.INPUT_TYPE}) is one captureDisplayLane counts as practice evidence`
);
assert(
  libraryText.includes('function excludedFromPrimaryPattern'),
  'the library owns the "kept as evidence, excluded from the primary pattern" rule'
);
assert(
  libraryText.includes("raw.analysisLane === '" + core.PRIMARY_LANE + "'"),
  'the lane manual evidence asks for is a lane the library actually reads'
);

// The fallback metric configs exist only for a headless caller; if they drift
// from the registry, a browser import and a test import stop agreeing.
Object.keys(core.METRIC_FALLBACK).forEach((key) => {
  const config = registry.metricConfig(key);
  const fallback = core.METRIC_FALLBACK[key];
  assert(
    config && config.candidateMetric === fallback.candidateMetric && config.unit === fallback.unit && config.confidence === fallback.confidence,
    `the ${key} fallback metric config still matches the alias registry`
  );
});

// The parallel analysis this module used to carry is the thing being removed;
// if it comes back, the manual route has forked from the Practice pipeline again.
const coreText = fs.readFileSync(path.join(ROOT, 'scripts', 'gd-manual-practice-core.js'), 'utf8');
['analyzeSession', 'buildResultMethod', 'recommendationFromMethod', 'summarizeClub'].forEach((name) => {
  assert(!coreText.includes('function ' + name), `the seam no longer implements ${name} - clustering belongs to the Practice pipeline`);
});
assert(
  !/\bacceptedShots\s*:/.test(coreText),
  'the seam no longer builds its own acceptedShots/analysis contract'
);

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exitCode = failures ? 1 : 0;
