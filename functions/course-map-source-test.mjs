/* Map source test: fetch one course's imagery and terrain from a chosen source and report
 * exactly what came back. Admin only, DEV/TEST path.
 *
 * POST {courseId, imagery?: "auto"|"existing"|"mapbox", terrain?: same, bounds?, spanM?}
 *   bounds - {north,south,east,west}, normally the Studio map's current view. Without it a
 *            spanM square (default 1600m) is drawn around the course's own stored location.
 *            The course's coordinates come from course_maps - nothing here searches or
 *            geocodes, with Mapbox or anyone else.
 * -> 200 {course, requestedBounds, sources, imagery, terrain, provenance}
 *    imagery: {ok, provider, product, storable, zoom, tilesRequested, width, height, bounds,
 *              metresPerPixel, georef, image:{mediaType,data}} or {ok:false, error}
 *    terrain: {ok, provider, product, zoom, tilesRequested, width, height, metresPerSample,
 *              minElevation, maxElevation, centre:{lat,lng,elevation}, maxNeighbourStep,
 *              preview:{mediaType,data}} or {ok:false, error}
 *
 * Nothing is stored. The picture goes back to the browser, which can hand it to the normal AI
 * scan (course-map-ai-scan.mjs) - and a picture from a non-storable source (Mapbox) is always
 * scanned as a dry run there, so its shapes are shown and never saved.
 *
 * The picture is sized to the AI scan's own limits (long side 1568px, ~1.1MP) so what is
 * tested here is exactly what the scan would read. */

import sharp from "sharp";
import { hasSupabase, slug, verifiedAdminEmail, loadCourse, json } from "./lib/gd-map-overlay-store.mjs";
import { resolveMapSources, acquireMapSources, provenanceFor, normaliseChoice } from "./lib/gd-map-sources.mjs";
import { mapboxStatus } from "./lib/gd-mapbox-source.mjs";
import { elevationAt, gridCentre, maxNeighbourStep } from "./lib/gd-elevation-grid-core.mjs";
import { hillshade } from "./lib/gd-relief-core.mjs";
import { validBounds } from "./lib/gd-tile-mosaic-core.mjs";

const DEFAULT_SPAN_M = 1600;
const MAX_SPAN_M = 4000;
const AI_MAX_EDGE_PX = 1568;
const AI_MAX_PIXELS = 1100000;
const M_PER_DEG_LAT = 111320;

function boundsAround(lat, lng, spanM) {
  const half = spanM / 2;
  const dLat = half / M_PER_DEG_LAT;
  const dLng = half / (M_PER_DEG_LAT * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
  return { north: lat + dLat, south: lat - dLat, west: lng - dLng, east: lng + dLng };
}

function spanM(b) {
  const midLat = (b.north + b.south) / 2;
  return Math.max((b.north - b.south) * M_PER_DEG_LAT, (b.east - b.west) * M_PER_DEG_LAT * Math.cos(midLat * Math.PI / 180));
}

/* A quick look at the terrain, not a product: hillshade of the grid, exaggerated so a few
   metres of fall reads at all. */
async function terrainPreview(grid) {
  const shade = hillshade(grid.heights, grid.width, grid.height, grid.metresPerSample, { exaggeration: 3 });
  const bytes = Buffer.alloc(grid.width * grid.height);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(shade[i] * 255);
  const png = await sharp(bytes, { raw: { width: grid.width, height: grid.height, channels: 1 } }).png().toBuffer();
  return { mediaType: "image/png", data: png.toString("base64") };
}

const round = (v, dp) => v == null ? null : Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp);

