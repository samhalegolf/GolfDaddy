/* Visual engine snapshot worker (Netlify background function - 15 min budget).

   Claims a queued course_visual_jobs row, reads the published course package from
   course_maps, computes the capture plan with the shared plan module (same policies as the
   in-browser scan), fetches the tiles for every capture, composites each into a single
   Clarity-owned raster with sharp, and uploads the results to the course-visuals Storage
   bucket along with an index.json describing every capture (bounds, zoom, lens, path).

   This is Phase 1 of dev/VISUAL_ENGINE_SERVER_WORKER_PLAN.md: the snapshot happens server
   side, once, and browsers stop needing tile access at all. Export (recipe compose) is
   Phase 2 and reads these captures back down. */

import sharp from "sharp";
import { planCourseCaptures, captureGrid, packageHoleData } from "./lib/gd-visual-plan-core.mjs";
/* Static import so Netlify's bundler ships the engine with the function. The UMD factory runs
   at import with root=globalThis and touches localStorage only at call time behind guards, so
   installing the stubs later (loadEngine) is safe. */
import engineModule from "../scripts/gd-course-visual-engine.js";

const JOBS_TABLE = "course_visual_jobs";
const MAPS_TABLE = "course_maps";
const BUCKET = "course-visuals";
const TILE_CONCURRENCY = 8;
const TILE_TIMEOUT_MS = 15000;

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }

async function supabaseFetch(path, options = {}) {
  const headers = Object.assign({
    apikey: supabaseKey(),
    Authorization: "Bearer " + supabaseKey(),
    "Content-Type": "application/json"
  }, options.headers || {});
  const response = await fetch(supabaseBase() + "/rest/v1/" + path, Object.assign({}, options, { headers }));
  const textBody = await response.text();
  let body = null;
  try { body = textBody ? JSON.parse(textBody) : null; } catch (e) { body = textBody; }
  if (!response.ok) throw new Error("Supabase " + response.status + ": " + (typeof body === "string" ? body : JSON.stringify(body)));
  return body;
}

async function storageUpload(path, buffer, contentType) {
  const response = await fetch(supabaseBase() + "/storage/v1/object/" + BUCKET + "/" + path, {
    method: "POST",
    headers: {
      apikey: supabaseKey(),
      Authorization: "Bearer " + supabaseKey(),
      "Content-Type": contentType,
      "x-upsert": "true"
    },
    body: buffer
  });
  if (!response.ok) throw new Error("Storage upload " + response.status + " for " + path + ": " + (await response.text()).slice(0, 300));
  return path;
}

async function claimJob(jobId) {
  /* status=eq.queued in the filter makes the claim atomic - two workers racing the same row
     can't both flip it to running. */
  const filter = jobId ? "id=eq." + encodeURIComponent(jobId) + "&" : "";
  const rows = await supabaseFetch(JOBS_TABLE + "?" + filter + "status=eq.queued&order=created_at.asc&limit=1", { method: "GET" });
  const job = Array.isArray(rows) ? rows[0] : null;
  if (!job) return null;
  const claimed = await supabaseFetch(JOBS_TABLE + "?id=eq." + job.id + "&status=eq.queued", {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "running", updated_at: new Date().toISOString() })
  });
  return Array.isArray(claimed) && claimed.length ? claimed[0] : null;
}

async function finishJob(id, patch) {
  await supabaseFetch(JOBS_TABLE + "?id=eq." + id, {
    method: "PATCH",
    body: JSON.stringify(Object.assign({ updated_at: new Date().toISOString() }, patch))
  });
}

async function loadCoursePackage(courseId) {
  const rows = await supabaseFetch(MAPS_TABLE + "?select=course_id,course_name,objects_json,holes_json&course_id=eq." + encodeURIComponent(courseId) + "&published=eq.true&limit=1");
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  return {
    courseId: row.course_id,
    courseName: row.course_name || row.course_id,
    objects: row.objects_json || {},
    holes: row.holes_json || {}
  };
}

