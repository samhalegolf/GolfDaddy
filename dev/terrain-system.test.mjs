/*
 * The terrain ingestion system (functions/lib/terrain/) - no network, no Supabase.
 *
 * Providers are either fakes that return RawTerrainData directly or the REAL adapters fed by a
 * stubbed fetch, so the resolver -> adapter -> normaliser -> bake -> stored asset path runs end
 * to end. Pinned here, by the numbers the brief asked for:
 *    1 course fully covered by regional terrain        8 CRS conversion
 *    2 course not covered -> global fallback           9 provider disabled
 *    3 regional provider failure -> global fallback   10 asset exists -> no refetch
 *    4 regional beats global                          11 source updated -> rebuild available
 *    5 higher resolution beats lower                  12 green slope lines off for coarse terrain
 *    6 partial coverage                               13 adapter errors never break the bake
 *    7 nodata handling
 * plus the staging round trip (OSNI-style files -> staged tiles -> a bake reads them) and the
 * network failure modes (timeouts, rate limits, malformed answers).
 *
 * Run: node dev/terrain-system.test.mjs
 */
import assert from "node:assert/strict";
import sharp from "sharp";
import { createRequire } from "node:module";
import { TERRAIN_CONFIG, terrainCapabilities, effectiveQualityClass } from "../functions/lib/terrain/gd-terrain-config.mjs";
import { TERRAIN_SOURCES, GLOBAL_TERRAIN_SOURCE_ID, sourceFingerprint } from "../functions/lib/terrain/gd-terrain-sources.mjs";
import { resolveTerrain, assessRebuild, padBoundsM } from "../functions/lib/terrain/gd-terrain-resolver.mjs";
import { fromLngLat, toLngLat, projectBounds, __test as crsTest } from "../functions/lib/terrain/gd-terrain-crs.mjs";
import { ADAPTERS, fetchWithRetry, mercMetresPerPixel, pixelRectFor, encodeStagedTile, TerrainError } from "../functions/lib/terrain/gd-terrain-adapters.mjs";
import { planClarityGrid, reprojectToGrid, gridPixelLatLng, MASK_FILLED } from "../functions/lib/terrain/gd-terrain-normalise.mjs";
import { bakeCourseTerrain, reuseDecision, TERRAIN_FORMAT_VERSION } from "../functions/lib/terrain/gd-terrain-bake.mjs";
import { ensureCourseTerrain, loadCourseTerrain } from "../functions/lib/terrain/gd-terrain-service.mjs";
import { terrainForWindow } from "../functions/lib/terrain/gd-terrain-window.mjs";
import { parseElevationText, addToTiles, stagedIndex } from "../functions/lib/terrain/gd-terrain-staging.mjs";
import { terrainRgbPngFromHeights, cropByBounds, decodeElevation } from "../functions/lib/gd-relief-core.mjs";
import { encodeTerrainAsset } from "../functions/lib/terrain/gd-terrain-bake.mjs";

const require = createRequire(import.meta.url);
const liveTerrain = require("../app/js/live-terrain.js");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok   " + name); }
  catch (error) { failures.push(name); console.log("FAIL " + name + "\n     " + (error && error.stack || error).split("\n").slice(0, 4).join("\n     ")); }
}

/* ---------- fixtures --------------------------------------------------------------------- */

/* Royal Portrush-sized bounds (NI), St Andrews (Scotland - no regional source), Pupuke (NZ). */
const PORTRUSH = { south: 55.196, north: 55.207, west: -6.64, east: -6.61 };
const ST_ANDREWS = { south: 56.340, north: 56.352, west: -2.83, east: -2.80 };
const PUPUKE = { south: -36.756, north: -36.749, west: 174.748, east: 174.756 };
const MERC_HALF = 20037508.342789244;

const staged = (over = {}) => TERRAIN_SOURCES.map(s => s.id === "osni-ni-dtm10" ? Object.assign({}, s, { datasetVersion: "test-v1" }, over) : s);
const ENV = { LINZ_BASEMAPS_API_KEY: "k" };

/* Heights as a smooth function of WGS84 position, so any source in any CRS describes the SAME
   ground and reprojection errors show up as height errors. */
const groundAt = (lat, lng) => 40 + (lat - 55) * 2000 + (lng + 6.6) * 800;

/* A fake adapter that serves `groundAt` in the source's own CRS, with optional failure/holes. */
function fakeAdapter(sourceType, behaviour = {}) {
  const calls = [];
  return {
    calls,
    sourceType,
    canHandle: s => s.sourceType === sourceType,
    async fetchTerrain({ source, bounds }) {
      calls.push(source.id);
      const b = behaviour[source.id] || {};
      if (b.throw) throw b.throw;
      const crs = source.horizontalCrs;
      let raw;
      if (crs === "EPSG:3857") {
        const z = 15, r = pixelRectFor(bounds, z), mpp = mercMetresPerPixel(z);
        raw = { crs, width: r.width, height: r.height, transform: { originX: r.left * mpp - MERC_HALF, originY: MERC_HALF - r.top * mpp, pixelSize: mpp } };
      } else {
        const n = projectBounds(crs, bounds), px = Number(source.resolutionM) || 10;
        const ox = Math.floor(n.minX / px) * px - 2 * px, oy = Math.ceil(n.maxY / px) * px + 2 * px;
        raw = { crs, width: Math.ceil((n.maxX - ox) / px) + 3, height: Math.ceil((oy - n.minY) / px) + 3, transform: { originX: ox, originY: oy, pixelSize: px } };
      }
      raw.heights = new Float32Array(raw.width * raw.height);
      for (let j = 0; j < raw.height; j++) for (let i = 0; i < raw.width; i++) {
        const X = raw.transform.originX + (i + 0.5) * raw.transform.pixelSize, Y = raw.transform.originY - (j + 0.5) * raw.transform.pixelSize;
        const ll = toLngLat(crs, X, Y);
        let v = groundAt(ll.lat, ll.lng) + (b.offset || 0);
        if (b.holeWestOf != null && ll.lng < b.holeWestOf) v = NaN;
        raw.heights[j * raw.width + i] = v;
      }
      return Object.assign(raw, { sourceId: source.id, verticalDatum: source.verticalDatum, resolutionM: source.resolutionM, requests: { total: 1, failed: 0, missing: 0 }, warnings: [] });
    }
  };
}
function fakeAdapters(behaviour) {
  const list = ["xyz-elevation", "arcgis-image-server", "clarity-staged"].map(t => fakeAdapter(t, behaviour));
  list.calls = () => list.flatMap(a => a.calls);
  return list;
}

