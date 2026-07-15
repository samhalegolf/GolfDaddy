#!/usr/bin/env node
"use strict";

const assert = require("assert");
const path = require("path");

function svgText(dataUrl) {
  const body = String(dataUrl || "").split(",")[1] || "";
  return decodeURIComponent(body);
}

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

function worldPixel(lat, lng, zoom) {
  const scale = 256 * Math.pow(2, zoom);
  const sin = Math.sin(lat * Math.PI / 180);
  return {
    x: (lng + 180) / 360 * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale
  };
}

function manifest(id, holeNumber, xOffset) {
  const zoom = 17;
  const imageWidth = 512;
  const imageHeight = 512;
  const center = worldPixel(-45.012 - holeNumber * 0.001, 169.102, zoom);
  return {
    key: id,
    courseKey: "cromwell",
    courseName: "Cromwell Golf Course",
    holeNumber,
    imageWidth,
    imageHeight,
    captureZoom: zoom,
    originPx: { x: Math.round(center.x - imageWidth / 2 + (xOffset || 0)), y: Math.round(center.y - imageHeight / 2) },
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
      { x: 0, y: 0, z: zoom, tileX: 1, tileY: 2, url: "https://tiles.test/" + id + "/0.png" },
      { x: 256, y: 0, z: zoom, tileX: 2, tileY: 2, url: "https://tiles.test/" + id + "/1.png" },
      { x: 0, y: 256, z: zoom, tileX: 1, tileY: 3, url: "https://tiles.test/" + id + "/2.png" },
      { x: 256, y: 256, z: zoom, tileX: 2, tileY: 3, url: "https://tiles.test/" + id + "/3.png" }
    ],
    createdAt: "2026-07-15T00:00:00.000Z"
  };
}