async function fetchTile(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TILE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/* Composite one capture: fetch its tile grid (bounded concurrency) and flatten onto a single
   canvas. Coverage is enforced like the browser flatten - a capture with missing tiles is
   refused rather than baked with holes in it. */
async function buildCapture(grid, { format }) {
  const tiles = grid.tiles;
  const buffers = new Array(tiles.length);
  let failed = 0;
  let cursor = 0;
  async function pump() {
    while (cursor < tiles.length) {
      const index = cursor++;
      try {
        buffers[index] = await fetchTile(tiles[index].url);
      } catch (e) {
        failed += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(TILE_CONCURRENCY, tiles.length) }, pump));
  if (failed > 0) throw new Error("tile coverage incomplete: " + failed + "/" + tiles.length + " failed");
  const canvas = sharp({
    create: { width: grid.imageWidth, height: grid.imageHeight, channels: 3, background: { r: 16, g: 19, b: 15 } },
    limitInputPixels: false
  });
  const composites = tiles.map((tile, index) => ({ input: buffers[index], left: tile.x, top: tile.y })).filter(layer =>
    layer.left > -256 && layer.top > -256 && layer.left < grid.imageWidth && layer.top < grid.imageHeight);
  const composed = canvas.composite(composites);
  return format === "png"
    ? composed.png({ compressionLevel: 9 }).toBuffer()
    : composed.jpeg({ quality: 85 }).toBuffer();
}

async function runSnapshotJob(job) {
  const pkg = await loadCoursePackage(job.course_id);
  if (!pkg) throw new Error("course " + job.course_id + " not found in " + MAPS_TABLE);
  const plan = planCourseCaptures(pkg);
  if (!plan.length) throw new Error("capture plan is empty - no play-ready geometry");
  const index = { version: 1, courseId: pkg.courseId, courseName: pkg.courseName, generatedAt: new Date().toISOString(), captures: [] };
  const failures = [];
  for (const item of plan) {
    const grid = captureGrid(item);
    const isTerrain = item.role === "terrain-reference";
    const ext = isTerrain ? "png" : "jpg";
    const path = pkg.courseId + "/captures/" + item.captureKey.replace(/:/g, "/") + "." + ext;
    try {
      const buffer = await buildCapture(grid, { format: isTerrain ? "png" : "jpeg" });
      await storageUpload(path, buffer, isTerrain ? "image/png" : "image/jpeg");
      index.captures.push({
        id: item.id,
        captureKey: item.captureKey,
        role: item.role,
        quality: item.quality,
        stitchLayer: item.stitchLayer,
        holeNumber: item.holeNumber,
        segmentIndex: item.segmentIndex,
        segmentCount: item.segmentCount,
        captureZoom: grid.captureZoom,
        width: grid.imageWidth,
        height: grid.imageHeight,
        bounds: grid.imageBounds,
        originPx: grid.originPx,
        lensOrientation: grid.lensOrientation,
        lensCornersPx: grid.lensCornersPx,
        anchorPins: item.anchorPins,
        captureAnchorPins: item.captureAnchorPins,
        terrainStageOnly: !!item.terrainStageOnly,
        tileCount: grid.tiles.length,
        bytes: null,
        path
      });
    } catch (error) {
      failures.push({ id: item.id, role: item.role, holeNumber: item.holeNumber, error: String(error && error.message || error).slice(0, 300) });
    }
  }
  if (!index.captures.length) throw new Error("every capture failed: " + JSON.stringify(failures.slice(0, 3)));
  await storageUpload(pkg.courseId + "/captures/index.json", Buffer.from(JSON.stringify(index)), "application/json");
  return {
    planItems: plan.length,
    captured: index.captures.length,
    failed: failures.length,
    failures: failures.slice(0, 12),
    indexPath: pkg.courseId + "/captures/index.json"
  };
}

/* ---------- export job: recipe compose using the REAL engine ----------------------------- */

async function storageDownload(path) {
  const response = await fetch(supabaseBase() + "/storage/v1/object/" + BUCKET + "/" + path, {
    headers: { apikey: supabaseKey(), Authorization: "Bearer " + supabaseKey() }
  });
  if (!response.ok) throw new Error("Storage download " + response.status + " for " + path);
  return Buffer.from(await response.arrayBuffer());
}

/* The export runs the SAME code the browser sandbox runs - gd-course-visual-engine.js is UMD
   and happily loads in Node behind a localStorage stub (the engine test suite has always done
   this). Recipe parity is therefore by construction: identical stitch, identical filter
   markup, and librsvg (sharp's SVG rasterizer) supports the filter primitives the recipe
   uses (verified: feColorMatrix, feComponentTransfer, mix-blend-mode multiply). */
let engineReady = false;
function loadEngine() {
  if (engineReady) return engineModule;
  const data = {};
  globalThis.localStorage = globalThis.localStorage || {
    getItem: k => Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null,
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
    clear: () => { Object.keys(data).forEach(k => delete data[k]); }
  };
  globalThis.dispatchEvent = globalThis.dispatchEvent || (() => {});
  globalThis.CustomEvent = globalThis.CustomEvent || function CustomEvent(type, init) { return { type, detail: init && init.detail }; };
  engineReady = true;
  return engineModule;
}

function engineObjectsFromPackage(pkg) {
  const holeData = packageHoleData(pkg);
  const objects = [];
  Object.keys(holeData).forEach(key => {
    const data = holeData[key];
    const holeNumber = Number(key);
    if (data.green && data.green.position) objects.push({ id: "green:h" + holeNumber, type: "green", holeNumber, geometry: data.greenShape && data.greenShape.length ? { type: "LineString", points: data.greenShape } : { type: "Point", point: data.green.position } });
    if (data.tee && data.tee.position) objects.push({ id: "tee:h" + holeNumber, type: "tee", holeNumber, geometry: { type: "Point", point: data.tee.position } });
    if (data.route && data.route.length) objects.push({ id: "fairway:h" + holeNumber, type: "fairway", holeNumber, geometry: { type: "LineString", points: data.route } });
  });
  return objects;
}

async function rasterizeSvgDataUrl(dataUrl, { maxWidth, quality }) {
  const comma = String(dataUrl || "").indexOf(",");
  if (comma < 0) throw new Error("asset has no data url");
  const body = String(dataUrl).slice(comma + 1);
  const svg = Buffer.from(String(dataUrl).includes(";base64,") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body), "utf8");
  let image = sharp(svg, { limitInputPixels: false, density: 72 });
  const meta = await image.metadata();
  if (maxWidth && meta.width && meta.width > maxWidth) image = image.resize({ width: maxWidth });
  return image.jpeg({ quality: quality || 82 }).toBuffer();
}

