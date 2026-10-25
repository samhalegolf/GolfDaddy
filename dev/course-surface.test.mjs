/*
 * The course map's core (functions/lib/gd-course-surface-core.mjs): the outline Studio draws
 * round the course, the ground the course map covers, and its elevation resampled onto the
 * picture's grid.
 *
 *   - an outline is stored clean: closing point dropped, repeats dropped, rounded; a ring that
 *     is too small, crosses itself, is too long or holds a non-coordinate is refused
 *   - with an outline the surface is the outline's box plus a margin, kept to the shot ground;
 *     without one it is the backdrop
 *   - the backdrop is never one of the composited captures, and a capture off the surface is
 *     not read
 *   - the version moves with the outline and nothing else it is not given
 *   - heights resampled onto the same window come back unchanged, onto half of it the right
 *     half, and the elevation grid keeps the picture's aspect at the terrain's spacing
 *   - the job kind matches the literal course-visual-jobs.mjs carries
 *   - drawn for real (sharp): framed on an extent the picture covers that ground at an
 *     integer zoom with the corridor where it is and the backdrop round it, the backdrop alone
 *     is enough, and a terrain-RGB plane cut and resampled onto the picture's grid reads back
 *     the plane's own heights
 *
 * Run: node dev/course-surface.test.mjs
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import { renderHoleSurfaceMercator } from "../functions/lib/gd-visual-export-core.mjs";
import { cropByBounds, decodeElevation, terrainRgbPngFromHeights } from "../functions/lib/gd-relief-core.mjs";
import {
  COURSE_SURFACE_KIND, COURSE_SURFACE_MARGIN_M, BOUNDARY_MAX_POINTS, COURSE_ELEVATION_MAX_PX,
  normaliseBoundary, ringAreaM2, ringSelfIntersects, ringBounds, boundaryHash, surfaceExtent, surfaceCaptures,
  surfaceVersion, elevationGrid, resampleHeights, heightRange, intersectBounds, courseSurfaceRecord, surfaceHoles
} from "../functions/lib/gd-course-surface-core.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/* A square about 500 m a side near Auckland. */
const LAT = -36.9, LNG = 174.8, D = 0.0045;
const square = [
  { lat: LAT, lng: LNG }, { lat: LAT, lng: LNG + D * 1.25 }, { lat: LAT + D, lng: LNG + D * 1.25 }, { lat: LAT + D, lng: LNG }
];

/* ---- the outline ---- */

{
  const area = ringAreaM2(square);
  assert.ok(area > 240000 && area < 260000, "a ~500 m square: " + area);
  const closed = square.concat([square[0]]);
  const doubled = [square[0], square[0], square[1], square[2], square[3]];
  const fromRing = normaliseBoundary({ ring: closed });
  assert.strictEqual(fromRing.ring.length, 4, "the closing point is dropped");
  assert.strictEqual(normaliseBoundary(doubled).ring.length, 4, "a point repeated straight after itself is dropped");
  assert.strictEqual(fromRing.areaM2, Math.round(area));
  const rounded = normaliseBoundary([{ lat: LAT + 1e-9, lng: LNG }, square[1], square[2], square[3]]);
  assert.strictEqual(rounded.ring[0].lat, LAT, "kept to 7 places");
  assert.ok(normaliseBoundary([{ latitude: LAT, longitude: LNG }, square[1], square[2], square[3]]), "latitude/longitude spellings read");

  assert.throws(() => normaliseBoundary(square.slice(0, 2)), /at least 3/);
  assert.throws(() => normaliseBoundary([square[0], { lat: LAT + 0.0001, lng: LNG }, { lat: LAT, lng: LNG + 0.0001 }]), /too small/);
  const bowtie = [square[0], square[2], square[1], square[3]];
  assert.ok(ringSelfIntersects(bowtie), "a figure-of-eight crosses itself");
  assert.ok(!ringSelfIntersects(square), "a square does not");
  assert.throws(() => normaliseBoundary(bowtie), /crosses itself/);
  assert.throws(() => normaliseBoundary([square[0], { lat: "x", lng: 1 }, square[1], square[2]]), /point 2/);
  assert.throws(() => normaliseBoundary("nope"), /list of points/);
  const many = [];
  for (let i = 0; i <= BOUNDARY_MAX_POINTS; i++) {
    const a = i / (BOUNDARY_MAX_POINTS + 1) * Math.PI * 2;
    many.push({ lat: LAT + Math.sin(a) * D, lng: LNG + Math.cos(a) * D });
  }
  assert.throws(() => normaliseBoundary(many), /at most/);
  assert.strictEqual(normaliseBoundary(many.slice(0, BOUNDARY_MAX_POINTS)).ring.length, BOUNDARY_MAX_POINTS);

  assert.strictEqual(boundaryHash(square), boundaryHash(square.map(p => Object.assign({}, p))), "same ring, same hash");
  assert.notStrictEqual(boundaryHash(square), boundaryHash(square.slice(1).concat(square[0]).concat([{ lat: LAT + D / 2, lng: LNG - D / 4 }])));
  assert.strictEqual(boundaryHash([]), "");
}

