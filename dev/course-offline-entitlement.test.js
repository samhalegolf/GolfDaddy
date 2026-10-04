/* Regression coverage for the boundary between transient online course packages and
 * the paid, device-retained Course Library. */
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
  ctx.ClarityApp.access = { offlineDownloads: () => allowed };
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
  assert.strictEqual(ctx.ClarityApp.access.offlineDownloads(), false,
    "a signed-in free player may view online packages but must not get a device download");
}

{
  const ctx = loadAccess({
    "gd_accounts_v1": JSON.stringify({ activeId: "coach", accounts: [{ accountId: "coach", role: "coach" }] })
  }, true);
  assert.strictEqual(ctx.ClarityApp.access.offlineDownloads(), true, "staff access includes offline courses");
}

{
  const ctx = loadAccess({
    "clarity:payments:status:v1": JSON.stringify({ active: true })
  }, true);
  assert.strictEqual(ctx.ClarityApp.access.offlineDownloads(), true, "active backend paid access includes offline courses");
}

{
  const ctx = loadAccess({
    "clarity:payments:status:v1": JSON.stringify({ active: true })
  }, false);
  assert.strictEqual(ctx.ClarityApp.access.offlineDownloads(), false,
    "a stale paid-account cache must not unlock guest downloads after sign-out");
}

{
  const ctx = loadAccess({
    "clarity:store-entitlement:v1": JSON.stringify({ active: true, expiresAt: "2999-01-01T00:00:00.000Z" })
  });
  assert.strictEqual(ctx.ClarityApp.access.offlineDownloads(), true, "an active native store entitlement includes offline courses");
}

{
  const ctx = loadAccess({
    "clarity:store-entitlement:v1": JSON.stringify({ active: true, expiresAt: "2000-01-01T00:00:00.000Z" })
  });
  assert.strictEqual(ctx.ClarityApp.access.offlineDownloads(), false, "an expired device entitlement must not unlock new downloads");
}

{
  const free = loadStore(false, false);
  const saved = free.ClarityApp.courseStore.save(entry("free-course"));
  assert.strictEqual(saved, null);
  assert.strictEqual(free.ClarityApp.courseStore.lastSaveFailure(), "access");
  assert.strictEqual(free.localStorage.getItem("clarity:course-library:v1"), null,
    "online viewing must not silently populate the offline Course Library");
}

{
  const paid = loadStore(true, false);
  const saved = paid.ClarityApp.courseStore.save(entry("paid-course"));
  assert.ok(saved && saved.courseId === "paid-course");
  assert.strictEqual(paid.ClarityApp.courseStore.lastSaveFailure(), "");
  assert.strictEqual(paid.ClarityApp.courseStore.list().length, 1, "paid access retains the package on device");
}

{
  const full = loadStore(true, true);
  const saved = full.ClarityApp.courseStore.save(entry("quota-course"));
  assert.strictEqual(saved, null);
  assert.strictEqual(full.ClarityApp.courseStore.lastSaveFailure(), "storage",
    "a quota rejection must be distinguishable from an entitlement refusal");
}

console.log("course offline entitlement passed");
