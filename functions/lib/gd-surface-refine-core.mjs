/* Surface shape refinement: OSM polygon as a GUIDE, our own imagery as the truth.

   The pipeline this belongs to writes surfaces from OpenStreetMap (gd-automapper-core.mjs's
   enrichSurfaceObjects). Those polygons are somebody else's tracing, at whatever fidelity they
   felt like, and we neither own them nor know how carefully they were drawn. What we DO own is
   the published hole frame - licensed imagery, already captured, already the pixels the player
   is looking at.

   So the guide is used for what it is genuinely good at - saying roughly where a feature is and
   roughly how big it should be - and the Green Wand (gd-green-shape-core.mjs) is run against
   the frame to find the actual edge. The candidate whose area lands closest to the guide's is
   the one kept, simplified to a handful of points.

   The result is lighter than the OSM ring, it is ours, and it is anchored to the imagery rather
   than to a stranger's trace. The guide's osmId is kept so a feature stays traceable back to
   what pointed us at it.

   WHAT THIS IS NOT: a detector. Measured on the Millbrook hole 1 frame, a fabricated guide
   placed over bare fairway refines happily (ratio 0.82, confidence 0.90, "Strong edge"), as
   does one over a car park (0.83 / 0.96 / "Strong edge"). Sixteen of the thirty-three REAL
   features on that hole score a lower edge difference than the car park does. Mown grass has
   stripes and car parks have cars, so neither the size match nor the edge metrics can tell a
   bunker from a driveway - and the size match least of all, since the sweep is explicitly
   searching for the guide's size and will find it on any pixels.

   So the guide is not merely a size hint: it is the evidence that the feature exists at all.
   This refines an edge somebody else already found. Where the guide is wrong about a feature
   being there, the output is a prettier wrong shape - no worse than the guide it replaced, but
   no better either. REFINE_ACCEPT_RATIO is a sanity bound for geometry the sweep could not get
   near, not a verification that anything was seen. */

import sharp from "sharp";
import { detect } from "./gd-green-shape-core.mjs";
import { projectPoint, unprojectPoint } from "./gd-visual-plan-core.mjs";
import { simplifyShape, shapeCentroid, cleanOsmShape, REFINED_SHAPE_SOURCE } from "./gd-automapper-core.mjs";

/* baseBubbleSize is the wand's only real scale control, and its default of 61 is green-sized:
   at 61 a Millbrook green came out 0.27x its guide and a bunker 2.87x. Calibrated against that
   frame, the value that lands on the guide is ~2.85x the guide's own radius in FRAME PIXELS -
   2.82 for the green (radius 35.5px -> 100), 2.88 for the bunker (13.9px -> 40). One ratio
   covers a 6.5x spread in feature size, so the sweep below starts there and only has to search
   a narrow band around it rather than guessing blind. */
export const BUBBLE_PER_GUIDE_RADIUS_PX = 2.85;
export const BUBBLE_SWEEP = [0.55, 0.7, 0.85, 1, 1.2, 1.45, 1.75];

/* A sanity bound, not a verification - see the header. Generous on the low side because the
   wand traces the MOWN surface and an OSM green ring often includes a collar it correctly
   leaves out. */
export const REFINE_ACCEPT_RATIO = { min: 0.6, max: 1.5 };
export const REFINE_MIN_CONFIDENCE = 0.5;
/* Crop window as a multiple of the guide's diameter. Wide enough that the true edge is inside
   the frame even when the guide is offset from it, tight enough that a neighbouring feature
   does not dominate. */
export const REFINE_CROP_SPAN = 3.2;
export const REFINE_CROP_MIN_PX = 96;

/* Lower than SURFACE_SHAPE_MAX_POINTS (16), because "lighter" is half the point of owning the
   shape and 16 was not: OSM's hole 1 rings average 12.9 points, so refining to 16 made the
   course 26% HEAVIER. The wand's output is a smooth radial blob and decimates far better than
   a hand-traced ring does - with the area-preserving resample above, 10 points holds the shape
   at roughly a fifth fewer points than the guide. */
export const REFINED_SHAPE_MAX_POINTS = 10;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* The wand returns a 144-point ring sampled radially from the seed, so dropping to every Nth
   point is already an even angular resample - but it is an INSCRIBED one, and it loses area
   every time: 10 points came out 12.8% smaller than 16 across hole 1, which would shrink every
   feature on the course. Scaling the survivors about the centroid to restore the original area
   removes that bias, and makes a genuinely small ring usable rather than merely smaller. */
