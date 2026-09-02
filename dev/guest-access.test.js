/* A guest is a first-class session, and demo mode is what limits it.
 *
 * Two things used to be true at once and should never have been: the Profile
 * screen was a sign-in form for anyone without an account, and the whole shot
 * system answered gdAuthGateAllows() with a login prompt. This locks in the
 * replacement:
 *
 *   - the signed-out session gets a stable profile derived from the durable
 *     guest install id, adopting the shared hard-coded placeholder in place
 *     (and carrying its saved-course keys across) rather than orphaning them;
 *   - a placeholder some ACCOUNT points at is never adopted - that is another
 *     player on this device, not the guest;
 *   - the shot system opens for a guest, and importCapture is the one door
 *     that stays shut, so no intake button can route around it;
 *   - admin is still account-based.
 *
 * Run: node dev/guest-access.test.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const GUEST_ACCESS = path.join(ROOT, "scripts", "gd-guest-access.js");
const AUTH_GATE = path.join(ROOT, "scripts", "inline", "gd-auth-gate-v1.js");

const GUEST_ID = "9f7381c2e4a60b5d";
const GUEST_PROFILE_ID = "guest9f7381c2";

function fakeStorage(seed) {
  const data = Object.assign({}, seed || {});
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; },
    _data: data
  };
}

/* The real file in a minimal browser. Everything it reaches for is supplied
   here so a behaviour change in it fails this test rather than a stub. */
function boot(options) {
  const opts = options || {};
  const profileState = opts.profileState || { profiles: [], activeId: null };
  const saves = { profiles: 0 };
  const toasts = [];
  const listeners = {};
  const timers = [];

  const window = {
    GDGuestIdentity: { getOrCreateGuestId: () => GUEST_ID, getActorKey: () => "guest:" + GUEST_ID },
    GolfDaddyAccounts: { current: () => opts.account || null },
    GolfDaddyLaunchMonitorData: opts.launchMonitor || null,
    localStorage: fakeStorage(opts.storage),
    location: { search: opts.search || "" },
    savePlayerProfiles: () => { saves.profiles += 1; },
    syncCoreProfileFromActive: () => {},
    gdPlaceholderProfile: (id) => ({
      id, name: "Demo Player", handedness: "right", mode: "player",
      bag: [{ club: "7i", baseCarry: 158 }], bubbleProfiles: {}, placeholderProfile: true
    }),
    gdLmToast: (message) => { toasts.push(String(message)); },
    addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); },
    dispatchEvent: () => {}
  };
  window.window = window;

  const document = {
    readyState: "complete",
    body: { classList: makeClassList() },
    documentElement: { classList: makeClassList() },
    addEventListener: () => {},
    getElementById: () => null
  };

  const sandbox = {
    window, document, console,
    JSON, Object, String, Number, Array, Date, Boolean, Math, RegExp, Error,
    URLSearchParams,
    GD_PROFILE_STATE: profileState,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {}
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(fs.readFileSync(GUEST_ACCESS, "utf8"), sandbox);

  return {
    api: window.GDGuestAccess,
    window, document, profileState, saves, toasts,
    /* The module defers its first sync; running the queued callbacks is what a
       real boot does a tick later. */
    settle: () => { while (timers.length) timers.shift()(); },
    emitSessionChange: () => (listeners["clarity:session-changed"] || []).forEach((fn) => fn())
  };
}

function makeClassList() {
  const set = {};
  return {
    add: (name) => { set[name] = true; },
    remove: (name) => { delete set[name]; },
    contains: (name) => !!set[name],
    toggle: (name, on) => { if (on) set[name] = true; else delete set[name]; return !!set[name]; },
    _set: set
  };
}

