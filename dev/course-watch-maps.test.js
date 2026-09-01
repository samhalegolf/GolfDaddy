#!/usr/bin/env node
"use strict";

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

const root = path.join(__dirname, "..");

(async function run() {
  const api = await import(pathToFileURL(path.join(root, "functions", "course-watch-maps.mjs")).href);
  const helpers = api.__test;

  // --- holeNumbersFromObjects: distinct, sorted, ignores garbage ---------------------------
  const numbers = helpers.holeNumbersFromObjects({
    a: { holeNumber: 3 }, b: { holeNumber: 1 }, c: { holeNumber: 3 },
    d: { holeNumber: "not-a-number" }, e: {}, f: { holeNumber: 0 }, g: { holeNumber: 18 }
  });
  assert.deepStrictEqual(numbers, [1, 3, 18], "hole numbers must be distinct, sorted, and filtered to positive finite numbers");
  assert.deepStrictEqual(helpers.holeNumbersFromObjects({}), []);
  assert.deepStrictEqual(helpers.holeNumbersFromObjects(null), []);

  // --- reportShape: a missing row reads as "none", not an error ----------------------------
  const none = helpers.reportShape(null);
  assert.strictEqual(none.status, "none");
  assert.strictEqual(none.holeCount, 0);
  assert.deepStrictEqual(none.holes, []);

  // --- reportShape: a real row maps snake_case DB columns to the camelCase API contract -----
  const row = {
    status: "ready",
    watch_package_version: 12345,
    recipe_id: "watch-map-v1",
    recipe_version: 1,
    source_objects_version: "2026-08-01T00:00:00Z",
    hole_count: 18,
    ready_hole_count: 18,
    total_bytes: 862000,
    format: "webp",
    generated_at: "2026-09-01T00:00:00Z",
    generated_by: "samhalegolf@gmail.com",
    holes: [{ holeNumber: 1 }],
    errors: []
  };
  const shaped = helpers.reportShape(row);
  assert.strictEqual(shaped.status, "ready");
  assert.strictEqual(shaped.watchPackageVersion, 12345);
  assert.strictEqual(shaped.recipeId, "watch-map-v1");
  assert.strictEqual(shaped.holeCount, 18);
  assert.strictEqual(shaped.readyHoleCount, 18);
  assert.strictEqual(shaped.totalBytes, 862000);
  assert.strictEqual(shaped.holes.length, 1);

  // --- storage-only packages remain inspectable, but are explicitly recovery state --------
  const recovered = helpers.recoveryReport("millbrook-remarkables-18", {
    watchPackageVersion: 1788278423353,
    holes: [{ holeNumber: 1, path: "millbrook-remarkables-18/v1788278423353/h1.webp", format: "webp", bytes: 4700 }]
  });
  assert.strictEqual(recovered.status, "recovery");
  assert.strictEqual(recovered.watchPackageVersion, 1788278423353);
  assert.strictEqual(recovered.holes.length, 1);

  // --- this pipeline must never touch the native visual/geometry tables --------------------
  const source = fs.readFileSync(path.join(root, "functions", "course-watch-maps.mjs"), "utf8");
  ["course_visuals", "course_visual_jobs", "course_mapper_jobs"].forEach(table => {
    assert.ok(!source.includes('"' + table + '"') && !source.includes("'" + table + "'"), "course-watch-maps.mjs must never reference " + table);
  });
  assert.ok(source.includes("ADMIN_EMAILS"), "generation must be admin-gated");
  assert.ok(source.includes('published=eq.true'), "generation must read only published course geometry");

  // --- admin studio wiring: the action rail, maintenance menu, and tab dispatch exist -------
  const studio = fs.readFileSync(path.join(root, "scripts", "studio", "gd-admin-course-db.js"), "utf8");
  assert.ok(studio.includes('gdAdminCourseDbShowWatchMaps(${id})">Watch Maps</button>'), "the course action rail must carry a Watch Maps button");
  assert.ok(studio.includes('"generate_watch_maps","Generate Watch Maps"'), "the maintenance dropdown must carry a Generate Watch Maps item");
  assert.ok(studio.includes('mode==="generate_watch_maps"'), "the maintenance dispatcher must handle generate_watch_maps");
  assert.ok(studio.includes('gdAdminCourseDatabaseTab==="watchmaps"'), "the detail panel must render a watchmaps tab body");
  {
    // The generate_watch_maps dispatch branch itself must call the Watch Map generator, not the
    // native visual export job queue - checked on the branch's own body, not the whole file
    // (gdAdminCourseVisualEnqueueCloudJob legitimately appears elsewhere, for rebake_visuals).
    const branch = studio.slice(studio.indexOf('if(mode==="generate_watch_maps"'));
    const body = branch.slice(0, branch.indexOf("\n  }") + 4);
    assert.ok(body.includes("gdAdminCourseWatchMapsGenerate"), "generate_watch_maps must call the Watch Map generator");
    assert.ok(!body.includes("gdAdminCourseVisualEnqueueCloudJob"), "generate_watch_maps must not be wired through the native visual job queue");
  }

  const viewer = fs.readFileSync(path.join(root, "scripts", "studio", "gd-admin-watch-map-viewer.js"), "utf8");
  assert.ok(viewer.includes("/api/course-watch-maps"), "the viewer must call the Watch Map API");
  assert.ok(viewer.includes("gdAdminWatchMapGallery"), "the viewer must render each generated Watch Map in a gallery");
  assert.ok(viewer.includes("Open full size"), "each Watch Map must have a complete-asset inspection link");
  assert.ok(viewer.includes("window.GDWatchMapCore"), "the debug overlay must reuse the shared geo<->pixel transform, not a second implementation");
  assert.ok(!/gdAdminWatchMapStage[\s\S]{0,400}(bezel|complication|LockShot|Bubble)/i.test(viewer), "the viewer must not draw a fake Watch bezel or Bubble/Lock-Shot UI - it inspects the baked asset only");

  // --- netlify.toml must pin the shared core so functions/ can import it -------------------
  const toml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
  assert.ok(toml.includes("scripts/gd-watch-map-core.js"), "netlify.toml must pin scripts/gd-watch-map-core.js as an included_files entry");

  const migration = fs.readFileSync(path.join(root, "supabase", "migrations", "20260902_fix_course_watch_map_version_bigint.sql"), "utf8");
  assert.ok(migration.includes("bigint"), "existing installations must upgrade Watch Map package versions to bigint");


  // --- pruning superseded packages: the live one must never be selectable ----

  const { supersededPaths } = helpers;
  const LIVE = 1788285633006;
  const listing = [
    { folder: "v1788278329227", assets: ["h1.webp", "h2.webp"] },
    { folder: "v1788278423353", assets: ["h1.webp"] },
    { folder: "v" + LIVE, assets: ["h1.webp", "h2.webp"] }
  ];
  const doomed = supersededPaths("millbrook-remarkables-18", LIVE, listing);
  assert.deepStrictEqual(doomed, [
    "millbrook-remarkables-18/v1788278329227/h1.webp",
    "millbrook-remarkables-18/v1788278329227/h2.webp",
    "millbrook-remarkables-18/v1788278423353/h1.webp"
  ], "every superseded asset, and only those");
  assert.ok(!doomed.some(p => p.includes(String(LIVE))), "the live package can never appear in the delete list");

  assert.deepStrictEqual(supersededPaths("c", LIVE, [{ folder: "v" + LIVE, assets: ["h1.webp"] }]), [],
    "a course with only the live package prunes nothing");
  assert.deepStrictEqual(supersededPaths("c", LIVE, []), [], "an empty bucket prunes nothing");

  /* A non-version folder, or a file that is not a baked hole, is not this
     function's to delete - it did not put it there. */
  assert.deepStrictEqual(supersededPaths("c", LIVE, [
    { folder: "backup", assets: ["h1.webp"] },
    { folder: "v1", assets: ["notes.txt", "h1.webp", "../../escape.webp"] }
  ]), ["c/v1/h1.webp"], "only vN folders and only baked hole assets are pruned");

  // --- backfillHoleReferences ---------------------------------------------------------------

  /* `reference` is derived from course_maps.objects_json alone, never from the
     image, so it can be written into an already-baked package without a
     re-bake and without bumping the version. The safety property is that the
     geometry has not moved since: a reference describing today's green under
     an image drawn from last week's would put the Bubble somewhere the picture
     disagrees with, silently, because both halves are individually valid. */

  const watchMapCore = require(path.join(root, "scripts", "gd-watch-map-core.js"));

  const BACKFILL_OBJECTS = {
    "tee-1": { type: "tee", holeNumber: 1, position: { lat: -45.010, lng: 169.100 } },
    "green-1": { type: "green", holeNumber: 1, position: { lat: -45.013, lng: 169.104 } }
  };
  function bakedHole(objects, holeNumber) {
    const frame = watchMapCore.buildWatchHoleFrame(
      watchMapCore.WATCH_MAP_RECIPE_V1, watchMapCore.objectsForHole(objects, holeNumber));
    return {
      holeNumber,
      path: "c/v1/h" + holeNumber + ".webp",
      width: frame.width,
      height: frame.height,
      format: "webp",
      bytes: 4200,
      spatialReference: frame.spatialReference
    };
  }

  const baked = bakedHole(BACKFILL_OBJECTS, 1);
  const unchanged = helpers.backfillHoleReferences({ objects_json: BACKFILL_OBJECTS }, { holes: [baked] });
  assert.strictEqual(unchanged.updated, 1, "an unedited package must accept its reference");
  assert.strictEqual(unchanged.skipped.length, 0);
  assert.strictEqual(unchanged.holes[0].reference.version, 1);
  assert.deepStrictEqual(unchanged.holes[0].spatialReference, baked.spatialReference,
    "a backfill writes the reference and touches nothing else");
  assert.strictEqual(unchanged.holes[0].path, baked.path);

  /* The green has been dragged 30m since the bake. The stored image still
     shows the old one, so this hole must be refused and named. */
  const moved = JSON.parse(JSON.stringify(BACKFILL_OBJECTS));
  moved["green-1"].position.lat -= 0.00027;
  const edited = helpers.backfillHoleReferences({ objects_json: moved }, { holes: [baked] });
  assert.strictEqual(edited.updated, 0, "a package whose geometry has moved must not be described with the new geometry");
  assert.strictEqual(edited.skipped.length, 1);
  assert.match(edited.skipped[0].reason, /regenerate/, "the caller must be told the fix is a regenerate, not a retry");
  assert.strictEqual(edited.holes[0].reference, undefined, "a refused hole is left exactly as it was");

  /* Idempotent: running it twice is not an error and is not a second write. */
  const again = helpers.backfillHoleReferences({ objects_json: BACKFILL_OBJECTS }, { holes: unchanged.holes });
  assert.strictEqual(again.updated, 0);
  assert.strictEqual(again.alreadyPresent, 1);

  /* A hole deleted from the map since the bake still has an image in the
     bucket. It cannot be described, and that is not a failure of the others. */
  const orphan = helpers.backfillHoleReferences(
    { objects_json: BACKFILL_OBJECTS }, { holes: [baked, Object.assign({}, baked, { holeNumber: 7 })] });
  assert.strictEqual(orphan.updated, 1, "one bad hole must not cost the good ones their reference");
  assert.strictEqual(orphan.skipped.length, 1);
  assert.strictEqual(orphan.skipped[0].holeNumber, 7);
  assert.match(orphan.skipped[0].reason, /no green geometry/);

  // --- sameProjectionBasis --------------------------------------------------------------------
  const basis = baked.spatialReference;
  assert.strictEqual(helpers.sameProjectionBasis(basis, basis), true);
  assert.strictEqual(helpers.sameProjectionBasis(basis, null), false);
  /* A last-bit difference is the same computation; a metre is not. */
  const nudged = JSON.parse(JSON.stringify(basis));
  nudged.transform.tx += Math.abs(basis.transform.tx) * 1e-12;
  assert.strictEqual(helpers.sameProjectionBasis(basis, nudged), true, "floating-point noise is not a moved green");
  const shifted = JSON.parse(JSON.stringify(basis));
  shifted.transform.tx += 1;
  assert.strictEqual(helpers.sameProjectionBasis(basis, shifted), false);
  const resized = JSON.parse(JSON.stringify(basis));
  resized.imageWidth += 1;
  assert.strictEqual(helpers.sameProjectionBasis(basis, resized), false, "a differently sized canvas is a different bake");

  console.log("course-watch-maps passed");
})().catch((error) => {
  console.error("course-watch-maps failed");
  console.error(error && error.stack || error);
  process.exit(1);
});