/* An in-memory course_terrain table + storage bucket, enough for gd-terrain-service. */
function memoryStore() {
  const rows = new Map(), files = new Map();
  const supabaseFetch = async (pathAndQuery, options = {}) => {
    const [table, query = ""] = pathAndQuery.split("?");
    assert.equal(table, "course_terrain");
    const params = new URLSearchParams(query);
    const id = (params.get("course_id") || "").replace(/^eq\./, "");
    const method = options.method || "GET";
    if (method === "GET") return rows.has(id) ? [rows.get(id)] : [];
    if (method === "POST") { for (const r of JSON.parse(options.body)) rows.set(r.course_id, Object.assign({}, rows.get(r.course_id) || {}, r)); return []; }
    if (method === "PATCH") { rows.set(id, Object.assign({}, rows.get(id), JSON.parse(options.body))); return []; }
    throw new Error("unexpected " + method);
  };
  const storage = {
    upload: async (p, buffer) => { files.set(p, buffer); return p; },
    list: async prefix => {
      const names = new Set();
      for (const p of files.keys()) if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length), slash = rest.indexOf("/");
        names.add(slash < 0 ? JSON.stringify({ name: rest, id: "f" }) : JSON.stringify({ name: rest.slice(0, slash), id: null }));
      }
      return [...names].map(n => JSON.parse(n));
    },
    remove: async paths => { paths.forEach(p => files.delete(p)); }
  };
  return { rows, files, supabaseFetch, storage };
}

function serviceDeps(store, bake) {
  return { supabaseFetch: store.supabaseFetch, storage: store.storage, sharp, terrainRgbPngFromHeights, bake };
}

/* ---------- 1-6, 9: the resolver and the bake's source choice ---------------------------------- */

await test("1. a course fully covered by a regional source bakes from it alone", async () => {
  const adapters = fakeAdapters({});
  const out = await bakeCourseTerrain({ courseId: "portrush", courseBounds: PORTRUSH }, { sources: staged(), adapters });
  const m = out.manifest;
  assert.equal(m.sources[0].id, "osni-ni-dtm10");
  assert.equal(m.sources[0].role, "primary");
  assert.equal(m.strategy, "single");
  assert.equal(m.coverage.core, 1);
  assert.equal(m.horizontalCrs, "EPSG:3857");
  assert.deepEqual(m.sourceCrs, ["EPSG:29902"]);
  assert.equal(m.verticalDatum, "Belfast");
  assert.equal(m.sources[0].licence, "Open Government Licence v3.0");
  assert.equal(m.sources[0].datasetVersion, "test-v1");
  assert.equal(m.sourceResolutionM, 10);
  assert.ok(m.grid.metresPerPixel <= 5 && m.grid.metresPerPixel >= 2, "grid oversamples a 10m source by about 2x: " + m.grid.metresPerPixel);
  assert.ok(m.frameBounds.north > PORTRUSH.north && m.frameBounds.west < PORTRUSH.west, "fetched with the margin");
  assert.deepEqual(adapters.calls(), ["osni-ni-dtm10"], "the global source is never fetched when the regional one covers the course");
  assert.ok(m.failures.length === 0);
});

await test("2. a course no regional source covers falls to the global source and is flagged", async () => {
  const r = resolveTerrain({ bounds: ST_ANDREWS, countryCode: "GB", regionName: "Scotland", sources: staged() });
  assert.equal(r.strategy, "global-only");
  assert.equal(r.primarySource.id, GLOBAL_TERRAIN_SOURCE_ID);
  assert.equal(r.fallbackSource, null);
  assert.equal(r.upgrade.opportunity, true);
  assert.equal(r.upgrade.regionalConfigured, false);
  assert.equal(r.upgrade.region, "Scotland");
  assert.ok(r.log.some(l => /OSNI.*outside coverage/.test(l)));
  const out = await bakeCourseTerrain({ courseId: "st-andrews", courseBounds: ST_ANDREWS, regionName: "Scotland" }, { sources: staged(), adapters: fakeAdapters({}) });
  assert.equal(out.manifest.strategy, "global-only");
  assert.equal(out.manifest.quality.class, "global");
  assert.equal(out.manifest.quality.greenDetail, "none");
});

await test("3. a regional source that fails is recorded and the global source answers", async () => {
  const adapters = fakeAdapters({ "osni-ni-dtm10": { throw: new TerrainError("osni-ni-dtm10", "timeout", "timed out") } });
  const out = await bakeCourseTerrain({ courseId: "portrush", courseBounds: PORTRUSH }, { sources: staged(), adapters });
  const m = out.manifest;
  assert.equal(m.sources[0].id, GLOBAL_TERRAIN_SOURCE_ID);
  assert.equal(m.strategy, "fallback");
  assert.deepEqual(m.failures.map(f => [f.sourceId, f.code]), [["osni-ni-dtm10", "timeout"]]);
  assert.equal(m.resolver.selected, "osni-ni-dtm10", "the manifest remembers what it SHOULD have been");
  assert.ok(m.log.some(l => /fetch failed/.test(l)));
});

