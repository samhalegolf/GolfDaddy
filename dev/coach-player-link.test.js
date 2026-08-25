/*
 * A coach opening a player must land on that player.
 *
 * The reported bug: a coach tapped a name in Players and got their OWN profile.
 * Three separate faults produced it, and each is pinned here because all three
 * are silent - nothing threw, and the app cheerfully toasted "Player profile
 * loaded" over the wrong person.
 *
 *   1. The roster came from coach.linkedPlayerIds alone. That field held the
 *      coach's own account id on live data, so the coach was a row in their own
 *      player list. It also ignored player.linkedCoachIds, so players who were
 *      only linked from their side never appeared at all.
 *
 *   2. gdAccountApplySession fell back to the coach's own profile whenever the
 *      viewed player's profile row was missing locally - which was the normal
 *      case, because nothing ever fetched a linked player's profile.
 *
 *   3. The coach's view of a player was the coach's own profile screen with the
 *      name swapped, so even a correct load read as "this is me".
 *
 * Run: node dev/coach-player-link.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const core = fs.readFileSync(path.join(ROOT, "scripts", "gd-app-core.js"), "utf8");
const rosterClient = fs.readFileSync(path.join(ROOT, "scripts", "clarity-coach-roster.js"), "utf8");
const rosterServer = fs.readFileSync(path.join(ROOT, "functions", "coach-roster.js"), "utf8");
const shell = fs.readFileSync(path.join(ROOT, "scripts", "inline", "gd-auth-account-shell.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const netlify = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");

function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

/* ---------- link derivation ----------
   The two link functions are lifted out of gd-app-core and run directly. The
   file is ~25k lines and drags the whole app in, so the alternative is not
   testing the one piece of logic the bug actually lived in. */

function extractFunction(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start !== -1, "could not find function " + name + " in gd-app-core.js");
  /* Walk the parameter list out first. A default like `opts={}` opens and
     closes a brace before the body ever starts, so counting braces from the
     function keyword returns an empty match and every assertion below passes
     vacuously. */
  let parens = 0;
  let i = start + ("function " + name).length;
  for (; i < source.length; i += 1) {
    if (source[i] === "(") parens += 1;
    else if (source[i] === ")") {
      parens -= 1;
      if (parens === 0) { i += 1; break; }
    }
  }
  const bodyStart = source.indexOf("{", i);
  assert.ok(bodyStart !== -1, "no body found for " + name);
  let depth = 0;
  for (let j = bodyStart; j < source.length; j += 1) {
    if (source[j] === "{") depth += 1;
    else if (source[j] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, j + 1);
    }
  }
  throw new Error("unterminated function " + name);
}

/* Arrays that came out of the vm realm are not `Array` here, so
   deepStrictEqual rejects them on prototype alone. */
function list(value) { return Array.prototype.slice.call(value || []); }

function linkSandbox(accounts, profiles) {
  const rows = profiles || accounts.map((a) => ({ id: a.profileId, accountId: a.accountId, name: a.name }));
  const sandbox = {
    console,
    GD_ACCOUNT_STATE: { accounts: accounts, activeId: null, viewingProfileId: null },
    GD_PROFILE_STATE: { profiles: rows, activeId: null },
    gdAccountById: (id) => accounts.find((a) => a.accountId === id) || null,
    gdAccountForProfile: (pid) => accounts.find((a) => a.profileId === pid) || null,
    gdProfileById: (pid) => rows.find((p) => p && p.id === pid) || null,
    gdCurrentAccount: () => null,
    gdAccountRole: (value) => {
      const raw = String(value || "player").toLowerCase();
      return raw === "admin" ? "admin" : raw === "coach" ? "coach" : "player";
    }
  };
  sandbox.gdAccountIsStaff = (account) => {
    const role = sandbox.gdAccountRole(account && account.role);
    return role === "admin" || role === "coach";
  };
  sandbox.gdAdminCanManageAllUsers = (account) => sandbox.gdAccountRole(account && account.role) === "admin";
  vm.createContext(sandbox);
  [
    "gdAccountPlayerLinkIds",
    "gdAccountLinkedPlayers",
    "gdAccountManagedProfiles",
    "gdAccountOwnsProfile",
    "gdAccountCanAccessProfile"
  ].forEach((name) => {
    vm.runInContext(extractFunction(core, name), sandbox);
  });
  return sandbox;
}

