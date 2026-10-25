/* The OPCD / GSPro export (functions/lib/gd-opcd-export-core.mjs + gd-opcd-export-job.mjs),
   no network, no Supabase.

     1 UTM projection against a known value, and the zone picker
     2 the job kind literal in course-visual-jobs.mjs agrees with the core
     3 frame planning: 2^n+1 samples, whole-metre origin, margin, clipping
     4 heightmap sampling reproduces a known plane, north row first, metre grid
     5 ground outside the asset is filled and counted, never NaN
     6 RAW16 encoding round-trips within a step, little-endian
     7 GeoTIFF round-trips origin, CRS and values through geotiff.js
     8 surfaces GeoJSON: kinds, dedupe of cloned surfaces, closed rings, routes, par
     9 trees CSV: frame metres, ground, measured vs estimated heights, outside-frame trees
    10 holes CSV
    11 the whole job on fakes: files, manifest, README, result

   Run: node dev/opcd-export.test.mjs */
import assert from "node:assert/strict";
import fs from "node:fs";
import sharp from "sharp";
import { fromArrayBuffer } from "geotiff";
import { fromLngLat, toLngLat, utmCrsFor, supportedCrs } from "../functions/lib/terrain/gd-terrain-crs.mjs";
import { lngLatToWorldPx, mercMetresPerPixel } from "../functions/lib/terrain/gd-terrain-adapters.mjs";
import { assetAsRaw } from "../functions/lib/terrain/gd-terrain-window.mjs";
import { terrainRgbPngFromHeights, decodeElevation } from "../functions/lib/gd-relief-core.mjs";
import { packTrees } from "../functions/lib/gd-course-trees-store.mjs";
import {
  OPCD_EXPORT_KIND, planOpcdFrame, toLocal, insideFrame, sampleHeightmap, heightStats, rawEncoding, encodeRaw16,
  heightmapGeoTiff, groundAt, surfacesGeoJson, treesCsv, holesCsv, parByHole, TREE_HEIGHT_PER_CROWN_RADIUS,
  assetCovers, windowGridFor, rawFromWindow
} from "../functions/lib/gd-opcd-export-core.mjs";
import { gridPixelLatLng } from "../functions/lib/terrain/gd-terrain-normalise.mjs";
import { runOpcdExport, canopySampler, loadCourseTrees } from "../functions/lib/gd-opcd-export-job.mjs";

const MERC_R = 6378137;
const mercator = (lat, lng) => ({ x: MERC_R * lng * Math.PI / 180, y: MERC_R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) });
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || "") + " expected " + b + " got " + a + " (tol " + tol + ")");

// ---- 1. UTM: zone 32N, 45N 9E sits on the central meridian: E = 500000, N = meridian arc x 0.9996
{
  const [e, n] = fromLngLat("EPSG:32632", 45, 9);
  near(e, 500000, 0.01, "UTM easting");
  near(n, 4982950.4, 0.5, "UTM northing");
  const back = toLngLat("EPSG:32610", ...fromLngLat("EPSG:32610", 36.5826, -121.9426));
  near(back.lat, 36.5826, 1e-9); near(back.lng, -121.9426, 1e-9);
  assert.equal(utmCrsFor(-45.02, 168.73), "EPSG:32759", "Queenstown is 59S");
  assert.equal(utmCrsFor(36.58, -121.94), "EPSG:32610", "Monterey is 10N");
  assert.equal(utmCrsFor(51.5, -0.1), "EPSG:32630");
  assert.ok(supportedCrs("EPSG:32759") && !supportedCrs("EPSG:32761") && !supportedCrs("EPSG:32800"));
  const [e2, n2] = fromLngLat("EPSG:32759", -45.02, 168.73);
  assert.ok(n2 > 4000000 && n2 < 5100000 && e2 > 300000 && e2 < 700000, "southern hemisphere false northing applied");
  console.log("1. UTM projection exact on the known point; zones pick correctly");
}

