#!/usr/bin/env node
"use strict";

/* 18 Sep 2026, 08:13-08:27 UTC: every read of the caddy database failed for a
   quarter of an hour and the Studio fell back to its local cache. Nothing was
   wrong with the data. Three of our own request patterns had filled
   PostgREST's connection pool:

     1. /api/course-mapper-jobs (no courseId) read objects_json and holes_json
        for every course - 12 MB - to ask whether each had geometry.
     2. Every Studio row polled /api/course-visual-jobs?courseId= for itself,
        three Supabase reads per row, and asked again as soon as a poll failed.
     3. Every phone whose manifest went stale pulled the whole library through
        /api/course-maps?scope=play at once.

   These checks pin down the shape of each request now. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
let checks = 0;
function ok(name) { checks += 1; console.log("  ok  " + name); }

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function stubTables(world, asked) {
  global.fetch = async function (url) {
    const target = String(url);
    asked.push(target);
    const rest = target.split("/rest/v1/")[1] || "";
    const table = rest.split("?")[0];
    if (table === "course_maps_list") {
      return jsonResponse(200, (world.maps || []).map((row) => ({
        id: "published::" + row.course_id,
        course_id: row.course_id,
        course_name: row.course_name || row.course_id,
        published: row.published !== false,
        hole_count: Object.keys(row.holes_json || {}).length,
        object_count: Object.keys(row.objects_json || {}).length,
        updated_at: row.updated_at || "2026-09-09T00:00:00.000Z"
      })));
    }
    if (table === "course_maps") {
      let rows = world.maps || [];
      const inList = /course_id=in\.\(([^)]*)\)/.exec(rest);
      if (inList) {
        const wanted = inList[1].split(",").map((s) => s.replace(/"/g, ""));
        rows = rows.filter((row) => wanted.indexOf(row.course_id) >= 0);
      }
      return jsonResponse(200, rows);
    }
    /* PostgREST filters; a single-course read must not see every course's rows. */
    const eq = /course_id=eq\.([^&]+)/.exec(rest);
    const only = (rows) => eq ? rows.filter((row) => row.course_id === decodeURIComponent(eq[1])) : rows;
    if (table === "course_visuals") return jsonResponse(200, only(world.visuals || []));
    if (table === "course_visual_jobs") return jsonResponse(200, only(world.visualJobs || []));
    if (table === "course_mapper_jobs") return jsonResponse(200, only(world.mapperJobs || []));
    return jsonResponse(200, []);
  };
}

const MAPPED = {
  id: "published::cromwell", course_id: "cromwell", course_name: "Cromwell Golf Course", published: true,
  objects_revision: 3, geometry_version: "v2",
  objects_json: { t1: { type: "tee", holeNumber: 1 }, g1: { type: "green", holeNumber: 1 } },
  holes_json: { 1: { par: 4 } }, course_json: {}, assets_json: {},
  published_at: "2026-09-09T00:00:00.000Z", updated_at: "2026-09-09T00:00:00.000Z"
};
const STUB = {
  id: "published::north-shore", course_id: "north-shore", course_name: "North Shore", published: true,
  objects_revision: null, objects_json: {}, holes_json: {}, course_json: {}, assets_json: {},
  published_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-10T00:00:00.000Z"
};

