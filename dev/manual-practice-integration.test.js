// Manual Practice, end to end: plotted observations -> canonical Practice
// evidence -> the Shot Library -> the analysis the Practice Bubble is built
// from.
//
// The seam test next door proves one observation converts correctly. This
// proves the converted evidence still MEANS the same thing once the real
// pipeline has gated, clustered and scored it: that a right-side pattern reads
// right, that a wider pattern reads wider, that a shot the player admitted was
// disrupted is kept but cannot move the answer, and that one player's manual
// session can never reach another player's practice data.
//
// Everything runs against the real gd-launch-monitor-data.js and the real
// manual store, loaded headlessly - no stubbed analysis anywhere.
//
// Run: node dev/manual-practice-integration.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('ok  -', msg);
  else { console.error('FAIL:', msg); failures += 1; }
}
function near(a, b, tolerance, msg) {
  const ok = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
  assert(ok, msg + (ok ? '' : ` (got ${a}, expected ~${b} +-${tolerance})`));
}

// ---- the app, loaded headlessly ----

const BAG = { PW: 120, '7i': 150, '4i': 190, Driver: 240 };
const BUBBLE = {
  PW: { widthM: 18, depthM: 16 },
  '7i': { widthM: 26, depthM: 22 },
  '4i': { widthM: 34, depthM: 28 },
  Driver: { widthM: 44, depthM: 34 }
};

function loadApp() {
  const storage = new Map();
  const win = {
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    addEventListener: () => {},
    dispatchEvent: () => {},
    console
  };
  win.window = win;
  win.document = {
    readyState: 'complete',
    addEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null
  };
  ['Date', 'Math', 'JSON', 'Number', 'Object', 'Array', 'String', 'Promise', 'RegExp', 'Error', 'Boolean', 'isNaN', 'parseFloat', 'parseInt'].forEach((key) => { win[key] = global[key]; });
  const ctx = vm.createContext(win);
  const load = (file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });

  load('scripts/gd-launch-monitor-alias-registry.js');
  const registry = win.GolfDaddyLaunchMonitorAliasRegistry;

  /* The four app globals the manual lane reads, and nothing else. */
  win.gdClarityClubBaselineM = (club) => BAG[club] || 155;
  win.gdGeneratedShotBubbleForClub = (club) => BUBBLE[club] || null;
  win.gdLmMetricForKey = (key, value) => {
    const config = registry.metricConfig(key);
    const number = Number(value);
    if (!config || !Number.isFinite(number)) return null;
    return {
      rawLabel: config.label,
      candidateMetric: config.candidateMetric,
      rawValue: String(value),
      value: number,
      unit: config.unit,
      confidence: config.confidence
    };
  };
  win.gdBagSourceRows = () => Object.keys(BAG).map((club) => ({ club }));
  win.gdLmToast = () => {};
  win.renderPracticeData = () => {};

  /* Who is signed in, and who they are looking at. Both are mutable so the
     ownership tests can move between players. */
  win.__permission = 'admin';
  win.__scope = { viewedProfileId: 'player-a', accountName: 'Player A', accountId: 'account-a' };
  win.gdGetAccountPermission = () => win.__permission;
  win.ClaritySession = {
    get: () => win.__scope,
    isStaff: () => win.__permission === 'admin' || win.__permission === 'coach'
  };

  load('scripts/gd-launch-monitor-data.js');
  load('scripts/gd-manual-practice-core.js');
  load('scripts/gd-manual-practice-data.js');
  return win;
}

const win = loadApp();
const library = win.GolfDaddyLaunchMonitorData;
const manual = win.GolfDaddyManualPracticeData;

function asPlayer(playerId, name) {
  win.__scope = { viewedProfileId: playerId, accountName: name || playerId, accountId: 'account-' + playerId };
}
function asPermission(value) {
  win.__permission = value;
}

/* Deterministic: the nth shot of a pattern always lands in the same place, so a
   failure is a change in the pipeline and never a change in the data. */
function pattern(club, x, y, count, spread) {
  const shots = [];
  for (let i = 0; i < count; i += 1) {
    // Evenly spaced across the spread and symmetric about the centre, so a
    // mirrored pattern really is a mirrored set of points.
    const wobble = count > 1 ? (i / (count - 1)) * 2 - 1 : 0;
    shots.push({ club, x: x + wobble * spread, y: y + wobble * (spread / 2) });
  }
  return shots;
}

function plot(shots, classification) {
  shots.forEach((shot) => {
    manual.setSelectedClub(shot.club);
    manual.addObservation({ clubId: shot.club, x: shot.x, y: shot.y, classification: classification || 'representative' });
  });
}