// ---- 2. kind parity
{
  const src = fs.readFileSync(new URL("../functions/course-visual-jobs.mjs", import.meta.url), "utf8");
  assert.ok(src.includes('const OPCD_EXPORT_KIND = "' + OPCD_EXPORT_KIND + '"'), "course-visual-jobs.mjs must carry the same kind literal");
  assert.ok(src.includes("sideJobKind(job"), "and filter it out of the player build state");
  console.log("2. job kind literal agrees:", OPCD_EXPORT_KIND);
}

// ---- 3. frame planning
const course = { north: -45.015, south: -45.027, west: 168.725, east: 168.741 };   // ~1.3 km x 1.3 km
{
  const f = planOpcdFrame(course);
  assert.equal(f.crs, "EPSG:32759");
  assert.equal(f.samples, 2049, "1.3 km + 2x100 m margin wants the 2048 m square");
  assert.equal(f.sideM, 2048);
  assert.ok(Number.isInteger(f.originE) && Number.isInteger(f.originN), "whole-metre origin");
  for (const [lat, lng] of [[course.south, course.west], [course.north, course.east], [course.south, course.east], [course.north, course.west]]) {
    const l = toLocal(f, lat, lng);
    assert.ok(l.x >= f.marginM - 1 && l.z >= f.marginM - 1 && l.x <= f.sideM - f.marginM + 1 && l.z <= f.sideM - f.marginM + 1, "course corner inside the margin: " + JSON.stringify(l));
  }
  assert.ok(!f.clipped);
  assert.ok(f.bounds.north > course.north && f.bounds.south < course.south && f.bounds.east > course.east && f.bounds.west < course.west);
  const small = planOpcdFrame({ north: -45.018, south: -45.022, west: 168.730, east: 168.735 });
  assert.equal(small.samples, 1025);
  const big = planOpcdFrame({ north: -45.00, south: -45.034, west: 168.70, east: 168.75 });   // ~3.8 km
  assert.equal(big.samples, 4097);
  const huge = planOpcdFrame({ north: -45.00, south: -45.05, west: 168.70, east: 168.77 });   // ~5.5 km
  assert.equal(huge.samples, 4097);
  assert.ok(huge.clipped, "a course wider than 4096 m is reported clipped");
  const tiny = planOpcdFrame(course, { sides: [129, 257], marginM: 10 });
  assert.equal(tiny.samples, 257, "custom sides are honoured (and the largest is used when none fits)");
  console.log("3. frame:", f.samples + "² at 1 m, origin E" + f.originE + " N" + f.originN);
}

/* A synthetic baked asset over `bounds`: web-mercator grid at `zoom`, heights a plane in
   mercator metres so every sample's true value is known. */
function syntheticAsset(bounds, zoom, plane, padPx = 40) {
  const nw = lngLatToWorldPx(bounds.north, bounds.west, zoom), se = lngLatToWorldPx(bounds.south, bounds.east, zoom);
  const originPx = { x: Math.floor(nw.x) - padPx, y: Math.floor(nw.y) - padPx };
  const width = Math.ceil(se.x) - originPx.x + padPx, height = Math.ceil(se.y) - originPx.y + padPx;
  const mpp = mercMetresPerPixel(zoom);
  const heights = new Float32Array(width * height);
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) {
    const X = (originPx.x + i + 0.5) * mpp - 20037508.342789244, Y = 20037508.342789244 - (originPx.y + j + 0.5) * mpp;
    heights[j * width + i] = plane(X, Y);
  }
  const lat = (bounds.north + bounds.south) / 2;
  const manifest = {
    terrainVersion: 3, formatVersion: 1, sourceIds: ["linz-nz-elevation"], sourceResolutionM: 1, verticalDatum: "NZVD2016",
    quality: { class: "lidar", confidence: 0.9, greenDetail: "allowed" },
    sources: [{ id: "linz-nz-elevation", name: "LINZ", attribution: { text: "Sourced from LINZ, CC BY 4.0" } }],
    grid: { projection: "EPSG:3857", encoding: "terrain-rgb", captureZoom: zoom, originPx, width, height, metresPerPixel: mpp * Math.cos(lat * Math.PI / 180), bounds },
    files: { heights: "test-course/terrain/v3/heights.png" }
  };
  return { manifest, heights, plane };
}