await test("4. regional terrain outranks the global source", () => {
  const r = resolveTerrain({ bounds: PORTRUSH, sources: staged() });
  assert.equal(r.primarySource.id, "osni-ni-dtm10");
  assert.equal(r.fallbackSource.id, GLOBAL_TERRAIN_SOURCE_ID);
  assert.deepEqual(r.plan, ["osni-ni-dtm10", GLOBAL_TERRAIN_SOURCE_ID]);
  assert.equal(r.strategy, "single-with-fallback");
  /* ...even when the global one is given an absurd priority: global is never ranked. */
  const rigged = staged().map(s => s.id === GLOBAL_TERRAIN_SOURCE_ID ? Object.assign({}, s, { priority: 1e6 }) : s);
  assert.equal(resolveTerrain({ bounds: PORTRUSH, sources: rigged }).primarySource.id, "osni-ni-dtm10");
});

await test("5. a higher-resolution source beats a lower-resolution one over the same ground", () => {
  const lidar = { id: "ni-lidar-1m", name: "Estate LiDAR 1m", regions: ["GB-NIR"], coverage: { type: "region", bboxes: [{ south: 55.1, west: -6.8, north: 55.3, east: -6.5 }] },
    sourceType: "clarity-staged", staged: { bucket: "terrain-sources", tileSizeM: 500 }, resolutionM: 1, fallbackResolutionM: 1, horizontalCrs: "EPSG:2157",
    verticalDatum: "Belfast", licence: TERRAIN_SOURCES.find(s => s.id === "osni-ni-dtm10").licence, attribution: { text: "x" }, priority: 10, qualityClass: "lidar", enabled: true, datasetVersion: "v1" };
  const r = resolveTerrain({ bounds: PORTRUSH, sources: [...staged(), lidar] });
  assert.equal(r.primarySource.id, "ni-lidar-1m", "1m beats 10m even at lower priority");
  assert.deepEqual(r.plan, ["ni-lidar-1m", "osni-ni-dtm10", GLOBAL_TERRAIN_SOURCE_ID]);
  assert.equal(effectiveQualityClass("lidar", 1), "lidar");
  assert.equal(effectiveQualityClass("lidar", 8), "regional", "a LiDAR source that only delivered 8m is regional");
});

await test("6. partial coverage: blend under a matching datum, fall back whole across a mismatched one", async () => {
  /* Measured coverage: OSNI has no data west of the course's middle (border/sea). Its datum
     (Belfast) differs from the global one, so nothing is spliced - the global answers alone. */
  const mid = (PORTRUSH.west + PORTRUSH.east) / 2;
  const out = await bakeCourseTerrain({ courseId: "p", courseBounds: PORTRUSH }, { sources: staged(), adapters: fakeAdapters({ "osni-ni-dtm10": { holeWestOf: mid } }) });
  assert.equal(out.manifest.sources[0].id, GLOBAL_TERRAIN_SOURCE_ID);
  assert.ok(out.manifest.failures.some(f => f.sourceId === "osni-ni-dtm10" && f.code === "coverage"));
  assert.ok(out.manifest.log.some(l => /not blended: vertical datum/.test(l)), "and says why it was not blended");

  /* Same datum: a partial 1m survey over a full 10m DTM composites - LiDAR wins where it has
     ground, the DTM fills the rest, and the mask says which pixel came from which. */
  const lidar = { id: "ni-lidar-1m", name: "Estate LiDAR", regions: ["GB-NIR"], coverage: { type: "region", bboxes: [{ south: 55.1, west: -6.8, north: 55.3, east: -6.5 }] },
    sourceType: "clarity-staged", staged: { tileSizeM: 500 }, resolutionM: 2, fallbackResolutionM: 2, horizontalCrs: "EPSG:29902", verticalDatum: "Belfast",
    licence: TERRAIN_SOURCES.find(s => s.id === "osni-ni-dtm10").licence, attribution: { text: "x" }, priority: 10, qualityClass: "lidar", enabled: true, datasetVersion: "v1" };
  const blended = await bakeCourseTerrain({ courseId: "p", courseBounds: PORTRUSH }, {
    sources: [...staged(), lidar], adapters: fakeAdapters({ "ni-lidar-1m": { holeWestOf: mid } })
  });
  const m = blended.manifest;
  assert.equal(m.strategy, "composite");
  assert.deepEqual(m.sources.map(s => [s.id, s.role]).sort(), [["ni-lidar-1m", "detail"], ["osni-ni-dtm10", "primary"]].sort());
  const values = new Set(blended.mask);
  assert.ok(values.size >= 2 && !values.has(0), "every pixel attributed, by more than one source");
});

