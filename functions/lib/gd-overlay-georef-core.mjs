/* Pixel -> lat/lng for shapes an AI reads off a satellite image, into overlay features.
 *
 * The AI sees a picture. It answers in that picture's pixels: "the fairway is this polygon,
 * the green is that blob". Nothing in the picture says where on Earth it is, so the caller has
 * to say - and the answer is only as good as that georeference. This module is the one place
 * the conversion lives, so the AI writer, Studio and any test agree on it to the pixel.
 *
 * Three ways to say where an image is, in order of exactness:
 *
 *   playSurface  - a published hole frame's own metadata: originPx (the mercator pixel of its
 *                  top-left corner), captureZoom, outputDimensions. Exact; this is how the
 *                  green wand already maps frame pixels to the ground (gd-surface-refine-core).
 *   centre+zoom  - a capture taken from a live map (Leaflet, Esri, a screenshot): the point at
 *                  the middle of the image and the zoom it was rendered at. `scale` is the
 *                  device pixel ratio when the image is a retina capture. Exact for any web
 *                  mercator map, which is every tile map this app plays over.
 *   bounds       - north/south/east/west of the image's edges. Exact in the vertical too,
 *                  because the interpolation is done in mercator space, not in degrees: a
 *                  linear lat interpolation would be off by metres across a course-sized frame.
 *
 * Pixel origin is the image's top-left corner, x right, y down, in the image's own pixels.
 * The AI may also answer in fractions of the image (0..1) or percent - `units` says which;
 * nothing here guesses, because a fairway at (0.4, 0.6) and one at pixel (0.4, 0.6) are both
 * valid inputs with very different meanings.
 *
 * What comes out is the overlay feature list gd-map-overlay-core.mjs stores and the mapper
 * reads: {id, kind, hole, points:[{lat,lng}], source}. Everything the mapper does after that -
 * linking fairways to greens, numbering from the scorecard - is unchanged and untouched.
 */

import { projectPoint, unprojectPoint } from "./gd-visual-plan-core.mjs";
import { normalizeOverlayFeatures, OVERLAY_KINDS, overlayKindIsPolygon } from "./gd-map-overlay-core.mjs";

export const AI_OVERLAY_SOURCE = "ai";
/* How far outside the image a returned point may sit and still be kept. An AI tracing a
   fairway that runs off the edge legitimately puts a vertex on the edge, and rounding puts it
   a pixel past it; a vertex 20% outside the image is a hallucination. */
export const EDGE_TOLERANCE = 0.02;

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }

/* ---------- the georeference ---------- */

/* Builds the projector, or returns {error} saying which field was missing - the caller is an
   API or a job that wants to put that sentence on a row, not a stack trace. */