// ---- 4. sampling reproduces the plane, north row first
const frame = planOpcdFrame(course, { sides: [257], marginM: 10 });
const X0 = mercator(course.south, course.west).x, Y0 = mercator(course.south, course.west).y;
const plane = (X, Y) => 120 + 0.004 * (X - X0) + 0.009 * (Y - Y0);
const asset = syntheticAsset(frame.bounds, 17, plane);
{
  const sampled = sampleHeightmap(frame, assetAsRaw(asset.manifest, asset.heights));
  assert.equal(sampled.outsideAssetFraction, 0, "asset covers the frame");
  const S = frame.samples;
  const at = (i, j) => sampled.heights[j * S + i];
  for (const [i, j] of [[0, 0], [S - 1, 0], [0, S - 1], [S - 1, S - 1], [100, 37], [200, 230], [128, 128]]) {
    const ll = toLngLat(frame.crs, frame.originE + i, frame.originN + frame.sideM - j);
    const m = mercator(ll.lat, ll.lng);
    near(at(i, j), plane(m.x, m.y), 0.02, "sample " + i + "," + j);
  }
  assert.ok(at(50, 0) > at(50, S - 1), "row 0 is the NORTH edge (the plane rises northward)");
  assert.ok(at(S - 1, 50) > at(0, 50), "column S-1 is the EAST edge");
  near(groundAt(frame, sampled.heights, 100, frame.sideM - 37), at(100, 37), 1e-6, "groundAt reads the sample at local metres");
  assert.equal(groundAt(frame, sampled.heights, -1, 5), null);
  console.log("4. heightmap matches the plane at the corners and inside; north-first, east-right");
}

// ---- 5. outside the asset: filled, counted
{
  /* An asset that stops well inside the (256 m) frame: the frame's own bounds pulled in by
     30% on every side. */
  const fb = frame.bounds, dLat = (fb.north - fb.south) * 0.3, dLng = (fb.east - fb.west) * 0.3;
  const narrow = { north: fb.north - dLat, south: fb.south + dLat, west: fb.west + dLng, east: fb.east - dLng };
  const smallAsset = syntheticAsset(narrow, 17, plane, 2);
  const sampled = sampleHeightmap(frame, assetAsRaw(smallAsset.manifest, smallAsset.heights));
  assert.ok(sampled.outsideAssetFraction > 0.2 && sampled.outsideAssetFraction < 0.95, "a good part of the frame is outside: " + sampled.outsideAssetFraction);
  assert.ok(sampled.filledFraction > 0);
  for (let i = 0; i < sampled.heights.length; i += 97) assert.ok(Number.isFinite(sampled.heights[i]), "no NaN survives");
  assert.equal(sampled.fallbackFraction, 0);
  assert.ok(!assetCovers(smallAsset.manifest, frame.bounds) && assetCovers(asset.manifest, frame.bounds));
  /* With the frame's window read from a provider, the ring comes from it instead of a fill. */
  const grid = windowGridFor(frame, { zoom: 17 });
  assert.ok(grid.width <= 3072 && grid.height <= 3072 && grid.zoom === 17);
  const nwBounds = gridPixelLatLng(grid, -0.5, -0.5), seBounds = gridPixelLatLng(grid, grid.width - 0.5, grid.height - 0.5);
  assert.ok(nwBounds.lat > frame.bounds.north && nwBounds.lng < frame.bounds.west && seBounds.lat < frame.bounds.south && seBounds.lng > frame.bounds.east, "window surrounds the frame");
  const winHeights = new Float32Array(grid.width * grid.height);
  for (let j = 0; j < grid.height; j++) for (let i = 0; i < grid.width; i++) {
    const ll = gridPixelLatLng(grid, i, j), m = mercator(ll.lat, ll.lng);
    winHeights[j * grid.width + i] = plane(m.x, m.y);
  }
  const withFallback = sampleHeightmap(frame, assetAsRaw(smallAsset.manifest, smallAsset.heights), { fallback: rawFromWindow(grid, winHeights) });
  assert.equal(withFallback.filledFraction, 0, "nothing left to invent");
  near(withFallback.fallbackFraction, withFallback.outsideAssetFraction, 1e-9, "every missing sample came from the window");
  const S = frame.samples;
  for (const [i, j] of [[0, 0], [S - 1, S - 1], [3, 200]]) {
    const ll = toLngLat(frame.crs, frame.originE + i, frame.originN + frame.sideM - j), m = mercator(ll.lat, ll.lng);
    near(withFallback.heights[j * S + i], plane(m.x, m.y), 0.02, "fallback sample " + i + "," + j);
  }
  const big = planOpcdFrame({ north: -45.00, south: -45.034, west: 168.70, east: 168.75 });
  const bigGrid = windowGridFor(big, { zoom: 17 });
  assert.ok(bigGrid.zoom < 17 && bigGrid.width <= 3072, "a 4096 m frame steps the window coarser rather than past maxSidePx: z" + bigGrid.zoom + " " + bigGrid.width + "px");
  console.log("5. outside-asset fraction", sampled.outsideAssetFraction.toFixed(3), "filled when alone, read from the window when one is given");
}

