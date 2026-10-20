#!/usr/bin/env node
"use strict";

/* The public watch preview (watch-preview.html, scripts/clarity-watch-preview.js,
   functions/watch-preview-request.mjs): the page's scripts exist and deploy, the landing page
   links to it, the three positions land where they say, and the sign-up request is stored
   and mailed - or refused with a reason - without any network. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const preview = require(path.join(ROOT, "scripts/clarity-watch-preview.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("the page loads only scripts that exist, and that the deploy copies", () => {
  const html = read("watch-preview.html");
  const refs = [...html.matchAll(/(?:src|href)="([^"#?]+)/g)].map((m) => m[1]).filter((r) => !/^(https?:)?\/\//.test(r) && /\.(js|css)$/.test(r));
  assert.ok(refs.length >= 8, "expected the watch renderers and the page script to be loaded");
  refs.forEach((ref) => assert.ok(fs.existsSync(path.join(ROOT, ref)), ref + " is referenced but does not exist"));
  const deploy = read("scripts", "clarity-deploy-build.js");
  refs.forEach((ref) => assert.ok(/^(scripts|assets)\//.test(ref), ref + " is outside the deployed scripts/ and assets/ trees"));
  assert.ok(/"watch-preview\.html"/.test(deploy), "the deploy build does not copy watch-preview.html");
  assert.ok(/NON_APP_FILES = \[[^\]]*"watch-preview\.html"/.test(deploy), "the phone build would ship watch-preview.html");
  assert.ok(/\["watch-preview\.html"\]\.forEach[\s\S]*stampContentVersions/.test(deploy), "the deployed page's script versions are not content-stamped");
  assert.ok(/id="gate"/.test(html) && /id="preview"[^>]*hidden/.test(html), "the preview is not behind the gate");
  ["tee", "long", "short"].forEach((p) => assert.ok(html.includes('data-preset="' + p + '"'), "no " + p + " position button"));
});

/* The preview's scripts run on three pages at three depths: / (watch-preview.html), /studio/
   and a public course page at /courses/<id> (functions/course-page.mjs). What they fetch at
   runtime has to be root-absolute: a relative "app/js/..." resolved under /courses/ 404s, the
   Bubble Engine never loads, and AIM silently locks the shot instead of opening the map. */