const COACH = { accountId: "acct_coach", profileId: "profile_coach", name: "Sam", role: "coach", linkedPlayerIds: [], linkedCoachIds: [] };

test("a coach is never in their own player list", () => {
  const coach = Object.assign({}, COACH, { linkedPlayerIds: ["acct_coach", "acct_p1"] });
  const p1 = { accountId: "acct_p1", profileId: "profile_p1", name: "Cullen", role: "player", linkedCoachIds: [] };
  const box = linkSandbox([coach, p1]);
  const players = list(box.gdAccountLinkedPlayers(coach));
  assert.deepStrictEqual(
    players.map((a) => a.accountId), ["acct_p1"],
    "the coach appeared in their own roster — tapping that row opens the coach's own profile, which is the reported bug"
  );
});

test("a link claimed only by the player still shows up", () => {
  const coach = Object.assign({}, COACH, { linkedPlayerIds: [] });
  const p1 = { accountId: "acct_p1", profileId: "profile_p1", name: "Roy", role: "player", linkedCoachIds: ["acct_coach"] };
  const box = linkSandbox([coach, p1]);
  assert.deepStrictEqual(
    list(box.gdAccountLinkedPlayers(coach)).map((a) => a.accountId), ["acct_p1"],
    "reverse-only links were ignored — five real players were invisible on live data because of this"
  );
});

test("ids with no account are dropped", () => {
  const coach = Object.assign({}, COACH, { linkedPlayerIds: ["acct_gone", "acct_p1"] });
  const p1 = { accountId: "acct_p1", profileId: "profile_p1", role: "player", linkedCoachIds: [] };
  const box = linkSandbox([coach, p1]);
  assert.deepStrictEqual(list(box.gdAccountLinkedPlayers(coach)).map((a) => a.accountId), ["acct_p1"]);
});

test("another coach is not somebody's player", () => {
  const coach = Object.assign({}, COACH, { linkedPlayerIds: ["acct_coach2"] });
  const coach2 = { accountId: "acct_coach2", profileId: "profile_coach2", role: "coach", linkedCoachIds: [] };
  const box = linkSandbox([coach, coach2]);
  assert.deepStrictEqual(list(box.gdAccountLinkedPlayers(coach)), []);
});

test("access follows either link direction, and stops at strangers", () => {
  const coach = Object.assign({}, COACH, { linkedPlayerIds: [] });
  const linked = { accountId: "acct_p1", profileId: "profile_p1", role: "player", linkedCoachIds: ["acct_coach"] };
  const stranger = { accountId: "acct_p2", profileId: "profile_p2", role: "player", linkedCoachIds: [] };
  const box = linkSandbox([coach, linked, stranger]);
  assert.strictEqual(box.gdAccountCanAccessProfile(coach, "profile_p1"), true, "a reverse-linked player was refused");
  assert.strictEqual(box.gdAccountCanAccessProfile(coach, "profile_p2"), false, "a coach could open an unlinked player");
  assert.strictEqual(box.gdAccountCanAccessProfile(coach, "profile_coach"), true, "a coach could not open their own profile");
});

test("a player cannot open anyone else", () => {
  const player = { accountId: "acct_p1", profileId: "profile_p1", role: "player", linkedCoachIds: ["acct_coach"] };
  const other = { accountId: "acct_p2", profileId: "profile_p2", role: "player", linkedCoachIds: [] };
  const box = linkSandbox([player, other]);
  assert.strictEqual(box.gdAccountCanAccessProfile(player, "profile_p2"), false);
});

/* ---------- spare profiles on the coach's own account ----------
   Four of these sat on the live admin account, all named "Sam Hale". The roster
   is built from ACCOUNTS and they all share one, so they were invisible - and
   invisible meant undeletable, so they only accumulated. */

const OWN_PROFILES = [
  { id: "profile_coach", accountId: "acct_coach", name: "Sam" },
  { id: "player63", accountId: "acct_coach", name: "Sam Hale" },
  { id: "player22", accountId: "acct_coach", name: "Sam Hale" }
];