// ---- 6. RAW16
const sampled = sampleHeightmap(frame, assetAsRaw(asset.manifest, asset.heights));
const stats = heightStats(sampled.heights);
const encoding = rawEncoding(stats);
{
  assert.ok(encoding.baseElevationM < stats.min && encoding.baseElevationM + encoding.heightRangeM > stats.max, "headroom both ends");
  assert.ok(Number.isInteger(encoding.baseElevationM) && Number.isInteger(encoding.heightRangeM));
  const raw = encodeRaw16(sampled.heights, encoding);
  assert.equal(raw.length, frame.samples * frame.samples * 2);
  for (const k of [0, 1234, 40000, sampled.heights.length - 1]) {
    const v = raw.readUInt16LE(k * 2);
    near(encoding.baseElevationM + v * encoding.heightRangeM / 65535, sampled.heights[k], encoding.stepM, "raw sample " + k);
  }
  assert.equal(raw[0] | (raw[1] << 8), raw.readUInt16LE(0), "little-endian");
  console.log("6. RAW16 base", encoding.baseElevationM, "range", encoding.heightRangeM, "step", encoding.stepM.toFixed(5), "m");
}

// ---- 7. GeoTIFF
{
  const tif = await heightmapGeoTiff(frame, sampled.heights);
  const image = await (await fromArrayBuffer(tif.buffer.slice(tif.byteOffset, tif.byteOffset + tif.byteLength))).getImage();
  assert.equal(image.getWidth(), frame.samples);
  const [ox, oy] = image.getOrigin();
  near(ox, frame.originE - 0.5, 1e-6, "tiepoint west edge"); near(oy, frame.originN + frame.sideM + 0.5, 1e-6, "tiepoint north edge");
  assert.equal(image.getGeoKeys().ProjectedCSTypeGeoKey, frame.epsg);
  const [, resY] = image.getResolution();
  near(Math.abs(resY), 1, 1e-9);
  const values = (await image.readRasters())[0];
  near(values[5 * frame.samples + 7], sampled.heights[5 * frame.samples + 7], 1e-6, "pixel value");
  console.log("7. GeoTIFF: " + frame.epsg + ", origin", ox, oy, tif.length, "bytes");
}