await test("9. a disabled provider is refused, reported, and leaves an upgrade opportunity", () => {
  const SYDNEY = { south: -33.95, north: -33.94, west: 151.18, east: 151.2 };
  const r = resolveTerrain({ bounds: SYDNEY, countryCode: "AU", sources: TERRAIN_SOURCES });
  assert.equal(r.primarySource.id, GLOBAL_TERRAIN_SOURCE_ID);
  const ga = r.candidates.find(c => c.id === "ga-au-dem-lidar-5m");
  assert.equal(ga.status, "rejected");
  assert.match(ga.reason, /^disabled/);
  assert.ok(r.log.some(l => /Geoscience Australia.*disabled.*better resolution/.test(l)), "the log calls out a better source that is switched off");
  assert.equal(r.upgrade.opportunity, true);
  assert.equal(r.upgrade.regionalConfigured, true);
  assert.match(r.upgrade.reason, /covers this course but is disabled/);
  /* Not staged yet is also refused - with the instruction to stage it. */
  const unstaged = resolveTerrain({ bounds: PORTRUSH, sources: TERRAIN_SOURCES });
  assert.equal(unstaged.primarySource.id, GLOBAL_TERRAIN_SOURCE_ID);
  assert.match(unstaged.candidates.find(c => c.id === "osni-ni-dtm10").reason, /not staged/);
  /* And an unconfigured key is refused the same way (LINZ with no key). */
  const nz = resolveTerrain({ bounds: PUPUKE, env: {}, sources: TERRAIN_SOURCES });
  assert.match(nz.candidates.find(c => c.id === "linz-nz-elevation").reason, /LINZ_BASEMAPS_API_KEY or LINZ_BASEMAPS_PUBLIC_KEY/);
  assert.equal(resolveTerrain({ bounds: PUPUKE, env: ENV, sources: TERRAIN_SOURCES }).primarySource.id, "linz-nz-elevation");
});

await test("licences, adapters and CRSs are gates, not suggestions", () => {
  const base = staged().find(s => s.id === "osni-ni-dtm10");
  const variants = [
    [Object.assign({}, base, { id: "sa", licence: Object.assign({}, base.licence, { shareAlike: true }) }), /licence/],
    [Object.assign({}, base, { id: "disp", licence: Object.assign({}, base.licence, { storage: false }) }), /licence/],
    [Object.assign({}, base, { id: "cog", sourceType: "cog" }), /no adapter/],
    [Object.assign({}, base, { id: "crs", horizontalCrs: "EPSG:31370" }), /CRS/],
    [Object.assign({}, base, { id: "draft", draft: true }), /draft/]
  ];
  for (const [source, why] of variants) {
    const r = resolveTerrain({ bounds: PORTRUSH, sources: [source, TERRAIN_SOURCES.find(s => s.id === GLOBAL_TERRAIN_SOURCE_ID)] });
    assert.equal(r.primarySource.id, GLOBAL_TERRAIN_SOURCE_ID, source.id);
    assert.match(r.candidates.find(c => c.id === source.id).reason, why, source.id);
  }
});

/* ---------- 7: nodata ---------------------------------------------------------------------------- */

await test("7. nodata is never ground: sentinels, transparency and NODATA_value become gaps, then marked fills", async () => {
  /* Real xyz adapter over stubbed terrain-RGB tiles: one tile transparent in a corner, one
     with the GSI sea sentinel, one missing (404). */
  const z = 15, bounds = padBoundsM(PUPUKE, 50);
  const tileBuf = async (tx, ty) => {
    const raw = Buffer.alloc(256 * 256 * 4);
    for (let p = 0; p < 256 * 256; p++) {
      const v = Math.round((50 + 10000) / 0.1);
      raw[p * 4] = (v >> 16) & 255; raw[p * 4 + 1] = (v >> 8) & 255; raw[p * 4 + 2] = v & 255; raw[p * 4 + 3] = 255;
      if ((tx + ty) % 3 === 0 && p % 256 < 32) raw[p * 4 + 3] = 0;          // transparent strip
    }
    return sharp(raw, { raw: { width: 256, height: 256, channels: 4 } }).png().toBuffer();
  };
  let missing = 0;
  const fetchImpl = async url => {
    const m = /\/(\d+)\/(\d+)\/(\d+)\.png/.exec(url);
    const x = Number(m[2]), y = Number(m[3]);
    if (missing === 0 && (x + y) % 5 === 0) { missing++; return { ok: false, status: 404, headers: { get: () => null } }; }
    const body = await tileBuf(x, y);
    return { ok: true, status: 200, headers: { get: () => "image/png" }, arrayBuffer: async () => body };
  };
  const xyz = ADAPTERS.find(a => a.sourceType === "xyz-elevation");
  const source = Object.assign({}, TERRAIN_SOURCES.find(s => s.id === "linz-nz-elevation"), { urlTemplate: "https://t/{z}/{x}/{y}.png" });
  const raw = await xyz.fetchTerrain({ source, bounds, zoom: z }, { fetchImpl, sharp });
  let nan = 0, zero = 0;
  for (const v of raw.heights) { if (!Number.isFinite(v)) nan++; else if (v === 0) zero++; }
  assert.ok(nan > 0, "gaps are NaN");
  assert.equal(zero, 0, "and never 0");
  assert.equal(raw.requests.missing, 1);

  /* Staged text with NODATA_value -9999. */
  const asc = "ncols 4\nnrows 3\nxllcorner 284000\nyllcorner 438000\ncellsize 10\nNODATA_value -9999\n1 2 3 4\n5 -9999 7 8\n9 10 11 12\n";
  const g = parseElevationText(asc);
  assert.equal(g.kind, "ascii-grid");
  assert.ok(Number.isNaN(g.heights[5]), "NODATA_value is nodata");
  assert.equal(g.valid, 11);
  const xyzText = "X,Y,Z\n100005,200005,-9999\n100015,200005,4.5\n100005,200015,3.0\n100015,200015,3.5\n";
  const p = parseElevationText(xyzText);
  assert.equal(p.kind, "xyz");
  assert.equal(p.pixelSize, 10);
  assert.ok(Number.isNaN(p.heights[2]), "a -9999 sentinel is nodata, not a 9999m trench");

  /* After the bake every gap is filled AND marked, and the manifest says how much. */
  const out = await bakeCourseTerrain({ courseId: "p", courseBounds: PUPUKE, env: ENV }, {
    sources: TERRAIN_SOURCES, adapters: fakeAdapters({ [GLOBAL_TERRAIN_SOURCE_ID]: { holeWestOf: PUPUKE.west - 0.002 }, "linz-nz-elevation": { holeWestOf: PUPUKE.west - 0.002 } })
  });
  assert.ok(out.manifest.coverage.filledFraction > 0, "margin gaps were filled");
  assert.ok(out.mask.some(v => v === MASK_FILLED), "and every filled pixel is marked");
  assert.ok(out.manifest.filledRegions.length > 0, "and reported as regions the green fit can refuse");
  for (const v of out.heights) assert.ok(Number.isFinite(v));
});

