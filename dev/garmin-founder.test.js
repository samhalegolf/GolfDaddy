/* Garmin Founder: the offer for players who connect a Garmin watch.
 *
 * Pinned here:
 *   - the server records it as one permanent user_entitlements row
 *     (garmin_founder, no expiry) against the account in the bearer token -
 *     never one named in the body - and a second call writes nothing;
 *   - readPaidAccess reports it on its own: it is NOT paid access, and it
 *     survives alongside a membership;
 *   - on the phone it opens the Starter Bubble (Manual Set) and nothing else:
 *     practice data and the full Bubble centre setting stay on membership;
 *   - the claim only fires for a Garmin that is chosen, in reach and has
 *     Clarity Caddy installed, and only once per account;
 *   - a round on the watch leads to one feedback ask, which opens the Garmin
 *     topic of the support form, and that ticket is tagged on the server.
 *
 * Run: node dev/garmin-founder.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const UTILS = path.join(ROOT, "functions", "payment-utils.js");
const ENDPOINT = path.join(ROOT, "functions", "garmin-founder.js");
const SUPPORT = path.join(ROOT, "functions", "support-ticket.js");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function withEnv(vars, fn) {
  const previous = {};
  Object.keys(vars).forEach(function (k) { previous[k] = process.env[k]; process.env[k] = vars[k]; });
  return Promise.resolve().then(fn).finally(function () {
    Object.keys(previous).forEach(function (k) {
      if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k];
    });
  });
}

/* ------------------------------------------------------------ server read */

async function readAccessWith(rows) {
  delete require.cache[UTILS];
  const utils = require(UTILS);
  const originalFetch = global.fetch;
  global.fetch = async function (url) {
    const body = String(url).includes("/user_entitlements") ? rows : [];
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body, headers: { get: () => null } };
  };
  try {
    return await withEnv({ SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "stub" }, function () {
      return utils.readPaidAccess({ accountId: "acct_1", email: "p@example.com" });
    });
  } finally {
    global.fetch = originalFetch;
  }
}

const FOUNDER_ROW = { product_key: "garmin_founder", entitlement_type: "garmin_founder", status: "active", starts_at: "2026-10-01T00:00:00.000Z", expires_at: null };

test("a Garmin Founder alone is not paid access, but is reported", async () => {
  const result = await readAccessWith([FOUNDER_ROW]);
  assert.strictEqual(result.active, false, "Garmin Founder must never read as a membership");
  assert.strictEqual(result.paymentState, "free_access");
  assert.deepStrictEqual(result.garminFounder, { active: true, since: "2026-10-01T00:00:00.000Z" });
  assert.strictEqual(result.entitlements.length, 0, "the founder row must not appear as a paid entitlement");
});

test("Garmin Founder is kept alongside a membership", async () => {
  const pass = { product_key: "month_pass", status: "active", starts_at: "2026-10-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z" };
  const result = await readAccessWith([FOUNDER_ROW, pass]);
  assert.strictEqual(result.active, true);
  assert.strictEqual(result.paymentState, "month_pass_active");
  assert.strictEqual(result.garminFounder.active, true);
});

test("an inactive founder row does not count, and no row reads as not a founder", async () => {
  assert.strictEqual((await readAccessWith([Object.assign({}, FOUNDER_ROW, { status: "revoked" })])).garminFounder.active, false);
  assert.strictEqual((await readAccessWith([])).garminFounder.active, false);
});

/* ------------------------------------------------------------- endpoint */

function loadEndpoint(options) {
  delete require.cache[UTILS];
  delete require.cache[ENDPOINT];
  const real = require(UTILS);
  const calls = { gets: [], posts: [] };
  const stub = Object.assign({}, real, {
    hasSupabase: () => true,
    authenticatedAccount: async function (event) {
      const auth = event.headers && event.headers.authorization;
      if (!auth) return null;
      return { account_id: "acct_token", email: "Token@Example.com", profile_id: "prof_token" };
    },
    supabaseFetch: async function (pathAndQuery, init) {
      if (init && init.method === "POST") {
        const row = JSON.parse(init.body);
        calls.posts.push(row);
        return [Object.assign({ created_at: "2026-10-05T00:00:00.000Z" }, row)];
      }
      calls.gets.push(pathAndQuery);
      return options.existing || [];
    }
  });
  const originalLoad = Module._load;
  Module._load = function (request, parent) {
    if (parent && parent.filename === ENDPOINT && request === "./payment-utils") return stub;
    return originalLoad.apply(this, arguments);
  };
  try { return { handler: require(ENDPOINT).handler, calls: calls }; }
  finally { Module._load = originalLoad; }
}

