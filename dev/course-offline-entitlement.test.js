/* Regression coverage for the boundary between transient online course packages and
 * the device-retained Course Library, which belongs to an account: anyone signed in may
 * save, a guest is refused (and told so - access.courseIssue("signin")), and a live native
 * store subscription is the one way to save without an account. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const ACCESS = fs.readFileSync(path.join(ROOT, "app", "js", "access.js"), "utf8");
const STORE = fs.readFileSync(path.join(ROOT, "app", "js", "course-store.js"), "utf8");

function memoryStorage(seed, failCourseWrites) {
  const values = Object.assign({}, seed || {});
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null; },
    setItem(key, value) {
      if (failCourseWrites && key === "clarity:course-library:v1") throw new Error("QuotaExceededError");
      values[key] = String(value);
    },
    removeItem(key) { delete values[key]; },
    snapshot() { return Object.assign({}, values); }
  };
}

function context(seed, failCourseWrites) {
  const localStorage = memoryStorage(seed, failCourseWrites);
  const ctx = {
    console,
    localStorage,
    location: { search: "", href: "" },
    document: {
      body: {},
      getElementById() { return null; },
      addEventListener() {}
    },
    setTimeout() { return 1; },
    clearTimeout() {},
    ClarityApp: {}
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  return ctx;
}

function loadAccess(seed, signedIn) {
  const ctx = context(seed);
  ctx.ClarityApp.account = { signedIn() { return !!signedIn; } };
  vm.runInContext(ACCESS, ctx, { filename: "app/js/access.js" });
  return ctx;
}

function loadStore(allowed, failCourseWrites) {
  const ctx = context({}, failCourseWrites);
  ctx.ClarityApp.access = { canSaveCourses: () => allowed };
  vm.runInContext(STORE, ctx, { filename: "app/js/course-store.js" });
  return ctx;
}

function entry(id) {
  return {
    courseId: id,
    courseName: "Test Course",
    mapType: "published",
    objectsVersion: "objects-1",
    mapVersion: 2,
    bakeNumber: 7,
    objectsRevision: 3,
    versionLabel: "v7",
    pkg: { status: "full-map-ready", holes: { 1: { green: { lat: -36.8, lng: 174.7 } } } }
  };
}

{
  const ctx = loadAccess({
    "gd_accounts_v1": JSON.stringify({ activeId: "p1", accounts: [{ accountId: "p1", role: "player" }] }),
    "clarity:payments:status:v1": JSON.stringify({ active: false })
  }, true);
  assert.strictEqual(ctx.ClarityApp.access.canSaveCourses(), true,
    "a signed-in free player may save courses: the library is an account feature, not a paid one");
}

{
  const ctx = loadAccess({}, false);
  assert.strictEqual(ctx.ClarityApp.access.canSaveCourses(), false, "a guest may not save courses");
}

{
  const ctx = loadAccess({
    "clarity:payments:status:v1": JSON.stringify({ active: true })
  }, false);
  assert.strictEqual(ctx.ClarityApp.access.canSaveCourses(), false,
    "a stale paid-account cache must not stand in for a sign-in after sign-out");
}

{
  const ctx = loadAccess({
    "clarity:store-entitlement:v1": JSON.stringify({ active: true, expiresAt: "2999-01-01T00:00:00.000Z" })
  });
  assert.strictEqual(ctx.ClarityApp.access.canSaveCourses(), true, "a live native store subscription saves without an account");
}

{
  const ctx = loadAccess({
    "clarity:store-entitlement:v1": JSON.stringify({ active: true, expiresAt: "2000-01-01T00:00:00.000Z" })
  });
  assert.strictEqual(ctx.ClarityApp.access.canSaveCourses(), false, "an expired device entitlement does not");
}

{
  const guest = loadStore(false, false);
  const saved = guest.ClarityApp.courseStore.save(entry("guest-course"));
  assert.strictEqual(saved, null);
  assert.strictEqual(guest.ClarityApp.courseStore.lastSaveFailure(), "signin",
    "a guest's refused save names the sign-in, so boot.js can ask for one");
  assert.strictEqual(guest.localStorage.getItem("clarity:course-library:v1"), null,
    "online viewing must not silently populate the Course Library");
}

{
  const signedIn = loadStore(true, false);
  const saved = signedIn.ClarityApp.courseStore.save(entry("saved-course"));
  assert.ok(saved && saved.courseId === "saved-course");
  assert.strictEqual(signedIn.ClarityApp.courseStore.lastSaveFailure(), "");
  assert.strictEqual(signedIn.ClarityApp.courseStore.list().length, 1, "a signed-in save retains the package on device");
}

{
  const full = loadStore(true, true);
  const saved = full.ClarityApp.courseStore.save(entry("quota-course"));
  assert.strictEqual(saved, null);
  assert.strictEqual(full.ClarityApp.courseStore.lastSaveFailure(), "storage",
    "a quota rejection must be distinguishable from a sign-in refusal");
}

console.log("course offline entitlement passed");
