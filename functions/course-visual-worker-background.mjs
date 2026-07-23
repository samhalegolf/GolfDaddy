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
import { renderHoleSurfaceMercator, renderOverview } from "./lib/gd-visual-export-core.mjs";

const JOBS_TABLE = "course_visual_jobs";
const MAPS_TABLE = "course_maps";
const BUCKET = "course-visuals";
const TILE_CONCURRENCY = 8;
const TILE_TIMEOUT_MS = 15000;
const TILE_RETRIES = 3;

/* The export only ever reads the 2048 rendition, so the full-resolution master costs ~90MB per
   course and is never read back. Deleting it is tempting but NOT free: the in-browser bake
   works at up to 4096 (gd-course-visual-engine.js), so cloud frames are currently half the
   linear resolution of the local preview. If that parity gap is ever closed by raising the
   cloud output, these masters are the only way to do it without re-shooting 6.6k tiles.
   Kept until that call is made - flipping this to false is a one-liner, un-flipping it needs a
   fresh snapshot. */
const KEEP_FULL_RES_MASTER = true;

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

async function fetchTileOnce(url) {
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

/* Coverage is all-or-nothing (see buildCapture), so a single transient 502 out of ~6.6k tile
   fetches used to bin an entire capture. Retry transient failures before giving up; a 404 is
   a real gap in the tile source and retrying it just burns the clock. */
async function fetchTile(url) {
  let lastError = null;
  for (let attempt = 0; attempt < TILE_RETRIES; attempt++) {
    try {
      return await fetchTileOnce(url);
    } catch (error) {
      lastError = error;
      if (/HTTP 4(0[34]|10)/.test(String(error && error.message || ""))) break;
      if (attempt < TILE_RETRIES - 1) await new Promise(resolve => setTimeout(resolve, 250 * Math.pow(2, attempt)));
    }
  }
  throw lastError || new Error("tile fetch failed");
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

/* Snapshot is resumable the same way export is, but cheaper: every field in a capture's index
   entry is pure arithmetic over the course package (captureGrid), so a resumed run re-derives
   the metadata for free and only needs to skip the tile fetch + composite. No sidecar needed.

   The skip is gated on planKey - the plan ids embed a hash of each capture's padded bounds, so
   if the course geometry moved, the key changes and every capture is re-shot rather than
   silently reusing a stale image under the same captureKey. */
async function runSnapshotJob(job, deadlineAt) {
  const pkg = await loadCoursePackage(job.course_id);
  if (!pkg) throw new Error("course " + job.course_id + " not found in " + MAPS_TABLE);
  const plan = planCourseCaptures(pkg);
  if (!plan.length) throw new Error("capture plan is empty - no play-ready geometry");
  const planKey = hashText(plan.map(item => item.id).join("|"));
  const resumable = !!(job.result && job.result.progress && job.result.progress.planKey === planKey);
  const index = { version: 1, courseId: pkg.courseId, courseName: pkg.courseName, generatedAt: new Date().toISOString(), captures: [] };
  const failures = [];
  let shot = 0;
  for (const item of plan) {
    const grid = captureGrid(item);
    const isTerrain = item.role === "terrain-reference";
    const ext = isTerrain ? "png" : "jpg";
    const fullPath = pkg.courseId + "/captures/" + item.captureKey.replace(/:/g, "/") + "." + ext;
    const smallPath = pkg.courseId + "/captures/2048/" + item.captureKey.replace(/:/g, "/") + "." + ext;
    /* The 2048 rendition is what the export reads, so its presence is what "already shot"
       means. path stays pointed at whichever object actually exists. */
    const path = KEEP_FULL_RES_MASTER ? fullPath : smallPath;
    try {
      if (!(resumable && await storageExists(smallPath))) {
        await heartbeatJob(job, { planKey, capturesDone: index.captures.length, capturesTotal: plan.length, stage: "shooting " + item.captureKey, rssMb: Math.round(process.memoryUsage().rss / 1048576) });
        const buffer = await buildCapture(grid, { format: isTerrain ? "png" : "jpeg" });
        if (KEEP_FULL_RES_MASTER) await storageUpload(fullPath, buffer, isTerrain ? "image/png" : "image/jpeg");
        /* Export-ready rendition: pre-downscaled to the frame output resolution so the export
           never has to download and decode the full-resolution capture again. Decoding 17MP
           JPEGs per hole was most of the export's CPU bill on throttled serverless cores. */
        const small = sharp(buffer, { limitInputPixels: false }).resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true });
        await storageUpload(smallPath, await (isTerrain ? small.png({ compressionLevel: 6 }) : small.jpeg({ quality: 88 })).toBuffer(), isTerrain ? "image/png" : "image/jpeg");
        shot += 1;
      }
      index.captures.push({
        path2048: smallPath,
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
    /* Same soft-deadline relay as export. Snapshots average ~10 min against a ~4 min real
       invocation cap, so before this they survived only by luck: a death meant the reaper
       requeued a run that started again from capture 1. */
    if (deadlineAt && Date.now() > deadlineAt && index.captures.length + failures.length < plan.length) {
      return { requeue: true, rendered: shot, progress: { planKey, capturesDone: index.captures.length, capturesTotal: plan.length } };
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

async function storageList(prefix) {
  const response = await fetch(supabaseBase() + "/storage/v1/object/list/" + BUCKET, {
    method: "POST",
    headers: { apikey: supabaseKey(), Authorization: "Bearer " + supabaseKey(), "Content-Type": "application/json" },
    body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: "name", order: "asc" } })
  });
  if (!response.ok) throw new Error("Storage list " + response.status + " for " + prefix);
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

async function storageRemove(paths) {
  if (!paths.length) return;
  const response = await fetch(supabaseBase() + "/storage/v1/object/" + BUCKET, {
    method: "DELETE",
    headers: { apikey: supabaseKey(), Authorization: "Bearer " + supabaseKey(), "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: paths })
  });
  if (!response.ok) throw new Error("Storage remove " + response.status + ": " + (await response.text()).slice(0, 200));
}

/* Retire every frame version dir except the one just published. Each export writes a fresh
   r{hash} dir; without this they accumulate (~11MB/version) forever. Best-effort and scoped
   strictly to {courseId}/frames/{oldVersion}/* - never touches captures/, the live version, or
   the index.json that points at it, so a bad list can only under-delete, never orphan Play. */
async function sweepOldFrameVersions(courseId, liveVersion) {
  const entries = await storageList(courseId + "/frames/");
  /* Folder entries come back with id:null; the live version and the index.json file stay. */
  const staleDirs = entries
    .filter(e => e && e.id === null && e.name && e.name !== liveVersion && /^r[a-z0-9]+$/.test(e.name))
    .map(e => e.name);
  let removed = 0;
  for (const dir of staleDirs) {
    const files = await storageList(courseId + "/frames/" + dir + "/");
    const paths = files.filter(f => f && f.id !== null && f.name).map(f => courseId + "/frames/" + dir + "/" + f.name);
    await storageRemove(paths);
    removed += paths.length;
  }
  return { staleDirs: staleDirs.length, removed };
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
  /* Heartbeats land every hole (~1 min); 6 minutes of silence means the invocation is dead.
     Observed runtime cap in production is ~4 minutes per invocation, so a tight window here
     keeps the requeue->resume loop moving instead of stalling 20 minutes per death. */
  const cutoff = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  try {
    const stale = await supabaseFetch(JOBS_TABLE + "?select=id,result&status=eq.running&updated_at=lt." + encodeURIComponent(cutoff));
    for (const row of Array.isArray(stale) ? stale : []) {
      const attempts = (row.result && Number(row.result.attempts) || 0) + 1;
      /* Exports resume from uploaded frames, so retries are cheap - give them a longer leash
         on heavily throttled invocations. */
      const patch = attempts >= 8
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

/* Export renders ONE HOLE AT A TIME with the sharp compositor (gd-visual-export-core) -
   pure bitmap ops, no engine, no nested base64 SVGs, no librsvg megaparse. Seconds per hole,
   ~50MB peak. The version directory is a deterministic hash of (recipe, snapshot) and
   already-uploaded frames are skipped, so an interrupted run resumes where it stopped. */
async function runExportJob(job, deadlineAt) {
  const pkg = await loadCoursePackage(job.course_id);
  if (!pkg) throw new Error("course " + job.course_id + " not found in " + MAPS_TABLE);
  const capturesIndex = JSON.parse((await storageDownload(job.course_id + "/captures/index.json")).toString("utf8"));
  const entries = Array.isArray(capturesIndex && capturesIndex.captures) ? capturesIndex.captures : [];
  if (!entries.length) throw new Error("no captures in index - run a snapshot job first");
  const recipe = job.recipe && (job.recipe.presetId || job.recipe.overrides || job.recipe.courseOverrides) ? job.recipe : await latestPublishedRecipe(job.course_id);
  const presetId = String(recipe.presetId || "");
  const overrides = recipe.overrides || recipe.courseOverrides || {};
  /* out tag bumped to iz1 when captureZoom went integer-only (gd-visual-export-core): old
     fractional-zoom frames must NOT be resumed/reused, so the version dir has to change. */
  const version = "r" + hashText(JSON.stringify({ presetId, overrides, snapshot: capturesIndex.generatedAt, out: "mercator-2048-iz1" }));
  const framesDir = pkg.courseId + "/frames/" + version;
  const holeData = packageHoleData(pkg);
  const terrainEntry = entries.find(e => e.role === "terrain-reference");
  const backdropEntry = entries.find(e => e.role === "course-backdrop");
  const cachedBuffers = {};
  /* Prefer the pre-downscaled rendition written at snapshot time - small download, no 17MP
     decode. Older snapshots without one fall back to download + downscale of full-res. */
  async function bufferFor(entry) {
    if (!cachedBuffers[entry.path]) {
      if (entry.path2048) {
        cachedBuffers[entry.path] = await storageDownload(entry.path2048);
      } else {
        const raw = await storageDownload(entry.path);
        const isPng = entry.path.endsWith(".png");
        const resized = sharp(raw, { limitInputPixels: false }).resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true });
        cachedBuffers[entry.path] = await (isPng ? resized.png({ compressionLevel: 9 }) : resized.jpeg({ quality: 88 })).toBuffer();
      }
    }
    return cachedBuffers[entry.path];
  }
  function entryWithLensLocal(entry) {
    return Object.assign({}, entry, {
      lensLocalCorners: Array.isArray(entry.lensCornersPx) && entry.originPx
        ? entry.lensCornersPx.map(p => ({ x: p.x - entry.originPx.x, y: p.y - entry.originPx.y }))
        : []
    });
  }
  const holeNumbers = [...new Set(entries.filter(e => e.holeNumber && !e.terrainStageOnly).map(e => Number(e.holeNumber)))].sort((a, b) => a - b);
  const framesIndex = { version: 1, courseId: pkg.courseId, exportVersion: version, presetId, generatedAt: capturesIndex.generatedAt, overview: null, holes: [] };
  let rendered = 0;
  for (const holeNumber of holeNumbers) {
    const path = framesDir + "/h" + holeNumber + ".jpg";
    const holeEntries = entries.filter(e => Number(e.holeNumber) === holeNumber && !e.terrainStageOnly);
    const holeBoundsList = holeEntries.map(e => e.bounds).filter(Boolean);
    let bounds = holeBoundsList.length ? { south: Math.min(...holeBoundsList.map(b => b.south)), west: Math.min(...holeBoundsList.map(b => b.west)), north: Math.max(...holeBoundsList.map(b => b.north)), east: Math.max(...holeBoundsList.map(b => b.east)) } : null;
    const data = holeData[holeNumber] || {};
    const pins = {
      tee: data.tee && data.tee.position || (holeEntries[0] && holeEntries[0].anchorPins && holeEntries[0].anchorPins.tee) || null,
      green: data.green && data.green.position || (holeEntries[0] && holeEntries[0].anchorPins && holeEntries[0].anchorPins.green) || null,
      route: data.route || [],
      greenShape: data.greenShape || []
    };
    let width = null, height = null, playSurface = null;
    /* A frame may only be SKIPPED when its metadata is recoverable. The metadata sidecar is
       written AT RENDER TIME next to each frame - recovering from the final index.json was a
       livelock: that file only exists after a COMPLETE run, so relayed runs re-rendered from
       h1 forever and died at the soft deadline every time. */
    let sidecar = null;
    if (await storageExists(path)) {
      try { sidecar = JSON.parse((await storageDownload(path + ".json")).toString("utf8")); } catch (e) { sidecar = null; }
    }
    if (sidecar && sidecar.playSurface && sidecar.playSurface.originPx) {
      width = sidecar.width; height = sidecar.height; playSurface = sidecar.playSurface;
      if (sidecar.bounds) bounds = sidecar.bounds;
    } else {
      /* Stage marker BEFORE the render: a silent crash (OOM, native abort) writes no error,
         but this leaves a corpse marker in the job row saying exactly where it died. */
      await heartbeatJob(job, { version, holesDone: framesIndex.holes.length, holesTotal: holeNumbers.length, stage: "rendering h" + holeNumber, rssMb: Math.round(process.memoryUsage().rss / 1048576) });
      const captures = [];
      for (const entry of holeEntries) captures.push({ entry: entryWithLensLocal(entry), buffer: await bufferFor(entry) });
      const terrain = terrainEntry ? { entry: terrainEntry, buffer: await bufferFor(terrainEntry) } : null;
      /* North-up mercator surface: the geometry the v19 GPS pipeline consumes natively
         (originPx + captureZoom + one image). The runtime does the play-axis framing, same
         as it does for locally captured surfaces. */
      const frame = await renderHoleSurfaceMercator({ pins, captures, terrain, settings: overrides });
      await storageUpload(path, frame.jpeg, "image/jpeg");
      width = frame.width; height = frame.height;
      playSurface = {
        model: "mercator-image",
        projection: "mercator-image",
        useGpsPlayFraming: true,
        fallbackUnderlay: "live-gps",
        fallbackPolicy: "live-gps-only",
        anchorPins: pins,
        sourceBounds: frame.bounds,
        captureZoom: frame.captureZoom,
        originPx: frame.originPx,
        outputDimensions: { width: frame.width, height: frame.height }
      };
      await storageUpload(path + ".json", Buffer.from(JSON.stringify({ width, height, bounds, playSurface })), "application/json");
      rendered += 1;
    }
    framesIndex.holes.push({ holeNumber, path, width, height, bounds, playSurface });
    await heartbeatJob(job, { version, holesDone: framesIndex.holes.length, holesTotal: holeNumbers.length });
    /* Production invocations get silently killed around the 4-minute mark regardless of the
       advertised background budget. Rather than die mid-hole and wait for the reaper, hand
       the job back to the queue at the soft deadline and chain a fresh invocation - uploaded
       frames make the resume instant. */
    if (deadlineAt && Date.now() > deadlineAt && framesIndex.holes.length < holeNumbers.length) {
      return { requeue: true, rendered, progress: { version, holesDone: framesIndex.holes.length, holesTotal: holeNumbers.length } };
    }
  }
  const overviewPath = framesDir + "/overview.jpg";
  if (backdropEntry) {
    if (!(await storageExists(overviewPath))) {
      const overview = await renderOverview({
        backdrop: { entry: backdropEntry, buffer: await bufferFor(backdropEntry) },
        terrain: terrainEntry ? { entry: terrainEntry, buffer: await bufferFor(terrainEntry) } : null,
        settings: overrides
      });
      await storageUpload(overviewPath, overview.jpeg, "image/jpeg");
      framesIndex.overview = { path: overviewPath, width: overview.width, height: overview.height, bounds: backdropEntry.bounds };
    } else {
      framesIndex.overview = { path: overviewPath, width: backdropEntry.width, height: backdropEntry.height, bounds: backdropEntry.bounds };
    }
  }
  if (!framesIndex.holes.length) throw new Error("no hole frames produced");
  await storageUpload(pkg.courseId + "/frames/index.json", Buffer.from(JSON.stringify(framesIndex)), "application/json");
  await writeCourseVisualRow(job, pkg, framesIndex, { presetId, overrides });
  /* Index + row now point at this version, so every OTHER frame dir is dead. Retire them.
     Best-effort: a sweep failure must never fail an otherwise-good export. */
  let swept = null;
  try { swept = await sweepOldFrameVersions(pkg.courseId, version); }
  catch (e) { console.warn("frame-version sweep failed", pkg.courseId, e && e.message || e); }
  return {
    exportVersion: version,
    presetId,
    holes: framesIndex.holes.length,
    overview: !!framesIndex.overview,
    indexPath: pkg.courseId + "/frames/index.json",
    courseVisualRow: "cv-" + pkg.courseId,
    swept
  };
}

const SOFT_DEADLINE_MS = 3 * 60 * 1000;
/* A full 18-hole export needs ~2-3 relays; a snapshot of 44 captures a few more. Anything
   past this is a loop, not a long job. */
const MAX_RELAYS = 12;

/* AWAITED, not fire-and-forget: serverless freezes the process the moment the handler
   returns, so an un-awaited ping never leaves the building and the relay stalls until the
   10-minute sweeper. The target is a background function that acks with 202 immediately,
   so awaiting costs a few hundred ms. */
async function chainNextInvocation(req) {
  try {
    const origin = new URL(req.url).origin;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    await fetch(origin + "/.netlify/functions/course-visual-worker-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: controller.signal
    }).catch(() => {});
    clearTimeout(timer);
  } catch (e) { /* sweeper will pick it up */ }
}

export default async function courseVisualWorker(req) {
  if (!supabaseBase() || !supabaseKey()) return new Response("supabase not configured", { status: 503 });
  let payload = {};
  try { payload = await req.json(); } catch (e) { payload = {}; }
  await reapStaleJobs();
  const deadlineAt = Date.now() + SOFT_DEADLINE_MS;
  /* Process the named job, then sweep any other queued jobs while we have the budget. */
  let job = await claimJob(payload && payload.jobId || null);
  while (job) {
    try {
      const result = job.kind === "snapshot" ? await runSnapshotJob(job, deadlineAt) : job.kind === "export" ? await runExportJob(job, deadlineAt) : { skipped: "unknown kind " + job.kind };
      if (result && result.requeue) {
        /* Soft deadline reached: hand the job back and chain a fresh invocation, which
           resumes instantly from the work already uploaded.

           The relay is only allowed to continue if this invocation actually produced
           something new. A run that renders NOTHING and still hands the job back is a
           livelock, not progress - that is exactly how an export burned 12 hours and ~250
           invocations re-rendering the same 7 holes, heartbeating cheerfully the whole time
           so the stale-job reaper never touched it. Loud failures were capped at 8 attempts;
           this one looked healthy, so nothing stopped it. Now nothing has to: no forward
           progress, or too many relays, and the job dies with a diagnosis. */
        const relays = (job.result && Number(job.result.relays) || 0) + 1;
        if (!result.rendered) {
          await finishJob(job.id, { status: "failed", error: "relay livelock: hit the soft deadline having produced nothing new (" + JSON.stringify(result.progress) + "). Resume-skip is not matching already-uploaded work.", result: { progress: result.progress, relays } });
          break;
        }
        if (relays > MAX_RELAYS) {
          await finishJob(job.id, { status: "failed", error: "relay budget exhausted after " + relays + " invocations (" + JSON.stringify(result.progress) + ")", result: { progress: result.progress, relays } });
          break;
        }
        await finishJob(job.id, { status: "queued", result: { progress: result.progress, relays, attempts: job.result && Number(job.result.attempts) || 0 }, error: null });
        await chainNextInvocation(req);
        break;
      }
      await finishJob(job.id, { status: "done", result, error: null });
      /* Hybrid: fresh captures always get re-exported with the live recipe (or natural). */
      if (job.kind === "snapshot") await enqueueFollowUpExport(job.course_id).catch(() => {});
    } catch (error) {
      console.error("course-visual-worker job failed", job.id, error);
      await finishJob(job.id, { status: "failed", error: String(error && error.message || error).slice(0, 900) }).catch(() => {});
    }
    if (Date.now() > deadlineAt) { await chainNextInvocation(req); break; }
    job = await claimJob(null);
  }
  return new Response("ok", { status: 200 });
}