function post(handler, body, headers) {
  return handler({ httpMethod: "POST", headers: headers || {}, body: JSON.stringify(body || {}) });
}

test("the endpoint needs a signed-in caller", async () => {
  const { handler, calls } = loadEndpoint({});
  const res = await post(handler, { accountId: "acct_victim" });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(calls.gets.length + calls.posts.length, 0, "no database call without a token");
});

test("the first claim writes one permanent row for the token's account", async () => {
  const { handler, calls } = loadEndpoint({});
  const res = await post(handler, { accountId: "acct_victim", platform: "ios", deviceModel: "Forerunner 965" }, { authorization: "Bearer t" });
  const body = JSON.parse(res.body);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body.created, true);
  assert.strictEqual(body.garminFounder.active, true);
  assert.strictEqual(calls.posts.length, 1);
  const row = calls.posts[0];
  assert.strictEqual(row.user_id, "acct_token", "the account comes from the token, never the body");
  assert.strictEqual(row.account_email, "token@example.com");
  assert.strictEqual(row.product_key, "garmin_founder");
  assert.strictEqual(row.status, "active");
  assert.strictEqual(row.expires_at, null, "Garmin Founder never expires");
  assert.strictEqual(row.metadata.platform, "ios");
  assert.strictEqual(row.metadata.deviceModel, "Forerunner 965");
  assert.ok(calls.gets[0].includes("user_id=eq.acct_token"), "the existing-row check is scoped to the token's account");
});

test("a repeat claim writes nothing and keeps the first date", async () => {
  const { handler, calls } = loadEndpoint({ existing: [FOUNDER_ROW] });
  const res = await post(handler, { platform: "android" }, { authorization: "Bearer t" });
  const body = JSON.parse(res.body);
  assert.strictEqual(body.created, false);
  assert.strictEqual(body.garminFounder.since, FOUNDER_ROW.starts_at);
  assert.strictEqual(calls.posts.length, 0);
});

/* ----------------------------------------------------- phone: what it opens */

function paymentsClient(status) {
  const store = { "clarity:payments:status:v1": JSON.stringify(status) };
  const w = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    document: { readyState: "complete", addEventListener() {}, querySelector() { return null; }, getElementById() { return null; }, querySelectorAll() { return []; }, body: { dataset: {} } },
    addEventListener() {}, setTimeout() {}, location: { search: "", href: "", origin: "" }, console,
    GDI18n: { t: (k) => k, tn: (k) => k, locale: () => "en", onChange() {} },
    GolfDaddyAccounts: { current: () => ({ accountId: "acct_1", email: "p@example.com", role: "player" }) }
  };
  w.window = w;
  vm.createContext(w);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "scripts", "clarity-payments.js"), "utf8"), w);
  return w.ClarityPayments;
}

test("a Garmin Founder can keep a Starter Bubble and nothing more", () => {
  const pay = paymentsClient({ active: false, paymentState: "free_access", garminFounder: { active: true } });
  assert.strictEqual(pay.hasActiveAccess(), false, "Garmin Founder is not a membership");
  assert.strictEqual(pay.garminFounderActive(), true);
  assert.strictEqual(pay.canUse("starterBubble"), true);
  ["saveBubble", "adoptBubble", "practiceToBag", "bubbleCentre", "offlineCourse"].forEach(function (feature) {
    assert.strictEqual(pay.canUse(feature), false, feature + " must stay on membership");
  });
});

test("without the offer the Starter Bubble stays on membership", () => {
  const free = paymentsClient({ active: false, paymentState: "free_access" });
  assert.strictEqual(free.canUse("starterBubble"), false);
  const member = paymentsClient({ active: true, paymentState: "membership_active" });
  assert.strictEqual(member.canUse("starterBubble"), true);
  assert.strictEqual(member.canUse("bubbleCentre"), true);
});