/* Natural baseline: every effect off. Mirrors GD_VISUAL_OFF_OVERRIDES in the admin UI. */
const NATURAL_OVERRIDES = {
  turf: { greenStrength: 0, greenTone: 0 },
  lighting: { brightnessTarget: 52, contrastTarget: 1 },
  readability: { sharpness: 0, fairwaySeparation: 0 },
  mowingVisibility: 0,
  visualTools: { holeTerrainStrength: 0, courseTerrainStrength: 0, fairwayAirbrush: false },
  floodlight: { enabled: false }
};

/* Hybrid publish model: after every successful snapshot the worker re-exports frames with the
   course's last PUBLISHED recipe (or the natural/off baseline if it has never been published),
   so players never see frames baked from stale captures. A manual Publish is the only thing
   that changes which recipe is live. */
async function latestPublishedRecipe(courseId) {
  try {
    const rows = await supabaseFetch("course_visuals?select=preset_id,course_overrides&course_id=eq." + encodeURIComponent(courseId) + "&order=updated_at.desc&limit=1");
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row) return { presetId: row.preset_id || "", overrides: row.course_overrides || NATURAL_OVERRIDES };
  } catch (e) { /* fall through to natural */ }
  return { presetId: "", overrides: NATURAL_OVERRIDES };
}

