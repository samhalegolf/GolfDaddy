/* Map versions: "Akarana Golf Club (v1.4)", "W-v1.0", "Update Available (v1.5)", and the
   operator-only stamp that names which baked asset is on screen.

   Run: npm run test:course-version-label

   The scheme lives in exactly one file (scripts/gd-course-version-label.js) and this
   suite is what keeps it there - four server endpoints and both browser shells render
   the same string, and the last time a version field was restated per-surface the two
   ends drifted onto different columns and the badge stopped meaning anything (see the
   header of app/js/course-versions.js). */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const label = require(path.join(root, "scripts", "gd-course-version-label.js"));
const surface = require(path.join(root, "app", "js", "play-surface.js"));

const checks = [];
function test(name, fn) { checks.push([name, fn]); }

// ---------------------------------------------------------------- the scheme

test("a baked course is v<bake>.<edits since that bake>", () => {
  const v = label.courseVersion({ bakeNumber: 1, objectsRevision: 5, bakeObjectsRevision: 1 });
  assert.strictEqual(v.label, "v1.4");
  assert.strictEqual(v.major, 1);
  assert.strictEqual(v.minor, 4);
});

test("an object-only course is v0.<revision> - the leading zero says there are no pictures", () => {
  assert.strictEqual(label.courseVersion({ bakeNumber: 0, objectsRevision: 1 }).label, "v0.1");
  assert.strictEqual(label.courseVersion({ bakeNumber: null, objectsRevision: 3 }).label, "v0.3");
});

test("a re-bake resets the minor - new pictures are taken at the geometry as it stands", () => {
  assert.strictEqual(label.courseVersion({ bakeNumber: 1, objectsRevision: 4, bakeObjectsRevision: 1 }).label, "v1.3");
  assert.strictEqual(label.courseVersion({ bakeNumber: 2, objectsRevision: 4, bakeObjectsRevision: 4 }).label, "v2.0");
});

test("an unknown geometry revision produces no label at all, never a guessed one", () => {
  assert.strictEqual(label.courseVersion({ bakeNumber: 1, objectsRevision: null }), null);
  assert.strictEqual(label.courseVersion({ bakeNumber: 1, objectsRevision: "v1" }), null);
  assert.strictEqual(label.courseVersion(null), null);
});

test("a bake recorded before baselines existed reads as <bake>.0, not as invented drift", () => {
  assert.strictEqual(label.courseVersion({ bakeNumber: 3, objectsRevision: 9, bakeObjectsRevision: null }).label, "v3.0");
});

test("geometry can never run backwards into a negative minor", () => {
  /* A bake made from a revision NEWER than the course reports - only reachable if the
     two reads straddle a write - must not print "v2.-1". */
  assert.strictEqual(label.courseVersion({ bakeNumber: 2, objectsRevision: 3, bakeObjectsRevision: 5 }).label, "v2.0");
});

test("a Watch package is W- prefixed, so it can never be read as the phone's map", () => {
  assert.strictEqual(label.watchVersion({ buildNumber: 1, objectsRevision: 1, sourceObjectsRevision: 1 }).label, "W-v1.0");
  assert.strictEqual(label.watchVersion({ buildNumber: 1, objectsRevision: 4, sourceObjectsRevision: 1 }).label, "W-v1.3",
    "drift: the course moved on three times and the wrist copy did not");
  assert.strictEqual(label.watchVersion({ buildNumber: 0, objectsRevision: 4 }), null,
    "nothing generated yet is not W-v0.something - there is no Watch asset to name");
});

test("the display helpers", () => {
  assert.strictEqual(label.withName("Akarana Golf Club", { label: "v1.4" }), "Akarana Golf Club (v1.4)");
  assert.strictEqual(label.withName("Akarana Golf Club", "v1.4"), "Akarana Golf Club (v1.4)");
  assert.strictEqual(label.withName("Akarana Golf Club", null), "Akarana Golf Club",
    "no version means the bare name, never an empty pair of brackets");
  assert.strictEqual(label.updateAvailable({ label: "v1.5" }), "Update Available (v1.5)");
  assert.strictEqual(label.updateAvailable(null), "Update Available");
});

// ------------------------------------------------- the stamp on a baked asset

