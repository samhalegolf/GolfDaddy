/* Visual engine capture planning, portable to Node.
   Faithful port of the browser plan logic (gd-course-visual-engine.js capturePolicy /
   planCourseVisualCaptures + the v19 camera's pixel-rect and tile enumeration), with
   Leaflet's projection replaced by standard spherical-mercator math. Input is the published
   course package exactly as stored in Supabase course_maps (objects_json / holes_json).
   Zoom policies, tile budgets, bleeds, and corridor segmentation mirror the browser so a
   server snapshot frames the course the same way the in-browser scan does. */

import { exportImageUrl } from "./gd-imagery-sources.mjs";

/* Capture policies describe FRAMING - zoom, bleed, lens, budget. They no longer name a tile
   source: which imagery a course may be shot from is a licensing decision resolved per region
   in gd-imagery-sources.mjs and handed to captureGrid. A policy that hardcoded an endpoint
   would route straight around that gate, which is exactly how Esri's display-only tiles ended
   up baked into stored frames. */
export function capturePolicy(role) {
  role = String(role || "");
  const mobileHoleLens = { captureLens: "mobile-hole", lensShape: "mobile-hole", lensAspectRatio: 9 / 16, lensOrientation: "play-axis", lensFit: "expand-bounds" };
  const greenSquareLens = { captureLens: "green-square", lensShape: "green-square", lensAspectRatio: 1, lensOrientation: "map-axis", lensFit: "expand-bounds" };
  if (role === "green-surround") return Object.assign({ role, label: "Super HD green surrounds", quality: "super-hd", targetZoom: 20, minZoom: 20, maxZoom: 20, maxTiles: 220, bleedMeters: 26, bleedPx: 220, stitchLayer: 30, fixedZoom: true }, greenSquareLens);
  if (role === "play-corridor") return Object.assign({ role, label: "HD play corridor", quality: "hd", targetZoom: 19, minZoom: 19, maxZoom: 19, maxTiles: 320, bleedMeters: 32, bleedPx: 220, stitchLayer: 20, fixedZoom: true, maxSegmentMeters: 320, segmentOverlapMeters: 42, maxSegments: 6 }, mobileHoleLens);
  if (role === "terrain-reference") return { role, label: "Terrain relief reference", quality: "terrain-map", targetZoom: 16, minZoom: 14, maxZoom: 17, maxTiles: 260, bleedMeters: 130, bleedPx: 380, stitchLayer: 5, terrainStageOnly: true };
  return { role: "course-backdrop", label: "Live map underlay", quality: "live-map-base", targetZoom: 17, minZoom: 16, maxZoom: 18, maxTiles: 260, bleedMeters: 120, bleedPx: 420, stitchLayer: 0 };
}

