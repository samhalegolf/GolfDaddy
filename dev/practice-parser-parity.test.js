// The practice parser is one file (scripts/gd-practice-parser-core.js) loaded
// two ways: by the browser via index.html, and by the import function via
// functions/practice-data-parser.js. It used to be two hand-maintained copies,
// which drifted. This test is what stops that happening again - it runs both
// bindings over the same fixtures and asserts they agree row for row.
//
// It also covers the browser-only half (store, gate input, soft delete), since
// nothing else did.
//
// Run: node dev/practice-parser-parity.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('ok  -', msg);
  } else {
    console.error('FAIL:', msg);
    failures += 1;
  }
}

// ---- The two bindings ----

const server = require(path.join(ROOT, 'functions', 'practice-data-parser.js'));

function loadBrowser() {
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
  win.Date = Date; win.Math = Math; win.JSON = JSON; win.Number = Number;
  win.Object = Object; win.Array = Array; win.String = String; win.Promise = Promise;
  win.RegExp = RegExp; win.Error = Error;

  const ctx = vm.createContext(win);
  const load = (file) => vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
  load('scripts/gd-practice-parser-core.js');
  load('scripts/gd-native-practice-data.js');
  win.ClaritySession = { get: () => ({ viewedProfileId: 'player-1', accountName: 'Sam', accountId: 'acct-1' }) };
  return win;
}

// ---- Fixtures: one per parser branch ----

const FIXTURES = [
  { name: 'header csv', text: 'Club,Carry,Total,Offline,Face,Path,Start\n7 Iron,142,151,-6,1.2,3.1,0.8\nPW,118,121,3,-0.4,1.0,-0.2' },
  { name: 'headerless defaults', text: '7i,142,151,-6,1.2,3.1,0.8\n8i,132,140,2,0.1,2.0,0.4' },
  { name: 'tab delimited', text: 'Club\tCarry\tTotal\tOffline\n3W\t205\t228\t11\nDriver\t248\t272\t-14' },
  { name: 'semicolon delimited', text: 'Club;Carry;Total;Offline\n9i;125;131;4' },
  { name: 'quoted commas', text: 'Club,Carry,Notes\n"7 Iron","142","struck well, slight draw"' },
  { name: 'unknown headers fall back to positional', text: 'alpha,beta,gamma,delta\n7i,142,151,-6' },
  { name: 'explicit side column', text: 'Club,Carry,Offline,Side\n7i,142,6,left\n7i,140,-6,right' },
  { name: 'spin axis derived from components', text: 'Club,Carry,Total,SideSpin,Backspin\n7i,142,151,-420,6200' },
  { name: 'spin axis from total spin', text: 'Club,Carry,Side Spin,Total Spin\n7i,142,300,5400' },
  { name: 'spin axis supplied, not derived', text: 'Club,Carry,SideSpin,Backspin,Spin Axis\n7i,142,-420,6200,-3.9' },
  { name: 'invalid numeric cell', text: 'Club,Carry,Total\n7i,abc,151' },
  { name: 'missing club and distance', text: 'Club,Carry,Total\n,,\n,142,151' },
  { name: 'extra trailing columns', text: 'Club,Carry,Total\n7i,142,151,extra1,extra2' },
  { name: 'club inferred from first column', text: 'Carry,Total\n7i,142' },
  { name: 'thousands separators', text: 'Club,Carry,Backspin,Side Spin\n7i,142,"6,200",-420' },
  { name: 'duplicate headers', text: 'Club,Carry,Carry\n7i,142,143' },
  { name: 'parenthesised units in headers', text: 'Club,Carry (m),Total (m),Offline (m)\n7i,142,151,-6' },
  { name: 'L/R marker column', text: 'Club,Carry,L/R\n7i,142,-6' },
  { name: 'blank input', text: '   \n\n  ' },
  { name: 'headers forced off', text: 'Club,Carry,Total\n7i,142,151', opts: { headers: false } },
  { name: 'headers forced on', text: '7i,142,151\n8i,132,140', opts: { headers: true } },
  { name: 'metric headers', text: 'Club,Carry (m),Total (m)\n7i,142,151' },
  { name: 'imperial headers', text: 'Club,Carry (yds),Total (yds)\n7i,155,165' },
  { name: 'dated shots', text: 'Date,Club,Carry (m)\n2026-07-28T14:03,7i,142\n2026-07-28T14:07,7i,140' }
];

