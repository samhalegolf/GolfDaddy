/* Server-side Native Geometry Resolver: a faithful port of the pure resolution algorithm in
   scripts/gd-course-geometry-resolver.js. This resolver exists for ONE case: OSM has the
   SHAPES (greens, fairways, hole lines) but does not expose hole NUMBERS, so numbering has to
   be worked out from geometry + scorecard evidence. It is a genuinely separate system from
   AutoMapper (functions/lib/gd-automapper-core.mjs) - it was reused by AutoMapper's removed
   client orchestrator only as a secondary fallback, and it belongs server-side for the same
   reason AutoMapper does (course-package architecture doc: "No AutoMapper logic runs on the
   user's phone" - this is the geometry-resolution half of that same mapping pipeline).

   Everything below is pure data/math - candidate detection, shape classification, scorecard
   distance matching, beam-search hole assignment - over plain OSM elements and scorecard
   rows. The client file's DOM-dependent parts (debugEnabled/adminOrDeveloperAllowed,
   renderFeedbackWindow's HTML panel, drawDebug's Leaflet layers, and the checkpoint SVG
   visualizer) are NOT ported: they are debug UI with no server equivalent. Structured
   diagnostics (buildFeedback/resolverDebugDetails) ARE kept - "durable run history, warnings,
   failures" is a real server responsibility per the architecture doc, it just doesn't need to
   render as an image.

   Telemetry hooks (recordMappingDebug -> window.GDCourseMappingDebug) are removed entirely;
   the calling worker logs whatever it needs to the job row instead. Scorecard evidence
   (input.scorecardHoles/scorecardEvidence) must be supplied by the caller - the client's
   window.scorecard/gdScorecard fallback reads have no server equivalent and are not needed
   since the worker passes them explicitly (see resolveGeometryWithFallback in
   gd-course-package-shape adjacent worker code). */

const HIGH_CONFIDENCE = 0.76;
const MEDIUM_CONFIDENCE = 0.58;
const EARTH_RADIUS_M = 6371008.8;
const MAX_BEAM_WIDTH = 360;
const GREEN_FAIRWAY_LINK_MAX_M = 230;
const RESOLVER_VERSION = "course-geometry-resolver-v1";
const SOURCE = "automapper-course-geometry-resolver";

function number(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function nowIso() { return new Date().toISOString(); }
function makeRunId(courseId) {
  return "cgr-" + String(courseId || "course").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 36) + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
}

function toPoint(value) {
  if (!value) return null;
  const lat = number(value.lat, NaN);
  const lng = number(value.lng != null ? value.lng : value.lon, NaN);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}
