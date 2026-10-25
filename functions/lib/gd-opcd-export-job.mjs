/* The OPCD export as a job: read the course, sample its terrain asset, write the files.

   Everything with a side effect comes in through deps so dev/opcd-export.test.mjs runs the
   whole job against fakes:
     supabaseFetch(pathAndQuery, init?)         PostgREST
     loadTerrain(courseId) -> manifest | null    the course's current terrain asset (with files)
     ensureTerrain(pkg, bounds) -> manifest|null bake one when there is none (may be slow)
     download(path) -> Buffer                   from the terrain bucket
     decodeTerrainPng(buffer) -> {heights, width, height}
     upload(path, buffer, contentType)          into the export bucket
     encodePreviewPng(grey, width, height) -> Buffer | null   optional
     readWindow(grid, {manifest, heights}) -> {heights, from, source, tried} | null
                                                optional; terrainForWindow for the frame's
                                                mercator window when the asset stops short
     readCanopy(bounds) -> {grids} | null        optional; tree heights
     loadScorecardHoles(pkg) -> [] | null        optional; par
     heartbeat(stage)                            optional
     now() -> Date

   Output layout (course-visuals bucket, public like the frames):
     <courseId>/opcd/<version>/heightmap.raw | heightmap.tif | heightmap-preview.png |
                               surfaces.geojson | trees.csv | holes.csv | manifest.json | README.md
   A version is a timestamp; nothing is overwritten and the job result names the folder. */

import { courseBoundsFor } from "./gd-visual-plan-core.mjs";
import { assetAsRaw } from "./terrain/gd-terrain-window.mjs";
import { liveTrees } from "./gd-course-trees-core.mjs";
import watchMapCore from "../../scripts/gd-watch-map-core.js";
import {
  planOpcdFrame, sampleHeightmap, heightStats, rawEncoding, encodeRaw16, heightmapGeoTiff, previewGrey,
  surfacesGeoJson, treesCsv, holesCsv, parByHole, opcdManifest, opcdReadme, assetCovers, windowGridFor, rawFromWindow
} from "./gd-opcd-export-core.mjs";

export const OPCD_ROOT = "opcd";
const TREES_TABLE = "course_trees";
const OVERLAYS_TABLE = "course_map_overlays";
const MERC_R = 6378137;

export function opcdVersion(now) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
}

/* Studio-placed single trees plus the finder's live level, each tagged with where it came
   from. Either table missing is an empty list, not a failure. */
export async function loadCourseTrees(courseId, supabaseFetch) {
  const [treeRows, overlayRows] = await Promise.all([
    supabaseFetch(TREES_TABLE + "?select=trees,level&course_id=eq." + encodeURIComponent(courseId) + "&limit=1").catch(() => []),
    supabaseFetch(OVERLAYS_TABLE + "?select=features&course_id=eq." + encodeURIComponent(courseId) + "&limit=1").catch(() => [])
  ]);
  const found = liveTrees(Array.isArray(treeRows) ? treeRows[0] : null).map(t => ({ lat: t.lat, lng: t.lng, r: t.r, level: t.l, source: "finder" }));
  const features = Array.isArray(overlayRows) && overlayRows[0] && Array.isArray(overlayRows[0].features) ? overlayRows[0].features : [];
  const placed = watchMapCore.singleTreesFromOverlay(features).map(t => ({ lat: t.lat, lng: t.lng, r: t.r, source: "studio" }));
  return placed.concat(found);
}

/* A sampler over the canopy grids gd-canopy-height's readCanopy returns (EPSG:3857 or 4326,
   top-left origin, dy negative for north-up). Null where no grid has data. */
export function canopySampler(grids) {
  const list = Array.isArray(grids) ? grids : [];
  if (!list.length) return null;
  return function canopyAt(lat, lng) {
    for (const g of list) {
      let x, y;
      if (g.crs === "EPSG:3857") {
        x = MERC_R * lng * Math.PI / 180;
        y = MERC_R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
      } else { x = lng; y = lat; }
      const col = Math.floor((x - g.x0) / g.dx), row = Math.floor((y - g.y0) / g.dy);
      if (col < 0 || row < 0 || col >= g.width || row >= g.height) continue;
      const v = g.heights[row * g.width + col];
      if (v > 0) return v;
    }
    return null;
  };
}