/* A whole manual session, exactly as the lane runs it: plot, finish, analyse. */
function session(shots, options) {
  const opts = options || {};
  manual.startNewSession();
  plot(shots);
  (opts.disrupted || []).forEach((shot) => plot([shot], 'disrupted'));
  const finished = manual.finishSession();
  return { finished, analysis: library.analyzeDisplay() };
}

function clubCluster(analysis, club) {
  return ((analysis.methods.resultScaledCluster.clubClusters) || []).find((cluster) => cluster.club === club) || null;
}

function resetLibrary() {
  library.clearStore();
}

// ---- 1. the path exists, and it lands in the practice evidence lane ----

resetLibrary();
const right = session(pattern('7i', 0.3, 0, 6, 0.04));
assert(right.finished.ok === true, 'a finished session imports into the Practice Library');
assert(right.finished.session.shotCount === 6, 'every plotted observation becomes a stored shot');
assert(
  library.getDisplayStore().captures.some((capture) => capture.inputType === 'manual-practice'),
  'the manual capture reaches the practice evidence lane, so it shows on the Practice Data screen'
);
assert(right.analysis.acceptedShots.length === 6, 'and every one of them is accepted for the graph');
assert(right.analysis.totals.rejected === 0, 'a plotted session rejects nothing');
assert(
  right.analysis.acceptedShots.every((shot) => shot.plot.source === 'direct_offline' && !shot.plot.simulated),
  'manual shots plot from their own converted offline, never from a simulation'
);

// ---- 2. the pattern means what it looked like ----

const method = right.analysis.methods.resultScaledCluster;
assert(method.showToUser === true, 'a tight six-shot manual pattern is enough to say something');
assert(method.anchorDeg > 0, 'a right-side manual pattern reads as a positive offset');
near(method.anchorDeg, Math.atan2(0.3 * 13, 150) * 180 / Math.PI, 0.3, 'the offset is the geometry of the plot, not a manual-only number');
assert(right.analysis.recommendation.showToUser === true, 'and it reaches the recommendation the Bubble is built from');

resetLibrary();
const left = session(pattern('7i', -0.3, 0, 6, 0.04));
assert(left.analysis.methods.resultScaledCluster.anchorDeg < 0, 'a left-side manual pattern reads as a negative offset');
near(
  left.analysis.methods.resultScaledCluster.anchorDeg,
  -right.analysis.methods.resultScaledCluster.anchorDeg,
  0.05,
  'a mirrored pattern is a mirrored answer'
);

// ---- 3. wider is wider ----

resetLibrary();
const tight = session(pattern('7i', 0.2, 0, 8, 0.02));
resetLibrary();
const wide = session(pattern('7i', 0.2, 0, 8, 0.25));
assert(
  clubCluster(wide.analysis, '7i').radiusDeg > clubCluster(tight.analysis, '7i').radiusDeg,
  'a wider manual pattern produces a wider resulting dispersion'
);
assert(
  clubCluster(wide.analysis, '7i').stdDeg > clubCluster(tight.analysis, '7i').stdDeg,
  'and a bigger standard deviation'
);

// ---- 4. disrupted survives as evidence, but cannot move the answer ----

resetLibrary();
const clean = session(pattern('7i', 0.15, 0, 6, 0.03));
resetLibrary();
const withOutlier = session(pattern('7i', 0.15, 0, 6, 0.03), { disrupted: [{ club: '7i', x: 0.95, y: 0.6 }] });

assert(withOutlier.analysis.acceptedShots.length === 7, 'the disrupted shot is kept as evidence, not deleted at the boundary');
const disruptedShot = withOutlier.analysis.acceptedShots.find((shot) => shot.provenance && shot.provenance.classification === 'disrupted');
assert(!!disruptedShot, 'and it is still identifiable as disrupted in the library');
assert(disruptedShot.excludeFromPrimaryPattern === true, 'it is flagged out of the primary pattern rather than out of the store');
assert(
  library.excludedFromPrimaryPattern(disruptedShot) === true && library.excludedFromPrimaryPattern(withOutlier.analysis.acceptedShots[0]) === false,
  'the library reads that flag through its own gate, not a manual-practice conditional'
);
assert(
  withOutlier.analysis.methods.resultScaledCluster.anchorDeg === clean.analysis.methods.resultScaledCluster.anchorDeg,
  'a disrupted outlier does not move the primary result at all'
);
assert(
  clubCluster(withOutlier.analysis, '7i').countedShots === clubCluster(clean.analysis, '7i').countedShots,
  'and it is not counted in the cluster'
);