/* ---------- 8: CRS ------------------------------------------------------------------------------- */

await test("8. CRS conversion: OS worked example, round trips, and Irish Grid ground lands in the right place", () => {
  const { tmForward, ELLIPSOIDS, CRS } = crsTest;
  const lat = 52 + 39 / 60 + 27.2531 / 3600, lng = 1 + 43 / 60 + 4.5177 / 3600;
  const [E, N] = tmForward(CRS["EPSG:27700"], ELLIPSOIDS.Airy1830, lat, lng);
  assert.ok(Math.abs(E - 651409.903) < 0.01 && Math.abs(N - 313177.270) < 0.01, "OS Annex C example: " + E + "," + N);
  for (const crs of ["EPSG:27700", "EPSG:29902", "EPSG:29903", "EPSG:2157", "EPSG:3857", "EPSG:2193"]) {
    const pt = crs === "EPSG:2193" ? [-36.75, 174.75] : [54.6, -5.93];
    const xy = fromLngLat(crs, pt[0], pt[1]);
    const back = toLngLat(crs, xy[0], xy[1]);
    assert.ok(Math.abs(back.lat - pt[0]) < 1e-7 && Math.abs(back.lng - pt[1]) < 1e-7, crs + " round trip");
  }
  /* Irish Grid and ITM are the same TM on different datums/offsets: ~(400000, 500000) apart. */
  const ig = fromLngLat("EPSG:29902", 54.5966, -5.9301), itm = fromLngLat("EPSG:2157", 54.5966, -5.9301);
  assert.ok(Math.abs(itm[0] - ig[0] - 400000) < 150 && Math.abs(itm[1] - ig[1] - 500000) < 150);

  /* A grid laid out in Irish Grid, resampled onto the web-mercator Clarity grid, gives the
     height of the ground actually under each mercator pixel. */
  const source = staged().find(s => s.id === "osni-ni-dtm10");
  const grid = planClarityGrid(padBoundsM(PORTRUSH, 100), 10);
  return fakeAdapter("clarity-staged").fetchTerrain({ source, bounds: padBoundsM(PORTRUSH, 150) }).then(raw => {
    const heights = reprojectToGrid(raw, grid);
    let worst = 0;
    for (const [i, j] of [[5, 5], [grid.width - 6, 7], [Math.floor(grid.width / 2), Math.floor(grid.height / 2)], [9, grid.height - 9]]) {
      const ll = gridPixelLatLng(grid, i, j);
      worst = Math.max(worst, Math.abs(heights[j * grid.width + i] - groundAt(ll.lat, ll.lng)));
    }
    /* groundAt changes ~0.02m per metre; 0.2m of error is ~10m of misplacement at worst. Real
       TM65 datum error is ~1m, i.e. ~0.02m here. */
    assert.ok(worst < 0.2, "Irish Grid -> mercator height error " + worst.toFixed(4) + "m");
  });
});

/* ---------- 10, 11, 13: the stored asset ---------------------------------------------------------- */

await test("10. an existing, current asset is reused - nothing is fetched again", async () => {
  const store = memoryStore();
  const adapters = fakeAdapters({});
  const bake = { sources: staged(), adapters };
  const first = await ensureCourseTerrain({ courseId: "portrush", courseBounds: PORTRUSH }, serviceDeps(store, bake));
  assert.equal(first.status, "baked");
  assert.equal(first.manifest.terrainVersion, 1);
  assert.ok(store.files.has("portrush/terrain/v1/heights.png") && store.files.has("portrush/terrain/v1/mask.png") && store.files.has("portrush/terrain/v1/manifest.json"));
  const row = store.rows.get("portrush");
  assert.equal(row.status, "ready");
  assert.equal(row.primary_source_id, "osni-ni-dtm10");
  assert.ok(!JSON.stringify(row.manifest).includes("heights\":["), "no height arrays in the database row");
  const fetched = adapters.calls().length;
  const again = await ensureCourseTerrain({ courseId: "portrush", courseBounds: PORTRUSH }, serviceDeps(store, bake));
  assert.equal(again.status, "reused");
  assert.equal(adapters.calls().length, fetched, "no provider contacted");
  /* Readers (export, live frame) get the asset and its files. */
  const loaded = await loadCourseTerrain("portrush", { supabaseFetch: store.supabaseFetch });
  assert.equal(loaded.files.heights, "portrush/terrain/v1/heights.png");
  /* A read-only caller (a test bake) never writes. */
  const ro = await ensureCourseTerrain({ courseId: "elsewhere", courseBounds: ST_ANDREWS, readOnly: true }, serviceDeps(store, bake));
  assert.equal(ro.status, "unavailable");
  assert.ok(!store.rows.has("elsewhere"));
  /* Geometry that moves outside the baked frame forces a fresh bake. */
  const moved = { south: PORTRUSH.south + 0.02, north: PORTRUSH.north + 0.02, west: PORTRUSH.west, east: PORTRUSH.east };
  const rebaked = await ensureCourseTerrain({ courseId: "portrush", courseBounds: moved }, serviceDeps(store, bake));
  assert.equal(rebaked.status, "baked");
  assert.equal(rebaked.manifest.terrainVersion, 2);
});