/* ---------- geometry (matches browser math, plain {lat,lng} + {south,west,north,east}) --- */

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
export function point(value) {
  if (!value) return null;
  const lat = num(value.lat !== undefined ? value.lat : value.latitude);
  const lng = num(value.lng !== undefined ? value.lng : (value.lon !== undefined ? value.lon : value.longitude));
  return lat != null && lng != null ? { lat, lng } : null;
}
function points(list) { return (Array.isArray(list) ? list : []).map(point).filter(Boolean); }
export function validBounds(b) {
  return !!(b && num(b.south) != null && num(b.west) != null && num(b.north) != null && num(b.east) != null && b.north >= b.south && b.east >= b.west);
}
export function boundsFromPoints(list) {
  const pts = points(list);
  if (!pts.length) return null;
  const lats = pts.map(p => p.lat), lngs = pts.map(p => p.lng);
  return { south: Math.min(...lats), west: Math.min(...lngs), north: Math.max(...lats), east: Math.max(...lngs) };
}
export function mergeBounds(list) {
  const values = (Array.isArray(list) ? list : []).filter(validBounds);
  if (!values.length) return null;
  return {
    south: Math.min(...values.map(b => Number(b.south))),
    west: Math.min(...values.map(b => Number(b.west))),
    north: Math.max(...values.map(b => Number(b.north))),
    east: Math.max(...values.map(b => Number(b.east)))
  };
}
export function padBounds(bounds, meters) {
  if (!validBounds(bounds)) return null;
  const pad = Math.max(0, Number(meters) || 0);
  const centerLat = (Number(bounds.south) + Number(bounds.north)) / 2;
  const latPad = pad / 111320;
  const lngPad = pad / (111320 * Math.max(0.18, Math.cos(centerLat * Math.PI / 180)));
  return { south: Number(bounds.south) - latPad, west: Number(bounds.west) - lngPad, north: Number(bounds.north) + latPad, east: Number(bounds.east) + lngPad };
}
export function boundsSpanM(bounds) {
  if (!validBounds(bounds)) return { width: 0, height: 0, diag: 0 };
  const centerLat = ((Number(bounds.south) + Number(bounds.north)) / 2) * Math.PI / 180;
  const width = Math.abs(Number(bounds.east) - Number(bounds.west)) * 111320 * Math.max(0.18, Math.cos(centerLat));
  const height = Math.abs(Number(bounds.north) - Number(bounds.south)) * 111320;
  return { width, height, diag: Math.sqrt(width * width + height * height) };
}
function distanceMeters(a, b) {
  a = point(a); b = point(b);
  if (!a || !b) return 0;
  const lat = (a.lat + b.lat) / 2 * Math.PI / 180;
  const dx = (b.lng - a.lng) * 111320 * Math.max(0.18, Math.cos(lat));
  const dy = (b.lat - a.lat) * 111320;
  return Math.sqrt(dx * dx + dy * dy);
}
function routeLengthMeters(route) {
  route = points(route);
  let total = 0;
  for (let i = 1; i < route.length; i++) total += distanceMeters(route[i - 1], route[i]);
  return total;
}
function dedupeRoutePoints(list) {
  const out = [];
  points(list).forEach(p => {
    const last = out[out.length - 1];
    if (!last || distanceMeters(last, p) > 0.75) out.push(p);
  });
  return out;
}
function pointAtRouteDistance(route, meters) {
  route = points(route);
  if (!route.length) return null;
  const target = Math.max(0, Number(meters) || 0);
  let walked = 0;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i], seg = distanceMeters(a, b);
    if (seg <= 0) continue;
    if (walked + seg >= target) {
      const t = Math.min(1, Math.max(0, (target - walked) / seg));
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
    walked += seg;
  }
  return route[route.length - 1];
}
function routeSegmentPoints(route, startM, endM) {
  route = points(route);
  const out = [];
  const start = Math.max(0, Number(startM) || 0), end = Math.max(start, Number(endM) || start);
  const startPoint = pointAtRouteDistance(route, start);
  const endPoint = pointAtRouteDistance(route, end);
  if (startPoint) out.push(startPoint);
  let total = 0;
  for (let i = 1; i < route.length - 1; i++) {
    total += distanceMeters(route[i - 1], route[i]);
    if (total > start && total < end) out.push(route[i]);
  }
  if (endPoint) out.push(endPoint);
  return dedupeRoutePoints(out);
}

/* ---------- package -> per-hole play data ------------------------------------------------ */

export function packageHoleData(pkg) {
  const objects = pkg && pkg.objects || {};
  const byHole = {};
  Object.keys(objects).forEach(key => {
    const object = objects[key] || {};
    const holeNumber = Math.round(Number(object.holeNumber) || 0);
    if (!holeNumber) return;
    const slot = byHole[holeNumber] = byHole[holeNumber] || { tee: null, green: null, fairways: [], greenShape: [] };
    if (object.type === "tee" && !slot.tee) slot.tee = point(object.position);
    else if (object.type === "green" && !slot.green) {
      slot.green = point(object.position);
      slot.greenShape = points(object.greenShape || object.shape);
    } else if (object.type === "fairway") {
      const p = point(object.position);
      if (p) slot.fairways.push(p);
    }
  });
  Object.keys(pkg && pkg.holes || {}).forEach(key => {
    const hole = pkg.holes[key] || {};
    const holeNumber = Math.round(Number(hole.holeNumber) || Number(key) || 0);
    if (!holeNumber) return;
    const slot = byHole[holeNumber] = byHole[holeNumber] || { tee: null, green: null, fairways: [], greenShape: [] };
    if (!slot.green) slot.green = point(hole.greenCenter || hole.greenCentre);
    if (!slot.greenShape.length) slot.greenShape = points(hole.greenShape);
  });
  const out = {};
  Object.keys(byHole).map(Number).sort((a, b) => a - b).forEach(holeNumber => {
    const slot = byHole[holeNumber];
    const route = dedupeRoutePoints([slot.tee, ...slot.fairways, slot.green].filter(Boolean));
    // Play-ready rule: a green plus at least one more point.
    if (!slot.green || route.length < 2) return;
    out[holeNumber] = {
      holeNumber,
      tee: slot.tee ? { position: slot.tee } : null,
      green: { position: slot.green, center: slot.green, greenShape: slot.greenShape, shape: slot.greenShape },
      route,
      greenShape: slot.greenShape
    };
  });
  return out;
}