// ---- 5. cross-club replication still works through the canonical route ----

resetLibrary();
manual.startNewSession();
// The same ~1.5deg miss on two clubs: 0.3 of a 13m half-span at 150m, and 0.35
// of a 9m half-span at 120m.
plot(pattern('7i', 0.3, 0, 6, 0.03));
plot(pattern('PW', 0.35, 0, 6, 0.03));
assert(manual.finishSession().ok === true, 'a multi-club manual session imports as one batch');
const multi = library.analyzeDisplay();
assert(clubCluster(multi, '7i') && clubCluster(multi, 'PW'), 'two clubs produce two clusters');
near(
  clubCluster(multi, '7i').centerDeg,
  clubCluster(multi, 'PW').centerDeg,
  1.0,
  'the same miss on two clubs reads as the same angle'
);
assert(
  multi.methods.resultScaledCluster.status === 'cross_distance_verified',
  'and the canonical pipeline calls that cross-distance verified'
);
assert(
  multi.methods.resultScaledCluster.verificationClubs.length >= 2,
  'naming the clubs that corroborated it'
);

// ---- 6. provenance, and nothing invented ----

const stored = multi.acceptedShots[0];
assert(stored.source === 'manual_practice', 'stored evidence says it was plotted by hand');
assert(stored.provenance.manualPractice === true && stored.provenance.plot, 'the plot it came from is stored with it');
assert(stored.provenance.calibration.calibrationVersion === win.GolfDaddyManualPracticeCore.CALIBRATION_VERSION, 'so is the calibration version that produced it');
assert(
  multi.acceptedShots.every((shot) => shot.metrics.length === 2),
  'no manual shot carries more than the carry and offline it can honestly claim'
);
assert(
  multi.acceptedShots.every((shot) => shot.delivery.faceToPathDeg === null && shot.delivery.faceAngleDeg === null && shot.delivery.clubPathDeg === null),
  'no face angle, club path or face-to-path is fabricated'
);
assert(
  multi.acceptedShots.every((shot) => shot.plot.spinAxisDeg === undefined && shot.plot.ballSpeedMph === undefined),
  'no spin or ball speed is fabricated'
);
assert(
  multi.methods.deliveryCluster.status === 'needs_more_data',
  'with no delivery measurements the delivery method stays silent instead of guessing'
);
near(stored.depthM, stored.carryM - BAG[stored.club], 0.01, 'depth is carry minus the bag distance, exactly like an imported shot');

// ---- 7. the trusted override reaches the same downstream result ----

const beforeOverride = library.analyzeDisplay();
assert(manual.applyTrustedOverride(beforeOverride) === beforeOverride, 'with no override set, the analysis passes through untouched');
assert(!!manual.setTrustedOverride({ clubId: '7i', offsetDeg: 3.4 }), 'a coach can set a trusted override');
const overridden = manual.applyTrustedOverride(library.analyzeDisplay());
assert(overridden.recommendation.offsetDeg === 3.4, 'the override anchors the recommendation at the stated offset');
assert(overridden.methods.resultScaledCluster.source === 'coach_manual_override', 'stamped as a coach override, not as measured evidence');
assert(
  overridden.methods.resultScaledCluster.clubClusters.length === beforeOverride.methods.resultScaledCluster.clubClusters.length,
  'the clusters under it are still the pipeline\'s own'
);
assert(overridden.acceptedShots.length === beforeOverride.acceptedShots.length, 'and the evidence is unchanged');
asPermission('player');
assert(manual.setTrustedOverride({ clubId: '7i', offsetDeg: 9 }) === null, 'a player cannot set a trusted override');
asPermission('admin');
assert(manual.clearTrustedOverride() === true, 'and it can be cleared again');
assert(manual.applyTrustedOverride(library.analyzeDisplay()).recommendation.offsetDeg !== 3.4, 'clearing it puts the measured answer back');

// ---- 8. a finished session is finished ----

resetLibrary();
manual.startNewSession();
plot(pattern('7i', 0.2, 0, 5, 0.03));
const firstSessionId = manual.activeSession().sessionId;
const firstFinish = manual.finishSession();
assert(firstFinish.ok === true, 'the first session finishes');
assert(manual.activeSession() === null, 'and there is no active session left to append to');
plot(pattern('7i', -0.2, 0, 5, 0.03));
const secondSessionId = manual.activeSession().sessionId;
assert(secondSessionId !== firstSessionId, 'the next plotted shot starts a new session');
assert(manual.activeSession().observations.length === 5, 'and only the new shots are in it');
assert(
  manual.getSessionById(firstSessionId).observations.length === 5,
  'the finished session keeps exactly what it was finished with'
);
assert(manual.getSessionById(firstSessionId).status === 'completed', 'and is marked completed');
assert(manual.getSessionById(firstSessionId).importBatchId, 'with the import batch it became');
assert(manual.finishSession().ok === true, 'the second session finishes independently');
assert(
  library.analyzeDisplay().totals.rawShots === 10,
  'both sessions are in the library, and neither replaced the other'
);