// Ids and timestamps are generated per call; mask them so a diff means a real
// behaviour difference.
function mask(value) {
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach((key) => {
      const v = value[key];
      if (/^(shotId|sessionId|importBatchId|importId)$/.test(key) && typeof v === 'string' && v) {
        out[key] = v.replace(/^(practice-[a-z]+)-.*$/, '$1-<id>');
      } else if (/At$/.test(key) && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
        out[key] = '<iso>';
      } else {
        out[key] = mask(v);
      }
    });
    return out;
  }
  return value;
}

const win = loadBrowser();
const client = win.GolfDaddyNativePracticeData;
const SCOPE = { playerId: 'player-1', playerName: 'Sam', accountId: 'acct-1' };

FIXTURES.forEach((fixture) => {
  const opts = Object.assign({ sourceType: 'email_csv', sourceName: 'shots.csv' }, fixture.opts || {});
  const fromServer = server.parsePracticeImportText(fixture.text, opts);
  const fromClient = client.parsePracticeImportText(fixture.text, opts);
  assert(
    JSON.stringify(mask(fromServer)) === JSON.stringify(mask(fromClient)),
    'parse agrees: ' + fixture.name
  );

  const source = { sourceType: 'email_csv', sourceName: 'shots.csv' };
  const serverRows = mask(server.createPracticeImportBatch(fromServer.rows, source, SCOPE).rows);
  const clientRows = mask(client.createPracticeImportBatch(fromClient.rows, source).rows);
  assert(
    JSON.stringify(serverRows) === JSON.stringify(clientRows),
    'normalised shots agree: ' + fixture.name
  );
});

// ---- Sign convention (spec §9.2): negative offline is left, everywhere ----

const signed = server.parsePracticeImportText('Club,Carry,Offline\n7i,142,-6\n7i,142,6', {});
const signedRows = server.createPracticeImportBatch(signed.rows, {}, SCOPE).rows;
assert(signedRows[0].side === 'left' && signedRows[0].offlineDistance === -6, 'negative offline is labelled left');
assert(signedRows[1].side === 'right' && signedRows[1].offlineDistance === 6, 'positive offline is labelled right');

const labelled = server.parsePracticeImportText('Club,Carry,Offline,Side\n7i,142,6,left', {});
const labelledRows = server.createPracticeImportBatch(labelled.rows, {}, SCOPE).rows;
assert(labelledRows[0].side === 'left', 'explicit side column wins over the sign');
assert(labelledRows[0].offlineDistance === 6, 'explicit side does NOT rewrite the stored sign (spec §9.2 gap)');

// ---- Unit system: read where stated, recorded where not, never guessed
//      (spec §2a, §9.1). Missing provenance does not hold up an import - it is
//      the metric layer and the report's coverage footer that act on it. ----

function parseBatch(text, opts, source) {
  const parsed = server.parsePracticeImportText(text, opts || {});
  const built = server.createPracticeImportBatch(parsed.rows, Object.assign({
    unitSystem: parsed.unitSystem,
    unitSource: parsed.unitSource,
    sessionDate: parsed.sessionDate,
    sessionDateSource: parsed.sessionDateSource,
    provider: parsed.provider
  }, source || {}), SCOPE);
  return { parsed, batch: built.batch, rows: built.rows };
}

const metric = parseBatch('Club,Carry (m),Total (m),Offline (m)\n7i,142,151,-6');
assert(metric.parsed.unitSystem === 'metric', 'metric headers declare a metric batch');
assert(metric.parsed.unitSource === 'header', 'the declaration is attributed to the header');
assert(metric.batch.unitSystem === 'metric', 'unit system reaches the batch');
assert(server.batchGateStatus(metric.batch) === 'staged', 'a declared batch stages');

const imperial = parseBatch('Club,Carry (yds),Total [yards]\n7i,155,165');
assert(imperial.parsed.unitSystem === 'imperial', 'yard headers declare an imperial batch');

assert(
  server.parsePracticeImportText('Club,Carry Distance (y),Total\n7i,155,165', {}).unitSystem === 'imperial',
  'a unit baked into the field name is read, not flattened away'
);
assert(
  server.parsePracticeImportText('Club,CarryM,TotalM\n7i,142,151', {}).unitSystem === 'metric',
  'the carrym/totalm aliases declare metric'
);
assert(
  server.parsePracticeImportText('Club,Carry_yards,Total_yards\n7i,155,165', {}).unitSystem === 'imperial',
  'a trailing underscore unit is read'
);

