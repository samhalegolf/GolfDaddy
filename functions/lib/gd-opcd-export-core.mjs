/* OPCD export core - a Clarity course as the files a GSPro course build starts from.

   GSPro courses are built in Unity with the OPCD toolkit (QGIS -> Blender/Inkscape -> Unity).
   Nothing here builds that course; it writes the INPUTS that workflow is otherwise assembled
   by hand from LiDAR downloads and tracing:

     heightmap.raw      16-bit unsigned little-endian, S x S samples at 1 m, north row first
                        (tick "Flip Vertically" on Unity's Import Raw), 0 = baseElevationM,
                        65535 = baseElevationM + heightRangeM
     heightmap.tif      the same ground as float32 metres, GeoTIFF in the course's UTM zone -
                        what QGIS reads, and the file to check the RAW against
     surfaces.geojson   every published surface (fairway, green, tee, bunker, water, woods,
                        hazard, waste), green centres, tee points, each hole's route and the
                        terrain frame itself, WGS84 as GeoJSON requires
     trees.csv          every tree the course holds (Studio-placed and finder-found): position,
                        local metres, ground height, crown radius, height
     holes.csv          tee and green per hole with par and length where known
     surfaces-opcd.svg  the surfaces as the Inkscape SVG OPCD's mesher (Clender) takes: one
                        layer per OPCD class in its palette, 1 mm = 1 m over the frame
     manifest.json      the frame, the encoding, provenance and attributions
     README.md          how to import it

   THE FRAME. One square of UTM ground, side 2^n metres (1024, 2048 or 4096 - Unity wants
   2^n+1 samples, OPCD builds on 2048 m squares), at exactly 1 m a sample, origin snapped to
   whole metres, centred on the course's play geometry. Unity terrain coordinates fall out of
   it: X = easting - originE, Z = northing - originN, Y = height - baseElevationM.

   THE GROUND. Sampled from the course's baked terrain asset (functions/lib/terrain/), the
   same heights the phone's mesh and the green contours read, so what a player sees in Clarity
   and what GSPro is built on are one measurement. Catmull-Rom between the asset's samples;
   ground the asset does not cover is nearest-filled and the fraction reported, never hidden.

   Pure: no network, no sharp, no Supabase. dev/opcd-export.test.mjs runs it on synthetic
   ground; functions/lib/gd-opcd-export-job.mjs wires it to storage. */

import { fromLngLat, toLngLat, utmCrsFor } from "./terrain/gd-terrain-crs.mjs";
import { sampleRaw, fillGaps } from "./terrain/gd-terrain-normalise.mjs";
import { lngLatToWorldPx, mercMetresPerPixel } from "./terrain/gd-terrain-adapters.mjs";
import { packageHoleData } from "./gd-visual-plan-core.mjs";
import polygonClipping from "polygon-clipping";

/* The course_visual_jobs kind. Mirrored as a literal in functions/course-visual-jobs.mjs
   (which must not load this module's imports on a player poll); dev/opcd-export.test.mjs
   asserts the two agree. */
export const OPCD_EXPORT_KIND = "opcd_export";
export const OPCD_FORMAT_VERSION = 1;
export const OPCD_SAMPLE_M = 1;
/* Unity heightmap resolutions: 2^n + 1. 513 is too small for a real course; 8193 is a
   270 MB float raster a function cannot hold. */
export const OPCD_SIDES = [1025, 2049, 4097];
export const OPCD_MARGIN_M = 100;
/* A tree whose height nothing measured: crowns on a mature parkland tree run about 40% of
   its height, so height ~ 2.4 x crown radius. Marked "estimated" in the CSV. */
export const TREE_HEIGHT_PER_CROWN_RADIUS = 2.4;

const MERC_R = 6378137;
const MERC_HALF = 20037508.342789244;
const DEG = Math.PI / 180;

function mercator(lat, lng) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  return { x: MERC_R * lng * DEG, y: MERC_R * Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2)) };
}