// ---- 8. surfaces
const tee1 = { lat: -45.0255, lng: 168.728 }, green1 = { lat: -45.0215, lng: 168.733 };
const tee2 = { lat: -45.0210, lng: 168.7335 }, green2 = { lat: -45.0175, lng: 168.738 };
const greenRing = c => [0, 60, 120, 180, 240, 300].map(a => ({ lat: c.lat + 0.00012 * Math.cos(a * Math.PI / 180), lng: c.lng + 0.00017 * Math.sin(a * Math.PI / 180) }));
const quad = (c, d) => [{ lat: c.lat - d, lng: c.lng - d }, { lat: c.lat - d, lng: c.lng + d }, { lat: c.lat + d, lng: c.lng + d }, { lat: c.lat + d, lng: c.lng - d }];
const sharedBunker = quad({ lat: -45.0225, lng: 168.7315 }, 0.00005);
const pkg = {
  courseId: "test-course", courseName: "Test Course", holes: {},
  objects: {
    t1: { type: "tee", holeNumber: 1, position: tee1, source: "osm_auto_tee" },
    g1: { type: "green", holeNumber: 1, position: green1, greenCenter: green1, greenShape: greenRing(green1), greenSource: "osm_auto_green_polygon" },
    f1: { type: "fairway", holeNumber: 1, position: { lat: -45.0235, lng: 168.7305 } },
    t2: { type: "tee", holeNumber: 2, position: tee2 },
    g2: { type: "green", holeNumber: 2, position: green2, shape: greenRing(green2) },
    fa1: { type: "fairway_area", holeNumber: 1, shape: quad({ lat: -45.0235, lng: 168.7305 }, 0.0006), osmId: "way/1" },
    b1a: { type: "bunker", holeNumber: 1, shape: sharedBunker, osmId: "way/2" },
    b1b: { type: "bunker", holeNumber: 2, shape: sharedBunker.map(p => ({ lat: p.lat, lng: p.lng })), osmId: "way/2" },
    w1: { type: "water", holeNumber: 2, shape: quad({ lat: -45.019, lng: 168.736 }, 0.0002), hazardClass: "penalty" },
    tr1: { type: "trees", holeNumber: 1, shape: quad({ lat: -45.024, lng: 168.734 }, 0.0003) },
    junk: { type: "bunker", holeNumber: 1, shape: [{ lat: 1, lng: 2 }] },
    nohole: { type: "green", position: { lat: -45.02, lng: 168.73 } }
  }
};
const par = parByHole([{ holeNumber: 1, par: 4 }, { hole: 2, par: 3 }, { holeNumber: 3, par: 9 }]);
{
  assert.equal(par.get(1), 4); assert.equal(par.get(2), 3); assert.equal(par.get(3), undefined, "par 9 is not a par");
  const gj = surfacesGeoJson(pkg, frame, { par });
  assert.equal(gj.type, "FeatureCollection");
  const kinds = {};
  gj.features.forEach(f => { kinds[f.properties.kind] = (kinds[f.properties.kind] || 0) + 1; });
  assert.deepEqual(kinds, { terrain_frame: 1, fairway: 1, bunker: 1, water: 1, woods: 1, green: 2, green_centre: 3, tee: 2, hole_route: 2 }, JSON.stringify(kinds));
  assert.equal(gj.features[0].properties.kind, "terrain_frame");
  gj.features.filter(f => f.geometry.type === "Polygon").forEach(f => {
    const r = f.geometry.coordinates[0];
    assert.deepEqual(r[0], r[r.length - 1], "ring closed");
    assert.ok(r.length >= 4);
    r.forEach(([lng, lat]) => assert.ok(Math.abs(lng) <= 180 && Math.abs(lat) <= 90, "GeoJSON is [lng, lat]"));
  });
  const water = gj.features.find(f => f.properties.kind === "water");
  assert.equal(water.properties.hazard_class, "penalty");
  const bunker = gj.features.find(f => f.properties.kind === "bunker");
  assert.equal(bunker.properties.hole, 1, "the clone's first hole");
  const route1 = gj.features.find(f => f.properties.kind === "hole_route" && f.properties.hole === 1);
  assert.equal(route1.geometry.coordinates.length, 3, "tee, fairway point, green");
  assert.equal(route1.properties.par, 4);
  const teePt = gj.features.find(f => f.properties.kind === "tee" && f.properties.hole === 1);
  const l = toLocal(frame, tee1.lat, tee1.lng);
  near(teePt.properties.x_m, l.x, 0.01); near(teePt.properties.z_m, l.z, 0.01);
  const fr = gj.features[0].geometry.coordinates[0];
  const frameW = Math.min(...fr.map(c => c[0])), frameE = Math.max(...fr.map(c => c[0]));
  near(frameW, frame.bounds.west, 1e-6, "terrain frame polygon is the frame"); near(frameE, frame.bounds.east, 1e-6);
  console.log("8. surfaces:", gj.features.length, "features", JSON.stringify(kinds));
}