function rad(value) { return value * Math.PI / 180; }
function distanceM(a, b) {
  a = toPoint(a); b = toPoint(b);
  if (!a || !b) return Infinity;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const lat1 = rad(a.lat), lat2 = rad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
function lineDistanceM(points) {
  const pts = (points || []).map(toPoint).filter(Boolean);
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += distanceM(pts[i - 1], pts[i]);
  return total;
}
function elementId(element, fallback) { return String((element && element.type) || "osm") + "-" + String((element && element.id) || fallback || "feature"); }
function tags(element) { return (element && element.tags) || {}; }
function tagText(element, key) { return String(tags(element)[key] || "").trim(); }
function golfTag(element) { return tagText(element, "golf").toLowerCase(); }
function validHoleNumber(value) {
  const match = String(value || "").match(/\d+/);
  const n = match ? Number(match[0]) : Number(value);
  return Number.isFinite(n) && n >= 1 && n <= 36 ? n : null;
}
function elementPoints(element) {
  const pts = [];
  const add = raw => { const p = toPoint(raw); if (p) pts.push(p); };
  if (Array.isArray(element && element.geometry)) element.geometry.forEach(add);
  if (Array.isArray(element && element.members)) element.members.forEach(member => { if (Array.isArray(member && member.geometry)) member.geometry.forEach(add); });
  return dedupeNearbyPoints(pts, 0.4);
}
function dedupeNearbyPoints(points, metres) {
  const clean = [];
  (points || []).forEach(point => {
    const p = toPoint(point);
    if (!p) return;
    const prev = clean[clean.length - 1];
    if (!prev || distanceM(prev, p) > (metres || 0.5)) clean.push(p);
  });
  return clean;
}
function cleanPolygon(points) {
  const pts = dedupeNearbyPoints(points, 0.6);
  if (pts.length > 3 && distanceM(pts[0], pts[pts.length - 1]) < 1.5) pts.pop();
  return pts.length >= 3 ? pts : null;
}
function centroid(points) {
  const pts = (points || []).map(toPoint).filter(Boolean);
  if (!pts.length) return null;
  let lat = 0, lng = 0;
  pts.forEach(p => { lat += p.lat; lng += p.lng; });
  return { lat: lat / pts.length, lng: lng / pts.length };
}
function boundsForPoints(points) {
  const pts = (points || []).map(toPoint).filter(Boolean);
  if (!pts.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  pts.forEach(p => { minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat); minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng); });
  return { minLat, maxLat, minLng, maxLng };
}
function boundsPolygon(bounds, padM) {
  if (!bounds) return [];
  const centerLat = (bounds.minLat + bounds.maxLat) / 2 || 0;
  const latPad = (padM || 0) / 111320;
  const lngPad = (padM || 0) / (111320 * Math.max(0.2, Math.cos(rad(centerLat))));
  return [
    { lat: bounds.minLat - latPad, lng: bounds.minLng - lngPad },
    { lat: bounds.minLat - latPad, lng: bounds.maxLng + lngPad },
    { lat: bounds.maxLat + latPad, lng: bounds.maxLng + lngPad },
    { lat: bounds.maxLat + latPad, lng: bounds.minLng - lngPad }
  ];
}
function inputCenter(input) {
  input = input || {};
  const course = input.course || {};
  return toPoint(input.courseCentre) || toPoint(input.courseCenter) || toPoint(input.center) ||
    toPoint(course.courseCentre) || toPoint(course.courseCenter) || toPoint(course.center) ||
    toPoint({ lat: course.courseLat || course.lat || course.latitude, lng: course.courseLng || course.lng || course.longitude }) ||
    toPoint(input.mapViewport && input.mapViewport.center);
}
function explicitBoundary(input) {
  input = input || {};
  for (const candidate of [input.courseBoundary, input.boundary, input.analysisBoundary]) {
    const polygon = cleanPolygon(candidate);
    if (polygon) return polygon;
  }
  return null;
}
function pointInPolygon(point, polygon) {
  point = toPoint(point);
  const poly = (polygon || []).map(toPoint).filter(Boolean);
  if (!point || poly.length < 3) return true;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i++) {
    const xi = poly[i].lng, yi = poly[i].lat, xj = poly[j].lng, yj = poly[j].lat;
    const intersects = ((yi > point.lat) !== (yj > point.lat)) && (point.lng < (xj - xi) * (point.lat - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}
function polygonAreaM2(points) {
  const pts = cleanPolygon(points);
  if (!pts) return null;
  const c = centroid(pts) || pts[0];
  const latScale = 111320, lngScale = 111320 * Math.max(0.2, Math.cos(rad(c.lat)));
  let area = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i++) {
    const xi = (pts[i].lng - c.lng) * lngScale, yi = (pts[i].lat - c.lat) * latScale;
    const xj = (pts[j].lng - c.lng) * lngScale, yj = (pts[j].lat - c.lat) * latScale;
    area += xj * yi - xi * yj;
  }
  return Math.abs(area / 2);
}
function spanM(points, center) {
  const c = center || centroid(points);
  if (!c) return Infinity;
  let max = 0;
  (points || []).forEach(p => { max = Math.max(max, distanceM(c, p)); });
  return max * 2;
}
function nearestFeatureDistance(point, elements, predicate) {
  let best = Infinity;
  (elements || []).forEach(element => {
    if (predicate && !predicate(element)) return;
    elementPoints(element).forEach(p => { best = Math.min(best, distanceM(point, p)); });
  });
  return best;
}
function hasTextRisk(element, pattern) {
  const text = [tagText(element, "name"), tagText(element, "description"), tagText(element, "note"), tagText(element, "ref")].join(" ").toLowerCase();
  return pattern.test(text);
}
function deriveAnalysisBoundary(input, elements) {
  const boundary = explicitBoundary(input);
  if (boundary) return boundary;
  const coursePolygons = (elements || []).filter(element => golfTag(element) === "course" && cleanPolygon(elementPoints(element)));
  if (coursePolygons.length) {
    return coursePolygons.map(element => cleanPolygon(elementPoints(element))).sort((a, b) => (polygonAreaM2(b) || 0) - (polygonAreaM2(a) || 0))[0];
  }
  let featurePoints = [];
  (elements || []).forEach(element => {
    const golf = golfTag(element);
    const water = tagText(element, "natural") === "water" || !!tagText(element, "water");
    if (golf || water) featurePoints = featurePoints.concat(elementPoints(element));
  });
  if (featurePoints.length >= 3) return boundsPolygon(boundsForPoints(featurePoints), 90);
  const center = inputCenter(input);
  if (!center) return [];
  const dLat = 1400 / 111320;
  const dLng = 1400 / (111320 * Math.max(0.2, Math.cos(rad(center.lat))));
  return [
    { lat: center.lat - dLat, lng: center.lng - dLng }, { lat: center.lat - dLat, lng: center.lng + dLng },
    { lat: center.lat + dLat, lng: center.lng + dLng }, { lat: center.lat + dLat, lng: center.lng - dLng }
  ];
}
function greenCandidateFromElement(element, elements, boundary, index) {
  const polygon = cleanPolygon(elementPoints(element));
  if (!polygon) return null;
  const center = centroid(polygon);
  if (!center || !pointInPolygon(center, boundary)) return null;
  const area = polygonAreaM2(polygon);
  const span = spanM(polygon, center);
  const compactArea = area && span ? area / Math.max(1, Math.PI * (span / 2) ** 2) : 0;
  let shapeScore = clamp(1 - Math.abs((span || 55) - 48) / 95, 0, 1);
  if (area) shapeScore = (shapeScore + clamp(1 - Math.abs(area - 900) / 1800, 0, 1) + clamp(compactArea, 0, 1)) / 3;
  const osmScore = golfTag(element) === "green" ? 1 : 0.2;
  const nearFairway = nearestFeatureDistance(center, elements, c => golfTag(c) === "fairway" || golfTag(c) === "hole" || golfTag(c) === "tee");
  const courseContextScore = nearFairway <= 60 ? 1 : nearFairway <= 180 ? 0.68 : 0.28;
  let practiceGreenRisk = 0;
  if (hasTextRisk(element, /\b(practice|putting|nursery|range|target)\b/i)) practiceGreenRisk += 0.7;
  if (nearestFeatureDistance(center, elements, c => golfTag(c) === "driving_range" || golfTag(c) === "practice_area") < 120) practiceGreenRisk += 0.25;
  practiceGreenRisk = clamp(practiceGreenRisk, 0, 1);
  const evidence = ["osm:" + elementId(element, index), "span:" + Math.round(span) + "m"];
  if (area) evidence.push("area:" + Math.round(area) + "m2");
  if (nearFairway < Infinity) evidence.push("course-context:" + Math.round(nearFairway) + "m");
  if (practiceGreenRisk) evidence.push("practice-risk:" + practiceGreenRisk.toFixed(2));
  const confidence = clamp(0.38 * shapeScore + 0.32 * osmScore + 0.3 * courseContextScore - 0.36 * practiceGreenRisk, 0, 1);
  return { id: elementId(element, "green-" + index), centre: center, polygon, areaM2: area || undefined, shapeScore, osmScore, courseContextScore, practiceGreenRisk, confidence, evidence };
}
function dedupeGreenCandidates(greens) {
  return (greens || []).slice().sort((a, b) => b.confidence - a.confidence)
    .filter((green, index, all) => all.slice(0, index).every(prev => distanceM(prev.centre, green.centre) > 12));
}
function detectGreenCandidates(elements, boundary) {
  const accepted = [], rejected = [];
  (elements || []).forEach((element, index) => {
    const golf = golfTag(element);
    const isExcluded = golf === "bunker" || golf === "water_hazard" || tagText(element, "natural") === "water" || tagText(element, "building");
    if (golf !== "green" || isExcluded) return;
    const candidate = greenCandidateFromElement(element, elements, boundary, index);
    if (!candidate) return;
    if (candidate.confidence >= 0.42 && candidate.practiceGreenRisk < 0.72) accepted.push(candidate);
    else rejected.push(candidate);
  });
  return { accepted: dedupeGreenCandidates(accepted), rejected };
}
function angleBetween(a, b, c) {
  a = toPoint(a); b = toPoint(b); c = toPoint(c);
  if (!a || !b || !c) return 0;
  const ux = a.lng - b.lng, uy = a.lat - b.lat, vx = c.lng - b.lng, vy = c.lat - b.lat;
  const dot = ux * vx + uy * vy;
  const mag = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
  if (!mag) return 0;
  return Math.acos(clamp(dot / mag, -1, 1)) * 180 / Math.PI;
}
function turnSign(a, b, c) {
  a = toPoint(a); b = toPoint(b); c = toPoint(c);
  if (!a || !b || !c) return 0;
  return (b.lng - a.lng) * (c.lat - b.lat) - (b.lat - a.lat) * (c.lng - b.lng);
}
function directionChanges(points) {
  const pts = (points || []).map(toPoint).filter(Boolean);
  const changes = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const angle = 180 - angleBetween(pts[i - 1], pts[i], pts[i + 1]);
    if (Math.abs(angle) >= 18) changes.push({ deg: Math.abs(angle), sign: turnSign(pts[i - 1], pts[i], pts[i + 1]) });
  }
  return changes;
}
function classifyShape(points) {
  const changes = directionChanges(points).filter(c => c.deg >= 28);
  if (!changes.length) return "straight";
  if (changes.length >= 2) return "double-dogleg";
  return changes[0].sign > 0 ? "dogleg-left" : "dogleg-right";
}
function nearestGreenForPath(path, greens) {
  const pts = (path || []).map(toPoint).filter(Boolean);
  if (pts.length < 2 || !(greens || []).length) return null;
  const first = pts[0], last = pts[pts.length - 1];
  let best = null;
  greens.forEach(green => {
    [first, last].forEach((endpoint, endpointIndex) => {
      const d = distanceM(endpoint, green.centre);
      if (!best || d < best.distance) best = { green, distance: d, endpointIndex };
    });
  });
  return best;
}
function orientPathToGreen(path, greens) {
  const pts = (path || []).map(toPoint).filter(Boolean);
  const match = nearestGreenForPath(pts, greens);
  if (match && match.endpointIndex === 0) pts.reverse();
  return { path: pts, green: (match && match.green) || null, greenDistanceM: (match && match.distance) || Infinity };
}
function localProjector(origin) {
  origin = toPoint(origin) || { lat: 0, lng: 0 };
  const latScale = 111320, lngScale = 111320 * Math.max(0.2, Math.cos(rad(origin.lat)));
  return {
    toXY(point) { point = toPoint(point); return point ? { x: (point.lng - origin.lng) * lngScale, y: (point.lat - origin.lat) * latScale } : null; },
    toPoint(xy) { return { lat: origin.lat + xy.y / latScale, lng: origin.lng + xy.x / lngScale }; }
  };
}
function distancePointToSegmentM(point, a, b) {
  point = toPoint(point); a = toPoint(a); b = toPoint(b);
  if (!point || !a || !b) return Infinity;
  const projector = localProjector(point);
  const p = projector.toXY(point), aa = projector.toXY(a), bb = projector.toXY(b);
  const vx = bb.x - aa.x, vy = bb.y - aa.y;
  const len2 = vx * vx + vy * vy;
  if (!len2) return Math.hypot(p.x - aa.x, p.y - aa.y);
  const t = clamp(((p.x - aa.x) * vx + (p.y - aa.y) * vy) / len2, 0, 1);
  return Math.hypot(p.x - (aa.x + vx * t), p.y - (aa.y + vy * t));
}
function distancePointToPolygonM(point, polygon) {
  const poly = cleanPolygon(polygon);
  point = toPoint(point);
  if (!point || !poly) return Infinity;
  if (pointInPolygon(point, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, distancePointToSegmentM(point, poly[i], poly[(i + 1) % poly.length]));
  return best;
}
function distancePointToPathM(point, path) {
  const pts = (path || []).map(toPoint).filter(Boolean);
  if (!toPoint(point) || pts.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distancePointToSegmentM(point, pts[i - 1], pts[i]));
  return best;
}
function fairwayMajorAxis(polygon) {
  const pts = cleanPolygon(polygon);
  if (!pts) return null;
  const origin = centroid(pts);
  const projector = localProjector(origin);
  const xy = pts.map(projector.toXY).filter(Boolean);
  if (xy.length < 3) return null;
  let meanX = 0, meanY = 0;
  xy.forEach(p => { meanX += p.x; meanY += p.y; });
  meanX /= xy.length; meanY /= xy.length;
  let xx = 0, xyCov = 0, yy = 0;
  xy.forEach(p => { const dx = p.x - meanX, dy = p.y - meanY; xx += dx * dx; xyCov += dx * dy; yy += dy * dy; });
  const angle = 0.5 * Math.atan2(2 * xyCov, xx - yy);
  const axis = { x: Math.cos(angle), y: Math.sin(angle) };
  let min = Infinity, max = -Infinity;
  xy.forEach(p => { const proj = p.x * axis.x + p.y * axis.y; min = Math.min(min, proj); max = Math.max(max, proj); });
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 60) return null;
  function pointAt(projection) { return projector.toPoint({ x: axis.x * projection, y: axis.y * projection }); }
  return {
    min, max, spanM: max - min, center: pointAt((min + max) / 2), a: pointAt(min), b: pointAt(max),
    projectionForPoint(point) { const p = projector.toXY(point); return p ? p.x * axis.x + p.y * axis.y : NaN; },
    pointAt
  };
}
function nearbyFeatureCount(point, elements, radiusM, predicate) {
  let count = 0;
  (elements || []).forEach(element => {
    if (predicate && !predicate(element)) return;
    if (elementPoints(element).some(p => distanceM(point, p) <= radiusM)) count++;
  });
  return count;
}
function hasNearbyWater(path, elements) {
  return (path || []).some(point => nearestFeatureDistance(point, elements, element =>
    golfTag(element) === "water_hazard" || golfTag(element) === "lateral_water_hazard" || tagText(element, "natural") === "water" || !!tagText(element, "water")
  ) <= 55);
}
function inferredParForDistance(distance) {
  if (!Number.isFinite(distance)) return undefined;
  if (distance >= 430) return 5;
  if (distance >= 225) return 4;
  return 3;
}
function orientPathToSpecificGreen(path, green) {
  const pts = (path || []).map(toPoint).filter(Boolean);
  green = green || null;
  if (pts.length >= 2 && green && toPoint(green.centre)) {
    const first = distanceM(pts[0], green.centre), last = distanceM(pts[pts.length - 1], green.centre);
    if (first < last) pts.reverse();
    return { path: pts, green, greenDistanceM: Math.min(first, last) };
  }
  return { path: pts, green: null, greenDistanceM: Infinity };
}
function buildCandidate(id, rawPath, greens, elements, source, extraEvidence, forcedGreen) {
  const oriented = forcedGreen ? orientPathToSpecificGreen(rawPath, forcedGreen) : orientPathToGreen(rawPath, greens);
  const path = dedupeNearbyPoints(oriented.path, 2);
  if (path.length < 2) return null;
  const green = oriented.green;
  const pathDistance = lineDistanceM(path);
  const straightLine = distanceM(path[0], path[path.length - 1]);
  const nearbyBunkers = green ? nearbyFeatureCount(green.centre, elements, 90, e => golfTag(e) === "bunker") : 0;
  const evidence = [source, "path:" + Math.round(pathDistance) + "m"].concat(extraEvidence || []);
  if (green) evidence.push("green:" + green.id);
  if (oriented.greenDistanceM < Infinity) evidence.push("green-distance:" + Math.round(oriented.greenDistanceM) + "m");
  let confidence = source === "osm-hole-line" ? 0.72 : source === "fairway-centreline" ? 0.64 : 0.48;
  if (green && oriented.greenDistanceM <= 95) confidence += 0.12;
  if (pathDistance >= 70 && pathDistance <= 620) confidence += 0.08;
  if (straightLine > 0 && pathDistance / straightLine < 1.55) confidence += 0.04;
  return {
    candidateId: id, greenId: (green && green.id) || "", teeCandidates: [path[0]], path,
    straightLineDistanceM: straightLine, pathDistanceM: pathDistance, inferredPar: inferredParForDistance(pathDistance),
    shape: classifyShape(path), directionChangesDeg: directionChanges(path).map(c => Math.round(c.deg)),
    nearbyWater: hasNearbyWater(path, elements), crossingWater: false, nearbyBunkers,
    confidence: clamp(confidence, 0, 1), evidence
  };
}
function fairwayCenterlineForGreen(green, fairway, index, boundary) {
  const polygon = cleanPolygon(elementPoints(fairway));
  if (!green || !polygon) return null;
  const center = centroid(polygon);
  if (center && !pointInPolygon(center, boundary)) return null;
  const fairwayDistance = distancePointToPolygonM(green.centre, polygon);
  if (fairwayDistance > GREEN_FAIRWAY_LINK_MAX_M) return null;
  const axis = fairwayMajorAxis(polygon);
  if (!axis) return null;
  const aDistance = distanceM(axis.a, green.centre), bDistance = distanceM(axis.b, green.centre);
  const near = aDistance <= bDistance ? axis.a : axis.b;
  const far = aDistance <= bDistance ? axis.b : axis.a;
  const greenProjection = axis.projectionForPoint(green.centre);
  let projectedGreenSide = Number.isFinite(greenProjection) ? axis.pointAt(clamp(greenProjection, axis.min, axis.max)) : near;
  if (distanceM(projectedGreenSide, green.centre) > distanceM(near, green.centre) + 35) projectedGreenSide = near;
  const rawPath = [far, axis.center, projectedGreenSide, green.centre].filter(Boolean);
  const evidence = ["fairway:" + elementId(fairway, "fairway-" + index), "green-led", "fairway-distance:" + Math.round(fairwayDistance) + "m", "fairway-axis-span:" + Math.round(axis.spanM) + "m"];
  return buildCandidate(elementId(fairway, "fairway-" + index) + "-" + green.id, rawPath, [green], [fairway], "fairway-centreline", evidence, green);
}
function greenLedFairwayCandidates(elements, greens, boundary) {
  const fairways = (elements || []).map((element, index) => {
    if (golfTag(element) !== "fairway") return null;
    const polygon = cleanPolygon(elementPoints(element));
    return polygon ? { element, index, polygon } : null;
  }).filter(Boolean);
  if (!fairways.length || !(greens || []).length) return [];
  const candidates = [];
  (greens || []).forEach(green => {
    const ranked = fairways.map(fairway => ({ fairway, distance: distancePointToPolygonM(green.centre, fairway.polygon) }))
      .filter(entry => Number.isFinite(entry.distance) && entry.distance <= GREEN_FAIRWAY_LINK_MAX_M)
      .sort((a, b) => a.distance - b.distance);
    for (const entry of ranked) {
      const candidate = fairwayCenterlineForGreen(green, entry.fairway.element, entry.fairway.index, boundary);
      if (candidate) { candidates.push(candidate); break; }
    }
  });
  return candidates;
}
function greenLedHoleLineCorridorCandidates(elements, greens, boundary) {
  const lines = (elements || []).map((element, index) => {
    if (golfTag(element) !== "hole") return null;
    const pts = elementPoints(element);
    if (pts.length < 2) return null;
    const center = centroid(pts);
    if (center && !pointInPolygon(center, boundary)) return null;
    return { element, index, points: pts };
  }).filter(Boolean);
  if (!lines.length || !(greens || []).length) return [];
  const candidates = [];
  (greens || []).forEach(green => {
    const ranked = lines.map(line => ({
      line, distance: Math.min(distancePointToPathM(green.centre, line.points), distanceM(green.centre, line.points[0]), distanceM(green.centre, line.points[line.points.length - 1]))
    })).filter(entry => Number.isFinite(entry.distance) && entry.distance <= GREEN_FAIRWAY_LINK_MAX_M).sort((a, b) => a.distance - b.distance);
    if (!ranked.length) return;
    const line = ranked[0].line;
    const ref = validHoleNumber(tagText(line.element, "ref") || tagText(line.element, "name"));
    const candidate = buildCandidate(
      elementId(line.element, "hole-" + line.index) + "-" + green.id, line.points, [green], elements, "fairway-centreline",
      ["osm-hole-line-as-fairway", "green-led", "hole-line-distance:" + Math.round(ranked[0].distance) + "m"].concat(ref ? ["existing-ref:" + ref] : ["missing-ref"]), green
    );
    if (candidate) { candidate.existingHoleNumber = ref || undefined; candidates.push(candidate); }
  });
  return candidates;
}
function detectHoleGeometryCandidates(elements, greens, boundary) {
  const holeLineCandidates = [];
  (elements || []).forEach((element, index) => {
    if (golfTag(element) !== "hole") return;
    const pts = elementPoints(element);
    if (pts.length < 2) return;
    const center = centroid(pts);
    if (center && !pointInPolygon(center, boundary)) return;
    const ref = validHoleNumber(tagText(element, "ref") || tagText(element, "name"));
    const candidate = buildCandidate(elementId(element, "hole-" + index), pts, greens, elements, "osm-hole-line", [ref ? "existing-ref:" + ref : "missing-ref"]);
    if (candidate) { candidate.existingHoleNumber = ref || undefined; holeLineCandidates.push(candidate); }
  });
  const fairwayCandidates = greenLedFairwayCandidates(elements, greens, boundary);
  if (fairwayCandidates.length) {
    const labelledHoleLines = holeLineCandidates.filter(c => c.existingHoleNumber);
    return dedupeCandidates(fairwayCandidates.concat(labelledHoleLines));
  }
  const holeLineCorridors = greenLedHoleLineCorridorCandidates(elements, greens, boundary);
  if (holeLineCorridors.length) return dedupeCandidates(holeLineCorridors);
  return dedupeCandidates(holeLineCandidates);
}
function dedupeCandidates(candidates) {
  return (candidates || []).slice().sort((a, b) => b.confidence - a.confidence).filter((candidate, index, all) =>
    all.slice(0, index).every(prev => {
      const sameGreen = candidate.greenId && prev.greenId && candidate.greenId === prev.greenId;
      const teeClose = distanceM(candidate.path[0], prev.path[0]) < 25;
      const greenClose = distanceM(candidate.path[candidate.path.length - 1], prev.path[prev.path.length - 1]) < 25;
      return !(sameGreen && teeClose && greenClose);
    })
  );
}
function yardsToMetres(value) { const n = number(value, NaN); return Number.isFinite(n) ? n * 0.9144 : undefined; }
function metres(value) { const n = number(value, NaN); return Number.isFinite(n) ? n : undefined; }
function descriptionEvidence(text) {
  text = String(text || "").toLowerCase();
  const evidence = { landmarks: [] };
  if (/\bdog\s*leg\s*left\b|\bturns?\s+left\b/.test(text)) evidence.dogleg = "left";
  if (/\bdog\s*leg\s*right\b|\bturns?\s+right\b/.test(text)) evidence.dogleg = "right";
  if (/\bover water\b|\bcarry (the )?(creek|lake|water|pond)\b/.test(text)) evidence.water = "crossing";
  else if (/\bwater short\b/.test(text)) evidence.water = "short";
  else if (/\blake on the left\b|\bwater on the left\b/.test(text)) evidence.water = "left";
  else if (/\blake on the right\b|\bwater on the right\b/.test(text)) evidence.water = "right";
  else if (/\bwater\b|\bcreek\b|\blake\b|\bpond\b/.test(text)) evidence.water = "green";
  if (/\bout of bounds left\b/.test(text)) evidence.outOfBounds = "left";
  if (/\bout of bounds right\b/.test(text)) evidence.outOfBounds = "right";
  if (/\buphill\b/.test(text)) evidence.elevation = "uphill";
  if (/\bdownhill\b/.test(text)) evidence.elevation = "downhill";
  if (/\bshort par three\b|\bshort par 3\b/.test(text)) evidence.lengthHint = "short";
  if (/\blong par five\b|\blong par 5\b/.test(text)) evidence.lengthHint = "long";
  ["bunker", "creek", "lake", "pond", "clubhouse", "trees", "narrow"].forEach(word => { if (text.indexOf(word) >= 0) evidence.landmarks.push(word); });
  return evidence;
}
function validPar(value) { const n = number(value, NaN); return Number.isFinite(n) && n >= 3 && n <= 6 ? n : undefined; }
function normalizeScorecardHole(raw, fallbackHole) {
  raw = raw || {};
  const holeNumber = validHoleNumber(raw.holeNumber || raw.hole || raw.number || raw.no || fallbackHole);
  if (!holeNumber) return null;
  let distanceMValue = metres(raw.distanceM || raw.meters || raw.metres || raw.distanceMeters || raw.distanceMetres);
  const distanceYdValue = number(raw.distanceYd || raw.yards || raw.yds || raw.yardage || raw.distanceYards, NaN);
  if (!Number.isFinite(distanceMValue) && Number.isFinite(distanceYdValue)) distanceMValue = yardsToMetres(distanceYdValue);
  const text = [raw.name, raw.description, raw.notes, raw.tip, raw.summary].filter(Boolean).join(" ");
  return {
    holeNumber, par: validPar(raw.par), distanceM: distanceMValue,
    distanceYd: Number.isFinite(distanceYdValue) ? distanceYdValue : undefined,
    name: raw.name || undefined, description: raw.description || raw.notes || raw.tip || undefined,
    descriptionEvidence: descriptionEvidence(text)
  };
}
function scorecardSourceHoles(source) {
  if (Array.isArray(source)) return source;
  if (Array.isArray(source && source.holes)) return source.holes;
  if (Array.isArray(source && source.scorecard && source.scorecard.holes)) return source.scorecard.holes;
  return [];
}
function pushScorecardSource(entries, source, label, url) {
  if (!source) return;
  const holes = scorecardSourceHoles(source);
  if (!holes.length) return;
  entries.push({ source, label: String(label || source.source || source.provider || source.name || "scorecard").trim(), sourceUrl: String(url || source.sourceUrl || source.url || "").trim() });
}
/* No window.scorecard/gdScorecard/currentScorecard fallback here - server callers must pass
   evidence explicitly (see the port note in this file's header). */
