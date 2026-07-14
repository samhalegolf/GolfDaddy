#!/usr/bin/env node
"use strict";

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

(async function run() {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "functions", "course-maps.mjs")).href);
  const {
    courseFromSupabaseRow,
    courseToSupabaseRow,
    mapsFromSupabaseRows,
    mergeMapSets,
    sanitizeCourse
  } = mod.__courseMapsTest;

  const actor = { name: "Sam", email: "samhalegolf@gmail.com", role: "admin", accountId: "acct-1" };
  const course = sanitizeCourse({
    courseId: "cromwell",
    courseName: "Cromwell Golf Course",
    finderLat: -45.038113,
    finderLng: 169.204844,
    objects: {
      g1: {
        id: "g1",
        type: "green",
        greenCenter: { lat: -45.03, lng: 169.2 },
        greenShape: [
          { lat: -45.0301, lng: 169.2001 },
          { lat: -45.0302, lng: 169.2002 },
          { lat: -45.0303, lng: 169.2003 }
        ],
        holeNumber: 1,
        confirmed: true,
        source: "native-resolver"
      },
      f1: {
        id: "f1",
        type: "fairway",
        position: { lat: -45.031, lng: 169.201 },
        holeNumber: 1,
        confirmed: true,
        source: "native-resolver"
      }
    },
    holes: {
      1: {
        id: "h1",
        holeNumber: 1,
        greenCenter: { lat: -45.03, lng: 169.2 },
        greenShape: [
          { lat: -45.0301, lng: 169.2001 },
          { lat: -45.0302, lng: 169.2002 },
          { lat: -45.0303, lng: 169.2003 }
        ],
        greenSource: "native-resolver"
      }
    }
  }, actor);

  assert.equal(course.id, "published::cromwell");
  assert.equal(course.courseLat, null);
  assert.equal(course.courseLng, null);
  assert.equal(Object.keys(course.objects).length, 2);
  assert.equal(Object.keys(course.holes).length, 1);

  const row = courseToSupabaseRow(course);
  assert.equal(row.id, "published::cromwell");
  assert.equal(row.course_id, "cromwell");
  assert.equal(row.course_name, "Cromwell Golf Course");
  assert.equal(row.course_lat, null);
  assert.equal(row.finder_lat, -45.038113);
  assert.equal(row.objects_json.g1.type, "green");
  assert.equal(row.holes_json[1].holeNumber, 1);
  assert.deepEqual(row.assets_json, {});

  const restored = courseFromSupabaseRow(Object.assign({}, row, {
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T01:00:00.000Z"
  }));
  assert.equal(restored.id, "published::cromwell");
  assert.equal(restored.userId, "published");
  assert.equal(restored.finderLat, -45.038113);
  assert.equal(restored.objects.g1.greenCenter.lat, -45.03);
  assert.equal(restored.holes[1].greenCenter.lng, 169.2);

  const cloudMaps = mapsFromSupabaseRows([Object.assign({}, row, { updated_at: "2026-07-15T01:00:00.000Z" })]);
  assert.equal(cloudMaps.storage, "supabase");
  assert.equal(Object.keys(cloudMaps.courses).length, 1);
  assert.equal(cloudMaps.updatedAt, "2026-07-15T01:00:00.000Z");

  const merged = mergeMapSets(
    { updatedAt: "2026-07-14T00:00:00.000Z", courses: { "published::cromwell": { id: "published::cromwell", courseName: "Old" } } },
    cloudMaps,
    { storage: "supabase" }
  );
  assert.equal(merged.storage, "supabase");
  assert.equal(merged.courses["published::cromwell"].courseName, "Cromwell Golf Course");
  assert.equal(merged.updatedAt, "2026-07-15T01:00:00.000Z");

  const optionsResponse = await mod.default(new Request("https://clarity-caddie.test/api/course-maps", { method: "OPTIONS" }));
  assert.equal(optionsResponse.status, 200);
  assert.equal(optionsResponse.headers.get("Access-Control-Allow-Methods"), "GET,POST,OPTIONS");

  console.log("course maps cloud tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
