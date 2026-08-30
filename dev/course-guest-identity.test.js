/* The anonymous installation identity, and the request it is there to make possible.
 *
 * Before this existed, functions/course-package.mjs would not start a mapping run for anybody
 * without a Supabase account - so the most common first run of the app (install, search a
 * course, press Play) never enqueued anything, the package came back "none", and the round
 * opened in manual green-tapping. These assertions cover the two halves that fix: the id is
 * stable and durable, and it actually travels on the request.
 *
 * Load-bearing assertions:
 *   - one id per installation, minted once and kept
 *   - it matches what functions/course-mapper-jobs.mjs will accept, or it is silently ignored
 *     server-side and courses quietly stop being mapped
 *   - it is mirrored by gd-durable-storage.js, or a storage eviction hands the install a
 *     fresh mapping budget every time
 *   - /api/course-package carries it, signed in or not
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const IDENTITY = path.join(root, "scripts", "gd-guest-identity.js");
const CLIENT = path.join(root, "scripts", "gd-course-package-client.js");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function storage(initial = {}) {
  const data = Object.assign({}, initial);
  return {
    data,
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; }
  };
}

function loadIdentity(options = {}) {
  const localStorage = options.localStorage || storage();
  const win = {
    localStorage,
    crypto: options.noCrypto ? undefined : { getRandomValues(array) { for (let i = 0; i < array.length; i += 1) array[i] = (i * 37 + 11) % 256; return array; } },
    ClaritySupabaseAuth: options.session ? { session: () => options.session } : undefined
  };
  win.window = win;
  vm.runInNewContext(fs.readFileSync(IDENTITY, "utf8"), { window: win, document: { body: { dataset: {} } } }, { filename: "gd-guest-identity.js" });
  return { api: win.GDGuestIdentity, localStorage, win };
}

test("an installation mints one id and then keeps it", () => {
  const env = loadIdentity();
  const first = env.api.getOrCreateGuestId();
  assert.ok(first, "an id is produced");
  assert.strictEqual(env.api.getOrCreateGuestId(), first, "asking again does not mint another");
  const reload = loadIdentity({ localStorage: env.localStorage });
  assert.strictEqual(reload.api.getOrCreateGuestId(), first, "and it survives the page being loaded again");
});

test("the id is in the shape the server will accept", async () => {
  /* If these two ever disagree the failure is silent and horrible: the server treats the id as
     no actor at all, declines to enqueue, and every course looks permanently unmapped. */
  const { mapperActorKey } = await import(path.join(root, "functions", "course-mapper-jobs.mjs"));
  const id = loadIdentity().api.getOrCreateGuestId();
  assert.strictEqual(mapperActorKey({ guestId: id }), "guest:" + id);
});

test("a corrupted stored value is replaced rather than sent", () => {
  const env = loadIdentity({ localStorage: storage({ "clarity:guest-install-id:v1": "  NOT an id  " }) });
  const id = env.api.getOrCreateGuestId();
  assert.ok(/^[a-f0-9]{16,64}$/.test(id), "got: " + id);
});

test("an installation without crypto still gets a usable id", async () => {
  const { mapperActorKey } = await import(path.join(root, "functions", "course-mapper-jobs.mjs"));
  const id = loadIdentity({ noCrypto: true }).api.getOrCreateGuestId();
  assert.ok(mapperActorKey({ guestId: id }), "a weaker id is still an id - the alternative is no mapping at all");
});

test("a signed-in session reports as a user, not a guest", () => {
  const env = loadIdentity({ session: { user: { id: "user-abc" } } });
  assert.strictEqual(env.api.getActorKey(), "user:user-abc");
  assert.strictEqual(loadIdentity().api.getActorKey().slice(0, 6), "guest:");
});

test("the id is mirrored to durable storage", () => {
  /* A WebView eviction that took this with it would hand the installation a fresh server-side
     mapping budget every time, which is the budget existing to be finite. */
  const durable = fs.readFileSync(path.join(root, "scripts", "inline", "gd-durable-storage.js"), "utf8");
  assert.ok(durable.includes("clarity:guest-install-id:v1"), "the key must be listed in DURABLE_KEYS");
  const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const durableAt = index.indexOf("gd-durable-storage.js");
  const identityAt = index.indexOf("gd-guest-identity.js");
  assert.ok(identityAt > -1, "the identity script is loaded");
  assert.ok(durableAt > -1 && durableAt < identityAt,
    "durable storage patches localStorage.setItem, so it has to be in place before the id is written or the write is never mirrored");
});

test("the course-package request carries the guest id", async () => {
  const urls = [];
  const localStorage = storage();
  const win = {
    localStorage,
    crypto: { getRandomValues(a) { for (let i = 0; i < a.length; i += 1) a[i] = i + 1; return a; } }
  };
  win.window = win;
  const document = { body: { dataset: {} } };
  vm.runInNewContext(fs.readFileSync(IDENTITY, "utf8"), { window: win, document }, { filename: "gd-guest-identity.js" });
  const context = {
    window: win,
    document,
    setTimeout: () => 1,
    clearTimeout: () => {},
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    fetch: async (url) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => ({ status: "processing" }) }; }
  };
  win.fetch = context.fetch;
  vm.runInNewContext(fs.readFileSync(CLIENT, "utf8"), context, { filename: "gd-course-package-client.js" });
  await win.GDCoursePackageClient.fetchPackage({ courseId: "southport", courseLat: 53.64, courseLng: -3.02 });
  assert.strictEqual(urls.length, 1);
  assert.ok(urls[0].includes("guestId=" + win.GDGuestIdentity.getOrCreateGuestId()),
    "without this a signed-out player's course is never enqueued: " + urls[0]);
  assert.strictEqual(document.body.dataset.gdCoursePackageOutcome, "processing",
    "and the outcome channel reports the build state rather than blaming the missing sign-in");
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    try { await item.fn(); console.log("  ok  " + item.name); }
    catch (error) { failed += 1; console.error("  FAIL  " + item.name + "\n        " + (error && error.message || error)); }
  }
  if (failed) { console.error("course-guest-identity FAILED: " + failed + " of " + tests.length); process.exit(1); }
  console.log("course-guest-identity passed: " + tests.length + " checks");
})();