function scorecardSourceEntries(input) {
  input = input || {};
  const entries = [];
  const evidence = input.scorecardEvidence || {};
  const evidenceSources = Array.isArray(evidence.sources) ? evidence.sources : [];
  if (evidenceSources.length) {
    evidenceSources.forEach(source => pushScorecardSource(entries, source.holes || source.scorecard || source, source.source || source.provider || evidence.source, source.sourceUrl || source.url));
  } else if (Array.isArray(evidence.holes)) {
    pushScorecardSource(entries, evidence.holes, evidence.source || "scorecard-evidence", evidence.sourceUrl || "");
  }
  if (!evidenceSources.length && Array.isArray(input.scorecardHoles)) pushScorecardSource(entries, input.scorecardHoles, "scorecard-holes", "");
  if (!evidenceSources.length && input.scorecard) pushScorecardSource(entries, input.scorecard, input.scorecard.source || "scorecard", input.scorecard.sourceUrl || "");
  return entries;
}
function normalizeScorecardSources(input) {
  const seen = {};
  return scorecardSourceEntries(input || {}).map((entry, index) => {
    const normalized = scorecardSourceHoles(entry.source).map((hole, holeIndex) => normalizeScorecardHole(hole, holeIndex + 1)).filter(Boolean).sort((a, b) => a.holeNumber - b.holeNumber);
    const completeDistances = normalized.filter(hole => Number.isFinite(hole.distanceM)).length;
    const signature = normalized.map(hole => hole.holeNumber + ":" + (Number.isFinite(hole.distanceM) ? Math.round(hole.distanceM) : "")).join("|");
    const key = (entry.sourceUrl || entry.label || ("inline-" + index)) + "|" + signature;
    if (!normalized.length || seen[key]) return null;
    seen[key] = true;
    return { source: entry.label || "scorecard", sourceUrl: entry.sourceUrl || "", holes: normalized, distanceCount: completeDistances };
  }).filter(Boolean);
}
function normalizeScorecard(input, normalizedSources) {
  normalizedSources = normalizedSources || normalizeScorecardSources(input || {});
  let best = [];
  normalizedSources.forEach(source => {
    const bestDistances = best.filter(hole => Number.isFinite(hole.distanceM)).length;
    if (source.holes.length > best.length || source.distanceCount > bestDistances) best = source.holes;
  });
  return best.sort((a, b) => a.holeNumber - b.holeNumber);
}
function scorecardDistanceCount(scorecard) { return (scorecard || []).filter(hole => Number.isFinite(hole.distanceM)).length; }
function scorecardLengthOrder(scorecard) {
  return (scorecard || []).filter(hole => Number.isFinite(hole.distanceM)).map(hole => ({ hole: hole.holeNumber, distanceM: Math.round(hole.distanceM), par: hole.par })).sort((a, b) => b.distanceM - a.distanceM);
}
function candidateLengthOrder(candidates) {
  return (candidates || []).filter(c => Number.isFinite(c.pathDistanceM)).map(c => ({ candidateId: c.candidateId, displayId: c.displayId || "", pathDistanceM: Math.round(c.pathDistanceM) })).sort((a, b) => b.pathDistanceM - a.pathDistanceM);
}
function scorecardEvidenceSummary(input, normalizedSources, scorecard, expected) {
  input = input || {};
  const evidence = input.scorecardEvidence || {};
  const sourceRows = (normalizedSources || []).map(source => ({
    source: source.source || "scorecard", sourceUrl: source.sourceUrl || "", holes: source.holes.length, distanceCount: source.distanceCount,
    lengthOrder: scorecardLengthOrder(source.holes).slice(0, Math.max(18, expected || 18))
  }));
  let distanceCount = scorecardDistanceCount(scorecard);
  const explicitDistanceCount = number(evidence.distanceCount, NaN);
  if (Number.isFinite(explicitDistanceCount)) distanceCount = Math.max(distanceCount, explicitDistanceCount);
  const normalizedLengthOrder = scorecardLengthOrder(scorecard);
  const evidenceLengthOrder = Array.isArray(evidence.lengthOrder) ? evidence.lengthOrder : [];
  const lengthOrder = evidenceLengthOrder.length >= normalizedLengthOrder.length ? evidenceLengthOrder : normalizedLengthOrder;
  return {
    source: evidence.source || (sourceRows[0] && sourceRows[0].source) || "", sourceUrl: evidence.sourceUrl || (sourceRows[0] && sourceRows[0].sourceUrl) || "",
    sourceCount: sourceRows.length, distanceCount, requiredDistanceCount: expected ? Math.min(expected, 18) : 18, lengthOrder, sources: sourceRows
  };
}
function median(values) {
  const nums = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}
