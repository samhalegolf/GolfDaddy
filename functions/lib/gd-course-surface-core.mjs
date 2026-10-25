/* Course map core - the whole course as one surface, and the outline that trims it.

   The course is scanned hole by hole (functions/course-visual-worker-background.mjs): every
   hole's corridor and green are shot at their own zoom and published as that hole's frame.
   The course map is the same captures composited once over the whole course instead - the
   course backdrop underneath, every corridor and green over it at the course's zoom, the
   course terrain beside it - so there is one tidy asset to stand the whole course up from
   (Studio's 3D Course Viewer today, GPS Play's free roam next) rather than eighteen frames
   that overlap at their corners.

   THE OUTLINE. A polygon drawn round the course in Studio's 3D Course Viewer. Ground outside
   it is not the course - the neighbours' roofs, the road, the next club - and is cut away
   when the course map is drawn. Stored on course_visuals.course_boundary as
   {ring: [{lat, lng}], areaM2, savedBy, savedAt}. No outline: the whole surface shows.

   THE SURFACE. Stored on course_visuals.course_surface: the picture, its elevation and the
   mercator geometry that puts them back on the ground, shaped like a hole frame's
   playSurface so anything that stands a hole up can stand the course up the same way.
   Cropped to the outline (with a margin, so the outline can still be widened from what the
   picture shows) once there is one, the whole backdrop until then.

   Pure: no network, no sharp. dev/course-surface.test.mjs runs it. */

import { padBounds, mergeBounds, validBounds, point, packageHoleData } from "./gd-visual-plan-core.mjs";

/* The course_visual_jobs kind. Mirrored as a literal in functions/course-visual-jobs.mjs
   (which must not load this module on a player poll); dev/course-surface.test.mjs asserts
   the two agree. */
export const COURSE_SURFACE_KIND = "course_surface";
/* Folder under the course's own folder in the course-visuals bucket. */
export const COURSE_SURFACE_ROOT = "course-map";
/* Longest edge of the picture. Most GPUs' texture ceiling, and what the 3D viewer can hold
   in one texture (gd-course-3d.js MAX_PICTURE_PX): ~0.45 m a pixel on a 1.8 km course. */
export const COURSE_SURFACE_MAX_PX = 4096;
/* Longest edge of the elevation. The terrain asset's own samples are 1-5 m apart, so over
   the same ground this is never coarser than the source. */
export const COURSE_ELEVATION_MAX_PX = 2048;
/* Ground kept round the outline, so a cut that went too far can be pulled back out. */
export const COURSE_SURFACE_MARGIN_M = 60;
/* Bumped whenever how the surface is drawn changes, so a course re-renders rather than
   keeping a picture drawn the old way. */
export const COURSE_SURFACE_STAMP = "surface1";

export const BOUNDARY_MAX_POINTS = 400;
/* Smaller than any real course - a ring this small is a slip of the mouse. */
export const BOUNDARY_MIN_AREA_M2 = 5000;

const EARTH_M_PER_DEG = 111320;

function round(v, places) { const f = Math.pow(10, places); return Math.round(v * f) / f; }

/* ---------- the outline ------------------------------------------------------------------ */

/* Local metres round the ring's first point: plenty for a course-sized polygon. */
function localMetres(ring) {
  const lat0 = ring[0].lat, lng0 = ring[0].lng;
  const kx = EARTH_M_PER_DEG * Math.cos(lat0 * Math.PI / 180);
  return ring.map(p => [(p.lng - lng0) * kx, (p.lat - lat0) * EARTH_M_PER_DEG]);
}