async function enqueueFollowUpExport(courseId) {
  const existing = await supabaseFetch(JOBS_TABLE + "?select=id&course_id=eq." + encodeURIComponent(courseId) + "&kind=eq.export&status=in.(queued,running)&limit=1");
  if (Array.isArray(existing) && existing.length) return;
  const recipe = await latestPublishedRecipe(courseId);
  await supabaseFetch(JOBS_TABLE, {
    method: "POST",
    body: JSON.stringify([{ course_id: courseId, kind: "export", status: "queued", recipe, requested_by: "auto-after-snapshot" }])
  });
}

/* Jobs stuck "running" belong to a worker that died mid-run (crash, 15-min cap). Exports are
   resumable (deterministic version dir + skip-existing frames), so a reaped job is REQUEUED to
   pick up where it died - up to 3 attempts, then failed for good. The worker heartbeats after
   every hole, so only genuinely dead runs trip the 20-minute cutoff. */
async function reapStaleJobs() {
  const cutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  try {
    const stale = await supabaseFetch(JOBS_TABLE + "?select=id,result&status=eq.running&updated_at=lt." + encodeURIComponent(cutoff));
    for (const row of Array.isArray(stale) ? stale : []) {
      const attempts = (row.result && Number(row.result.attempts) || 0) + 1;
      const patch = attempts >= 3
        ? { status: "failed", error: "stale-running-reaped: worker died mid-job " + attempts + " times", updated_at: new Date().toISOString() }
        : { status: "queued", error: null, result: Object.assign({}, row.result || {}, { attempts }), updated_at: new Date().toISOString() };
      await supabaseFetch(JOBS_TABLE + "?id=eq." + row.id, { method: "PATCH", body: JSON.stringify(patch) });
    }
  } catch (e) { /* reaping is best-effort */ }
}

/* The worker owns the course_visuals row - the browser no longer posts multi-MB asset
   payloads through a size-limited function. uploaded_assets roles drive the existing
   play_payload contract in /api/course-visuals. */
async function writeCourseVisualRow(job, pkg, framesIndex, recipe) {
  const versionNumber = Math.max(1, parseInt(String(framesIndex.exportVersion || "v1").replace(/[^0-9]/g, ""), 10) || 1);
  const bounds = (framesIndex.holes || []).map(h => h.bounds).filter(Boolean);
  const courseBounds = bounds.length ? {
    south: Math.min(...bounds.map(b => Number(b.south))),
    west: Math.min(...bounds.map(b => Number(b.west))),
    north: Math.max(...bounds.map(b => Number(b.north))),
    east: Math.max(...bounds.map(b => Number(b.east)))
  } : {};
  const uploadedAssets = [];
  if (framesIndex.overview) uploadedAssets.push({ path: framesIndex.overview.path, role: "published", contentType: "image/jpeg", holeNumber: null, hole_number: null, metadata: { width: framesIndex.overview.width, height: framesIndex.overview.height, bounds: framesIndex.overview.bounds } });
  (framesIndex.holes || []).forEach(frame => {
    uploadedAssets.push({ path: frame.path, role: "hole-frame-published", contentType: "image/jpeg", holeNumber: frame.holeNumber, hole_number: frame.holeNumber, metadata: { width: frame.width, height: frame.height, bounds: frame.bounds, playSurface: frame.playSurface } });
  });
  const row = {
    id: "cv-" + pkg.courseId,
    course_id: pkg.courseId,
    status: "published",
    raw_master_path: null,
    basic_image_path: null,
    preview_image_path: null,
    published_image_path: framesIndex.overview ? framesIndex.overview.path : (framesIndex.holes[0] && framesIndex.holes[0].path) || null,
    course_bounds: courseBounds,
    source_capture_ids: (framesIndex.holes || []).map(h => "h" + h.holeNumber),
    preset_id: recipe.presetId || null,
    preset_version: 0,
    course_overrides: recipe.overrides || {},
    current_version: versionNumber,
    published_version: versionNumber,
    last_error: {},
    diagnostics: { source: "course-visual-worker", jobId: job.id, framesIndexPath: pkg.courseId + "/frames/index.json", generatedAt: framesIndex.generatedAt },
    versions: [],
    uploaded_assets: uploadedAssets,
    updated_at: new Date().toISOString()
  };
  await supabaseFetch("course_visuals?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(row)
  });
}