test("the preview's runtime fetches are root-absolute, so they work under /courses/<id>", () => {
  const page = read("scripts/studio/gps-play/watch-preview/watch-preview-page.js");
  const garmin = read("scripts/studio/gps-play/garmin-preview/garmin-preview-page.js");
  assert.ok(page.includes('fetch("/app/js/distance.js")') && page.includes('fetch("/app/js/bubble-engine.js")'), "the Bubble Engine is not fetched from the site root");
  assert.ok(garmin.includes('spriteImage("/garmin/resources-trees/'), "the tree sprites are not fetched from the site root");
  [page, garmin, read("scripts/studio/gps-play/apple-preview/apple-preview-page.js"), read("scripts/clarity-watch-preview.js")].forEach((src) => {
    const relative = [...src.matchAll(/(?:fetch|spriteImage)\("(?!\/|https?:)([^"]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(relative, [], "relative runtime fetches: " + relative.join(", "));
  });
  const course = read("functions/course-page.mjs");
  assert.ok(!/<base\b/i.test(course), "the course page must not need a <base> to make the scripts work");
  const script = read("scripts/clarity-watch-preview.js");
  assert.ok(/state\.mount\.problem/.test(script), "the public readout does not show the face's problem line");
});

test("the landing page links to the preview, translated", () => {
  const welcome = read("welcome.html");
  assert.ok(/href="watch-preview\.html"[^>]*data-i18n="welcome\.watchPreviewLink"/.test(welcome), "welcome.html has no translated link to the preview");
  fs.readdirSync(path.join(ROOT, "scripts/i18n")).filter((f) => f.endsWith(".js")).forEach((f) => {
    assert.ok(read("scripts/i18n", f).includes('"welcome.watchPreviewLink"'), f + " lacks the link's words");
  });
});

test("the three positions stand on the hole's play line", () => {
  /* A straight 360 m hole heading north, with one route point in the middle. */
  const tee = { lat: -45.0300, lng: 168.7200 };
  const mid = { lat: -45.0300 + 180 / 111320, lng: 168.7200 };
  const green = { lat: -45.0300 + 360 / 111320, lng: 168.7200 };
  const hole = { holeNumber: 1, skeleton: { t: tee, r: [mid], g: green } };
  const m = (a, b) => preview.pointShortOfGreen([a, b], 0) && 111320 * Math.abs(a.lat - b.lat);
  assert.deepStrictEqual(preview.positionFor("tee", hole), tee);
  const long = preview.positionFor("long", hole), short = preview.positionFor("short", hole);
  assert.ok(Math.abs(m(long, green) - preview.LONG_APPROACH_M) < 1, "long approach is " + m(long, green) + " m out");
  assert.ok(Math.abs(m(short, green) - preview.SHORT_APPROACH_M) < 1, "short approach is " + m(short, green) + " m out");
  assert.ok(long.lat < short.lat, "the long approach is further from the green than the short one");
  /* A par 3 shorter than the walk starts on the tee; a hole with no route has nowhere to stand. */
  const par3 = { skeleton: { t: tee, r: [], g: { lat: -45.0300 + 120 / 111320, lng: 168.7200 } } };
  assert.deepStrictEqual(preview.positionFor("long", par3), tee);
  assert.strictEqual(preview.positionFor("short", { skeleton: { t: null, r: [], g: green } }), null);
  assert.strictEqual(preview.positionFor("tee", null), null);
});

test("the sign-up request is stored and mailed, or refused with a reason", async () => {
  const fn = await import(path.join(ROOT, "functions/watch-preview-request.mjs"));
  assert.strictEqual(fn.config.path, "/api/watch-preview-request");
  const req = (body, method) => new Request("https://caddy.test/api/watch-preview-request", { method: method || "POST", headers: { "Content-Type": "application/json", referer: "https://caddy.test/watch-preview.html" }, body: body == null ? undefined : JSON.stringify(body) });
  assert.strictEqual((await fn.handleRequest(req(null, "GET"))).status, 405);
  let res = await fn.handleRequest(req({ email: "sam@example.com" }));
  assert.strictEqual(res.status, 400); assert.strictEqual((await res.json()).code, "name_required");
  res = await fn.handleRequest(req({ name: "Sam", email: "not-an-email" }));
  assert.strictEqual(res.status, 400); assert.strictEqual((await res.json()).code, "invalid_email");

  const built = fn.buildTicket({ name: " Sam ", email: "SAM@Example.com", watch: "apple", note: "fenix owner" }, { referer: "https://caddy.test/watch-preview.html" });
  assert.strictEqual(built.ticket.source, "clarity-caddy-watch-preview-request");
  assert.strictEqual(built.ticket.contact, "sam@example.com");
  assert.strictEqual(built.ticket.context.watch, "apple");
  assert.ok(built.ticket.happened.includes("Sam") && built.ticket.happened.includes("Apple Watch"));
  assert.strictEqual(fn.buildTicket({ name: "Sam", email: "sam@example.com", watch: "casio" }).ticket.context.watch, "", "an unknown watch is not recorded as one");
  const mail = fn.renderEmail(built.ticket, "t-1");
  assert.ok(mail.subject.includes("Sam") && mail.text.includes("sam@example.com") && mail.html.includes("fenix owner"));

  /* Nothing configured: an honest 503, never a silent 200. */
  const saved = {};
  ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "RESEND_API_KEY"].forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  try {
    res = await fn.handleRequest(req({ name: "Sam", email: "sam@example.com", watch: "garmin" }), async () => { throw new Error("no network in this test"); });
    assert.strictEqual(res.status, 503);
    /* Configured: one row in support_tickets, one email through Resend, both recorded. */
    process.env.SUPABASE_URL = "https://db.test"; process.env.SUPABASE_SERVICE_ROLE_KEY = "service"; process.env.RESEND_API_KEY = "re_test";
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url.startsWith("https://db.test/rest/v1/support_tickets")) return { ok: true, json: async () => [{ id: "row-1" }] };
      if (url === "https://api.resend.com/emails") return { ok: true, json: async () => ({ id: "mail-1" }) };
      throw new Error("unexpected fetch " + url);
    };
    res = await fn.handleRequest(req({ name: "Sam", email: "sam@example.com", watch: "garmin" }), fakeFetch);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true, requestId: "row-1", stored: true, emailed: true });
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].body.source, "clarity-caddy-watch-preview-request");
    assert.strictEqual(calls[1].body.reply_to, "sam@example.com");
    assert.ok(calls[1].body.subject.includes("row-1"));
  } finally {
    Object.keys(saved).forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  }
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.stack || err)); }
  }
  console.log(failed ? failed + " failed" : tests.length + "/" + tests.length + " passed");
  process.exit(failed ? 1 : 0);
})();