export async function runOpcdExport({ courseId, pkg }, deps) {
  const beat = deps.heartbeat || (() => Promise.resolve());
  const now = deps.now ? deps.now() : new Date();
  const warnings = [];
  const bounds = courseBoundsFor(pkg);
  if (!bounds) throw new Error("course has no play-ready geometry to frame");

  await beat("terrain");
  let terrain = await deps.loadTerrain(courseId);
  if (!terrain && deps.ensureTerrain) terrain = await deps.ensureTerrain(pkg, bounds);
  if (!terrain || !terrain.files || !terrain.files.heights) throw new Error("no terrain asset for " + courseId + " - bake terrain first");
  const png = await deps.download(terrain.files.heights);
  const decoded = await deps.decodeTerrainPng(png);
  if (decoded.width !== terrain.grid.width || decoded.height !== terrain.grid.height) {
    throw new Error("terrain asset is " + decoded.width + "x" + decoded.height + " but its manifest says " + terrain.grid.width + "x" + terrain.grid.height);
  }
  const raw = assetAsRaw(terrain, decoded.heights);

  await beat("heightmap");
  const frame = planOpcdFrame(bounds);
  if (frame.clipped) warnings.push("course span " + Math.round(Math.max(frame.courseSpanM.east, frame.courseSpanM.north)) + " m exceeds the largest frame (" + frame.sideM + " m); edges are cut");
  /* The asset is baked round the course with its own margin; a square frame round a narrow
     course reaches past it. That ring is read for this export through the same window path
     the live frame uses (asset first, then the resolver's providers), and only what no
     source holds is nearest-filled. */
  let fallback = null, beyondAsset = null;
  if (!assetCovers(terrain, frame.bounds) && deps.readWindow) {
    const grid = windowGridFor(frame, { zoom: terrain.grid.captureZoom });
    await beat("terrain beyond the asset (" + grid.width + "x" + grid.height + " @z" + grid.zoom + ")");
    try {
      const win = await deps.readWindow(grid, { manifest: terrain, heights: decoded.heights });
      if (win && win.heights && win.heights.length === grid.width * grid.height) {
        fallback = rawFromWindow(grid, win.heights);
        beyondAsset = (win.source && win.source.id || "terrain provider") + " (" + (win.from || "provider") + ", z" + grid.zoom + ")";
      } else {
        warnings.push("no terrain source could supply the frame beyond the asset (" + ((win && win.tried || []).join("; ") || "nothing tried") + "); edges nearest-filled");
      }
    } catch (error) {
      warnings.push("terrain beyond the asset failed (" + String(error && error.message || error).slice(0, 120) + "); edges nearest-filled");
    }
  }
  const sampled = sampleHeightmap(frame, raw, { fallback });
  sampled.beyondAsset = beyondAsset;
  if (sampled.filledFraction > 0.05) warnings.push(Math.round(sampled.filledFraction * 100) + "% of the frame has no ground from any source and was nearest-filled");
  const stats = heightStats(sampled.heights);
  const encoding = rawEncoding(stats);
  const quality = terrain.quality && terrain.quality.class;
  if (quality && quality !== "lidar" && quality !== "high-resolution") warnings.push("terrain is " + quality + " (" + terrain.sourceResolutionM + " m source) - fine for routing, not for greens");

  await beat("trees");
  const trees = await loadCourseTrees(courseId, deps.supabaseFetch);
  let canopyAt = null;
  if (deps.readCanopy && trees.length) {
    try {
      const canopy = await deps.readCanopy(bounds);
      canopyAt = canopySampler(canopy && canopy.grids);
    } catch (error) {
      warnings.push("tree heights unavailable (" + String(error && error.message || error).slice(0, 120) + "); heights estimated from crowns");
    }
  }
  const treesOut = treesCsv(trees, frame, sampled.heights, { canopyAt });

  await beat("surfaces");
  let par = new Map();
  if (deps.loadScorecardHoles) {
    try { par = parByHole(await deps.loadScorecardHoles(pkg)); } catch (e) { par = new Map(); }
  }
  const geojson = surfacesGeoJson(pkg, frame, { par });
  const holesOut = holesCsv(pkg, frame, sampled.heights, { par });

  await beat("writing");
  const version = opcdVersion(now);
  const root = courseId + "/" + OPCD_ROOT + "/" + version;
  const files = [];
  const put = async (name, buffer, contentType) => {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    await deps.upload(root + "/" + name, buf, contentType);
    files.push({ name, path: root + "/" + name, bytes: buf.length, contentType });
  };
  await put("heightmap.raw", encodeRaw16(sampled.heights, encoding), "application/octet-stream");
  await put("heightmap.tif", await heightmapGeoTiff(frame, sampled.heights, { writeArrayBuffer: deps.writeArrayBuffer }), "image/tiff");
  if (deps.encodePreviewPng) {
    try {
      const preview = await deps.encodePreviewPng(previewGrey(sampled.heights, encoding), frame.samples, frame.samples);
      if (preview) await put("heightmap-preview.png", preview, "image/png");
    } catch (error) {
      warnings.push("preview not written (" + String(error && error.message || error).slice(0, 120) + ")");
    }
  }
  await put("surfaces.geojson", JSON.stringify(geojson), "application/geo+json");
  await put("trees.csv", treesOut.csv, "text/csv");
  await put("holes.csv", holesOut.csv, "text/csv");

  const surfaceCounts = {};
  geojson.features.forEach(f => { surfaceCounts[f.properties.kind] = (surfaceCounts[f.properties.kind] || 0) + 1; });
  const manifest = opcdManifest({
    courseId, courseName: pkg.courseName || courseId, frame, encoding, stats, sampled, terrain,
    trees: { count: treesOut.count, inside: treesOut.inside, measured: treesOut.measured, file: "trees.csv" },
    holes: { count: holesOut.count, parKnown: par.size, file: "holes.csv" },
    surfaces: { counts: surfaceCounts, file: "surfaces.geojson" },
    files: files.map(f => ({ name: f.name, bytes: f.bytes })),
    generatedAt: now.toISOString(), warnings
  });
  await put("README.md", opcdReadme(manifest), "text/markdown");
  manifest.files = files.map(f => ({ name: f.name, bytes: f.bytes }));
  await put("manifest.json", JSON.stringify(manifest, null, 2), "application/json");

  return {
    version, root, files,
    frame: manifest.frame, heightmap: manifest.heightmap,
    terrainVersion: terrain.terrainVersion, qualityClass: quality || null,
    trees: manifest.trees, holes: manifest.holes, surfaces: manifest.surfaces,
    warnings
  };
}