export default async function courseMapSourceTest(req) {
  if (req.method === "OPTIONS") return json(204, null);
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  const admin = await verifiedAdminEmail(req);
  if (!admin) return json(403, { error: "Admin verification failed" });

  let payload;
  try { payload = await req.json(); } catch (e) { return json(400, { error: "Invalid JSON" }); }
  const courseId = slug(payload && (payload.courseId || payload.course_id));
  if (!courseId) return json(400, { error: "courseId required" });
  const course = await loadCourse(courseId);
  if (!course) return json(404, { error: "no course_maps row for " + courseId });
  if (course.lat == null || course.lng == null) return json(422, { error: "this course has no stored location" });

  let bounds = payload.bounds && validBounds(payload.bounds)
    ? { north: Number(payload.bounds.north), south: Number(payload.bounds.south), east: Number(payload.bounds.east), west: Number(payload.bounds.west) }
    : boundsAround(course.lat, course.lng, Math.min(MAX_SPAN_M, Math.max(200, Number(payload.spanM) || DEFAULT_SPAN_M)));
  if (spanM(bounds) > MAX_SPAN_M) return json(400, { error: "bounds too large", detail: "Zoom in - the test reads at most " + MAX_SPAN_M + "m across." });

  const request = { imagery: normaliseChoice(payload.imagery), terrain: normaliseChoice(payload.terrain) };
  const selection = resolveMapSources(request, { bounds });
  /* Says whether, never what - see gd-mapbox-source mapboxStatus. */
  const mapbox = mapboxStatus();
  console.log("[map-source-test] " + courseId + " imagery=" + request.imagery + " terrain=" + request.terrain + " · Mapbox token configured: " + (mapbox.configured ? "yes" : "no"));

  const acquired = await acquireMapSources(selection, {
    imagery: { targetPx: AI_MAX_EDGE_PX, maxOutputPx: AI_MAX_EDGE_PX, maxPixels: AI_MAX_PIXELS },
    terrain: { maxTiles: 16 }
  });

  let imagery;
  if (acquired.imagery.ok) {
    const r = acquired.imagery.result;
    imagery = {
      ok: true, provider: r.source.provider, product: r.source.product, label: r.source.label,
      attribution: r.source.attribution, storable: !!selection.imagery.storable,
      zoom: r.zoom, pixelRatio: r.pixelRatio, tilesRequested: r.tilesRequested,
      width: r.width, height: r.height, bounds: r.bounds, requestedBounds: r.requestedBounds,
      metresPerPixel: round(r.metresPerPixel, 3), georef: r.georef, fetchedAt: r.fetchedAt,
      image: { mediaType: r.mediaType, data: r.image.toString("base64") }
    };
  } else {
    imagery = { ok: false, choice: request.imagery, error: acquired.imagery.error };
  }

  let terrain;
  if (acquired.terrain.ok) {
    const g = acquired.terrain.result;
    const c = gridCentre(g);
    const courseElevation = elevationAt(g, course.lat, course.lng);
    let preview = null;
    try { preview = await terrainPreview(g); } catch (e) { preview = null; }
    terrain = {
      ok: true, provider: g.source.provider, product: g.source.product, label: g.source.label,
      attribution: g.source.attribution, storable: !!selection.terrain.storable,
      zoom: g.zoom, tilesRequested: g.tilesRequested, width: g.width, height: g.height,
      bounds: g.bounds, metresPerSample: round(g.metresPerSample, 2), encoding: g.encoding,
      minElevation: round(g.minElevation, 1), maxElevation: round(g.maxElevation, 1),
      centre: { lat: c.lat, lng: c.lng, elevation: round(elevationAt(g, c.lat, c.lng), 1) },
      courseLocationElevation: round(courseElevation, 1),
      maxNeighbourStep: round(maxNeighbourStep(g), 2),
      fetchedAt: g.fetchedAt, preview
    };
  } else {
    terrain = { ok: false, choice: request.terrain, error: acquired.terrain.error };
  }

  return json(200, {
    course: { id: course.courseId, name: course.name, lat: course.lat, lng: course.lng },
    requestedBounds: bounds,
    sources: { imagery: request.imagery, terrain: request.terrain, mapboxConfigured: mapbox.configured, mapboxReason: mapbox.reason },
    imagery, terrain,
    provenance: Object.assign(provenanceFor(acquired), { storable: !!(selection.imagery.storable && imagery.ok) })
  });
}

export const config = {
  path: "/api/course-map-source-test"
};