/* Tests 9-10 need a frame that actually holds the tees, greens and trees: the 1024 m one. */
const wide = planOpcdFrame(course, { sides: [1025], marginM: 10 });
const wideAsset = syntheticAsset(wide.bounds, 17, plane);
const sampledWide = sampleHeightmap(wide, assetAsRaw(wideAsset.manifest, wideAsset.heights)).heights;

// ---- 9. trees
{
  const trees = [
    { lat: -45.0230, lng: 168.7320, r: 3.5, source: "studio" },
    { lat: -45.0220, lng: 168.7350, r: 2.0, source: "finder", level: 1 },
    { lat: -44.9, lng: 168.6, r: 4.0, source: "finder", level: 2 }   // far outside the frame
  ];
  const canopyAt = (lat, lng) => (Math.abs(lat - trees[0].lat) < 1e-6 ? 14 : null);
  const out = treesCsv(trees, wide, sampledWide, { canopyAt });
  const lines = out.csv.trim().split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "id,source,lat,lng,easting,northing,x_m,z_m,ground_m,crown_radius_m,height_m,height_source,level");
  const row1 = lines[1].split(","), row2 = lines[2].split(","), row3 = lines[3].split(",");
  assert.equal(row1.length, 13);
  const l1 = toLocal(wide, trees[0].lat, trees[0].lng);
  near(Number(row1[6]), l1.x, 0.01); near(Number(row1[7]), l1.z, 0.01);
  near(Number(row1[8]), groundAt(wide, sampledWide, l1.x, l1.z), 0.01, "ground from the heightmap");
  assert.equal(row1[10], "14"); assert.equal(row1[11], "canopy");
  assert.equal(row2[10], String(Math.round(2.0 * TREE_HEIGHT_PER_CROWN_RADIUS * 10) / 10)); assert.equal(row2[11], "estimated"); assert.equal(row2[12], "1");
  assert.equal(row3[6], ""); assert.equal(row3[7], ""); assert.equal(row3[8], "", "outside the frame: no local coordinates, no ground");
  assert.ok(row3[4] !== "" && row3[5] !== "", "but still its UTM position");
  assert.deepEqual([out.count, out.inside, out.measured], [3, 2, 1]);
  const sampler = canopySampler([{ crs: "EPSG:4326", x0: 168.70, y0: -45.00, dx: 0.001, dy: -0.001, width: 50, height: 50, heights: new Uint8Array(2500).fill(9) }]);
  assert.equal(sampler(-45.02, 168.73), 9);
  assert.equal(sampler(-46, 168.73), null);
  console.log("9. trees CSV:", out.count, "trees,", out.inside, "in frame,", out.measured, "measured");
}

// ---- 10. holes
{
  const out = holesCsv(pkg, wide, sampledWide, { par });
  const lines = out.csv.trim().split("\n");
  assert.equal(out.count, 2);
  assert.equal(lines[0].split(",").length, 13);
  const h1 = lines[1].split(",");
  assert.equal(h1[0], "1"); assert.equal(h1[1], "4");
  assert.ok(Number(h1[2]) > 500 && Number(h1[2]) < 700, "hole 1 length via the fairway point: " + h1[2]);
  assert.ok(Number(h1[7]) > 100 && Number(h1[12]) > 100, "tee and green ground heights");
  console.log("10. holes CSV:", out.count, "holes");
}