export function resampleRing(ring, maxPoints) {
  const decimated = simplifyShape(ring, maxPoints);
  if (!decimated) return null;
  const before = polygonAreaM2(ring), after = polygonAreaM2(decimated);
  if (!(before > 0) || !(after > 0)) return decimated;
  const k = Math.sqrt(before / after);
  if (!Number.isFinite(k) || k <= 0) return decimated;
  /* Scaling lat and lng by the same factor in DEGREES scales the metric area by k^2: the
     cos(lat) that makes a lng degree shorter is constant across a feature this size, so it
     divides out of the ratio. No need to convert to metres and back. */
  const c = shapeCentroid(decimated);
  return decimated.map(p => ({ lat: c.lat + (p.lat - c.lat) * k, lng: c.lng + (p.lng - c.lng) * k }));
}

/* Shoelace on a local equirectangular projection about the ring's own centroid. Good to well
   under a percent at feature scale, and it needs no projection library. */
export function polygonAreaM2(shape) {
  const ring = cleanOsmShape(shape);
  if (!ring) return 0;
  const c = shapeCentroid(ring);
  const k = Math.cos(c.lat * Math.PI / 180);
  const pts = ring.map(p => ({ x: (p.lng - c.lng) * 111320 * k, y: (p.lat - c.lat) * 111320 }));
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a / 2);
}

/* A frame's playSurface carries the mercator origin of its top-left pixel and the zoom it was
   captured at, so frame pixels and lat/lng convert exactly - projectPoint on the frame's own
   sourceBounds reproduces originPx and outputDimensions to the pixel. */
