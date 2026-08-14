// CSV import regression library.
//
// The parity test next door asks "do the browser and the server agree?". This
// one asks the harder question: "does this exact file still produce these exact
// Clarity-native rows?". Every fixture is a real-world-shaped CSV with a written
// down expected result, so a parser change that quietly re-reads a column shows
// up here as a diff instead of as a wrong distance in someone's shot library
// six weeks later.
//
// Layout:
//   dev/fixtures/practice-csv/<case>/input.csv      the file as it would arrive
//   dev/fixtures/practice-csv/<case>/expected.json  what it must turn into
//
// expected.json:
//   why       one line saying what the case is for (required)
//   options   parse options, e.g. {"sourceName":"trackman-export.csv"} (optional)
//   pending   a reason string. The case is a KNOWN GAP: it is run and reported,
//             but it does not fail the suite. `parse`/`batch`/`rows` describe
//             what SHOULD happen, not what happens today. When a pending case
//             starts passing, the suite fails on purpose so the flag gets
//             removed - that is the ratchet.
//   parse     the parse-level result (delimiter, headers, units, warnings)
//   batch     the batch envelope (counts, gate status, provenance gaps)
//   rows      the Clarity-native shots, ids and timestamps stripped
//
// Run:      node dev/practice-csv-regression.test.js
// Author:   node dev/practice-csv-regression.test.js --update
//           (fills in parse/batch/rows from current behaviour for every case
//           that is NOT pending - only ever run this when you intend to bless
//           what the parser does today, and read the diff before committing)
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CASES_DIR = path.join(__dirname, 'fixtures', 'practice-csv');
const parser = require(path.join(ROOT, 'functions', 'practice-data-parser.js'));

const UPDATE = process.argv.includes('--update');
const ONLY = (process.argv.find((arg) => arg.indexOf('--only=') === 0) || '').split('=')[1] || '';

const SCOPE = { playerId: 'player-1', playerName: 'Fixture Player', accountId: 'acct-1' };

/* Fields worth asserting on, in a fixed order so the files read the same way
   every time. Anything null/blank/empty is left out entirely - an expected.json
   full of nulls is unreadable and hides the values that matter. */
const ROW_FIELDS = [
  'club', 'shotNumber', 'hitAt',
  'carryDistance', 'totalDistance', 'offlineDistance', 'side',
  'ballSpeed', 'clubSpeed', 'launchAngle',
  'spin', 'backspin', 'sideSpin', 'totalSpin', 'spinAxis',
  'faceAngle', 'pathAngle', 'faceToPath', 'startDirection', 'curve', 'targetLine',
  'status', 'errors', 'warnings', 'unknownFields', 'derivedMetrics'
];

function isEmpty(value) {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function projectRow(row) {
  const out = {};
  ROW_FIELDS.forEach((field) => {
    if (!isEmpty(row[field])) out[field] = row[field];
  });
  return out;
}

function projectParse(parsed) {
  return {
    delimiter: parsed.delimiter === '\t' ? '\\t' : parsed.delimiter,
    hasHeader: !!parsed.hasHeader,
    headers: parsed.headers || [],
    warnings: parsed.warnings || [],
    unitSystem: parsed.unitSystem,
    unitSource: parsed.unitSource || '',
    unitHints: parsed.unitHints || {},
    provider: parsed.provider || '',
    sessionDate: parsed.sessionDate,
    sessionDateSource: parsed.sessionDateSource || ''
  };
}

function projectBatch(batch) {
  return {
    rowCount: batch.rowCount,
    validCount: batch.validCount,
    invalidCount: batch.invalidCount,
    unitSystem: batch.unitSystem,
    sessionDate: batch.sessionDate,
    provider: batch.provider || '',
    gateStatus: parser.batchGateStatus(batch),
    provenanceGaps: parser.batchProvenanceGaps(batch)
  };
}

function runCase(name, expected) {
  const text = fs.readFileSync(path.join(CASES_DIR, name, 'input.csv'), 'utf8');
  const options = Object.assign({ sourceType: 'email_csv' }, expected.options || {});
  const parsed = parser.parsePracticeImportText(text, options);
  const built = parser.createPracticeImportBatch(parsed.rows, {
    sourceType: options.sourceType,
    sourceName: options.sourceName || '',
    unitSystem: parsed.unitSystem,
    unitSource: parsed.unitSource,
    sessionDate: parsed.sessionDate,
    sessionDateSource: parsed.sessionDateSource,
    provider: parsed.provider
  }, SCOPE);
  return {
    parse: projectParse(parsed),
    batch: projectBatch(built.batch),
    rows: built.rows.map(projectRow)
  };
}

/* Readable diff: every leaf that differs, by path. Enough to fix the parser or
   the fixture without opening a JSON viewer. */
function diff(expected, actual, base, out) {
  base = base || '';
  out = out || [];
  const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let i = 0; i < length; i += 1) diff(expected[i], actual[i], base + '[' + i + ']', out);
    return out;
  }
  if (isObject(expected) && isObject(actual)) {
    const keys = Array.from(new Set(Object.keys(expected).concat(Object.keys(actual))));
    keys.forEach((key) => diff(expected[key], actual[key], base ? base + '.' + key : key, out));
    return out;
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    out.push('    ' + (base || '(root)') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
  return out;
}

function caseNames() {
  if (!fs.existsSync(CASES_DIR)) return [];
  return fs.readdirSync(CASES_DIR)
    .filter((name) => fs.existsSync(path.join(CASES_DIR, name, 'expected.json')))
    .filter((name) => !ONLY || name.indexOf(ONLY) !== -1)
    .sort();
}

const names = caseNames();
if (!names.length) {
  console.error('No fixtures found in ' + path.relative(ROOT, CASES_DIR));
  process.exitCode = 1;
  return;
}

let failures = 0;
let pendingGaps = 0;
const pendingFixed = [];

names.forEach((name) => {
  const file = path.join(CASES_DIR, name, 'expected.json');
  const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
  let actual;
  try {
    actual = runCase(name, expected);
  } catch (error) {
    console.error('FAIL: ' + name + ' threw ' + (error && error.message));
    failures += 1;
    return;
  }

  if (UPDATE && !expected.pending) {
    fs.writeFileSync(file, JSON.stringify(Object.assign({}, expected, actual), null, 2) + '\n');
    console.log('upd -', name);
    return;
  }

  const differences = []
    .concat(diff(expected.parse || {}, actual.parse, 'parse'))
    .concat(diff(expected.batch || {}, actual.batch, 'batch'))
    .concat(diff(expected.rows || [], actual.rows, 'rows'));

  if (expected.pending) {
    if (!differences.length) {
      pendingFixed.push(name);
      console.error('FIXED: ' + name + ' now matches - remove "pending" from its expected.json');
      console.error('       (was: ' + expected.pending + ')');
      failures += 1;
    } else {
      pendingGaps += 1;
      console.log('gap -', name, '-', expected.pending);
    }
    return;
  }

  if (differences.length) {
    failures += 1;
    console.error('FAIL: ' + name + ' - ' + expected.why);
    differences.slice(0, 12).forEach((line) => console.error(line));
    if (differences.length > 12) console.error('    ...and ' + (differences.length - 12) + ' more');
  } else {
    console.log('ok  -', name);
  }
});

if (UPDATE) {
  console.log('\nexpected.json rewritten from current behaviour - read the diff before committing');
} else {
  console.log(
    '\n' + (names.length - pendingGaps - pendingFixed.length) + ' asserted, ' +
    pendingGaps + ' known gaps, ' + failures + ' failing'
  );
}
process.exitCode = failures ? 1 : 0;