function visualManifest(id, request, xOffset) {
  const base = manifest(id, Number(request.holeNumber) || 1, xOffset || 0);
  return Object.assign({}, base, {
    key: id,
    courseKey: request.courseId || "cromwell",
    courseName: request.courseName || "Cromwell Golf Course",
    holeNumber: Number(request.holeNumber) || 1,
    visualRole: request.role,
    visualQuality: request.quality,
    visualPlanId: request.planId || request.id,
    stitchLayer: request.stitchLayer,
    debugUnderlay: !!request.debugUnderlay,
    debugTerrain: !!request.debugTerrain,
    terrainStageOnly: !!request.terrainStageOnly,
    beta3dStageOnly: !!request.beta3dStageOnly,
    cameraMode: request.cameraMode || "",
    cameraTiltDeg: Number.isFinite(Number(request.cameraTiltDeg)) ? Number(request.cameraTiltDeg) : null,
    captureTiltDeg: Number.isFinite(Number(request.captureTiltDeg)) ? Number(request.captureTiltDeg) : null,
    playTiltDeg: Number.isFinite(Number(request.playTiltDeg)) ? Number(request.playTiltDeg) : null,
    mapCameraCapability: request.mapCameraCapability || null,
    nativePitchAvailable: request.nativePitchAvailable === true,
    nativeBearingAvailable: request.nativeBearingAvailable === true,
    cameraFallback: request.cameraFallback || "",
    captureLens: request.captureLens || request.lensShape || "",
    lensShape: request.lensShape || request.captureLens || "",
    lensAspectRatio: Number.isFinite(Number(request.lensAspectRatio)) ? Number(request.lensAspectRatio) : null,
    lensOrientation: request.lensOrientation || "",
    lensFit: request.lensFit || "",
    segmentIndex: Number.isFinite(Number(request.segmentIndex)) ? Number(request.segmentIndex) : null,
    segmentCount: Number.isFinite(Number(request.segmentCount)) ? Number(request.segmentCount) : null,
    segmentStartMeters: Number.isFinite(Number(request.segmentStartMeters)) ? Number(request.segmentStartMeters) : null,
    segmentEndMeters: Number.isFinite(Number(request.segmentEndMeters)) ? Number(request.segmentEndMeters) : null,
    routeLengthMeters: Number.isFinite(Number(request.routeLengthMeters)) ? Number(request.routeLengthMeters) : null,
    tileSourceLabel: request.tileSourceLabel || ""
  });
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
  const enginePath = path.join(__dirname, "..", "scripts", "gd-course-visual-engine.js");
  const engine = require(enginePath);
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
  const plan = engine.planCourseVisualCaptures(input);
  const planRoles = plan.map((item) => item.role);
  assert.ok(planRoles.includes("course-backdrop"), "planned captures include a live map underlay");
  assert.ok(planRoles.includes("terrain-reference"), "planned captures include a terrain-reference stage");
  assert.ok(planRoles.includes("green-surround"), "planned captures include super-HD green surrounds");
  assert.ok(planRoles.includes("play-corridor"), "planned captures include HD play corridor");
  assert.equal(planRoles.includes("three-d-hole-beta"), false, "3D beta capture is opt-in");
  const betaPlan = engine.planCourseVisualCaptures(input, { enable3dBeta: true });
  assert.ok(betaPlan.some((item) => item.role === "three-d-hole-beta"), "3D beta capture can be enabled");
  assert.ok(plan.find((item) => item.role === "green-surround").targetZoom > plan.find((item) => item.role === "play-corridor").targetZoom, "green capture asks for more pixels than corridor capture");
  assert.ok(plan.find((item) => item.role === "play-corridor").targetZoom > plan.find((item) => item.role === "course-backdrop").targetZoom, "corridor capture asks for more pixels than live underlay");
  assert.equal(plan.find((item) => item.role === "green-surround").captureLens, "green-square", "green captures remain square super-HD tiles");
  assert.equal(plan.find((item) => item.role === "green-surround").lensAspectRatio, 1, "green capture lens is square");
  assert.equal(plan.find((item) => item.role === "play-corridor").captureLens, "mobile-hole", "corridor captures use long mobile-hole rectangles");
  assert.equal(plan.find((item) => item.role === "play-corridor").lensAspectRatio, 9 / 16, "corridor lens is portrait shaped");
  const corridorSegments = plan.filter((item) => item.role === "play-corridor");
  assert.ok(corridorSegments.length > 1, "long corridors split into multiple fixed-zoom rectangles instead of zooming out");
  assert.ok(corridorSegments.every((item) => item.targetZoom === 19 && item.minZoom === 19), "corridor segments keep a consistent HD zoom");
  assert.ok(corridorSegments.every((item) => item.segmentCount === corridorSegments.length), "corridor segments carry segment metadata for stitching");
  assert.equal(plan.find((item) => item.role === "course-backdrop").captureLens, undefined, "course underlay remains a broad map capture");
  assert.equal(plan.find((item) => item.role === "terrain-reference").captureLens, undefined, "terrain reference remains course-wide");
  assert.equal(betaPlan.find((item) => item.role === "three-d-hole-beta").captureLens, "mobile-hole", "3D beta captures use the same mobile lens");

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
  assert.equal(built.rawMaster.metadata.rendererVersion, "clarity-course-visual-renderer-v6");
  assert.equal(built.rawMaster.metadata.layout, "geographic-mercator");
  assert.equal(built.rawMaster.metadata.stitchModel, "geo-rectangle-table-over-live-map", "stitch metadata describes overlapping rectangles over a live map base");
  assert.ok(decodeURIComponent(built.rawMaster.dataUrl).includes("data-stitch-width"), "raw stitch keeps coverage geometry as metadata attributes");
  assert.ok(!decodeURIComponent(built.rawMaster.dataUrl).includes("SUPER HD GREEN"), "raw stitch does not bake debug labels into the visual product");
  assert.ok(built.rawMaster.height / built.rawMaster.width < 8, "full-course stitch does not collapse into a giant vertical strip");
  assert.ok(built.exampleHoleVisual.dataUrl.startsWith("data:image/svg+xml"), "example hole preview is built from the same captures");
  assert.ok(built.terrainView && built.terrainView.dataUrl.startsWith("data:image/svg+xml"), "course overview enters a terrain shading stage after the base stitch");
  assert.equal(built.rawMaster.dataUrl, built.basicVisual.dataUrl, "raw master feeds basic delivery without recompression");
  const persistedAfterBuild = JSON.parse(localStorage.getItem(engine.storeKey));
  assert.equal(persistedAfterBuild.records.cromwell.rawMaster.dataUrl, undefined, "raw data URL is not persisted into localStorage");
  assert.equal(persistedAfterBuild.records.cromwell.basicVisual.dataUrl, undefined, "basic data URL is not persisted into localStorage");
  assert.equal(persistedAfterBuild.records.cromwell.exampleHoleVisual.dataUrl, undefined, "example-hole data URL is not persisted into localStorage");
  assert.equal(persistedAfterBuild.records.cromwell.terrainView.dataUrl, undefined, "terrain data URL is not persisted into localStorage");

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
  assert.equal(preview.previewVisual.metadata.stage, "native-visuals", "course overview enters native visuals");
  const overviewSvg = svgText(preview.previewVisual.dataUrl);
  assert.ok(overviewSvg.includes("cvMowingStripe"), "preset mowing visibility is baked into native visuals");
  assert.ok(overviewSvg.includes("green-strength"), "green strength is baked into native visuals as a visible layer");
  assert.ok(!overviewSvg.includes("fairway-airbrush"), "course overview native visuals do not apply the airbrush pass");
  assert.equal(preview.previewVisual.metadata.fairwayAirbrush.enabled, false, "course overview explicitly records airbrush as disabled");
  assert.equal(preview.terrainView.metadata.stage, "terrain-shading", "course overview enters terrain shading after native visuals");
  assert.equal(preview.terrainView.metadata.inputStage, "native-visuals", "overview terrain shading consumes the native visual output");
  assert.equal(preview.terrainView.metadata.terrainStrength, 0.42, "course overview keeps the softer terrain strength");
  assert.ok(preview.singleHolePreviewVisual.path.includes("/single-hole/preview/"), "single-hole visual enters native visuals");
  assert.equal(preview.singleHolePreviewVisual.metadata.stage, "native-visuals", "single-hole native visual records the native stage");
  const singleHoleNativeSvg = svgText(preview.singleHolePreviewVisual.dataUrl);
  assert.ok(singleHoleNativeSvg.includes("fairway-airbrush"), "single-hole native visuals include the fairway burn-rescue airbrush layer");
  assert.ok(!singleHoleNativeSvg.includes("green-surround-airbrush"), "single-hole native visuals do not touch up greens");
  assert.ok(!singleHoleNativeSvg.includes("cvGreenSurroundAirbrushClip"), "green touch-up masks are removed completely");
  assert.equal(preview.singleHolePreviewVisual.metadata.fairwayAirbrush.preserves, "relative-luminance-and-mow-lines", "fairway airbrush preserves mowing-line texture");
  assert.equal(preview.singleHolePreviewVisual.metadata.greenSurroundAirbrush.enabled, false, "green touch-up metadata is disabled");
  assert.equal(preview.singleHolePreviewVisual.metadata.greenSurroundAirbrush.reason, "removed-green-touch-up", "green touch-up removal is explicit");
  assert.ok(preview.singleHoleTerrainView.path.includes("/single-hole/terrain/"), "single-hole visual enters terrain shading");
  assert.equal(preview.singleHoleTerrainView.metadata.inputStage, "native-visuals", "single-hole terrain shading consumes the native hole output");
  assert.equal(preview.singleHoleTerrainView.metadata.terrainStrength, 0.85, "single-hole terrain uses the stronger preset terrain strength");
  assert.equal(preview.publishedVisual, null, "preview does not publish");

  const published = engine.publishCourseVisual("cromwell");
  assert.equal(published.status, "published", "publish changes active version");
  assert.equal(published.publishedVersion, preview.previewVisual.version);
  assert.equal(published.publishedVisual.dataUrl, published.terrainView.dataUrl, "published overview uses the terrain-shaded product");
  assert.ok(published.singleHolePublishedVisual && published.singleHolePublishedVisual.dataUrl === published.singleHoleTerrainView.dataUrl, "publish includes the terrain-shaded single-hole product");
  assert.ok(published.versions.filter((item) => item.type === "published").length >= 1, "published versions remain in history");

  const originalFetch = global.fetch;
  const originalAccounts = global.GolfDaddyAccounts;
  let cloudRequest = null;
  global.GolfDaddyAccounts = { current() { return { role: "admin", email: "samhalegolf@gmail.com", accountId: "acct-test" }; } };
  global.fetch = async function mockCourseVisualCloud(url, options) {
    cloudRequest = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        storage: "supabase",
        play_payload: {
          status: "published",
          published_visual: { url: "https://example.test/course-visuals/cromwell/published/2.svg" }
        }
      })
    };
  };
  const cloud = await engine.syncPublishedCourseVisual("cromwell", "publish");
  assert.equal(cloud.storage, "supabase", "explicit publish sync waits for Supabase");
  assert.equal(cloud.play_payload.status, "published", "cloud response contains the Play payload");
  assert.equal(cloudRequest.url, "/api/course-visuals", "published visuals sync to the course visuals endpoint");
  assert.equal(cloudRequest.body.visual.status, "published", "cloud sync sends a published visual record");
  assert.ok(cloudRequest.body.visual.assets.some((asset) => asset.role === "published"), "cloud sync uploads the published overview asset");
  assert.ok(cloudRequest.body.visual.assets.some((asset) => asset.role === "single-hole-published"), "cloud sync uploads the single-hole published asset");
  assert.equal(engine.getRecord("cromwell").diagnostics.cloudPublish.playPayloadReady, true, "local diagnostics record Play payload readiness");
  global.fetch = originalFetch;
  global.GolfDaddyAccounts = originalAccounts;

  const resolved = engine.resolveCourseVisual("cromwell");
  assert.equal(resolved.status, "published", "resolveCourseVisual prefers published over basic");
  assert.equal(resolved.publishedVisual.version, published.publishedVersion);
  assert.equal(resolved.singleHolePublishedVisual.version, published.publishedVersion, "resolved metadata includes the published single-hole product");

  const basicOnlyInput = engine.adaptCoursePlayPayloadToVisualInput(Object.assign({}, payload(), { courseId: "basic-only", courseKey: "basic-only" }), {
    captures: [manifest("manifest-basic", 1, 0)]
  });
  engine.ingestCourseVisualInput(basicOnlyInput);
  await engine.buildCourseVisualMaster("basic-only");
  const basicOnly = engine.resolveCourseVisual("basic-only");
  assert.equal(basicOnly, null, "resolveCourseVisual keeps Play on live map until a Clarity map is published");
  assert.equal(engine.resolveCourseVisual("missing-course"), null, "resolveCourseVisual returns null when neither asset exists");

  const beforeVersions = engine.getRecord("basic-only").versions.length;
  const [a, b] = await Promise.all([
    engine.buildCourseVisualMaster("basic-only"),
    engine.buildCourseVisualMaster("basic-only")
  ]);
  assert.equal(a.currentVersion, b.currentVersion);
  assert.equal(engine.getRecord("basic-only").versions.length, beforeVersions, "duplicate build requests do not create conflicting versions");

  const multiInput = engine.adaptCoursePlayPayloadToVisualInput(Object.assign({}, payload(), { courseId: "multi-capture", courseKey: "multi-capture" }), {
    captures: [manifest("manifest-multi-1", 1, 0), manifest("manifest-multi-2", 2, 0), manifest("manifest-multi-3", 3, 0)]
  });
  engine.ingestCourseVisualInput(multiInput);
  const multiBuilt = await engine.buildCourseVisualMaster("multi-capture");
  assert.equal(multiBuilt.rawMaster.metadata.rendererVersion, "clarity-course-visual-renderer-v6");
  assert.ok(multiBuilt.rawMaster.height < 12000, "multi-capture stitch is geographically laid out instead of vertically appended");
  assert.ok(multiBuilt.rawMaster.height / multiBuilt.rawMaster.width < 8, "multi-capture output keeps a usable preview aspect");

  const originalPipeline = global.GDCoursePlayPipeline;
  const originalExecutor = global.gdBuildCourseVisualCaptureManifest;
  const visualRequests = [];
  global.GDCoursePlayPipeline = {
    buildCoursePlayDbPayload() {
      return Object.assign({}, payload(), { courseId: "planned-course", courseKey: "planned-course" });
    },
    getCoursePlayFrameIndex() {
      return [];
    }
  };
  global.gdBuildCourseVisualCaptureManifest = function buildVisualCapture(request) {
    visualRequests.push(request);
    const capture = visualManifest("visual-" + request.role + "-" + (request.holeNumber || "course"), request, visualRequests.length * 20);
    if (request.role === "three-d-hole-beta") {
      capture.mapCameraCapability = {
        provider: "leaflet",
        library: "leaflet",
        nativePitchAvailable: false,
        nativeBearingAvailable: false,
        pitchStrategy: "faux-tilt-svg",
        reason: "plain-leaflet-no-native-pitch"
      };
      capture.cameraFallback = "leaflet-flat-capture-faux-tilt-stage";
    }
    return capture;
  };
  const plannedBuilt = await engine.buildFromCourseDatabase("planned-course", { enable3dBeta: true });
  const requestedRoles = visualRequests.map((request) => request.role);
  assert.ok(requestedRoles.includes("course-backdrop"), "Build Basic asks browser capture for the live underlay");
  assert.ok(requestedRoles.includes("terrain-reference"), "Build Basic asks browser capture for terrain reference");
  assert.ok(requestedRoles.includes("green-surround"), "Build Basic asks browser capture for super-HD green");
  assert.ok(requestedRoles.includes("play-corridor"), "Build Basic asks browser capture for HD corridor");
  assert.ok(requestedRoles.includes("three-d-hole-beta"), "Build Basic asks browser capture for 3D beta when toggled");
  assert.ok(visualRequests.filter((request) => request.role === "green-surround").every((request) => request.captureLens === "green-square" && request.lensAspectRatio === 1), "green capture requests carry the green-square lens into the browser capture step");
  assert.ok(visualRequests.filter((request) => request.role === "play-corridor" || request.role === "three-d-hole-beta").every((request) => request.captureLens === "mobile-hole" && request.lensAspectRatio === 9 / 16), "corridor and 3D capture requests carry the mobile-hole lens into the browser capture step");
  assert.equal(plannedBuilt.exampleHoleVisual.metadata.windowShape, "mobile-hole", "single-hole product uses the mobile golf-hole window");
  assert.ok(Math.abs(plannedBuilt.exampleHoleVisual.width / plannedBuilt.exampleHoleVisual.height - 9 / 16) < 0.02, "single-hole window is portrait instead of square");
  assert.ok(plannedBuilt.exampleHoleVisual.metadata.sourceCaptureCount > 1, "single-hole window stitches hole captures instead of picking one square");
  assert.ok(plannedBuilt.terrainView && plannedBuilt.terrainView.dataUrl.startsWith("data:image/svg+xml"), "terrain view is built as a separate derived stage");
  assert.ok(plannedBuilt.beta3dView && plannedBuilt.beta3dView.dataUrl.startsWith("data:image/svg+xml"), "3D beta view is built as a separate opt-in stage");
  assert.equal(plannedBuilt.beta3dView.metadata.cameraModel, "faux-3d-svg-perspective", "3D beta uses faux perspective when Leaflet has no pitch");
  assert.equal(plannedBuilt.beta3dView.metadata.nativePitchAvailable, false, "3D beta records native pitch as unavailable");
  assert.equal(plannedBuilt.beta3dView.metadata.mapCameraCapability.reason, "plain-leaflet-no-native-pitch", "3D beta records the Leaflet fallback reason");
  assert.equal(plannedBuilt.rawMaster.metadata.visualLayerModel, "live-underlay-plus-feathered-captures", "raw master records the visual layer model");
  assert.equal(plannedBuilt.diagnostics.stageSettings.enable3dBeta, true, "3D beta toggle is recorded in diagnostics");

  const snapshotChoiceRequests = [];
  global.GDCoursePlayPipeline = {
    buildCoursePlayDbPayload() {
      return Object.assign({}, payload(), { courseId: "snapshot-choice", courseKey: "snapshot-choice" });
    },
    getCoursePlayFrameIndex() {
      return [];
    }
  };
  global.gdBuildCourseVisualCaptureManifest = function buildSnapshotChoiceCapture(request) {
    snapshotChoiceRequests.push(request);
    if (request.role === "green-surround") {
      const tooGreen = Object.assign(visualManifest("snapshot-too-green", request, 0), {
        analysis: { greenLushness: 0.95, fairwayLines: 0.35 },
        snapshotId: "snapshot-too-green"
      });
      const balanced = Object.assign(visualManifest("snapshot-balanced", request, 10), {
        analysis: { greenLushness: 0.78, fairwayLines: 0.74 },
        snapshotId: "snapshot-balanced"
      });
      const fairwayTieBreak = Object.assign(visualManifest("snapshot-fairway-lines", request, 20), {
        analysis: { greenLushness: 0.74, fairwayLines: 0.78 },
        snapshotId: "snapshot-fairway-lines"
      });
      return { olderSnapshots: [tooGreen, balanced, fairwayTieBreak] };
    }
    return visualManifest("snapshot-" + request.role + "-" + (request.holeNumber || "course"), request, snapshotChoiceRequests.length * 15);
  };
  const snapshotChoiceBuilt = await engine.buildFromCourseDatabase("snapshot-choice");
  const snapshotSelection = snapshotChoiceBuilt.diagnostics.captureExecution.snapshotSelection.find((item) => item.role === "green-surround");
  assert.ok(snapshotSelection, "capture execution records older-snapshot selection diagnostics");
  assert.equal(snapshotSelection.selectedCaptureId, "snapshot-fairway-lines", "older snapshot selection breaks balanced ties toward fairway lines");
  assert.equal(snapshotSelection.candidateCount, 3, "older snapshot selection scores all candidates");
  assert.equal(snapshotSelection.tieBreak, "fairway-lines", "snapshot tie-break policy is explicit");
  global.GDCoursePlayPipeline = originalPipeline;
  global.gdBuildCourseVisualCaptureManifest = originalExecutor;

  const globalPreset = engine.getPreset("clarity-course-natural-v1");
  const presetStore = engine.loadPresets();
  const presetList = engine.courseVisualPresetList();
  assert.equal(presetStore.version, 4, "preset store upgrades to the current built-in preset version");
  assert.ok(presetList.length >= 8 && presetList.length <= 10, "admin gets a proper preset palette without becoming noisy");
  assert.ok(presetList.some((preset) => preset.id === "clarity-course-green-detail-v1"), "green detail preset is available");
  assert.ok(presetList.some((preset) => preset.id === "clarity-course-terrain-relief-v1"), "terrain relief preset is available");
  assert.ok(presetList.some((preset) => preset.id === "clarity-course-acid-test-v1"), "overcooked debug preset is available");
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

  const reloadInput = engine.adaptCoursePlayPayloadToVisualInput(Object.assign({}, payload(), { courseId: "reload-missing-asset", courseKey: "reload-missing-asset" }), {
    captures: [manifest("manifest-reload-missing-asset", 1, 0)]
  });
  localStorage.setItem("manifest-reload-missing-asset", JSON.stringify(manifest("manifest-reload-missing-asset", 1, 0)));
  engine.ingestCourseVisualInput(reloadInput);
  const firstReloadBuild = await engine.buildCourseVisualMaster("reload-missing-asset");
  assert.equal(firstReloadBuild.currentVersion, 1);
  delete require.cache[require.resolve(enginePath)];
  const reloadedEngine = require(enginePath);
  assert.equal(reloadedEngine.getRecord("reload-missing-asset").basicVisual.dataUrl, undefined, "reload starts with metadata but no transient image data");
  const rebuiltAfterReload = await reloadedEngine.buildCourseVisualMaster("reload-missing-asset");
  assert.equal(rebuiltAfterReload.currentVersion, 2, "Build Basic regenerates when the saved v2 asset data is missing after reload");
  assert.ok(rebuiltAfterReload.basicVisual.dataUrl.startsWith("data:image/svg+xml"), "regenerated asset is immediately renderable");

  console.log("course visual engine tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