await test("11. a source that is updated, or newly added, makes a rebuild available", async () => {
  const store = memoryStore();
  const v1 = staged();
  await ensureCourseTerrain({ courseId: "portrush", courseBounds: PORTRUSH }, serviceDeps(store, { sources: v1, adapters: fakeAdapters({}) }));
  const manifest = store.rows.get("portrush").manifest;
  /* Same source, new dataset version. */
  const v2 = staged({ datasetVersion: "test-v2" });
  const assessment = assessRebuild(manifest, resolveTerrain({ bounds: PORTRUSH, sources: v2 }), { formatVersion: TERRAIN_FORMAT_VERSION });
  assert.equal(assessment.rebuild, true);
  assert.equal(assessment.sourceUpdated, true);
  const re = await ensureCourseTerrain({ courseId: "portrush", courseBounds: PORTRUSH }, serviceDeps(store, { sources: v2, adapters: fakeAdapters({}) }));
  assert.equal(re.status, "baked");
  assert.equal(re.manifest.sources[0].datasetVersion, "test-v2");
  assert.equal(re.manifest.terrainVersion, 2);
  /* A course baked on the global source before OSNI was staged: staging it is an upgrade. */
  const before = memoryStore();
  await ensureCourseTerrain({ courseId: "portrush", courseBounds: PORTRUSH }, serviceDeps(before, { sources: TERRAIN_SOURCES, adapters: fakeAdapters({}) }));
  assert.equal(before.rows.get("portrush").primary_source_id, GLOBAL_TERRAIN_SOURCE_ID);
  const upgrade = assessRebuild(before.rows.get("portrush").manifest, resolveTerrain({ bounds: PORTRUSH, sources: v1 }), { formatVersion: TERRAIN_FORMAT_VERSION });
  assert.equal(upgrade.upgradeAvailable, true);
  assert.match(upgrade.reason, /better source available: OSNI/);
  assert.notEqual(sourceFingerprint(v1.find(s => s.id === "osni-ni-dtm10")), sourceFingerprint(v2.find(s => s.id === "osni-ni-dtm10")));
});

await test("13. provider errors never break the course: failure recorded, old asset kept, nothing thrown", async () => {
  const store = memoryStore();
  /* Every source down - and the course has no asset yet. */
  const allDown = fakeAdapters({ "osni-ni-dtm10": { throw: new Error("boom") }, [GLOBAL_TERRAIN_SOURCE_ID]: { throw: new TerrainError("g", "rate-limited", "HTTP 429") } });
  const r = await ensureCourseTerrain({ courseId: "portrush", courseBounds: PORTRUSH }, serviceDeps(store, { sources: staged(), adapters: allDown }));
  assert.equal(r.status, "failed");
  assert.match(r.error, /no terrain source produced usable ground/);
  assert.equal(store.rows.get("portrush").status, "failed");
  assert.ok(store.rows.get("portrush").last_error);
  /* Bake succeeds; then a forced rebake fails - the good asset stays live. */
  await ensureCourseTerrain({ courseId: "portrush", courseBounds: PORTRUSH }, serviceDeps(store, { sources: staged(), adapters: fakeAdapters({}) }));
  assert.equal(store.rows.get("portrush").status, "ready");
  const bad = await ensureCourseTerrain({ courseId: "portrush", courseBounds: PORTRUSH, force: true }, serviceDeps(store, { sources: staged(), adapters: allDown }));
  assert.equal(bad.status, "failed");
  assert.equal(bad.manifest.terrainVersion, store.rows.get("portrush").terrain_version, "the previous asset is still what readers get");
  assert.equal(store.rows.get("portrush").status, "ready");
  assert.ok(store.rows.get("portrush").last_error);
  /* A primary that failed is retried only once its failure is a day old. */
  const fellBack = memoryStore();
  const t0 = new Date("2026-10-01T10:00:00Z");
  const flaky = fakeAdapters({ "osni-ni-dtm10": { throw: new TerrainError("osni-ni-dtm10", "timeout", "timed out") } });
  await ensureCourseTerrain({ courseId: "portrush", courseBounds: PORTRUSH }, Object.assign(serviceDeps(fellBack, { sources: staged(), adapters: flaky }), { now: () => t0 }));
  const m = fellBack.rows.get("portrush").manifest;
  const resolution = resolveTerrain({ bounds: PORTRUSH, sources: staged() });
  assert.equal(reuseDecision(m, resolution, PORTRUSH, { now: new Date(t0.getTime() + 3600e3) }).reuse, true, "an hour later: keep the fallback");
  assert.equal(reuseDecision(m, resolution, PORTRUSH, { now: new Date(t0.getTime() + 25 * 3600e3) }).reuse, false, "a day later: try the regional source again");
});

/* ---------- 12: green detail gating ---------------------------------------------------------- */