/* ---- the surface's ground ---- */

{
  const backdrop = { south: LAT - D, north: LAT + 2 * D, west: LNG - D, east: LNG + 3 * D };
  assert.deepStrictEqual(surfaceExtent({ backdropBounds: backdrop }), backdrop, "no outline: the backdrop");
  const caps = [{ south: LAT, north: LAT + D, west: LNG, east: LNG + D }, { south: LAT + D, north: LAT + 2 * D, west: LNG, east: LNG + 2 * D }];
  assert.deepStrictEqual(surfaceExtent({ captureBounds: caps }), { south: LAT, north: LAT + 2 * D, west: LNG, east: LNG + 2 * D }, "no backdrop: every capture together");
  assert.strictEqual(surfaceExtent({}), null);

  const boundary = normaliseBoundary(square);
  const cut = surfaceExtent({ boundary, backdropBounds: backdrop });
  const box = ringBounds(boundary.ring);
  const marginLat = COURSE_SURFACE_MARGIN_M / 111320;
  assert.ok(Math.abs((box.south - cut.south) - marginLat) < 1e-9 && Math.abs((cut.north - box.north) - marginLat) < 1e-9, "the outline's box plus the margin");
  assert.ok(cut.west < box.west && cut.east > box.east);
  const tight = { south: LAT + D * 0.1, north: LAT + D * 0.9, west: LNG - D, east: LNG + 3 * D };
  const kept = surfaceExtent({ boundary, backdropBounds: tight });
  assert.strictEqual(kept.south, tight.south, "kept to the ground that was shot");
  assert.strictEqual(kept.north, tight.north);
  const elsewhere = { south: LAT + 1, north: LAT + 1.01, west: LNG, east: LNG + 0.01 };
  assert.ok(surfaceExtent({ boundary, backdropBounds: elsewhere }).south < box.south, "no overlap: the outline's own box");

  assert.strictEqual(intersectBounds(backdrop, elsewhere), null);
  const entries = [
    { role: "course-backdrop", bounds: backdrop },
    { role: "play-corridor", holeNumber: 1, bounds: caps[0] },
    { role: "green-surround", holeNumber: 1, bounds: caps[1] },
    { role: "play-corridor", holeNumber: 2, bounds: elsewhere },
    { role: "play-corridor", holeNumber: 0, bounds: caps[0] },
    { role: "play-corridor", holeNumber: 3 }
  ];
  const used = surfaceCaptures(entries, cut);
  assert.deepStrictEqual(used.map(e => e.role + e.holeNumber), ["play-corridor1", "green-surround1"], "hole captures on the surface only, never the backdrop");

  const v1 = surfaceVersion({ snapshot: "a", boundary: boundaryHash(square) });
  assert.strictEqual(v1, surfaceVersion({ snapshot: "a", boundary: boundaryHash(square) }));
  assert.notStrictEqual(v1, surfaceVersion({ snapshot: "a", boundary: "" }), "a new outline is a new version");
  assert.notStrictEqual(v1, surfaceVersion({ snapshot: "b", boundary: boundaryHash(square) }), "new captures are a new version");
  assert.ok(/^s[a-z0-9]+$/.test(v1), "the sweep's version pattern");
}

/* ---- the elevation ---- */