function bootAuthGate(account) {
  const window = {
    GolfDaddyAccounts: { current: () => account || null },
    location: { search: "" },
    addEventListener: () => {},
    gdOpenProfileV67: function () { window.__openedAuth = true; },
    toast: () => {}
  };
  window.window = window;
  const document = {
    readyState: "complete",
    body: { classList: makeClassList() },
    documentElement: { classList: makeClassList() },
    addEventListener: () => {},
    getElementById: () => null
  };
  const sandbox = {
    window, document, console, JSON, Object, String, Number, Array, Date, Math, RegExp, Error,
    URLSearchParams, sessionStorage: fakeStorage(),
    setTimeout: () => 0, clearTimeout: () => {}
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(AUTH_GATE, "utf8"), sandbox);
  return window;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("the guest profile id is derived from the durable guest install id", () => {
  const ctx = boot({});
  assert.strictEqual(ctx.api.guestProfileId(), GUEST_PROFILE_ID);
  /* Slug-safe by construction: the course-library uid is slug(profileId), and a
     guest id that changed shape under slug() would namespace saved courses
     somewhere nothing reads back. */
  assert.strictEqual(ctx.api._uidFor(GUEST_PROFILE_ID), "user-" + GUEST_PROFILE_ID);
});

test("an unclaimed placeholder is adopted in place, renamed, and its saved courses follow", () => {
  const placeholder = {
    id: "gd_placeholder_demo_player", name: "Demo Player", placeholderProfile: true,
    bag: [{ club: "7i", baseCarry: 162 }]
  };
  const ctx = boot({
    profileState: { profiles: [placeholder], activeId: "gd_placeholder_demo_player" },
    storage: {
      gd_accounts_v1: JSON.stringify({ accounts: [], activeId: null }),
      gd_user_course_library_v1: JSON.stringify({
        courses: {
          "user-gd-placeholder-demo-player::millbrook": {
            id: "c1", userId: "user-gd-placeholder-demo-player", courseId: "millbrook", courseName: "Millbrook"
          }
        }
      })
    }
  });

  const guest = ctx.api.ensureGuestProfile();
  assert.ok(guest, "a signed-out session must get a guest profile");
  assert.strictEqual(guest.id, GUEST_PROFILE_ID);
  assert.strictEqual(guest.name, "Guest", "the seeded 'Demo Player' name is not a guest identity");
  assert.deepStrictEqual(guest.bag, [{ club: "7i", baseCarry: 162 }], "adopting must carry the profile's data across");
  assert.strictEqual(ctx.profileState.profiles.length, 1, "adopting must not leave a second profile behind");
  assert.strictEqual(ctx.profileState.activeId, GUEST_PROFILE_ID);

  const store = JSON.parse(ctx.window.localStorage.getItem("gd_user_course_library_v1"));
  const keys = Object.keys(store.courses);
  assert.deepStrictEqual(keys, ["user-" + GUEST_PROFILE_ID + "::millbrook"], "saved courses were orphaned by the re-id");
  assert.strictEqual(store.courses[keys[0]].userId, "user-" + GUEST_PROFILE_ID);
  assert.strictEqual(store.courses[keys[0]].courseName, "Millbrook");
});

test("a placeholder some account points at is left alone", () => {
  const claimed = { id: "gd_placeholder_demo_player", name: "Demo Player", placeholderProfile: true };
  const ctx = boot({
    profileState: { profiles: [claimed], activeId: "gd_placeholder_demo_player" },
    storage: {
      gd_accounts_v1: JSON.stringify({
        accounts: [{ accountId: "acc-1", profileId: "gd_placeholder_demo_player" }], activeId: null
      })
    }
  });

  const guest = ctx.api.ensureGuestProfile();
  assert.strictEqual(guest.id, GUEST_PROFILE_ID);
  assert.strictEqual(claimed.id, "gd_placeholder_demo_player", "another account's profile must not be re-identified");
  assert.strictEqual(claimed.name, "Demo Player");
  assert.strictEqual(ctx.profileState.profiles.length, 2, "the guest is a new profile beside it, not a rename of it");
});

test("ensureGuestProfile is idempotent and never runs for a signed-in account", () => {
  const ctx = boot({ profileState: { profiles: [], activeId: null } });
  const first = ctx.api.ensureGuestProfile();
  const second = ctx.api.ensureGuestProfile();
  assert.strictEqual(first, second, "a second call must return the same profile, not mint another");
  assert.strictEqual(ctx.profileState.profiles.length, 1);

  const signedIn = boot({
    account: { accountId: "acc-1", profileId: "player42" },
    profileState: { profiles: [{ id: "player42", name: "Sam" }], activeId: "player42" }
  });
  assert.strictEqual(signedIn.api.ensureGuestProfile(), null);
  assert.strictEqual(signedIn.api.demoOnly(), false);
  assert.strictEqual(signedIn.profileState.activeId, "player42", "a signed-in session must keep its own active profile");
});

test("importCapture is the one door: refused for a guest, open for an account", () => {
  const calls = [];
  /* Held separately: _guardPracticeWrites replaces importCapture ON the object
     it is given, so reusing that object for the second boot would hand the
     signed-in session the guest's wrapper. */
  const real = (payload) => { calls.push(payload); return { session: { sessionId: "s1" }, capture: {}, shots: [1, 2] }; };

  const guest = boot({ launchMonitor: { importCapture: real } });
  assert.strictEqual(guest.api._guardPracticeWrites(), true);
  const blocked = guest.window.GolfDaddyLaunchMonitorData.importCapture({ label: "real import" });
  assert.strictEqual(calls.length, 0, "a guest import must never reach the store");
  /* Length, not deepStrictEqual: the array is built inside the vm realm, so its
     Array prototype is not this realm's and a deep-equal would fail on identity
     rather than on content. */
  assert.strictEqual(blocked.shots.length, 0, "the refusal must keep the real return shape");
  assert.strictEqual(blocked.blocked, "guest-demo");
  assert.ok(guest.toasts.some((t) => /demo mode/i.test(t)), "a silent refusal reads as a broken import");

  const member = boot({ account: { accountId: "acc-1" }, launchMonitor: { importCapture: real } });
  member.api._guardPracticeWrites();
  const allowed = member.window.GolfDaddyLaunchMonitorData.importCapture({ label: "real import" });
  assert.strictEqual(calls.length, 1, "a signed-in import must pass straight through");
  assert.strictEqual(allowed.shots.length, 2);
});

test("the URL demo route still seeds real rows", () => {
  const calls = [];
  const ctx = boot({
    search: "?demo=practice-bubble",
    launchMonitor: { importCapture: (p) => { calls.push(p); return { session: {}, capture: {}, shots: [] }; } }
  });
  assert.strictEqual(ctx.api.demoOnly(), false, "the seeded demo route is not a guest walking in");
  ctx.api._guardPracticeWrites();
  ctx.window.GolfDaddyLaunchMonitorData.importCapture({ label: "seed" });
  assert.strictEqual(calls.length, 1);
});

test("sync marks the body so the surfaces can tell which session they are in", () => {
  const guest = boot({});
  guest.settle();
  assert.strictEqual(guest.document.body.classList.contains("gdGuestSession"), true);
  assert.strictEqual(guest.document.body.classList.contains("gdGuestDemoMode"), true);

  const member = boot({ account: { accountId: "acc-1", profileId: "player42" } });
  member.settle();
  assert.strictEqual(member.document.body.classList.contains("gdGuestSession"), false);
  assert.strictEqual(member.document.body.classList.contains("gdGuestDemoMode"), false);
});

test("the auth gate lets a guest into the shot system and keeps admin out", () => {
  const guest = bootAuthGate(null);
  assert.strictEqual(guest.gdAuthGateAllows("shotData"), true, "the shot system is guest-reachable in demo mode");
  assert.strictEqual(guest.gdAuthGateAllows("courseData"), true);
  assert.strictEqual(guest.gdAuthGateAllows("practiceData"), true);
  assert.strictEqual(guest.__openedAuth, undefined, "no sign-in screen may be forced open for those routes");
  assert.strictEqual(guest.gdAuthGateAllows("admin"), false, "admin is the operator console, not a demo");
  assert.strictEqual(guest.__openedAuth, true, "a refused route must open the sign-in screen itself");

  const member = bootAuthGate({ accountId: "acc-1" });
  assert.strictEqual(member.gdAuthGateAllows("admin"), true);
});

/* The guest profile screen says "Sign In" and "Create Account" on its account
   call to action. Two files used to read those words off the panel and conclude
   the sign-in FORM was up - which locked the shell (gdAuthLocked) behind a
   screen that is not the form: Home, the dock, every module panel and the
   profile's own topbar hidden, with the guest looking at their profile. */
function bootRouteHardening(authFormOpen) {
  const HARDENING = path.join(ROOT, "scripts", "inline", "gd-inline-profile-route-hardening-v1.js");
  const bodyClasses = makeClassList();
  const profileEl = { classList: makeClassList(), textContent: "Guest Profile Guest Bag Shot Data Create Account Sign In" };
  profileEl.classList.add("hidden");
  const window = {
    GolfDaddyAccounts: { current: () => null },
    gd67AuthFormOpen: authFormOpen === null ? undefined : () => authFormOpen,
    gdOpenProfileV67: function () { return "opened"; },
    gdCloseProfileV67: function () { return "closed"; },
    addEventListener: () => {}
  };
  window.window = window;
  const document = {
    body: { classList: bodyClasses },
    documentElement: { classList: makeClassList() },
    addEventListener: () => {},
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: (id) => (id === "gdProfileV67" ? profileEl : null)
  };
  const sandbox = {
    window, document, console, JSON, Object, String, Number, Array, Date, Math, RegExp, Error,
    /* The file assigns this bare global under 'use strict', so it has to exist
       or its own safe() swallows a ReferenceError and prints a warning. */
    lastShellModule: "",
    setTimeout: () => 0, clearTimeout: () => {}
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(HARDENING, "utf8"), sandbox);
  window.gdOpenProfileV67();
  return bodyClasses;
}

test("the guest profile screen is not mistaken for the sign-in form", () => {
  const guestProfile = bootRouteHardening(false);
  assert.strictEqual(guestProfile.contains("gdAuthLocked"), false,
    "the shell was locked behind the guest profile - Home, the dock and the panel's own topbar all hide under gdAuthLocked");
  assert.strictEqual(guestProfile.contains("gdProfileOpen"), true, "the profile surface should still be marked open");

  const signInForm = bootRouteHardening(true);
  assert.strictEqual(signInForm.contains("gdAuthLocked"), true,
    "the real sign-in form must still keep the app out from behind it");
});

let failed = 0;
tests.forEach(({ name, fn }) => {
  try { fn(); console.log("  ok  " + name); }
  catch (error) { failed += 1; console.error("FAIL  " + name + "\n      " + error.message); }
});
console.log((tests.length - failed) + "/" + tests.length + " passed");
process.exit(failed ? 1 : 0);