await test("12. green slope lines are off for coarse terrain and on for fine terrain", async () => {
  assert.equal(terrainCapabilities({ resolutionM: 1, fallbackResolutionM: 1 }).greenDetail, "allowed");
  assert.equal(terrainCapabilities({ resolutionM: 1, fallbackResolutionM: 8 }).greenDetail, "conditional", "LINZ-style mixed tiers: allowed only where the fit passes");
  assert.equal(terrainCapabilities({ resolutionM: 10, fallbackResolutionM: 10 }).greenDetail, "coarse");
  assert.equal(terrainCapabilities({ resolutionM: 25, fallbackResolutionM: 30 }).greenDetail, "none");
  assert.equal(terrainCapabilities({ resolutionM: 10 }).greenSlopeLinesDefault, false);
  assert.equal(terrainCapabilities({ resolutionM: 25 }).courseTerrain, false, "global terrain is broad landscape only");
  /* The phone's gate reads the asset's verdict first. */
  assert.equal(liveTerrain.greenReadable({ terrain: { greenDetail: "coarse" }, sourceMetresPerSample: 1 }), false, "the asset's verdict beats a fine-looking spacing");
  assert.equal(liveTerrain.greenReadable({ terrain: { greenDetail: "allowed" } }), true);
  assert.equal(liveTerrain.greenReadable({ terrain: { greenDetail: "conditional" } }), true);
  assert.equal(liveTerrain.greenReadable({ terrain: { greenDetail: "none" } }), false);
  assert.equal(liveTerrain.greenReadable({ sourceMetresPerSample: 10 }), false, "no verdict: spacing decides");
  assert.equal(liveTerrain.greenReadable({}), true, "a bake older than both is left to the fit's own gate");
  /* An OSNI bake says coarse, and the threshold is the configured one. */
  const out = await bakeCourseTerrain({ courseId: "p", courseBounds: PORTRUSH }, { sources: staged(), adapters: fakeAdapters({}) });
  assert.equal(out.manifest.quality.greenDetail, "coarse");
  assert.equal(TERRAIN_CONFIG.quality.greenDetailMaxM, 2.5);
});

/* ---------- reads from the stored asset ---------------------------------------------------------- */

await test("a window inside the course asset is cut from it; outside it, the resolver answers", async () => {
  const adapters = fakeAdapters({});
  const baked = await bakeCourseTerrain({ courseId: "p", courseBounds: PORTRUSH }, { sources: staged(), adapters });
  const g = baked.manifest.grid;
  const asset = { manifest: baked.manifest, heights: baked.heights };
  const inside = { zoom: g.captureZoom + 1, originPx: { x: (g.originPx.x + 40) * 2, y: (g.originPx.y + 40) * 2 }, width: 200, height: 150 };
  const before = adapters.calls().length;
  const r = await terrainForWindow({ grid: inside, asset }, { sources: staged(), adapters });
  assert.equal(r.from, "asset");
  assert.equal(adapters.calls().length, before, "no provider contacted");
  assert.equal(r.sampleM, 10);
  assert.equal(r.quality.greenDetail, "coarse");
  const ll = gridPixelLatLng(inside, 100, 75);
  assert.ok(Math.abs(r.heights[75 * 200 + 100] - groundAt(ll.lat, ll.lng)) < 0.3, "the asset carries the ground");
  const outside = { zoom: g.captureZoom, originPx: { x: g.originPx.x + g.width + 500, y: g.originPx.y }, width: 64, height: 64 };
  const o = await terrainForWindow({ grid: outside, asset }, { sources: staged(), adapters });
  assert.equal(o.from, "provider");
  assert.ok(o.tried.some(t => /course asset/.test(t)));
});

await test("the stored asset is what the export's hole crop already reads: terrain-RGB on the manifest grid", async () => {
  const baked = await bakeCourseTerrain({ courseId: "p", courseBounds: PORTRUSH }, { sources: staged(), adapters: fakeAdapters({}) });
  const { heightsPng, maskPng } = await encodeTerrainAsset(baked, { sharp, terrainRgbPngFromHeights });
  const g = baked.manifest.grid;
  const meta = await sharp(heightsPng).metadata();
  assert.deepEqual([meta.width, meta.height], [g.width, g.height]);
  assert.deepEqual([(await sharp(maskPng).metadata()).channels], [1]);
  /* One hole's box, cut the way runExportJob cuts it. */
  const hole = { south: 55.199, north: 55.203, west: -6.63, east: -6.62 };
  const crop = await cropByBounds(heightsPng, g.bounds, hole);
  const { data, info } = await sharp(crop.buffer).raw().toBuffer({ resolveWithObject: true });
  const d = decodeElevation(data, info.width, info.height, info.channels, "terrain-rgb");
  const cx = Math.floor(info.width / 2), cy = Math.floor(info.height / 2);
  const lat = crop.bounds.north + (crop.bounds.south - crop.bounds.north) * (cy + 0.5) / info.height;
  const lng = crop.bounds.west + (crop.bounds.east - crop.bounds.west) * (cx + 0.5) / info.width;
  assert.ok(Math.abs(d.heights[cy * info.width + cx] - groundAt(lat, lng)) < 0.5, "cropped heights are the ground under the hole");
});

/* ---------- staging round trip ------------------------------------------------------------------- */