// ---- 11. the job on fakes
{
  /* A bake covers the course plus its margin, so this asset does too (the 256 m test asset
     above would leave most of the real 2048 m frame unfilled). */
  const jobAsset = syntheticAsset({ north: course.north + 0.0045, south: course.south - 0.0045, west: course.west - 0.0065, east: course.east + 0.0065 }, 17, plane);
  const png = await terrainRgbPngFromHeights(jobAsset.heights, jobAsset.manifest.grid.width, jobAsset.manifest.grid.height);
  const uploads = new Map();
  const beats = [];
  const treeRow = { trees: packTrees([{ lat: -45.0230, lng: 168.7320, r: 2.6, l: 1, h: 0 }, { lat: -45.0222, lng: 168.7352, r: 2.1, l: 5, h: 1 }]), level: 2 };
  const overlayTree = { kind: "tree", points: quad({ lat: -45.0218, lng: 168.7340 }, 0.00003) };
  const deps = {
    supabaseFetch: async q => q.startsWith("course_trees") ? [treeRow] : q.startsWith("course_map_overlays") ? [{ features: [overlayTree, { kind: "bunker", points: [] }] }] : [],
    loadTerrain: async () => jobAsset.manifest,
    download: async path => { assert.equal(path, jobAsset.manifest.files.heights); return png; },
    decodeTerrainPng: async buffer => {
      const raw = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
      const d = decodeElevation(raw.data, raw.info.width, raw.info.height, raw.info.channels, "terrain-rgb");
      return { heights: d.heights, width: raw.info.width, height: raw.info.height };
    },
    upload: async (path, buffer, contentType) => { uploads.set(path, { buffer, contentType }); },
    encodePreviewPng: (grey, w, h) => sharp(grey, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer(),
    readWindow: async () => { throw new Error("the asset covers the frame - no window read expected"); },
    readCanopy: async () => ({ grids: [{ crs: "EPSG:4326", x0: 168.70, y0: -45.00, dx: 0.001, dy: -0.001, width: 50, height: 50, heights: new Uint8Array(2500).fill(11) }] }),
    loadScorecardHoles: async () => [{ holeNumber: 1, par: 4 }, { holeNumber: 2, par: 3 }],
    heartbeat: async stage => { beats.push(stage); },
    now: () => new Date("2026-10-25T03:04:05Z")
  };
  const trees = await loadCourseTrees("test-course", deps.supabaseFetch);
  assert.equal(trees.length, 2, "studio tree + the finder tree at or under the live level (level 5 stays out)");
  assert.equal(trees[0].source, "studio");
  const result = await runOpcdExport({ courseId: "test-course", pkg }, deps);
  assert.equal(result.version, "20261025-030405Z");
  assert.equal(result.root, "test-course/opcd/20261025-030405Z");
  const names = result.files.map(f => f.name).sort();
  assert.deepEqual(names, ["README.md", "heightmap-preview.png", "heightmap.raw", "heightmap.tif", "holes.csv", "manifest.json", "surfaces.geojson", "trees.csv"]);
  assert.deepEqual(beats, ["terrain", "heightmap", "trees", "surfaces", "writing"]);
  const S = result.frame.samples;
  assert.equal(S, 2049, "the real frame for this course");
  assert.equal(uploads.get(result.root + "/heightmap.raw").buffer.length, S * S * 2);
  const manifest = JSON.parse(uploads.get(result.root + "/manifest.json").buffer.toString("utf8"));
  assert.equal(manifest.courseId, "test-course");
  assert.equal(manifest.heightmap.unityImportRaw.flipVertically, true);
  assert.equal(manifest.heightmap.unityImportRaw.resolution, S);
  assert.equal(manifest.heightmap.unityImportRaw.height, manifest.heightmap.heightRangeM);
  assert.equal(manifest.terrain.terrainVersion, 3);
  assert.deepEqual(manifest.terrain.attribution, ["Sourced from LINZ, CC BY 4.0"]);
  assert.equal(manifest.trees.count, 2); assert.equal(manifest.trees.measured, 2, "canopy answered both");
  assert.equal(manifest.holes.parKnown, 2);
  assert.ok(manifest.files.some(f => f.name === "README.md"));
  const readme = uploads.get(result.root + "/README.md").buffer.toString("utf8");
  assert.ok(readme.includes("Flip Vertically: ON") && readme.includes("EPSG:32759") && readme.includes("Sourced from LINZ"), readme.slice(0, 400));
  const gj = JSON.parse(uploads.get(result.root + "/surfaces.geojson").buffer.toString("utf8"));
  assert.ok(gj.features.length > 8);
  assert.equal(uploads.get(result.root + "/surfaces.geojson").contentType, "application/geo+json");
  const preview = await sharp(uploads.get(result.root + "/heightmap-preview.png").buffer).metadata();
  assert.equal(preview.width, S);
  /* The asset's decoded heights carry terrain-RGB's 0.1 m quantisation, so the exported
     ground sits within that of the plane. */
  const tif = uploads.get(result.root + "/heightmap.tif").buffer;
  const image = await (await fromArrayBuffer(tif.buffer.slice(tif.byteOffset, tif.byteOffset + tif.byteLength))).getImage();
  const values = (await image.readRasters())[0];
  const ll = toLngLat(result.frame.crs, result.frame.originEasting + 1000, result.frame.originNorthing + result.frame.sideM - 1000);
  const m = mercator(ll.lat, ll.lng);
  near(values[1000 * S + 1000], plane(m.x, m.y), 0.12, "exported ground vs the plane through the real decode");
  assert.ok(result.warnings.every(w => !/outside the terrain asset/.test(w)), "no coverage warning: " + JSON.stringify(result.warnings));
  console.log("11. job wrote", result.files.length, "files;", (result.files.reduce((n, f) => n + f.bytes, 0) / 1048576).toFixed(1), "MB; warnings:", result.warnings.length);
}

// ---- 12. the job when the asset stops short of the frame: the window read fills the ring
{
  const shortAsset = syntheticAsset({ north: course.north + 0.001, south: course.south - 0.001, west: course.west - 0.0015, east: course.east + 0.0015 }, 17, plane, 2);
  const png = await terrainRgbPngFromHeights(shortAsset.heights, shortAsset.manifest.grid.width, shortAsset.manifest.grid.height);
  const uploads = new Map();
  let windowCalls = 0;
  const deps = {
    supabaseFetch: async () => [],
    loadTerrain: async () => shortAsset.manifest,
    download: async () => png,
    decodeTerrainPng: async buffer => {
      const raw = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
      const d = decodeElevation(raw.data, raw.info.width, raw.info.height, raw.info.channels, "terrain-rgb");
      return { heights: d.heights, width: raw.info.width, height: raw.info.height };
    },
    upload: async (path, buffer) => { uploads.set(path, buffer); },
    readWindow: async (grid, asset) => {
      windowCalls++;
      assert.ok(asset && asset.manifest && asset.heights, "the asset is offered to the window reader first");
      const heights = new Float32Array(grid.width * grid.height);
      for (let j = 0; j < grid.height; j++) for (let i = 0; i < grid.width; i++) {
        const ll = gridPixelLatLng(grid, i, j), m = mercator(ll.lat, ll.lng);
        heights[j * grid.width + i] = plane(m.x, m.y);
      }
      return { heights, from: "provider", source: { id: "linz-nz-elevation" }, tried: [] };
    },
    now: () => new Date("2026-10-25T04:00:00Z")
  };
  const result = await runOpcdExport({ courseId: "test-course", pkg }, deps);
  assert.equal(windowCalls, 1);
  assert.ok(result.heightmap.outsideAssetFraction > 0.1, "a real ring lay outside: " + result.heightmap.outsideAssetFraction);
  assert.equal(result.heightmap.filledFraction, 0, "and none of it was invented");
  near(result.heightmap.fallbackFraction, result.heightmap.outsideAssetFraction, 1e-9);
  assert.ok(/linz-nz-elevation \(provider, z17\)/.test(result.heightmap.groundBeyondAsset), result.heightmap.groundBeyondAsset);
  assert.ok(result.warnings.every(w => !/nearest-filled/.test(w)), JSON.stringify(result.warnings));
  const readme = uploads.get(result.root + "/README.md").toString("utf8");
  assert.ok(readme.includes("read for this export from linz-nz-elevation"), "README names where the ring came from");
  const S = result.frame.samples;
  const raw16 = uploads.get(result.root + "/heightmap.raw");
  const enc = result.heightmap;
  const corner = enc.baseElevationM + raw16.readUInt16LE(0) * enc.heightRangeM / 65535;
  const ll = toLngLat(result.frame.crs, result.frame.originEasting, result.frame.originNorthing + result.frame.sideM), m = mercator(ll.lat, ll.lng);
  near(corner, plane(m.x, m.y), 0.15, "the north-west corner (outside the asset) carries real ground");
  console.log("12. asset short of the frame: window read once, ring", (result.heightmap.fallbackFraction * 100).toFixed(1) + "% from the provider, nothing filled");
}

console.log("opcd-export: all checks passed");