function holeAnchorPins(holeData) {
  if (!holeData) return { tee: null, green: null, route: [], greenShape: [] };
  const route = points(holeData.route);
  return {
    tee: point(holeData.tee && holeData.tee.position) || route[0] || null,
    green: point(holeData.green && holeData.green.position) || route[route.length - 1] || null,
    route,
    greenShape: points(holeData.greenShape)
  };
}
function holeCaptureAnchorPins(holeData, role, extra) {
  if (role !== "play-corridor" && role !== "three-d-hole-beta") return null;
  const anchors = holeAnchorPins(holeData);
  let route = anchors.route;
  if (!route.length && anchors.tee && anchors.green) route = [anchors.tee, anchors.green];
  let segmentRoute = route;
  const start = num(extra && extra.segmentStartMeters), end = num(extra && extra.segmentEndMeters);
  if (route.length >= 2 && start != null && end != null && end > start) segmentRoute = routeSegmentPoints(route, start, end);
  if (!segmentRoute.length) segmentRoute = route;
  const count = Number(extra && extra.segmentCount) || 0, index = Number(extra && extra.segmentIndex) || 0;
  const isLast = !count || !index || index >= count;
  return {
    tee: segmentRoute[0] || anchors.tee || null,
    green: segmentRoute[segmentRoute.length - 1] || anchors.green || null,
    route: segmentRoute,
    greenShape: isLast ? anchors.greenShape : []
  };
}
function splitBoundsAlongRoute(bounds, holeData, policy) {
  if (!validBounds(bounds)) return [];
  const route = holeData ? points(holeData.route) : [];
  const length = routeLengthMeters(route);
  const maxSegment = Number(policy && policy.maxSegmentMeters) || 0;
  if (route.length < 2 || !maxSegment || length <= maxSegment) return [{ bounds, segmentIndex: 1, segmentCount: 1, routeLengthMeters: length || boundsSpanM(bounds).diag }];
  const maxSegments = Math.max(1, Math.round(Number(policy && policy.maxSegments) || 6));
  const count = Math.max(1, Math.min(maxSegments, Math.ceil(length / maxSegment)));
  const overlap = Math.max(0, Number(policy && policy.segmentOverlapMeters) || 0);
  const out = [];
  for (let i = 0; i < count; i++) {
    const segmentStart = Math.max(0, length * i / count - overlap);
    const segmentEnd = Math.min(length, length * (i + 1) / count + overlap);
    const segmentBounds = boundsFromPoints(routeSegmentPoints(route, segmentStart, segmentEnd));
    if (segmentBounds) out.push({ bounds: segmentBounds, segmentIndex: i + 1, segmentCount: count, routeLengthMeters: length, segmentStartMeters: segmentStart, segmentEndMeters: segmentEnd });
  }
  return out.length ? out : [{ bounds, segmentIndex: 1, segmentCount: 1, routeLengthMeters: length }];
}

/* ---------- plan ------------------------------------------------------------------------- */

function slug(value) { return String(value || "course").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "course"; }
function hashString(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value) || "";
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

/* Bounds of everything play-ready in a package. The imagery registry needs these BEFORE a plan
   exists - which source may legally shoot this course decides whether there is a plan at all. */
export function courseBoundsFor(pkg) {
  const holeData = packageHoleData(pkg);
  const all = Object.keys(holeData).map(Number).sort((a, b) => a - b).map(h => {
    const anchors = holeAnchorPins(holeData[h]);
    return boundsFromPoints([anchors.tee, anchors.green, ...anchors.route, ...anchors.greenShape].filter(Boolean));
  }).filter(Boolean);
  return mergeBounds(all);
}