function distanceScale(candidates, scorecard) {
  const candidateDistances = candidates.map(c => c.pathDistanceM).filter(Number.isFinite).sort((a, b) => a - b);
  const cardDistances = scorecard.map(h => h.distanceM).filter(Number.isFinite).sort((a, b) => a - b);
  const pairs = [];
  const count = Math.min(candidateDistances.length, cardDistances.length);
  for (let i = 0; i < count; i++) if (cardDistances[i] > 0) pairs.push(candidateDistances[i] / cardDistances[i]);
  return median(pairs) || 1;
}
function rankMap(items, getValue, getKey) {
  const sorted = items.slice().filter(item => Number.isFinite(getValue(item))).sort((a, b) => getValue(a) - getValue(b));
  const map = {};
  sorted.forEach((item, index) => { map[getKey(item)] = sorted.length <= 1 ? 0.5 : index / (sorted.length - 1); });
  return map;
}
function scorePair(candidate, hole, context) {
  let score = 0.22 * candidate.confidence;
  const evidence = candidate.evidence.slice();
  let distanceScoreValue = 0, rankScore = 0, multiSourceScore = 0, multiSourceCount = 0, parScore = 0, shapeScore = 0, hazardScore = 0, descriptionScore = 0;
  const rawDistanceDeltaM = Number.isFinite(hole.distanceM) ? Math.abs(candidate.pathDistanceM - hole.distanceM) : null;
  let scaledDistanceDeltaM = null, normalizedDistanceDelta = null;
  const tieBreakersUsed = [], explanation = [];
  if (Number.isFinite(candidate.existingHoleNumber) && candidate.existingHoleNumber === hole.holeNumber) {
    score += 0.24; evidence.push("existing-osm-ref-match"); tieBreakersUsed.push("existing-osm-ref");
    explanation.push("Existing OSM hole number matched this scorecard hole.");
  }
  if (Number.isFinite(hole.distanceM)) {
    const cr = context.candidateRanks[candidate.candidateId];
    const hr = context.scorecardRanks[hole.holeNumber];
    if (Number.isFinite(cr) && Number.isFinite(hr)) {
      rankScore = clamp(1 - Math.abs(cr - hr) / 0.55, 0, 1);
      score += 0.46 * rankScore;
      evidence.push("relative-rank:" + rankScore.toFixed(2));
      if (rankScore >= 0.75) explanation.push("Relative distance rank matched the scorecard structure.");
    }
    if (Array.isArray(context.sourceRankMaps) && context.sourceRankMaps.length > 1 && Number.isFinite(cr)) {
      context.sourceRankMaps.forEach(sourceRank => {
        const sr = sourceRank && sourceRank[hole.holeNumber];
        if (!Number.isFinite(sr)) return;
        multiSourceCount += 1;
        multiSourceScore += clamp(1 - Math.abs(cr - sr) / 0.55, 0, 1);
      });
      if (multiSourceCount > 1) {
        multiSourceScore /= multiSourceCount;
        score += 0.12 * multiSourceScore;
        evidence.push("multi-source-rank:" + multiSourceScore.toFixed(2));
        if (multiSourceScore >= 0.78) { tieBreakersUsed.push("multi-source-length-order"); explanation.push("Multiple scorecard sources agreed with this relative length order."); }
      }
    }
    const expected = hole.distanceM * context.scale;
    const diff = Math.abs(candidate.pathDistanceM - expected) / Math.max(80, expected);
    scaledDistanceDeltaM = Math.abs(candidate.pathDistanceM - expected);
    normalizedDistanceDelta = diff;
    distanceScoreValue = clamp(1 - diff / 0.28, 0, 1);
    score += 0.10 * distanceScoreValue;
    evidence.push("scale-sanity:" + distanceScoreValue.toFixed(2));
    if (distanceScoreValue >= 0.62) explanation.push("Centre-path distance stayed within the course-wide scorecard scale check.");
  }
  if (hole.par && candidate.inferredPar) {
    parScore = hole.par === candidate.inferredPar ? 1 : Math.abs(hole.par - candidate.inferredPar) === 1 ? 0.42 : 0;
    score += 0.07 * parScore;
    evidence.push("par-score:" + parScore.toFixed(2));
    if (parScore >= 0.8) { tieBreakersUsed.push("par"); explanation.push("Inferred par matched the scorecard par."); }
  }
  const text = hole.descriptionEvidence || {};
  if (text.dogleg && candidate.shape.indexOf("dogleg") >= 0) {
    const expectedShape = text.dogleg === "left" ? "dogleg-left" : "dogleg-right";
    shapeScore = candidate.shape === expectedShape ? 1 : 0;
    descriptionScore = shapeScore;
    score += candidate.shape === expectedShape ? 0.06 : -0.04;
    evidence.push("description-dogleg:" + text.dogleg);
    tieBreakersUsed.push("dogleg-direction");
    if (shapeScore) explanation.push("Dogleg direction matched the course description.");
  }
  if (text.water && (candidate.nearbyWater || candidate.crossingWater)) {
    hazardScore = 1; descriptionScore = Math.max(descriptionScore, 0.7); score += 0.04;
    evidence.push("description-water"); tieBreakersUsed.push("hazard-context");
    explanation.push("Water or hazard context matched the scorecard/course description.");
  }
  return {
    score: clamp(score, 0, 1), evidence,
    assignmentEvidence: {
      rawDistanceDeltaM, scaledDistanceDeltaM, normalizedDistanceDelta, distanceScore: distanceScoreValue, rankScore, multiSourceScore, multiSourceCount,
      parScore, shapeScore, hazardScore, descriptionScore, routingScore: 0, totalScore: clamp(score, 0, 1), tieBreakersUsed, explanation
    }
  };
}
function routeContinuityScore(prevCandidate, candidate) {
  if (!prevCandidate || !candidate) return 0;
  const d = distanceM(prevCandidate.path[prevCandidate.path.length - 1], candidate.path[0]);
  if (!Number.isFinite(d)) return 0;
  if (d <= 90) return 0.08;
  if (d <= 230) return 0.04;
  if (d >= 850) return -0.08;
  return 0;
}
function matchCandidatesToScorecard(candidates, scorecard, expectedHoleCount, normalizedScorecardSources) {
  const warnings = [];
  const holes = scorecard.slice().sort((a, b) => a.holeNumber - b.holeNumber);
  if (!holes.length) {
    warnings.push("No scorecard evidence available; resolver refused to number geometry.");
    return { assignments: [], unresolvedScorecardHoles: [], confidence: 0, warnings, alternatives: [] };
  }
  const usefulCandidates = candidates.filter(c => c.path && c.path.length >= 2 && c.confidence >= 0.38).slice(0, Math.max(expectedHoleCount || holes.length || 18, holes.length) + 8);
  if (!usefulCandidates.length) {
    warnings.push("No usable hole geometry candidates found inside the analysis boundary.");
    return { assignments: [], unresolvedScorecardHoles: holes, confidence: 0, warnings, alternatives: [] };
  }
  const context = {
    scale: distanceScale(usefulCandidates, holes),
    candidateRanks: rankMap(usefulCandidates, c => c.pathDistanceM, c => c.candidateId),
    scorecardRanks: rankMap(holes, h => h.distanceM, h => h.holeNumber),
    sourceRankMaps: (normalizedScorecardSources || []).filter(source => source.distanceCount >= 2).map(source => rankMap(source.holes, h => h.distanceM, h => h.holeNumber)),
    scorecardLengthOrder: scorecardLengthOrder(holes),
    candidateLengthOrder: candidateLengthOrder(usefulCandidates)
  };
  const pair = {};
  holes.forEach(hole => { usefulCandidates.forEach(candidate => { pair[hole.holeNumber + "::" + candidate.candidateId] = scorePair(candidate, hole, context); }); });
  let states = [{ score: 0, assignments: [], used: {}, last: null }];
  holes.forEach(hole => {
    const nextStates = [];
    states.forEach(state => {
      usefulCandidates.forEach(candidate => {
        if (state.used[candidate.candidateId]) return;
        const scored = pair[hole.holeNumber + "::" + candidate.candidateId];
        if (!scored || scored.score < 0.18) return;
        const continuity = routeContinuityScore(state.last, candidate);
        nextStates.push({
          score: state.score + scored.score + continuity,
          assignments: state.assignments.concat([{ hole, candidate, pair: scored, continuity }]),
          used: Object.assign({}, state.used, { [candidate.candidateId]: true }),
          last: candidate
        });
      });
      nextStates.push({ score: state.score - 0.18, assignments: state.assignments, used: state.used, last: state.last });
    });
    states = nextStates.sort((a, b) => b.score - a.score).slice(0, MAX_BEAM_WIDTH);
  });
  const best = states[0] || { assignments: [], score: 0 };
  const assignments = best.assignments.map(assignment => {
    const baseConfidence = clamp(assignment.pair.score * 0.88 + assignment.candidate.confidence * 0.12 + Math.max(0, assignment.continuity), 0, 1);
    const structuredEvidence = Object.assign({}, assignment.pair.assignmentEvidence || {});
    structuredEvidence.routingScore = assignment.continuity || 0;
    structuredEvidence.totalScore = assignment.pair.score + (assignment.continuity || 0);
    structuredEvidence.tieBreakersUsed = (structuredEvidence.tieBreakersUsed || []).slice();
    structuredEvidence.explanation = (structuredEvidence.explanation || []).slice();
    if (assignment.continuity > 0) { structuredEvidence.tieBreakersUsed.push("previous-hole-routing"); structuredEvidence.explanation.push("Previous green to next tee routing supported this ordering."); }
    return {
      holeNumber: assignment.hole.holeNumber, par: assignment.hole.par, officialDistanceM: assignment.hole.distanceM, candidate: assignment.candidate,
      matchScore: assignment.pair.score, confidence: baseConfidence,
      evidence: assignment.pair.evidence.concat(assignment.continuity ? ["routing-continuity:" + assignment.continuity.toFixed(2)] : []),
      assignmentEvidence: structuredEvidence
    };
  });
  const assignedHoleNumbers = {};
  assignments.forEach(a => { assignedHoleNumbers[a.holeNumber] = true; });
  const unresolvedScorecardHoles = holes.filter(h => !assignedHoleNumbers[h.holeNumber]);
  let confidence = assignments.length ? assignments.reduce((sum, a) => sum + a.confidence, 0) / assignments.length : 0;
  confidence *= clamp(assignments.length / Math.max(1, holes.length), 0, 1);
  if (context.scale && Math.abs(1 - context.scale) > 0.12) warnings.push("Map geometry scale differs from scorecard by " + Math.round((1 - context.scale) * -100) + "%; relative distance matching was used.");
  return {
    assignments, unresolvedScorecardHoles, confidence: clamp(confidence, 0, 1), warnings, context, score: best.score || 0,
    alternatives: states.slice(0, 5).map(state => ({ score: state.score, holes: state.assignments.map(a => ({ holeNumber: a.hole.holeNumber, candidateId: a.candidate.candidateId })) }))
  };
}
function expectedHoleCount(input, scorecard) {
  const explicit = number(input.expectedHoleCount, NaN);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (scorecard && scorecard.length) return scorecard.length;
  return 18;
}
/* This resolver exists for ONE case: OSM has the SHAPES but does not expose hole numbers, so
   the numbering has to be worked out from geometry. */