export function imageGeoreference(ref) {
  if (!ref || typeof ref !== "object") return { error: "georef required" };
  const playSurface = ref.playSurface || (ref.originPx ? ref : null);
  const dims = (playSurface && playSurface.outputDimensions) || ref.outputDimensions || ref;
  const width = num(dims.width), height = num(dims.height);
  if (!width || !height || width <= 0 || height <= 0) return { error: "georef needs the image width and height in pixels" };

  /* 1. A published frame's own metadata. */
  if (playSurface && playSurface.originPx) {
    const zoom = num(playSurface.captureZoom != null ? playSurface.captureZoom : playSurface.zoom);
    const ox = num(playSurface.originPx.x), oy = num(playSurface.originPx.y);
    if (zoom == null || ox == null || oy == null) return { error: "playSurface needs originPx {x,y} and captureZoom" };
    return projector("playSurface", width, height, zoom, ox, oy);
  }

  /* 2. Centre + zoom, as a live map reports its view. */
  const centre = ref.centre || ref.center;
  if (centre) {
    const lat = num(centre.lat), lng = num(centre.lng != null ? centre.lng : centre.lon);
    const zoom = num(ref.zoom);
    const scale = num(ref.scale) || 1;
    if (lat == null || lng == null) return { error: "centre needs lat and lng" };
    if (zoom == null) return { error: "centre georef needs the zoom the image was rendered at" };
    if (scale <= 0) return { error: "scale must be positive" };
    /* A retina capture at z17 with scale 2 holds the ground of z18: twice the pixels per
       tile. Folding the scale into the zoom keeps one code path for both. */
    const effectiveZoom = zoom + Math.log2(scale);
    const c = projectPoint(lat, lng, effectiveZoom);
    return projector("centre", width, height, effectiveZoom, c.x - width / 2, c.y - height / 2);
  }

  /* 3. Edge bounds. Interpolated in mercator, so the vertical is as exact as the horizontal. */
  const bounds = ref.bounds || ref;
  const north = num(bounds.north), south = num(bounds.south), east = num(bounds.east), west = num(bounds.west);
  if ([north, south, east, west].some(v => v == null)) return { error: "georef needs playSurface, centre+zoom, or bounds {north,south,east,west}" };
  if (!(north > south) || !(east > west)) return { error: "bounds must have north > south and east > west" };
  /* Any zoom works for the maths; a high one keeps the origin arithmetic well inside double
     precision for a course-sized frame at any latitude. Non-square pixels are allowed: an
     image whose aspect does not match its bounds is stretched, not refused, because the
     bounds are the caller's claim about the picture and the maths honours it. */
  const zoom = 22;
  const nw = projectPoint(north, west, zoom);
  const se = projectPoint(south, east, zoom);
  const sx = (se.x - nw.x) / width, sy = (se.y - nw.y) / height;
  return {
    mode: "bounds", width, height, zoom,
    toLatLng(px) { return unprojectPoint(nw.x + Number(px.x) * sx, nw.y + Number(px.y) * sy, zoom); },
    toPx(point) { const p = projectPoint(Number(point.lat), Number(point.lng), zoom); return { x: (p.x - nw.x) / sx, y: (p.y - nw.y) / sy }; },
    metresPerPixel: metresPerPixelAt((north + south) / 2, zoom) * Math.max(Math.abs(sx), Math.abs(sy))
  };
}

function projector(mode, width, height, zoom, ox, oy) {
  const mid = unprojectPoint(ox + width / 2, oy + height / 2, zoom);
  return {
    mode, width, height, zoom,
    toLatLng(px) { return unprojectPoint(ox + Number(px.x), oy + Number(px.y), zoom); },
    toPx(point) { const p = projectPoint(Number(point.lat), Number(point.lng), zoom); return { x: p.x - ox, y: p.y - oy }; },
    metresPerPixel: metresPerPixelAt(mid.lat, zoom)
  };
}

function metresPerPixelAt(lat, zoom) {
  return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
}

/* What to tell the AI about the picture, so its answer can be checked and so it knows what a
   pixel is worth: a 25m green is 9px at 2.8m/px and 45px at 0.55m/px, and a model told that
   draws it at the right size. */
export function georefSummary(georef) {
  if (!georef || georef.error) return null;
  const nw = georef.toLatLng({ x: 0, y: 0 });
  const se = georef.toLatLng({ x: georef.width, y: georef.height });
  return {
    mode: georef.mode,
    width: georef.width,
    height: georef.height,
    metresPerPixel: Math.round(georef.metresPerPixel * 1000) / 1000,
    bounds: { north: nw.lat, south: se.lat, west: nw.lng, east: se.lng },
    centre: georef.toLatLng({ x: georef.width / 2, y: georef.height / 2 })
  };
}

/* ---------- the AI's answer ---------- */

const KIND_ALIASES = {
  fairway: "fairway", fairways: "fairway", fairway_area: "fairway",
  green: "green", greens: "green", putting_green: "green",
  hole: "hole", hole_line: "hole", centreline: "hole", centerline: "hole", line: "hole"
};

function pixelPoint(raw) {
  if (!raw) return null;
  const x = num(Array.isArray(raw) ? raw[0] : (raw.x != null ? raw.x : raw.px));
  const y = num(Array.isArray(raw) ? raw[1] : (raw.y != null ? raw.y : raw.py));
  return x == null || y == null ? null : { x, y };
}

/* Fractions and percents are scaled to pixels here, once, so everything below is in pixels. */
function toPixels(point, units, georef) {
  if (units === "fraction") return { x: point.x * georef.width, y: point.y * georef.height };
  if (units === "percent") return { x: point.x / 100 * georef.width, y: point.y / 100 * georef.height };
  return point;
}

