#!/usr/bin/env node
"use strict";

/* Studio > Marketing > Public Facing Hub: the rules (functions/lib/gd-public-hub-rules.mjs),
   the admin API (functions/public-hub.mjs) and the page's frame matching. No network - fetch
   is a stub. Also keeps the phone deep-link exclusions that make a /courses link open in the
   browser, which arrived with the old Course Database switch this replaces. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
let passed = 0;
const ok = (name) => { passed += 1; console.log("  ok  " + name); };

function course(over) {
  return Object.assign({ courseId: "c", name: "C", countryCode: "NZ", holeCount: 18, objectCount: 300, bunkerCount: 80,
    waterCount: 5, treeCount: 200, published: true, visualPublished: true, pagePublic: false, headerCount: 0 }, over);
}

(async function run() {
  const R = await import(pathToFileURL(path.join(ROOT, "functions", "lib", "gd-public-hub-rules.mjs")).href);

  /* ---- rules ---- */
  const d = R.defaultRules();
  assert.deepStrictEqual(R.ruleMisses(d.autoPublish, course()), []);
  assert.deepStrictEqual(R.ruleMisses(d.autoPublish, course({ visualPublished: false })), ["no published visual"]);
  assert.deepStrictEqual(R.ruleMisses(d.autoPublish, course({ published: false })), ["map not published"]);
  assert.strictEqual(d.autoPublish.headers, false);
  assert.strictEqual(d.autoPublish.enabled, true);
  ok("auto publish starts as the old live condition: published map + published visual, no headers needed");

  const r = R.normalizeRules({ hub: { countries: ["nz", "US", "bad", "NZ"], minTrees: "150", minBunkers: -3, extra: 1 }, held: ["b", "a", "a", ""] });
  assert.deepStrictEqual(r.hub.countries, ["NZ", "US"]);
  assert.strictEqual(r.hub.minTrees, 150);
  assert.strictEqual(r.hub.minBunkers, 0);
  assert.ok(!("extra" in r.hub));
  assert.deepStrictEqual(r.held, ["a", "b"]);
  ok("stored rules are cleaned: country codes, whole minimums, no unknown keys, held de-duplicated");

  assert.deepStrictEqual(R.ruleMisses(r.hub, course({ countryCode: "JP", treeCount: 40 })), ["not in NZ, US", "40 trees (needs 150)"]);
  assert.deepStrictEqual(R.ruleMisses(Object.assign({}, d.hub, { headers: true }), course({ headerCount: 2 })), ["headers 2/3"]);
  ok("a miss says why, in words");

  const rules = R.normalizeRules({ autoPublish: { minTrees: 100 }, held: ["held"] });
  const ev = R.evaluate(rules, [
    course({ courseId: "new" }),
    course({ courseId: "on", pagePublic: true }),
    course({ courseId: "held" }),
    course({ courseId: "thin", treeCount: 10, pagePublic: true }),
    course({ courseId: "novis", visualPublished: false, pagePublic: true })
  ]);
  const plan = R.publishPlan(rules, ev);
  assert.deepStrictEqual(plan.toPublish.map((c) => c.courseId), ["new"]);
  assert.deepStrictEqual(plan.notMatching.map((c) => c.courseId).sort(), ["novis", "thin"]);
  assert.strictEqual(ev.find((c) => c.courseId === "novis").live, false);
  assert.strictEqual(ev.find((c) => c.courseId === "on").live, true);
  rules.autoPublish.enabled = false;
  assert.deepStrictEqual(R.publishPlan(rules, ev).toPublish, []);
  ok("publishing switches on new matches only: never a held course, never takes one down, nothing when disabled");

  /* ---- the API ---- */
  process.env.SUPABASE_URL = "https://db.example.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  const mod = await import(pathToFileURL(path.join(ROOT, "functions", "public-hub.mjs")).href);
  assert.strictEqual(mod.config.path, "/api/public-hub");

  let who = "samhalegolf@gmail.com";
  let stored = { autoPublish: { minTrees: 100 }, held: [] };
  const calls = [];
  const reply = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  global.fetch = async function (url, init) {
    const target = String(url);
    init = init || {};
    calls.push({ url: target, init });
    if (target.includes("/auth/v1/user")) return { ok: !!who, status: who ? 200 : 401, json: async () => ({ id: "u1", email: who }), text: async () => "" };
    if (target.includes("/storage/v1/object/list/")) {
      const prefix = JSON.parse(init.body).prefix;
      if (prefix === "") return reply([{ name: "tara-iti", id: null }]);
      if (prefix === "tara-iti/web") return reply([{ name: "02-head-to-tee.jpg", id: "x" }, { name: "03-approach.jpg", id: "y" }]);
      return reply([]);
    }
    if (target.includes("/storage/v1/object/course-pages/")) return reply({ Key: "ok" });
    if (target.includes("public_hub_settings")) {
      if (init.method === "POST") { stored = JSON.parse(init.body).rules; return reply([]); }
      return reply([{ rules: stored, updated_at: "2026-10-20T00:00:00Z", updated_by: "samhalegolf@gmail.com" }]);
    }
    if (target.includes("course_visuals")) return reply([{ course_id: "tara-iti" }, { course_id: "parkes" }]);
    if (target.includes("course_maps")) {
      if (init.method === "PATCH") {
        const ids = decodeURIComponent(target.match(/in\.\(([^)]*)\)/)[1]).split(",").map((s) => s.replace(/"/g, ""));
        return reply(ids.filter((id) => id !== "nowhere").map((id) => ({ course_id: id })));
      }
      return reply([
        { course_id: "tara-iti", course_name: "Tara Iti", country_code: "NZ", hole_count: 18, object_count: 741, bunker_count: 537, water_count: 1, tree_count: 260, published: true, page_public: true },
        { course_id: "parkes", course_name: "Parkes", country_code: "AU", hole_count: 18, object_count: 300, bunker_count: 40, water_count: 3, tree_count: 120, published: true, page_public: false },
        { course_id: "thin", course_name: "Thin", country_code: "NZ", hole_count: 9, object_count: 20, bunker_count: 1, water_count: 0, tree_count: 2, published: true, page_public: false }
      ]);
    }
    return reply([]);
  };
  const req = (method, body, bearer = "tok") => mod.default(new Request("https://caddy.test/api/public-hub", { method, headers: Object.assign({ "Content-Type": "application/json" }, bearer ? { Authorization: "Bearer " + bearer } : {}), body: body ? JSON.stringify(body) : undefined }));

  let res = await req("GET");
  assert.strictEqual(res.status, 200);
  let got = await res.json();
  const tara = got.courses.find((c) => c.courseId === "tara-iti");
  assert.strictEqual(tara.headerCount, 2);
  assert.strictEqual(tara.live, true);
  assert.strictEqual(got.courses.find((c) => c.courseId === "thin").autoMatch, false);
  assert.deepStrictEqual(got.publish.toPublish.map((c) => c.courseId), ["parkes"]);
  ok("GET answers every course with its header count, page state and what publishing would do");

  calls.length = 0;
  res = await req("POST", { action: "publish", dryRun: true });
  assert.deepStrictEqual((await res.json()).toPublish.map((c) => c.courseId), ["parkes"]);
  assert.ok(!calls.some((c) => c.init.method === "PATCH"), "a dry run wrote");
  res = await req("POST", { action: "publish" });
  got = await res.json();
  assert.deepStrictEqual(got.published, ["parkes"]);
  const patch = calls.find((c) => c.init.method === "PATCH");
  assert.deepStrictEqual(JSON.parse(patch.init.body), { page_public: true }, "only page_public is written");
  ok("publishing writes page_public on the matches and nothing else; a dry run writes nothing");

  res = await req("POST", { action: "page", courseId: "tara-iti", pagePublic: false });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(stored.held, ["tara-iti"]);
  res = await req("POST", { action: "rules", rules: { hub: { countries: ["NZ"] }, held: [] } });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(stored.held, ["tara-iti"], "a rules save dropped the held list");
  assert.deepStrictEqual(stored.hub.countries, ["NZ"]);
  res = await req("POST", { action: "page", courseId: "tara-iti", pagePublic: true });
  assert.deepStrictEqual(stored.held, []);
  res = await req("POST", { action: "page", courseId: "nowhere", pagePublic: true });
  assert.strictEqual(res.status, 404);
  res = await req("POST", { action: "page", courseId: "tara-iti", pagePublic: "yes" });
  assert.strictEqual(res.status, 400);
  ok("taking a page down holds it, switching it on releases it, and a rules save keeps the held list");

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
  calls.length = 0;
  res = await req("POST", { action: "header", courseId: "tara-iti", frame: "02-head-to-tee", jpegBase64: jpeg });
  assert.strictEqual(res.status, 200);
  assert.ok(calls.some((c) => /\/storage\/v1\/object\/course-pages\/tara-iti\/web\/02-head-to-tee\.jpg$/.test(c.url)));
  res = await req("POST", { action: "header", courseId: "tara-iti", frame: "og", jpegBase64: jpeg });
  assert.strictEqual(res.status, 400);
  res = await req("POST", { action: "header", courseId: "tara-iti", frame: "03-approach", jpegBase64: Buffer.from("<svg/>").toString("base64") });
  assert.strictEqual(res.status, 400);
  res = await req("POST", { action: "header", courseId: "../x", frame: "03-approach", jpegBase64: jpeg });
  assert.strictEqual(res.status, 400);
  ok("a header is one JPEG frame at <course>/web/<frame>.jpg - nothing else is stored");

  who = "";
  assert.strictEqual((await req("GET")).status, 403);
  who = "someone@example.com";
  assert.strictEqual((await req("POST", { action: "publish" })).status, 403);
  ok("no session or a non-admin is refused");

  /* ---- the Studio page ---- */
  global.window = {};
  require(path.join(ROOT, "scripts", "studio", "marketing", "public-hub-page.js"));
  const frames = R.HEADER_FRAMES;
  const f = (name) => ({ name });
  const pick = (names) => window.GDPublicHubPage.assignFrames(names.map(f), frames).map((p) => p.file.name + ">" + p.frame);
  assert.deepStrictEqual(pick(["03-approach.png", "01-pre-lock.png", "02-head-to-tee.png"]), ["03-approach.png>03-approach", "01-pre-lock.png>01-pre-lock", "02-head-to-tee.png>02-head-to-tee"]);
  assert.deepStrictEqual(pick(["shot 2.png"]), ["shot 2.png>02-head-to-tee"]);
  assert.deepStrictEqual(pick(["a.png", "b.png"]), ["a.png>01-pre-lock", "b.png>02-head-to-tee"]);
  ok("dropped files find their frame by name, else fill the frames in order");

  const studio = read("scripts", "studio", "gd-admin-course-db.js");
  assert.ok(!/gdAdminCoursePageSwitch|action:"page"/.test(studio), "the old Course Database switch is still there");
  assert.ok(!/action === "page"/.test(read("functions", "course-maps.mjs")), "course-maps still has the page action");
  ok("the page switch lives only in the hub");

  const aasa = JSON.parse(read(".well-known", "apple-app-site-association"));
  const components = aasa.applinks.details[0].components;
  assert.deepStrictEqual(components.map((c) => [c["/"], !!c.exclude]), [["/courses/*", true], ["/*", false]], "iOS must leave /courses/* to the browser and keep claiming the rest");
  const manifest = read("android", "app", "src", "main", "AndroidManifest.xml");
  assert.ok(!/android:host="caddy\.claritygolf\.app" \/>/.test(manifest), "Android still claims the whole host");
  assert.ok(/android:host="caddy\.claritygolf\.app" android:path="\/" \/>/.test(manifest), "Android must still claim the root shell the auth links use");
  ok("a course page link opens in the browser on a phone with the app installed");

  console.log(passed + " checks passed");
})().catch((error) => { console.error(error); process.exit(1); });