export function hasNumberingIssue(input) {
  const payload = input.osmPayload || {};
  const elements = payload.elements || input.elements || [];
  const holeElements = elements.filter(element => golfTag(element) === "hole");
  const refs = holeElements.map(element => validHoleNumber(tagText(element, "ref") || tagText(element, "name"))).filter(Boolean);
  const usefulGeometry = holeElements.length || elements.some(element => golfTag(element) === "green" || golfTag(element) === "fairway");
  if (!usefulGeometry) return false;
  return !refs.length;
}
function supportedGolfGeometry(elements) {
  return (elements || []).filter(element => { const golf = golfTag(element); return golf === "hole" || golf === "green" || golf === "fairway" || golf === "tee"; });
}
function normalizeSourceLoadError(raw, fallbackCode, fallbackReason) {
  raw = raw || {};
  return { code: String(raw.code || fallbackCode || "native-resolver-source-load-failed"), reason: String(raw.reason || fallbackReason || raw.message || "Native resolver source load failed"), message: String(raw.message || raw.reason || fallbackReason || "Native resolver source load failed"), name: String(raw.name || "") };
}
function sourceEvidenceError(input, elements, boundary) {
  if (input.sourceLoadError) return normalizeSourceLoadError(input.sourceLoadError, "osm-request-failed", "OSM request failed");
  if (!Array.isArray(elements)) return normalizeSourceLoadError(null, "osm-payload-invalid", "OSM payload was unavailable");
  if (!elements.length) return normalizeSourceLoadError(null, "no-supported-golf-geometry-returned", "No supported golf geometry returned");
  if (!supportedGolfGeometry(elements).length) return normalizeSourceLoadError(null, "no-supported-golf-geometry-returned", "No supported golf geometry returned");
  if (!Array.isArray(boundary) || boundary.length < 3) return normalizeSourceLoadError(null, "course-boundary-unavailable", "Course boundary unavailable");
  return null;
}
function distanceRange(values) {
  const nums = (values || []).filter(Number.isFinite);
  if (!nums.length) return null;
  return { min: Math.round(Math.min(...nums)), max: Math.round(Math.max(...nums)) };
}
function failedSourceFeedback(error, elements, scorecard) {
  const supported = supportedGolfGeometry(elements);
  return {
    stage: "Source load failed",
    geometry: { osmFeatures: Array.isArray(elements) ? elements.length : 0, supportedGolfFeatures: supported.length, greenCandidates: 0, acceptedGreens: 0, rejectedGreens: 0, fairwayCorridors: 0, candidatePaths: 0, missingCandidates: 0, sourceLoadError: error },
    distance: { measuredRange: null, scorecardRange: distanceRange((scorecard || []).map(h => h.distanceM)), globalScale: 1, averageNormalisedError: null, rankAgreement: "0 / 0", poorAgreementHoles: [], distanceUsed: "none", confidence: "None" },
    assignment: { scorecardHoles: Array.isArray(scorecard) ? scorecard.length : 0, geometryCandidates: 0, resolvedHoles: 0, unresolvedHoles: (scorecard || []).map(h => h.holeNumber), duplicateAssignmentsBlocked: true, unusedCandidates: 0, overallAssignmentScore: 0, overallConfidence: 0 },
    tieBreakers: {}, explanations: []
  };
}
function sourceLoadFailureResult(input, courseId, resolverRunId, error, elements, boundary, scorecard) {
  const result = {
    courseId, resolverRunId, status: "source-load-failed", sourceLoadError: error, holes: [], unresolvedCandidates: [], unresolvedScorecardHoles: scorecard || [],
    analysisBoundary: boundary || [], confidence: 0, overallConfidence: 0, warnings: [error.message], resolverVersion: RESOLVER_VERSION, resolvedAt: nowIso(), source: SOURCE,
    debugEvidence: { resolverRunId, analysisBoundary: boundary || [], osmFeatureCount: Array.isArray(elements) ? elements.length : 0, fairwayCount: (elements || []).filter(e => golfTag(e) === "fairway").length, expectedHoleCount: expectedHoleCount(input, scorecard || []), greenCandidates: [], rejectedGreenCandidates: [], holeCandidates: [], totalHoleCandidates: 0, scorecardHoles: scorecard || [], assignmentContext: {}, assignmentScore: 0, assignmentAlternatives: [], sourceLoadError: error }
  };
  result.feedback = failedSourceFeedback(error, elements, scorecard || []);
  return result;
}
function resolveStatus(assignments, confidence, expected, scorecardAvailable) {
  if (!scorecardAvailable) return "geometry-resolved-numbering-unavailable";
  const high = assignments.filter(hole => hole.confidence >= HIGH_CONFIDENCE).length;
  if (assignments.length >= expected && confidence >= HIGH_CONFIDENCE) return "resolved";
  if (high > 0 && confidence >= MEDIUM_CONFIDENCE) return "partially-resolved";
  if (assignments.length && confidence >= MEDIUM_CONFIDENCE) return "partially-resolved";
  return "insufficient-confidence";
}
function buildFeedback(result) {
  const debug = result.debugEvidence || {};
  const candidates = debug.holeCandidates || [];
  const scorecard = debug.scorecardHoles || [];
  const scorecardEvidence = debug.scorecardEvidence || {};
  const assigned = result.holes || [];
  const measuredRange = distanceRange(candidates.map(c => c.pathDistanceM));
  const scorecardRange = distanceRange(scorecard.map(h => h.distanceM));
  const poor = assigned.filter(h => h.assignmentEvidence && h.assignmentEvidence.normalizedDistanceDelta > 0.22).map(h => h.holeNumber);
  const tieBreakers = {};
  assigned.forEach(hole => { (hole.assignmentEvidence && hole.assignmentEvidence.tieBreakersUsed || []).forEach(key => { tieBreakers[key] = (tieBreakers[key] || 0) + 1; }); });
  return {
    stage: result.status === "resolved" ? "Completed" : result.status === "partially-resolved" ? "Partially resolved" : result.status === "geometry-resolved-numbering-unavailable" ? "Numbering unavailable" : "Fallback required",
    geometry: { osmFeatures: debug.osmFeatureCount || 0, greenCandidates: (debug.greenCandidates || []).length + (debug.rejectedGreenCandidates || []).length, acceptedGreens: (debug.greenCandidates || []).length, rejectedGreens: (debug.rejectedGreenCandidates || []).length, fairwayCorridors: debug.fairwayCount || 0, candidatePaths: candidates.length, missingCandidates: Math.max(0, (debug.expectedHoleCount || 18) - candidates.length) },
    distance: { measuredRange, scorecardRange, globalScale: (debug.assignmentContext && debug.assignmentContext.scale) || 1, averageNormalisedError: assigned.length ? assigned.reduce((sum, h) => sum + number(h.assignmentEvidence && h.assignmentEvidence.normalizedDistanceDelta, 0), 0) / assigned.length : null, rankAgreement: assigned.filter(h => h.assignmentEvidence && h.assignmentEvidence.rankScore >= 0.75).length + " / " + assigned.length, poorAgreementHoles: poor, distanceUsed: scorecardEvidence.distanceCount >= (scorecardEvidence.requiredDistanceCount || 1) ? "relative-rank" : "not-used", scorecardEvidence, confidence: result.confidence >= HIGH_CONFIDENCE ? "High" : result.confidence >= MEDIUM_CONFIDENCE ? "Medium" : "Low" },
    assignment: { scorecardHoles: scorecard.length, geometryCandidates: candidates.length, resolvedHoles: assigned.length, unresolvedHoles: (result.unresolvedScorecardHoles || []).map(h => h.holeNumber), duplicateAssignmentsBlocked: true, unusedCandidates: (result.unresolvedCandidates || []).length, overallAssignmentScore: number(debug.assignmentScore, 0), overallConfidence: result.confidence },
    tieBreakers, explanations: assigned.map(h => ({ holeNumber: h.holeNumber, explanation: (h.assignmentEvidence && h.assignmentEvidence.explanation) || [] })).filter(row => row.explanation.length)
  };
}

