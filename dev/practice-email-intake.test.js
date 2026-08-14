// Practice email: what the address looks like, and who is allowed to send to it.
//
// The address used to be practice+<slugged uuid>@domain - unreadable, and
// derived rather than stored, so it could never be changed or revoked. Making
// it readable makes it guessable, which moves the protection from "nobody can
// find this address" to "only senders you have approved can use it". These are
// the two halves of that trade, held in place.
//
// Run: node dev/practice-email-intake.test.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const intake = require(path.join(ROOT, 'functions', 'practice-email-intake.js')).__testables;

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('ok  -', msg);
  else { console.error('FAIL:', msg); failures += 1; }
}

// ---- the address a person can read out ----

assert(intake.preferredLocalPart({ name: 'Sam Hale' }) === 'samhale', 'a name becomes a plain local part');
assert(intake.preferredLocalPart({ name: "Seve Ballesteros-O'Brien" }) === 'seveballesterosobrien', 'punctuation and apostrophes are dropped, not encoded');
assert(intake.preferredLocalPart({ email: 'samhalegolf@gmail.com' }) === 'samhalegolf', 'with no name, the email local part is used');
assert(intake.preferredLocalPart({ name: 'Sam Hale', email: 'other@x.com' }) === 'samhale', 'the name wins over the email');
assert(intake.preferredLocalPart({ name: 'Jo' }) === 'jo', 'a short name is used as it is - a second Jo becomes jo2, which is what the collision check is for');
assert(intake.preferredLocalPart({}) === 'player', 'with nothing at all to go on it still returns something sendable');
assert(
  intake.preferredLocalPart({ name: 'Sam Hale' }).length <= 24,
  'the local part is bounded, so a long name cannot produce an unusable address'
);
assert(
  !/[+._-]/.test(intake.preferredLocalPart({ name: 'Sam Hale' })),
  'no plus, dot, underscore or hyphen - the characters that get mangled when read aloud or retyped'
);
assert(
  intake.preferredLocalPart({ profileId: '8f3c9a2e-4d1b-4c77-9f0e-2b1a5c6d7e8f' }).length <= 24,
  'even with only a uuid to work from, the result stays short'
);

// ---- the domain ----

assert(intake.intakeDomain() === 'claritygolf.app', 'practice mail lands on claritygolf.app by default');
assert(
  /CLARITY_PRACTICE_EMAIL_DOMAIN/.test(fs.readFileSync(path.join(ROOT, 'functions/practice-email-intake.js'), 'utf8')),
  'and an env var still overrides it, so a deploy can move it without a code change'
);

// ---- the legacy address keeps working ----

const legacy = intake.practiceEmailAddress({ profileId: 'player-1' });
assert(/^practice\+/.test(legacy), 'the derived legacy form is still produced for a store-less deployment');
assert(
  intake.playerKeyFromRecipients(['practice+player-1@' + intake.intakeDomain()]) === 'player-1',
  'and mail addressed to a legacy address still resolves to its player'
);
assert(
  intake.playerKeyFromRecipients(['someone@example.com']) === '',
  'mail to an unrelated address resolves to nobody'
);

// ---- the app never invents an address ----
//
// Addresses are allocated and stored server-side, so the app cannot derive one.
// Showing a made-up practice+<id> address while offline would hand the player
// an address that receives nothing.
const lane0 = fs.readFileSync(path.join(ROOT, 'scripts/gd-route-audit.js'), 'utf8');
assert(
  !/practice\+\$\{owner\}@/.test(lane0),
  'the app no longer builds a local practice+<id> address'
);
assert(
  lane0.includes('GD_PRACTICE_EMAIL_UNKNOWN'),
  'it says the address is not fetched yet instead'
);
assert(
  /No address to copy yet/.test(lane0),
  'and copying a placeholder is refused rather than putting it on the clipboard'
);

// ---- who is allowed to send ----

const senders = [{ sender_email: 'coach@club.com' }, { sender_email: 'samhalegolf@gmail.com' }];
assert(intake.senderIsVerified(senders, 'coach@club.com'), 'a verified sender is recognised');
assert(intake.senderIsVerified(senders, 'Coach@Club.com'), 'sender matching ignores case');
assert(intake.senderIsVerified(senders, '  coach@club.com  '), 'and surrounding whitespace');
assert(!intake.senderIsVerified(senders, 'stranger@elsewhere.com'), 'an unknown sender is not verified');
assert(!intake.senderIsVerified(senders, ''), 'a missing sender is never treated as verified');
assert(!intake.senderIsVerified([], 'coach@club.com'), 'with no verified senders at all, nobody is verified');

// ---- what happens to mail from someone unapproved ----
//
// It is imported and flagged, not held. Holding a coach's export hostage until
// the player happens to open the app is worse than importing it with a mark on
// it: the data is theirs either way, and they can approve the sender once or
// delete the import.

const oneGoodBatch = {
  imports: [{ batch: { batch: { rowCount: 3, validCount: 3, invalidCount: 0 } } }],
  pendingPhotos: [],
  unsupported: [],
  errors: []
};
assert(intake.eventStatus(oneGoodBatch) === 'staged', 'a good import stages');
assert(
  intake.eventStatus({ imports: [], pendingPhotos: [{}], unsupported: [], errors: [] }) === 'pending_photo',
  'a photo goes to the photo lane'
);
assert(
  intake.eventStatus.length === 1,
  'the status no longer depends on who sent it - an unapproved sender does not change what happens to the data'
);

