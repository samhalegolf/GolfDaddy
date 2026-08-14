/* The Studio read view of practice email intake.
 *
 * Two things are worth pinning here. First, the shaping: Studio renders what
 * this function returns, so if metadata stops being unpacked the page silently
 * shows blanks rather than failing. Second, the wiring: a page that is written
 * but not registered, not loaded by index.html, or not routed by netlify.toml
 * is invisible in exactly the way nobody notices until they go looking for it.
 *
 * Run: node dev/practice-email-admin.test.js */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const admin = require(path.join(ROOT, 'functions', 'practice-email-admin.js'));
const { batchView, eventView, clampLimit } = admin.__testables;

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('ok  -', msg);
  else { console.error('FAIL:', msg); failures += 1; }
}

// ---- the limit ----

assert(clampLimit(undefined) === 25, 'no limit asked for means twenty five');
assert(clampLimit('50') === 50, 'a number in the query string is honoured');
assert(clampLimit('99999') === 200, 'and capped, so one request cannot pull the whole table');
assert(clampLimit('0') === 1 && clampLimit('-4') === 1, 'a nonsense limit still returns something');

// ---- the batch shape ----

const batch = batchView({
  import_batch_id: 'b1', intake_id: 'i1', created_at: '2026-08-14T03:19:35Z',
  source_type: 'email_csv', source_name: 'trackman.csv', status: 'staged',
  row_count: 42, valid_count: 42, invalid_count: 0,
  provider: 'trackman', unit_system: 'metric', session_date: null,
  metadata: {
    unitSource: 'header', warnings: ['preamble_skipped'], parseErrors: [],
    senderVerified: true, photos: []
  }
});

assert(batch.rowCount === 42 && batch.validCount === 42, 'the counts survive as numbers');
assert(batch.provider === 'trackman', 'the detected provider is carried');
assert(batch.unitSystem === 'metric' && batch.unitSource === 'header',
  'and the unit system with where it came from - a metric file and a guess are not the same claim');
assert(batch.warnings.length === 1 && batch.warnings[0] === 'preamble_skipped',
  'warnings are unpacked out of metadata rather than left as raw json for the page to dig through');
assert(batch.photoCount === 0, 'no photos means zero, not undefined');

const missing = batchView({ metadata: null });
assert(Array.isArray(missing.warnings) && Array.isArray(missing.parseErrors),
  'a batch with no metadata still yields arrays, so the page never guards for null');

// ---- the event shape ----

const event = eventView({
  intake_id: 'i1', created_at: '2026-08-14T03:19:34Z', status: 'staged',
  sender_email: 'sam@example.com', recipient_email: 'samhale@claritygolf.app',
  player_key: 'player41', subject: '', sender_verified: false,
  routing_json: { errors: ['photo could not be stored'], unsupported: [{}, {}] }
}, [batch]);

assert(event.senderVerified === false, 'an unapproved sender is reported as such');
assert(event.errors.length === 1, 'routing errors are surfaced - this is the "it landed and did nothing" case');
assert(event.unsupportedCount === 2, 'unsupported attachments are counted');
assert(event.batches.length === 1, 'batches hang off their event');

const bare = eventView({ intake_id: 'i2', routing_json: null }, []);
assert(bare.errors.length === 0 && bare.unsupportedCount === 0 && bare.batches.length === 0,
  'an event with no routing json and no batches is still a complete row');

// ---- the wiring ----

const registrySource = fs.readFileSync(path.join(ROOT, 'scripts/studio/studio-registry.js'), 'utf8');
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(registrySource, ctx);
const registry = ctx.window.GDStudioRegistry;
const record = registry.get('practice-email');

assert(!!record, 'the page has a registry record');
assert(record && record.parent === 'shot-system', 'it sits under Shot System');
assert(record && record.status === 'implemented', 'and is marked implemented, not a placeholder');
assert(record && record.runtime && record.runtime.app === false,
  'it is not an app surface - there is no app screen for this, which is why the page exists');

const navTree = typeof registry.navTree === 'function' ? registry.navTree() : registry.navTree;
const shotSystem = navTree.find(function (group) { return group.id === 'shot-system'; });
assert(shotSystem && shotSystem.children.indexOf('practice-email') !== -1,
  'and it is in the sidebar, not only reachable from the group index');

record.code.forEach(function (entry) {
  assert(fs.existsSync(path.join(ROOT, entry.path)), 'registry code path exists: ' + entry.path);
});

const pageSource = fs.readFileSync(
  path.join(ROOT, 'scripts/studio/shot-system/practice-email/practice-email-page.js'), 'utf8');
assert(/window\.GDStudioPages\["practice-email"\]/.test(pageSource),
  'the page registers itself under the same id the registry uses - the shell matches them exactly');
assert(!/fetch\(\s*["'][^"']*supabase/i.test(pageSource),
  'the page does not reach for Supabase directly - those tables are service-role only');
assert(/Authorization["']?\s*:\s*["']Bearer/.test(pageSource),
  'it sends the signed-in admin token');

const indexSource = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const tag = /<script data-gd-surface="studio" src="scripts\/studio\/shot-system\/practice-email\/practice-email-page\.js/;
assert(tag.test(indexSource), 'index.html loads the page');
assert(indexSource.indexOf('practice-email/practice-email-page.js')
  < indexSource.indexOf('studio/studio-shell.js'),
  'and loads it before the shell, which is what reads GDStudioPages');

const netlify = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
assert(/from = "\/api\/practice-email-admin"/.test(netlify), 'netlify routes /api/practice-email-admin');

// ---- read-only ----

const adminSource = fs.readFileSync(path.join(ROOT, 'functions/practice-email-admin.js'), 'utf8');
assert(!/method:\s*["'](POST|PATCH|PUT|DELETE)["']/.test(adminSource),
  'the function never writes - every Supabase call is a GET');
assert(/if \(event\.httpMethod !== "GET"\) return json\(405/.test(adminSource),
  'and refuses anything but GET');
assert(/caller\.isAdmin/.test(adminSource), 'admin permission is required, not merely staff');

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exit(failures ? 1 : 0);