export function ringAreaM2(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  const xy = localMetres(ring);
  let twice = 0;
  for (let i = 0; i < xy.length; i++) {
    const a = xy[i], b = xy[(i + 1) % xy.length];
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/* Does any edge cross another that is not its neighbour? A figure-of-eight has no inside. */
export function ringSelfIntersects(ring) {
  const xy = localMetres(ring), n = xy.length;
  for (let i = 0; i < n; i++) {
    const a = xy[i], b = xy[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(a, b, xy[j], xy[(j + 1) % n])) return true;
    }
  }
  return false;
}

/* An outline as it may be stored: 3 to BOUNDARY_MAX_POINTS real points, open (the last point
   is not the first again), no point repeated straight after itself, a real area and no edge
   crossing another. Throws with what is wrong. Coordinates kept to 7 places (~1 cm). */
export function normaliseBoundary(input) {
  const raw = Array.isArray(input) ? input : (input && Array.isArray(input.ring) ? input.ring : null);
  if (!raw) throw new Error("the outline must be a list of points");
  const ring = [];
  raw.forEach((value, i) => {
    const p = point(value);
    if (!p || Math.abs(p.lat) > 85 || Math.abs(p.lng) > 180) throw new Error("point " + (i + 1) + " of the outline is not a real coordinate");
    const q = { lat: round(p.lat, 7), lng: round(p.lng, 7) };
    const last = ring[ring.length - 1];
    if (!last || last.lat !== q.lat || last.lng !== q.lng) ring.push(q);
  });
  if (ring.length > 1 && ring[0].lat === ring[ring.length - 1].lat && ring[0].lng === ring[ring.length - 1].lng) ring.pop();
  if (ring.length < 3) throw new Error("the outline needs at least 3 points");
  if (ring.length > BOUNDARY_MAX_POINTS) throw new Error("the outline has " + ring.length + " points; " + BOUNDARY_MAX_POINTS + " at most");
  if (ringSelfIntersects(ring)) throw new Error("the outline crosses itself");
  const areaM2 = ringAreaM2(ring);
  if (areaM2 < BOUNDARY_MIN_AREA_M2) throw new Error("the outline encloses " + Math.round(areaM2) + " m² - too small to be a course");
  return { ring, areaM2: Math.round(areaM2) };
}

export function ringBounds(ring) {
  if (!Array.isArray(ring) || !ring.length) return null;
  return {
    south: Math.min(...ring.map(p => p.lat)), north: Math.max(...ring.map(p => p.lat)),
    west: Math.min(...ring.map(p => p.lng)), east: Math.max(...ring.map(p => p.lng))
  };
}

/* A short, stable name for an outline, so a surface records which outline it was cut to. */
export function boundaryHash(ring) {
  let hash = 5381;
  const s = (Array.isArray(ring) ? ring : []).map(p => p.lat.toFixed(7) + "," + p.lng.toFixed(7)).join(";");
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  return s ? hash.toString(36) : "";
}

/* ---------- the surface's ground --------------------------------------------------------- */

export function intersectBounds(a, b) {
  if (!validBounds(a) || !validBounds(b)) return null;
  const out = {
    south: Math.max(Number(a.south), Number(b.south)), north: Math.min(Number(a.north), Number(b.north)),
    west: Math.max(Number(a.west), Number(b.west)), east: Math.min(Number(a.east), Number(b.east))
  };
  return out.north > out.south && out.east > out.west ? out : null;
}

export function boundsIntersect(a, b) { return !!intersectBounds(a, b); }

/* The ground the surface covers. With an outline: the outline's box and a margin, kept to
   the ground that was shot (the backdrop) where the two overlap. Without: the backdrop, or
   every hole capture together when there is no backdrop. Null when there is nothing. */
export function surfaceExtent({ boundary = null, backdropBounds = null, captureBounds = [] } = {}) {
  const shot = validBounds(backdropBounds) ? backdropBounds : mergeBounds(captureBounds);
  if (boundary && Array.isArray(boundary.ring) && boundary.ring.length >= 3) {
    const around = padBounds(ringBounds(boundary.ring), COURSE_SURFACE_MARGIN_M);
    return (shot && intersectBounds(around, shot)) || around;
  }
  return shot || null;
}

/* Which captures land on the surface, drawn bottom to top the way the hole frames stack
   them (renderHoleSurfaceMercator sorts by stitchLayer): corridors, then greens. The
   backdrop is the underlay, not one of these. */
export function surfaceCaptures(entries, extent) {
  return (Array.isArray(entries) ? entries : []).filter(e => e && e.role !== "course-backdrop" && e.role !== "terrain-reference"
    && Number(e.holeNumber) > 0 && validBounds(e.bounds) && boundsIntersect(e.bounds, extent));
}

export function surfaceVersion(parts) {
  let hash = 5381;
  const s = JSON.stringify(Object.assign({ stamp: COURSE_SURFACE_STAMP, maxPx: COURSE_SURFACE_MAX_PX }, parts || {}));
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  return "s" + hash.toString(36);
}

/* ---------- the surface's elevation ------------------------------------------------------ */

/* Web-mercator x/y in 0..1 (y down). */
function mercX(lng) { return (Number(lng) + 180) / 360; }
function mercY(lat) {
  const s = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, Number(lat))) * Math.PI / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