test("spare profiles on your own account are listed, and your live one is not", () => {
  const box = linkSandbox([COACH], OWN_PROFILES);
  assert.deepStrictEqual(
    list(box.gdAccountManagedProfiles(COACH)).map((p) => p.id),
    ["player63", "player22"],
    "spare profiles were not surfaced, or the coach's live profile was listed as one of them"
  );
});

test("a coach can open a spare profile on their own account", () => {
  const box = linkSandbox([COACH], OWN_PROFILES);
  assert.strictEqual(
    box.gdAccountCanAccessProfile(COACH, "player63"), true,
    "a profile on the coach's own account was refused, so it could be listed but never opened"
  );
});

test("profiles on someone else's account are not yours to manage", () => {
  const other = { accountId: "acct_p1", profileId: "profile_p1", role: "player", linkedCoachIds: [] };
  const box = linkSandbox([COACH, other], OWN_PROFILES.concat([{ id: "stray", accountId: "acct_p1", name: "Not yours" }]));
  assert.deepStrictEqual(
    list(box.gdAccountManagedProfiles(COACH)).map((p) => p.id),
    ["player63", "player22"],
    "another account's profile appeared in the coach's managed list"
  );
});

test("deleting a managed profile refuses the account's live profile and other accounts' rows", () => {
  const body = stripComments(extractFunction(core, "gdAccountDeleteManagedProfile"));
  assert.ok(
    /profile\.id===account\.profileId/.test(body.replace(/\s+/g, "")),
    "gdAccountDeleteManagedProfile can delete the profile you sign in as — the account would point at nothing and the app would mint a replacement"
  );
  assert.ok(
    /profile\.accountId!==account\.accountId/.test(body.replace(/\s+/g, "")),
    "gdAccountDeleteManagedProfile does not check ownership"
  );
  assert.ok(
    /ClarityProfileDelete/.test(body),
    "the delete is local-only — account-profiles would restore the row on the next device wipe"
  );
});

test("the roster offers a delete for managed rows and never silently drops it", () => {
  const code = stripComments(shell);
  assert.ok(/managedProfileRosterItems/.test(code), "managed profiles are not built into roster items");
  assert.ok(
    /gd67RemoveManagedProfile/.test(code) && /window\.gd67RemoveManagedProfile\s*=/.test(code),
    "the managed-profile delete handler is not wired to the row"
  );
  assert.ok(
    !/isAdmin:\s*false/.test(code),
    "the Players list still hard-codes isAdmin:false, which is what made every row unremovable"
  );
  assert.ok(
    /hasRecentActivity = true/.test(code),
    "managed rows go through the recent-activity filter — the rows a coach opened the list to delete would be hidden"
  );
});

