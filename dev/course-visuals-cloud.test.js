#!/usr/bin/env node
"use strict";

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

(async function run() {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "functions", "course-visuals.mjs")).href);
  const { sanitizeVisual, visualToRow, rowToVisual, sanitizeAsset, dataUrlToBytes } = mod.__courseVisualsTest;

  const visual = sanitizeVisual({
    id: "visual::cromwell",
    course_id: "Cromwell Golf Course",
    status: "published",
    raw_master_path: "course-visuals/cromwell/raw/visual.svg",
    basic_image_path: "course-visuals/cromwell/basic/1.svg",
    preview_image_path: "course-visuals/cromwell/preview/2.svg",
    published_image_path: "course-visuals/cromwell/published/2.svg",
    course_bounds: { south: -45.02, west: 169.1, north: -45.01, east: 169.11 },
    source_capture_ids: ["manifest-1"],
    preset_id: "clarity-course-natural-v1",
    preset_version: 1,
    course_overrides: { turf: { greenStrength: 0.5 } },
    current_version: 2,
    published_version: 2,
    last_error: null,
    diagnostics: { rendererVersion: "clarity-course-visual-renderer-v2" },
    versions: [{ version: 1, type: "basic" }],
    uploaded_assets: [{ path: "course-visuals/cromwell/basic/1.svg", role: "basic" }]
  });

  assert.equal(visual.course_id, "cromwell-golf-course");
  assert.equal(visual.status, "published");
  assert.equal(visual.preset_version, 1);
  assert.deepEqual(visual.source_capture_ids, ["manifest-1"]);

  const row = visualToRow(visual);
  assert.equal(row.id, "visual::cromwell");
  assert.equal(row.created_at, undefined);

  const restored = rowToVisual(Object.assign({}, row, {
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T01:00:00.000Z"
  }));
  assert.equal(restored.course_id, "cromwell-golf-course");
  assert.equal(restored.published_image_path, "course-visuals/cromwell/published/2.svg");
  assert.equal(restored.versions[0].type, "basic");
  assert.equal(restored.uploaded_assets[0].role, "basic");

  const asset = sanitizeAsset({
    path: "course-visuals/cromwell/basic/1.svg",
    role: "basic",
    contentType: "image/svg+xml",
    dataUrl: "data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E"
  });
  assert.equal(asset.path, "cromwell/basic/1.svg");
  assert.equal(dataUrlToBytes(asset.dataUrl).toString("utf8"), "<svg></svg>");

  const optionsResponse = await mod.default(new Request("https://clarity-caddie.test/api/course-visuals", { method: "OPTIONS" }));
  assert.equal(optionsResponse.status, 200);
  assert.equal(optionsResponse.headers.get("Access-Control-Allow-Methods"), "GET,POST,OPTIONS");

  console.log("course visuals cloud tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