const source = fs.readFileSync(path.join(ROOT, 'functions/practice-email-intake.js'), 'utf8');
assert(!/quarantin/i.test(source), 'nothing is quarantined any more');
assert(
  /senderVerified: inbound\.senderVerified !== false/.test(source),
  'every batch records whether its sender was approved, which is what the flag is drawn from'
);
assert(
  source.includes('sender_verified: inbound.senderVerified !== false'),
  'and so does the intake event'
);
assert(
  source.includes('function clearSenderFlagFor'),
  'approving a sender clears the flag on what they already sent'
);

const lane = fs.readFileSync(path.join(ROOT, 'scripts/gd-route-audit.js'), 'utf8');
assert(
  lane.includes('batch.metadata?.senderVerified===false'),
  'the email lane marks an import from an unapproved sender'
);
assert(
  lane.includes('gdPracticeApproveEmailSender'),
  'and offers to approve that sender in one tap'
);
assert(
  !/quarantin/i.test(lane),
  'the lane no longer has a held state to render'
);

// ---- routing is unchanged: this job did not touch it ----

assert(intake.laneForAttachment({ filename: 'shots.csv' }).lane === 'email_csv', 'csv attachments still take the CSV pathway');
assert(intake.laneForAttachment({ filename: 'table.jpg' }).lane === 'email_photo', 'images still take the photo pathway');
assert(intake.laneForAttachment({ filename: 'session.json' }).lane === 'email_json', 'json still takes the structured pathway');
assert(intake.laneForAttachment({ filename: 'notes.pdf' }).lane === 'unsupported', 'anything else is unsupported rather than guessed at');
assert(
  intake.looksLikeCsvBody('Club,Carry,Total\n7 Iron,142,151'),
  'a CSV pasted into the email body is still detected'
);

// ---- the migration exists and matches what the code writes ----

const migration = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260814_practice_email_addresses.sql'),
  'utf8'
);
['practice_email_addresses', 'practice_email_senders'].forEach((table) => {
  assert(migration.includes('create table if not exists public.' + table), 'the migration creates ' + table);
});
assert(
  migration.includes('sender_verified'),
  'and the column the intake stamps on every event'
);
assert(
  source.includes('verifiedUser'),
  'sender approval verifies a signed-in user rather than accepting the webhook secret'
);
assert(
  /action === "approve_sender"[\s\S]{0,600}verifiedUser/.test(source),
  'and it checks that identity before it changes anything'
);

// ---- an emailed CSV imports itself ----

/* The review step used to be the whole point of the lane. It was also
   unreachable: the Save button lives inside the manual paste drawer, which
   gdRenderPracticeImportPanel force-closes for anyone without the Admin tab
   expanded - and the Admin tab is hidden from players entirely. So an emailed
   CSV could be loaded and never saved. It imports on arrival now, and the
   approved-sender list is what makes that safe. */

assert(
  !lane.includes('gdPracticeLoadEmailBatch'),
  'the load-into-review button is gone - it opened a drawer players cannot see'
);
assert(
  lane.includes('function gdPracticeAutoImportEmailBatches'),
  'the lane imports qualifying batches itself'
);
assert(
  /gdPracticeAutoImportEmailBatches\(\)[\s\S]{0,200}gdRenderPracticeEmailLane\(\)/.test(lane),
  'and does it before the render, so the row never claims pending and then corrects itself'
);
assert(
  /function gdPracticeEmailBatchAutoImportable[\s\S]{0,400}senderVerified===false\)return false/.test(lane),
  'an unapproved sender is not imported - it stays flagged with an Approve button'
);
assert(
  /function gdPracticeEmailBatchAutoImportable[\s\S]{0,400}source_type==="email_photo"\)return false/.test(lane),
  'and a photo is not imported either, because nothing has read it yet'
);
assert(
  /function gdPracticeEmailBatchAutoImportable[\s\S]{0,400}!gdPracticeEmailBatchInLibrary/.test(lane),
  'a batch already in the library is not imported twice'
);
assert(
  /function gdPracticeEmailBatchInLibrary[\s\S]{0,500}getScopedStore/.test(lane),
  'and that check asks the library itself rather than keeping a second list of what was imported'
);
assert(
  /function gdPracticeEmailBatchInLibrary[\s\S]{0,600}\["sessions","captures","shots"\]/.test(lane),
  'checking every record type, including soft-deleted ones, so a deleted import does not come back'
);
assert(
  /function gdPracticeApproveEmailSender[\s\S]{0,2200}gdPracticeRefreshEmailLane\(\)/.test(lane),
  'approving a sender refreshes the lane, which is what pulls their held import in'
);
assert(
  /function gdPracticeEmailBatchToPreview/.test(lane)
  && /gdPracticeEmailBatchToPreview\(batch\)/.test(lane),
  'the row-to-preview mapping is one function, shared rather than written twice'
);
assert(
  /gdPracticeEmailBatchToPreview[\s\S]{0,900}unitSystem:batch\.unit_system/.test(lane),
  'and it still carries the unit system the server parsed, so an emailed yard file converts'
);

console.log(failures ? '\n' + failures + ' failing' : '\nall passing');
process.exitCode = failures ? 1 : 0;
