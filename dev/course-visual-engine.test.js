#!/usr/bin/env node
"use strict";

const assert = require("assert");
const path = require("path");

function installStorage() {
  const data = {};
  global.localStorage = {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    },
    clear() {
      Object.keys(data).forEach((key) => delete data[key]);
    }
  };
  global.dispatchEvent = function () {};
  global.CustomEvent = function CustomEvent(type, init) {
    return { type, detail: init && init.detail };
  };
}

function manifest(id, holeNumber, xOffset) {
  return {
    key: id,
    courseKey: "cromwell",
    courseName: "Cromwell Golf Course",
    holeNumber,
    imageWidth: 512,
    imageHeight: 512,
    captureZoom: 19,
    originPx: { x: 1000 + xOffset, y: 2000 },
    anchorPins: {
      tee: { lat: -45.01 - holeNumber * 0.001, lng: 169.1 },
      green: { lat: -45.012 - holeNumber * 0.001, lng: 169.104 },
      route: [
        { lat: -45.01 - holeNumber * 0.001, lng: 169.1 },
        { lat: -45.011 - holeNumber * 0.001, lng: 169.102 },
        { lat: -45.012 - holeNumber * 0.001, lng: 169.104 }
      ],
      greenShape: [
        { lat: -45.0121 - holeNumber * 0.001, lng: 169.1039 },
        { lat: -45.0122 - holeNumber * 0.001, lng: 169.1041 },
        { lat: -45.0119 - holeNumber * 0.001, lng: 169.1042 }
      ]
    },
    tiles: [
      { x: 0, y: 0, z: 19, tileX: 1, tileY: 2, url: "https://tiles.test/" + id + "/0.png" },
      { x: 256, y: 0, z: 19, tileX: 2, tileY: 2, url: "https://tiles.test/" + id + "/1.png" },
      { x: 0, y: 256, z: 19, tileX: 1, tileY: 3, url: "https://tiles.test/" + id + "/2.png" },
      { x: 256, y: 256, z: 19, tileX: 2, tileY: 3, url: "https://tiles.test/" + id + "/3.png" }
    ],
    createdAt: "2026-07-15T00:00:00.000Z"
  };
}

function payload() {
  return {
    courseId: "cromwell",
    courseKey: "cromwell",
    courseName: "Cromwell Golf Course",
    holes: [
      {
        courseId: "cromwell",
        courseKey: "cromwell",
        courseName: "Cromwell Golf Course",
        holeNumber: 1,
        status: "play_data_ready",
        teePoint: { lat: -45.011, lng: 169.1 },
        greenCentre: { lat: -45.013, lng: 169.104 },
        greenShape: [
          { lat: -45.0131, lng: 169.1039 },
          { lat: -45.0132, lng: 169.1041 },
          { lat: -45.0129, lng: 169.1042 }
        ],
        routePoints: [
          { lat: -45.011, lng: 169.1 },
          { lat: -45.012, lng: 169.102 },
          { lat: -45.013, lng: 169.104 }
        ]
      }
    ]
  };
}