export function planCourseCaptures(pkg, opts = {}) {
  const courseId = slug(pkg && (pkg.courseId || pkg.id));
  const courseName = String(pkg && (pkg.courseName || pkg.name) || courseId);
  const holeData = packageHoleData(pkg);
  const holeNumbers = Object.keys(holeData).map(Number).sort((a, b) => a - b);
  const allBounds = [];
  holeNumbers.forEach(h => {
    const anchors = holeAnchorPins(holeData[h]);
    const b = boundsFromPoints([anchors.tee, anchors.green, ...anchors.route, ...anchors.greenShape].filter(Boolean));
    if (b) allBounds.push(b);
  });
  const backdropBounds = mergeBounds(allBounds);
  const plan = [];
  const item = (role, bounds, holeNumber, data, extra = {}) => {
    const policy = capturePolicy(role);
    const padded = padBounds(bounds, policy.bleedMeters);
    if (!validBounds(padded)) return null;
    const segmentSuffix = extra.segmentCount > 1 ? "s" + extra.segmentIndex + "of" + extra.segmentCount : "";
    const id = ["cv-plan", courseId, policy.role, holeNumber ? "h" + holeNumber : "course", segmentSuffix, hashString(padded)].filter(Boolean).join(":");
    return Object.assign({}, policy, {
      id, planId: id, courseId, courseName,
      holeNumber: holeNumber || null,
      segmentIndex: extra.segmentIndex || null,
      segmentCount: extra.segmentCount || null,
      segmentStartMeters: num(extra.segmentStartMeters),
      segmentEndMeters: num(extra.segmentEndMeters),
      routeLengthMeters: num(extra.routeLengthMeters),
      bounds: padded,
      sourceBounds: bounds,
      anchorPins: holeAnchorPins(data),
      captureAnchorPins: holeCaptureAnchorPins(data, policy.role, extra),
      captureKey: [courseId, holeNumber ? "h" + holeNumber : "course", policy.role, segmentSuffix].filter(Boolean).join(":")
    });
  };
  if (backdropBounds) {
    const backdrop = item("course-backdrop", backdropBounds, null, null);
    if (backdrop) plan.push(backdrop);
    /* The relief capture fetches a ready-made hillshade RASTER, and no region has a licensed
       one - shading is computed from the DEM instead, which is one fetch that also feeds the
       offline plays-like maths. So this is planned only when a caller explicitly supplies a
       terrain raster source, which today nothing does. It stays here rather than being deleted
       because the capture slot itself survives the move to computed relief; only where the
       pixels come from changes. Callers that resolve no sources at all (plan-shape tests) keep
       the original behaviour. */
    const wantsTerrain = !("terrainSource" in opts) || !!opts.terrainSource;
    if (wantsTerrain) {
      const terrain = item("terrain-reference", backdropBounds, null, null);
      if (terrain) plan.push(terrain);
    }
  }
  holeNumbers.forEach(holeNumber => {
    const data = holeData[holeNumber];
    const anchors = holeAnchorPins(data);
    let greenBounds = boundsFromPoints([anchors.green, ...anchors.greenShape].filter(Boolean));
    if (validBounds(greenBounds)) {
      if (boundsSpanM(greenBounds).diag < 8) greenBounds = padBounds(greenBounds, 16);
      const greenItem = item("green-surround", greenBounds, holeNumber, data);
      if (greenItem) plan.push(greenItem);
    }
    let corridorBounds = boundsFromPoints([anchors.tee, anchors.green, ...anchors.route, ...anchors.greenShape].filter(Boolean));
    if (validBounds(corridorBounds)) {
      if (boundsSpanM(corridorBounds).diag < 35) corridorBounds = padBounds(corridorBounds, 32);
      const corridorPolicy = capturePolicy("play-corridor");
      splitBoundsAlongRoute(corridorBounds, data, corridorPolicy).forEach(segment => {
        const corridorItem = item("play-corridor", segment.bounds, holeNumber, data, segment);
        if (corridorItem) plan.push(corridorItem);
      });
    }
  });
  const limit = Math.max(0, Math.round(Number(opts.limit) || 0));
  return limit ? plan.slice(0, limit) : plan;
}

/* ---------- spherical mercator + tile grids (replaces the Leaflet shutter) --------------- */