(async function run() {
  process.env.SUPABASE_URL = "https://db.example.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  process.env.COURSE_MAPS_ALLOW_BLOB_FALLBACK = "";

  const mapperJobs = (await import(pathToFileURL(path.join(ROOT, "functions", "course-mapper-jobs.mjs")).href)).default;
  const visualJobs = (await import(pathToFileURL(path.join(ROOT, "functions", "course-visual-jobs.mjs")).href)).default;
  const courseMaps = (await import(pathToFileURL(path.join(ROOT, "functions", "course-maps.mjs")).href)).default;
  const get = (fn, url) => fn(new Request(url)).then(async (res) => ({ status: res.status, body: JSON.parse(await res.text()) }));

  // --- 1. the mapper list never reads geometry --------------------------------
  let asked = [];
  stubTables({ maps: [MAPPED, STUB], mapperJobs: [{ course_id: "north-shore", kind: "automap", status: "failed", error: "no holes found", created_at: "2026-09-10T00:00:00Z" }] }, asked);
  let all = await get(mapperJobs, "https://clarity.example/api/course-mapper-jobs");
  assert.strictEqual(all.status, 200);
  assert.ok(!asked.some((u) => u.includes("objects_json")), "the list must not read objects_json: " + asked.join("\n"));
  assert.ok(asked.some((u) => u.includes("course_maps_list") && u.includes("object_count")), "it reads the counts view");
  assert.strictEqual(all.body.courses.cromwell.state, "geometry-ready");
  assert.strictEqual(all.body.courses.cromwell.hasGeometry, true);
  assert.strictEqual(all.body.courses["north-shore"].state, "failed");
  assert.strictEqual(all.body.courses["north-shore"].lastError, "no holes found");
  ok("every course's mapping state comes from the counts view, not 12 MB of geometry");

  asked = [];
  let one = await get(mapperJobs, "https://clarity.example/api/course-mapper-jobs?courseId=cromwell");
  assert.strictEqual(one.body.state, "geometry-ready");
  assert.strictEqual(one.body.geometryVersion, "v2");
  assert.ok(!asked.some((u) => u.includes("objects_json")), "one course's state must not read its geometry either");
  ok("a single course's mapping state keeps its geometry version without reading the map");

  // --- 2. every course's build state in one request ----------------------------
  asked = [];
  stubTables({
    maps: [MAPPED, STUB],
    visuals: [{ course_id: "cromwell", published_version: 4, bake_number: 2, bake_objects_revision: 3, status: "published" }],
    visualJobs: [
      { course_id: "north-shore", id: "j2", kind: "snapshot", status: "running", updated_at: new Date().toISOString(), created_at: "2026-09-18T00:00:01Z", result: { progress: { capturesDone: 3, capturesTotal: 18 } } },
      { course_id: "cromwell", id: "j1", kind: "export", status: "done", created_at: "2026-09-18T00:00:00Z" }
    ],
    mapperJobs: []
  }, asked);
  const bulk = await get(visualJobs, "https://clarity.example/api/course-visual-jobs");
  assert.strictEqual(bulk.status, 200);
  const restReads = asked.filter((u) => u.includes("/rest/v1/"));
  assert.ok(restReads.length <= 4, "the whole table costs at most four reads, not three per row: " + restReads.length);
  assert.ok(!asked.some((u) => u.includes("objects_json")), "and none of them is the geometry");
  assert.strictEqual(bulk.body.courses.cromwell.state, "frames-ready");
  assert.strictEqual(bulk.body.courses.cromwell.framesReady, true);
  /* v<bake_number>.<objects_revision - bake_objects_revision>: scripts/gd-course-version-label.js */
  assert.strictEqual(bulk.body.courses.cromwell.framesVersionLabel, "v2.0");
  assert.strictEqual(bulk.body.courses["north-shore"].state, "running");
  assert.strictEqual(bulk.body.courses["north-shore"].building, true);
  assert.strictEqual(bulk.body.courses["north-shore"].activeKind, "snapshot");
  assert.deepStrictEqual(bulk.body.courses["north-shore"].progress, { capturesDone: 3, capturesTotal: 18 });
  assert.ok(!("jobs" in bulk.body.courses.cromwell), "a table row carries no job history");
  ok("GET with no courseId answers every course's build state in one request");

  const single = await get(visualJobs, "https://clarity.example/api/course-visual-jobs?courseId=cromwell");
  const row = bulk.body.courses.cromwell;
  ["state", "framesReady", "framesVersion", "framesVersionLabel", "building", "activeKind", "snapshotReady", "exportReady", "failedStage", "lastError", "hasGeometry"].forEach((key) => {
    assert.deepStrictEqual(single.body[key], row[key], "single and bulk disagree on " + key);
  });
  ok("a row and its detail panel derive the same words from the same rows");

  // --- 3. the phone asks for the courses that changed ---------------------------
  asked = [];
  stubTables({ maps: [MAPPED, STUB] }, asked);
  const subset = await get(courseMaps, "https://clarity.example/api/course-maps?scope=play&courseIds=cromwell,cromwell,%20Not%20A%20Course%20");
  assert.strictEqual(subset.status, 200);
  assert.strictEqual(subset.body.scope, "play");
  assert.strictEqual(subset.body.partial, true);
  assert.deepStrictEqual(subset.body.requested, ["cromwell", "not-a-course"]);
  assert.deepStrictEqual(Object.keys(subset.body.courses), ["published::cromwell"]);
  assert.ok(asked.some((u) => u.includes('course_id=in.("cromwell","not-a-course")')), "it filters to the named courses");
  assert.ok(subset.body.courses["published::cromwell"].objects.t1, "and they arrive with their geometry");
  ok("scope=play&courseIds returns only those courses, marked partial");

  asked = [];
  const whole = await get(courseMaps, "https://clarity.example/api/course-maps?scope=play");
  assert.ok(!whole.body.partial, "no courseIds is still the whole library");
  assert.strictEqual(Object.keys(whole.body.courses).length, 2);
  ok("scope=play without courseIds is unchanged");

  // --- the two screens hold up their end ----------------------------------------
  const studio = fs.readFileSync(path.join(ROOT, "scripts", "studio", "gd-admin-course-db.js"), "utf8");
  assert.ok(/fetch\("\/api\/course-visual-jobs",\{headers:\{Accept:"application\/json"\},cache:"no-store"\}\)/.test(studio),
    "the table must load one snapshot of every course's build state");
  assert.ok(/if\(courseId!==gdAdminCourseDatabaseSelected\)\{[\s\S]{0,200}gdLoadAdminCourseBuildStates\(\)/.test(studio),
    "a row that is not selected must read the snapshot, never poll for itself");
  assert.ok(/if\(entry&&entry\.inflight\)return known;/.test(studio), "a poll still in flight is never asked twice");
  assert.ok(/failedAt\?GD_ADMIN_BUILD_POLL_FAILED_MS/.test(studio), "a failed poll waits before it is asked again");
  ok("Studio rows read one snapshot; only the selected course polls, once at a time, with a cooldown");

  const phone = fs.readFileSync(path.join(ROOT, "scripts", "gd-course-library-pin-lock.js"), "utf8");
  assert.ok(/PUBLISHED_COURSE_API\+'\?scope=play&courseIds='\+encodeURIComponent\(courseIds\.join\(','\)\)/.test(phone),
    "the phone must ask for the stale and missing courses by id");
  assert.ok(/data\.partial!==true[^\n]*return null;/.test(phone), "and must not merge a full answer as if it were the subset");
  assert.ok(/const wanted=freshness\.stale\.concat\(freshness\.missing\)/.test(phone), "the manifest's stale and missing lists are what it asks for");
  ok("the phone syncs the courses that changed, and only falls back to the whole library");

  console.log("course-db-load passed: " + checks + " checks");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