test("the profile-delete endpoint is read-checked, scoped and routed", () => {
  const server = stripComments(fs.readFileSync(path.join(ROOT, "functions", "account-profile-delete.js"), "utf8"));
  assert.ok(/supabaseAuth\("user"/.test(server), "the caller is not resolved from the access token");
  assert.ok(!/body\.accountId/.test(server), "an account id from the body would let anyone delete anyone else's profiles");
  assert.ok(/live_profile/.test(server), "the endpoint can delete the profile the account signs in as");
  assert.ok(/not_yours/.test(server), "the endpoint does not verify the profile belongs to the caller");
  assert.ok(
    /account_id=eq\." \+ encodeFilter\(accountId\)/.test(server),
    "the DELETE is not scoped to the caller's account id"
  );
  assert.ok(
    /from = "\/api\/account-profile-delete"/.test(netlify),
    "no /api/account-profile-delete redirect — the client would 404 and the row would survive"
  );
  assert.ok(/clarity-profile-delete\.js/.test(indexHtml), "clarity-profile-delete.js is not loaded by index.html");
});

/* ---------- sync must not write a player's data over the coach's ---------- */

test("cloud sync pushes the account's own profile, not whatever is on screen", () => {
  const sync = fs.readFileSync(path.join(ROOT, "scripts", "clarity-cloud-sync.js"), "utf8");
  const body = extractFunction(sync, "profileFor");
  assert.ok(
    !/if \(api && typeof api\.active === "function"\) return api\.active\(\);/.test(body),
    "profileFor returns the ACTIVE profile unconditionally — account-sync writes it under the account's own profile_id, so a coach with a player open overwrote their own server profile with that player's bag"
  );
  assert.ok(
    /active\.id === wanted/.test(body),
    "profileFor does not check that the active profile is the account's own"
  );
  const guard = stripComments(extractFunction(sync, "requireAccountSynced"));
  assert.ok(
    /!payload\.profile/.test(guard),
    "an unresolvable profile is still pushed — account-sync writes bag_json: [] for a missing profile and would wipe the bag"
  );
});

/* ---------- the silent fallback ---------- */

test("viewing a player whose profile row is missing throws instead of loading the coach", () => {
  const body = extractFunction(core, "gdAccountViewProfile");
  assert.ok(
    /if\(!gdProfileById\(profileId\)\)throw/.test(body.replace(/\s+/g, "")) ||
      /!gdProfileById\(profileId\)[\s\S]*throw new Error/.test(body),
    "gdAccountViewProfile does not require the profile row to exist — a missing row silently loads the coach's own profile"
  );
});

test("the session fallback to the coach's own profile is reported, not silent", () => {
  const body = stripComments(extractFunction(core, "gdAccountApplySession"));
  assert.ok(
    /ClarityErrorReporter/.test(body) && /console\.warn/.test(body),
    "gdAccountApplySession still swaps to the coach's own profile without saying so"
  );
});

/* ---------- the player surface ---------- */

test("a coach viewing a player gets its own screen, not the own-profile markup", () => {
  const code = stripComments(shell);
  assert.ok(
    /if \(coachViewingPlayer\) \{[\s\S]{0,200}renderCoachPlayerView/.test(code),
    "render() does not branch to a dedicated player view"
  );
  assert.ok(
    /coachViewBanner/.test(code) && /coachPlayerExit/.test(code),
    "the player view has no viewing banner or exit control, so it reads as the coach's own profile"
  );
  assert.ok(
    !/gd67OpenMembershipSettings/.test(code.split("renderCoachPlayerView")[1] || ""),
    "the player view offers Membership, which belongs to the signed-in account only"
  );
});

test("the player view is styled apart from the own-profile view", () => {
  const css = fs.readFileSync(path.join(ROOT, "styles", "inline", "gd-app-base.css"), "utf8");
  ["coachViewBanner", "coachPlayerHero", "coachPlayerCard", "coachPlayerExit"].forEach((cls) => {
    assert.ok(
      new RegExp("#gdProfileV67 \\." + cls + "\\b").test(css),
      "no styles for ." + cls + " — the player view would fall back to unstyled blocks"
    );
  });
});

/* ---------- the roster endpoint ---------- */

test("coach-roster is read-only and takes identity from the token", () => {
  const code = stripComments(rosterServer);
  ["DELETE", "PATCH", "PUT"].forEach((verb) => {
    assert.ok(
      !new RegExp('method:\\s*"' + verb + '"').test(code),
      "coach-roster.js issues a " + verb + " — reading a roster must not be able to damage it"
    );
  });
  assert.ok(!/on_conflict|Prefer/.test(code), "coach-roster.js looks like it upserts; it should only read");
  assert.ok(
    /supabaseAuth\("user"/.test(code),
    "coach-roster.js does not resolve the caller from the access token"
  );
  assert.ok(
    !/body\.(coachAccountId|accountId)/.test(code),
    "coach-roster.js trusts an id from the body — anyone could read anyone else's players"
  );
});

test("coach-roster refuses a non-coach and drops the caller from their own roster", () => {
  const code = stripComments(rosterServer);
  assert.ok(/not_a_coach/.test(code), "any signed-in account can read a roster");
  assert.ok(/id === coachId/.test(code), "the caller is not excluded from their own player list");
});

test("the endpoint is routed and the client is loaded", () => {
  assert.ok(/from = "\/api\/coach-roster"/.test(netlify), "no /api/coach-roster redirect — the client would 404");
  assert.ok(/clarity-coach-roster\.js/.test(indexHtml), "clarity-coach-roster.js is not loaded by index.html");
});

/* ---------- roster merge ---------- */

function mergeSandbox(stored) {
  const store = {
    gd_accounts_v1: JSON.stringify(stored.accounts || { accounts: [] }),
    gd_player_profiles_v27: JSON.stringify(stored.profiles || { profiles: [] })
  };
  const sandbox = {
    console,
    setTimeout: () => {},
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; }
    },
    document: { readyState: "complete", addEventListener() {} },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, players: [] }) })
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.dispatchEvent = () => {};
  vm.createContext(sandbox);
  vm.runInContext(rosterClient, sandbox);
  return { sandbox, store };
}