function point(p) {
  const lat = Number(p && p.lat), lng = Number(p && p.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}
function ring(shape) {
  const out = (Array.isArray(shape) ? shape : []).map(point).filter(Boolean);
  return out.length >= 3 ? out : null;
}
function ringKey(r) { return r.length + ":" + r[0].lat.toFixed(7) + "," + r[0].lng.toFixed(7); }
function round(v, places) { const f = Math.pow(10, places); return Math.round(v * f) / f; }

/* ---------- the frame ------------------------------------------------------------------- */

/* planOpcdFrame(courseBounds WGS84, {marginM, sides}) -> the UTM square the export covers.
   `clipped` when the course is wider than the largest side allows even with no margin; the
   square is then centred on the course and the edges fall outside it. */
export function planOpcdFrame(bounds, { marginM = OPCD_MARGIN_M, sides = OPCD_SIDES } = {}) {
  if (!bounds || !(bounds.north > bounds.south) || !(bounds.east > bounds.west)) throw new Error("course bounds required");
  const lat = (bounds.north + bounds.south) / 2, lng = (bounds.west + bounds.east) / 2;
  const crs = utmCrsFor(lat, lng);
  const corners = [[bounds.south, bounds.west], [bounds.south, bounds.east], [bounds.north, bounds.west], [bounds.north, bounds.east]]
    .map(([a, b]) => fromLngLat(crs, a, b));
  const minE = Math.min(...corners.map(c => c[0])), maxE = Math.max(...corners.map(c => c[0]));
  const minN = Math.min(...corners.map(c => c[1])), maxN = Math.max(...corners.map(c => c[1]));
  const spanE = maxE - minE, spanN = maxN - minN;
  const need = Math.max(spanE, spanN) + 2 * marginM;
  let samples = sides.find(s => s - 1 >= need);
  let clipped = false;
  if (!samples) { samples = sides[sides.length - 1]; clipped = Math.max(spanE, spanN) > samples - 1; }
  const sideM = (samples - 1) * OPCD_SAMPLE_M;
  const originE = Math.round((minE + maxE) / 2 - sideM / 2);
  const originN = Math.round((minN + maxN) / 2 - sideM / 2);
  const frameCorners = [[originE, originN], [originE + sideM, originN], [originE + sideM, originN + sideM], [originE, originN + sideM]]
    .map(([e, n]) => toLngLat(crs, e, n));
  const m = /^EPSG:32([67])(\d\d)$/.exec(crs);
  return {
    crs, epsg: Number(crs.slice(5)), utmZone: Number(m[2]), hemisphere: m[1] === "7" ? "S" : "N",
    samples, sideM, sampleM: OPCD_SAMPLE_M, originE, originN,
    centre: { lat, lng },
    bounds: {
      north: Math.max(...frameCorners.map(c => c.lat)), south: Math.min(...frameCorners.map(c => c.lat)),
      east: Math.max(...frameCorners.map(c => c.lng)), west: Math.min(...frameCorners.map(c => c.lng))
    },
    courseSpanM: { east: round(spanE, 1), north: round(spanN, 1) },
    marginM, clipped
  };
}

/* WGS84 -> the frame's metres: UTM easting/northing and Unity-style local X (east) / Z (north)
   from the square's south-west corner. */
export function toLocal(frame, lat, lng) {
  const [e, n] = fromLngLat(frame.crs, lat, lng);
  return { easting: e, northing: n, x: e - frame.originE, z: n - frame.originN };
}

export function insideFrame(frame, local) {
  return local.x >= 0 && local.z >= 0 && local.x <= frame.sideM && local.z <= frame.sideM;
}

/* ---------- the ground ------------------------------------------------------------------ */

/* Whether a terrain asset's grid holds the whole frame. A bake pads the course by its own
   margin (450 m today); a 2048 m square round a narrow course reaches past that. */
export function assetCovers(manifest, bounds) {
  const b = manifest && manifest.grid && manifest.grid.bounds;
  return !!b && bounds.south >= b.south && bounds.north <= b.north && bounds.west >= b.west && bounds.east <= b.east;
}

/* The web-mercator window (gd-terrain-window's grid shape) that covers the frame with a few
   pixels to spare, at the asset's zoom or the first coarser one that fits maxSidePx. */
export function windowGridFor(frame, { zoom = 17, maxSidePx = 3072, padPx = 3 } = {}) {
  let z = Math.max(1, Math.round(zoom));
  for (;;) {
    const nw = lngLatToWorldPx(frame.bounds.north, frame.bounds.west, z);
    const se = lngLatToWorldPx(frame.bounds.south, frame.bounds.east, z);
    const left = Math.floor(nw.x) - padPx, top = Math.floor(nw.y) - padPx;
    const width = Math.ceil(se.x) + padPx - left, height = Math.ceil(se.y) + padPx - top;
    if ((width <= maxSidePx && height <= maxSidePx) || z <= 1) return { zoom: z, originPx: { x: left, y: top }, width, height };
    z -= 1;
  }
}

/* Heights read for such a window, as a raw grid sampleHeightmap can take. */
export function rawFromWindow(grid, heights) {
  const mpp = mercMetresPerPixel(grid.zoom);
  return {
    sourceId: "window", crs: "EPSG:3857", width: grid.width, height: grid.height, heights,
    transform: { originX: grid.originPx.x * mpp - MERC_HALF, originY: MERC_HALF - grid.originPx.y * mpp, pixelSize: mpp }
  };
}

/* sampleHeightmap(frame, raw) - raw is a RawTerrainData in EPSG:3857 (the baked asset through
   gd-terrain-window's assetAsRaw). Row 0 is the frame's NORTH edge, column 0 its west edge,
   one sample a metre. Projected positions are computed on a lattice every `lattice` samples
   and interpolated between (the normaliser's trick: over 16 m the projection is linear to
   well under a centimetre). A sample the asset does not hold is taken from `fallback` (the
   same ground read for the whole frame, when the job could get it) and counted in
   fallbackFraction; what neither holds is nearest-filled and counted in filledFraction. */
export function sampleHeightmap(frame, raw, { lattice = 16, fallback = null } = {}) {
  if (!raw || raw.crs !== "EPSG:3857") throw new Error("sampleHeightmap reads an EPSG:3857 raw grid");
  if (fallback && fallback.crs !== "EPSG:3857") throw new Error("the fallback grid must be EPSG:3857 too");
  const S = frame.samples;
  const heights = new Float32Array(S * S);
  const L = Math.ceil((S - 1) / lattice) + 1;
  const mx = new Float64Array(L * L), my = new Float64Array(L * L);
  for (let b = 0; b < L; b++) {
    for (let a = 0; a < L; a++) {
      const e = frame.originE + Math.min(S - 1, a * lattice) * frame.sampleM;
      const n = frame.originN + frame.sideM - Math.min(S - 1, b * lattice) * frame.sampleM;
      const ll = toLngLat(frame.crs, e, n);
      const m = mercator(ll.lat, ll.lng);
      mx[b * L + a] = m.x; my[b * L + a] = m.y;
    }
  }
  const t = raw.transform, f = fallback && fallback.transform;
  let missing = 0, fromFallback = 0;
  for (let j = 0; j < S; j++) {
    const gy = j / lattice, b = Math.min(L - 2, Math.floor(gy)), v = gy - b;
    for (let i = 0; i < S; i++) {
      const gx = i / lattice, a = Math.min(L - 2, Math.floor(gx)), u = gx - a;
      const k00 = b * L + a, k10 = k00 + 1, k01 = k00 + L, k11 = k01 + 1;
      const X = (mx[k00] * (1 - u) + mx[k10] * u) * (1 - v) + (mx[k01] * (1 - u) + mx[k11] * u) * v;
      const Y = (my[k00] * (1 - u) + my[k10] * u) * (1 - v) + (my[k01] * (1 - u) + my[k11] * u) * v;
      let h = sampleRaw(raw, (X - t.originX) / t.pixelSize - 0.5, (t.originY - Y) / t.pixelSize - 0.5);
      if (!Number.isFinite(h)) {
        missing++;
        if (f) {
          h = sampleRaw(fallback, (X - f.originX) / f.pixelSize - 0.5, (f.originY - Y) / f.pixelSize - 0.5);
          if (Number.isFinite(h)) fromFallback++;
        }
      }
      heights[j * S + i] = h;
    }
  }
  let filledFraction = 0;
  if (missing > fromFallback) filledFraction = fillGaps(heights, new Uint8Array(S * S), S, S).filledFraction;
  return { heights, filledFraction, outsideAssetFraction: missing / (S * S), fallbackFraction: fromFallback / (S * S) };
}

export function heightStats(heights) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const v = heights[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/* The RAW's vertical encoding: a whole-metre base just under the lowest ground and a
   whole-metre range just over the highest, so the file has headroom and the Unity terrain
   height setting is an integer. Resolution is range / 65535 - 1.5 mm per 100 m of range. */
export function rawEncoding(stats) {
  const base = Math.floor(stats.min) - 1;
  const range = Math.max(2, Math.ceil(stats.max - base) + 1);
  return { baseElevationM: base, heightRangeM: range, stepM: range / 65535 };
}

export function encodeRaw16(heights, encoding) {
  const out = Buffer.alloc(heights.length * 2);
  const scale = 65535 / encoding.heightRangeM;
  for (let i = 0; i < heights.length; i++) {
    const v = Math.max(0, Math.min(65535, Math.round((heights[i] - encoding.baseElevationM) * scale)));
    out.writeUInt16LE(v, i * 2);
  }
  return out;
}

/* Float32 GeoTIFF of the same samples, pixel-is-area with the tie point half a metre outside
   the north-west sample so every pixel CENTRE sits on the whole-metre grid the RAW describes.
   writeArrayBuffer is geotiff.js's; injected so the core stays import-light. */
export async function heightmapGeoTiff(frame, heights, { writeArrayBuffer } = {}) {
  const write = writeArrayBuffer || (await import("geotiff")).writeArrayBuffer;
  const S = frame.samples;
  const meta = {
    width: S, height: S,
    ModelPixelScale: [frame.sampleM, frame.sampleM, 0],
    ModelTiepoint: [0, 0, 0, frame.originE - frame.sampleM / 2, frame.originN + frame.sideM + frame.sampleM / 2, 0],
    GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ProjectedCSTypeGeoKey: frame.epsg,
    SampleFormat: [3], BitsPerSample: [32], SamplesPerPixel: 1, PhotometricInterpretation: 1, PlanarConfiguration: 1
  };
  return Buffer.from(await write(heights, meta));
}

/* Ground height at local metres (bilinear between samples), null outside the frame. */
export function groundAt(frame, heights, x, z) {
  const S = frame.samples;
  const fx = x / frame.sampleM, fy = (frame.sideM - z) / frame.sampleM;
  if (!(fx >= 0 && fy >= 0 && fx <= S - 1 && fy <= S - 1)) return null;
  const x0 = Math.min(S - 2, Math.floor(fx)), y0 = Math.min(S - 2, Math.floor(fy));
  const u = fx - x0, v = fy - y0;
  const h = (xx, yy) => heights[yy * S + xx];
  return (h(x0, y0) * (1 - u) + h(x0 + 1, y0) * u) * (1 - v) + (h(x0, y0 + 1) * (1 - u) + h(x0 + 1, y0 + 1) * u) * v;
}

/* An 8-bit greyscale preview of the heightmap (black = base, white = top) - for a human to
   eyeball orientation against the aerial. Same row order as the RAW. */
export function previewGrey(heights, encoding) {
  const out = Buffer.alloc(heights.length);
  const scale = 255 / encoding.heightRangeM;
  for (let i = 0; i < heights.length; i++) out[i] = Math.max(0, Math.min(255, Math.round((heights[i] - encoding.baseElevationM) * scale)));
  return out;
}

/* ---------- surfaces -------------------------------------------------------------------- */

const SURFACE_KIND = { fairway_area: "fairway", bunker: "bunker", water: "water", trees: "woods", hazard: "hazard", waste: "waste" };

function closedRing(r) {
  const coords = r.map(p => [round(p.lng, 7), round(p.lat, 7)]);
  const first = coords[0], last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) coords.push([first[0], first[1]]);
  return coords;
}
function feature(geometry, properties) { return { type: "Feature", geometry, properties }; }
function holeOf(o) { const h = Number(o && o.holeNumber); return Number.isFinite(h) && h > 0 ? h : null; }

/* surfacesGeoJson(pkg {objects, holes, courseId, courseName}, frame, {par: Map hole -> par})
   One FeatureCollection. A surface stored once per hole it shows on (the mapper's clone rule)
   is written once; the hole it is first seen on is the one it carries. */
export function surfacesGeoJson(pkg, frame, { par } = {}) {
  const features = [];
  const local = p => { const l = toLocal(frame, p.lat, p.lng); return { x_m: round(l.x, 2), z_m: round(l.z, 2) }; };
  const frameRing = [[frame.originE, frame.originN], [frame.originE + frame.sideM, frame.originN], [frame.originE + frame.sideM, frame.originN + frame.sideM], [frame.originE, frame.originN + frame.sideM]]
    .map(([e, n]) => toLngLat(frame.crs, e, n));
  features.push(feature({ type: "Polygon", coordinates: [closedRing(frameRing)] }, {
    kind: "terrain_frame", crs: frame.crs, origin_easting: frame.originE, origin_northing: frame.originN, side_m: frame.sideM
  }));
  const seen = new Set();
  const greensByHole = new Map(), teesByHole = new Map();
  Object.values(pkg && pkg.objects || {}).forEach(o => {
    if (!o) return;
    if (SURFACE_KIND[o.type]) {
      const r = ring(o.shape);
      if (!r) return;
      const key = o.type + ":" + ringKey(r);
      if (seen.has(key)) return;
      seen.add(key);
      const props = { kind: SURFACE_KIND[o.type], hole: holeOf(o), osm_id: o.osmId || null, source: o.source || null };
      if (o.type === "water") props.hazard_class = o.hazardClass || "water";
      features.push(feature({ type: "Polygon", coordinates: [closedRing(r)] }, props));
    } else if (o.type === "green") {
      const hole = holeOf(o);
      if (hole && greensByHole.has(hole)) return;
      const r = ring(o.greenShape || o.shape);
      const centre = point(o.greenCenter) || point(o.position);
      if (hole) greensByHole.set(hole, true);
      if (r) features.push(feature({ type: "Polygon", coordinates: [closedRing(r)] }, { kind: "green", hole, source: o.greenSource || o.source || null }));
      if (centre) features.push(feature({ type: "Point", coordinates: [round(centre.lng, 7), round(centre.lat, 7)] }, Object.assign({ kind: "green_centre", hole }, local(centre))));
    } else if (o.type === "tee") {
      const hole = holeOf(o);
      if (hole && teesByHole.has(hole)) return;
      const r = ring(o.shape);
      const centre = point(o.position);
      if (hole) teesByHole.set(hole, true);
      if (r) features.push(feature({ type: "Polygon", coordinates: [closedRing(r)] }, { kind: "tee_area", hole, source: o.source || null }));
      if (centre) features.push(feature({ type: "Point", coordinates: [round(centre.lng, 7), round(centre.lat, 7)] }, Object.assign({ kind: "tee", hole, par: par && par.get(hole) || null }, local(centre))));
    }
  });
  const holeData = packageHoleData(pkg);
  Object.keys(holeData).map(Number).sort((a, b) => a - b).forEach(h => {
    const route = holeData[h].route;
    if (route.length < 2) return;
    features.push(feature({ type: "LineString", coordinates: route.map(p => [round(p.lng, 7), round(p.lat, 7)]) }, { kind: "hole_route", hole: h, par: par && par.get(h) || null }));
  });
  return {
    type: "FeatureCollection",
    name: String(pkg && (pkg.courseName || pkg.courseId) || "course") + " surfaces",
    crs_note: "Coordinates are WGS84 longitude/latitude (GeoJSON). x_m/z_m on points are metres east/north of the terrain frame's south-west corner in " + frame.crs + ".",
    features
  };
}

/* ---------- trees ----------------------------------------------------------------------- */

function csvLine(cells) {
  return cells.map(c => {
    if (c == null || c === "") return "";
    const s = String(c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(",");
}

/* The trees as a finder/overlay list: [{lat, lng, r (crown radius m), source, level?}].
   canopyAt(lat, lng) -> metres or null (the Meta/WRI canopy raster where it has data).
   Trees outside the frame are kept, with blank local coordinates - the frame is a terrain
   choice, not a judgement about which trees exist. */
export function treesCsv(trees, frame, heights, { canopyAt } = {}) {
  const lines = [csvLine(["id", "source", "lat", "lng", "easting", "northing", "x_m", "z_m", "ground_m", "crown_radius_m", "height_m", "height_source", "level"])];
  let measured = 0, inside = 0;
  (trees || []).forEach((t, index) => {
    const p = point(t);
    const r = Number(t && t.r);
    if (!p || !(r > 0)) return;
    const l = toLocal(frame, p.lat, p.lng);
    const within = insideFrame(frame, l);
    if (within) inside++;
    const ground = within && heights ? groundAt(frame, heights, l.x, l.z) : null;
    const canopy = canopyAt ? canopyAt(p.lat, p.lng) : null;
    const height = canopy > 0 ? canopy : round(r * TREE_HEIGHT_PER_CROWN_RADIUS, 1);
    if (canopy > 0) measured++;
    lines.push(csvLine([
      "t" + (index + 1), t.source || "finder", round(p.lat, 7), round(p.lng, 7), round(l.easting, 2), round(l.northing, 2),
      within ? round(l.x, 2) : "", within ? round(l.z, 2) : "", ground == null ? "" : round(ground, 2),
      round(r, 1), round(height, 1), canopy > 0 ? "canopy" : "estimated", Number.isFinite(Number(t.level)) ? Number(t.level) : ""
    ]));
  });
  return { csv: lines.join("\n") + "\n", count: lines.length - 1, inside, measured };
}

/* ---------- holes ----------------------------------------------------------------------- */

function haversineM(a, b) {
  const dLat = (b.lat - a.lat) * DEG, dLng = (b.lng - a.lng) * DEG;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * MERC_R * Math.asin(Math.sqrt(s));
}

/* Par per hole from a shared scorecard's holes list ({holeNumber|hole|number, par}), or an
   empty map. */
export function parByHole(scorecardHoles) {
  const out = new Map();
  (Array.isArray(scorecardHoles) ? scorecardHoles : []).forEach(h => {
    const n = Number(h && (h.holeNumber != null ? h.holeNumber : h.hole != null ? h.hole : h.number));
    const par = Number(h && h.par);
    if (Number.isFinite(n) && n > 0 && Number.isFinite(par) && par >= 3 && par <= 6 && !out.has(n)) out.set(n, par);
  });
  return out;
}

export function holesCsv(pkg, frame, heights, { par } = {}) {
  const holeData = packageHoleData(pkg);
  const lines = [csvLine(["hole", "par", "length_m", "tee_lat", "tee_lng", "tee_x_m", "tee_z_m", "tee_ground_m", "green_lat", "green_lng", "green_x_m", "green_z_m", "green_ground_m"])];
  const cell = p => {
    if (!p) return ["", "", "", "", ""];
    const l = toLocal(frame, p.lat, p.lng);
    const within = insideFrame(frame, l);
    const g = within && heights ? groundAt(frame, heights, l.x, l.z) : null;
    return [round(p.lat, 7), round(p.lng, 7), within ? round(l.x, 2) : "", within ? round(l.z, 2) : "", g == null ? "" : round(g, 2)];
  };
  Object.keys(holeData).map(Number).sort((a, b) => a - b).forEach(h => {
    const d = holeData[h];
    const tee = d.tee && d.tee.position, green = d.green && d.green.position;
    let length = null;
    if (d.route.length >= 2) { length = 0; for (let i = 1; i < d.route.length; i++) length += haversineM(d.route[i - 1], d.route[i]); }
    lines.push(csvLine([h, par && par.get(h) || "", length == null ? "" : Math.round(length), ...cell(tee), ...cell(green)]));
  });
  return { csv: lines.join("\n") + "\n", count: lines.length - 1 };
}

/* ---------- the OPCD SVG ---------------------------------------------------------------- */

/* OPCD's V4 palette as Clender reads it - the golf entries of osm2svg4opcd's styles.json,
   which is what the community pipelines that pass Clender write. Layer label = the class
   string; fill = the colour; `order` = stacking, low first. A fill Clender does not know is
   dropped on its side, so nothing here invents a colour. natural.scrub shares the wood
   colour on purpose: Clender turns both into OPCD's "Deep" rough. */
export const OPCD_CLASSES = {
  rough:   { cls: "leisure.golf_course", fill: "#278438", order: 0 },
  scrub:   { cls: "natural.scrub",       fill: "#164B20", order: 55 },
  fairway: { cls: "golf.fairway",        fill: "#43E561", order: 60 },
  tee:     { cls: "golf.tee",            fill: "#A0E5B8", order: 70 },
  wood:    { cls: "natural.wood",        fill: "#164B20", order: 80 },
  green:   { cls: "golf.green",          fill: "#BCE5A4", order: 90 },
  bunker:  { cls: "golf.bunker",         fill: "#E5E5AA", order: 100 },
  water:   { cls: "golf.water_hazard",   fill: "#0000C0", order: 110 }
};
const OBJECT_CLASS = { fairway_area: "fairway", bunker: "bunker", water: "water", trees: "wood", hazard: "scrub", waste: "scrub" };
/* Clarity stores a tee as a point. OPCD wants a pad to mesh, so one is drawn: this big,
   its long side along the line of play. A real tee shape in the overlay (tee_area) wins. */
export const TEE_PAD_M = { width: 8, length: 14 };
/* A green with a centre and no outline (never from the resolver, but allowed by the data). */
export const GREEN_DISC_RADIUS_M = 12;
export const SVG_MIN_AREA_M2 = 1;

function svgPoint(frame, lat, lng) {
  const [e, n] = fromLngLat(frame.crs, lat, lng);
  return [round(e - frame.originE, 2), round(frame.originN + frame.sideM - n, 2)];
}
function svgRing(frame, r) {
  const pts = r.map(p => svgPoint(frame, p.lat, p.lng));
  const a = pts[0], z = pts[pts.length - 1];
  if (a[0] !== z[0] || a[1] !== z[1]) pts.push([a[0], a[1]]);
  return pts;
}
function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(a) / 2;
}
function discRing(cx, cy, r, n = 16) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([round(cx + r * Math.cos(2 * Math.PI * i / n), 2), round(cy + r * Math.sin(2 * Math.PI * i / n), 2)]);
  pts.push([pts[0][0], pts[0][1]]);
  return pts;
}
function padRing(c, towards, pad) {
  let dx = towards ? towards[0] - c[0] : 0, dy = towards ? towards[1] - c[1] : 0;
  const len = Math.hypot(dx, dy);
  if (!(len > 1)) return discRing(c[0], c[1], Math.max(pad.width, pad.length) / 2, 12);
  dx /= len; dy /= len;
  const px = -dy, py = dx, L = pad.length / 2, W = pad.width / 2;
  const corner = (sl, sw) => [round(c[0] + dx * sl * L + px * sw * W, 2), round(c[1] + dy * sl * L + py * sw * W, 2)];
  const pts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  pts.push([pts[0][0], pts[0][1]]);
  return pts;
}
function pathD(poly) {
  return poly.map(ring => "M" + ring.map(p => p[0] + "," + p[1]).join(" L") + " Z").join(" ");
}
function xmlEscape(v) { return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"); }

/* opcdSvg(pkg, frame, {courseName, generatedAt}) -> { svg, layers: {cls: {shapes, areaM2}},
   teePadsDrawn, greenDiscsDrawn, warnings }
   Clender's rules, as the pipelines that pass it apply them: shapes closed; no two shapes of
   one colour overlapping or touching (same-class shapes are unioned, so a bunker stored on
   two holes or two fairways that share an edge become one shape); everything clipped to the
   square; slivers under SVG_MIN_AREA_M2 dropped; holes kept, filled even-odd. Different
   classes may overlap (a bunker sits on its fairway) - OPCD blends surfaces, it does not
   expect them cut out of one another. */
export function opcdSvg(pkg, frame, { courseName, generatedAt } = {}) {
  const S = frame.sideM;
  const square = [[[0, 0], [S, 0], [S, S], [0, S], [0, 0]]];
  const byClass = {};
  const add = (key, ring) => { (byClass[key] = byClass[key] || []).push([ring]); };
  const warnings = [];
  const seen = new Set();
  let teePadsDrawn = 0, greenDiscsDrawn = 0;
  const teeAreas = new Set();
  Object.values(pkg && pkg.objects || {}).forEach(o => {
    if (!o) return;
    if (OBJECT_CLASS[o.type]) {
      const r = ring(o.shape);
      if (!r) return;
      const key = o.type + ":" + ringKey(r);
      if (seen.has(key)) return;
      seen.add(key);
      add(OBJECT_CLASS[o.type], svgRing(frame, r));
    } else if (o.type === "green") {
      const hole = holeOf(o);
      const r = ring(o.greenShape || o.shape);
      const c = point(o.greenCenter) || point(o.position);
      /* One green per hole (the first stored, as packageHoleData reads it); an unassigned
         green is kept once per outline or centre. */
      const key = "green:" + (hole ? "h" + hole : r ? ringKey(r) : c ? c.lat.toFixed(6) + "," + c.lng.toFixed(6) : "");
      if (!key.endsWith(":") && seen.has(key)) return;
      seen.add(key);
      if (r) add("green", svgRing(frame, r));
      else if (c) { const q = svgPoint(frame, c.lat, c.lng); add("green", discRing(q[0], q[1], GREEN_DISC_RADIUS_M)); greenDiscsDrawn++; }
    } else if (o.type === "tee") {
      const r = ring(o.shape), hole = holeOf(o);
      if (r) { add("tee", svgRing(frame, r)); if (hole) teeAreas.add(hole); }
    }
  });
  const holeData = packageHoleData(pkg);
  Object.keys(holeData).map(Number).sort((a, b) => a - b).forEach(h => {
    const d = holeData[h];
    if (teeAreas.has(h) || !d.tee) return;
    const c = svgPoint(frame, d.tee.position.lat, d.tee.position.lng);
    const next = d.route[1] ? svgPoint(frame, d.route[1].lat, d.route[1].lng) : null;
    add("tee", padRing(c, next, TEE_PAD_M));
    teePadsDrawn++;
  });
  if (teePadsDrawn) warnings.push(teePadsDrawn + " tee pad(s) are drawn from tee points (" + TEE_PAD_M.width + "x" + TEE_PAD_M.length + " m along the line of play) - size them to the real tee in Inkscape");
  if (greenDiscsDrawn) warnings.push(greenDiscsDrawn + " green(s) had no outline and are drawn as " + GREEN_DISC_RADIUS_M + " m discs");

  const layers = {};
  const order = Object.keys(OPCD_CLASSES).filter(k => k !== "rough").sort((a, b) => OPCD_CLASSES[a].order - OPCD_CLASSES[b].order);
  const groups = [];
  const rough = OPCD_CLASSES.rough;
  groups.push('  <g inkscape:groupmode="layer" id="layer-' + rough.cls + '" inkscape:label="' + rough.cls + '">\n'
    + '    <rect id="rough" x="0" y="0" width="' + S + '" height="' + S + '" fill="' + rough.fill + '" stroke="none"/>\n  </g>');
  for (const key of order) {
    const def = OPCD_CLASSES[key];
    const polys = byClass[key] || [];
    if (!polys.length) continue;
    let merged;
    try {
      merged = polygonClipping.intersection(polygonClipping.union(...polys), square);
    } catch (error) {
      warnings.push(def.cls + ": union failed (" + String(error && error.message || error).slice(0, 80) + "); shapes written unmerged");
      merged = polys;
    }
    const paths = [];
    let area = 0, dropped = 0;
    merged.forEach(poly => {
      const outer = poly[0];
      const a = ringArea(outer);
      if (!(a >= SVG_MIN_AREA_M2) || outer.length < 4) { dropped++; return; }
      area += a - poly.slice(1).reduce((n, r) => n + ringArea(r), 0);
      const rounded = poly.map(r => r.map(pt => [round(pt[0], 2), round(pt[1], 2)]));
      paths.push('    <path id="' + def.cls + "-" + (paths.length + 1) + '" d="' + pathD(rounded) + '" fill="' + def.fill + '" stroke="none"' + (poly.length > 1 ? ' fill-rule="evenodd"' : "") + "/>");
    });
    if (!paths.length) continue;
    layers[def.cls] = { shapes: paths.length, areaM2: Math.round(area), dropped };
    groups.push('  <g inkscape:groupmode="layer" id="layer-' + def.cls + '" inkscape:label="' + def.cls + '">\n' + paths.join("\n") + "\n  </g>");
  }
  const name = String(courseName || pkg && (pkg.courseName || pkg.courseId) || "course");
  const svg = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + "<!-- " + xmlEscape(name) + " for OPCD / Clender. 1 mm = 1 m. Top-left = (E " + frame.originE + ", N " + (frame.originN + S) + ") in " + frame.crs
    + "; north up; the square is the terrain frame in manifest.json. Written by Clarity Studio" + (generatedAt ? " " + generatedAt : "") + ". -->\n"
    + '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"'
    + ' version="1.1" width="' + S + 'mm" height="' + S + 'mm" viewBox="0 0 ' + S + " " + S + '">\n'
    + "  <title>" + xmlEscape(name) + " - OPCD surfaces</title>\n"
    + '  <sodipodi:namedview id="namedview" inkscape:document-units="mm" units="mm"/>\n'
    + groups.join("\n") + "\n</svg>\n";
  return { svg, layers, teePadsDrawn, greenDiscsDrawn, warnings };
}

/* ---------- manifest + readme ----------------------------------------------------------- */

export function opcdManifest({ courseId, courseName, frame, encoding, stats, sampled, terrain, trees, holes, surfaces, svg, files, generatedAt, warnings }) {
  return {
    formatVersion: OPCD_FORMAT_VERSION,
    courseId, courseName, generatedAt,
    frame: {
      crs: frame.crs, utmZone: frame.utmZone, hemisphere: frame.hemisphere,
      originEasting: frame.originE, originNorthing: frame.originN,
      sideM: frame.sideM, samples: frame.samples, sampleM: frame.sampleM,
      centre: frame.centre, boundsWgs84: frame.bounds, courseSpanM: frame.courseSpanM, marginM: frame.marginM, clipped: frame.clipped
    },
    heightmap: {
      file: "heightmap.raw", bitDepth: 16, byteOrder: "little-endian", rowOrder: "north-first",
      unityImportRaw: { depth: "Bit 16", byteOrder: "Windows", flipVertically: true, resolution: frame.samples, width: frame.sideM, length: frame.sideM, height: encoding.heightRangeM },
      baseElevationM: encoding.baseElevationM, heightRangeM: encoding.heightRangeM, stepM: round(encoding.stepM, 5),
      groundMinM: round(stats.min, 2), groundMaxM: round(stats.max, 2),
      outsideAssetFraction: round(sampled.outsideAssetFraction, 4), fallbackFraction: round(sampled.fallbackFraction || 0, 4), filledFraction: round(sampled.filledFraction, 4),
      groundBeyondAsset: sampled.beyondAsset || (sampled.outsideAssetFraction > 0 ? "nearest-filled" : "none needed"),
      geotiff: "heightmap.tif (float32 metres, pixel centres on the metre grid, " + frame.crs + ")"
    },
    terrain: terrain ? {
      terrainVersion: terrain.terrainVersion, sourceIds: terrain.sourceIds, sourceResolutionM: terrain.sourceResolutionM,
      gridMetresPerPixel: terrain.grid && terrain.grid.metresPerPixel, qualityClass: terrain.quality && terrain.quality.class,
      greenDetail: terrain.quality && terrain.quality.greenDetail, verticalDatum: terrain.verticalDatum,
      attribution: (terrain.sources || []).map(s => s.attribution && s.attribution.text).filter(Boolean)
    } : null,
    trees, holes, surfaces,
    opcdSvg: svg ? { file: "surfaces-opcd.svg", scale: "1 mm = 1 m", layers: svg.layers, teePadsDrawn: svg.teePadsDrawn, greenDiscsDrawn: svg.greenDiscsDrawn, palette: Object.fromEntries(Object.values(OPCD_CLASSES).map(c => [c.cls, c.fill])) } : null,
    files, warnings: warnings || []
  };
}

export function opcdReadme(m) {
  const f = m.frame, h = m.heightmap, u = h.unityImportRaw;
  const lines = [
    "# " + m.courseName + " - OPCD / GSPro export",
    "",
    "Generated " + m.generatedAt + " by Clarity Studio (format v" + m.formatVersion + "). These are the inputs to the OPCD course-build workflow (QGIS -> Blender/Inkscape -> Unity), not a finished GSPro course.",
    "",
    "## Terrain frame",
    "",
    "- CRS: " + f.crs + " (WGS84 / UTM zone " + f.utmZone + f.hemisphere + "), units metres",
    "- Square: " + f.sideM + " m a side, south-west corner at easting " + f.originEasting + ", northing " + f.originNorthing,
    "- Samples: " + f.samples + " x " + f.samples + " at " + f.sampleM + " m" + (f.clipped ? " - WARNING: the course is wider than the frame; its edges are cut" : ""),
    "- Unity terrain coordinates: X = easting - " + f.originEasting + ", Z = northing - " + f.originNorthing + ", Y = height - " + h.baseElevationM,
    "",
    "## heightmap.raw",
    "",
    "16-bit unsigned, little-endian, " + f.samples + " x " + f.samples + ", NORTH row first. 0 = " + h.baseElevationM + " m, 65535 = " + (h.baseElevationM + h.heightRangeM) + " m (" + h.stepM + " m a step). Ground runs " + h.groundMinM + " to " + h.groundMaxM + " m.",
    "",
    "Unity > Terrain > Terrain Settings > Import Raw:",
    "- Depth: " + u.depth,
    "- Byte order: " + u.byteOrder,
    "- Resolution: " + u.resolution + " x " + u.resolution,
    "- Flip Vertically: " + (u.flipVertically ? "ON (the file is north-first; Unity fills from the south edge)" : "off"),
    "- Terrain size: width " + u.width + ", length " + u.length + ", height " + u.height,
    "",
    "Check the orientation against heightmap.tif in QGIS (same samples as float32 metres, georeferenced) or heightmap-preview.png (black = lowest, white = highest) before building on it.",
    "",
    "## surfaces.geojson",
    "",
    "WGS84 GeoJSON. `kind` is one of terrain_frame, fairway, green, green_centre, tee, tee_area, bunker, water, woods, hazard, waste, hole_route. Point features carry x_m/z_m in the terrain frame. Load into QGIS and reproject to " + f.crs + " for the OPCD SVG/Blender steps.",
    "",
    "## trees.csv",
    "",
    m.trees.count + " trees (" + m.trees.inside + " inside the frame): position, frame metres, ground height, crown radius and height. height_source is `canopy` where the Meta/WRI canopy raster measured it (" + m.trees.measured + " trees), `estimated` (" + TREE_HEIGHT_PER_CROWN_RADIUS + " x crown radius) otherwise.",
    "",
    "## holes.csv",
    "",
    m.holes.count + " holes: tee and green with frame metres and ground heights, par and route length where the scorecard is known.",
    "",
    "## surfaces-opcd.svg",
    "",
    "The surfaces as the Inkscape SVG OPCD's mesher (Clender) takes: " + f.sideM + " x " + f.sideM + " mm at 1 mm = 1 m, top-left = the frame's north-west corner, one layer per OPCD class in the V4 palette ("
      + (m.opcdSvg ? Object.keys(m.opcdSvg.layers).join(", ") : "") + "). Same-class shapes are merged and clipped to the square; different classes may overlap, as OPCD blends them."
      + (m.opcdSvg && m.opcdSvg.teePadsDrawn ? " " + m.opcdSvg.teePadsDrawn + " tee pads are drawn from Clarity's tee points (" + TEE_PAD_M.width + "x" + TEE_PAD_M.length + " m along the line of play): size them to the real tees in Inkscape before submitting." : "")
      + " Rough, semi-rough, fringe and cart paths are not mapped in Clarity, so the background layer is plain rough. Use it with the OPCD web app's terrain square set to this frame's centre and side.",
    "",
    "## Provenance",
    ""
  ];
  if (m.terrain) {
    lines.push("- Elevation: " + (m.terrain.sourceIds || []).join(", ") + " at " + m.terrain.sourceResolutionM + " m (" + m.terrain.qualityClass + "), vertical datum " + m.terrain.verticalDatum + ", Clarity terrain v" + m.terrain.terrainVersion);
    (m.terrain.attribution || []).forEach(a => lines.push("  - " + a));
  }
  lines.push("- Surfaces and holes: the course's published Clarity geometry (OpenStreetMap contributors, ODbL, plus Studio edits)");
  lines.push("- Tree heights: Meta & World Resources Institute global canopy height, CC BY 4.0, where used");
  if (h.fallbackFraction > 0) lines.push("- " + round(h.fallbackFraction * 100, 1) + "% of the frame lies outside Clarity's terrain asset and was read for this export from " + h.groundBeyondAsset + ".");
  if (h.filledFraction > 0) lines.push("- " + round(h.filledFraction * 100, 1) + "% of the frame had no ground from any source and was nearest-filled; treat those edges as approximate.");
  (m.warnings || []).forEach(w => lines.push("- WARNING: " + w));
  return lines.join("\n") + "\n";
}
