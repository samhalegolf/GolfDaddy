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
  const lensLocalCorners = request.captureLens === "mobile-hole" ? [
    { x: 126, y: 18 },
    { x: 494, y: 166 },
    { x: 386, y: 502 },
    { x: 18, y: 354 }
  ] : [];
  const lensCornersPx = lensLocalCorners.map((point) => ({
    x: base.originPx.x + point.x,
    y: base.originPx.y + point.y
  }));
  return Object.assign({}, base, {
    key: id,
    courseKey: request.courseId || "cromwell",
    courseName: request.courseName || "Cromwell Golf Course",
    holeNumber: Number(request.holeNumber) || 1,
    visualRole: request.role,
    visualQuality: request.quality,
    visualPlanId: request.planId || request.id,
    stitchLayer: request.stitchLayer,
    anchorPins: request.anchorPins || base.anchorPins,
    captureAnchorPins: request.captureAnchorPins || {},
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
    tileSourceLabel: request.tileSourceLabel || "",
    lensLocalCorners,
    lensCornersPx
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
  assert.equal(plan.find((item) => item.role === "play-corridor").lensOrientation, "play-axis", "corridor lens is aimed by the hole axis rather than north");
  const corridorSegments = plan.filter((item) => item.role === "play-corridor");
  assert.ok(corridorSegments.length > 1, "long corridors split into multiple fixed-zoom rectangles instead of zooming out");
  assert.ok(corridorSegments.every((item) => item.targetZoom === 19 && item.minZoom === 19), "corridor segments keep a consistent HD zoom");
  assert.ok(corridorSegments.every((item) => item.segmentCount === corridorSegments.length), "corridor segments carry segment metadata for stitching");
  assert.ok(corridorSegments.every((item) => item.includeAnchorPins === true && item.captureAnchorPins && Array.isArray(item.captureAnchorPins.route) && item.captureAnchorPins.route.length >= 2), "corridor segments carry a wider donor-image route into capture");
  assert.ok(corridorSegments.every((item) => item.anchorPins && item.anchorPins.green && Array.isArray(item.anchorPins.route) && item.anchorPins.route.length >= item.captureAnchorPins.route.length), "corridor segments keep the full-hole anchors for GPS Play");
  assert.equal(plan.find((item) => item.role === "course-backdrop").captureLens, undefined, "course underlay remains a broad map capture");
  assert.equal(plan.find((item) => item.role === "terrain-reference").captureLens, undefined, "terrain reference remains course-wide");
  assert.equal(betaPlan.find((item) => item.role === "three-d-hole-beta").captureLens, "mobile-hole", "3D beta captures use the same mobile lens");
  assert.equal(betaPlan.find((item) => item.role === "three-d-hole-beta").lensOrientation, "play-axis", "3D beta captures use the hole axis too");

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
  assert.equal(built.rawMaster.metadata.rendererVersion, "clarity-course-visual-renderer-v26");
  assert.equal(built.rawMaster.metadata.layout, "geographic-mercator");
  assert.equal(built.rawMaster.metadata.stitchModel, "geo-rectangle-table-over-live-map", "stitch metadata describes overlapping rectangles over a live map base");
  assert.ok(decodeURIComponent(built.rawMaster.dataUrl).includes("data-stitch-width"), "raw stitch keeps coverage geometry as metadata attributes");
  assert.ok(!decodeURIComponent(built.rawMaster.dataUrl).includes("SUPER HD GREEN"), "raw stitch does not bake debug labels into the visual product");
  assert.ok(built.rawMaster.height / built.rawMaster.width < 8, "full-course stitch does not collapse into a giant vertical strip");
  assert.ok(built.exampleHoleVisual.dataUrl.startsWith("data:image/svg+xml"), "example hole preview is built from the same captures");
  assert.ok(Array.isArray(built.holeFrameVisuals) && built.holeFrameVisuals.length >= 1, "base build creates ready per-hole play surfaces");
  assert.equal(built.holeFrameVisuals[0].metadata.framingModel, "gps-play-overcaptured-play-axis-surface", "hole surfaces keep GPS Play surface metadata");
  assert.equal(built.holeFrameVisuals[0].metadata.playSurface.projection, "play-axis-svg", "hole surfaces are already aligned to the hole axis for Play projection");
  assert.equal(built.holeFrameVisuals[0].metadata.playSurface.useGpsPlayFraming, true, "hole surfaces tell Play to frame on the per-hole surface");
  assert.equal(built.holeFrameVisuals[0].metadata.playSurface.fallbackUnderlay, "live-gps", "hole surfaces fall back only to live GPS");
  assert.equal(built.holeFrameVisuals[0].metadata.playSurface.fallbackPolicy, "live-gps-only", "hole surfaces do not point Play at a stitched fallback");
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
  }, { presetId: "clarity-course-fresh-v1" });
  assert.equal(settingsRecord.settingsDirty, true, "preview settings are saved without publishing");
  assert.equal(settingsRecord.presetId, "clarity-course-fresh-v1", "preset selection is saved immediately before async preview rendering");
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
  assert.ok(singleHoleNativeSvg.includes("cvHoleWindowClip"), "single-hole native visuals come from the direct play-axis hole capture window");
  assert.ok(!singleHoleNativeSvg.includes('data-role="play-underlay"'), "single-hole capture does not need a course-overview underlay");
  assert.ok(singleHoleNativeSvg.includes('data-role="play-route-axis"'), "single-hole preview proves the route/fairway axis from real anchors");
  assert.ok(singleHoleNativeSvg.includes('data-role="play-green-bound"'), "single-hole preview proves the green bound from real anchors");
  assert.ok(singleHoleNativeSvg.includes('data-proof-layer="behind-imagery"'), "single-hole object proof is retained only behind the imagery");
  assert.ok(singleHoleNativeSvg.indexOf('data-role="play-route-axis"') < singleHoleNativeSvg.indexOf("<image "), "route proof paints behind the captured image tiles");
  assert.ok(!singleHoleNativeSvg.includes("green-surround-airbrush"), "single-hole native visuals do not touch up greens");
  assert.ok(!singleHoleNativeSvg.includes("cvGreenSurroundAirbrushClip"), "green touch-up masks are removed completely");
  assert.ok(!singleHoleNativeSvg.includes('data-role="fairway-airbrush"'), "single-hole visuals do not airbrush generated route-only fairway lines");
  assert.equal(preview.singleHolePreviewVisual.metadata.fairwayAirbrush.enabled, false, "route-only fairway objects are not eligible for the airbrush");
  assert.equal(preview.singleHolePreviewVisual.metadata.fairwayAirbrush.reason, "missing-fairway-polygon-geometry", "airbrush waits for real OSM fairway polygon bounds");
  assert.equal(preview.singleHolePreviewVisual.metadata.greenSurroundAirbrush.enabled, false, "green touch-up metadata is disabled");
  assert.equal(preview.singleHolePreviewVisual.metadata.greenSurroundAirbrush.reason, "removed-green-touch-up", "green touch-up removal is explicit");
  assert.equal(preview.singleHolePreviewVisual.metadata.overflowVisible, true, "single-hole preview exposes the captured overflow outside the phone frame");
  assert.equal(preview.singleHolePreviewVisual.metadata.playSurface.useGpsPlayFraming, true, "single-hole preview is derived from the GPS Play surface");
  assert.equal(preview.singleHolePreviewVisual.metadata.objectProofOverlay.enabled, true, "single-hole preview carries object proof metadata");
  assert.ok(preview.singleHoleTerrainView.path.includes("/single-hole/terrain/"), "single-hole visual enters terrain shading");
  assert.equal(preview.singleHoleTerrainView.metadata.inputRole, "single-hole-native-visuals", "single-hole terrain view consumes the direct native hole window");
  assert.equal(preview.singleHoleTerrainView.metadata.inputStage, "native-visuals", "single-hole terrain view follows the native stage");
  assert.equal(preview.singleHoleTerrainView.metadata.terrainStrength, 0.85, "single-hole terrain uses the stronger preset terrain strength");
  assert.ok(preview.holeFramePreviewVisuals.length >= 1, "every hole frame enters native visuals");
  assert.ok(preview.holeFrameTerrainViews.length >= 1, "every hole frame enters terrain shading");
  assert.equal(preview.holeFrameTerrainViews[0].metadata.role, "hole-frame-terrain", "hole frame terrain output carries its own role");
  assert.equal(preview.holeFrameTerrainViews[0].metadata.playSurface.useGpsPlayFraming, true, "terrain hole frame keeps play-surface metadata");
  assert.equal(preview.publishedVisual, null, "preview does not publish");

  const published = engine.publishCourseVisual("cromwell");
  assert.equal(published.status, "published", "publish changes active version");
  assert.equal(published.publishedVersion, preview.previewVisual.version);
  assert.equal(published.publishedVisual.dataUrl, published.terrainView.dataUrl, "published overview uses the terrain-shaded product");
  assert.ok(published.singleHolePublishedVisual && published.singleHolePublishedVisual.dataUrl === published.singleHoleTerrainView.dataUrl, "publish includes the terrain-shaded single-hole product");
  assert.ok(published.holeFramePublishedVisuals.length >= 1, "publish includes per-hole GPS Play surfaces");
  assert.equal(published.holeFramePublishedVisuals[0].metadata.role, "hole-frame-published", "published hole frames have the Play-facing role");
  assert.equal(published.holeFramePublishedVisuals[0].metadata.playSurface.fallbackUnderlay, "live-gps", "published hole frames keep live GPS as the only fallback");
  assert.equal(published.holeFramePublishedVisuals[0].metadata.playSurface.fallbackPolicy, "live-gps-only", "published hole frames do not use a stitched fallback underlay");
  assert.ok(published.versions.filter((item) => item.type === "published").length >= 1, "published versions remain in history");

  const cloudVisualOriginalFetch = global.fetch;
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
  const cloudHoleFrames = cloudRequest.body.visual.assets.filter((asset) => asset.role === "hole-frame-published");
  assert.ok(cloudHoleFrames.length >= 1, "cloud sync uploads per-hole published assets");
  assert.ok(cloudHoleFrames.every((asset) => Number(asset.holeNumber) > 0), "cloud hole frame assets carry hole numbers");
  assert.equal(engine.getRecord("cromwell").diagnostics.cloudPublish.playPayloadReady, true, "local diagnostics record Play payload readiness");
  global.fetch = cloudVisualOriginalFetch;
  global.GolfDaddyAccounts = originalAccounts;

  const resolved = engine.resolveCourseVisual("cromwell");
  assert.equal(resolved.status, "published", "resolveCourseVisual prefers published over basic");
  assert.equal(resolved.publishedVisual.version, published.publishedVersion);
  assert.equal(resolved.singleHolePublishedVisual.version, published.publishedVersion, "resolved metadata includes the published single-hole product");
  assert.ok(resolved.holeFramePublishedVisuals.length >= 1, "resolved metadata includes published per-hole surfaces");

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
  assert.equal(multiBuilt.rawMaster.metadata.rendererVersion, "clarity-course-visual-renderer-v26");
  assert.ok(multiBuilt.rawMaster.height < 12000, "multi-capture stitch is geographically laid out instead of vertically appended");
  assert.ok(multiBuilt.rawMaster.height / multiBuilt.rawMaster.width < 8, "multi-capture output keeps a usable preview aspect");

  const originalPipeline = global.GDCoursePlayPipeline;
  const originalExecutor = global.gdBuildCourseVisualCaptureManifest;
  const originalFetchForManifestResolution = global.fetch;
  let automaticCourseVisualPosts = 0;
  const cromwellHoles = Array.from({ length: 18 }, (_, index) => {
    const holeNumber = index + 1;
    const lat = -45.011 - index * 0.001;
    const lng = 169.1 + index * 0.001;
    return {
      courseId: "cromwell",
      courseKey: "cromwell",
      courseName: "Cromwell Golf Course",
      holeNumber,
      status: "play_data_ready",
      teePoint: { lat, lng },
      greenCentre: { lat: lat - 0.002, lng: lng + 0.004 },
      greenShape: [
        { lat: lat - 0.0021, lng: lng + 0.0039 },
        { lat: lat - 0.0022, lng: lng + 0.0041 },
        { lat: lat - 0.0019, lng: lng + 0.0042 }
      ],
      routePoints: [
        { lat, lng },
        { lat: lat - 0.001, lng: lng + 0.002 },
        { lat: lat - 0.002, lng: lng + 0.004 }
      ]
    };
  });
  const cromwellFrameRows = cromwellHoles.map((hole) => {
    const indexedKey = `gd_captured_hole_frame_v19_Cromwell_Golf_Course:h${hole.holeNumber}`;
    const actualKey = `gd_captured_hole_frame_v19_cromwell:h${hole.holeNumber}`;
    localStorage.setItem(actualKey, JSON.stringify(Object.assign(manifest(actualKey, hole.holeNumber, hole.holeNumber * 30), { courseKey: "cromwell", courseName: "Cromwell Golf Course" })));
    return {
      schema: "gd.course_play_pipeline.frame",
      frameIndexKey: `cromwell:h${hole.holeNumber}`,
      courseId: "cromwell",
      courseKey: "cromwell",
      courseName: "Cromwell Golf Course",
      holeNumber: hole.holeNumber,
      manifestKey: indexedKey,
      capturedManifestKey: indexedKey
    };
  });
  localStorage.setItem("gd_course_play_frame_index_v1", JSON.stringify({
    schema: "gd.course_play_pipeline.frame_index",
    version: 1,
    updatedAt: null,
    frames: Object.fromEntries(cromwellFrameRows.map((row) => [row.frameIndexKey, Object.assign({}, row)]))
  }));
  global.GDCoursePlayPipeline = {
    frameIndexStorageKey: "gd_course_play_frame_index_v1",
    buildCoursePlayDbPayload() {
      return { courseId: "cromwell", courseKey: "cromwell", courseName: "Cromwell Golf Course", holes: cromwellHoles };
    },
    getCoursePlayFrameIndex() {
      return cromwellFrameRows.map((row) => Object.assign({}, row));
    }
  };
  global.fetch = async function rejectAutomaticCourseVisualPost(url, options) {
    if (String(url).includes("/api/course-visuals") && options && options.method === "POST") automaticCourseVisualPosts += 1;
    throw new Error("unexpected fetch during native visual build");
  };
  const cromwellNative = await engine.buildFromCourseDatabase("cromwell");
  assert.equal(cromwellNative.diagnostics.manifestResolution.required, 18, "Cromwell native build requires every indexed frame manifest");
  assert.equal(cromwellNative.diagnostics.manifestResolution.resolved, 18, "Cromwell resolves all captured-frame manifest aliases");
  assert.equal(cromwellNative.diagnostics.manifestResolution.missing, 0, "Cromwell has no missing captured-frame manifests");
  assert.equal(cromwellNative.diagnostics.manifestResolution.repairedFrameIndex, true, "stale Cromwell frame-index keys are repaired to the working manifest keys");
  assert.equal(cromwellNative.diagnostics.publishEnabled, true, "native visual becomes eligible for manual publishing after complete manifest resolution");
  assert.equal(cromwellNative.holeFrameVisuals.length, 18, "Cromwell has one base hole-frame visual per resolved manifest");
  const repairedCromwellFrameIndex = JSON.parse(localStorage.getItem("gd_course_play_frame_index_v1"));
  assert.equal(repairedCromwellFrameIndex.frames["cromwell:h2"].manifestKey, "gd_captured_hole_frame_v19_cromwell:h2", "hole 2 frame-index entry is repaired to the actual stored manifest key");
  assert.deepEqual(cromwellNative.diagnostics.manifestResolution.resolvedManifests.find((item) => item.holeNumber === 2).attemptedKeys, [
    "gd_captured_hole_frame_v19_Cromwell_Golf_Course:h2",
    "gd_captured_hole_frame_v19_cromwell:h2",
    "gd_captured_hole_frame_v19_cromwell-golf-course:h2"
  ], "lookup order prefers the indexed key, then courseId, then course name / recovered key aliases");
  assert.equal(automaticCourseVisualPosts, 0, "native visual build does not automatically publish to /api/course-visuals");
  global.fetch = originalFetchForManifestResolution;
  global.GDCoursePlayPipeline = originalPipeline;

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
  const plannedRawSvg = svgText(plannedBuilt.rawMaster.dataUrl);
  const requestedRoles = visualRequests.map((request) => request.role);
  assert.ok(requestedRoles.includes("course-backdrop"), "Build Basic asks browser capture for the live underlay");
  assert.ok(requestedRoles.includes("terrain-reference"), "Build Basic asks browser capture for terrain reference");
  assert.ok(requestedRoles.includes("green-surround"), "Build Basic asks browser capture for super-HD green");
  assert.ok(requestedRoles.includes("play-corridor"), "Build Basic asks browser capture for HD corridor");
  assert.ok(requestedRoles.includes("three-d-hole-beta"), "Build Basic asks browser capture for 3D beta when toggled");
  assert.ok(visualRequests.filter((request) => request.role === "green-surround").every((request) => request.captureLens === "green-square" && request.lensAspectRatio === 1), "green capture requests carry the green-square lens into the browser capture step");
  assert.ok(visualRequests.filter((request) => request.role === "play-corridor" || request.role === "three-d-hole-beta").every((request) => request.captureLens === "mobile-hole" && request.lensAspectRatio === 9 / 16), "corridor and 3D capture requests carry the mobile-hole lens into the browser capture step");
  assert.ok(visualRequests.filter((request) => request.role === "play-corridor" || request.role === "three-d-hole-beta").every((request) => request.lensOrientation === "play-axis" && request.includeAnchorPins === true), "mobile-hole capture requests are aimed by the hole axis and include the donor route");
  assert.ok(visualRequests.filter((request) => request.holeNumber).every((request) => request.anchorPins && request.anchorPins.green && Array.isArray(request.anchorPins.route) && request.anchorPins.route.length >= 2), "planned hole captures carry the real green and route anchors into the browser snapshot step");
  assert.ok(visualRequests.filter((request) => request.role === "play-corridor").every((request) => request.captureAnchorPins && Array.isArray(request.captureAnchorPins.route) && request.captureAnchorPins.route.length >= 2), "planned corridor captures give the browser a segment route for the wider donor image");
  assert.ok(plannedRawSvg.includes('data-lens-clip="oriented-mobile-hole"'), "mobile-hole captures are clipped to the oriented donor lens instead of showing the north-up tile AABB");
  assert.equal(plannedBuilt.exampleHoleVisual.metadata.windowShape, "mobile-hole-with-overflow", "single-hole product uses the mobile golf-hole window with visible overflow");
  assert.equal(plannedBuilt.exampleHoleVisual.metadata.framingModel, "gps-play-viewport-over-hole-surface", "single-hole product previews the GPS Play viewport over the play surface");
  assert.equal(plannedBuilt.exampleHoleVisual.metadata.orientationSource, "tee-green-anchor", "single-hole preview rotates from real tee-to-green anchors");
  assert.equal(plannedBuilt.exampleHoleVisual.metadata.objectProofOverlay.enabled, true, "single-hole preview proves object overlay from the snapshot anchors");
  assert.ok(Math.abs(plannedBuilt.exampleHoleVisual.width / plannedBuilt.exampleHoleVisual.height - 9 / 16) < 0.02, "single-hole window is portrait instead of square");
  assert.ok(plannedBuilt.exampleHoleVisual.metadata.sourceCaptureCount > 1, "single-hole window stitches hole captures instead of picking one square");
  assert.ok(plannedBuilt.holeFrameVisuals.length >= 1, "planned build creates per-hole play surfaces");
  assert.equal(plannedBuilt.holeFrameVisuals[0].metadata.playSurface.useGpsPlayFraming, true, "planned hole surface is ready for GPS Play framing");
  assert.ok(plannedBuilt.terrainView && plannedBuilt.terrainView.dataUrl.startsWith("data:image/svg+xml"), "terrain view is built as a separate derived stage");
  assert.ok(plannedBuilt.beta3dView && plannedBuilt.beta3dView.dataUrl.startsWith("data:image/svg+xml"), "3D beta view is built as a separate opt-in stage");
  assert.ok(svgText(plannedBuilt.beta3dView.dataUrl).includes('data-role="birds-eye-tiltable-3d-plane"'), "3D beta ships the full play surface birds-eye as a tiltable 3D plane (no baked trapezoid crop)");
  assert.ok(svgText(plannedBuilt.beta3dView.dataUrl).includes('data-default-view="birds-eye"'), "3D beta asset defaults to the birds-eye view");
  assert.equal(plannedBuilt.beta3dView.metadata.cameraModel, "birds-eye-tiltable-plane", "3D beta asset is a birds-eye tiltable plane, tilted by the viewer");
  assert.equal(plannedBuilt.beta3dView.metadata.surfaceModel, "birds-eye-tiltable-3d-plane", "3D beta records the tiltable-plane surface model");
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

  const fallbackCoursePayload = Object.assign({}, payload(), { courseId: "fallback-existing-visuals", courseKey: "fallback-existing-visuals" });
  const fallbackRequests = [
    { courseId: "fallback-existing-visuals", courseName: "Fallback Existing Visuals", role: "course-backdrop", quality: "live-map-base", stitchLayer: 0, holeNumber: 1 },
    { courseId: "fallback-existing-visuals", courseName: "Fallback Existing Visuals", role: "green-surround", quality: "super-hd", stitchLayer: 30, holeNumber: 1, captureLens: "green-square", lensAspectRatio: 1 },
    { courseId: "fallback-existing-visuals", courseName: "Fallback Existing Visuals", role: "play-corridor", quality: "hd", stitchLayer: 20, holeNumber: 1, captureLens: "mobile-hole", lensAspectRatio: 9 / 16 }
  ];
  const fallbackManifests = fallbackRequests.map((request, index) => visualManifest("fallback-existing-visuals-" + request.role, request, index * 30));
  fallbackManifests.forEach((item) => localStorage.setItem(item.key, JSON.stringify(item)));
  engine.ingestCourseVisualInput(engine.adaptCoursePlayPayloadToVisualInput(fallbackCoursePayload, { captures: fallbackManifests }));
  global.GDCoursePlayPipeline = {
    buildCoursePlayDbPayload() {
      return fallbackCoursePayload;
    },
    getCoursePlayFrameIndex() {
      return [];
    }
  };
  global.gdBuildCourseVisualCaptureManifest = function emptyVisualCaptureExecutor() {
    return null;
  };
  const fallbackBuilt = await engine.buildFromCourseDatabase("fallback-existing-visuals");
  assert.equal(fallbackBuilt.status, "basic-ready", "database rebuild reuses existing visual capture refs when fresh capture execution is empty");
  assert.ok(fallbackBuilt.holeFrameVisuals.length >= 1, "fallback rebuild still creates per-hole play surfaces");
  assert.ok(fallbackBuilt.diagnostics.captureExecution.fallbackReason.includes("previous-visual-capture-refs"), "fallback source is explicit in diagnostics");
  assert.equal(fallbackBuilt.lastError, null, "fallback rebuild avoids the missing-renderable-captures failure");
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
  const resetWorking = engine.resetCourseVisualWorkingState("cromwell", { keepPublished: true });
  assert.equal(resetWorking.status, "published", "recapture reset keeps the published play asset available");
  assert.equal(resetWorking.publishedVersion, restored.publishedVersion, "recapture reset does not unpublish the current Clarity map");
  assert.equal(resetWorking.rawMaster, null, "recapture reset clears the working stitch");
  assert.equal(resetWorking.captureRefs.length, 0, "recapture reset clears stale visual capture refs");
  assert.ok((resetWorking.events || []).some((event) => event.type === "course-visual-recapture-reset"), "recapture reset is diagnostic and auditable");

  const forceInput = engine.adaptCoursePlayPayloadToVisualInput(Object.assign({}, payload(), { courseId: "force-fresh", courseKey: "force-fresh" }));
  const forcePlan = engine.planCourseVisualCaptures(forceInput);
  const oldForceManifest = visualManifest("old-force-visual", forcePlan.find((item) => item.role === "play-corridor"), 0);
  const oldSourceFrameManifest = Object.assign(manifest("old-force-source-frame", 1, 40), { courseKey: "force-fresh" });
  localStorage.setItem(oldForceManifest.key, JSON.stringify(oldForceManifest));
  localStorage.setItem(oldSourceFrameManifest.key, JSON.stringify(oldSourceFrameManifest));
  engine.ingestCourseVisualInput(Object.assign({}, forceInput, { captures: [oldForceManifest] }));
  global.GDCoursePlayPipeline = {
    buildCoursePlayDbPayload() {
      return Object.assign({}, payload(), { courseId: "force-fresh", courseKey: "force-fresh" });
    },
    getCoursePlayFrameIndex() {
      return [{ holeNumber: 1, manifestKey: oldSourceFrameManifest.key, capturedManifestKey: oldSourceFrameManifest.key }];
    }
  };
  global.gdBuildCourseVisualCaptureManifest = function emptyFreshCapture() {
    return null;
  };
  const forceFresh = await engine.buildFromCourseDatabase("force-fresh", { forceFresh: true });
  assert.equal(forceFresh.status, "failed", "force-fresh recapture does not silently reuse stale visual captures");
  assert.equal(forceFresh.input.captureCount, 0, "force-fresh recapture does not fall back to old GPS/source frame manifests");
  assert.equal(forceFresh.diagnostics.captureExecution.captured, 0, "force-fresh records that no fresh captures were produced");
  assert.equal(forceFresh.diagnostics.captureExecution.freshRun, true, "force-fresh diagnostics identify a true fresh run");
  assert.equal(forceFresh.diagnostics.captureExecution.fallbackReason, "planned-captures-empty", "force-fresh reports the real fresh-capture failure");
  global.GDCoursePlayPipeline = originalPipeline;
  global.gdBuildCourseVisualCaptureManifest = originalExecutor;
  const persistedCromwell = JSON.parse(localStorage.getItem(engine.storeKey)).records.cromwell;
  assert.ok(persistedCromwell.versions.length <= 60, "persisted visual history is compacted to avoid localStorage quota failures");
  assert.equal(persistedCromwell.diagnostics.capturePlan, undefined, "bulky capture plans stay out of the persisted visual record");

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

  const originalFetch = global.fetch;
  global.fetch = async function mockCourseVisualPull(url) {
    assert.ok(String(url).includes("/api/course-visuals?courseId=cloud-course"), "cloud visual pull uses the course visual endpoint");
    return {
      ok: true,
      async json() {
        return {
          visual: {
            course_id: "cloud-course",
            status: "published",
            published_image_path: "course-visuals/cloud-course/published/9.svg",
            current_version: 9,
            published_version: 9,
            preset_id: "clarity-course-natural-v1",
            preset_version: 4,
            play_payload: {
              publishedVisual: {
                role: "published",
                path: "course-visuals/cloud-course/published/9.svg",
                url: "https://storage.test/course-visuals/cloud-course/published/9.svg",
                metadata: { outputDimensions: { width: 1800, height: 2400 }, sourceBounds: { south: -45.02, west: 169.1, north: -45.01, east: 169.11 } }
              },
              singleHolePublishedVisual: {
                role: "single-hole-published",
                path: "course-visuals/cloud-course/single-hole/published/9.svg",
                url: "https://storage.test/course-visuals/cloud-course/single-hole/published/9.svg",
                holeNumber: 1,
                metadata: { outputDimensions: { width: 900, height: 1600 }, sourceBounds: { south: -45.02, west: 169.1, north: -45.01, east: 169.11 } }
              },
              holeFrames: [
                {
                  role: "hole-frame-published",
                  path: "course-visuals/cloud-course/holes/h1/published/9.svg",
                  url: "https://storage.test/course-visuals/cloud-course/holes/h1/published/9.svg",
                  holeNumber: 1,
                  metadata: { outputDimensions: { width: 900, height: 1600 }, sourceBounds: { south: -45.02, west: 169.1, north: -45.01, east: 169.11 } }
                }
              ]
            }
          },
          storage: "supabase"
        };
      }
    };
  };
  const cloudRecord = await reloadedEngine.pullCourseVisual("cloud-course");
  const cloudResolved = reloadedEngine.resolveCourseVisual("cloud-course");
  assert.equal(cloudRecord.status, "published", "cloud visual restore keeps published status");
  assert.equal(cloudResolved.publishedVisual.url, "https://storage.test/course-visuals/cloud-course/published/9.svg", "cloud overview keeps the Supabase Storage URL");
  assert.equal(cloudResolved.singleHolePublishedVisual.url, "https://storage.test/course-visuals/cloud-course/single-hole/published/9.svg", "single-hole play asset keeps the Supabase Storage URL");
  assert.equal(cloudResolved.holeFramePublishedVisuals.length, 1, "cloud play payload restores hole-frame assets for GPS Play");
  assert.equal(cloudResolved.holeFramePublishedVisuals[0].url, "https://storage.test/course-visuals/cloud-course/holes/h1/published/9.svg", "hole-frame play asset keeps the Supabase Storage URL");
  global.fetch = originalFetch;

  // Green tone (cool <-> warm) turf control
  const toneRgb = (hex) => {
    const m = String(hex || "").match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    assert.ok(m, "green tone produces a #rrggbb hex, got " + hex);
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  };
  const neutralFilter = engine.__test.filterForSettings({ turf: { greenStrength: 1.5 } });
  assert.equal(neutralFilter.greenTone, 0, "greenTone defaults to neutral (0)");
  const neutralRgb = toneRgb(neutralFilter.greenHex);
  assert.ok(neutralRgb.g > neutralRgb.r && neutralRgb.g > neutralRgb.b, "neutral green tone stays green-dominant");
  assert.ok(Math.abs(neutralRgb.r - 0x3c) <= 3 && Math.abs(neutralRgb.g - 0xae) <= 3 && Math.abs(neutralRgb.b - 0x5f) <= 3, "neutral tone reproduces the legacy #3cae5f overlay");

  const coolRgb = toneRgb(engine.__test.filterForSettings({ turf: { greenStrength: 1.5, greenTone: -1 } }).greenHex);
  const warmRgb = toneRgb(engine.__test.filterForSettings({ turf: { greenStrength: 1.5, greenTone: 1 } }).greenHex);
  assert.ok(warmRgb.r > neutralRgb.r && warmRgb.r > coolRgb.r, "warmer tone raises red toward yellow-green");
  assert.ok(coolRgb.b > neutralRgb.b && neutralRgb.b > warmRgb.b, "cooler tone raises blue toward teal-green, warmer tone lowers it");
  assert.ok(coolRgb.g > coolRgb.r && warmRgb.g > warmRgb.b, "both tone extremes remain recognisably green");

  assert.equal(engine.__test.filterForSettings({ turf: { greenTone: 5 } }).greenTone, 1, "greenTone clamps to +1");
  assert.equal(engine.__test.filterForSettings({ turf: { greenTone: -9 } }).greenTone, -1, "greenTone clamps to -1");
  assert.equal(typeof engine.greenToneHex, "function", "greenToneHex is exposed for the admin live preview");
  assert.equal(engine.greenToneHex(0), neutralFilter.greenHex, "public greenToneHex matches the render pipeline");

  // Terrain: hillshade source + relief shading (not a pasted map), toggllable strength
  const terrainPolicy = engine.__test.capturePolicy("terrain-reference");
  assert.ok(/World_Hillshade/i.test(terrainPolicy.tileTemplate), "terrain reference captures the Esri hillshade relief layer");
  assert.equal(terrainPolicy.tileSourceLabel, "Esri World Hillshade", "terrain source is labelled as hillshade");

  const terrainAsset = {
    dataUrl: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#3a7d4a"/></svg>'),
    width: 200, height: 200,
    bounds: { south: -45.02, west: 169.1, north: -45.01, east: 169.11 },
    metadata: {}
  };
  const terrainCap = {
    id: "terrain-cap-1", role: "terrain-reference", width: 256, height: 256,
    imageData: "data:image/png;base64,iVBORw0KGgo=",
    bounds: { south: -45.025, west: 169.095, north: -45.005, east: 169.115 }
  };
  const terrainOpts = (s) => ({ terrainStrength: s, role: "single-hole-terrain", stage: "terrain-shading", product: "single-hole", bounds: terrainAsset.bounds });
  const terrainLow = engine.__test.terrainShadeAsset(terrainAsset, [terrainCap], terrainOpts(0));
  const terrainHigh = engine.__test.terrainShadeAsset(terrainAsset, [terrainCap], terrainOpts(1.5));
  assert.ok(terrainLow && terrainHigh, "terrain shade asset renders at both strengths");
  const lowSvg = svgText(terrainLow.dataUrl);
  const highSvg = svgText(terrainHigh.dataUrl);
  assert.ok(/feColorMatrix type="saturate" values="0"/.test(highSvg), "terrain tiles are desaturated to pure relief luminance, not a coloured map overlay");
  assert.ok(highSvg.indexOf(".32 .32 .32") < 0, "old colour-averaging terrain matrix is gone");
  assert.ok(/data-role="terrain-reference"[^>]*mix-blend-mode:multiply/.test(highSvg) || /mix-blend-mode:multiply/.test(highSvg), "hillshade relief shades the surface via multiply (shadows carve in)");
  assert.equal(terrainHigh.metadata.terrainSource, "hillshade-relief-shading", "terrain source is reported as relief shading");
  const groupOpacity = (svg) => {
    const m = svg.match(/data-role="terrain-reference" opacity="([0-9.]+)"/);
    return m ? Number(m[1]) : null;
  };
  const lowOpacity = groupOpacity(lowSvg);
  const highOpacity = groupOpacity(highSvg);
  assert.ok(lowOpacity !== null && highOpacity !== null, "terrain relief group is present at both strengths");
  assert.ok(highOpacity > lowOpacity, "higher terrain strength deepens the relief shading (toggllable degree)");
  assert.ok(lowOpacity > 0, "strength 0 keeps a minimal baseline of relief shading, not fully off");

  // 3D asset: birds-eye tiltable plane (the edited image saved as a 3D asset, flat by default)
  const holeSurface = {
    dataUrl: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="420"><rect width="240" height="420" fill="#3f8a4d"/><circle cx="120" cy="90" r="30" fill="#a7d98a"/></svg>'),
    width: 240, height: 420, holeNumber: 4,
    bounds: { south: -45.02, west: 169.1, north: -45.01, east: 169.11 },
    sourceCaptureIds: ["cap-a"], metadata: { role: "hole-frame" }
  };
  const birdsEye = engine.__test.beta3dVisualAsset(holeSurface, { captureTiltDeg: 8, playTiltDeg: 14 });
  assert.ok(birdsEye && birdsEye.dataUrl, "3D asset renders");
  const birdsEyeSvg = svgText(birdsEye.dataUrl);
  assert.ok(/data-role="birds-eye-tiltable-3d-plane"/.test(birdsEyeSvg), "3D asset declares itself a birds-eye tiltable plane");
  assert.ok(/data-default-view="birds-eye"/.test(birdsEyeSvg), "3D asset defaults to birds-eye view");
  assert.ok(birdsEyeSvg.indexOf('data-role="faux-3d-deck"') < 0 && birdsEyeSvg.indexOf("skewX(") < 0, "no perspective is baked into the asset — tilt is applied by the viewer");
  assert.equal(birdsEye.width, holeSurface.width, "birds-eye asset keeps the source width (identical framing from directly above)");
  assert.equal(birdsEye.height, holeSurface.height, "birds-eye asset keeps the source height");
  assert.equal(birdsEye.metadata.surfaceModel, "birds-eye-tiltable-3d-plane", "asset metadata marks it as a tiltable 3D plane");
  assert.equal(birdsEye.metadata.defaultView, "birds-eye", "asset metadata records the birds-eye default view");
  assert.equal(birdsEye.metadata.tiltAppliedBy, "viewer-runtime", "tilt is owned by the viewer/player, not baked in");
  assert.equal(birdsEye.metadata.playTiltDeg, 14, "asset carries the play tilt policy for the player to apply");

  console.log("course visual engine tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