/* Main entry, kept synchronous under the hood (no telemetry/network awaits server-side) but
   async for interface parity with the client version and room to grow (e.g. a future DB read
   for cached candidates). courseId/course/courseCentre/mapViewport/expectedHoleCount/
   osmPayload behave exactly as in the client. scorecardHoles/scorecardEvidence must be
   supplied explicitly by the caller (see file header). */
export async function resolveCourseGeometryForAutoMapper(input) {
  input = input || {};
  const payload = input.osmPayload || {};
  const elements = payload.elements || input.elements || [];
  const course = input.course || {};
  const courseId = String(course.courseId || course.id || input.courseId || course.name || course.courseName || "course");
  const resolverRunId = makeRunId(courseId);
  let warnings = [];
  const analysisBoundary = deriveAnalysisBoundary(input, elements);
  const scorecardSources = normalizeScorecardSources(input);
  const scorecard = normalizeScorecard(input, scorecardSources);
  const acquisitionError = sourceEvidenceError(input, elements, analysisBoundary);
  if (acquisitionError) return sourceLoadFailureResult(input, courseId, resolverRunId, acquisitionError, elements, analysisBoundary, scorecard);
  const greenResult = detectGreenCandidates(elements, analysisBoundary);
  const allCandidates = detectHoleGeometryCandidates(elements, greenResult.accepted, analysisBoundary);
  /* Ground another course has already claimed.
   *
   * A multi-loop facility with no OSM numbering is resolved one CARD at a time
   * over one shared payload - see the unnumbered multi-loop path in
   * course-mapper-worker-background.mjs. Without this the second card is free to
   * match the same nine holes the first one took, because nothing in the
   * matching says a piece of ground can only belong to one course. */
  const excluded = new Set((input.excludeCandidateIds || []).map(String));
  const candidates = excluded.size ? allCandidates.filter(c => !excluded.has(String(c.candidateId))) : allCandidates;
  const expected = expectedHoleCount(input, scorecard);
  const requiredDistanceCount = scorecard.length ? Math.max(1, Math.min(expected || scorecard.length || 18, scorecard.length, 18)) : Math.max(1, Math.min(expected || 18, 18));
  const distanceEvidenceCount = scorecardDistanceCount(scorecard);
  const scorecardUsableForNumbering = !!scorecard.length && distanceEvidenceCount >= requiredDistanceCount;
  let match;
  if (scorecardUsableForNumbering) {
    match = matchCandidatesToScorecard(candidates, scorecard, expected, scorecardSources);
  } else {
    const unavailableReason = scorecard.length ? "Scorecard distances unavailable" : "Scorecard unavailable";
    match = {
      assignments: [], unresolvedScorecardHoles: scorecard, confidence: 0, warnings: [unavailableReason], alternatives: [],
      context: { scale: 1, candidateRanks: rankMap(candidates, c => c.pathDistanceM, c => c.candidateId), scorecardRanks: rankMap(scorecard, h => h.distanceM, h => h.holeNumber), sourceRankMaps: [], scorecardLengthOrder: scorecardLengthOrder(scorecard), candidateLengthOrder: candidateLengthOrder(candidates) },
      score: 0, numberingUnavailableReason: unavailableReason
    };
  }
  match.scorecardEvidence = scorecardEvidenceSummary(input, scorecardSources, scorecard, expected);
  match.scorecardEvidence.requiredDistanceCount = requiredDistanceCount;
  warnings = warnings.concat(match.warnings || []);
  if (match.numberingUnavailableReason && warnings.indexOf(match.numberingUnavailableReason) < 0) warnings.push(match.numberingUnavailableReason);
  if (greenResult.accepted.length < Math.min(6, expected)) warnings.push("Few reliable green polygons were found inside the course boundary.");
  if (!candidates.length) warnings.push("No candidate centre-lines could be constructed.");
  const status = resolveStatus(match.assignments, match.confidence, expected, scorecardUsableForNumbering);
  const assignedIds = {};
  match.assignments.forEach(a => { assignedIds[a.candidate.candidateId] = true; });
  const result = {
    courseId, resolverRunId, status, holes: match.assignments, unresolvedCandidates: candidates.filter(c => !assignedIds[c.candidateId]),
    unresolvedScorecardHoles: match.unresolvedScorecardHoles, analysisBoundary, confidence: match.confidence, overallConfidence: match.confidence,
    warnings, resolverVersion: RESOLVER_VERSION, resolvedAt: nowIso(), source: SOURCE,
    debugEvidence: {
      resolverRunId, analysisBoundary, osmFeatureCount: elements.length, fairwayCount: elements.filter(e => golfTag(e) === "fairway").length,
      expectedHoleCount: expected, greenCandidates: greenResult.accepted, rejectedGreenCandidates: greenResult.rejected, holeCandidates: candidates,
      /* Every candidate the ground offered, before another course's claim was
         taken out. holeCandidates is what THIS run could choose from; this is
         how big the site is, which is the number the multi-loop check reads. */
      totalHoleCandidates: allCandidates.length,
      scorecardHoles: scorecard, scorecardEvidence: match.scorecardEvidence, scorecardSources, scorecardDistanceCount: distanceEvidenceCount,
      assignmentContext: match.context || {}, assignmentScore: match.score || 0, assignmentAlternatives: match.alternatives || []
    }
  };
  result.feedback = buildFeedback(result);
  return result;
}

