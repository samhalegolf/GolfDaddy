/* Visual engine snapshot worker (Netlify background function - 15 min budget).

   Claims a queued course_visual_jobs row, reads the published course package from
   course_maps, computes the capture plan with the shared plan module (same policies as the
   in-browser scan), fetches the tiles for every capture, composites each into a single
   Clarity-owned raster with sharp, and uploads the results to the course-visuals Storage
   bucket along with an index.json describing every capture (bounds, zoom, lens, path).

   This is Phase 1 of dev/VISUAL_ENGINE_SERVER_WORKER_PLAN.md: the snapshot happens server
   side, once, and browsers stop needing tile access at all. Export (recipe compose) is
   Phase 2 and reads these captures back down. */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

/* libvips caches decoded images and operation results so a repeated pipeline is cheap. This
   worker is the opposite shape: ~50 large composites, each touched once and never again, so
   the cache is pure retention. Measured on the Jacks Point snapshot, RSS climbed 725 -> 870MB
   across a single minute (capture 12 of 50) against a 1024MB function, surviving only because
   the 3-minute relay kept restarting the process before it burst. Turning the cache off costs
   nothing here - there is no reuse to lose. */
sharp.cache(false);
/* One libvips worker thread, not one per core. Each thread carries its own tile buffers
   through the pipeline, so on a 320-tile composite the thread count multiplies peak memory
   rather than the work - and the work is not the bottleneck here anyway; tile fetching is.
   Trading compositing throughput we are not using for headroom we keep running out of. */
sharp.concurrency(1);
import { planCourseCaptures, captureGrid, packageHoleData, courseBoundsFor } from "./lib/gd-visual-plan-core.mjs";
import { resolveImagerySource, unscannableReason, attributionFor } from "./lib/gd-imagery-sources.mjs";
import { renderHoleSurfaceMercator, renderOverview } from "./lib/gd-visual-export-core.mjs";
import { reliefFromTerrainRgb, cropByBounds, reliefAzimuthForPlayAxis, RELIEF_DEFAULTS, heightsFromFloat32Tiff, terrainRgbPngFromHeights, decodeElevation } from "./lib/gd-relief-core.mjs";

const JOBS_TABLE = "course_visual_jobs";
const MAPS_TABLE = "course_maps";
const RECIPES_TABLE = "course_visual_recipes";
const BUCKET = "course-visuals";
/* Tile fetching is what a snapshot spends its time on: measured on Jacks Point, 13.1s per
   capture against composites that take a fraction of that, so this number sets the wall clock.
   8 was chosen when the source was a third-party endpoint we had no relationship with; LINZ and
   USGS are CDN-fronted and licensed, so a course scan is no longer something to be shy about.
   Raise further only with a failure rate to look at - a 429 storm costs more than it saves. */
const TILE_CONCURRENCY = 16;
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

/* Longest edge of the export-ready rendition AND of the frames rendered from it. The two are
   one number on purpose: the rendition exists so the export never decodes a 17MP master, so
   shipping it smaller than the frame would just upscale mush, and shipping it larger would put
   the decode cost straight back.

   Was 2048, which dated from the dead engine-in-Node path that OOM-killed workers - the sharp
   compositor that replaced it was never the thing that got stuck. The masters kept by
   KEEP_FULL_RES_MASTER are shot well above this, so raising it re-renditions from storage and
   never re-shoots tiles. 4096 is the next stop if worker memory holds (peak scales with the
   square of this). Changing it MUST come with a bump to the out tag in runExportJob's version
   hash, or already-uploaded frames at the old size get resumed as if they were current. */
const EXPORT_RENDITION_PX = 3072;
const NATURAL_PRESET_ID = "clarity-course-natural-v1";

/* Stamps the relief lighting into cache keys. Bump it whenever the shading constants in
   gd-relief-core.mjs change: stored terrain captures hold shaded pixels, so a new
   exaggeration or light angle makes every one of them stale, and neither the plan ids nor
   the recipe hash would notice. */
const RELIEF_STAMP = "relief2-perhole-x" + RELIEF_DEFAULTS.exaggeration + "-az" + RELIEF_DEFAULTS.azimuth + "-al" + RELIEF_DEFAULTS.altitude;
const ENGINE_SOURCE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/gd-course-visual-engine.js");
let presetHelpersCache = null;

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

