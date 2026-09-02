/*
 * Changing the email an account signs in with, as a coach or an admin.
 *
 * The email is the LOGIN, so a change is only correct when four things hold at
 * once, and each one is a bug someone can ship without noticing:
 *
 *   1. Privilege comes from the token, never the body. A coach may move a
 *      player they actually coach; only an admin may move an account that is
 *      not their player, and neither may move a coach or admin address - the
 *      address is the password-reset link, so moving one is a staff-privilege
 *      handover.
 *
 *   2. All three stores move together. Supabase Auth decides sign-in,
 *      app_accounts is what findAccountByEmail keys on, app_profiles is what
 *      the rosters read. Auth goes first because it is the one that can refuse,
 *      and if the account row then fails, Auth is put back.
 *
 *   3. The device does not push the old address back. account-sync writes
 *      whatever the phone holds on every startup, so without a guard the change
 *      survived exactly until the account holder next opened the app.
 *
 *   4. The account holder is told, at both addresses.
 *
 * Run: node dev/account-email-change.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const server = read("functions", "account-change-email.js");
const authUtils = read("functions", "auth-utils.js");
const sync = read("functions", "account-sync.js");
const cloudSync = read("scripts", "clarity-cloud-sync.js");
const client = read("scripts", "clarity-account-email.js");
const core = read("scripts", "gd-app-core.js");
const shell = read("scripts", "inline", "gd-auth-account-shell.js");
const indexHtml = read("index.html");
const netlify = read("netlify.toml");
const css = read("styles", "inline", "gd-app-base.css");

function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---------- 1. privilege ---------- */

