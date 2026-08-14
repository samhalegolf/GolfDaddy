// Graph regression: generated shot data -> import -> Clarity-native rows ->
// the Shot Library -> the numbers the practice graph actually plots.
//
// The CSV fixtures next door prove a file parses into the right rows. This
// proves those rows still MEAN the same thing by the time they reach the plot:
// that a left miss reads left, that a tight session reads tighter than a wide
// one, that an outlier does not drag the centre, and that the same session
// exported in yards lands in the same place as one exported in metres.
//
// Everything is generated from a fixed seed, so a failure is a change in the
// pipeline and never a change in the data.
//
// Run: node dev/practice-graph-regression.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const parser = require(path.join(ROOT, 'functions', 'practice-data-parser.js'));
const adapter = require(path.join(ROOT, 'scripts', 'gd-practice-library-adapter.js'));

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('ok  -', msg);
  else { console.error('FAIL:', msg); failures += 1; }
}
function near(a, b, tolerance, msg) {
  const ok = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
  assert(ok, msg + (ok ? '' : ` (got ${a}, expected ~${b} +-${tolerance})`));
}

// ---- the real library, loaded headlessly ----

function loadLibrary() {
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
  win.document = { readyState: 'complete', addEventListener: () => {}, getElementById: () => null };
  ['Date', 'Math', 'JSON', 'Number', 'Object', 'Array', 'String', 'Promise', 'RegExp', 'Error', 'Boolean', 'isNaN', 'parseFloat', 'parseInt'].forEach((key) => { win[key] = global[key]; });
  const ctx = vm.createContext(win);
  const load = (file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
  load('scripts/gd-launch-monitor-alias-registry.js');
  load('scripts/gd-launch-monitor-data.js');
  return win;
}

const win = loadLibrary();
const library = win.GolfDaddyLaunchMonitorData;

/* The alias registry is the real one, so metric keys, labels and units are the
   app's own. This mirrors gdLmMetricForKey's {strict:false} path - parse the
   number, look up the config - which is what the adapter asks for. */
const registry = win.GolfDaddyLaunchMonitorAliasRegistry || win.GDLaunchMonitorAliasRegistry || win.gdLmAliasRegistryValue;
function metricForKey(key, value) {
  const canonical = registry && typeof registry.canonicalKey === 'function' ? (registry.canonicalKey(key) || key) : key;
  const config = registry && typeof registry.metricConfig === 'function' ? registry.metricConfig(canonical) : null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return {
    rawLabel: config ? config.label : canonical,
    candidateMetric: config ? config.candidateMetric : canonical,
    rawValue: String(value),
    value: number,
    unit: config ? config.unit : '',
    confidence: config && Number.isFinite(Number(config.confidence)) ? Number(config.confidence) : 0.84
  };
}

const BAG = { '7 Iron': 150, '7i': 150, 'PW': 120, 'Driver': 240 };
const deps = { metricForKey, clubBaselineM: (club) => BAG[club] || 150 };

// ---- deterministic generator ----

function seeded(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
/* Box-Muller, so a "spread" is a real standard deviation rather than a
   uniform band - dispersion assertions mean what they say. */
function normal(rand, mean, sd) {
  const u = Math.max(rand(), 1e-9);
  const v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function dataset(options) {
  const opts = Object.assign({ club: '7 Iron', shots: 20, carry: 142, carrySd: 3, offline: 0, offlineSd: 4, seed: 7 }, options);
  const rand = seeded(opts.seed);
  const rows = [];
  for (let i = 0; i < opts.shots; i += 1) {
    const carry = Math.round(normal(rand, opts.carry, opts.carrySd) * 10) / 10;
    const offline = Math.round(normal(rand, opts.offline, opts.offlineSd) * 10) / 10;
    rows.push({ club: opts.club, carry, offline });
  }
  (opts.outliers || []).forEach((outlier) => rows.push({ club: opts.club, carry: opts.carry, offline: outlier }));
  return rows;
}

function csvFrom(rows, unitLabel) {
  const header = `Club,Carry (${unitLabel}),Offline (${unitLabel})`;
  return [header].concat(rows.map((row) => `${row.club},${row.carry},${row.offline}`)).join('\n');
}

/* The whole chain, exactly as the app runs it: text -> parser -> Clarity-native
   rows -> adapter -> library -> analysis. */
function importAndAnalyze(csv, label) {
  library.clearStore();
  const parsed = parser.parsePracticeImportText(csv, { sourceName: label || 'generated.csv' });
  const built = parser.createPracticeImportBatch(parsed.rows, {
    sourceName: label || 'generated.csv',
    unitSystem: parsed.unitSystem,
    unitSource: parsed.unitSource,
    provider: parsed.provider
  }, { playerId: 'p1', playerName: 'Tester' });
  const payload = adapter.nativeRowsToLibraryPayload(built.rows, {
    label: label || 'generated.csv',
    unitSystem: built.batch.unitSystem,
    unitHints: parsed.unitHints
  }, deps);
  library.importCapture(payload);
  return {
    parsed,
    payload,
    analysis: library.analyze({ store: library.getStore() })
  };
}

/* The library normalises club names on the way in ("7 Iron" becomes "7i"), so
   find the cluster by way of a shot that carries the label we generated rather
   than assuming the two spellings match. */
function clusterFor(analysis, originLabel) {
  const shot = (analysis.acceptedShots || []).find((item) => item.originClubLabel === originLabel);
  const club = shot ? shot.club : originLabel;
  return (analysis.clusters || []).find((cluster) => String(cluster.club).toLowerCase() === String(club).toLowerCase()) || null;
}

// ---- 1. nothing is lost between the file and the plot ----

const straight = importAndAnalyze(csvFrom(dataset({ shots: 20, seed: 11 }), 'm'), 'straight.csv');
assert(straight.analysis.totals.rawShots === 20, 'every generated shot reaches the library');
assert(straight.analysis.totals.accepted === 20, 'and every one of them is accepted for the graph');
assert(straight.analysis.totals.rejected === 0, 'a clean session rejects nothing');
assert(
  straight.analysis.acceptedShots.every((shot) => shot.plot && shot.plot.complete && !shot.plot.simulated),
  'every shot plots from its own measured offline, not a simulation'
);
assert(
  straight.analysis.acceptedShots.every((shot) => shot.plot.source === 'direct_offline'),
  'the plot source is the offline column the file supplied'
);

// ---- 2. left is left and right is right, all the way to the plot ----

const left = importAndAnalyze(csvFrom(dataset({ offline: -8, offlineSd: 2, seed: 21 }), 'm'), 'left.csv');
const right = importAndAnalyze(csvFrom(dataset({ offline: 8, offlineSd: 2, seed: 21 }), 'm'), 'right.csv');
assert(clusterFor(left.analysis, '7 Iron').meanDeg < 0, 'a left-biased session reads negative at the cluster');
assert(clusterFor(right.analysis, '7 Iron').meanDeg > 0, 'a right-biased session reads positive');
near(
  clusterFor(left.analysis, '7 Iron').meanDeg,
  -Math.atan2(8, 150) * 180 / Math.PI,
  0.6,
  'the left cluster sits where the geometry says it should (atan2 of offline over the bag baseline)'
);
near(
  clusterFor(right.analysis, '7 Iron').meanDeg,
  -clusterFor(left.analysis, '7 Iron').meanDeg,
  0.2,
  'a mirrored session is a mirrored answer'
);

// ---- 3. tight reads tighter than wide ----

const tight = importAndAnalyze(csvFrom(dataset({ offlineSd: 1.5, seed: 31 }), 'm'), 'tight.csv');
const wide = importAndAnalyze(csvFrom(dataset({ offlineSd: 9, seed: 31 }), 'm'), 'wide.csv');
const tightCluster = clusterFor(tight.analysis, '7 Iron');
const wideCluster = clusterFor(wide.analysis, '7 Iron');
assert(tightCluster.stdDeg < wideCluster.stdDeg, 'a tight session has the smaller standard deviation');
assert(tightCluster.rangeDeg < wideCluster.rangeDeg, 'and the smaller range');
assert(tightCluster.status !== 'needs_more_data', 'a 20-shot tight session is enough data to say something');
assert(
  wideCluster.status === 'needs_more_data' || wideCluster.stdDeg > tightCluster.stdDeg * 2,
  'a very wide session either reads as too scattered to call, or is plainly wider'
);

// ---- 4. an outlier must not drag the centre ----

const withOutliers = importAndAnalyze(
  csvFrom(dataset({ offline: 0, offlineSd: 1.5, seed: 41, outliers: [45, -40] }), 'm'),
  'outliers.csv'
);
const anchorDeg = withOutliers.analysis.methods.resultScaledCluster.anchorDeg;
if (anchorDeg === null) {
  assert(true, 'the outlier session produced no confident anchor (acceptable)');
} else {
  near(anchorDeg, 0, 1.5, 'the median-based centre ignores two wild shots');
}
const outlierMean = clusterFor(withOutliers.analysis, '7 Iron').meanDeg;
assert(
  Math.abs(outlierMean) < 3,
  'the mean is still reported, and the two outliers cancel rather than inventing a bias'
);

// ---- 5. the same session in yards lands in the same place ----

const metres = dataset({ offline: -6, offlineSd: 2, seed: 51 });
const yards = metres.map((row) => ({
  club: row.club,
  carry: Math.round((row.carry / 0.9144) * 10) / 10,
  offline: Math.round((row.offline / 0.9144) * 10) / 10
}));
const inMetres = importAndAnalyze(csvFrom(metres, 'm'), 'metric.csv');
const inYards = importAndAnalyze(csvFrom(yards, 'yds'), 'imperial.csv');
assert(inYards.payload.unitConversions.length > 0, 'the yard file is converted on the way in');
assert(inMetres.payload.unitConversions.length === 0, 'the metre file is not');
near(
  clusterFor(inYards.analysis, '7 Iron').meanDeg,
  clusterFor(inMetres.analysis, '7 Iron').meanDeg,
  0.15,
  'a session exported in yards plots where the same session in metres plots'
);

// ---- 6. distance changes the angle, because the angle is geometry ----

const near150 = importAndAnalyze(csvFrom(dataset({ club: 'PW', carry: 118, offline: 6, offlineSd: 1, seed: 61 }), 'm'), 'wedge.csv');
const far = importAndAnalyze(csvFrom(dataset({ club: 'Driver', carry: 240, offline: 6, offlineSd: 1, seed: 61 }), 'm'), 'driver.csv');
assert(
  clusterFor(near150.analysis, 'PW').meanDeg > clusterFor(far.analysis, 'Driver').meanDeg,
  'the same 6m miss is a bigger angle on a wedge than on a driver'
);

// ---- 7. a whole bag keeps its clubs apart ----

const bagRows = []
  .concat(dataset({ club: '7 Iron', shots: 12, carry: 142, offline: -5, seed: 71 }))
  .concat(dataset({ club: 'Driver', shots: 12, carry: 240, offline: 10, seed: 72 }));
const bag = importAndAnalyze(csvFrom(bagRows, 'm'), 'bag.csv');
assert(bag.analysis.clusters.length === 2, 'two clubs produce two clusters');
assert(clusterFor(bag.analysis, '7 Iron').meanDeg < 0, 'the iron keeps its left bias');
assert(clusterFor(bag.analysis, 'Driver').meanDeg > 0, 'the driver keeps its right bias');
assert(
  clusterFor(bag.analysis, '7 Iron').shots === 12 && clusterFor(bag.analysis, 'Driver').shots === 12,
  'no shot is counted under the wrong club'
);

// ---- 8. depth is measured against the bag, not against itself ----

const shortDay = importAndAnalyze(csvFrom(dataset({ carry: 132, carrySd: 1, offlineSd: 1, seed: 81 }), 'm'), 'short.csv');
const depths = shortDay.analysis.acceptedShots.map((shot) => shot.depthM);
assert(
  depths.every((depth) => depth < 0),
  'a session carrying short of the bag distance reads as negative depth'
);
assert(
  !depths.every((depth) => depth === 0),
  'depth is not flat zero - that is the symptom of expectedDistanceM being set to the shot carry'
);
near(mean(depths), 132 - 150, 2, 'depth is carry minus the bag baseline');

function mean(values) {
  return values.reduce((sum, value) => sum + Number(value), 0) / (values.length || 1);
}

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exitCode = failures ? 1 : 0;