test("the merge adds a missing player and their profile", () => {
  const ctx = mergeSandbox({
    accounts: { accounts: [{ accountId: "acct_coach", profileId: "profile_coach", role: "coach", linkedPlayerIds: [] }] },
    profiles: { profiles: [{ id: "profile_coach", name: "Sam" }] }
  });
  ctx.sandbox.ClarityCoachRoster.merge("acct_coach", [
    {
      account: { accountId: "acct_p1", profileId: "profile_p1", name: "Cullen", email: "c@x.com", linkedCoachIds: ["acct_coach"] },
      profile: { profile_id: "profile_p1", name: "Cullen", profile_json: { id: "profile_p1", name: "Cullen", bag: [1] } }
    }
  ]);
  const accounts = JSON.parse(ctx.store.gd_accounts_v1).accounts;
  const profiles = JSON.parse(ctx.store.gd_player_profiles_v27).profiles;
  assert.ok(accounts.some((a) => a.accountId === "acct_p1"), "the player account was not added");
  assert.ok(profiles.some((p) => p.id === "profile_p1"), "the player's profile row was not added — tapping them would fall back to the coach");
  const coach = accounts.find((a) => a.accountId === "acct_coach");
  assert.deepStrictEqual(list(coach.linkedPlayerIds), ["acct_p1"], "the coach's link list was not updated");
});

test("the merge never overwrites a profile that is already local", () => {
  const local = { id: "profile_p1", name: "Cullen", bag: [{ club: "7i", baseCarry: 140 }], localEdit: true };
  const ctx = mergeSandbox({
    accounts: { accounts: [{ accountId: "acct_coach", profileId: "profile_coach", role: "coach", linkedPlayerIds: ["acct_p1"] }] },
    profiles: { profiles: [local] }
  });
  ctx.sandbox.ClarityCoachRoster.merge("acct_coach", [
    {
      account: { accountId: "acct_p1", profileId: "profile_p1", name: "Cullen", linkedCoachIds: [] },
      profile: { profile_id: "profile_p1", name: "Cullen", profile_json: { id: "profile_p1", name: "Cullen", bag: [] } }
    }
  ]);
  const profiles = JSON.parse(ctx.store.gd_player_profiles_v27).profiles;
  assert.strictEqual(profiles.length, 1, "the profile was duplicated");
  assert.deepStrictEqual(
    profiles[0], local,
    "a local profile was overwritten from the server — offline coach edits would be lost and deleted players would come back"
  );
});

test("the merge keeps the coach out of their own linkedPlayerIds", () => {
  const ctx = mergeSandbox({
    accounts: { accounts: [{ accountId: "acct_coach", profileId: "profile_coach", role: "coach", linkedPlayerIds: ["acct_coach"] }] },
    profiles: { profiles: [] }
  });
  ctx.sandbox.ClarityCoachRoster.merge("acct_coach", [
    { account: { accountId: "acct_coach", profileId: "profile_coach", name: "Sam" }, profile: null }
  ]);
  const coach = JSON.parse(ctx.store.gd_accounts_v1).accounts.find((a) => a.accountId === "acct_coach");
  assert.deepStrictEqual(list(coach.linkedPlayerIds), [], "the coach is still their own player");
});

(async () => {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.fn();
      console.log("  ok  " + entry.name);
    } catch (error) {
      failed += 1;
      console.error("  FAIL  " + entry.name + "\n        " + (error && error.message));
    }
  }
  if (failed) process.exit(1);
  console.log("coach-player-link passed: " + tests.length + " checks");
})();