test("the endpoint takes the caller from resolveCaller, never from the body", () => {
  const code = stripComments(server);
  assert.ok(/resolveCaller\(event/.test(code), "caller must be resolved from the request, not the payload");
  assert.ok(!/body\.(role|isAdmin|callerRole)/.test(code), "the body must not be able to name the caller's privilege");
  assert.ok(/caller\.isStaff/.test(code), "non-staff must be refused");
});

test("only the target and the new address are read from the body", () => {
  /* Scoped to the handler: `body` is also the name of every fetch response
     parsed in the email helpers above it, and those are not request input. */
  const code = stripComments(server).slice(stripComments(server).indexOf("exports.handler"));
  const bodyReads = (code.match(/body\.[a-zA-Z]+/g) || []).map(s => s.slice(5));
  const allowed = new Set(["targetAccountId", "accountId", "email", "actorAccountId"]);
  bodyReads.forEach(key => {
    assert.ok(allowed.has(key), "unexpected body field trusted by the endpoint: " + key);
  });
});

test("a coach may only move a player on their own roster, in either link direction", () => {
  const code = stripComments(server);
  assert.ok(/coachOwnsPlayer/.test(code), "coach ownership must be checked");
  assert.ok(/linked_player_ids/.test(code) && /linked_coach_ids/.test(code),
    "both link directions count, the same way coach-roster.js counts them");
  assert.ok(/not_your_player/.test(code), "an unlinked player must be refused with a distinct code");
});

test("only an admin may move a coach or admin address", () => {
  const code = stripComments(server);
  assert.ok(/isStaffRole\(targetRow\.role\)[\s\S]{0,40}!caller\.isAdmin/.test(code),
    "a coach must not be able to move a staff address - that is the reset link, and the privilege with it");
  assert.ok(/staff_target/.test(code));
});

test("nobody changes their own email through this endpoint", () => {
  const code = stripComments(server);
  assert.ok(/callerAccountId === targetAccountId/.test(code), "self-change must be refused");
  assert.ok(/self_change/.test(code));
  assert.ok(/Settings/.test(server), "the refusal has to say where self-service actually lives");
});

test("the client mirrors the same three refusals before spending a round trip", () => {
  const code = stripComments(core);
  const start = code.indexOf("async function gdStaffChangeAccountEmail");
  assert.ok(start !== -1, "gdStaffChangeAccountEmail must exist in gd-app-core.js");
  const body = code.slice(start, start + 2200);
  assert.ok(/gdAccountIsStaff\(actor\)/.test(body), "caller must be staff");
  assert.ok(/target\.accountId===actor\.accountId/.test(body), "self-change refused locally too");
  assert.ok(/gdAccountIsStaff\(target\)[\s\S]{0,60}!=='admin'/.test(body), "a coach must not move a staff address");
});

/* ---------- 2. the stores move together ---------- */

test("Supabase Auth is updated before any app row, and confirmed on the spot", () => {
  const code = stripComments(server);
  const authAt = code.indexOf("admin/users/");
  const accountsAt = code.indexOf("app_accounts?account_id=eq.");
  assert.ok(authAt !== -1 && accountsAt !== -1, "both writes must exist");
  assert.ok(authAt < accountsAt, "Auth is the store that can refuse, so it goes first");
  assert.ok(/email_confirm: true/.test(code),
    "without email_confirm GoTrue parks the change behind a link sent to an address the holder cannot read");
});

test("a failed account-row write puts the Auth email back rather than leaving a split account", () => {
  const code = stripComments(server);
  const at = code.indexOf("account_row_update_failed");
  assert.ok(at !== -1, "the failure must have its own code");
  const around = code.slice(Math.max(0, at - 1800), at + 400);
  assert.ok(/rolledBack/.test(around), "the rollback must run on this path");
  assert.ok(/JSON\.stringify\(\{ email: previousEmail/.test(around), "the rollback restores the previous address");
  assert.ok(/sendSystemAlert/.test(around), "a rollback that itself fails must alert - the split is then real");
});

test("the profile row and its profile_json copy both move", () => {
  const code = stripComments(server);
  assert.ok(/app_profiles\?profile_id=eq\./.test(code), "the profile row is patched");
  assert.ok(/profile_json/.test(code), "profile_json carries its own email copy and must move too");
});

test("metadata is merged, never replaced", () => {
  const code = stripComments(server);
  assert.ok(/Object\.assign\(\{\}, metadata,/.test(code),
    "a wholesale metadata write would drop severedCoachIds and resurrect cut coach links");
});

test("the change is audited in app_sync_events with who did it", () => {
  const code = stripComments(server);
  assert.ok(/account_email_changed/.test(code));
  assert.ok(/byAccountId/.test(code) && /byRole/.test(code), "the audit row must name the actor");
});

test("upsertAccount finds the account by auth_user_id first, so an email change cannot fork it", () => {
  const code = stripComments(authUtils);
  const start = code.indexOf("async function upsertAccount");
  assert.ok(start !== -1);
  const body = code.slice(start, start + 400);
  const byAuth = body.indexOf("findAccountByAuthUserId");
  const byEmail = body.indexOf("findAccountByEmail");
  assert.ok(byAuth !== -1, "auth_user_id is the identity that survives an address change");
  assert.ok(byAuth < byEmail, "email is the fallback, not the primary key");
});

/* ---------- 3. the device must not push the old address back ---------- */

test("account-sync writes the stored email, not the pushed one", () => {
  const code = stripComments(sync);
  assert.ok(/storedAccount\(accountId\)/.test(code), "the server's address has to be read before the write");
  assert.ok(/const effectiveEmail = stored\.email \|\| accountEmail/.test(code),
    "a stored address wins; the pushed one is only used when there is no row yet");
  assert.ok(!/\n      email: accountEmail,/.test(code),
    "no write may still use the pushed address");
  const writes = (code.match(/email: effectiveEmail,/g) || []).length;
  assert.ok(writes >= 2, "both app_accounts and app_profiles must use it, got " + writes);
});

test("a lookup failure falls back to the old behaviour rather than losing the sync", () => {
  const start = sync.indexOf("async function storedAccount");
  assert.ok(start !== -1);
  const body = sync.slice(start, start + 1200);
  /* The empty read stands in for BOTH halves of the row now: no stored address,
     so the pushed one is used, and no stored metadata, so the tombstone is not
     applied. Neither costs the caller their sync. */
  assert.ok(/catch \(_error\) \{[\s\S]*?return empty;/.test(body),
    "a failed read must return the empty row so the caller still syncs");
  assert.ok(/const empty = \{ email: "", metadata: \{\} \};/.test(body),
    "the empty read has to carry both halves");
});

test("account-sync echoes the stored address and the client adopts it", () => {
  assert.ok(/accountEmail: effectiveEmail/.test(stripComments(sync)), "the response carries the server's address");
  const code = stripComments(cloudSync);
  assert.ok(/function adoptServerEmail/.test(code), "the client needs a way to learn its login moved");
  assert.ok(/adoptCanonicalIds\(result\);\s*adoptServerEmail\(result\);/.test(code),
    "adoption must run on every successful sync, not only on a merge");
});

/* ---------- 4. the account holder is told ---------- */

test("both the new and the old address are emailed, naming the actor and their role", () => {
  const code = stripComments(server);
  assert.ok(/sendChangeEmail\(nextEmail/.test(code), "the new address is the new login and must be told");
  assert.ok(/sendChangeEmail\(previousEmail/.test(code),
    "a login moving without warning is indistinguishable from a takeover");
  assert.ok(/function actorLabel/.test(code), "the message has to name who did it");
  assert.ok(/roleLabel/.test(code), "and with what authority");
});

test("a mail failure never rolls the change back or fails the request", () => {
  const code = stripComments(server);
  const at = code.indexOf("notified.next = await sendChangeEmail");
  assert.ok(at !== -1);
  const around = code.slice(at - 200, at + 1400);
  assert.ok(/catch \(_error\) \{ notified\.next/.test(around), "a send failure is caught, not thrown");
  assert.ok(/notified/.test(code), "the response reports whether the holder was actually reached");
});

test("a record moved without a sign-in behind it is not reported as a login change", () => {
  const code = stripComments(shell);
  assert.ok(/result\.loginUpdated !== false/.test(code),
    "an account with no Supabase Auth user has no sign-in to move, and the coach must not be told otherwise");
  assert.ok(/no Clarity sign-in yet/.test(code));
});

test("the coach is told when the confirmation email did not go out", () => {
  const code = stripComments(shell);
  assert.ok(/notified\.next && notified\.next\.sent/.test(code), "the UI must read the send result");
  assert.ok(/could not be sent - tell them directly/.test(code),
    "a silent mail failure leaves the player with no idea their login moved");
});

/* ---------- wiring ---------- */

test("the endpoint is routed, shipped and reachable", () => {
  assert.ok(/from = "\/api\/account-change-email"/.test(netlify), "netlify.toml must route the endpoint");
  assert.ok(/to = "\/\.netlify\/functions\/account-change-email"/.test(netlify));
  assert.ok(/scripts\/clarity-account-email\.js/.test(indexHtml), "the client module must be loaded");
  assert.ok(/window\.ClarityAccountEmail = \{ change: change \}/.test(client));
  assert.ok(/changeAccountEmail:gdStaffChangeAccountEmail/.test(core),
    "the account API must expose it, or the shell cannot call it");
});

test("the client calls the server and waits, rather than writing locally first", () => {
  const code = stripComments(core);
  const start = code.indexOf("async function gdStaffChangeAccountEmail");
  const body = code.slice(start, start + 2200);
  const call = body.indexOf("ClarityAccountEmail.change");
  const write = body.indexOf("target.email=email");
  assert.ok(call !== -1 && write !== -1);
  assert.ok(call < write, "local state must not move until the server has accepted");
  assert.ok(/Authorization: "Bearer "/.test(client), "the request must carry the caller's token");
});

/* ---------- the two surfaces ---------- */

test("the coach>player view carries the control, and a managed profile does not", () => {
  const code = stripComments(shell);
  assert.ok(/function playerEmailPanel/.test(code));
  assert.ok(/\$\{managed \? '' : playerEmailPanel\(account, owner\)\}/.test(code),
    "a managed profile has no account and no login, so it gets no email control");
  assert.ok(/if \(!owner\) return '';/.test(code), "and the panel refuses to render without one");
});

test("the admin All Users row routes into the same control, not a second one", () => {
  const code = stripComments(shell);
  assert.ok(/gd67OpenEmailPanel\('\$\{esc\(item\.profileId\)\}','\$\{esc\(item\.accountId\)\}'\)/.test(code),
    "the admin row must open the user, not edit inline");
  assert.ok(/function openEmailPanelFor/.test(code));
  assert.ok(/adminViewProfile\(profileId\)/.test(code.slice(code.indexOf("function openEmailPanelFor"))),
    "it goes through the admin view route, which is where the admin check lives");
  assert.ok((code.match(/gd67ChangePlayerEmail\(/g) || []).length === 1,
    "one call site: the panel. Two would mean two implementations to keep honest");
});

test("the panel survives a re-render, which is how the admin route lands on it open", () => {
  const code = stripComments(shell);
  assert.ok(/let emailPanelAccountId/.test(code), "the open state must live outside the template");
  assert.ok(/emailPanelAccountId === owner\.accountId/.test(code));
});

test("the change is confirmed with the in-app dialog, never window.confirm", () => {
  const code = stripComments(shell);
  const start = code.indexOf("async function changePlayerEmail");
  assert.ok(start !== -1);
  const body = code.slice(start, code.indexOf("function openEmailPanelFor"));
  assert.ok(/window\.gdConfirmDialog/.test(body), "the change needs confirming - the old address stops working");
  assert.ok(!/[^.]\bconfirm\(/.test(body.replace(/gdConfirmDialog/g, "")),
    "window.confirm returns false instantly in the webview, which would make the button a silent no-op");
  assert.ok(/: false;\s*if \(!ok\) return;/.test(body),
    "no dialog must mean no change, never an approval by default");
});

test("the admin row's two actions do not collapse the roster grid", () => {
  assert.ok(/hasEmailAction/.test(css), "a third child needs a widened grid");
  assert.ok(/#gdProfileV67 \.gdProfileRosterRow\.hasEmailAction\{\s*grid-template-columns:minmax\(0,1fr\) auto auto;/.test(css));
  const narrow = css.slice(css.indexOf("@media(max-width:430px)"));
  assert.ok(/\.gdProfileRosterRow\.hasEmailAction\{grid-template-columns:1fr\}/.test(narrow),
    "the narrow override must repeat the class or it loses on specificity");
  assert.ok(/gdProfileRosterEmailAction/.test(css), "changing an email is not destructive and must not look it");
});

let failed = 0;
tests.forEach(({ name, fn }) => {
  try {
    fn();
    console.log("  ok   " + name);
  } catch (error) {
    failed += 1;
    console.log("  FAIL " + name);
    console.log("       " + (error && error.message));
  }
});
console.log("\n" + (tests.length - failed) + "/" + tests.length + " passed");
process.exit(failed ? 1 : 0);