/* The elevation's grid for a picture W x H px over ground metresAcross wide: the terrain's
   own spacing (sourceMetres), never finer than the picture and never past
   COURSE_ELEVATION_MAX_PX. Same aspect as the picture, so one metres-per-pixel serves both
   axes (mercator is conformal). */
export function elevationGrid(W, H, metresAcross, sourceMetres) {
  const longest = Math.max(W, H);
  const wanted = Math.round(longest * (metresAcross / W) / Math.max(0.5, Number(sourceMetres) || 1));
  const side = Math.max(16, Math.min(COURSE_ELEVATION_MAX_PX, longest, wanted));
  const scale = side / longest;
  const width = Math.max(2, Math.round(W * scale)), height = Math.max(2, Math.round(H * scale));
  return { width, height, metresPerPixel: metresAcross / width };
}

/* Heights over one mercator window, resampled onto another (bilinear, edge clamped). The
   terrain asset's grid never lines up with the picture's, and terrain-RGB cannot be resized
   as an image - a channel step averaged is a cliff - so the heights are moved as numbers and
   encoded again afterwards. */
export function resampleHeights(src, sw, sh, srcBounds, dstBounds, dw, dh) {
  const out = new Float32Array(dw * dh);
  const sx0 = mercX(srcBounds.west), sx1 = mercX(srcBounds.east);
  const sy0 = mercY(srcBounds.north), sy1 = mercY(srcBounds.south);
  const dx0 = mercX(dstBounds.west), dx1 = mercX(dstBounds.east);
  const dy0 = mercY(dstBounds.north), dy1 = mercY(dstBounds.south);
  const at = (x, y) => src[Math.min(sh - 1, Math.max(0, y)) * sw + Math.min(sw - 1, Math.max(0, x))];
  for (let j = 0; j < dh; j++) {
    const my = dy0 + (j + 0.5) / dh * (dy1 - dy0);
    const fy = (my - sy0) / (sy1 - sy0) * sh - 0.5;
    const y0 = Math.floor(fy), ty = fy - y0;
    for (let i = 0; i < dw; i++) {
      const mx = dx0 + (i + 0.5) / dw * (dx1 - dx0);
      const fx = (mx - sx0) / (sx1 - sx0) * sw - 0.5;
      const x0 = Math.floor(fx), tx = fx - x0;
      const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
      const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
      out[j * dw + i] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

export function heightRange(heights) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const v = heights[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? { min: round(min, 2), max: round(max, 2) } : { min: 0, max: 0 };
}

/* ---------- the record ------------------------------------------------------------------- */

/* Each hole's tee and green, for jumping round the course on the surface. */
export function surfaceHoles(pkg) {
  const data = packageHoleData(pkg);
  return Object.keys(data).map(Number).filter(n => n > 0).sort((a, b) => a - b).map(n => {
    const h = data[n] || {};
    const route = (Array.isArray(h.route) ? h.route : []).map(point).filter(Boolean);
    return {
      holeNumber: n,
      tee: point(h.tee && h.tee.position) || route[0] || null,
      green: point(h.green && h.green.position) || route[route.length - 1] || null
    };
  });
}

/* What course_visuals.course_surface holds. playSurface is a hole frame's playSurface in
   shape (originPx, captureZoom, outputDimensions, sourceBounds, elevation), so a consumer
   that can place a hole frame can place this. */
export function courseSurfaceRecord({ version, dir, frame, bytes, elevation = null, boundary = null, holes = [], extent, source = null, builtAt, jobId = null }) {
  const playSurface = {
    model: "mercator-image",
    projection: "mercator-image",
    scope: "course",
    sourceBounds: frame.bounds,
    captureZoom: frame.captureZoom,
    originPx: frame.originPx,
    outputDimensions: { width: frame.width, height: frame.height },
    anchorPins: { tee: null, green: null }
  };
  if (elevation) playSurface.elevation = elevation;
  return {
    version,
    path: dir + "/surface.jpg",
    width: frame.width,
    height: frame.height,
    bytes: bytes || null,
    bounds: frame.bounds,
    extent,
    boundaryHash: boundary ? boundaryHash(boundary.ring) : "",
    holes,
    playSurface,
    imagery: source ? { key: source.key || null, attribution: source.attribution || null } : null,
    builtAt,
    jobId
  };
}