/* Converts one resolver assignment (result.holes[i]) into the same {hole, points, source,
   resolverVersion, resolverConfidence, ...} "guide" shape functions/lib/gd-automapper-core.mjs
   already knows how to turn into saved tee/green/fairway objects - ported from
   guideFromResolvedHole (gd-course-library-pin-lock.js:2475-2499). mediumConfidence gates
   which guides are trusted enough to save, same threshold the client used. */
export function guideFromResolvedHole(resolved, result, mediumConfidence = MEDIUM_CONFIDENCE) {
  const candidate = resolved && resolved.candidate;
  const points = ((candidate && candidate.path) || []).filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!points.length) return null;
  const h = validHoleNumber(resolved && resolved.holeNumber);
  if (!h) return null;
  const high = HIGH_CONFIDENCE;
  const acceptedResolvedRun = String((result && result.status) || "") === "resolved" && Array.isArray(result && result.holes) && result.holes.length > 0 && !((result && result.unresolvedScorecardHoles || []).length);
  const confidence = Number(resolved.confidence) || 0;
  if (confidence < mediumConfidence) return null;
  return {
    id: "cgr-" + h + "-" + candidate.candidateId, hole: h, par: resolved.par || candidate.inferredPar, points,
    source: (result && result.source) || SOURCE, resolverVersion: (result && result.resolverVersion) || RESOLVER_VERSION, resolvedAt: (result && result.resolvedAt) || nowIso(),
    resolverConfidence: confidence, resolverMatchScore: Number(resolved.matchScore) || 0,
    resolverEvidence: Array.isArray(resolved.evidence) ? resolved.evidence.slice(0, 18) : [],
    resolverProvisional: !acceptedResolvedRun && confidence < high,
    officialDistanceM: Number(resolved.officialDistanceM) || undefined, greenId: candidate.greenId || ""
  };
}

export const __geometryResolverCoreTest = {
  detectGreenCandidates, detectHoleGeometryCandidates, matchCandidatesToScorecard, normalizeScorecard, normalizeScorecardSources,
  scorecardEvidenceSummary, resolveStatus, distanceM, HIGH_CONFIDENCE, MEDIUM_CONFIDENCE
};