// ---- 9. one player's manual data never reaches another's ----

const playerAShots = library.analyzeDisplay().totals.rawShots;
assert(playerAShots === 10, 'player A has their ten shots');
const playerASessions = manual.listSessions().length;

asPlayer('player-b', 'Player B');
assert(manual.listSessions().length === 0, 'player B sees none of player A\'s manual sessions');
assert(manual.activeSession() === null, 'and inherits no active session');
assert(library.analyzeDisplay().totals.rawShots === 0, 'nor any of their practice evidence');
manual.startNewSession();
plot(pattern('PW', 0.4, 0, 5, 0.03));
assert(manual.finishSession().ok === true, 'player B can run their own session');
assert(library.analyzeDisplay().totals.rawShots === 5, 'which contains only their own shots');
assert(
  library.analyzeDisplay().acceptedShots.every((shot) => shot.playerId === 'player-b'),
  'every stored shot is stamped with the player who plotted it'
);

asPlayer('player-a', 'Player A');
assert(manual.listSessions().length === playerASessions, 'player A\'s sessions are exactly as they left them');
assert(library.analyzeDisplay().totals.rawShots === playerAShots, 'and so is their practice evidence');
assert(
  library.analyzeDisplay().acceptedShots.every((shot) => shot.playerId === 'player-a'),
  'with nothing of player B\'s mixed in'
);

// ---- 10. no player, no read and no write ----

const beforeUnscoped = JSON.parse(win.localStorage.getItem(manual.storageKey)).sessions.length;
asPlayer('', '');
assert(manual.hasPlayerScope() === false, 'an unresolvable player is recognised as unscoped');
assert(manual.activeSession() === null, 'an unscoped read returns nothing rather than everyone\'s sessions');
assert(manual.listSessions().length === 0, 'listing sessions unscoped lists nobody\'s');
assert(manual.addObservation({ clubId: '7i', x: 0.2, y: 0 }) === null, 'an unscoped write is refused');
assert(manual.startNewSession() === null, 'an unscoped session cannot be started');
assert(manual.finishSession().ok === false, 'and nothing can be finished into the library');
assert(
  JSON.parse(win.localStorage.getItem(manual.storageKey)).sessions.length === beforeUnscoped,
  'nothing was written to the store while unscoped'
);
assert(manual.setTrustedOverride({ offsetDeg: 4 }) === null, 'an unscoped override is refused too');

// ---- 11. the rollout gate is one gate ----

asPlayer('player-a', 'Player A');
asPermission('coach');
assert(manual.activeSession() === null && manual.addObservation({ clubId: '7i', x: 0, y: 0 }) === null, 'a coach gets no Manual Practice lane yet');
assert(manual.applyTrustedOverride({ recommendation: {} }).recommendation.offsetDeg === undefined, 'and no manual override is applied for them');
asPermission('player');
assert(manual.listSessions().length === 0, 'nor does a player');
asPermission('admin');
assert(manual.listSessions().length === playerASessions, 'and an admin still sees their own');

// ---- 12. the other import routes are untouched ----

resetLibrary();
const csvLike = {
  label: 'shots.csv',
  inputType: 'native-csv',
  clubGroups: [{
    originClubLabel: '7i',
    candidateClub: '7i',
    expectedDistanceM: 150,
    metrics: [win.gdLmMetricForKey('carry', 148), win.gdLmMetricForKey('offline', 4)]
  }]
};
library.importCapture(csvLike);
const csvAnalysis = library.analyzeDisplay();
assert(csvAnalysis.acceptedShots.length === 1, 'a normal CSV-shaped import still imports');
assert(csvAnalysis.acceptedShots[0].source === 'launch_monitor', 'and is still attributed to a launch monitor');
assert(csvAnalysis.acceptedShots[0].excludeFromPrimaryPattern === false, 'an import that says nothing about the primary pattern is in it');
assert(csvAnalysis.acceptedShots[0].provenance === null, 'and carries no invented provenance block');

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exitCode = failures ? 1 : 0;