test("the Bubble save asks for the Starter Bubble only for a Manual Set", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "gd-route-audit.js"), "utf8");
  const start = src.indexOf("function gdBubbleOffsetSave(){");
  const body = src.slice(start, src.indexOf("const offset=Number(pending.offsetDeg)", start));
  assert.ok(/pending\.source==="user_manual_set"\?"starterBubble":"bubbleCentre"/.test(body),
    "gdBubbleOffsetSave must pick starterBubble for a Manual Set and bubbleCentre for everything else");
  assert.ok(body.indexOf("requireAccess(feature)") > body.indexOf("const pending="),
    "the access question must be asked about the pending source being committed");
  const manual = fs.readFileSync(path.join(ROOT, "scripts", "gd-manual-bubble-set.js"), "utf8");
  assert.ok(manual.includes("canUse('starterBubble')"), "Manual Set must ask canUse('starterBubble')");
  assert.ok(!manual.includes("hasActiveAccess"), "Manual Set must not ask for a membership directly");
});

/* ------------------------------------------------- phone: claim + feedback */

function founderModule(options) {
  const store = Object.assign({ gd_accounts_v1: JSON.stringify({ activeId: "acct_1" }) }, options.storage || {});
  const listeners = {};
  const fetches = [];
  const opened = [];
  const appended = [];
  let garmin = options.garmin;
  const w = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    document: {
      readyState: "complete", hidden: false, addEventListener() {},
      getElementById: (id) => appended.filter((n) => n.id === id && !n.removed)[0] || null,
      createElement: () => ({ addEventListener() {}, remove() { this.removed = true; } }),
      body: { append: (n) => appended.push(n) }
    },
    addEventListener() {},
    setTimeout() {},
    GDI18n: { t: (k) => k, apply() {} },
    Capacitor: {
      getPlatform: () => "ios",
      Plugins: { NativeRoundBridge: {
        garminState: async () => garmin,
        addListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); }
      } }
    },
    ClaritySupabaseAuth: { session: () => (options.signedOut ? null : { access_token: "t" }), freshAccessToken: async () => "tok" },
    fetch: async (url, init) => {
      fetches.push({ url: url, init: init });
      return { ok: true, json: async () => ({ created: true, garminFounder: { active: true, since: "2026-10-05T00:00:00.000Z" } }) };
    },
    toast() {}
  };
  if (options.support) w.ClaritySupport = { open: (o) => opened.push(o) };
  w.window = w;
  vm.createContext(w);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "scripts", "clarity-garmin-founder.js"), "utf8"), w);
  return {
    api: w.ClarityGarminFounder, store: store, fetches: fetches, opened: opened, appended: appended, listeners: listeners,
    setGarmin: (g) => { garmin = g; }
  };
}

const READY = { selectedDevice: { deviceId: "d1", model: "fenix 8" }, reachable: true, appInstalled: true };

test("only a chosen, reachable Garmin with Clarity Caddy installed qualifies", () => {
  const { api } = founderModule({ garmin: READY });
  assert.strictEqual(api._garminConnected(READY), true);
  assert.strictEqual(api._garminConnected(Object.assign({}, READY, { appInstalled: undefined })), false);
  assert.strictEqual(api._garminConnected(Object.assign({}, READY, { reachable: false })), false);
  assert.strictEqual(api._garminConnected(Object.assign({}, READY, { selectedDevice: null })), false);
});

test("the claim is sent once per account, with the token", async () => {
  const m = founderModule({ garmin: READY });
  await m.api.check();
  await m.api.check();
  assert.strictEqual(m.fetches.length, 1, "a claimed account must not be re-sent");
  assert.strictEqual(m.fetches[0].url, "/api/garmin-founder");
  assert.strictEqual(m.fetches[0].init.headers.Authorization, "Bearer tok");
  assert.deepStrictEqual(JSON.parse(m.fetches[0].init.body), { platform: "ios", deviceModel: "fenix 8" });
  assert.ok(JSON.parse(m.store["clarity:garmin-founder:v1"]).acct_1);
});