export function projectPoint(lat, lng, zoom) {
  const size = 256 * Math.pow(2, zoom);
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, Number(lat)));
  const sin = Math.sin(clampedLat * Math.PI / 180);
  return {
    x: (Number(lng) + 180) / 360 * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size
  };
}
export function unprojectPoint(x, y, zoom) {
  const size = 256 * Math.pow(2, zoom);
  const lng = x / size * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y / size;
  const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

function pixelRect(item, zoom) {
  const pins = item.captureAnchorPins || item.anchorPins || {};
  const surface = [
    { lat: item.bounds.south, lng: item.bounds.west }, { lat: item.bounds.south, lng: item.bounds.east },
    { lat: item.bounds.north, lng: item.bounds.west }, { lat: item.bounds.north, lng: item.bounds.east },
    pins.tee, pins.green, ...(pins.route || []), ...(pins.greenShape || [])
  ].filter(Boolean);
  const bleed = Math.max(0, Math.round(Number(item.bleedPx) || 0));
  const projected = surface.map(p => projectPoint(p.lat, p.lng, zoom));
  let rect = {
    minX: Math.floor(Math.min(...projected.map(p => p.x)) - bleed),
    minY: Math.floor(Math.min(...projected.map(p => p.y)) - bleed),
    maxX: Math.ceil(Math.max(...projected.map(p => p.x)) + bleed),
    maxY: Math.ceil(Math.max(...projected.map(p => p.y)) + bleed)
  };
  return applyLens(rect, item, pins, zoom);
}

/* Play-axis lens: fit a 9/16 (or square) window along the tee->green direction, mirroring the
   camera's applyCaptureLensRect. The captured rect is the axis-aligned cover of that window. */
function applyLens(rect, item, pins, zoom) {
  const aspect = Number(item.lensAspectRatio) || 0;
  if (!aspect) return rect;
  const route = points(pins && pins.route);
  const routeStart = route[0] || point(pins && pins.tee);
  const routeEnd = route[route.length - 1] || point(pins && pins.green);
  if (item.lensOrientation === "play-axis" && routeStart && routeEnd) {
    const a = projectPoint(routeStart.lat, routeStart.lng, zoom);
    const b = projectPoint(routeEnd.lat, routeEnd.lng, zoom);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1) {
      const ux = dx / len, uy = dy / len, px = -uy, py = ux;
      const corners = [
        { x: rect.minX, y: rect.minY }, { x: rect.maxX, y: rect.minY },
        { x: rect.maxX, y: rect.maxY }, { x: rect.minX, y: rect.maxY }
      ];
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const extents = corners.map(p => ({ along: (p.x - center.x) * ux + (p.y - center.y) * uy, cross: (p.x - center.x) * px + (p.y - center.y) * py }));
      let along = Math.max(len / 2, ...extents.map(p => Math.abs(p.along)));
      let cross = Math.max(1, ...extents.map(p => Math.abs(p.cross)));
      if ((cross * 2) / (along * 2) > aspect) along = cross / aspect; else cross = along * aspect;
      const lens = [
        { x: center.x - ux * along - px * cross, y: center.y - uy * along - py * cross },
        { x: center.x + ux * along - px * cross, y: center.y + uy * along - py * cross },
        { x: center.x + ux * along + px * cross, y: center.y + uy * along + py * cross },
        { x: center.x - ux * along + px * cross, y: center.y - uy * along + py * cross }
      ];
      return {
        minX: Math.floor(Math.min(...lens.map(p => p.x))),
        minY: Math.floor(Math.min(...lens.map(p => p.y))),
        maxX: Math.ceil(Math.max(...lens.map(p => p.x))),
        maxY: Math.ceil(Math.max(...lens.map(p => p.y))),
        lensCornersPx: lens.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })),
        lensOrientation: "play-axis"
      };
    }
  }
  const width = Math.max(1, rect.maxX - rect.minX), height = Math.max(1, rect.maxY - rect.minY);
  const current = width / height;
  if (Math.abs(current - aspect) < 0.01) return rect;
  const cx = (rect.minX + rect.maxX) / 2, cy = (rect.minY + rect.maxY) / 2;
  const w = current > aspect ? width : height * aspect;
  const h = current > aspect ? width / aspect : height;
  return { minX: Math.floor(cx - w / 2), minY: Math.floor(cy - h / 2), maxX: Math.ceil(cx + w / 2), maxY: Math.ceil(cy + h / 2), lensOrientation: "map-axis" };
}

function tileCountFor(rect) {
  if (!rect) return 0;
  const minTx = Math.floor(rect.minX / 256), maxTx = Math.floor((rect.maxX - 1) / 256);
  const minTy = Math.floor(rect.minY / 256), maxTy = Math.floor((rect.maxY - 1) / 256);
  return Math.max(0, maxTx - minTx + 1) * Math.max(0, maxTy - minTy + 1);
}

/* Which half of a resolved source a capture reads from: relief comes off the elevation
   endpoint, everything else off imagery. */
function specForItem(item, source) {
  if (!source) return null;
  return item.role === "terrain-reference" ? (source.terrain || null) : (source.imagery || null);
}

