/* The email ask before the first course search.
 *   - functions/course-map-contact.mjs stores one row per address, links a signed-in player,
 *     and refuses a bad address;
 *   - scripts/gd-course-search-email.js asks once per device, never asks a signed-in player,
 *     lets the player skip, and posts the address when they give one;
 *   - the picker waits on it before a typed search, then runs that search.
 * Supabase and Supabase Auth are stubbed at the fetch layer, so this is hermetic. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function stubFetch(world) {
  world.writes = [];
  global.fetch = async (url, options = {}) => {
    url = String(url);
    if (url.includes("/auth/v1/user")) return world.user ? jsonResponse(200, world.user) : jsonResponse(401, {});
    const rest = url.split("/rest/v1/")[1] || "";
    const method = String(options.method || "GET").toUpperCase();
    if (method !== "GET") {
      if (world.writeStatus) return jsonResponse(world.writeStatus, { message: "down" });
      world.writes.push({ table: rest.split("?")[0], query: rest, body: JSON.parse(options.body) });
      return jsonResponse(201, null);
    }
    return jsonResponse(200, []);
  };
}

let mod = null;
function post(body, headers) {
  return new Request("https://x.test/api/course-map-contact", { method: "POST", headers: headers || {}, body: JSON.stringify(body) });
}

/* ---- Server ---- */

test("stores the address, lower-cased, upserted on email", async () => {
  const world = {};
  stubFetch(world);
  const res = await mod.default(post({ email: "  Sam@Example.COM " }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(world.writes.length, 1);
  assert.strictEqual(world.writes[0].table, "course_map_update_contacts");
  assert.ok(world.writes[0].query.includes("on_conflict=email"));
  assert.strictEqual(world.writes[0].body.email, "sam@example.com");
  assert.ok(!("user_id" in world.writes[0].body), "no sign-in, no user id - and never a null that clears one");
});

test("a signed-in player's row is linked to their account", async () => {
  const world = { user: { id: "u-1", email: "sam@example.com" } };
  stubFetch(world);
  const res = await mod.default(post({ email: "sam@example.com" }, { Authorization: "Bearer token" }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(world.writes[0].body.user_id, "u-1");
});

test("a bad address writes nothing", async () => {
  const world = {};
  stubFetch(world);
  for (const email of [undefined, "", "not-an-email", "a@b"]) {
    assert.strictEqual((await mod.default(post({ email }))).status, 400, JSON.stringify(email));
  }
  assert.strictEqual(world.writes.length, 0);
});

test("a database failure is reported, not swallowed", async () => {
  stubFetch({ writeStatus: 500 });
  assert.strictEqual((await mod.default(post({ email: "a@example.com" }))).status, 502);
});

/* ---- Client ---- */

const CLIENT = fs.readFileSync(path.join(root, "scripts", "gd-course-search-email.js"), "utf8");

function fakeElement(tag) {
  const el = {
    tag, id: "", className: "", innerHTML: "", value: "", disabled: false, onclick: null, onkeydown: null,
    attrs: {}, children: [], textContent: "",
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); }
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(child) { this.children.push(child); return child; },
    focus() {},
    querySelector(sel) {
      el.parts = el.parts || {};
      if (!el.parts[sel]) el.parts[sel] = fakeElement("part");
      if (sel === "[data-gd-search-email]" && el.parts[sel].value === "") {
        const m = /data-gd-search-email [^>]*value="([^"]*)"/.exec(el.innerHTML);
        el.parts[sel].value = m ? m[1] : "";
      }
      return el.parts[sel];
    }
  };
  el.className.split(" ").forEach(c => c && el.classList.add(c));
  return el;
}