test("a hole image's stamp is read off the asset, and survives the course moving on", () => {
  const frozen = label.stampFor(label.courseVersion({ bakeNumber: 2, objectsRevision: 4, bakeObjectsRevision: 4 }), { buildId: "r1alw6nz" });
  assert.strictEqual(frozen.label, "v2.0");
  assert.strictEqual(frozen.buildId, "r1alw6nz");
  /* Two geometry edits later the COURSE is v2.2. The image is still v2.0, because the
     pixels did not change - and that gap is the whole reason the stamp exists. */
  assert.strictEqual(label.courseVersion({ bakeNumber: 2, objectsRevision: 6, bakeObjectsRevision: 4 }).label, "v2.2");
  assert.strictEqual(surface.assetVersionLabel({ version: frozen }), "v2.0");
});

test("an unstamped asset renders nothing rather than a placeholder", () => {
  assert.strictEqual(surface.assetVersionLabel({ version: null }), "");
  assert.strictEqual(surface.assetVersionLabel(null), "");
  assert.strictEqual(surface.assetVersionLabel({ version: "not a version" }), "");
  assert.strictEqual(surface.assetVersionLabel({ version: "v2.0" }), "v2.0");
});

test("the stamp names the file, from a path or from the package's asset URL", () => {
  assert.strictEqual(surface.assetFileName({ path: "akarana-golf-club/frames/r1alw6nz/h7.jpg" }), "r1alw6nz/h7.jpg");
  assert.strictEqual(surface.assetFileName({ url: "/api/course-visual-assets?path=akarana%2Fframes%2Fr1alw6nz%2Fh7.jpg" }), "r1alw6nz/h7.jpg");
  assert.strictEqual(surface.assetFileName(null), "");
});

test("holeSurfaceAsset carries the stamp out of the course_visuals record", () => {
  const record = { status: "published", uploaded_assets: [
    { path: "c/frames/r1/h3.jpg", holeNumber: 3, metadata: { playSurface: { captureZoom: 18 }, version: { label: "v1.0" } } },
    { path: "c/frames/r1/h4.jpg", holeNumber: 4, metadata: { playSurface: { captureZoom: 18 } } }
  ] };
  assert.strictEqual(surface.holeSurfaceAsset(record, 3).version.label, "v1.0");
  assert.strictEqual(surface.holeSurfaceAsset(record, 4).version, null, "an older frame has no stamp and must not borrow one");
});

// ----------------------------------------------- the freshness rule it feeds

test("frame updates are decided by bake_number, not by the hash digits that preceded it", () => {
  const win = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, "app", "js", "course-versions.js"), "utf8"), { window: win });
  const versions = win.ClarityApp.courseVersions;
  const T = "2026-09-01T00:00:00.000+00:00";

  assert.strictEqual(versions.updateKind({ bakeNumber: 1, objectsVersion: T }, { bakeNumber: 2, objectsVersion: T }), "frame");
  assert.strictEqual(versions.updateKind({ bakeNumber: 2, objectsVersion: T }, { bakeNumber: 2, objectsVersion: T }), "none");
  assert.strictEqual(versions.updateKind({ bakeNumber: 3, objectsVersion: T }, { bakeNumber: 2, objectsVersion: T }), "none",
    "an older bake on the server is not an update");

  /* The bug this replaces, reproduced against the OLD field: published_version carried
     the digits of the export content hash, so akarana held 1977 and a genuine re-bake
     that scraped 5 read as no update at all. */
  assert.strictEqual(versions.updateKind({ mapVersion: 1977, objectsVersion: T }, { mapVersion: 5, objectsVersion: T }), "none",
    "documents the old behaviour - this is why mapVersion is no longer the deciding field");
  assert.strictEqual(versions.updateKind({ mapVersion: 1977, objectsVersion: T }, { bakeNumber: 1, objectsVersion: T }), "frame",
    "a copy saved before bake numbers cannot be compared against one, so it re-downloads ONCE and gains a number");
});

// ------------------------------------------------- naming a version for old builds