const silent = parseBatch('Club,Carry,Total,Offline\n7i,142,151,-6');
assert(silent.parsed.unitSystem === null, 'silent headers do NOT get a guessed unit');
assert(silent.parsed.warnings.includes('unit_system_undeclared'), 'the undeclared unit is warned about');
assert(silent.batch.validCount === 1, 'the rows still parse');
assert(server.batchGateStatus(silent.batch) === 'staged', 'an unlabelled source still stages - it is not held up');
assert(
  server.batchProvenanceGaps(silent.batch).includes('unit_system_undeclared'),
  'but the batch records that its unit is unknown'
);
assert(silent.batch.unitSystem === null, 'and unit_system stays null rather than being filled with a default');

// 142 is a plausible metre carry and a plausible yard carry. Magnitude must
// never be used to break the tie - that is the whole point of holding.
const bigNumbers = server.parsePracticeImportText('Club,Carry,Total\nDriver,275,301', {});
assert(bigNumbers.unitSystem === null, 'large distances are not treated as evidence of yards');

const conflict = server.parsePracticeImportText('Club,Carry (m),Total (yds)\n7i,142,165', {});
assert(conflict.unitSystem === null, 'disagreeing distance headers declare nothing');
assert(conflict.warnings.includes('unit_system_conflict'), 'the conflict is warned about');

// Mixed conventions across DIFFERENT kinds are normal and must not read as a
// conflict: monitors report carry in metres and apex in feet all the time.
const mixedKinds = server.parsePracticeImportText('Club,Carry (m),Ball Speed (mph)\n7i,142,118', {});
assert(mixedKinds.unitSystem === 'metric', 'a speed unit does not overrule the distance unit');
assert(mixedKinds.unitHints.ballSpeed === 'mph', 'the speed unit is still recorded as a hint');

const overridden = server.parsePracticeImportText('Club,Carry,Total\n7i,142,151', { unitSystem: 'imperial' });
assert(overridden.unitSystem === 'imperial', 'a caller declaration supplies what the headers omit');
assert(overridden.unitSource === 'declared', 'a caller declaration is attributed as such');

const headerless = server.parsePracticeImportText('7i,142,151,-6', {});
assert(headerless.unitSystem === null, 'a headerless file has nothing to read a unit from');

// ---- Session date: unambiguous forms only (spec §2a) ----

const dated = parseBatch('Date,Club,Carry (m)\n2026-07-28T14:07,7i,140\n2026-07-28T14:03,7i,142');
assert(dated.parsed.sessionDate === '2026-07-28', 'the session is dated from its shots');
assert(dated.parsed.sessionDateSource === 'shot_times', 'the date source is recorded');
assert(dated.rows[0].hitAt === '2026-07-28T14:07:00', 'each shot keeps its own time');
assert(dated.batch.sessionDate === '2026-07-28', 'the session date reaches the batch');

const ambiguous = server.parsePracticeImportText('Date,Club,Carry (m)\n07/08/2026,7i,142', {});
assert(ambiguous.sessionDate === null, 'DD/MM vs MM/DD is refused rather than guessed');
assert(
  (ambiguous.rows[0].warnings || []).includes('Unrecognised shot time format'),
  'the unparsed date is warned about'
);
assert(ambiguous.rows[0].hitAt === '07/08/2026', 'the original date text is kept as evidence');

const undated = parseBatch('Club,Carry (m)\n7i,142');
assert(undated.batch.sessionDate === null, 'an undated batch stays undated');
assert(server.batchGateStatus(undated.batch) === 'staged', 'a missing date does not block staging');
assert(
  server.batchProvenanceGaps(undated.batch).includes('session_date_unknown'),
  'but the missing date is reported'
);

// The only thing that holds an import back is an import that did not work.
const noRows = server.createPracticeImportBatch(
  server.parsePracticeImportText('Club,Carry\n,', {}).rows, {}, SCOPE
);
assert(server.batchGateStatus(noRows.batch) === 'needs_review', 'a batch with no valid rows is held');
assert(
  server.batchProvenanceGaps(noRows.batch).includes('no_valid_rows'),
  'and says so'
);

// A wholly unlabelled source - no unit, no date, no recognisable monitor -
// still stages. It just carries three gaps for the engine to read.
const unlabelled = parseBatch('Club,Carry,Total\n7i,142,151', { sourceName: 'export.csv' });
assert(server.batchGateStatus(unlabelled.batch) === 'staged', 'an entirely unlabelled source stages');
assert(
  server.batchProvenanceGaps(unlabelled.batch).join(',') === 'unit_system_undeclared,session_date_unknown,provider_unknown',
  'and reports all three gaps for the coverage footer'
);