function bootClient({ account = null, storage = {} } = {}) {
  const byId = {};
  const body = fakeElement("body");
  const document = {
    head: fakeElement("head"), body,
    createElement: tag => fakeElement(tag),
    getElementById: id => byId[id] || null
  };
  body.appendChild = child => { byId[child.id] = child; child.className.split(" ").forEach(c => c && child.classList.add(c)); return child; };
  document.head.appendChild = child => { byId[child.id] = child; return child; };
  const data = Object.assign({}, storage);
  const posts = [];
  const window = {
    document,
    localStorage: { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: k => { delete data[k]; } },
    GDI18n: { t: k => k, html: k => k },
    GolfDaddyAccounts: { current: () => account },
    fetch: async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({}) }; },
    setTimeout: () => 0,
    toast: () => {}
  };
  window.window = window;
  vm.runInContext(CLIENT, vm.createContext(window));
  return { window, data, posts, card: () => byId.gdCourseSearchEmailCard };
}

test("a signed-in player is never asked", async () => {
  const { window } = bootClient({ account: { email: "sam@example.com" } });
  assert.strictEqual(window.GDCourseSearchEmail.needed(), false);
});

test("skipping lets the search run and is remembered", async () => {
  const { window, data, posts, card } = bootClient();
  assert.strictEqual(window.GDCourseSearchEmail.needed(), true);
  const done = window.GDCourseSearchEmail.ask();
  assert.ok(!card().classList.contains("hidden"), "the card is showing");
  card().querySelector("[data-gd-search-email-skip]").onclick();
  await done;
  assert.ok(card().classList.contains("hidden"));
  assert.strictEqual(posts.length, 0, "skipping sends nothing");
  assert.strictEqual(data.gd_course_search_email_v1, "skipped");
  assert.strictEqual(window.GDCourseSearchEmail.needed(), false);
});

test("giving an address posts it once and is remembered", async () => {
  const { window, data, posts, card } = bootClient();
  const done = window.GDCourseSearchEmail.ask();
  card().querySelector("[data-gd-search-email]").value = " Sam@Example.com ";
  await card().querySelector("[data-gd-search-email-go]").onclick();
  await done;
  assert.deepStrictEqual(posts.map(p => [p.url, p.body.email]), [["/api/course-map-contact", "sam@example.com"]]);
  assert.strictEqual(data.gd_course_search_email_v1, "given");
  assert.strictEqual(data.gd_course_map_notify_email_v1, JSON.stringify("sam@example.com"), "the map-notify card starts with it");
  assert.strictEqual(window.GDCourseSearchEmail.needed(), false);
});

test("a device that already answered is not asked again", async () => {
  const { window } = bootClient({ storage: { gd_course_search_email_v1: "skipped" } });
  assert.strictEqual(window.GDCourseSearchEmail.needed(), false);
});

/* ---- Picker wiring ---- */

test("the picker asks before a typed search, then runs it", async () => {
  const picker = fs.readFileSync(path.join(root, "scripts", "inline", "gd-course-picker-search-v2.js"), "utf8");
  const owner = picker.slice(picker.indexOf("function searchOwner("), picker.indexOf("function confirmAmbiguous("));
  const gate = owner.indexOf("askEmail.needed()");
  assert.ok(gate > 0, "searchOwner checks GDCourseSearchEmail");
  assert.ok(gate < owner.indexOf("++searchRun"), "before a search run starts");
  assert.ok(/askEmail\.ask\(\)\.then\(\(\)=>searchOwner\(requested\)\)/.test(owner), "and runs the same search afterwards");
  const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const script = index.indexOf("scripts/gd-course-search-email.js");
  assert.ok(script > 0 && script < index.indexOf("scripts/inline/gd-course-picker-search-v2.js"), "loaded before the picker");
});

(async () => {
  process.env.SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service";
  mod = await import(path.join(root, "functions", "course-map-contact.mjs"));
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("ok - " + t.name); }
    catch (error) { failed++; console.error("not ok - " + t.name + "\n", error); }
  }
  if (failed) { console.error(failed + " failed"); process.exit(1); }
  console.log("course-search-email: " + tests.length + " passed");
})();