test("the name tag is off unless explicitly switched on", async () => {
  const tag = await import("../functions/lib/gd-course-name-version-tag.mjs");
  const version = { label: "v2.0" };
  assert.strictEqual(tag.taggedCourseName("Akarana Golf Club", version, false), "Akarana Golf Club");
  assert.strictEqual(tag.taggedCourseName("Akarana Golf Club", version, true), "Akarana Golf Club (v2.0)");
  assert.strictEqual(tag.taggedCourseName("Akarana Golf Club", null, true), "Akarana Golf Club",
    "no version to tag with means the real name, never empty brackets");

  const saved = process.env.COURSE_NAME_VERSION_TAG;
  try {
    for (const on of ["1", "true", "on", "TRUE"]) {
      process.env.COURSE_NAME_VERSION_TAG = on;
      assert.strictEqual(tag.nameVersionTagEnabled(), true, on + " must enable it");
    }
    /* A var left at "false"/"0" while debugging must not quietly rename every course. */
    for (const off of ["false", "0", "", "no", "off"]) {
      process.env.COURSE_NAME_VERSION_TAG = off;
      assert.strictEqual(tag.nameVersionTagEnabled(), false, JSON.stringify(off) + " must NOT enable it");
    }
  } finally {
    if (saved === undefined) delete process.env.COURSE_NAME_VERSION_TAG;
    else process.env.COURSE_NAME_VERSION_TAG = saved;
  }
});

test("a tagged name must not reach mergeWithLibrary - it would double the course", async () => {
  /* The hazard, demonstrated rather than asserted about. mergeWithLibrary decides that an
     OSM course and a mapped course are the same place by comparing the slugs of their
     names. Tag the name first and that match fails, so the picker lists the course twice:
     once as mapped, once as an unmapped OSM footprint. */
  const { mergeWithLibrary } = await import("../functions/lib/gd-courses-near-core.mjs");
  const osm = [{ name: "Akarana Golf Club", lat: -36.88, lng: 174.74, distanceM: 10 }];
  const anchor = { lat: -36.88, lng: 174.74 };

  const clean = mergeWithLibrary(osm, [
    { course_id: "akarana-golf-club", course_name: "Akarana Golf Club", course_lat: -36.88, course_lng: 174.74, hole_count: 18 }
  ], anchor);
  assert.strictEqual(clean.length, 1, "untagged: one course, recognised as already mapped");

  const tagged = mergeWithLibrary(osm, [
    { course_id: "akarana-golf-club", course_name: "Akarana Golf Club (v2.0)", course_lat: -36.88, course_lng: 174.74, hole_count: 18 }
  ], anchor);
  assert.ok(tagged.length >= clean.length,
    "tagging before the merge can only ever add rows, never remove them");
});

test("courses-near tags AFTER merging, and the tag costs nothing when off", () => {
  const src = fs.readFileSync(path.join(root, "functions", "courses-near.mjs"), "utf8");
  const mergeAt = src.indexOf("mergeWithLibrary(osmCourses, library, anchor)");
  const tagAt = src.indexOf("tagVersionNames(merged, library)");
  assert.ok(mergeAt > 0 && tagAt > mergeAt,
    "the version tag must be applied to the MERGED list, never to the library rows the merge matches on");
  assert.ok(/tagNames \? await tagVersionNames/.test(src),
    "the extra course_visuals read must only happen when the switch is on");
});