function hashText(text) {
  let hash = 5381;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

async function storageExists(path) {
  const response = await fetch(supabaseBase() + "/storage/v1/object/info/" + BUCKET + "/" + path, {
    headers: { apikey: supabaseKey(), Authorization: "Bearer " + supabaseKey() }
  });
  return response.ok;
}

async function heartbeatJob(job, progress) {
  /* Preserves result.attempts - the reaper's retry budget - across progress writes. */
  await supabaseFetch(JOBS_TABLE + "?id=eq." + job.id, {
    method: "PATCH",
    body: JSON.stringify({ updated_at: new Date().toISOString(), result: { progress, attempts: job.result && Number(job.result.attempts) || 0 } })
  }).catch(() => {});
}

function entryToCapture(entry, buffer) {
  const mime = entry.path.endsWith(".png") ? "image/png" : "image/jpeg";
  return {
    id: entry.id,
    storagePath: "cloud:" + entry.captureKey,
    imageData: "data:" + mime + ";base64," + buffer.toString("base64"),
    bounds: entry.bounds,
    width: entry.width,
    height: entry.height,
    zoom: entry.captureZoom,
    originPx: entry.originPx,
    holeNumber: entry.holeNumber,
    role: entry.role,
    quality: entry.quality,
    stitchLayer: entry.stitchLayer,
    planId: entry.id,
    segmentIndex: entry.segmentIndex,
    segmentCount: entry.segmentCount,
    terrainStageOnly: !!entry.terrainStageOnly,
    anchorPins: entry.anchorPins || {},
    captureAnchorPins: entry.captureAnchorPins || null,
    captureLens: entry.lensOrientation === "play-axis" ? "mobile-hole" : "",
    lensShape: entry.lensOrientation === "play-axis" ? "mobile-hole" : "",
    lensOrientation: entry.lensOrientation || "",
    lensLocalCorners: Array.isArray(entry.lensCornersPx) && entry.originPx
      ? entry.lensCornersPx.map(p => ({ x: p.x - entry.originPx.x, y: p.y - entry.originPx.y }))
      : []
  };
}

/* Export bakes ONE HOLE AT A TIME through the engine. A whole-course bake holds hundreds of
   MB of SVG strings at once - it OOM-killed the function the same way it froze browser tabs.
   Per-hole mini-bakes keep peak memory to a few captures, the version directory is a
   deterministic hash of (recipe, snapshot), and already-uploaded frames are skipped - so a
   run that dies at hole 12 resumes at hole 12 when the reaper requeues it. */
async function runExportJob(job) {
  const engine = loadEngine();
  const pkg = await loadCoursePackage(job.course_id);
  if (!pkg) throw new Error("course " + job.course_id + " not found in " + MAPS_TABLE);
  const capturesIndex = JSON.parse((await storageDownload(job.course_id + "/captures/index.json")).toString("utf8"));
  const entries = Array.isArray(capturesIndex && capturesIndex.captures) ? capturesIndex.captures : [];
  if (!entries.length) throw new Error("no captures in index - run a snapshot job first");
  const recipe = job.recipe && (job.recipe.presetId || job.recipe.overrides || job.recipe.courseOverrides) ? job.recipe : await latestPublishedRecipe(job.course_id);
  const presetId = String(recipe.presetId || "") || (engine.defaultPreset && engine.defaultPreset().id) || "";
  const overrides = recipe.overrides || recipe.courseOverrides || {};
  const version = "r" + hashText(JSON.stringify({ presetId, overrides, snapshot: capturesIndex.generatedAt }));
  const framesDir = pkg.courseId + "/frames/" + version;
  const objects = engineObjectsFromPackage(pkg);
  const terrainEntry = entries.find(e => e.role === "terrain-reference");
  const backdropEntry = entries.find(e => e.role === "course-backdrop");
  const cachedBuffers = {};
  /* Captures are downscaled to the export's output resolution before being embedded. The SVG
     lays images out by their LOGICAL width/height attributes, so shrinking the pixels changes
     nothing about geometry or recipe - but it keeps the frame SVG well under librsvg's 10MB
     XML buffer limit (full-res embeds blew straight through it) and cuts peak memory ~4x. */
  async function bufferFor(entry) {
    if (!cachedBuffers[entry.path]) {
      const raw = await storageDownload(entry.path);
      const isPng = entry.path.endsWith(".png");
      const resized = sharp(raw, { limitInputPixels: false }).resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true });
      cachedBuffers[entry.path] = await (isPng ? resized.png({ compressionLevel: 9 }) : resized.jpeg({ quality: 82 })).toBuffer();
    }
    return cachedBuffers[entry.path];
  }
  const holeNumbers = [...new Set(entries.filter(e => e.holeNumber && !e.terrainStageOnly).map(e => Number(e.holeNumber)))].sort((a, b) => a - b);
  const framesIndex = { version: 1, courseId: pkg.courseId, exportVersion: version, presetId, generatedAt: capturesIndex.generatedAt, overview: null, holes: [] };
  for (const holeNumber of holeNumbers) {
    const path = framesDir + "/h" + holeNumber + ".jpg";
    const holeEntries = entries.filter(e => Number(e.holeNumber) === holeNumber && !e.terrainStageOnly);
    const already = await storageExists(path);
    let width = null, height = null, bounds = null, playSurface = null;
    if (!already) {
      const holeCaptures = [];
      for (const entry of holeEntries) holeCaptures.push(entryToCapture(entry, await bufferFor(entry)));
      if (terrainEntry) holeCaptures.push(entryToCapture(terrainEntry, await bufferFor(terrainEntry)));
      const holeCourseId = pkg.courseId + "--h" + holeNumber;
      engine.ingestCourseVisualInput({ courseId: holeCourseId, courseName: pkg.courseName, objects: objects.filter(o => Number(o.holeNumber) === holeNumber), captures: holeCaptures });
      await engine.buildCourseVisualMaster(holeCourseId, { captures: holeCaptures, forceRebuild: true });
      await engine.buildCourseVisualPreview(holeCourseId, presetId, overrides);
      const record = engine.getRecord(holeCourseId);
      if (record.lastError) throw new Error("hole " + holeNumber + " bake failed: " + (record.lastError.message || record.lastError.code));
      const frame = ((record.holeFrameTerrainViews && record.holeFrameTerrainViews.length ? record.holeFrameTerrainViews : record.holeFramePreviewVisuals) || []).find(f => f && f.dataUrl && Number(f.holeNumber) === holeNumber);
      if (!frame) throw new Error("hole " + holeNumber + " produced no styled frame");
      width = frame.width; height = frame.height; bounds = frame.bounds; playSurface = frame.metadata && frame.metadata.playSurface || null;
      const jpeg = await rasterizeSvgDataUrl(frame.dataUrl, { maxWidth: 2048, quality: 82 });
      await storageUpload(path, jpeg, "image/jpeg");
      engine.resetCourseVisualWorkingState(holeCourseId, { keepPublished: false });
    } else {
      const holeBounds = holeEntries.map(e => e.bounds).filter(Boolean);
      bounds = holeBounds.length ? { south: Math.min(...holeBounds.map(b => b.south)), west: Math.min(...holeBounds.map(b => b.west)), north: Math.max(...holeBounds.map(b => b.north)), east: Math.max(...holeBounds.map(b => b.east)) } : null;
    }
    framesIndex.holes.push({ holeNumber, path, width, height, bounds, playSurface });
    await heartbeatJob(job, { version, holesDone: framesIndex.holes.length, holesTotal: holeNumbers.length });
  }
  const overviewPath = framesDir + "/overview.jpg";
  if (backdropEntry) {
    if (!(await storageExists(overviewPath))) {
      const overviewCaptures = [entryToCapture(backdropEntry, await bufferFor(backdropEntry))];
      if (terrainEntry) overviewCaptures.push(entryToCapture(terrainEntry, await bufferFor(terrainEntry)));
      const overviewCourseId = pkg.courseId + "--overview";
      engine.ingestCourseVisualInput({ courseId: overviewCourseId, courseName: pkg.courseName, objects: [], captures: overviewCaptures });
      await engine.buildCourseVisualMaster(overviewCourseId, { captures: overviewCaptures, forceRebuild: true });
      await engine.buildCourseVisualPreview(overviewCourseId, presetId, overrides, { skipHoleFrames: true });
      const overviewRecord = engine.getRecord(overviewCourseId);
      const overviewAsset = overviewRecord.terrainView || overviewRecord.previewVisual || overviewRecord.rawMaster;
      if (overviewAsset && overviewAsset.dataUrl) {
        const jpeg = await rasterizeSvgDataUrl(overviewAsset.dataUrl, { maxWidth: 2048, quality: 80 });
        await storageUpload(overviewPath, jpeg, "image/jpeg");
        framesIndex.overview = { path: overviewPath, width: overviewAsset.width, height: overviewAsset.height, bounds: overviewAsset.bounds || backdropEntry.bounds };
      }
      engine.resetCourseVisualWorkingState(overviewCourseId, { keepPublished: false });
    } else {
      framesIndex.overview = { path: overviewPath, width: backdropEntry.width, height: backdropEntry.height, bounds: backdropEntry.bounds };
    }
  }
  if (!framesIndex.holes.length) throw new Error("no hole frames produced by the engine bake");
  await storageUpload(pkg.courseId + "/frames/index.json", Buffer.from(JSON.stringify(framesIndex)), "application/json");
  await writeCourseVisualRow(job, pkg, framesIndex, { presetId, overrides });
  return {
    exportVersion: version,
    presetId,
    holes: framesIndex.holes.length,
    overview: !!framesIndex.overview,
    indexPath: pkg.courseId + "/frames/index.json",
    courseVisualRow: "cv-" + pkg.courseId
  };
}

export default async function courseVisualWorker(req) {
  if (!supabaseBase() || !supabaseKey()) return new Response("supabase not configured", { status: 503 });
  let payload = {};
  try { payload = await req.json(); } catch (e) { payload = {}; }
  await reapStaleJobs();
  /* Process the named job, then sweep any other queued jobs while we have the budget. */
  let job = await claimJob(payload && payload.jobId || null);
  while (job) {
    try {
      const result = job.kind === "snapshot" ? await runSnapshotJob(job) : job.kind === "export" ? await runExportJob(job) : { skipped: "unknown kind " + job.kind };
      await finishJob(job.id, { status: "done", result, error: null });
      /* Hybrid: fresh captures always get re-exported with the live recipe (or natural). */
      if (job.kind === "snapshot") await enqueueFollowUpExport(job.course_id).catch(() => {});
    } catch (error) {
      console.error("course-visual-worker job failed", job.id, error);
      await finishJob(job.id, { status: "failed", error: String(error && error.message || error).slice(0, 900) }).catch(() => {});
    }
    job = await claimJob(null);
  }
  return new Response("ok", { status: 200 });
}