function insideImage(px, georef) {
  const padX = georef.width * EDGE_TOLERANCE, padY = georef.height * EDGE_TOLERANCE;
  return px.x >= -padX && px.x <= georef.width + padX && px.y >= -padY && px.y <= georef.height + padY;
}

/* The AI's features, however it spelt them, into overlay features. Tolerant on names (an
   answer that says "type":"fairways" with "polygon":[[x,y],...] is what a model writes when
   the prompt was loose) and strict on meaning: a point outside the image is dropped, a shape
   left with too few points is dropped, and every drop is reported by index with a reason so
   the caller can see what the model got wrong rather than just count what survived. */
export function aiShapesToOverlay(answer, georefInput, options = {}) {
  const georef = georefInput && typeof georefInput.toLatLng === "function" ? georefInput : imageGeoreference(georefInput);
  if (!georef || georef.error) return { features: [], dropped: [], error: (georef && georef.error) || "georef required" };
  const units = String(options.units || (answer && answer.units) || "px").toLowerCase();
  if (!["px", "pixels", "fraction", "percent"].includes(units)) return { features: [], dropped: [], error: "units must be px, fraction or percent" };
  const unit = units === "pixels" ? "px" : units;
  const list = Array.isArray(answer) ? answer : (answer && (answer.features || answer.shapes || answer.objects)) || [];
  const dropped = [];
  const features = [];
  (Array.isArray(list) ? list : []).forEach((raw, index) => {
    if (!raw || typeof raw !== "object") { dropped.push({ index, reason: "not an object" }); return; }
    const kindRaw = String(raw.kind || raw.type || raw.class || raw.label || "").toLowerCase().trim();
    const kind = KIND_ALIASES[kindRaw];
    if (!kind || !OVERLAY_KINDS.has(kind)) { dropped.push({ index, reason: "unknown kind: " + (kindRaw || "(none)") }); return; }
    const rawPoints = raw.points || raw.polygon || raw.pixels || raw.coordinates || raw.ring || raw.line || [];
    const pixels = (Array.isArray(rawPoints) ? rawPoints : []).map(pixelPoint).filter(Boolean).map(p => toPixels(p, unit, georef));
    const outside = pixels.filter(p => !insideImage(p, georef)).length;
    const kept = pixels.filter(p => insideImage(p, georef));
    const minPoints = overlayKindIsPolygon(kind) ? 3 : 2;
    if (kept.length < minPoints) {
      dropped.push({ index, reason: (pixels.length ? (outside ? outside + " of " + pixels.length + " points outside the image" : "too few points") : "no points") });
      return;
    }
    const hole = num(raw.hole != null ? raw.hole : raw.holeNumber);
    features.push({
      id: raw.id ? String(raw.id) : kind + "-ai-" + (index + 1),
      kind,
      hole: hole && Number.isInteger(hole) && hole >= 1 && hole <= 36 ? hole : null,
      points: kept.map(p => georef.toLatLng(p)),
      source: AI_OVERLAY_SOURCE,
      /* Kept so the feature can be drawn back over the SAME image for a person to check; the
         overlay store does not keep it. */
      pixels: kept,
      partial: outside > 0 || undefined
    });
  });
  /* The overlay's own normaliser has the final say on what a feature is - same rules as a
     hand-drawn one, so an AI shape that would be refused at the API is refused here too. */
  const normalized = normalizeOverlayFeatures(features);
  const kept = new Set(normalized.map(f => f.id));
  features.forEach((f, i) => { if (!kept.has(f.id)) dropped.push({ index: i, reason: "refused by the overlay normaliser" }); });
  return {
    features: normalized,
    pixels: features.filter(f => kept.has(f.id)).map(f => ({ id: f.id, kind: f.kind, pixels: f.pixels, partial: !!f.partial })),
    dropped,
    georef: georefSummary(georef)
  };
}

/* The other direction, for checking: overlay features (or any {lat,lng} shapes) back onto the
   image, so a reviewer can see the AI's answer over the picture it came from. */
export function overlayToPixels(features, georefInput) {
  const georef = georefInput && typeof georefInput.toLatLng === "function" ? georefInput : imageGeoreference(georefInput);
  if (!georef || georef.error) return [];
  return normalizeOverlayFeatures(features).map(f => ({ id: f.id, kind: f.kind, hole: f.hole, pixels: f.points.map(p => georef.toPx(p)) }));
}