test("both download paths name a course the same way", () => {
  /* /api/course-library feeds the app shell's picker, /api/courses-near feeds the older
     shell's "Find course". A course downloaded through one must not be named differently
     from the same course downloaded through the other, so both go through one helper. */
  ["functions/course-library.mjs", "functions/courses-near.mjs"].forEach(file => {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    assert.ok(/gd-course-name-version-tag\.mjs/.test(src), file + " must use the shared tag helper");
    assert.ok(/taggedCourseName\(/.test(src), file + " must name courses through it");
  });
});

// -------------------------------------------------------------- the wiring

test("the legacy version pair stays self-consistent for already-installed clients", () => {
  /* A client saves `packageVersion` from /api/course-package and compares what it saved
     against /api/course-library's `clarity_map_version`. Both must keep reading the same
     column, or every installed build reads as permanently "Update available" and
     re-downloading cannot clear it. This is not cosmetic - it regressed once already. */
  const shape = fs.readFileSync(path.join(root, "functions", "lib", "gd-course-package-shape.mjs"), "utf8");
  const manifest = fs.readFileSync(path.join(root, "functions", "course-library.mjs"), "utf8");
  assert.ok(/packageVersion:\s*visual\.published_version/.test(shape),
    "course-package's packageVersion must stay on published_version");
  assert.ok(/clarity_map_version:\s*visual\s*\?\s*integer\(visual\.published_version\)/.test(manifest),
    "the manifest's clarity_map_version must stay on published_version - it is the other half of that pair");
  assert.ok(/bakeNumber:\s*visual\.bake_number/.test(shape),
    "the real counter travels as its own field instead");
});

test("the shared core is pinned for the functions bundle", () => {
  const toml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
  assert.ok(toml.includes("scripts/gd-course-version-label.js"),
    "netlify.toml must pin scripts/gd-course-version-label.js - it sits outside functions/ and four functions import it");
});

test("every surface that reports a version reads the one shared core", () => {
  ["functions/course-library.mjs",
   "functions/course-visual-jobs.mjs",
   "functions/course-visual-worker-background.mjs",
   "functions/course-watch-maps.mjs",
   "functions/lib/gd-course-package-shape.mjs"].forEach(file => {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    assert.ok(/gd-course-version-label\.js/.test(src), file + " must import the shared version-label core, not restate the scheme");
  });
});

test("the bake worker stamps every image it writes, and bumps a real counter", () => {
  const src = fs.readFileSync(path.join(root, "functions", "course-visual-worker-background.mjs"), "utf8");
  assert.ok(src.includes("bake_number: bakeNumber"), "the row must carry the publish counter");
  assert.ok(src.includes("bake_objects_revision: bakeObjectsRevision"), "and the geometry it was baked from");
  const assets = src.slice(src.indexOf("const uploadedAssets = []"), src.indexOf("const row = {"));
  assert.strictEqual((assets.match(/version: versionStamp/g) || []).length, 2,
    "both the overview and the hole frames must be stamped");
  /* Same build, same number. Exports resume and jobs retry; running one build twice must
     not invent a second version of identical pixels. */
  assert.ok(src.includes("priorBuild === buildId"), "the counter must be bumped per build, not per call");
});

test("the version is metadata on the asset, never composited into the pixels", () => {
  /* Burnt-in text would be visible to every player on every hole, which is the opposite
     of an operator diagnostic. The renderer must not even know the label exists. */
  const exportCore = fs.readFileSync(path.join(root, "functions", "lib", "gd-visual-export-core.mjs"), "utf8");
  ["versionStamp", "bakeVersion", "bake_number", "versionLabel"].forEach(name => {
    assert.ok(!exportCore.includes(name),
      "gd-visual-export-core.mjs must not reference " + name + " - the stamp is drawn by the app, not baked into the JPEG");
  });
});

test("the play stamp is admin-only and reads the asset, not the course", () => {
  const painter = fs.readFileSync(path.join(root, "app", "js", "painter.js"), "utf8");
  const fn = painter.slice(painter.indexOf("function showVersionStamp"), painter.indexOf("function hideVersionStamp"));
  assert.ok(fn.includes("app.account.isAdmin()"), "the stamp must be gated on the operator account");
  assert.ok(fn.includes("surfaceLib.assetVersionLabel(asset)"), "and read the loaded asset's own stamp");
  assert.ok(!/round\(\)|currentScene|versionLabel/.test(fn),
    "it must not reach for the COURSE's version - an image baked at v1.2 inside a course at v1.3 has to keep saying v1.2");
  assert.ok(painter.includes("hideVersionStamp();"), "and it must be cleared whenever the published surface goes away");
});

test("both shells agree on who the operator is", () => {
  const appAccount = fs.readFileSync(path.join(root, "app", "js", "account.js"), "utf8");
  const oldShell = fs.readFileSync(path.join(root, "scripts", "gd-course-library-pin-lock.js"), "utf8");
  const emails = src => {
    const line = src.split("\n").find(l => /ADMIN_EMAILS\s*=|PUBLISHED_ADMIN_EMAILS\s*=/.test(l));
    return (line.match(/[\w.+-]+@[\w.-]+/g) || []).sort();
  };
  assert.deepStrictEqual(emails(appAccount), emails(oldShell),
    "the two shells share the account store but no code - their admin lists must not drift");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of checks) {
    try { await fn(); console.log("  ok  " + name); }
    catch (error) { failed++; console.log("  FAIL  " + name + "\n        " + (error && error.message)); }
  }
  if (failed) { console.log("course-version-label FAILED: " + failed + " of " + checks.length); process.exit(1); }
  console.log("course-version-label passed: " + checks.length + " checks");
})();