// ---- Provider ----

assert(
  server.parsePracticeImportText('Club,Carry (m)\n7i,142', { sourceName: 'trackman-export-jul.csv' }).provider === 'trackman',
  'the provider is read from the file name'
);
assert(
  server.parsePracticeImportText('Club,Carry (m)\n7i,142', { providerHint: 'Your GCQuad session' }).provider === 'foresight',
  'the provider is read from a caller hint'
);
assert(
  server.parsePracticeImportText('Club,Carry (m)\n7i,142', { sourceName: 'shots.csv' }).provider === '',
  'an unrecognised source leaves the provider unknown rather than guessing one'
);

// ---- Distance validation: a missing distance is not a zero distance ----

const carryOnly = server.createPracticeImportBatch(
  server.parsePracticeImportText('Club,Carry (m)\n7i,142', {}).rows, {}, SCOPE
);
assert(carryOnly.batch.validCount === 1, 'a carry-only row is valid (no total is not a zero total)');
assert(carryOnly.rows[0].errors.length === 0, 'a carry-only row carries no errors');

const totalOnly = server.createPracticeImportBatch(
  server.parsePracticeImportText('Club,Total (m)\n7i,151', {}).rows, {}, SCOPE
);
assert(totalOnly.batch.validCount === 1, 'a total-only row is valid');

const zeroCarry = server.validateNativePracticeShot({ club: '7i', carryDistance: 0, totalDistance: 151 });
assert(zeroCarry.errors.includes('invalid_carry_distance'), 'an actual zero carry is still invalid');

const noDistance = server.validateNativePracticeShot({ club: '7i' });
assert(noDistance.errors.includes('missing_distance'), 'no distance at all reports missing_distance');
assert(!noDistance.errors.includes('invalid_total_distance'), 'and not a misleading invalid_total_distance');

// ---- Server envelope stays the shape practice-email-intake.js persists ----

const built = server.createPracticeImportBatch(
  server.parsePracticeImportText('Club,Carry,Total\n7i,142,151\n8i,abc,140', {}).rows,
  { sourceType: 'email_csv', sourceName: 'shots.csv' },
  SCOPE
);
assert(built.batch.rowCount === 2, 'batch counts every row');
assert(built.batch.validCount === 1 && built.batch.invalidCount === 1, 'batch splits valid from invalid');
assert(built.session.playerId === 'player-1' && built.session.shotCount === 2, 'session carries player scope');
assert(built.rows[0].schemaVersion === server.SCHEMA_VERSION, 'rows are stamped with the schema version');
assert(/^practice-shot-/.test(built.rows[0].shotId), 'server ids use the practice-shot prefix');

// ---- Browser-only half: store, gate input, soft delete ----

const parsed = client.parsePracticeImportText('Club,Carry,Total,Offline\n7i,142,151,-6\nPW,118,121,3', {});
const batchPayload = client.createPracticeImportBatch(parsed.rows, { sourceType: 'text', rawText: 'x' });
assert(batchPayload.batch.status === 'active', 'browser batch carries a local record status');
assert(batchPayload.batch.importId === batchPayload.batch.importBatchId, 'browser batch keeps the legacy importId key');
assert(batchPayload.batch.rawText === 'x', 'browser batch keeps the raw text for re-parsing');
assert(batchPayload.session.status === 'active', 'browser session carries a local record status');

const saved = client.saveNativePracticeShots(batchPayload);
assert(saved.savedCount === 2 && saved.rejectedCount === 0, 'valid shots are stored');
assert(client.loadNativePracticeShots({}).length === 2, 'stored shots load back');

const gate = client.buildPracticeGateInput(batchPayload.session.sessionId, {});
assert(gate.accepted.length === 2, 'gate input accepts both shots');
assert(gate.accepted[0].lateralM === -6, 'gate input keeps the signed lateral value');
assert(Math.abs(gate.accepted[0].normalizedDeg + 2.42) < 0.05, 'gate input derives a signed offline angle');

const deleted = client.deletePracticeImport(batchPayload.batch.importBatchId, { deletedBy: 'test' });
assert(deleted.deletedImports === 1 && deleted.deletedRows === 2, 'soft delete marks the batch and its rows');
assert(client.loadNativePracticeShots({}).length === 0, 'soft-deleted shots stop loading');

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exitCode = failures ? 1 : 0;
