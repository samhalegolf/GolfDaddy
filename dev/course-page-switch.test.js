#!/usr/bin/env node
"use strict";

/* The Studio's "Course page" switch: POST /api/course-maps {action:"page"} flips
   course_maps.page_public and nothing else, admin only; the list row says which way it is;
   the Studio rail draws the switch from the cloud row. No network - fetch is a stub. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
let passed = 0;
const ok = (name) => { passed += 1; console.log("  ok  " + name); };

(async function run() {
  process.env.SUPABASE_URL = "https://db.example.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  process.env.COURSE_MAPS_ALLOW_BLOB_FALLBACK = "";
  const mod = await import(pathToFileURL(path.join(ROOT, "functions", "course-maps.mjs")).href);

  const calls = [];
  let who = "samhalegolf@gmail.com";
  global.fetch = async function (url, init) {
    const target = String(url);
    calls.push({ url: target, init: init || {} });
    if (target.includes("/auth/v1/user")) return { ok: !!who, status: who ? 200 : 401, json: async () => ({ id: "u1", email: who }), text: async () => "" };
    if (target.includes("course_maps_list")) return { ok: true, status: 200, text: async () => JSON.stringify([{ id: "published::tara-iti", course_id: "tara-iti", course_name: "Tara Iti", course_lat: -36.2, course_lng: 174.6, hole_count: 18, page_public: true }, { id: "published::parkes", course_id: "parkes", course_name: "Parkes Golf Club", course_lat: -33, course_lng: 148, hole_count: 18, page_public: false }]) };
    if ((init || {}).method === "PATCH") {
      const body = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify(target.includes("course_id=eq.nowhere") ? [] : [{ course_id: "tara-iti", page_public: body.page_public }]) };
    }
    return { ok: true, status: 200, text: async () => "[]" };
  };

  const post = (body, bearer) => mod.default(new Request("https://caddy.test/api/course-maps", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, bearer ? { Authorization: "Bearer " + bearer } : {}), body: JSON.stringify(body) }));

  const list = await (await mod.default(new Request("https://caddy.test/api/course-maps"))).json();
  assert.strictEqual(list.courses["published::tara-iti"].pagePublic, true);
  assert.strictEqual(list.courses["published::parkes"].pagePublic, false);
  ok("the list row says whether the course page is on");

  calls.length = 0;
  let res = await post({ action: "page", courseId: "tara-iti", pagePublic: false }, "tok");
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { ok: true, action: "page", courseId: "tara-iti", pagePublic: false });
  const patch = calls.find((c) => c.init.method === "PATCH");
  assert.ok(patch && /course_maps\?course_id=eq\.tara-iti/.test(patch.url), "the patch must hit the one row");
  assert.deepStrictEqual(JSON.parse(patch.init.body), { page_public: false }, "only page_public is written");
  ok("an admin flips the switch and nothing else on the row is touched");

  res = await post({ action: "page", courseId: "tara-iti", pagePublic: "yes" }, "tok");
  assert.strictEqual(res.status, 400);
  res = await post({ action: "page", courseId: "nowhere", pagePublic: true }, "tok");
  assert.strictEqual(res.status, 404);
  ok("a non-boolean is refused and an unknown course is a 404");

  who = "";
  res = await post({ action: "page", courseId: "tara-iti", pagePublic: true }, "tok");
  assert.strictEqual(res.status, 403);
  who = "someone@example.com";
  res = await post({ action: "page", courseId: "tara-iti", pagePublic: true }, "tok");
  assert.strictEqual(res.status, 403);
  ok("no session or a non-admin cannot flip it");

  const studio = read("scripts", "studio", "gd-admin-course-db.js");
  assert.ok(/\$\{gdAdminCoursePageSwitch\(selected\)\}/.test(studio), "the rail does not draw the switch");
  assert.ok(/cloud\.pagePublic===true/.test(studio) && /action:"page",courseId:courseId,pagePublic:next/.test(studio), "the switch does not post the page action");
  assert.ok(!/gdAdminEsc\(/.test(studio), "gdAdminEsc does not exist");
  assert.ok(/gdAdminCoursePageLink" title="Open the public page in a new tab"/.test(studio), "no Open link beside the switch");
  ok("the Studio rail carries the switch and posts the page action");

  const aasa = JSON.parse(read(".well-known", "apple-app-site-association"));
  const components = aasa.applinks.details[0].components;
  assert.deepStrictEqual(components.map((c) => [c["/"], !!c.exclude]), [["/courses/*", true], ["/*", false]], "iOS must leave /courses/* to the browser and keep claiming the rest");
  const manifest = read("android", "app", "src", "main", "AndroidManifest.xml");
  assert.ok(!/android:host="caddy\.claritygolf\.app" \/>/.test(manifest), "Android still claims the whole host");
  assert.ok(/android:host="caddy\.claritygolf\.app" android:path="\/" \/>/.test(manifest), "Android must still claim the root shell the auth links use");
  ok("a course page link opens in the browser on a phone with the app installed");

  console.log(passed + " checks passed");
})().catch((error) => { console.error(error); process.exit(1); });
