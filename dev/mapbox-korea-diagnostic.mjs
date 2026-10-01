/* Live diagnostic: Mapbox Satellite + Terrain for an existing South Korean Clarity course.
 *
 * Uses the course's coordinates as stored in course_maps - nothing is searched or geocoded.
 * Needs network access to api.mapbox.com and MAPBOX_PUBLIC_TOKEN (a pk. token); without the
 * token it says so and exits 0, so it is safe to run anywhere.
 *
 *   MAPBOX_PUBLIC_TOKEN=pk... node dev/mapbox-korea-diagnostic.mjs [courseId] [--span=1600] [--out=dir]
 *
 * Writes <out>/<courseId>-satellite.jpg, -terrain.png and -report.json, and prints the report.
 * Then, to put the picture through the normal visual mapper: Studio -> Courses -> Map overlay,
 * pick the course, "Test Mapbox source", "AI scan this picture (dry run)". */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createMapboxProvider, mapboxStatus } from "../functions/lib/gd-mapbox-source.mjs";
import { acquireMapSources, provenanceFor } from "../functions/lib/gd-map-sources.mjs";
import { elevationAt, gridCentre, maxNeighbourStep } from "../functions/lib/gd-elevation-grid-core.mjs";
import { pixelToLatLng, latLngToPixel } from "../functions/lib/gd-tile-mosaic-core.mjs";
import { hillshade } from "../functions/lib/gd-relief-core.mjs";

/* Existing Korean rows in course_maps (read 2026-10-01). Both are loops of the same club near
   Yeoju, Gyeonggi-do. */
const KOREAN_COURSES = {
  "cc-37-178n-127-708e": { name: "황학(黃鶴)코스 | Par 36", lat: 37.1763557151634, lng: 127.704966807264 },
  "par-36": { name: "여강(驪江)코스 | Par 36", lat: 37.1799944802685, lng: 127.704865844647 }
};

const args = process.argv.slice(2);
const courseId = args.find(a => !a.startsWith("--")) || "cc-37-178n-127-708e";
const flag = (name, fallback) => { const hit = args.find(a => a.startsWith("--" + name + "=")); return hit ? hit.split("=").slice(1).join("=") : fallback; };
const spanM = Number(flag("span", 1600));
const outDir = flag("out", path.join(process.cwd(), "dev", "out", "mapbox-korea"));

const course = KOREAN_COURSES[courseId];
if (!course) { console.error("Unknown course " + courseId + " - one of: " + Object.keys(KOREAN_COURSES).join(", ")); process.exit(2); }

const status = mapboxStatus();
console.log("Mapbox token configured: " + (status.configured ? "yes" : "no" + (status.reason ? " (" + status.reason + ")" : "")));
if (!status.configured) { console.log("SKIPPED - set MAPBOX_PUBLIC_TOKEN to run the live diagnostic."); process.exit(0); }

const half = spanM / 2, dLat = half / 111320, dLng = half / (111320 * Math.cos(course.lat * Math.PI / 180));
const bounds = { north: course.lat + dLat, south: course.lat - dLat, west: course.lng - dLng, east: course.lng + dLng };

const provider = createMapboxProvider({ sharp });
const selection = { bounds, imagery: { provider, storable: false }, terrain: { provider, storable: false } };
const acquired = await acquireMapSources(selection, {
  imagery: { targetPx: 1568, maxOutputPx: 1568, maxPixels: 1100000 },
  terrain: { maxTiles: 16 }
});

const report = { course: { id: courseId, name: course.name, lat: course.lat, lng: course.lng }, requestedBounds: bounds };
fs.mkdirSync(outDir, { recursive: true });

if (acquired.imagery.ok) {
  const im = acquired.imagery.result;
  /* pixel -> lat/lng -> pixel at a spread of points, the georeferencing acceptance check. */
  const probes = [[0, 0], [im.width, 0], [0, im.height], [im.width, im.height], [im.width / 2, im.height / 2], [123.5, 456.25]];
  const worst = Math.max(...probes.map(([x, y]) => {
    const back = latLngToPixel(im.georef, pixelToLatLng(im.georef, { x, y }));
    return Math.hypot(back.x - x, back.y - y);
  }));
  const pin = latLngToPixel(im.georef, course);
  fs.writeFileSync(path.join(outDir, courseId + "-satellite.jpg"), im.image);
  report.satellite = {
    ok: true, product: im.source.product, zoom: im.zoom, pixelRatio: im.pixelRatio, tilesRequested: im.tilesRequested,
    width: im.width, height: im.height, metresPerPixel: Number(im.metresPerPixel.toFixed(3)), bounds: im.bounds,
    coursePinAtPixel: { x: Number(pin.x.toFixed(1)), y: Number(pin.y.toFixed(1)) },
    roundTripWorstPx: worst
  };
} else {
  report.satellite = { ok: false, error: acquired.imagery.error };
}

if (acquired.terrain.ok) {
  const g = acquired.terrain.result;
  const c = gridCentre(g);
  const shade = hillshade(g.heights, g.width, g.height, g.metresPerSample, { exaggeration: 3 });
  const bytes = Buffer.alloc(g.width * g.height);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(shade[i] * 255);
  fs.writeFileSync(path.join(outDir, courseId + "-terrain.png"), await sharp(bytes, { raw: { width: g.width, height: g.height, channels: 1 } }).png().toBuffer());
  report.terrain = {
    ok: true, product: g.source.product, zoom: g.zoom, tilesRequested: g.tilesRequested,
    width: g.width, height: g.height, metresPerSample: Number(g.metresPerSample.toFixed(2)),
    minElevation: Number(g.minElevation.toFixed(1)), maxElevation: Number(g.maxElevation.toFixed(1)),
    centreElevation: Number(elevationAt(g, c.lat, c.lng).toFixed(1)),
    coursePinElevation: Number(elevationAt(g, course.lat, course.lng).toFixed(1)),
    maxNeighbourStepM: Number(maxNeighbourStep(g).toFixed(2))
  };
} else {
  report.terrain = { ok: false, error: acquired.terrain.error };
}

report.provenance = provenanceFor(acquired);
fs.writeFileSync(path.join(outDir, courseId + "-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log("Wrote " + outDir);

/* Acceptance, loosely: both parts arrived, the transform round-trips, the terrain is plausible
   and smooth. A failure here is a finding, not a crash - the report above says which. */
const problems = [];
if (!report.satellite.ok) problems.push("satellite failed");
else if (report.satellite.roundTripWorstPx > 1e-6) problems.push("georef round trip off by " + report.satellite.roundTripWorstPx + "px");
if (!report.terrain.ok) problems.push("terrain failed");
else {
  if (report.terrain.minElevation < -50 || report.terrain.maxElevation > 2000) problems.push("implausible elevations for a Korean course");
  if (report.terrain.maxNeighbourStepM > 10) problems.push("terrain steps " + report.terrain.maxNeighbourStepM + "m between neighbours - a seam or misdecode?");
}
if (problems.length) { console.error("PROBLEMS: " + problems.join("; ")); process.exit(1); }
console.log("OK");