(async function run() {
  installStorage();
  const engine = require(path.join(__dirname, "..", "scripts", "gd-course-visual-engine.js"));
  localStorage.clear();

  const frameRows = [{ holeNumber: 1, manifestKey: "manifest-1" }];
  localStorage.setItem("manifest-1", JSON.stringify(manifest("manifest-1", 1, 0)));
  const input = engine.adaptCoursePlayPayloadToVisualInput(payload(), {
    frameRows,
    readManifest(key) {
      return JSON.parse(localStorage.getItem(key));
    }
  });
  assert.equal(input.courseId, "cromwell");
  assert.equal(input.objects.length, 3, "mapper output converts into visual objects");
  assert.equal(input.captures.length, 1, "mapper frame rows convert into visual captures");

  const record = engine.ingestCourseVisualInput(input);
  assert.equal(record.status, "input-ready");
  assert.equal(record.input.captureCount, 1);
  const persistedAfterIngest = JSON.parse(localStorage.getItem(engine.storeKey));
  assert.equal(persistedAfterIngest.records.cromwell.captures, undefined, "full captures are kept transient, not persisted");
  assert.equal(persistedAfterIngest.records.cromwell.captureRefs.length, 1, "persisted records keep lightweight capture refs");

  const built = await engine.buildCourseVisualMaster("cromwell");
  assert.equal(built.status, "basic-ready", "valid captures produce a basic visual record");
  assert.ok(built.rawMaster.path.includes("/raw/"));
  assert.ok(built.basicVisual.dataUrl.startsWith("data:image/svg+xml"));
  assert.equal(built.rawMaster.dataUrl, built.basicVisual.dataUrl, "raw master feeds basic delivery without recompression");
  const persistedAfterBuild = JSON.parse(localStorage.getItem(engine.storeKey));
  assert.equal(persistedAfterBuild.records.cromwell.rawMaster.dataUrl, undefined, "raw data URL is not persisted into localStorage");
  assert.equal(persistedAfterBuild.records.cromwell.basicVisual.dataUrl, undefined, "basic data URL is not persisted into localStorage");

  const failed = engine.ingestCourseVisualInput({ courseId: "no-captures", objects: input.objects, captures: [] });
  assert.equal(failed.status, "unavailable");
  const failedBuilt = await engine.buildCourseVisualMaster("no-captures");
  assert.equal(failedBuilt.status, "failed", "stitch failure records visible failure");
  assert.equal(failedBuilt.objects.length, input.objects.length, "stitch failure keeps geometry");
  assert.equal(engine.resolveCourseVisual("no-captures"), null, "live-map fallback remains available when no visual resolves");

  const settingsRecord = engine.saveCourseVisualSettings("cromwell", {
    turf: { greenStrength: 0.7 },
    lighting: { brightnessTarget: 57, contrastTarget: 1.08 },
    mowingVisibility: "Clear"
  });
  assert.equal(settingsRecord.settingsDirty, true, "preview settings are saved without publishing");
  assert.equal(settingsRecord.publishedVisual, null);

  const preview = await engine.buildCourseVisualPreview("cromwell", engine.presetForMode("Fresh"));
  assert.equal(preview.status, "preview-ready");
  assert.ok(preview.previewVisual.path.includes("/preview/"));
  assert.equal(preview.publishedVisual, null, "preview does not publish");

  const published = engine.publishCourseVisual("cromwell");
  assert.equal(published.status, "published", "publish changes active version");
  assert.equal(published.publishedVersion, preview.previewVisual.version);
  assert.ok(published.versions.filter((item) => item.type === "published").length >= 1, "published versions remain in history");

  const resolved = engine.resolveCourseVisual("cromwell");
  assert.equal(resolved.status, "published", "resolveCourseVisual prefers published over basic");
  assert.equal(resolved.publishedVisual.version, published.publishedVersion);

  const basicOnlyInput = engine.adaptCoursePlayPayloadToVisualInput(Object.assign({}, payload(), { courseId: "basic-only", courseKey: "basic-only" }), {
    captures: [manifest("manifest-basic", 1, 0)]
  });
  engine.ingestCourseVisualInput(basicOnlyInput);
  await engine.buildCourseVisualMaster("basic-only");
  const basicOnly = engine.resolveCourseVisual("basic-only");
  assert.equal(basicOnly.status, "basic-ready", "resolveCourseVisual returns basic when no published version exists");
  assert.equal(engine.resolveCourseVisual("missing-course"), null, "resolveCourseVisual returns null when neither asset exists");

  const beforeVersions = engine.getRecord("basic-only").versions.length;
  const [a, b] = await Promise.all([
    engine.buildCourseVisualMaster("basic-only"),
    engine.buildCourseVisualMaster("basic-only")
  ]);
  assert.equal(a.currentVersion, b.currentVersion);
  assert.equal(engine.getRecord("basic-only").versions.length, beforeVersions, "duplicate build requests do not create conflicting versions");

  const globalPreset = engine.getPreset("clarity-course-natural-v1");
  const merged = engine.mergePreset(globalPreset, { turf: { greenStrength: 0.9 } });
  assert.equal(globalPreset.turf.greenStrength, 0.35, "course overrides do not mutate the global preset");
  assert.equal(merged.turf.greenStrength, 0.9, "global preset inheritance accepts course overrides");

  const rawBefore = engine.getRecord("cromwell").rawMaster.dataUrl;
  await engine.buildCourseVisualPreview("cromwell", engine.presetForMode("Strong"), { turf: { greenStrength: 0.2 } });
  engine.publishCourseVisual("cromwell");
  assert.equal(engine.getRecord("cromwell").rawMaster.dataUrl, rawBefore, "raw master remains unchanged after preview and publish");

  const restored = engine.getRecord("cromwell");
  assert.equal(restored.status, "published", "reloading admin state restores current visual status from local store");
  assert.ok(restored.diagnostics.stitchOutputDimensions.width > 0, "diagnostics include stitch output dimensions");
  assert.ok((restored.events || []).some((event) => event.type === "course-visual-published"), "structured diagnostic event names are recorded");

  console.log("course visual engine tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