{
  /* A plane rising east: heights = column index, so a resample is checkable by eye. */
  const sw = 40, sh = 20, src = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) src[y * sw + x] = x * 2 + 100;
  const bounds = { south: LAT, north: LAT + D, west: LNG, east: LNG + 2 * D };
  const same = resampleHeights(src, sw, sh, bounds, bounds, sw, sh);
  for (let i = 0; i < src.length; i++) assert.ok(Math.abs(same[i] - src[i]) < 1e-3, "the same window comes back unchanged at " + i);
  const east = { south: LAT, north: LAT + D, west: LNG + D, east: LNG + 2 * D };
  const half = resampleHeights(src, sw, sh, bounds, east, sw / 2, sh);
  for (let x = 0; x < sw / 2; x++) assert.ok(Math.abs(half[x] - src[sw / 2 + x]) < 1e-3, "the east half is the east half at " + x);
  const wider = { south: LAT - D, north: LAT + 2 * D, west: LNG - D, east: LNG + 3 * D };
  const clamped = resampleHeights(src, sw, sh, bounds, wider, 8, 8);
  assert.strictEqual(clamped[0], 100, "beyond the source the edge is held");
  assert.strictEqual(clamped[7], src[sw - 1]);
  assert.deepStrictEqual(heightRange(same), { min: 100, max: 178 });
  assert.deepStrictEqual(heightRange(new Float32Array([NaN, 3, 1])), { min: 1, max: 3 });

  const g = elevationGrid(4000, 3000, 1800, 1);
  assert.strictEqual(g.width, 1800, "1 m terrain over 1.8 km: one sample a metre");
  assert.strictEqual(elevationGrid(4000, 3000, 3000, 1).width, COURSE_ELEVATION_MAX_PX, "over 3 km: capped");
  assert.ok(Math.abs(g.width / g.height - 4 / 3) < 0.01, "the picture's aspect");
  assert.ok(Math.abs(g.metresPerPixel * g.width - 1800) < 1e-6);
  const coarse = elevationGrid(4000, 3000, 1800, 5);
  assert.strictEqual(coarse.width, 360, "5 m terrain: one sample per 5 m");
  const tiny = elevationGrid(100, 50, 50, 5);
  assert.strictEqual(tiny.width, 16, "never under 16 across");
}

/* ---- the record ---- */

{
  const frame = { width: 4000, height: 3000, captureZoom: 18, originPx: { x: 1, y: 2 }, bounds: { north: 1, south: 0, east: 1, west: 0 } };
  const record = courseSurfaceRecord({
    version: "sabc", dir: "c/course-map/sabc", frame, bytes: 10, boundary: normaliseBoundary(square),
    extent: frame.bounds, builtAt: "now", source: { key: "linz", attribution: "LINZ" }
  });
  assert.strictEqual(record.path, "c/course-map/sabc/surface.jpg");
  assert.strictEqual(record.playSurface.scope, "course");
  assert.strictEqual(record.playSurface.captureZoom, 18, "a hole frame's playSurface in shape");
  assert.deepStrictEqual(record.playSurface.outputDimensions, { width: 4000, height: 3000 });
  assert.strictEqual(record.playSurface.elevation, undefined, "no elevation, no sidecar");
  assert.strictEqual(record.boundaryHash, boundaryHash(normaliseBoundary(square).ring));
  assert.deepStrictEqual(record.imagery, { key: "linz", attribution: "LINZ" });

  const holes = surfaceHoles({ objects: {
    a: { type: "tee", holeNumber: 2, position: { lat: 1, lng: 2 } },
    b: { type: "green", holeNumber: 2, position: { lat: 3, lng: 4 } },
    c: { type: "fairway", holeNumber: 1, position: { lat: 5, lng: 6 } },
    d: { type: "green", holeNumber: 1, position: { lat: 7, lng: 8 } }
  } });
  assert.deepStrictEqual(holes.map(h => h.holeNumber), [1, 2], "in hole order");
  assert.deepStrictEqual(holes[0].tee, { lat: 5, lng: 6 }, "no tee mapped: the route's first point stands in");
  assert.deepStrictEqual(holes[1].tee, { lat: 1, lng: 2 });
  assert.deepStrictEqual(holes[1].green, { lat: 3, lng: 4 });
}

/* ---- the job kind ---- */

{
  const jobs = fs.readFileSync(path.join(ROOT, "functions/course-visual-jobs.mjs"), "utf8");
  assert.ok(jobs.includes('const COURSE_SURFACE_KIND = "' + COURSE_SURFACE_KIND + '"'), "course-visual-jobs.mjs mirrors the kind");
  assert.ok(/sideJobKind = kind => [^\n]*COURSE_SURFACE_KIND/.test(jobs), "and keeps it out of a player's build state");
}

/* ---- drawn for real ---- */