/* Captures overlap, heavily and by design: corridor segments carry a 42m overlap, a green sits
   inside its own corridor, and parallel holes share the axis-aligned box each rotated lens is
   captured through. Measured on Jacks Point, 2250 tile requests covered 614 distinct tiles -
   73% of the traffic was re-fetching bytes the run already had, one tile 18 times over.

   So tiles are cached for the run. Bounded, because a course is not the only thing that has to
   fit in the function: eviction is oldest-first, which suits a plan that sweeps the course
   hole by hole and rarely returns to ground it has left. The cache survives between relayed
   invocations of a warm container, which is a bonus rather than a correctness question - tile
   pyramids do not change under us mid-scan. */
const TILE_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
const tileCache = new Map();
let tileCacheBytes = 0;
const tileCacheStats = { hits: 0, misses: 0 };

function tileCacheGet(url) {
  const hit = tileCache.get(url);
  if (hit) tileCacheStats.hits += 1; else tileCacheStats.misses += 1;
  return hit || null;
}
function tileCachePut(url, buffer) {
  if (!buffer || tileCache.has(url)) return;
  tileCache.set(url, buffer);
  tileCacheBytes += buffer.length;
  while (tileCacheBytes > TILE_CACHE_BUDGET_BYTES && tileCache.size) {
    const oldest = tileCache.keys().next().value;
    const dropped = tileCache.get(oldest);
    tileCache.delete(oldest);
    tileCacheBytes -= dropped ? dropped.length : 0;
  }
}

/* Coverage is all-or-nothing (see buildCapture), so a single transient 502 out of ~6.6k tile
   fetches used to bin an entire capture. Retry transient failures before giving up; a 404 is
   a real gap in the tile source and retrying it just burns the clock. */
async function fetchTile(url) {
  const cached = tileCacheGet(url);
  if (cached) return cached;
  const fetched = await fetchTileUncached(url);
  tileCachePut(url, fetched);
  return fetched;
}