test("no claim when signed out or the watch does not qualify", async () => {
  const out = founderModule({ garmin: READY, signedOut: true });
  await out.api.check();
  assert.strictEqual(out.fetches.length, 0);
  const noApp = founderModule({ garmin: Object.assign({}, READY, { appInstalled: false }) });
  await noApp.api.check();
  assert.strictEqual(noApp.fetches.length, 0);
});

test("a message from the Garmin is noted as use, and leads to one ask", async () => {
  const m = founderModule({ garmin: READY, support: true });
  assert.strictEqual(m.api._shouldAsk(), false, "nothing to ask about before the watch is used");
  m.listeners.watchCommand.forEach((fn) => fn({ command: {} }));
  await new Promise((r) => setImmediate(r));
  const use = JSON.parse(m.store["clarity:garmin-use:v1"]);
  assert.ok(use.usedAt);
  assert.strictEqual(use.deviceModel, "fenix 8");
  assert.strictEqual(m.api._shouldAsk(), true);
  m.api.openFeedback();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(m.opened[0])), { topic: "garmin", deviceModel: "fenix 8" });
});

test("after an ask, the next ask waits for more use and a fortnight", () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const day = 24 * 60 * 60 * 1000;
  const ask = (use) => founderModule({ garmin: READY, storage: { "clarity:garmin-use:v1": JSON.stringify(use) } }).api._shouldAsk();
  assert.strictEqual(ask({ usedAt: iso(now - day), askedAt: iso(now - 2 * day) }), false, "asked too recently");
  assert.strictEqual(ask({ usedAt: iso(now - 20 * day), askedAt: iso(now - 15 * day) }), false, "no use since the last ask");
  assert.strictEqual(ask({ usedAt: iso(now - day), askedAt: iso(now - 15 * day) }), true);
});

test("an Apple Watch message does not count as Garmin use", async () => {
  const m = founderModule({ garmin: { selectedDevice: null, reachable: false } });
  m.listeners.watchCommand.forEach((fn) => fn({ command: {} }));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(m.store["clarity:garmin-use:v1"], undefined);
});

/* -------------------------------------------------- feedback on the server */

test("Garmin feedback tickets are tagged apart from bug reports", async () => {
  delete require.cache[SUPPORT];
  const handler = require(SUPPORT).handler;
  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async function (url, init) {
    sent.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 201, json: async () => [{ id: "t1" }], text: async () => "[{\"id\":\"t1\"}]" };
  };
  try {
    await withEnv({ SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "stub" }, async function () {
      await handler({ httpMethod: "POST", body: JSON.stringify({ happened: "Worked well", topic: "garmin", context: { garmin: { deviceModel: "fenix 8", founder: true } } }) });
      await handler({ httpMethod: "POST", body: JSON.stringify({ happened: "Crash", topic: "anything-else" }) });
    });
  } finally {
    global.fetch = originalFetch;
  }
  const tickets = sent.filter((s) => s.url.includes("/support_tickets")).map((s) => s.body);
  assert.strictEqual(tickets[0].source, "clarity-caddy-garmin-feedback");
  assert.deepStrictEqual(tickets[0].context.garmin, { deviceModel: "fenix 8", founder: true });
  assert.strictEqual(tickets[1].source, "clarity-caddie-beta-report", "an unknown topic is an ordinary report");
});

test("both shells load the Garmin Founder module", () => {
  assert.ok(fs.readFileSync(path.join(ROOT, "index.html"), "utf8").includes("scripts/clarity-garmin-founder.js"));
  assert.ok(fs.readFileSync(path.join(ROOT, "app", "index.html"), "utf8").includes("../scripts/clarity-garmin-founder.js"));
  assert.ok(fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8").includes('from = "/api/garmin-founder"'));
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log("  ok  " + t.name);
    } catch (err) {
      failed += 1;
      console.error("  FAIL " + t.name);
      console.error("       " + (err && err.stack || err));
    }
  }
  if (failed) {
    console.error("garmin-founder failed: " + failed + "/" + tests.length);
    process.exit(1);
  }
  console.log("garmin-founder passed: " + tests.length + " checks");
})();