{
  const solid = (r, g, b, w = 256, h = 256) => sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } }).jpeg({ quality: 95 }).toBuffer();
  const backdropBounds = { south: LAT - D, north: LAT + 2 * D, west: LNG - D, east: LNG + 3 * D };
  const corridorBounds = { south: LAT + D * 0.4, north: LAT + D * 0.6, west: LNG + D * 0.9, east: LNG + D * 1.1 };
  const extent = { south: LAT, north: LAT + D, west: LNG, east: LNG + 2 * D };
  const underlay = { entry: { role: "course-backdrop", bounds: backdropBounds, captureZoom: 17 }, buffer: await solid(20, 40, 220) };
  const corridor = { entry: { role: "play-corridor", holeNumber: 1, bounds: corridorBounds, captureZoom: 19, stitchLayer: 20 }, buffer: await solid(220, 30, 20) };
  const settings = { sourceMode: true };
  const pins = { tee: null, green: null, route: [], greenShape: [] };
  const frame = await renderHoleSurfaceMercator({ pins, captures: [corridor], underlay, terrain: null, greenSurface: null, settings, maxDim: 1024, extent });
  assert.ok(Number.isInteger(frame.captureZoom), "an integer zoom");
  assert.ok(Math.max(frame.width, frame.height) <= 1024, "within maxDim: " + frame.width + "x" + frame.height);
  for (const k of ["north", "south", "east", "west"]) assert.ok(Math.abs(frame.bounds[k] - extent[k]) < 1e-5, "framed on the extent: " + k);
  const px = await sharp(frame.jpeg).raw().toBuffer({ resolveWithObject: true });
  const colourAt = (lat, lng) => {
    const x = Math.floor((lng - frame.bounds.west) / (frame.bounds.east - frame.bounds.west) * px.info.width);
    const y = Math.floor((frame.bounds.north - lat) / (frame.bounds.north - frame.bounds.south) * px.info.height);
    const i = (y * px.info.width + x) * px.info.channels;
    return [px.data[i], px.data[i + 1], px.data[i + 2]];
  };
  const mid = colourAt(LAT + D * 0.5, LNG + D);
  const side = colourAt(LAT + D * 0.5, LNG + D * 0.3);
  assert.ok(mid[0] > 150 && mid[2] < 80, "the corridor where it was shot: " + mid);
  assert.ok(side[2] > 150 && side[0] < 80, "the backdrop round it: " + side);
  const bare = await renderHoleSurfaceMercator({ pins, captures: [], underlay, terrain: null, greenSurface: null, settings, maxDim: 512, extent });
  assert.ok(bare.width > 0 && Number.isInteger(bare.captureZoom) && bare.captureZoom <= 17, "the backdrop alone draws, at no more than its own zoom: z" + bare.captureZoom);
  await assert.rejects(renderHoleSurfaceMercator({ pins, captures: [], underlay: null, terrain: null, greenSurface: null, settings, maxDim: 512, extent }), /no positioned captures/);

  /* A plane rising 1 m per 10 m east over the backdrop's ground, as terrain-RGB. */
  const tw = 300, th = 200, plane = new Float32Array(tw * th);
  const metresAcross = (backdropBounds.east - backdropBounds.west) * 111320 * Math.cos(LAT * Math.PI / 180);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) plane[y * tw + x] = 50 + ((x + 0.5) / tw) * metresAcross / 10;
  const png = await terrainRgbPngFromHeights(plane, tw, th);
  const crop = await cropByBounds(png, backdropBounds, frame.bounds, { padPx: 2 });
  const raw = await sharp(crop.buffer).raw().toBuffer({ resolveWithObject: true });
  const decoded = decodeElevation(raw.data, raw.info.width, raw.info.height, raw.info.channels, "terrain-rgb");
  const grid = elevationGrid(frame.width, frame.height, metresAcross * (extent.east - extent.west) / (backdropBounds.east - backdropBounds.west), 1);
  const heights = resampleHeights(decoded.heights, raw.info.width, raw.info.height, crop.bounds, frame.bounds, grid.width, grid.height);
  const expectAt = lng => 50 + (lng - backdropBounds.west) / (backdropBounds.east - backdropBounds.west) * metresAcross / 10;
  const row = Math.floor(grid.height / 2);
  [0.1, 0.5, 0.9].forEach(f => {
    const col = Math.floor(f * grid.width);
    const lng = frame.bounds.west + (col + 0.5) / grid.width * (frame.bounds.east - frame.bounds.west);
    const got = heights[row * grid.width + col];
    assert.ok(Math.abs(got - expectAt(lng)) < 0.35, "the plane's height at " + f + " across: " + got.toFixed(2) + " vs " + expectAt(lng).toFixed(2));
  });
}

console.log("course-surface ok");
