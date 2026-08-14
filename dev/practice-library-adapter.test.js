// The seam between Clarity-native rows and the Clarity Shot Library.
//
// This is where an importer stops speaking its own dialect, so the things that
// must not drift are: which native field becomes which library metric, that
// left stays negative across the seam, and that expectedDistanceM is the bag
// baseline rather than the shot's own carry.
//
// Run: node dev/practice-library-adapter.test.js
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const parser = require(path.join(ROOT, 'functions', 'practice-data-parser.js'));
const adapter = require(path.join(ROOT, 'scripts', 'gd-practice-library-adapter.js'));

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('ok  -', msg);
  else { console.error('FAIL:', msg); failures += 1; }
}

/* Stand-ins for the two browser functions the adapter leans on. They record
   what they were asked for, which is the point of the test. */
const seen = [];
const deps = {
  metricForKey: (key, value) => {
    seen.push([key, value]);
    return { rawLabel: key, candidateMetric: key, rawValue: String(value), value, unit: 'm', confidence: 0.84 };
  },
  clubBaselineM: (club) => (club === '7 Iron' ? 150 : 155)
};

function metricValue(group, key) {
  const found = (group.metrics || []).find((metric) => metric.candidateMetric === key);
  return found ? found.value : undefined;
}

function rowsFrom(text) {
  const parsed = parser.parsePracticeImportText(text, {});
  return parser.createPracticeImportBatch(parsed.rows, {}, { playerId: 'p1', playerName: 'Tester' }).rows;
}

// ---- the mapping ----

const payload = adapter.nativeRowsToLibraryPayload(
  rowsFrom('Club,Carry,Total,Offline,Face,Path,Start,Ball Speed\n7 Iron,142,151,-6,1.2,3.1,0.8,118.4'),
  { label: 'shots.csv' },
  deps
);

assert(payload.clubGroups.length === 1, 'one row becomes one club group');
const group = payload.clubGroups[0];
assert(group.originClubLabel === '7 Iron' && group.candidateClub === '7 Iron', 'the club label is carried across');
assert(metricValue(group, 'carry') === 142, 'carryDistance becomes carry');
assert(metricValue(group, 'total') === 151, 'totalDistance becomes total');
assert(metricValue(group, 'offline') === -6, 'offlineDistance becomes offline');
assert(metricValue(group, 'faceAngle') === 1.2, 'faceAngle becomes faceAngle');
assert(metricValue(group, 'clubPath') === 3.1, 'pathAngle becomes clubPath');
assert(metricValue(group, 'launchDirection') === 0.8, 'startDirection becomes launchDirection');
assert(metricValue(group, 'ballSpeed') === 118.4, 'ballSpeed becomes ballSpeed');

// ---- expectedDistanceM is the baseline, not the carry ----

assert(group.expectedDistanceM === 150, 'expectedDistanceM is the bag baseline');
assert(group.expectedDistanceM !== metricValue(group, 'carry'), 'expectedDistanceM is NOT the row carry (that flat-lines the plot)');

// ---- direction survives the seam ----

const sided = adapter.nativeRowsToLibraryPayload(
  rowsFrom('Club,Carry,Offline,Side\n7 Iron,142,6,left\n7 Iron,140,6,right'),
  {},
  deps
);
assert(metricValue(sided.clubGroups[0], 'offline') === -6, 'a left miss stays negative across the seam');
assert(metricValue(sided.clubGroups[1], 'offline') === 6, 'a right miss stays positive across the seam');

// ---- what must not be invented ----

const spinny = adapter.nativeRowsToLibraryPayload(
  rowsFrom('Club,Carry,Spin,Side Spin\n7 Iron,142,6200,-420'),
  {},
  deps
);
assert(metricValue(spinny.clubGroups[0], 'sideSpin') === -420, 'sideSpin is carried');
assert(
  metricValue(spinny.clubGroups[0], 'backspin') === undefined && metricValue(spinny.clubGroups[0], 'totalSpin') === undefined,
  'a bare spin column is NOT guessed into backspin or total spin'
);

// ---- rejected rows are reported, not silently dropped ----

const mixed = adapter.nativeRowsToLibraryPayload(
  rowsFrom('Club,Carry,Total\n7 Iron,142,151\n7 Iron,abc,148'),
  {},
  deps
);
assert(mixed.clubGroups.length === 1, 'only clean rows reach the library');
assert(mixed.rejectedRows.length === 1, 'the rejected row is reported back');

// ---- a zero is not a missing value ----

const zeroed = adapter.nativeRowsToLibraryPayload(
  [{ club: '7 Iron', carryDistance: 142, offlineDistance: 0, totalDistance: null, errors: [] }],
  {},
  deps
);
assert(metricValue(zeroed.clubGroups[0], 'offline') === 0, 'a real zero offline is carried');
assert(metricValue(zeroed.clubGroups[0], 'total') === undefined, 'a null total is left out rather than sent as 0');

// ---- provenance rides along ----

const stamped = adapter.nativeRowsToLibraryPayload(
  rowsFrom('Club,Carry (yds)\n7 Iron,155'),
  { label: 'range.csv', unitSystem: 'imperial', sessionDate: '2026-07-28' },
  deps
);
assert(stamped.unitSystem === 'imperial', 'the batch unit system is carried on the payload');
assert(stamped.sessionDate === '2026-07-28', 'the session date is carried on the payload');
assert(stamped.label === 'range.csv', 'the label is the source name');

// ---- the seam has to line up with the library it feeds ----

const fs = require('fs');

// An inputType the library does not count as practice evidence imports fine and
// then never appears on the Practice Data screen - which reads to a player as
// the import having silently failed.
const libraryText = fs.readFileSync(path.join(ROOT, 'scripts', 'gd-launch-monitor-data.js'), 'utf8');
const displayLane = libraryText.slice(
  libraryText.indexOf('function captureDisplayLane'),
  libraryText.indexOf('function captureCanDisplay')
);
const defaultType = adapter.nativeRowsToLibraryPayload([], {}, deps).inputType;
assert(
  displayLane.includes("'" + defaultType + "'"),
  'the adapter default inputType (' + defaultType + ') is one captureDisplayLane counts as practice evidence'
);

// The uploaded-file path must go through the parser, not the old builder.
const coreText = fs.readFileSync(path.join(ROOT, 'scripts', 'gd-app-core.js'), 'utf8');
const uploadFn = coreText.slice(
  coreText.indexOf('async function gdHandleLaunchMonitorUpload'),
  coreText.indexOf('var gdPracticeLiveDebugEvents')
);
assert(uploadFn.length > 0, 'gdHandleLaunchMonitorUpload was found');
assert(
  !uploadFn.includes('gdBuildLaunchMonitorTextCapture'),
  'file upload no longer uses the legacy whitespace/label-value builder'
);
assert(
  uploadFn.includes('gdPracticeNativePayloadFromText'),
  'file upload builds its payload through the Clarity-native seam'
);

const markup = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
assert(
  /scripts\/gd-practice-library-adapter\.js\?v=/.test(markup),
  'index.html loads the adapter (with a cache-busting version)'
);

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exitCode = failures ? 1 : 0;
