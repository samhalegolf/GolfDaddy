#!/usr/bin/env node
"use strict";

/* /api/course-maps used to answer every published course's full record to
   anyone who asked with no scope - about 12 MB, of which objects_json is 11 MB.
   The Studio Course Database pulled all of it on load to draw a table of names
   and status badges, and nothing on that screen displayed the geometry.
   Geometry is opt-in now. These checks pin that down. */

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

let checks = 0;
function ok(name) { checks += 1; console.log("  ok  " + name); }

const LIST_ROW = {
  id: "published::cromwell",
  course_id: "cromwell",
  course_name: "Cromwell Golf Course",
  course_lat: -45.038113,
  course_lng: 169.204844,
  finder_lat: -45.038113,
  finder_lng: 169.204844,
  region: "Otago",
  country: "New Zealand",
  country_code: "NZ",
  facility_key: "cromwell",
  course_aliases: [],
  published: true,
  published_at: "2026-09-09T00:00:00.000Z",
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-09T00:00:00.000Z",
  hole_count: 18,
  object_count: 723,
  tee_count: 18,
  green_count: 18,
  fairway_count: 28
};

const FULL_ROW = {
  id: "published::cromwell",
  course_id: "cromwell",
  course_name: "Cromwell Golf Course",
  course_lat: -45.038113,
  course_lng: 169.204844,
  published: true,
  published_at: "2026-09-09T00:00:00.000Z",
  objects_json: { t1: { type: "tee", holeNumber: 1 }, g1: { type: "green", holeNumber: 1 } },
  holes_json: { 1: { par: 4 } },
  assets_json: {},
  course_json: { courseId: "cromwell", courseName: "Cromwell Golf Course" },
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-09T00:00:00.000Z"
};

(async function run() {
  process.env.SUPABASE_URL = "https://db.example.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  process.env.COURSE_MAPS_ALLOW_BLOB_FALLBACK = "";

  const mod = await import(pathToFileURL(path.join(__dirname, "..", "functions", "course-maps.mjs")).href);

  const asked = [];
  global.fetch = async function (url) {
    const target = String(url);
    asked.push(target);
    const rows = target.includes("course_maps_list") ? [LIST_ROW] : [FULL_ROW];
    return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
  };

  async function get(query) {
    const res = await mod.default(new Request("https://clarity-caddie.test/api/course-maps" + (query || "")));
    assert.equal(res.status, 200);
    return res.json();
  }

  // --- no scope: the list shell ---------------------------------------------
  asked.length = 0;
  const list = await get("");
  const listCourse = list.courses["published::cromwell"];
  assert.equal(list.scope, "list");
  assert.ok(asked.some((u) => u.includes("course_maps_list")), "the list must read the view, not the table");
  assert.ok(!asked.some((u) => u.includes("objects_json")), "no scope must never ask for geometry");
  ok("no scope reads the counts view and never asks for geometry");

  assert.equal(listCourse.objects, undefined, "a list row must not carry objects");
  assert.equal(listCourse.holes, undefined, "a list row must not carry holes");
  assert.equal(listCourse.holeCount, 18);
  assert.equal(listCourse.objectCount, 723);
  assert.deepEqual(
    [listCourse.teeCount, listCourse.greenCount, listCourse.fairwayCount],
    [18, 18, 28]
  );
  ok("a list row carries counts in place of geometry");

  /* undefined, not {}. The Studio screen tells "not loaded" from "nothing
     there" by this exact distinction - an empty object would label a fully
     mapped course "empty". */
  assert.ok(!("objects" in listCourse), "objects must be absent, not an empty object");
  assert.equal(listCourse.courseName, "Cromwell Golf Course");
  assert.equal(listCourse.region, "Otago");
  ok("identity and location still come through for the table");

  // --- one course: what an opened row asks for ------------------------------
  asked.length = 0;
  const one = await get("?courseId=cromwell");
  const oneCourse = one.courses["published::cromwell"];
  assert.equal(one.scope, "course");
  assert.equal(Object.keys(one.courses).length, 1, "one course, not the whole table");
  assert.ok(asked.some((u) => u.includes("course_id=eq.cromwell")), "it must filter to the one course");
  assert.deepEqual(Object.keys(oneCourse.objects).sort(), ["g1", "t1"]);
  assert.deepEqual(Object.keys(oneCourse.holes), ["1"]);
  ok("?courseId returns exactly one course, with its geometry");

  // --- scope=full: the old behaviour, now opt-in ----------------------------
  asked.length = 0;
  const full = await get("?scope=full");
  assert.ok(asked.some((u) => u.includes("objects_json")), "scope=full is the way to ask for geometry");
  assert.ok(full.courses["published::cromwell"].objects, "scope=full still carries geometry");
  ok("scope=full still answers the whole record for anything that needs it");

  // --- scope=play: unchanged for the phone ----------------------------------
  asked.length = 0;
  const play = await get("?scope=play");
  assert.equal(play.scope, "play");
  assert.ok(asked.some((u) => u.includes("objects_json")), "the phone still needs geometry");
  ok("scope=play is untouched - the phone's library sync still works");

  // --- a Supabase failure must not look like an empty database --------------
  global.fetch = async function () {
    return { ok: false, status: 503, text: async () => JSON.stringify({ code: "PGRST002", message: "down" }) };
  };
  const down = await get("");
  assert.equal(down.unavailable, true, "an outage must say so rather than report zero courses");
  assert.deepEqual(down.courses, {});
  assert.ok(down.warnings && down.warnings.length, "and it must carry the reason");
  ok("an outage reports unavailable, not an empty course list");

  // --- the Studio screen must actually hold up its end ----------------------
  const fs = require("fs");
  const adminSrc = fs.readFileSync(path.join(__dirname, "..", "scripts", "studio", "gd-admin-course-db.js"), "utf8");

  assert.ok(
    /fetch\("\/api\/course-maps",\{headers:\{Accept:"application\/json"\},cache:"no-store"\}\)/.test(adminSrc),
    "the table load must ask with no scope, which is now the list"
  );
  assert.ok(
    /fetch\("\/api\/course-maps\?courseId="\+encodeURIComponent\(id\)/.test(adminSrc),
    "geometry must be fetched one course at a time"
  );
  assert.ok(!/scope=full/.test(adminSrc), "the Studio table must never pull every course's geometry again");
  ok("the Studio screen loads a list and fetches geometry per course");

  assert.ok(
    /if\(gdAdminCourseDbExpanded\)\{[\s\S]{0,400}gdAdminCourseDbLoadCourse\(gdAdminCourseDbExpanded\)/.test(adminSrc),
    "opening a row must be what triggers the per-course fetch"
  );
  ok("opening a row is what loads that course's geometry");

  /* holes:c.holes||{} would make every unopened row read as a mapped course
     with zero holes - the same class of bug as the old status default. */
  assert.ok(!/holes:c\.holes\|\|\{\}/.test(adminSrc), "a list row must not be given empty geometry");
  assert.ok(
    /const holes=gdAdminCourseDbCount\(course,"holeCount","holes"\)/.test(adminSrc),
    "status must read the server's counts when geometry is absent"
  );
  ok("an unopened row is never mistaken for an empty course");

  console.log("course-maps-list-scope passed: " + checks + " checks");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