/* Slippy tiles - the original path, unchanged apart from taking its template from the
   resolved source instead of a module constant. */
function xyzTiles(spec, rect, origin, zoom) {
  const template = String(spec.urlTemplate || "");
  const tiles = [];
  const minTx = Math.floor(rect.minX / 256), maxTx = Math.floor((rect.maxX - 1) / 256);
  const minTy = Math.floor(rect.minY / 256), maxTy = Math.floor((rect.maxY - 1) / 256);
  const maxIndex = Math.pow(2, zoom) - 1;
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (tx < 0 || ty < 0 || tx > maxIndex || ty > maxIndex) continue;
      tiles.push({
        tileX: tx, tileY: ty, z: zoom,
        x: tx * 256 - origin.x, y: ty * 256 - origin.y,
        url: template.replace(/\{ *z *\}/g, zoom).replace(/\{ *x *\}/g, tx).replace(/\{ *y *\}/g, ty)
      });
    }
  }
  return tiles;
}

/* ImageServer exportImage - one request per block rather than per 256px tile, which is the
   difference between ~300 requests and ~4 for the same capture. Blocks are emitted in the
   same {x, y, url} shape as tiles and land on the same canvas, so the compositor cannot tell
   the two adapters apart. Each block is requested at exactly its own pixel size, so nothing
   is resampled on the way in. */
function exportBlocks(spec, rect, origin, zoom) {
  const block = Math.max(256, Math.round(Number(spec.blockPx) || 2048));
  const width = rect.maxX - rect.minX;
  const height = rect.maxY - rect.minY;
  const blocks = [];
  for (let by = 0; by < height; by += block) {
    for (let bx = 0; bx < width; bx += block) {
      const w = Math.min(block, width - bx);
      const h = Math.min(block, height - by);
      if (w <= 0 || h <= 0) continue;
      blocks.push({
        z: zoom, x: bx, y: by,
        url: exportImageUrl(spec, { left: origin.x + bx, top: origin.y + by, width: w, height: h }, zoom)
      });
    }
  }
  return blocks;
}

export function captureGrid(item, opts = {}) {
  const source = opts.source || null;
  const spec = specForItem(item, source);
  /* No licensed endpoint for this role means no capture. Returning an empty grid rather than
     throwing lets the planner drop one role (relief) without failing the course. */
  if (!spec || !(spec.urlTemplate || spec.endpoint)) return null;
  /* Resolution ceiling from the source, not from the policy. NAIP is 0.6m, so asking it for
     z19 buys nothing but upscaled mush at the same cost; and a fixedZoom policy (green
     surrounds sit at z20) has to be allowed to come DOWN to the ceiling, hence the floor
     moving too. */
  const ceiling = Math.max(1, Math.min(22, Math.round(Number(spec.maxUsefulZoom) || 22)));
  const minZoom = Math.min(ceiling, Math.max(1, Math.round(Number(item.minZoom) || 15)));
  let zoom = Math.min(ceiling, Math.max(minZoom, Math.min(22, Math.round(Number(item.targetZoom) || 18))));
  const maxTiles = Math.max(16, Math.round(Number(item.maxTiles) || 320));
  let rect = pixelRect(item, zoom);
  /* Budget is counted in 256px cells for both adapters so the step-down stays calibrated
     against the same numbers it was tuned on. */
  while (zoom > minZoom && tileCountFor(rect) > maxTiles) {
    zoom -= 1;
    rect = pixelRect(item, zoom);
  }
  const origin = { x: rect.minX, y: rect.minY };
  const width = Math.max(256, rect.maxX - rect.minX);
  const height = Math.max(256, rect.maxY - rect.minY);
  const tiles = String(spec.adapter) === "arcgis-export"
    ? exportBlocks(spec, rect, origin, zoom)
    : xyzTiles(spec, rect, origin, zoom);
  const nw = unprojectPoint(origin.x, origin.y, zoom);
  const se = unprojectPoint(origin.x + width, origin.y + height, zoom);
  return {
    captureZoom: zoom,
    originPx: origin,
    imageWidth: width,
    imageHeight: height,
    imageBounds: { north: nw.lat, west: nw.lng, south: se.lat, east: se.lng },
    lensCornersPx: rect.lensCornersPx || null,
    lensOrientation: rect.lensOrientation || item.lensOrientation || "",
    sourceKey: source.key || "",
    sourceLabel: source.label || "",
    adapter: String(spec.adapter || "xyz"),
    tiles
  };
}
