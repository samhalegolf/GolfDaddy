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
    deleteCourseId,
    findCourseMapKey,
    isGeneratedCourseUpload,
    mergeGeneratedCourse,
    mapsFromSupabaseRows,
    mergeMapSets,
    sanitizeCourse,
    stripSurfacesForPlay,
    visualSnapshotCourseId,
    withMirrorSummary
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

  const authoritative = withMirrorSummary(cloudMaps, {
    updatedAt: "2026-07-16T01:00:00.000Z",
    courses: {
      "published::akarana-golf-club": { id: "published::akarana-golf-club", courseId: "akarana-golf-club", courseName: "Akarana Golf Club" }
    }
  });
  assert.equal(authoritative.storage, "supabase");
  assert.equal(authoritative.courses["published::akarana-golf-club"], undefined);
  assert.equal(authoritative.courses["published::cromwell"].courseName, "Cromwell Golf Course");
  assert.equal(authoritative.mirrorCourseCount, 1);

  assert.equal(deleteCourseId({ id: "published::akarana-golf-club" }), "akarana-golf-club");
  assert.equal(deleteCourseId({ course: { courseName: "Akarana Golf Club" } }), "akarana-golf-club");

  assert.equal(isGeneratedCourseUpload({ generated: true, mode: "generated-create-or-append" }), true);
  assert.equal(isGeneratedCourseUpload({ generated: true, source: "native-resolver" }), true);
  assert.equal(isGeneratedCourseUpload({ generated: false, mode: "generated-create-or-append" }), false);

  const playerActor = { name: "Player", email: "player@example.com", role: "player", accountId: "acct-player" };
  const playerScan = sanitizeCourse({
    courseId: "cromwell",
    courseName: "Cromwell Golf Course",
    objects: {
      g2: {
        id: "g2",
        type: "green",
        greenCenter: { lat: -45.04, lng: 169.21 },
        greenShape: [
          { lat: -45.0401, lng: 169.2101 },
          { lat: -45.0402, lng: 169.2102 },
          { lat: -45.0403, lng: 169.2103 }
        ],
        holeNumber: 2,
        confirmed: true,
        source: "native-resolver"
      }
    },
    holes: {
      2: {
        id: "h2",
        holeNumber: 2,
        greenCenter: { lat: -45.04, lng: 169.21 },
        greenShape: [
          { lat: -45.0401, lng: 169.2101 },
          { lat: -45.0402, lng: 169.2102 },
          { lat: -45.0403, lng: 169.2103 }
        ],
        greenSource: "native-resolver"
      }
    }
  }, { name: "Community scan", email: "", accountId: playerActor.accountId });
  const existingKey = findCourseMapKey(cloudMaps, playerScan);
  assert.equal(existingKey, "published::cromwell");
  const generatedMerge = mergeGeneratedCourse(cloudMaps.courses[existingKey], playerScan);
  assert.equal(generatedMerge.accepted.objects, 1);
  assert.equal(generatedMerge.accepted.holes, 1);
  assert.equal(Object.keys(generatedMerge.course.objects).length, 3);
  assert.equal(generatedMerge.course.publishedBy.email, "samhalegolf@gmail.com");
  const duplicateMerge = mergeGeneratedCourse(generatedMerge.course, playerScan);
  assert.equal(duplicateMerge.accepted.objects, 0);
  assert.equal(duplicateMerge.accepted.holes, 0);

  /* Publishing geometry auto-enqueues a visual snapshot, and the worker looks the course up by
     course_maps.course_id. The hook used to pass `course.id` - the store key - so every publish
     since it was added queued a snapshot for "published-<name>", the worker failed it with
     "not found in course_maps", and the real course was never scanned. Two courses were
     published in the days before this was spotted and neither got frames. */
  assert.equal(visualSnapshotCourseId(course), "cromwell");
  assert.equal(visualSnapshotCourseId(course), courseToSupabaseRow(course).course_id,
    "the enqueued id must be the column the worker filters on");
  assert.notEqual(visualSnapshotCourseId(course), course.id, "the store key is not a course id");
  assert.equal(visualSnapshotCourseId({ id: "published::cromwell" }), "",
    "a course carrying only a store key enqueues nothing rather than a phantom");

  /* ?scope=play: a ready course loses its collected surfaces (the package carries those), a
     course still on its first scan keeps everything, and nothing else about either changes. */
  const ring = [{ lat: -45.03, lng: 169.2 }, { lat: -45.031, lng: 169.201 }, { lat: -45.032, lng: 169.2 }];
  const playMaps = stripSurfacesForPlay({
    updatedAt: "2026-09-09T00:00:00.000Z",
    courses: {
      "published::ready": {
        id: "published::ready", courseId: "ready", courseName: "Ready",
        holes: { 1: { holeNumber: 1 } },
        objects: {
          g1: { id: "g1", type: "green", position: { lat: -45.03, lng: 169.2 }, shape: ring, holeNumber: 1 },
          t1: { id: "t1", type: "tee", position: { lat: -45.04, lng: 169.2 }, holeNumber: 1 },
          pin: { id: "pin", type: "bunker", position: { lat: -45.035, lng: 169.2 }, holeNumber: 1 },
          b1: { id: "b1", type: "bunker", position: { lat: -45.035, lng: 169.2 }, shape: ring, holeNumber: 1 },
          f1: { id: "f1", type: "fairway_area", position: { lat: -45.035, lng: 169.2 }, shape: ring, holeNumber: 1 },
          w1: { id: "w1", type: "water", position: { lat: -45.035, lng: 169.2 }, shape: ring, holeNumber: 1, hazardClass: "penalty_area" }
        }
      },
      "published::fresh": {
        id: "published::fresh", courseId: "fresh", courseName: "Fresh", holes: {},
        objects: { w9: { id: "w9", type: "water", position: { lat: -45.1, lng: 169.3 }, shape: ring } }
      }
    }
  });
  assert.equal(playMaps.scope, "play");
  assert.equal(playMaps.updatedAt, "2026-09-09T00:00:00.000Z");
  assert.deepEqual(Object.keys(playMaps.courses["published::ready"].objects).sort(), ["g1", "pin", "t1"],
    "a ready course keeps green, tee and the bunker PIN; the three surfaces go");
  assert.deepEqual(playMaps.courses["published::ready"].surfacesOmitted, { fairway_area: 1, bunker: 1, water: 1 });
  assert.deepEqual(Object.keys(playMaps.courses["published::ready"].holes), ["1"]);
  assert.deepEqual(Object.keys(playMaps.courses["published::fresh"].objects), ["w9"],
    "a course with no saved holes ships its full record until its map is ready");
  assert.equal(playMaps.courses["published::fresh"].surfacesOmitted, undefined);

  const optionsResponse = await mod.default(new Request("https://clarity-caddie.test/api/course-maps", { method: "OPTIONS" }));
  assert.equal(optionsResponse.status, 200);
  assert.equal(optionsResponse.headers.get("Access-Control-Allow-Methods"), "GET,POST,OPTIONS");

  console.log("course maps cloud tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