export function frameProjector(playSurface) {
  const zoom = Number(playSurface && playSurface.captureZoom);
  const origin = playSurface && playSurface.originPx;
  const dims = (playSurface && playSurface.outputDimensions) || {};
  const width = Number(dims.width), height = Number(dims.height);
  if (!Number.isFinite(zoom) || !origin || !Number.isFinite(Number(origin.x)) || !Number.isFinite(Number(origin.y))
    || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  const ox = Number(origin.x), oy = Number(origin.y);
  return {
    width, height, zoom,
    toPx(point) {
      const p = projectPoint(Number(point.lat), Number(point.lng), zoom);
      return { x: p.x - ox, y: p.y - oy };
    },
    toLatLng(px) {
      return unprojectPoint(Number(px.x) + ox, Number(px.y) + oy, zoom);
    }
  };
}

/* The guide's radius in frame pixels, from its area rather than its longest spoke: a dogleg
   fairway polygon has a huge span and a modest area, and it is the area the wand is being
   matched against. */
function guideRadiusPx(guide, projector) {
  const areaM2 = polygonAreaM2(guide);
  if (!(areaM2 > 0)) return 0;
  const centre = shapeCentroid(guide);
  const a = projector.toPx(centre);
  const b = projector.toPx({ lat: centre.lat, lng: centre.lng + 0.001 });
  const metresPerPx = 0.001 * 111320 * Math.cos(centre.lat * Math.PI / 180) / Math.max(1e-9, Math.abs(b.x - a.x));
  return Math.sqrt(areaM2 / Math.PI) / metresPerPx;
}

/* image: the published hole frame, any format sharp reads.
   playSurface: that frame's metadata (originPx / captureZoom / outputDimensions).
   guideShape: the OSM ring for this feature.
   Returns {ok, shape, ratio, confidence, params, reason}. On ok:false the caller keeps the
   guide - see the module header. */
export async function refineSurfaceShape({ image, playSurface, guideShape, mode = "robustTonal", sweep = BUBBLE_SWEEP, maxPoints = REFINED_SHAPE_MAX_POINTS }) {
  const guide = cleanOsmShape(guideShape);
  if (!guide) return { ok: false, reason: "guide-not-a-polygon" };
  const projector = frameProjector(playSurface);
  if (!projector) return { ok: false, reason: "frame-has-no-projection" };
  const guideArea = polygonAreaM2(guide);
  const radiusPx = guideRadiusPx(guide, projector);
  if (!(guideArea > 0) || !(radiusPx > 0)) return { ok: false, reason: "guide-has-no-extent" };

  const centrePx = projector.toPx(shapeCentroid(guide));
  const span = Math.round(clamp(radiusPx * 2 * REFINE_CROP_SPAN, REFINE_CROP_MIN_PX, Math.min(projector.width, projector.height)));
  const left = Math.round(centrePx.x - span / 2), top = Math.round(centrePx.y - span / 2);
  /* Off the frame, or close enough to the edge that the crop would be clipped: the wand would
     be reading a truncated neighbourhood and the answer would not mean anything. */
  if (left < 0 || top < 0 || left + span > projector.width || top + span > projector.height) {
    return { ok: false, reason: "guide-outside-frame" };
  }
  const crop = await sharp(image).extract({ left, top, width: span, height: span }).png().toBuffer();
  const seed = { x: centrePx.x - left, y: centrePx.y - top };

  let best = null;
  for (const multiplier of sweep) {
    const baseBubbleSize = Math.round(radiusPx * BUBBLE_PER_GUIDE_RADIUS_PX * multiplier);
    if (!(baseBubbleSize > 0)) continue;
    const out = await detect({ image: crop, imageWidth: span, imageHeight: span, candidateCentrePx: seed, mode, baseBubbleSize });
    const ring = (out.polygonPixels || []).map(p => projector.toLatLng({ x: left + p.x, y: top + p.y }));
    const shape = ring.length >= 3 ? resampleRing(ring, maxPoints) : null;
    if (!shape) continue;
    const area = polygonAreaM2(shape);
    if (!(area > 0)) continue;
    const ratio = area / guideArea;
    const candidate = { shape, ratio, area, confidence: Number(out.confidence) || 0, baseBubbleSize, multiplier, mode };
    /* Closest to the guide in LOG area, so 2x over and 2x under are treated as equally wrong.
       Confidence only breaks ties - it is a weak signal on small features (flat ~0.97 across a
       4x bunker sweep) and must not be allowed to outvote the size match. */
    const score = c => Math.abs(Math.log(c.ratio));
    if (!best || score(candidate) < score(best) - 1e-9
      || (Math.abs(score(candidate) - score(best)) <= 1e-9 && candidate.confidence > best.confidence)) best = candidate;
  }

  if (!best) return { ok: false, reason: "wand-returned-no-polygon", guideArea };
  const params = { baseBubbleSize: best.baseBubbleSize, multiplier: best.multiplier, mode: best.mode, cropSpanPx: span, guideRadiusPx: radiusPx };
  if (best.ratio < REFINE_ACCEPT_RATIO.min || best.ratio > REFINE_ACCEPT_RATIO.max) {
    return { ok: false, reason: "no-size-match", ratio: best.ratio, confidence: best.confidence, guideArea, area: best.area, params };
  }
  if (best.confidence < REFINE_MIN_CONFIDENCE) {
    return { ok: false, reason: "low-confidence", ratio: best.ratio, confidence: best.confidence, guideArea, area: best.area, params };
  }
  return { ok: true, shape: best.shape, ratio: best.ratio, confidence: best.confidence, area: best.area, guideArea, params };
}

/* What a refined surface records about itself. The OSM id stays - it is what pointed us at the
   feature - but shapeSource says plainly that the geometry is no longer OSM's, which is what
   stops a later Collect Extra Objects run writing the OSM ring back over it (see
   upsertResolvedObject). Owned by gd-automapper-core.mjs, re-exported here for callers. */
export { REFINED_SHAPE_SOURCE };

export function applyRefinedShape(object, result) {
  if (!object || !result || !result.ok) return object;
  return Object.assign({}, object, {
    shape: result.shape,
    position: shapeCentroid(result.shape) || object.position,
    shapeSource: REFINED_SHAPE_SOURCE,
    refine: {
      ratio: Number(result.ratio.toFixed(3)),
      confidence: Number(result.confidence.toFixed(3)),
      points: result.shape.length,
      guidePoints: Array.isArray(object.shape) ? object.shape.length : null,
      baseBubbleSize: result.params.baseBubbleSize,
      mode: result.params.mode
    },
    updatedAt: new Date().toISOString()
  });
}

export const __surfaceRefineTest = { guideRadiusPx, clamp, resampleRing };