async function fetchTileUncached(url) {
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
  /* Float32 DEM blocks (US 3DEP, AU ELVIS) cannot go through the image compositor below - it
     flattens onto an 8-bit canvas, which would clamp every height into 0..255m. They are
     decoded as measurements, assembled as floats, and stored as the SAME terrain-RGB PNG a
     LINZ course stores, so the crop/shade/mesh/plays-like consumers never learn a second
     format existed. Decoded one block at a time: a 2048px block is 16.8MB of floats, and the
     mosaic itself is already width*height*4 bytes of headroom this worker has to find. */
  if (grid.encoding === "float32") {
    const mosaic = new Float32Array(grid.imageWidth * grid.imageHeight).fill(NaN);
    for (let index = 0; index < tiles.length; index++) {
      const block = await heightsFromFloat32Tiff(buffers[index]);
      buffers[index] = null;
      const left = tiles[index].x, top = tiles[index].y;
      const w = Math.min(block.width, grid.imageWidth - left);
      const h = Math.min(block.height, grid.imageHeight - top);
      for (let y = 0; y < h; y++) {
        const src = y * block.width, dst = (top + y) * grid.imageWidth + left;
        for (let x = 0; x < w; x++) mosaic[dst + x] = block.heights[src + x];
      }
    }
    buffers.length = 0;
    return await terrainRgbPngFromHeights(mosaic, grid.imageWidth, grid.imageHeight);
  }
  const canvas = sharp({
    create: { width: grid.imageWidth, height: grid.imageHeight, channels: 3, background: { r: 16, g: 19, b: 15 } },
    limitInputPixels: false
  });
  const composites = tiles.map((tile, index) => ({ input: buffers[index], left: tile.x, top: tile.y })).filter(layer =>
    layer.left > -256 && layer.top > -256 && layer.left < grid.imageWidth && layer.top < grid.imageHeight);
  /* The composites array now holds the only references that matter; dropping this one lets the
     off-grid tiles the filter discarded be collected before the composite runs rather than
     after it, which is exactly when the headroom is needed. */
  buffers.length = 0;
  const composed = canvas.composite(composites);
  const out = format === "png"
    ? await composed.png({ compressionLevel: 9 }).toBuffer()
    : await composed.jpeg({ quality: 85 }).toBuffer();
  composites.length = 0;
  /* Foreign-encoded elevation tiles (terrarium for Europe, gsi-dem-png for Japan) composite
     losslessly - they are ordinary 8-bit RGB - but they must not be STORED as themselves:
     the stored terrain artefact is terrain-RGB everywhere else, and the phone's terrain mesh
     decodes only that. Decode the stitched mosaic under its declared encoding (which also
     fills NoData sentinels - GSI paints the sea RGB(128,0,0)) and re-pack, the same
     normalisation the float32 branch above performs for the US. */
  if (format === "png" && grid.encoding && grid.encoding !== "terrain-rgb") {
    const { data, info } = await sharp(out, { limitInputPixels: false }).raw().toBuffer({ resolveWithObject: true });
    const decoded = decodeElevation(data, info.width, info.height, info.channels, grid.encoding);
    return await terrainRgbPngFromHeights(decoded.heights, info.width, info.height);
  }
  return out;
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
  /* Licensing gate, before a single tile is fetched. No licensed source covering this course
     is a legitimate answer - that course runs live-only - so the job fails with the reason
     rather than falling back to whatever imagery happens to respond. */
  const bounds = courseBoundsFor(pkg);
  const source = resolveImagerySource(bounds);
  if (!source) throw new Error("imagery-source-unavailable: " + unscannableReason(bounds));
  const attribution = attributionFor(source, null);
  /* Relief is computed, not fetched: source.terrain is the DEM spec tagged for the job, and
     is null wherever the DEM is not tiled terrain-RGB. Null plans no terrain capture and the
     course renders exactly as it does without relief. */
  /* source is passed so the planner can grid each capture once and clamp every zoom to the
     frame that capture actually lands in; maxOutputPx must be the export's own cap or the two
     disagree and we go back to shooting detail the compositor throws away. */
  const plan = planCourseCaptures(pkg, { terrainSource: source.terrain || null, source, maxOutputPx: EXPORT_RENDITION_PX });
  if (!plan.length) throw new Error("capture plan is empty - no play-ready geometry");
  /* The source is part of the key: masters shot from a different provider must never be
     re-renditioned under a new one, both because the pixels differ and because the stored
     credit would then be a lie about where they came from.

     RELIEF_STAMP is in the key for the same reason. What gets stored for a terrain capture is
     shading, not elevation, so the lighting constants are baked into those bytes - change the
     exaggeration and every stored relief is stale in a way no other signal would catch. */
  const planKey = hashText(source.key + "|" + RELIEF_STAMP + "|" + plan.map(item => item.id).join("|"));
  const resumable = !!(job.result && job.result.progress && job.result.progress.planKey === planKey);
  /* Stored masters may only be reused when they were shot for THIS plan. The plan ids embed a
     hash of each capture's padded bounds, so a course whose geometry moved gets a different
     planKey and every capture is re-shot from tiles rather than re-renditioned from a master
     that frames the old geometry. Snapshots written before this field existed have no planKey
     and are therefore never trusted - they re-shoot once, then carry one. */
  const storedPlanKey = await storedSnapshotPlanKey(pkg.courseId);
  const mastersMatchPlan = !!storedPlanKey && storedPlanKey === planKey;
  const index = {
    version: 1, planKey, renditionPx: EXPORT_RENDITION_PX,
    courseId: pkg.courseId, courseName: pkg.courseName,
    generatedAt: new Date().toISOString(),
    /* Travels with the captures so the credit is attached to the pixels, not reconstructed
       later from whatever the registry happens to say at read time. */
    source: { key: source.key, label: source.label, license: source.license && source.license.name || "", attribution },
    captures: []
  };
  const failures = [];
  let shot = 0;
  /* Counted so the soft-deadline check below still knows when the plan is exhausted; without
     this a skipped capture makes "done + failed < plan.length" permanently true and the job
     requeues itself forever. */
  let skipped = 0;
  for (const item of plan) {
    const grid = captureGrid(item, { source });
    /* No licensed endpoint for this role (relief in a region with imagery but no elevation) -
       drop the capture, keep the course. */
    if (!grid) { skipped += 1; continue; }
    const isTerrain = item.role === "terrain-reference";
    const ext = isTerrain ? "png" : "jpg";
    const fullPath = pkg.courseId + "/captures/" + item.captureKey.replace(/:/g, "/") + "." + ext;
    const renditionPath = pkg.courseId + "/captures/" + EXPORT_RENDITION_PX + "/" + item.captureKey.replace(/:/g, "/") + "." + ext;
    /* The export-ready rendition is what the export reads, so its presence is what "already
       shot" means. path stays pointed at whichever object actually exists. */
    const path = KEEP_FULL_RES_MASTER ? fullPath : renditionPath;
    try {
      if (!(resumable && await storageExists(renditionPath))) {
        await heartbeatJob(job, { planKey, capturesDone: index.captures.length, capturesTotal: plan.length, stage: "shooting " + item.captureKey, rssMb: Math.round(process.memoryUsage().rss / 1048576) });
        /* Raising the output size must not cost 6.6k tile fetches per course. When a master
           for this exact plan is already in storage, the rendition is derived from it and the
           tile source is never touched - that is the whole reason KEEP_FULL_RES_MASTER exists. */
        let buffer = null;
        if (mastersMatchPlan && await storageExists(fullPath)) {
          buffer = await storageDownload(fullPath);
        } else {
          buffer = await buildCapture(grid, { format: isTerrain ? "png" : "jpeg" });
          /* A terrain capture is stored as the elevation it arrived as, not as shading.

             It used to be shaded here, once per course, which was cheaper - but the frames
             are baked north-up and Play rotates them so the hole runs up the screen, so one
             fixed light swings around the screen hole by hole and ends up below the eye on
             roughly half of them. Light from below inverts perceived relief: those greens
             read as craters. Shading per hole at export, aimed off the play axis, is what
             fixes that, and it needs the heights rather than somebody's picture of them.

             Storing elevation is the better artefact anyway. It is the input to the terrain
             mesh, and to real slope for plays-like, neither of which can be recovered from a
             greyscale of one lighting choice. */
          if (KEEP_FULL_RES_MASTER) await storageUpload(fullPath, buffer, isTerrain ? "image/png" : "image/jpeg");
        }
        /* Export-ready rendition: pre-downscaled to the frame output resolution so the export
           never has to download and decode the full-resolution capture again. Decoding 17MP
           JPEGs per hole was most of the export's CPU bill on throttled serverless cores.

           At 3072 most captures are already at or under the cap - measured on Jacks Point, the
           renditions came back within a few percent of their masters and the backdrop rendition
           was LARGER than the one it came from. For those, resizing is a no-op and the encode
           is a full decode + re-encode that changes nothing but the JPEG quality number. Skip
           it and ship the composite as shot. */
        /* A terrain capture is NEVER resampled on the way to its rendition: the pixels are
           packed heights, and bilinear interpolation of terrain-RGB blends the byte planes
           into elevations that were never measured. Terrain mosaics are shot at z16-17 and
           essentially always fit anyway; on the rare course where one would not, storing it
           full-size costs bytes where resizing it would cost the ground truth. (Latent for
           NZ before the float32 path made it explicit - no NZ course has tripped it.) */
        const fitsAlready = isTerrain || (grid.imageWidth <= EXPORT_RENDITION_PX && grid.imageHeight <= EXPORT_RENDITION_PX);
        const renditionBuffer = fitsAlready ? buffer : await (() => {
          const small = sharp(buffer, { limitInputPixels: false }).resize({ width: EXPORT_RENDITION_PX, height: EXPORT_RENDITION_PX, fit: "inside", withoutEnlargement: true });
          return (isTerrain ? small.png({ compressionLevel: 6 }) : small.jpeg({ quality: 88 })).toBuffer();
        })();
        await storageUpload(renditionPath, renditionBuffer, isTerrain ? "image/png" : "image/jpeg");
        buffer = null;
        shot += 1;
      }
      index.captures.push({
        pathExport: renditionPath,
        renditionPx: EXPORT_RENDITION_PX,
        sourceKey: grid.sourceKey || source.key,
        sourceAdapter: grid.adapter,
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
    if (deadlineAt && Date.now() > deadlineAt && index.captures.length + failures.length + skipped < plan.length) {
      return { requeue: true, rendered: shot, progress: { planKey, capturesDone: index.captures.length, capturesTotal: plan.length } };
    }
  }
  if (!index.captures.length) throw new Error("every capture failed: " + JSON.stringify(failures.slice(0, 3)));
  await storageUpload(pkg.courseId + "/captures/index.json", Buffer.from(JSON.stringify(index)), "application/json");
  return {
    planItems: plan.length,
    captured: index.captures.length,
    failed: failures.length,
    skipped,
    tileFetches: tileCacheStats.misses,
    tileCacheHits: tileCacheStats.hits,
    source: source.key,
    license: source.license && source.license.name || "",
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

/* Raw baseline: every effect off. Mirrors GD_VISUAL_OFF_OVERRIDES in the admin UI. */
const RAW_BASELINE_OVERRIDES = {
  turf: { greenStrength: 0, greenTone: 0 },
  lighting: { brightnessTarget: 52, contrastTarget: 1 },
  readability: { sharpness: 0, fairwaySeparation: 0 },
  mowingVisibility: 0,
  visualTools: { holeTerrainStrength: 0, courseTerrainStrength: 0, fairwayAirbrush: false },
  floodlight: { enabled: false },
  effectToggles: { turf: false, lighting: false, floodlight: false, terrain: false, mowing: false },
  sourceMode: true
};

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function mergeSettings(base, patch) {
  const out = cloneJson(base) || {};
  (function walk(target, next) {
    Object.keys(next || {}).forEach((key) => {
      const value = next[key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        target[key] = target[key] && typeof target[key] === "object" && !Array.isArray(target[key]) ? target[key] : {};
        walk(target[key], value);
      } else {
        target[key] = value;
      }
    });
  })(out, patch || {});
  return out;
}

function extractEngineFunction(source, name) {
  const marker = "function " + name + "(";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("Could not find " + name + " in gd-course-visual-engine.js");
  let depth = 0;
  let started = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") { depth += 1; started = true; }
    else if (ch === "}") {
      depth -= 1;
      if (started && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("Unbalanced braces while reading " + name + " from gd-course-visual-engine.js");
}

function extractEngineVar(source, name) {
  const match = source.match(new RegExp("\\bvar\\s+" + name + "\\s*=\\s*([^;]+);"));
  if (!match) throw new Error("Could not find " + name + " in gd-course-visual-engine.js");
  return "var " + name + " = " + match[1] + ";";
}

function loadPresetHelpers() {
  if (presetHelpersCache) return presetHelpersCache;
  const source = fs.readFileSync(ENGINE_SOURCE_PATH, "utf8");
  const helperNames = ["baseCourseVisualPreset", "defaultPreset", "presetSpec", "builtInPresetSpecs"];
  const code = [
    'function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }',
    extractEngineVar(source, "PRESET_VERSION")
  ]
    .concat(helperNames.map((name) => extractEngineFunction(source, name)))
    .join("\n\n") + `
function mergePreset(base, patch) {
  var out = clone(base || defaultPreset());
  (function walk(target, next) {
    Object.keys(next || {}).forEach(function (key) {
      var value = next[key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        target[key] = target[key] && typeof target[key] === "object" && !Array.isArray(target[key]) ? target[key] : {};
        walk(target[key], value);
      } else {
        target[key] = value;
      }
    });
  })(out, patch || {});
  return out;
}
function builtInPresetMap() {
  var out = {};
  builtInPresetSpecs().forEach(function (spec) {
    out[spec.id] = mergePreset(defaultPreset(), spec.patch || {});
  });
  return out;
}
return {
  getPreset: function (presetId) {
    var presets = builtInPresetMap();
    return clone(presets[presetId] || presets[defaultPreset().id] || defaultPreset());
  }
};`;
  presetHelpersCache = new Function(code)();
  return presetHelpersCache;
}

function builtInPresetSettings(presetId) {
  return loadPresetHelpers().getPreset(String(presetId || NATURAL_PRESET_ID));
}

function normalizeRecipe(input) {
  const recipe = input && typeof input === "object" ? input : {};
  const presetId = String(recipe.presetId || recipe.preset_id || "");
  const courseOverrides = recipe.courseOverrides || recipe.course_overrides || recipe.overrides || {};
  if (recipe.settings && typeof recipe.settings === "object") {
    return { presetId, courseOverrides, settings: cloneJson(recipe.settings) };
  }
  if (presetId) {
    return { presetId, courseOverrides, settings: mergeSettings(builtInPresetSettings(presetId), courseOverrides) };
  }
  return { presetId: "", courseOverrides, settings: mergeSettings(RAW_BASELINE_OVERRIDES, courseOverrides) };
}

function recipeFromPublishedRow(row) {
  const presetId = String(row && row.preset_id || "");
  const courseOverrides = row && row.course_overrides && typeof row.course_overrides === "object" ? row.course_overrides : {};
  if (!presetId) return { presetId: "", courseOverrides, settings: mergeSettings(RAW_BASELINE_OVERRIDES, courseOverrides) };
  return { presetId, courseOverrides, settings: mergeSettings(builtInPresetSettings(presetId), courseOverrides) };
}

function recipeFromLibraryRow(row) {
  const presetId = String(row && (row.preset_id || row.presetId) || "");
  const rawOverrides = row && (row.course_overrides || row.courseOverrides);
  const courseOverrides = rawOverrides && typeof rawOverrides === "object" ? rawOverrides : {};
  return normalizeRecipe({ presetId, courseOverrides });
}

async function activeLibraryRecipe() {
  try {
    const rows = await supabaseFetch(RECIPES_TABLE + "?select=preset_id,course_overrides&is_active=eq.true&order=updated_at.desc&limit=1");
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? recipeFromLibraryRow(row) : null;
  } catch (e) {
    return null;
  }
}

/* Hybrid publish model: after every successful snapshot the worker re-exports frames with the
   course's last PUBLISHED recipe, otherwise the shared active recipe, otherwise the canonical
   Natural preset, so players never see frames baked from stale captures. A manual Publish is
   still the only thing that changes a course-specific recipe. */
async function latestPublishedRecipe(courseId) {
  try {
    const rows = await supabaseFetch("course_visuals?select=preset_id,course_overrides&course_id=eq." + encodeURIComponent(courseId) + "&order=updated_at.desc&limit=1");
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row) return recipeFromPublishedRow(row);
  } catch (e) { /* fall through to shared active recipe */ }
  const shared = await activeLibraryRecipe();
  if (shared) return shared;
  return normalizeRecipe({ presetId: NATURAL_PRESET_ID, courseOverrides: {} });
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
  /* Heartbeats now land every CAPTURE and every hole - seconds apart, not the ~1 minute this
     window was originally sized for - so two minutes of silence is a corpse with room to
     spare. The old six minutes stacked on top of the sweeper's ten to leave a dead job
     untouched for up to a quarter of an hour, which is what Jacks Point spent its afternoon
     doing. Still comfortably longer than any real gap between beats. */
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
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
    course_overrides: recipe.courseOverrides || {},
    current_version: versionNumber,
    published_version: versionNumber,
    last_error: {},
    /* imagery/attribution ride in diagnostics because the row's shape is fixed by the existing
       play_payload contract; the client reads them to render the credit over cloud frames. */
    diagnostics: { source: "course-visual-worker", jobId: job.id, framesIndexPath: pkg.courseId + "/frames/index.json", generatedAt: framesIndex.generatedAt, imagery: framesIndex.source || null, attribution: framesIndex.source && framesIndex.source.attribution || null },
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

/* planKey of the snapshot currently in storage, or "" when there is no index or it predates
   the field. Read once per snapshot run to decide whether stored masters frame current
   geometry (see runSnapshotJob). */
async function storedSnapshotPlanKey(courseId) {
  try {
    const index = JSON.parse((await storageDownload(courseId + "/captures/index.json")).toString("utf8"));
    return String(index && index.planKey || "");
  } catch (e) {
    return "";
  }
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
  const recipe = job.recipe && (job.recipe.presetId || job.recipe.preset_id || job.recipe.overrides || job.recipe.courseOverrides || job.recipe.settings)
    ? normalizeRecipe(job.recipe)
    : await latestPublishedRecipe(job.course_id);
  const presetId = String(recipe.presetId || "");
  const settings = cloneJson(recipe.settings || {});
  /* out tag bumped to iz1 when captureZoom went integer-only (gd-visual-export-core): old
     fractional-zoom frames must NOT be resumed/reused, so the version dir has to change.
     RELIEF_STAMP rides along for the same reason - relief changes published pixels, and
     without it every already-exported frame resumes as current and nothing re-renders. */
  const version = "r" + hashText(JSON.stringify({ presetId, settings, snapshot: capturesIndex.generatedAt, out: "mercator-" + EXPORT_RENDITION_PX + "-iz1-" + RELIEF_STAMP }));
  const framesDir = pkg.courseId + "/frames/" + version;
  const holeData = packageHoleData(pkg);
  const terrainEntry = entries.find(e => e.role === "terrain-reference");
  const backdropEntry = entries.find(e => e.role === "course-backdrop");
  const cachedBuffers = {};
  /* Prefer the pre-downscaled rendition written at snapshot time - small download, no 17MP
     decode. pathExport is the current field; path2048 is what snapshots written before the
     rendition size became configurable carry, and reading it keeps those courses exporting
     (at their old size) until they are re-snapshotted. Neither present: downscale the master. */
  async function bufferFor(entry) {
    if (!cachedBuffers[entry.path]) {
      const rendition = entry.pathExport || entry.path2048 || "";
      if (rendition) {
        cachedBuffers[entry.path] = await storageDownload(rendition);
      } else {
        const raw = await storageDownload(entry.path);
        const isPng = entry.path.endsWith(".png");
        const resized = sharp(raw, { limitInputPixels: false }).resize({ width: EXPORT_RENDITION_PX, height: EXPORT_RENDITION_PX, fit: "inside", withoutEnlargement: true });
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
  /* Carried through from the captures so a frame always ships with the credit for the imagery
     it was made from - Play renders it from here, not from a client-side lookup table. */
  const framesIndex = { version: 1, courseId: pkg.courseId, exportVersion: version, presetId, generatedAt: capturesIndex.generatedAt, source: capturesIndex.source || null, overview: null, holes: [] };
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
    let width = null, height = null, playSurface = null, bytes = null;
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
      bytes = Number(sidecar.bytes) || null;
      if (sidecar.bounds) bounds = sidecar.bounds;
    } else {
      /* Stage marker BEFORE the render: a silent crash (OOM, native abort) writes no error,
         but this leaves a corpse marker in the job row saying exactly where it died. */
      await heartbeatJob(job, { version, holesDone: framesIndex.holes.length, holesTotal: holeNumbers.length, stage: "rendering h" + holeNumber, rssMb: Math.round(process.memoryUsage().rss / 1048576) });
      const captures = [];
      for (const entry of holeEntries) captures.push({ entry: entryWithLensLocal(entry), buffer: await bufferFor(entry) });

      /* Elevation for THIS hole, cut from the course-wide capture, then shaded for it.

         Two products come out of the same crop. The elevation goes to storage beside the
         frame, because it is measurements and everything downstream that wants to know how
         the ground actually lies - the terrain mesh, real slope for plays-like - needs those
         and cannot get them back from a picture. The relief is a drawing made from them, lit
         off this hole's play axis so the light lands upper-left once Play has rotated the
         frame. Course-wide shading could not do that; the light is only correct for one
         heading and every hole has its own. */
      let terrain = null;
      let elevation = null;
      if (terrainEntry && bounds) {
        try {
          const demBuffer = await bufferFor(terrainEntry);
          const crop = await cropByBounds(demBuffer, terrainEntry.bounds, bounds);
          const azimuth = reliefAzimuthForPlayAxis(pins.tee, pins.green);
          const shaded = await reliefFromTerrainRgb(crop.buffer, {
            latitude: (crop.bounds.north + crop.bounds.south) / 2,
            zoom: terrainEntry.captureZoom
          }, { azimuth });
          terrain = { entry: { role: "terrain-reference", bounds: crop.bounds }, buffer: shaded.png };
          elevation = {
            buffer: crop.buffer,
            path: framesDir + "/h" + holeNumber + ".elevation.png",
            meta: {
              encoding: shaded.encoding,
              bounds: crop.bounds,
              width: crop.width,
              height: crop.height,
              captureZoom: terrainEntry.captureZoom,
              metresPerPixel: shaded.metresPerPixel,
              elevationRange: shaded.elevation,
              reliefAzimuth: azimuth,
              /* Recorded so a consumer can tell drawing decisions from measurements: the
                 heights in this file are true, the exaggeration is only how the sibling
                 frame was drawn. */
              reliefExaggeration: shaded.exaggeration
            }
          };
        } catch (error) {
          /* Relief is a finish, not the frame. A course whose elevation is missing or
             undecodable still ships its holes, unshaded, with the reason in the log. */
          console.log("[visual-worker] relief skipped for h" + holeNumber + ": " + (error && error.message || error));
          terrain = null;
          elevation = null;
        }
      }
      /* North-up mercator surface: the geometry the v19 GPS pipeline consumes natively
         (originPx + captureZoom + one image). The runtime does the play-axis framing, same
         as it does for locally captured surfaces. */
      const frame = await renderHoleSurfaceMercator({ pins, captures, terrain, settings, maxDim: EXPORT_RENDITION_PX });
      if (frame.diagnostics) {
        const t = frame.diagnostics.tone, tf = frame.diagnostics.turf;
        console.log("[visual-worker] normalise h" + holeNumber + " mean " + t.measuredMean.toFixed(1) + "->target " + t.brightnessTarget +
          " black/white " + t.blackPoint.toFixed(1) + ".." + t.whitePoint.toFixed(1) + " gamma " + t.gamma +
          " turf " + (tf.applied ? "pull " + tf.pull + " coverage " + tf.coverage : "not applied (" + tf.reason + ")"));
      }
      await storageUpload(path, frame.jpeg, "image/jpeg");
      width = frame.width; height = frame.height; bytes = frame.jpeg.length;
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
      if (elevation) {
        await storageUpload(elevation.path, elevation.buffer, "image/png");
        playSurface.elevation = Object.assign({ path: elevation.path }, elevation.meta);
        console.log("[visual-worker] elevation h" + holeNumber + " " + elevation.meta.width + "x" + elevation.meta.height +
          " " + elevation.meta.elevationRange.min.toFixed(1) + ".." + elevation.meta.elevationRange.max.toFixed(1) + "m" +
          " light az " + Math.round(elevation.meta.reliefAzimuth) + " (" + (elevation.buffer.length / 1024).toFixed(0) + "KB)");
      }
      await storageUpload(path + ".json", Buffer.from(JSON.stringify({ width, height, bytes, bounds, playSurface })), "application/json");
      rendered += 1;
    }
    framesIndex.holes.push({ holeNumber, path, width, height, bytes, bounds, playSurface });
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
        settings
      });
      if (overview.diagnostics) {
        const t = overview.diagnostics.tone, tf = overview.diagnostics.turf;
        console.log("[visual-worker] normalise overview mean " + t.measuredMean.toFixed(1) + "->target " + t.brightnessTarget +
          " black/white " + t.blackPoint.toFixed(1) + ".." + t.whitePoint.toFixed(1) + " gamma " + t.gamma +
          " turf " + (tf.applied ? "pull " + tf.pull + " coverage " + tf.coverage : "not applied (" + tf.reason + ")"));
      }
      await storageUpload(overviewPath, overview.jpeg, "image/jpeg");
      framesIndex.overview = { path: overviewPath, width: overview.width, height: overview.height, bytes: overview.jpeg.length, bounds: backdropEntry.bounds };
    } else {
      framesIndex.overview = { path: overviewPath, width: backdropEntry.width, height: backdropEntry.height, bounds: backdropEntry.bounds };
    }
  }
  if (!framesIndex.holes.length) throw new Error("no hole frames produced");
  /* Total download size, so the app can name a number in the offline-map prompt instead of
     guessing. Summed from what was actually encoded rather than measured afterwards, which
     would cost 19 HEAD requests from the phone. Null on any frame that was skipped by a resume
     without a sidecar carrying its size - the app treats a missing total as "unknown", never
     as zero. */
  framesIndex.totalBytes = framesIndex.holes.every(h => Number(h.bytes) > 0)
    ? framesIndex.holes.reduce((sum, h) => sum + Number(h.bytes), 0) + Number(framesIndex.overview && framesIndex.overview.bytes || 0)
    : null;
  await storageUpload(pkg.courseId + "/frames/index.json", Buffer.from(JSON.stringify(framesIndex)), "application/json");
  await writeCourseVisualRow(job, pkg, framesIndex, recipe);
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

export const __test = {
  NATURAL_PRESET_ID,
  RAW_BASELINE_OVERRIDES,
  builtInPresetSettings,
  normalizeRecipe,
  recipeFromPublishedRow,
  recipeFromLibraryRow
};