await test("staging: OSNI-style sheets -> staged tiles -> a course bake reads only the tiles under it", async () => {
  /* Two 10m ASCII sheets in Irish Grid around Portrush, sharing an edge, heights from groundAt. */
  const n = projectBounds("EPSG:29902", padBoundsM(PORTRUSH, 600));
  const px = 10, x0 = Math.floor(n.minX / 1000) * 1000, y0 = Math.floor(n.minY / 1000) * 1000;
  const W = Math.ceil((n.maxX - x0) / px), H = Math.ceil((n.maxY - y0) / px);
  const sheet = (cx0, cols) => {
    const lines = ["ncols " + cols, "nrows " + H, "xllcorner " + cx0, "yllcorner " + y0, "cellsize " + px, "NODATA_value -9999"];
    for (let j = 0; j < H; j++) {
      const row = [];
      for (let i = 0; i < cols; i++) {
        const ll = toLngLat("EPSG:29902", cx0 + (i + 0.5) * px, y0 + (H - j - 0.5) * px);
        row.push(groundAt(ll.lat, ll.lng).toFixed(2));
      }
      lines.push(row.join(" "));
    }
    return lines.join("\n");
  };
  const half = Math.floor(W / 2);
  const tiles = new Map();
  const source = staged().find(s => s.id === "osni-ni-dtm10");
  addToTiles(tiles, parseElevationText(sheet(x0, half + 1)), { tileSizeM: 2000, pixelSize: 10 });
  addToTiles(tiles, parseElevationText(sheet(x0 + half * px, W - half)), { tileSizeM: 2000, pixelSize: 10 });
  const index = stagedIndex({ source, datasetVersion: "test-v1", tiles, tileSizeM: 2000, pixelSize: 10, files: ["a", "b"] });
  assert.ok(Object.keys(index.tiles).length >= 4);
  /* Serve the staged copy the way Supabase Storage would. */
  const files = new Map([["osni-ni-dtm10/test-v1/index.json", Buffer.from(JSON.stringify(index))]]);
  for (const t of tiles.values()) files.set("osni-ni-dtm10/test-v1/tiles/" + t.key + ".f32.gz", encodeStagedTile(t.heights));
  const asked = [];
  const fetchImpl = async url => {
    const key = String(url).replace("https://stub/terrain-sources/", "");
    asked.push(key);
    const body = files.get(key);
    if (!body) return { ok: false, status: 404, headers: { get: () => null } };
    return { ok: true, status: 200, headers: { get: () => "application/octet-stream" }, arrayBuffer: async () => body };
  };
  const out = await bakeCourseTerrain({ courseId: "portrush", courseBounds: PORTRUSH }, {
    sources: staged(), fetchImpl, sharp, stagedBaseUrl: "https://stub/terrain-sources"
  });
  const m = out.manifest;
  assert.equal(m.sources[0].id, "osni-ni-dtm10", m.log.join(" | "));
  assert.equal(m.coverage.core, 1);
  const tileReads = asked.filter(k => k.includes("/tiles/")).length;
  assert.ok(tileReads > 0 && tileReads <= Object.keys(index.tiles).length, "only tiles under the course: " + tileReads);
  const g = out.grid;
  const ll = gridPixelLatLng(g, Math.floor(g.width / 2), Math.floor(g.height / 2));
  assert.ok(Math.abs(out.heights[Math.floor(g.height / 2) * g.width + Math.floor(g.width / 2)] - groundAt(ll.lat, ll.lng)) < 0.3, "staged ground lands in place");
  /* A file in the wrong CRS is caught by its position, not trusted. */
  const wrong = toLngLat("EPSG:29902", 900000, 900000);
  assert.ok(!(wrong.lat > 54 && wrong.lat < 55.4 && wrong.lng > -8.2 && wrong.lng < -5.4));
});

/* ---------- network failure modes ---------------------------------------------------------------- */

await test("adapters: timeouts and rate limits retry with backoff, 404 is a gap, other 4xx fail fast", async () => {
  const waits = [];
  const config = Object.assign({}, TERRAIN_CONFIG, { http: Object.assign({}, TERRAIN_CONFIG.http, { retries: 2, retryBaseMs: 10 }) });
  let n = 0;
  const flaky = async () => {
    n++;
    if (n === 1) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
    if (n === 2) return { ok: false, status: 429, headers: { get: k => (k === "retry-after" ? "3" : null) } };
    return { ok: true, status: 200, headers: { get: () => "image/png" }, arrayBuffer: async () => Buffer.from([1, 2]) };
  };
  const got = await fetchWithRetry("https://x", { fetchImpl: flaky, config, sleepImpl: async ms => waits.push(ms) });
  assert.equal(got.buffer.length, 2);
  assert.deepEqual(waits, [10, 3000], "backoff, then the provider's Retry-After");
  const gone = await fetchWithRetry("https://x", { fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null } }), config, sleepImpl: async () => {} });
  assert.equal(gone.missing, true);
  let calls = 0;
  await assert.rejects(fetchWithRetry("https://x", { sourceId: "s", fetchImpl: async () => { calls++; return { ok: false, status: 403, headers: { get: () => null } }; }, config, sleepImpl: async () => {} }), e => e.code === "http");
  assert.equal(calls, 1, "a 403 (bad key) is not retried");
  await assert.rejects(fetchWithRetry("https://x", { sourceId: "s", fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => null } }), config, sleepImpl: async () => {} }), e => e.code === "rate-limited");
});

await test("adapters: a provider answering garbage is malformed, not terrain", async () => {
  const xyz = ADAPTERS.find(a => a.sourceType === "xyz-elevation");
  const source = Object.assign({}, TERRAIN_SOURCES.find(s => s.id === GLOBAL_TERRAIN_SOURCE_ID), { urlTemplate: "https://t/{z}/{x}/{y}.png" });
  /* A rendered hillshade picture: greys decoded as terrarium span thousands of metres. */
  const picture = await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: await sharp({ create: { width: 128, height: 256, channels: 3, background: { r: 200, g: 200, b: 200 } } }).png().toBuffer(), left: 0, top: 0 }]).png().toBuffer();
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => "image/png" }, arrayBuffer: async () => picture });
  await assert.rejects(xyz.fetchTerrain({ source, bounds: PORTRUSH, zoom: 13 }, { fetchImpl, sharp }), e => e.code === "malformed");
  const html = async () => ({ ok: true, status: 200, headers: { get: () => "text/html" }, arrayBuffer: async () => Buffer.from("<html>maintenance</html>") });
  await assert.rejects(xyz.fetchTerrain({ source, bounds: PORTRUSH, zoom: 13 }, { fetchImpl: html, sharp }), e => e.code === "malformed");
});

console.log("\nterrain-system: " + passed + " passed" + (failures.length ? ", " + failures.length + " FAILED: " + failures.join("; ") : ""));
process.exit(failures.length ? 1 : 0);
