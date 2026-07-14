/*
 * gd-course-geometry-resolver.js
 * --------------------------------
 * Self-contained Course Geometry Resolver for the existing Clarity Caddie
 * AutoMapper. It does not save course maps or own GPS play; it returns
 * evidence-backed hole candidates that gd-course-library-pin-lock.js can feed
 * through the normal AutoMapper save path.
 */
(function () {
  "use strict";

  var SOURCE = "automapper-course-geometry-resolver";
  var RESOLVER_VERSION = "course-geometry-resolver-v1";
  var HIGH_CONFIDENCE = 0.76;
  var MEDIUM_CONFIDENCE = 0.58;
  var EARTH_RADIUS_M = 6371008.8;
  var MAX_BEAM_WIDTH = 360;
  var GREEN_FAIRWAY_LINK_MAX_M = 230;
  var activeRunId = "";

  function number(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function makeRunId(courseId) {
    return "cgr-" + String(courseId || "course").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 36) + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  function mappingDebug() {
    return window.GDCourseMappingDebug && typeof window.GDCourseMappingDebug.recordEvent === "function" ? window.GDCourseMappingDebug : null;
  }

  function recordMappingDebug(runId, event) {
    try {
      var api = mappingDebug();
      if (!api) return null;
      return api.recordEvent(runId, event);
    } catch (e) {
      return null;
    }
  }

  function attachMappingCheckpoint(runId, checkpoint) {
    try {
      var api = mappingDebug();
      if (!api || typeof api.attachCheckpoint !== "function") return null;
      return api.attachCheckpoint(runId, checkpoint);
    } catch (e) {
      return null;
    }
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }

  function toPoint(value) {
    if (!value) return null;
    var lat = number(value.lat, NaN);
    var lng = number(value.lng != null ? value.lng : value.lon, NaN);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat: lat, lng: lng } : null;
  }

  function rad(value) {
    return value * Math.PI / 180;
  }

  function distanceM(a, b) {
    a = toPoint(a);
    b = toPoint(b);
    if (!a || !b) return Infinity;
    var dLat = rad(b.lat - a.lat);
    var dLng = rad(b.lng - a.lng);
    var lat1 = rad(a.lat);
    var lat2 = rad(b.lat);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  }

  function lineDistanceM(points) {
    var pts = (points || []).map(toPoint).filter(Boolean);
    var total = 0;
    for (var i = 1; i < pts.length; i += 1) total += distanceM(pts[i - 1], pts[i]);
    return total;
  }

  function elementId(element, fallback) {
    return String((element && element.type) || "osm") + "-" + String((element && element.id) || fallback || "feature");
  }

  function tags(element) {
    return element && element.tags ? element.tags : {};
  }

  function tagText(element, key) {
    return String(tags(element)[key] || "").trim();
  }

  function golfTag(element) {
    return tagText(element, "golf").toLowerCase();
  }

  function validHoleNumber(value) {
    var match = String(value || "").match(/\d+/);
    var n = match ? Number(match[0]) : Number(value);
    return Number.isFinite(n) && n >= 1 && n <= 36 ? n : null;
  }

  function elementPoints(element) {
    var pts = [];
    function add(raw) {
      var point = toPoint(raw);
      if (point) pts.push(point);
    }
    if (Array.isArray(element && element.geometry)) element.geometry.forEach(add);
    if (Array.isArray(element && element.members)) {
      element.members.forEach(function (member) {
        if (Array.isArray(member && member.geometry)) member.geometry.forEach(add);
      });
    }
    return dedupeNearbyPoints(pts, 0.4);
  }

  function dedupeNearbyPoints(points, metres) {
    var clean = [];
    (points || []).forEach(function (point) {
      var p = toPoint(point);
      if (!p) return;
      var prev = clean[clean.length - 1];
      if (!prev || distanceM(prev, p) > (metres || 0.5)) clean.push(p);
    });
    return clean;
  }

  function cleanPolygon(points) {
    var pts = dedupeNearbyPoints(points, 0.6);
    if (pts.length > 3 && distanceM(pts[0], pts[pts.length - 1]) < 1.5) pts.pop();
    return pts.length >= 3 ? pts : null;
  }

  function centroid(points) {
    var pts = (points || []).map(toPoint).filter(Boolean);
    if (!pts.length) return null;
    var lat = 0;
    var lng = 0;
    pts.forEach(function (point) {
      lat += point.lat;
      lng += point.lng;
    });
    return { lat: lat / pts.length, lng: lng / pts.length };
  }

  function boundsForPoints(points) {
    var pts = (points || []).map(toPoint).filter(Boolean);
    if (!pts.length) return null;
    var minLat = Infinity;
    var maxLat = -Infinity;
    var minLng = Infinity;
    var maxLng = -Infinity;
    pts.forEach(function (point) {
      minLat = Math.min(minLat, point.lat);
      maxLat = Math.max(maxLat, point.lat);
      minLng = Math.min(minLng, point.lng);
      maxLng = Math.max(maxLng, point.lng);
    });
    return { minLat: minLat, maxLat: maxLat, minLng: minLng, maxLng: maxLng };
  }

  function boundsPolygon(bounds, padM) {
    if (!bounds) return [];
    var centerLat = (bounds.minLat + bounds.maxLat) / 2 || 0;
    var latPad = (padM || 0) / 111320;
    var lngPad = (padM || 0) / (111320 * Math.max(0.2, Math.cos(rad(centerLat))));
    return [
      { lat: bounds.minLat - latPad, lng: bounds.minLng - lngPad },
      { lat: bounds.minLat - latPad, lng: bounds.maxLng + lngPad },
      { lat: bounds.maxLat + latPad, lng: bounds.maxLng + lngPad },
      { lat: bounds.maxLat + latPad, lng: bounds.minLng - lngPad }
    ];
  }

  function inputCenter(input) {
    input = input || {};
    var course = input.course || {};
    return toPoint(input.courseCentre) ||
      toPoint(input.courseCenter) ||
      toPoint(input.center) ||
      toPoint(course.courseCentre) ||
      toPoint(course.courseCenter) ||
      toPoint(course.center) ||
      toPoint({ lat: course.courseLat || course.lat || course.latitude, lng: course.courseLng || course.lng || course.longitude }) ||
      toPoint(input.mapViewport && input.mapViewport.center);
  }

  function viewportBoundary(viewport) {
    var bounds = viewport && viewport.bounds || viewport;
    if (!bounds) return null;
    var north = number(bounds.north != null ? bounds.north : bounds.maxLat, NaN);
    var south = number(bounds.south != null ? bounds.south : bounds.minLat, NaN);
    var east = number(bounds.east != null ? bounds.east : bounds.maxLng, NaN);
    var west = number(bounds.west != null ? bounds.west : bounds.minLng, NaN);
    if (![north, south, east, west].every(Number.isFinite)) return null;
    return [
      { lat: south, lng: west },
      { lat: south, lng: east },
      { lat: north, lng: east },
      { lat: north, lng: west }
    ];
  }

  function explicitBoundary(input) {
    input = input || {};
    var candidates = [input.courseBoundary, input.boundary, input.analysisBoundary];
    for (var i = 0; i < candidates.length; i += 1) {
      var polygon = cleanPolygon(candidates[i]);
      if (polygon) return polygon;
    }
    return null;
  }

  function projectPoint(point, bounds, width, height) {
    point = toPoint(point);
    if (!point || !bounds) return null;
    var x = (point.lng - bounds.minLng) / ((bounds.maxLng - bounds.minLng) || 1e-9);
    var y = (bounds.maxLat - point.lat) / ((bounds.maxLat - bounds.minLat) || 1e-9);
    return {
      x: clamp(x, 0, 1) * width,
      y: clamp(y, 0, 1) * height
    };
  }

  function svgPath(points, bounds, width, height, close) {
    var projected = (points || []).map(function (point) { return projectPoint(point, bounds, width, height); }).filter(Boolean);
    if (!projected.length) return "";
    return projected.map(function (point, index) {
      return (index ? "L" : "M") + point.x.toFixed(1) + " " + point.y.toFixed(1);
    }).join(" ") + (close ? " Z" : "");
  }

  function pointInPolygon(point, polygon) {
    point = toPoint(point);
    var poly = (polygon || []).map(toPoint).filter(Boolean);
    if (!point || poly.length < 3) return true;
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
      var xi = poly[i].lng;
      var yi = poly[i].lat;
      var xj = poly[j].lng;
      var yj = poly[j].lat;
      var intersects = ((yi > point.lat) !== (yj > point.lat)) &&
        (point.lng < (xj - xi) * (point.lat - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function polygonAreaM2(points) {
    var pts = cleanPolygon(points);
    if (!pts) return null;
    var c = centroid(pts) || pts[0];
    var latScale = 111320;
    var lngScale = 111320 * Math.max(0.2, Math.cos(rad(c.lat)));
    var area = 0;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
      var xi = (pts[i].lng - c.lng) * lngScale;
      var yi = (pts[i].lat - c.lat) * latScale;
      var xj = (pts[j].lng - c.lng) * lngScale;
      var yj = (pts[j].lat - c.lat) * latScale;
      area += xj * yi - xi * yj;
    }
    return Math.abs(area / 2);
  }

  function spanM(points, center) {
    var c = center || centroid(points);
    if (!c) return Infinity;
    var max = 0;
    (points || []).forEach(function (point) {
      max = Math.max(max, distanceM(c, point));
    });
    return max * 2;
  }

  function nearestFeatureDistance(point, elements, predicate) {
    var best = Infinity;
    (elements || []).forEach(function (element) {
      if (predicate && !predicate(element)) return;
      elementPoints(element).forEach(function (p) {
        best = Math.min(best, distanceM(point, p));
      });
    });
    return best;
  }

  function hasTextRisk(element, pattern) {
    var text = [
      tagText(element, "name"),
      tagText(element, "description"),
      tagText(element, "note"),
      tagText(element, "ref")
    ].join(" ").toLowerCase();
    return pattern.test(text);
  }

  function deriveAnalysisBoundary(input, elements) {
    var course = input.course || {};
    var boundary = explicitBoundary(input);
    if (boundary) return boundary;
    var coursePolygons = (elements || []).filter(function (element) {
      return golfTag(element) === "course" && cleanPolygon(elementPoints(element));
    });
    if (coursePolygons.length) {
      var longest = coursePolygons
        .map(function (element) { return cleanPolygon(elementPoints(element)); })
        .sort(function (a, b) { return (polygonAreaM2(b) || 0) - (polygonAreaM2(a) || 0); })[0];
      return longest;
    }
    var featurePoints = [];
    (elements || []).forEach(function (element) {
      var golf = golfTag(element);
      var water = tagText(element, "natural") === "water" || !!tagText(element, "water");
      if (golf || water) featurePoints = featurePoints.concat(elementPoints(element));
    });
    if (featurePoints.length >= 3) return boundsPolygon(boundsForPoints(featurePoints), 90);
    var center = inputCenter(input);
    if (!center) return [];
    var dLat = 1400 / 111320;
    var dLng = 1400 / (111320 * Math.max(0.2, Math.cos(rad(center.lat))));
    return [
      { lat: center.lat - dLat, lng: center.lng - dLng },
      { lat: center.lat - dLat, lng: center.lng + dLng },
      { lat: center.lat + dLat, lng: center.lng + dLng },
      { lat: center.lat + dLat, lng: center.lng - dLng }
    ];
  }

  function greenCandidateFromElement(element, elements, boundary, index) {
    var polygon = cleanPolygon(elementPoints(element));
    if (!polygon) return null;
    var center = centroid(polygon);
    if (!center || !pointInPolygon(center, boundary)) return null;
    var area = polygonAreaM2(polygon);
    var span = spanM(polygon, center);
    var compactArea = area && span ? area / Math.max(1, Math.PI * Math.pow(span / 2, 2)) : 0;
    var shapeScore = clamp(1 - Math.abs((span || 55) - 48) / 95, 0, 1);
    if (area) shapeScore = (shapeScore + clamp(1 - Math.abs(area - 900) / 1800, 0, 1) + clamp(compactArea, 0, 1)) / 3;
    var osmScore = golfTag(element) === "green" ? 1 : 0.2;
    var nearFairway = nearestFeatureDistance(center, elements, function (candidate) {
      return golfTag(candidate) === "fairway" || golfTag(candidate) === "hole" || golfTag(candidate) === "tee";
    });
    var courseContextScore = nearFairway <= 60 ? 1 : nearFairway <= 180 ? 0.68 : 0.28;
    var practiceGreenRisk = 0;
    if (hasTextRisk(element, /\b(practice|putting|nursery|range|target)\b/i)) practiceGreenRisk += 0.7;
    if (nearestFeatureDistance(center, elements, function (candidate) {
      return golfTag(candidate) === "driving_range" || golfTag(candidate) === "practice_area";
    }) < 120) practiceGreenRisk += 0.25;
    practiceGreenRisk = clamp(practiceGreenRisk, 0, 1);
    var evidence = ["osm:" + elementId(element, index), "span:" + Math.round(span) + "m"];
    if (area) evidence.push("area:" + Math.round(area) + "m2");
    if (nearFairway < Infinity) evidence.push("course-context:" + Math.round(nearFairway) + "m");
    if (practiceGreenRisk) evidence.push("practice-risk:" + practiceGreenRisk.toFixed(2));
    var confidence = clamp(0.38 * shapeScore + 0.32 * osmScore + 0.3 * courseContextScore - 0.36 * practiceGreenRisk, 0, 1);
    return {
      id: elementId(element, "green-" + index),
      centre: center,
      polygon: polygon,
      areaM2: area || undefined,
      shapeScore: shapeScore,
      osmScore: osmScore,
      courseContextScore: courseContextScore,
      practiceGreenRisk: practiceGreenRisk,
      confidence: confidence,
      evidence: evidence
    };
  }

  function detectGreenCandidates(elements, boundary) {
    var accepted = [];
    var rejected = [];
    (elements || []).forEach(function (element, index) {
      var golf = golfTag(element);
      var isGreen = golf === "green";
      var isExcluded = golf === "bunker" || golf === "water_hazard" ||
        tagText(element, "natural") === "water" || tagText(element, "building");
      if (!isGreen || isExcluded) return;
      var candidate = greenCandidateFromElement(element, elements, boundary, index);
      if (!candidate) return;
      if (candidate.confidence >= 0.42 && candidate.practiceGreenRisk < 0.72) accepted.push(candidate);
      else rejected.push(candidate);
    });
    return {
      accepted: dedupeGreenCandidates(accepted),
      rejected: rejected
    };
  }

  function dedupeGreenCandidates(greens) {
    return (greens || [])
      .slice()
      .sort(function (a, b) { return b.confidence - a.confidence; })
      .filter(function (green, index, all) {
        return all.slice(0, index).every(function (prev) {
          return distanceM(prev.centre, green.centre) > 12;
        });
      });
  }

  function angleBetween(a, b, c) {
    a = toPoint(a);
    b = toPoint(b);
    c = toPoint(c);
    if (!a || !b || !c) return 0;
    var ux = a.lng - b.lng;
    var uy = a.lat - b.lat;
    var vx = c.lng - b.lng;
    var vy = c.lat - b.lat;
    var dot = ux * vx + uy * vy;
    var mag = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
    if (!mag) return 0;
    return Math.acos(clamp(dot / mag, -1, 1)) * 180 / Math.PI;
  }

  function turnSign(a, b, c) {
    a = toPoint(a);
    b = toPoint(b);
    c = toPoint(c);
    if (!a || !b || !c) return 0;
    var abx = b.lng - a.lng;
    var aby = b.lat - a.lat;
    var bcx = c.lng - b.lng;
    var bcy = c.lat - b.lat;
    return abx * bcy - aby * bcx;
  }

  function directionChanges(points) {
    var pts = (points || []).map(toPoint).filter(Boolean);
    var changes = [];
    for (var i = 1; i < pts.length - 1; i += 1) {
      var angle = 180 - angleBetween(pts[i - 1], pts[i], pts[i + 1]);
      if (Math.abs(angle) >= 18) changes.push({ deg: Math.abs(angle), sign: turnSign(pts[i - 1], pts[i], pts[i + 1]) });
    }
    return changes;
  }

  function classifyShape(points) {
    var changes = directionChanges(points);
    var meaningful = changes.filter(function (change) { return change.deg >= 28; });
    if (!meaningful.length) return "straight";
    if (meaningful.length >= 2) return "double-dogleg";
    return meaningful[0].sign > 0 ? "dogleg-left" : "dogleg-right";
  }

  function nearestGreenForPath(path, greens) {
    var pts = (path || []).map(toPoint).filter(Boolean);
    if (pts.length < 2 || !(greens || []).length) return null;
    var first = pts[0];
    var last = pts[pts.length - 1];
    var best = null;
    greens.forEach(function (green) {
      [first, last].forEach(function (endpoint, endpointIndex) {
        var d = distanceM(endpoint, green.centre);
        if (!best || d < best.distance) best = { green: green, distance: d, endpointIndex: endpointIndex };
      });
    });
    return best;
  }

  function orientPathToGreen(path, greens) {
    var pts = (path || []).map(toPoint).filter(Boolean);
    var match = nearestGreenForPath(pts, greens);
    if (match && match.endpointIndex === 0) pts.reverse();
    return { path: pts, green: match && match.green || null, greenDistanceM: match && match.distance || Infinity };
  }

  function localProjector(origin) {
    origin = toPoint(origin) || { lat: 0, lng: 0 };
    var latScale = 111320;
    var lngScale = 111320 * Math.max(0.2, Math.cos(rad(origin.lat)));
    return {
      toXY: function (point) {
        point = toPoint(point);
        return point ? { x: (point.lng - origin.lng) * lngScale, y: (point.lat - origin.lat) * latScale } : null;
      },
      toPoint: function (xy) {
        return { lat: origin.lat + xy.y / latScale, lng: origin.lng + xy.x / lngScale };
      }
    };
  }

  function distancePointToSegmentM(point, a, b) {
    point = toPoint(point);
    a = toPoint(a);
    b = toPoint(b);
    if (!point || !a || !b) return Infinity;
    var projector = localProjector(point);
    var p = projector.toXY(point);
    var aa = projector.toXY(a);
    var bb = projector.toXY(b);
    var vx = bb.x - aa.x;
    var vy = bb.y - aa.y;
    var len2 = vx * vx + vy * vy;
    if (!len2) return Math.sqrt(Math.pow(p.x - aa.x, 2) + Math.pow(p.y - aa.y, 2));
    var t = clamp(((p.x - aa.x) * vx + (p.y - aa.y) * vy) / len2, 0, 1);
    var x = aa.x + vx * t;
    var y = aa.y + vy * t;
    return Math.sqrt(Math.pow(p.x - x, 2) + Math.pow(p.y - y, 2));
  }

  function distancePointToPolygonM(point, polygon) {
    var poly = cleanPolygon(polygon);
    point = toPoint(point);
    if (!point || !poly) return Infinity;
    if (pointInPolygon(point, poly)) return 0;
    var best = Infinity;
    for (var i = 0; i < poly.length; i += 1) {
      best = Math.min(best, distancePointToSegmentM(point, poly[i], poly[(i + 1) % poly.length]));
    }
    return best;
  }

  function distancePointToPathM(point, path) {
    var pts = (path || []).map(toPoint).filter(Boolean);
    if (!toPoint(point) || pts.length < 2) return Infinity;
    var best = Infinity;
    for (var i = 1; i < pts.length; i += 1) {
      best = Math.min(best, distancePointToSegmentM(point, pts[i - 1], pts[i]));
    }
    return best;
  }

  function fairwayMajorAxis(polygon) {
    var pts = cleanPolygon(polygon);
    if (!pts) return null;
    var origin = centroid(pts);
    var projector = localProjector(origin);
    var xy = pts.map(projector.toXY).filter(Boolean);
    if (xy.length < 3) return null;
    var meanX = 0;
    var meanY = 0;
    xy.forEach(function (point) {
      meanX += point.x;
      meanY += point.y;
    });
    meanX /= xy.length;
    meanY /= xy.length;
    var xx = 0;
    var xyCov = 0;
    var yy = 0;
    xy.forEach(function (point) {
      var dx = point.x - meanX;
      var dy = point.y - meanY;
      xx += dx * dx;
      xyCov += dx * dy;
      yy += dy * dy;
    });
    var angle = 0.5 * Math.atan2(2 * xyCov, xx - yy);
    var axis = { x: Math.cos(angle), y: Math.sin(angle) };
    var min = Infinity;
    var max = -Infinity;
    xy.forEach(function (point) {
      var projection = point.x * axis.x + point.y * axis.y;
      min = Math.min(min, projection);
      max = Math.max(max, projection);
    });
    if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 60) return null;
    function pointAt(projection) {
      return projector.toPoint({ x: axis.x * projection, y: axis.y * projection });
    }
    return {
      min: min,
      max: max,
      spanM: max - min,
      center: pointAt((min + max) / 2),
      a: pointAt(min),
      b: pointAt(max),
      projectionForPoint: function (point) {
        var p = projector.toXY(point);
        return p ? p.x * axis.x + p.y * axis.y : NaN;
      },
      pointAt: pointAt
    };
  }

  function nearbyFeatureCount(point, elements, radiusM, predicate) {
    var count = 0;
    (elements || []).forEach(function (element) {
      if (predicate && !predicate(element)) return;
      var pts = elementPoints(element);
      if (pts.some(function (p) { return distanceM(point, p) <= radiusM; })) count += 1;
    });
    return count;
  }

  function hasNearbyWater(path, elements) {
    return (path || []).some(function (point) {
      return nearestFeatureDistance(point, elements, function (element) {
        return golfTag(element) === "water_hazard" ||
          golfTag(element) === "lateral_water_hazard" ||
          tagText(element, "natural") === "water" ||
          !!tagText(element, "water");
      }) <= 55;
    });
  }

  function inferredParForDistance(distance) {
    if (!Number.isFinite(distance)) return undefined;
    if (distance >= 430) return 5;
    if (distance >= 225) return 4;
    return 3;
  }

  function orientPathToSpecificGreen(path, green) {
    var pts = (path || []).map(toPoint).filter(Boolean);
    green = green || null;
    if (pts.length >= 2 && green && toPoint(green.centre)) {
      var first = distanceM(pts[0], green.centre);
      var last = distanceM(pts[pts.length - 1], green.centre);
      if (first < last) pts.reverse();
      return { path: pts, green: green, greenDistanceM: Math.min(first, last) };
    }
    return { path: pts, green: null, greenDistanceM: Infinity };
  }

  function buildCandidate(id, rawPath, greens, elements, source, extraEvidence, forcedGreen) {
    var oriented = forcedGreen ? orientPathToSpecificGreen(rawPath, forcedGreen) : orientPathToGreen(rawPath, greens);
    var path = dedupeNearbyPoints(oriented.path, 2);
    if (path.length < 2) return null;
    var green = oriented.green;
    var pathDistance = lineDistanceM(path);
    var straightLine = distanceM(path[0], path[path.length - 1]);
    var changes = directionChanges(path);
    var nearbyBunkers = green ? nearbyFeatureCount(green.centre, elements, 90, function (element) {
      return golfTag(element) === "bunker";
    }) : 0;
    var evidence = [source, "path:" + Math.round(pathDistance) + "m"].concat(extraEvidence || []);
    if (green) evidence.push("green:" + green.id);
    if (oriented.greenDistanceM < Infinity) evidence.push("green-distance:" + Math.round(oriented.greenDistanceM) + "m");
    var confidence = source === "osm-hole-line" ? 0.72 : source === "fairway-centreline" ? 0.64 : 0.48;
    if (green && oriented.greenDistanceM <= 95) confidence += 0.12;
    if (pathDistance >= 70 && pathDistance <= 620) confidence += 0.08;
    if (straightLine > 0 && pathDistance / straightLine < 1.55) confidence += 0.04;
    return {
      candidateId: id,
      greenId: green && green.id || "",
      teeCandidates: [path[0]],
      path: path,
      straightLineDistanceM: straightLine,
      pathDistanceM: pathDistance,
      inferredPar: inferredParForDistance(pathDistance),
      shape: classifyShape(path),
      directionChangesDeg: changes.map(function (change) { return Math.round(change.deg); }),
      nearbyWater: hasNearbyWater(path, elements),
      crossingWater: false,
      nearbyBunkers: nearbyBunkers,
      confidence: clamp(confidence, 0, 1),
      evidence: evidence
    };
  }

  function fairwayCenterlineForGreen(green, fairway, index, boundary) {
    var polygon = cleanPolygon(elementPoints(fairway));
    if (!green || !polygon) return null;
    var center = centroid(polygon);
    if (center && !pointInPolygon(center, boundary)) return null;
    var fairwayDistance = distancePointToPolygonM(green.centre, polygon);
    if (fairwayDistance > GREEN_FAIRWAY_LINK_MAX_M) return null;
    var axis = fairwayMajorAxis(polygon);
    if (!axis) return null;
    var endpointA = axis.a;
    var endpointB = axis.b;
    var aDistance = distanceM(endpointA, green.centre);
    var bDistance = distanceM(endpointB, green.centre);
    var near = aDistance <= bDistance ? endpointA : endpointB;
    var far = aDistance <= bDistance ? endpointB : endpointA;
    var greenProjection = axis.projectionForPoint(green.centre);
    var projectedGreenSide = Number.isFinite(greenProjection) ? axis.pointAt(clamp(greenProjection, axis.min, axis.max)) : near;
    if (distanceM(projectedGreenSide, green.centre) > distanceM(near, green.centre) + 35) projectedGreenSide = near;
    var rawPath = [far, axis.center, projectedGreenSide, green.centre].filter(Boolean);
    var evidence = [
      "fairway:" + elementId(fairway, "fairway-" + index),
      "green-led",
      "fairway-distance:" + Math.round(fairwayDistance) + "m",
      "fairway-axis-span:" + Math.round(axis.spanM) + "m"
    ];
    return buildCandidate(
      elementId(fairway, "fairway-" + index) + "-" + green.id,
      rawPath,
      [green],
      [fairway],
      "fairway-centreline",
      evidence,
      green
    );
  }

  function greenLedFairwayCandidates(elements, greens, boundary) {
    var fairways = (elements || []).map(function (element, index) {
      if (golfTag(element) !== "fairway") return null;
      var polygon = cleanPolygon(elementPoints(element));
      if (!polygon) return null;
      return { element: element, index: index, polygon: polygon };
    }).filter(Boolean);
    if (!fairways.length || !(greens || []).length) return [];
    var candidates = [];
    (greens || []).forEach(function (green) {
      var ranked = fairways.map(function (fairway) {
        return {
          fairway: fairway,
          distance: distancePointToPolygonM(green.centre, fairway.polygon)
        };
      }).filter(function (entry) {
        return Number.isFinite(entry.distance) && entry.distance <= GREEN_FAIRWAY_LINK_MAX_M;
      }).sort(function (a, b) {
        return a.distance - b.distance;
      });
      for (var i = 0; i < ranked.length; i += 1) {
        var candidate = fairwayCenterlineForGreen(green, ranked[i].fairway.element, ranked[i].fairway.index, boundary);
        if (candidate) {
          candidates.push(candidate);
          break;
        }
      }
    });
    return candidates;
  }

  function greenLedHoleLineCorridorCandidates(elements, greens, boundary) {
    var lines = (elements || []).map(function (element, index) {
      if (golfTag(element) !== "hole") return null;
      var pts = elementPoints(element);
      if (pts.length < 2) return null;
      var center = centroid(pts);
      if (center && !pointInPolygon(center, boundary)) return null;
      return { element: element, index: index, points: pts };
    }).filter(Boolean);
    if (!lines.length || !(greens || []).length) return [];
    var candidates = [];
    (greens || []).forEach(function (green) {
      var ranked = lines.map(function (line) {
        return {
          line: line,
          distance: Math.min(distancePointToPathM(green.centre, line.points), distanceM(green.centre, line.points[0]), distanceM(green.centre, line.points[line.points.length - 1]))
        };
      }).filter(function (entry) {
        return Number.isFinite(entry.distance) && entry.distance <= GREEN_FAIRWAY_LINK_MAX_M;
      }).sort(function (a, b) {
        return a.distance - b.distance;
      });
      if (!ranked.length) return;
      var line = ranked[0].line;
      var ref = validHoleNumber(tagText(line.element, "ref") || tagText(line.element, "name"));
      var candidate = buildCandidate(
        elementId(line.element, "hole-" + line.index) + "-" + green.id,
        line.points,
        [green],
        elements,
        "fairway-centreline",
        ["osm-hole-line-as-fairway", "green-led", "hole-line-distance:" + Math.round(ranked[0].distance) + "m"].concat(ref ? ["existing-ref:" + ref] : ["missing-ref"]),
        green
      );
      if (candidate) {
        candidate.existingHoleNumber = ref || undefined;
        candidates.push(candidate);
      }
    });
    return candidates;
  }

  function fairwayCorridorCount(elements, candidates) {
    var taggedFairways = geometryIds(elements || [], "fairway").length;
    var inferred = (candidates || []).filter(function (candidate) {
      return (candidate.evidence || []).indexOf("fairway-centreline") >= 0 ||
        (candidate.evidence || []).indexOf("osm-hole-line-as-fairway") >= 0;
    }).length;
    return Math.max(taggedFairways, inferred);
  }

  function detectHoleGeometryCandidates(elements, greens, boundary) {
    var holeLineCandidates = [];
    (elements || []).forEach(function (element, index) {
      var golf = golfTag(element);
      var pts = elementPoints(element);
      if (!pts.length) return;
      if (golf === "hole" && pts.length >= 2) {
        var center = centroid(pts);
        if (center && !pointInPolygon(center, boundary)) return;
        var ref = validHoleNumber(tagText(element, "ref") || tagText(element, "name"));
        var candidate = buildCandidate(
          elementId(element, "hole-" + index),
          pts,
          greens,
          elements,
          "osm-hole-line",
          [ref ? "existing-ref:" + ref : "missing-ref"]
        );
        if (candidate) {
          candidate.existingHoleNumber = ref || undefined;
          holeLineCandidates.push(candidate);
        }
      }
    });
    var fairwayCandidates = greenLedFairwayCandidates(elements, greens, boundary);
    if (fairwayCandidates.length) {
      var labelledHoleLines = holeLineCandidates.filter(function (candidate) { return candidate.existingHoleNumber; });
      return dedupeCandidates(fairwayCandidates.concat(labelledHoleLines));
    }
    var holeLineCorridors = greenLedHoleLineCorridorCandidates(elements, greens, boundary);
    if (holeLineCorridors.length) return dedupeCandidates(holeLineCorridors);
    return dedupeCandidates(holeLineCandidates);
  }

  function dedupeCandidates(candidates) {
    return (candidates || [])
      .slice()
      .sort(function (a, b) { return b.confidence - a.confidence; })
      .filter(function (candidate, index, all) {
        return all.slice(0, index).every(function (prev) {
          var sameGreen = candidate.greenId && prev.greenId && candidate.greenId === prev.greenId;
          var teeClose = distanceM(candidate.path[0], prev.path[0]) < 25;
          var greenClose = distanceM(candidate.path[candidate.path.length - 1], prev.path[prev.path.length - 1]) < 25;
          return !(sameGreen && teeClose && greenClose);
        });
      });
  }

  function yardsToMetres(value) {
    var n = number(value, NaN);
    return Number.isFinite(n) ? n * 0.9144 : undefined;
  }

  function metres(value) {
    var n = number(value, NaN);
    return Number.isFinite(n) ? n : undefined;
  }

  function descriptionEvidence(text) {
    text = String(text || "").toLowerCase();
    var evidence = { landmarks: [] };
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
    ["bunker", "creek", "lake", "pond", "clubhouse", "trees", "narrow"].forEach(function (word) {
      if (text.indexOf(word) >= 0) evidence.landmarks.push(word);
    });
    return evidence;
  }

  function normalizeScorecardHole(raw, fallbackHole) {
    raw = raw || {};
    var holeNumber = validHoleNumber(raw.holeNumber || raw.hole || raw.number || raw.no || fallbackHole);
    if (!holeNumber) return null;
    var distanceMValue = metres(raw.distanceM || raw.meters || raw.metres || raw.distanceMeters || raw.distanceMetres);
    var distanceYdValue = number(raw.distanceYd || raw.yards || raw.yds || raw.yardage || raw.distanceYards, NaN);
    if (!Number.isFinite(distanceMValue) && Number.isFinite(distanceYdValue)) distanceMValue = yardsToMetres(distanceYdValue);
    var text = [raw.name, raw.description, raw.notes, raw.tip, raw.summary].filter(Boolean).join(" ");
    return {
      holeNumber: holeNumber,
      par: validPar(raw.par),
      distanceM: distanceMValue,
      distanceYd: Number.isFinite(distanceYdValue) ? distanceYdValue : undefined,
      name: raw.name || undefined,
      description: raw.description || raw.notes || raw.tip || undefined,
      descriptionEvidence: descriptionEvidence(text)
    };
  }

  function validPar(value) {
    var n = number(value, NaN);
    return Number.isFinite(n) && n >= 3 && n <= 6 ? n : undefined;
  }

  function scorecardSourceHoles(source) {
    if (Array.isArray(source)) return source;
    if (Array.isArray(source && source.holes)) return source.holes;
    if (Array.isArray(source && source.scorecard && source.scorecard.holes)) return source.scorecard.holes;
    return [];
  }

  function pushScorecardSource(entries, source, label, url) {
    if (!source) return;
    var holes = scorecardSourceHoles(source);
    if (!holes.length) return;
    entries.push({
      source: source,
      label: String(label || source.source || source.provider || source.name || "scorecard").trim(),
      sourceUrl: String(url || source.sourceUrl || source.url || "").trim()
    });
  }

  function scorecardSourceEntries(input) {
    input = input || {};
    var entries = [];
    var evidence = input.scorecardEvidence || {};
    var evidenceSources = Array.isArray(evidence.sources) ? evidence.sources : [];
    if (evidenceSources.length) {
      evidenceSources.forEach(function (source) {
        pushScorecardSource(entries, source.holes || source.scorecard || source, source.source || source.provider || evidence.source, source.sourceUrl || source.url);
      });
    } else if (Array.isArray(evidence.holes)) {
      pushScorecardSource(entries, evidence.holes, evidence.source || "scorecard-evidence", evidence.sourceUrl || "");
    }
    if (!evidenceSources.length && Array.isArray(input.scorecardHoles)) pushScorecardSource(entries, input.scorecardHoles, "scorecard-holes", "");
    if (!evidenceSources.length && input.scorecard) pushScorecardSource(entries, input.scorecard, input.scorecard.source || "scorecard", input.scorecard.sourceUrl || "");
    try {
      if (!evidenceSources.length && window.scorecard) pushScorecardSource(entries, window.scorecard, window.scorecard.source || "window-scorecard", window.scorecard.sourceUrl || "");
      if (!evidenceSources.length && window.gdScorecard) pushScorecardSource(entries, window.gdScorecard, window.gdScorecard.source || "window-gdScorecard", window.gdScorecard.sourceUrl || "");
      if (!evidenceSources.length && window.currentScorecard) pushScorecardSource(entries, window.currentScorecard, window.currentScorecard.source || "window-currentScorecard", window.currentScorecard.sourceUrl || "");
    } catch (e) { /* no-op */ }
    return entries;
  }

  function normalizeScorecardSources(input) {
    var seen = {};
    return scorecardSourceEntries(input || {}).map(function (entry, index) {
      var normalized = scorecardSourceHoles(entry.source).map(function (hole, holeIndex) {
        return normalizeScorecardHole(hole, holeIndex + 1);
      }).filter(Boolean).sort(function (a, b) { return a.holeNumber - b.holeNumber; });
      var completeDistances = normalized.filter(function (hole) { return Number.isFinite(hole.distanceM); }).length;
      var signature = normalized.map(function (hole) {
        return hole.holeNumber + ":" + (Number.isFinite(hole.distanceM) ? Math.round(hole.distanceM) : "");
      }).join("|");
      var key = (entry.sourceUrl || entry.label || ("inline-" + index)) + "|" + signature;
      if (!normalized.length || seen[key]) return null;
      seen[key] = true;
      return {
        source: entry.label || "scorecard",
        sourceUrl: entry.sourceUrl || "",
        holes: normalized,
        distanceCount: completeDistances
      };
    }).filter(Boolean);
  }

  function normalizeScorecard(input, normalizedSources) {
    normalizedSources = normalizedSources || normalizeScorecardSources(input || {});
    var best = [];
    normalizedSources.forEach(function (source) {
      var bestDistances = best.filter(function (hole) { return Number.isFinite(hole.distanceM); }).length;
      if (source.holes.length > best.length || source.distanceCount > bestDistances) best = source.holes;
    });
    return best.sort(function (a, b) { return a.holeNumber - b.holeNumber; });
  }

  function scorecardDistanceCount(scorecard) {
    return (scorecard || []).filter(function (hole) { return Number.isFinite(hole.distanceM); }).length;
  }

  function scorecardLengthOrder(scorecard) {
    return (scorecard || []).filter(function (hole) { return Number.isFinite(hole.distanceM); }).map(function (hole) {
      return {
        hole: hole.holeNumber,
        distanceM: Math.round(hole.distanceM),
        par: hole.par
      };
    }).sort(function (a, b) { return b.distanceM - a.distanceM; });
  }

  function candidateLengthOrder(candidates) {
    return (candidates || []).filter(function (candidate) { return Number.isFinite(candidate.pathDistanceM); }).map(function (candidate) {
      return {
        candidateId: candidate.candidateId,
        displayId: candidate.displayId || "",
        pathDistanceM: Math.round(candidate.pathDistanceM)
      };
    }).sort(function (a, b) { return b.pathDistanceM - a.pathDistanceM; });
  }

  function scorecardEvidenceSummary(input, normalizedSources, scorecard, expected) {
    input = input || {};
    var evidence = input.scorecardEvidence || {};
    var sourceRows = (normalizedSources || []).map(function (source) {
      return {
        source: source.source || "scorecard",
        sourceUrl: source.sourceUrl || "",
        holes: source.holes.length,
        distanceCount: source.distanceCount,
        lengthOrder: scorecardLengthOrder(source.holes).slice(0, Math.max(18, expected || 18))
      };
    });
    var distanceCount = scorecardDistanceCount(scorecard);
    var explicitDistanceCount = number(evidence.distanceCount, NaN);
    if (Number.isFinite(explicitDistanceCount)) distanceCount = Math.max(distanceCount, explicitDistanceCount);
    return {
      source: evidence.source || (sourceRows[0] && sourceRows[0].source) || "",
      sourceUrl: evidence.sourceUrl || (sourceRows[0] && sourceRows[0].sourceUrl) || "",
      sourceCount: sourceRows.length,
      distanceCount: distanceCount,
      requiredDistanceCount: expected ? Math.min(expected, 18) : 18,
      lengthOrder: Array.isArray(evidence.lengthOrder) && evidence.lengthOrder.length ? evidence.lengthOrder : scorecardLengthOrder(scorecard),
      sources: sourceRows
    };
  }

  function median(values) {
    var nums = (values || []).filter(Number.isFinite).sort(function (a, b) { return a - b; });
    if (!nums.length) return null;
    var mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  }

  function distanceScale(candidates, scorecard) {
    var candidateDistances = candidates.map(function (candidate) { return candidate.pathDistanceM; }).filter(Number.isFinite).sort(function (a, b) { return a - b; });
    var cardDistances = scorecard.map(function (hole) { return hole.distanceM; }).filter(Number.isFinite).sort(function (a, b) { return a - b; });
    var pairs = [];
    var count = Math.min(candidateDistances.length, cardDistances.length);
    for (var i = 0; i < count; i += 1) {
      if (cardDistances[i] > 0) pairs.push(candidateDistances[i] / cardDistances[i]);
    }
    return median(pairs) || 1;
  }

  function rankMap(items, getValue, getKey) {
    var sorted = items.slice().filter(function (item) { return Number.isFinite(getValue(item)); })
      .sort(function (a, b) { return getValue(a) - getValue(b); });
    var map = {};
    sorted.forEach(function (item, index) {
      map[getKey(item)] = sorted.length <= 1 ? 0.5 : index / (sorted.length - 1);
    });
    return map;
  }

  function scorePair(candidate, hole, context) {
    var score = 0.22 * candidate.confidence;
    var evidence = candidate.evidence.slice();
    var distanceScore = 0;
    var rankScore = 0;
    var multiSourceScore = 0;
    var multiSourceCount = 0;
    var parScore = 0;
    var shapeScore = 0;
    var hazardScore = 0;
    var descriptionScore = 0;
    var rawDistanceDeltaM = Number.isFinite(hole.distanceM) ? Math.abs(candidate.pathDistanceM - hole.distanceM) : null;
    var scaledDistanceDeltaM = null;
    var normalizedDistanceDelta = null;
    var tieBreakersUsed = [];
    var explanation = [];
    if (Number.isFinite(candidate.existingHoleNumber) && candidate.existingHoleNumber === hole.holeNumber) {
      score += 0.24;
      evidence.push("existing-osm-ref-match");
      tieBreakersUsed.push("existing-osm-ref");
      explanation.push("Existing OSM hole number matched this scorecard hole.");
    }
    if (Number.isFinite(hole.distanceM)) {
      var cr = context.candidateRanks[candidate.candidateId];
      var hr = context.scorecardRanks[hole.holeNumber];
      if (Number.isFinite(cr) && Number.isFinite(hr)) {
        rankScore = clamp(1 - Math.abs(cr - hr) / 0.55, 0, 1);
        score += 0.46 * rankScore;
        evidence.push("relative-rank:" + rankScore.toFixed(2));
        if (rankScore >= 0.75) explanation.push("Relative distance rank matched the scorecard structure.");
      }
      if (Array.isArray(context.sourceRankMaps) && context.sourceRankMaps.length > 1 && Number.isFinite(cr)) {
        context.sourceRankMaps.forEach(function (sourceRank) {
          var sr = sourceRank && sourceRank[hole.holeNumber];
          if (!Number.isFinite(sr)) return;
          multiSourceCount += 1;
          multiSourceScore += clamp(1 - Math.abs(cr - sr) / 0.55, 0, 1);
        });
        if (multiSourceCount > 1) {
          multiSourceScore /= multiSourceCount;
          score += 0.12 * multiSourceScore;
          evidence.push("multi-source-rank:" + multiSourceScore.toFixed(2));
          if (multiSourceScore >= 0.78) {
            tieBreakersUsed.push("multi-source-length-order");
            explanation.push("Multiple scorecard sources agreed with this relative length order.");
          }
        }
      }
      var expected = hole.distanceM * context.scale;
      var diff = Math.abs(candidate.pathDistanceM - expected) / Math.max(80, expected);
      scaledDistanceDeltaM = Math.abs(candidate.pathDistanceM - expected);
      normalizedDistanceDelta = diff;
      distanceScore = clamp(1 - diff / 0.28, 0, 1);
      score += 0.10 * distanceScore;
      evidence.push("scale-sanity:" + distanceScore.toFixed(2));
      if (distanceScore >= 0.62) explanation.push("Centre-path distance stayed within the course-wide scorecard scale check.");
    }
    if (hole.par && candidate.inferredPar) {
      parScore = hole.par === candidate.inferredPar ? 1 : Math.abs(hole.par - candidate.inferredPar) === 1 ? 0.42 : 0;
      score += 0.07 * parScore;
      evidence.push("par-score:" + parScore.toFixed(2));
      if (parScore >= 0.8) {
        tieBreakersUsed.push("par");
        explanation.push("Inferred par matched the scorecard par.");
      }
    }
    var text = hole.descriptionEvidence || {};
    if (text.dogleg && candidate.shape.indexOf("dogleg") >= 0) {
      var expectedShape = text.dogleg === "left" ? "dogleg-left" : "dogleg-right";
      shapeScore = candidate.shape === expectedShape ? 1 : 0;
      descriptionScore = shapeScore;
      score += candidate.shape === expectedShape ? 0.06 : -0.04;
      evidence.push("description-dogleg:" + text.dogleg);
      tieBreakersUsed.push("dogleg-direction");
      if (shapeScore) explanation.push("Dogleg direction matched the course description.");
    }
    if (text.water && (candidate.nearbyWater || candidate.crossingWater)) {
      hazardScore = 1;
      descriptionScore = Math.max(descriptionScore, 0.7);
      score += 0.04;
      evidence.push("description-water");
      tieBreakersUsed.push("hazard-context");
      explanation.push("Water or hazard context matched the scorecard/course description.");
    }
    return {
      score: clamp(score, 0, 1),
      evidence: evidence,
      assignmentEvidence: {
        rawDistanceDeltaM: rawDistanceDeltaM,
        scaledDistanceDeltaM: scaledDistanceDeltaM,
        normalizedDistanceDelta: normalizedDistanceDelta,
        distanceScore: distanceScore,
        rankScore: rankScore,
        multiSourceScore: multiSourceScore,
        multiSourceCount: multiSourceCount,
        parScore: parScore,
        shapeScore: shapeScore,
        hazardScore: hazardScore,
        descriptionScore: descriptionScore,
        routingScore: 0,
        totalScore: clamp(score, 0, 1),
        tieBreakersUsed: tieBreakersUsed,
        explanation: explanation
      }
    };
  }

  function routeContinuityScore(prevCandidate, candidate) {
    if (!prevCandidate || !candidate) return 0;
    var prevGreen = prevCandidate.path[prevCandidate.path.length - 1];
    var nextTee = candidate.path[0];
    var d = distanceM(prevGreen, nextTee);
    if (!Number.isFinite(d)) return 0;
    if (d <= 90) return 0.08;
    if (d <= 230) return 0.04;
    if (d >= 850) return -0.08;
    return 0;
  }

  function matchCandidatesToScorecard(candidates, scorecard, expectedHoleCount, normalizedScorecardSources) {
    var warnings = [];
    var holes = scorecard.slice().sort(function (a, b) { return a.holeNumber - b.holeNumber; });
    if (!holes.length) {
      warnings.push("No scorecard evidence available; resolver refused to number geometry.");
      return { assignments: [], unresolvedScorecardHoles: [], confidence: 0, warnings: warnings, alternatives: [] };
    }
    var usefulCandidates = candidates
      .filter(function (candidate) { return candidate.path && candidate.path.length >= 2 && candidate.confidence >= 0.38; })
      .slice(0, Math.max(expectedHoleCount || holes.length || 18, holes.length) + 8);
    if (!usefulCandidates.length) {
      warnings.push("No usable hole geometry candidates found inside the analysis boundary.");
      return { assignments: [], unresolvedScorecardHoles: holes, confidence: 0, warnings: warnings, alternatives: [] };
    }
    var context = {
      scale: distanceScale(usefulCandidates, holes),
      candidateRanks: rankMap(usefulCandidates, function (candidate) { return candidate.pathDistanceM; }, function (candidate) { return candidate.candidateId; }),
      scorecardRanks: rankMap(holes, function (hole) { return hole.distanceM; }, function (hole) { return hole.holeNumber; }),
      sourceRankMaps: (normalizedScorecardSources || []).filter(function (source) { return source.distanceCount >= 2; }).map(function (source) {
        return rankMap(source.holes, function (hole) { return hole.distanceM; }, function (hole) { return hole.holeNumber; });
      }),
      scorecardLengthOrder: scorecardLengthOrder(holes),
      candidateLengthOrder: candidateLengthOrder(usefulCandidates)
    };
    var pair = {};
    holes.forEach(function (hole) {
      usefulCandidates.forEach(function (candidate) {
        pair[hole.holeNumber + "::" + candidate.candidateId] = scorePair(candidate, hole, context);
      });
    });
    var states = [{ score: 0, assignments: [], used: {}, last: null }];
    holes.forEach(function (hole) {
      var nextStates = [];
      states.forEach(function (state) {
        usefulCandidates.forEach(function (candidate) {
          if (state.used[candidate.candidateId]) return;
          var scored = pair[hole.holeNumber + "::" + candidate.candidateId];
          if (!scored || scored.score < 0.18) return;
          var continuity = routeContinuityScore(state.last, candidate);
          var nextScore = state.score + scored.score + continuity;
          nextStates.push({
            score: nextScore,
            assignments: state.assignments.concat([{ hole: hole, candidate: candidate, pair: scored, continuity: continuity }]),
            used: Object.assign({}, state.used, (function () {
              var used = {};
              used[candidate.candidateId] = true;
              return used;
            })()),
            last: candidate
          });
        });
        nextStates.push({
          score: state.score - 0.18,
          assignments: state.assignments,
          used: state.used,
          last: state.last
        });
      });
      states = nextStates
        .sort(function (a, b) { return b.score - a.score; })
        .slice(0, MAX_BEAM_WIDTH);
    });
    var best = states[0] || { assignments: [], score: 0 };
    var assignments = best.assignments.map(function (assignment) {
      var baseConfidence = clamp(assignment.pair.score * 0.88 + assignment.candidate.confidence * 0.12 + Math.max(0, assignment.continuity), 0, 1);
      var structuredEvidence = Object.assign({}, assignment.pair.assignmentEvidence || {});
      structuredEvidence.routingScore = assignment.continuity || 0;
      structuredEvidence.totalScore = assignment.pair.score + (assignment.continuity || 0);
      structuredEvidence.tieBreakersUsed = (structuredEvidence.tieBreakersUsed || []).slice();
      structuredEvidence.explanation = (structuredEvidence.explanation || []).slice();
      if (assignment.continuity > 0) {
        structuredEvidence.tieBreakersUsed.push("previous-hole-routing");
        structuredEvidence.explanation.push("Previous green to next tee routing supported this ordering.");
      }
      return {
        holeNumber: assignment.hole.holeNumber,
        par: assignment.hole.par,
        officialDistanceM: assignment.hole.distanceM,
        candidate: assignment.candidate,
        matchScore: assignment.pair.score,
        confidence: baseConfidence,
        evidence: assignment.pair.evidence.concat(assignment.continuity ? ["routing-continuity:" + assignment.continuity.toFixed(2)] : []),
        assignmentEvidence: structuredEvidence
      };
    });
    var assignedHoleNumbers = {};
    assignments.forEach(function (assignment) { assignedHoleNumbers[assignment.holeNumber] = true; });
    var unresolvedScorecardHoles = holes.filter(function (hole) { return !assignedHoleNumbers[hole.holeNumber]; });
    var confidence = assignments.length
      ? assignments.reduce(function (sum, assignment) { return sum + assignment.confidence; }, 0) / assignments.length
      : 0;
    confidence *= clamp(assignments.length / Math.max(1, holes.length), 0, 1);
    if (context.scale && Math.abs(1 - context.scale) > 0.12) {
      warnings.push("Map geometry scale differs from scorecard by " + Math.round((1 - context.scale) * -100) + "%; relative distance matching was used.");
    }
    return {
      assignments: assignments,
      unresolvedScorecardHoles: unresolvedScorecardHoles,
      confidence: clamp(confidence, 0, 1),
      warnings: warnings,
      context: context,
      score: best.score || 0,
      alternatives: states.slice(0, 5).map(function (state) {
        return {
          score: state.score,
          holes: state.assignments.map(function (assignment) {
            return { holeNumber: assignment.hole.holeNumber, candidateId: assignment.candidate.candidateId };
          })
        };
      })
    };
  }

  function expectedHoleCount(input, scorecard) {
    var explicit = number(input.expectedHoleCount, NaN);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    if (scorecard && scorecard.length) return scorecard.length;
    return 18;
  }

  function hasNumberingIssue(input) {
    var payload = input.osmPayload || {};
    var elements = payload.elements || input.elements || [];
    var holeElements = elements.filter(function (element) { return golfTag(element) === "hole"; });
    var refs = holeElements.map(function (element) {
      return validHoleNumber(tagText(element, "ref") || tagText(element, "name"));
    }).filter(Boolean);
    var uniqueRefs = {};
    refs.forEach(function (ref) { uniqueRefs[ref] = true; });
    var bundleGuides = input.guideBundle && Array.isArray(input.guideBundle.guides) ? input.guideBundle.guides : [];
    var usefulGeometry = holeElements.length ||
      elements.some(function (element) { return golfTag(element) === "green" || golfTag(element) === "fairway"; });
    if (!usefulGeometry) return false;
    if (holeElements.length && refs.length < holeElements.length) return true;
    if (refs.length && Object.keys(uniqueRefs).length < refs.length) return true;
    var expected = number(input.expectedHoleCount, 18);
    return bundleGuides.length > 0 && bundleGuides.length < Math.min(expected, 18);
  }

  function supportedGolfGeometry(elements) {
    return (elements || []).filter(function (element) {
      var golf = golfTag(element);
      return golf === "hole" || golf === "green" || golf === "fairway" || golf === "tee";
    });
  }

  function normalizeSourceLoadError(raw, fallbackCode, fallbackReason) {
    raw = raw || {};
    return {
      code: String(raw.code || fallbackCode || "native-resolver-source-load-failed"),
      reason: String(raw.reason || fallbackReason || raw.message || "Native resolver source load failed"),
      message: String(raw.message || raw.reason || fallbackReason || "Native resolver source load failed"),
      name: String(raw.name || "")
    };
  }

  function sourceEvidenceError(input, elements, boundary) {
    if (input.sourceLoadError) return normalizeSourceLoadError(input.sourceLoadError, "osm-request-failed", "OSM request failed");
    if (!Array.isArray(elements)) return normalizeSourceLoadError(null, "osm-payload-invalid", "OSM payload was unavailable");
    if (!elements.length) return normalizeSourceLoadError(null, "no-supported-golf-geometry-returned", "No supported golf geometry returned");
    if (!supportedGolfGeometry(elements).length) return normalizeSourceLoadError(null, "no-supported-golf-geometry-returned", "No supported golf geometry returned");
    if (!Array.isArray(boundary) || boundary.length < 3) return normalizeSourceLoadError(null, "course-boundary-unavailable", "Course boundary unavailable");
    return null;
  }

  function failedSourceFeedback(error, elements, scorecard) {
    var supported = supportedGolfGeometry(elements);
    return {
      stage: "Source load failed",
      geometry: {
        osmFeatures: Array.isArray(elements) ? elements.length : 0,
        supportedGolfFeatures: supported.length,
        greenCandidates: 0,
        acceptedGreens: 0,
        rejectedGreens: 0,
        fairwayCorridors: 0,
        candidatePaths: 0,
        missingCandidates: 0,
        sourceLoadError: error
      },
      distance: {
        measuredRange: null,
        scorecardRange: distanceRange((scorecard || []).map(function (hole) { return hole.distanceM; })),
        globalScale: 1,
        averageNormalisedError: null,
        rankAgreement: "0 / 0",
        poorAgreementHoles: [],
        distanceUsed: "none",
        confidence: "None"
      },
      assignment: {
        scorecardHoles: Array.isArray(scorecard) ? scorecard.length : 0,
        geometryCandidates: 0,
        resolvedHoles: 0,
        unresolvedHoles: (scorecard || []).map(function (hole) { return hole.holeNumber; }),
        duplicateAssignmentsBlocked: true,
        unusedCandidates: 0,
        overallAssignmentScore: 0,
        overallConfidence: 0
      },
      tieBreakers: {},
      explanations: []
    };
  }

  function sourceLoadFailureResult(input, courseId, resolverRunId, mappingRunId, debugStartedAt, error, elements, boundary, scorecard) {
    var result = {
      courseId: courseId,
      resolverRunId: resolverRunId,
      status: "source-load-failed",
      sourceLoadError: error,
      holes: [],
      unresolvedCandidates: [],
      unresolvedScorecardHoles: scorecard || [],
      analysisBoundary: boundary || [],
      confidence: 0,
      overallConfidence: 0,
      warnings: [error.message],
      checkpoints: [],
      resolverVersion: RESOLVER_VERSION,
      resolvedAt: nowIso(),
      source: SOURCE,
      debugEvidence: {
        resolverRunId: resolverRunId,
        analysisBoundary: boundary || [],
        osmFeatureCount: Array.isArray(elements) ? elements.length : 0,
        fairwayCount: (elements || []).filter(function (element) { return golfTag(element) === "fairway"; }).length,
        osmFairwayCount: (elements || []).filter(function (element) { return golfTag(element) === "fairway"; }).length,
        expectedHoleCount: expectedHoleCount(input, scorecard || []),
        greenCandidates: [],
        rejectedGreenCandidates: [],
        holeCandidates: [],
        scorecardHoles: scorecard || [],
        assignmentContext: {},
        assignmentScore: 0,
        assignmentAlternatives: [],
        sourceLoadError: error
      }
    };
    result.feedback = failedSourceFeedback(error, elements, scorecard || []);
    if (!input.debugSuppressLifecycle) {
      recordMappingDebug(mappingRunId, {
        source: "native-resolver",
        phase: "failed",
        event: "native-resolver-source-load-failed",
        summary: "Native resolver source load failed",
        details: resolverDebugDetails(result),
        error: { message: error.message, name: error.name || "", code: error.code },
        durationMs: Date.now() - debugStartedAt,
        confidence: 0
      });
    }
    publishResult(result);
    return result;
  }

  function resolveStatus(assignments, confidence, expected, scorecardAvailable) {
    if (!scorecardAvailable) return "geometry-resolved-numbering-unavailable";
    var high = assignments.filter(function (hole) { return hole.confidence >= HIGH_CONFIDENCE; }).length;
    if (assignments.length >= expected && confidence >= HIGH_CONFIDENCE && high >= expected) return "resolved";
    if (high > 0 && confidence >= MEDIUM_CONFIDENCE) return "partially-resolved";
    if (assignments.length && confidence >= MEDIUM_CONFIDENCE) return "partially-resolved";
    return "insufficient-confidence";
  }

  function allCheckpointPoints(data) {
    var points = [];
    (data.boundary || []).forEach(function (point) { points.push(point); });
    (data.greens || []).concat(data.rejectedGreens || []).forEach(function (green) {
      points = points.concat(green.polygon || []);
      if (green.centre) points.push(green.centre);
    });
    (data.candidates || []).forEach(function (candidate) { points = points.concat(candidate.path || []); });
    (data.elements || []).forEach(function (element) { points = points.concat(elementPoints(element)); });
    return points;
  }

  function checkpointBounds(data) {
    return boundsForPoints(allCheckpointPoints(data)) || boundsForPoints(data.boundary || []);
  }

  function featureStyle(element) {
    var golf = golfTag(element);
    if (golf === "fairway") return { stroke: "#79d279", fill: "#79d279", opacity: 0.16 };
    if (golf === "tee") return { stroke: "#fff0a8", fill: "#fff0a8", opacity: 0.28 };
    if (golf === "bunker") return { stroke: "#f2c879", fill: "#f2c879", opacity: 0.34 };
    if (golf === "water_hazard" || golf === "lateral_water_hazard" || tagText(element, "natural") === "water") return { stroke: "#5fb7ff", fill: "#5fb7ff", opacity: 0.28 };
    if (golf === "course") return { stroke: "#ffffff", fill: "none", opacity: 0.18 };
    return { stroke: "#bfc8c1", fill: "none", opacity: 0.12 };
  }

  function checkpointSvg(stage, title, data) {
    var width = 760;
    var height = 520;
    var pad = 42;
    var innerW = width - pad * 2;
    var innerH = height - pad * 2;
    var bounds = checkpointBounds(data);
    var innerBounds = bounds;
    if (bounds) {
      var latPad = (bounds.maxLat - bounds.minLat) * 0.08 || 0.001;
      var lngPad = (bounds.maxLng - bounds.minLng) * 0.08 || 0.001;
      innerBounds = { minLat: bounds.minLat - latPad, maxLat: bounds.maxLat + latPad, minLng: bounds.minLng - lngPad, maxLng: bounds.maxLng + lngPad };
    }
    function path(points, close) { return svgPath(points, innerBounds, innerW, innerH, close); }
    function shiftPath(d) { return d ? d.replace(/([ML])([0-9.-]+) ([0-9.-]+)/g, function (_, cmd, x, y) { return cmd + (Number(x) + pad).toFixed(1) + " " + (Number(y) + pad).toFixed(1); }) : ""; }
    function label(point, text, fill) {
      var p = projectPoint(point, innerBounds, innerW, innerH);
      if (!p) return "";
      return '<text x="' + (p.x + pad + 5).toFixed(1) + '" y="' + (p.y + pad - 5).toFixed(1) + '" fill="' + fill + '" font-size="12" font-weight="800">' + escapeHtml(text) + '</text>';
    }
    var body = [];
    body.push('<rect width="100%" height="100%" rx="16" fill="#07110c"/>');
    body.push('<text x="22" y="25" fill="#ffffff" font-size="16" font-weight="900">' + escapeHtml(title) + '</text>');
    body.push('<text x="22" y="45" fill="#98a99f" font-size="11">' + escapeHtml(data.courseName || data.courseId || "Course") + " | " + escapeHtml(data.resolverRunId || "") + " | " + escapeHtml(data.createdAt || "") + '</text>');
    (data.elements || []).forEach(function (element) {
      var pts = elementPoints(element);
      if (pts.length < 2) return;
      var style = featureStyle(element);
      var d = shiftPath(path(pts, pts.length >= 3));
      if (!d) return;
      body.push('<path d="' + d + '" fill="' + (style.fill || "none") + '" fill-opacity="' + style.opacity + '" stroke="' + style.stroke + '" stroke-opacity="' + Math.max(style.opacity, 0.28) + '" stroke-width="1.2"/>');
    });
    if ((data.boundary || []).length >= 3) body.push('<path d="' + shiftPath(path(data.boundary, true)) + '" fill="none" stroke="#ffdc5b" stroke-width="3" stroke-dasharray="8 5"/>');
    (data.rejectedGreens || []).forEach(function (green) {
      body.push('<path d="' + shiftPath(path(green.polygon, true)) + '" fill="#ff5a6f" fill-opacity=".16" stroke="#ff5a6f" stroke-width="2" stroke-dasharray="4 4"/>');
    });
    (data.greens || []).forEach(function (green) {
      body.push('<path d="' + shiftPath(path(green.polygon, true)) + '" fill="#36d47d" fill-opacity=".28" stroke="#36d47d" stroke-width="2"/>');
    });
    (data.candidates || []).forEach(function (candidate, index) {
      var stroke = stage === "number-allocation" ? "#f8d24a" : "#74b9ff";
      body.push('<path d="' + shiftPath(path(candidate.path, false)) + '" fill="none" stroke="' + stroke + '" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>');
      var mid = candidate.path && candidate.path[Math.floor(candidate.path.length / 2)];
      var stableId = candidate.candidateId || candidate.displayId || ("candidate-" + (index + 1));
      var text = stage === "number-allocation" && candidate.holeNumber ? "H" + candidate.holeNumber + " " + stableId : stableId;
      body.push(label(mid, text, stage === "number-allocation" ? "#ffe680" : "#cce4ff"));
    });
    if (data.center) body.push(label(data.center, "Course center", "#ffffff"));
    body.push('<line x1="' + (width - 152) + '" y1="' + (height - 28) + '" x2="' + (width - 52) + '" y2="' + (height - 28) + '" stroke="#ffffff" stroke-width="3"/><text x="' + (width - 150) + '" y="' + (height - 34) + '" fill="#ffffff" font-size="10">approx scale</text>');
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + " " + height + '">' + body.join("") + '</svg>';
  }

  function svgDataUrl(svg) {
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  function candidateDisplayId(index) {
    var n = index;
    var label = "";
    do {
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return "Candidate " + label;
  }

  function roundCoord(value) {
    var n = number(value, NaN);
    return Number.isFinite(n) ? Number(n.toFixed(6)) : undefined;
  }

  function summarizeBounds(bounds) {
    if (!bounds) return null;
    return {
      south: roundCoord(bounds.minLat),
      west: roundCoord(bounds.minLng),
      north: roundCoord(bounds.maxLat),
      east: roundCoord(bounds.maxLng)
    };
  }

  function summarizeViewport(viewport) {
    if (!viewport) return null;
    var out = {};
    var center = toPoint(viewport.center);
    if (center) out.center = { lat: roundCoord(center.lat), lng: roundCoord(center.lng) };
    if (Number.isFinite(number(viewport.zoom, NaN))) out.zoom = number(viewport.zoom, NaN);
    var boundary = viewportBoundary(viewport);
    if (boundary) out.bounds = summarizeBounds(boundsForPoints(boundary));
    return Object.keys(out).length ? out : null;
  }

  function geometryIds(elements, golf) {
    return (elements || []).filter(function (element) { return golfTag(element) === golf; })
      .map(function (element, index) { return elementId(element, golf + "-" + index); })
      .slice(0, 40);
  }

  function checkpointMetadata(input, data, extra) {
    var candidates = data.candidates || [];
    var taggedFairways = geometryIds(data.elements || [], "fairway");
    var fairwayCorridors = fairwayCorridorCount(data.elements || [], candidates);
    return Object.assign({
      viewport: summarizeViewport(input.mapViewport),
      bounds: summarizeBounds(boundsForPoints(allCheckpointPoints(data)) || boundsForPoints(data.boundary || [])),
      overlayCounts: {
        sourceFeatures: (data.elements || []).length,
        acceptedGreens: (data.greens || []).length,
        rejectedGreens: (data.rejectedGreens || []).length,
        fairways: fairwayCorridors,
        osmFairways: taggedFairways.length,
        tees: geometryIds(data.elements || [], "tee").length,
        candidates: candidates.length
      },
      geometryIds: {
        acceptedGreens: (data.greens || []).map(function (green) { return green.id; }).filter(Boolean).slice(0, 40),
        rejectedGreens: (data.rejectedGreens || []).map(function (green) { return green.id; }).filter(Boolean).slice(0, 40),
        fairways: taggedFairways,
        tees: geometryIds(data.elements || [], "tee"),
        candidates: candidates.map(function (candidate) { return candidate.candidateId; }).filter(Boolean).slice(0, 40)
      }
    }, extra || {});
  }

  function buildCheckpoints(input, runId, courseId, boundary, greenResult, candidates, match) {
    var course = input.course || {};
    var createdAt = nowIso();
    var elements = (input.osmPayload && input.osmPayload.elements) || input.elements || [];
    var center = inputCenter(input);
    var scorecardEvidence = match.scorecardEvidence || {};
    var assignmentsByCandidate = {};
    (match.assignments || []).forEach(function (assignment) { assignmentsByCandidate[assignment.candidate.candidateId] = assignment; });
    var base = {
      createdAt: createdAt,
      courseId: courseId,
      courseName: course.courseName || course.name || courseId,
      resolverRunId: runId,
      boundary: boundary,
      center: center,
      elements: elements
    };
    var lineCandidates = candidates.map(function (candidate, index) {
      return Object.assign({}, candidate, { displayId: candidateDisplayId(index) });
    });
    var numberCandidates = candidates.map(function (candidate, index) {
      var assignment = assignmentsByCandidate[candidate.candidateId];
      return Object.assign({}, candidate, {
        displayId: candidateDisplayId(index),
        holeNumber: assignment && assignment.holeNumber,
        confidence: assignment && assignment.confidence || candidate.confidence
      });
    });
    var stages = [
      {
        stage: "initial-snapshot",
        title: "Initial Snapshot",
        data: Object.assign({}, base, {
          greens: greenResult.accepted,
          rejectedGreens: greenResult.rejected,
          candidates: [],
          metadata: checkpointMetadata(input, Object.assign({}, base, {
            greens: greenResult.accepted,
            rejectedGreens: greenResult.rejected,
            candidates: []
          }), {
            osmFeatures: elements.length,
            acceptedGreens: greenResult.accepted.length,
            rejectedGreens: greenResult.rejected.length,
            fairways: fairwayCorridorCount(elements, []),
            osmFairways: elements.filter(function (element) { return golfTag(element) === "fairway"; }).length,
            tees: elements.filter(function (element) { return golfTag(element) === "tee"; }).length
          })
        })
      },
      {
        stage: "fairway-lines",
        title: "Fairway Lines",
        data: Object.assign({}, base, {
          greens: greenResult.accepted,
          rejectedGreens: greenResult.rejected,
          candidates: lineCandidates,
          metadata: checkpointMetadata(input, Object.assign({}, base, {
            greens: greenResult.accepted,
            rejectedGreens: greenResult.rejected,
            candidates: lineCandidates
          }), {
            acceptedGreens: greenResult.accepted.length,
            candidatePaths: candidates.length,
            rejectedCandidates: 0,
            pathDistanceRangeM: distanceRange(candidates.map(function (candidate) { return candidate.pathDistanceM; }))
          })
        })
      },
      {
        stage: "number-allocation",
        title: "Number Allocation",
        data: Object.assign({}, base, {
          greens: greenResult.accepted,
          rejectedGreens: greenResult.rejected,
          candidates: numberCandidates,
          metadata: checkpointMetadata(input, Object.assign({}, base, {
            greens: greenResult.accepted,
            rejectedGreens: greenResult.rejected,
            candidates: numberCandidates
          }), {
            status: (match.numberingUnavailableReason ? "unavailable" : "produced"),
            unavailableReason: match.numberingUnavailableReason || "",
            warning: match.numberingUnavailableReason || "",
            scorecardEvidenceSource: scorecardEvidence.source || "",
            scorecardEvidenceSourceCount: scorecardEvidence.sourceCount || 0,
            scorecardDistanceCount: scorecardEvidence.distanceCount || 0,
            requiredScorecardDistanceCount: scorecardEvidence.requiredDistanceCount || 0,
            scorecardLengthOrder: scorecardEvidence.lengthOrder || [],
            scorecardSources: scorecardEvidence.sources || [],
            candidateLengthOrder: match.context && match.context.candidateLengthOrder || candidateLengthOrder(candidates),
            resolvedHoles: (match.assignments || []).length,
            unresolvedScorecardHoles: (match.unresolvedScorecardHoles || []).map(function (hole) { return hole.holeNumber; }),
            confidence: match.confidence,
            alternatives: match.alternatives || []
          })
        })
      }
    ];
    return stages.map(function (entry) {
      var svg = checkpointSvg(entry.stage, entry.title, entry.data);
      return {
        stage: entry.stage,
        title: entry.title,
        createdAt: createdAt,
        courseId: courseId,
        resolverRunId: runId,
        imageDataUrl: svgDataUrl(svg),
        metadata: entry.data.metadata || {}
      };
    });
  }

  function distanceRange(values) {
    var nums = (values || []).filter(Number.isFinite);
    if (!nums.length) return null;
    return { min: Math.round(Math.min.apply(null, nums)), max: Math.round(Math.max.apply(null, nums)) };
  }

  function buildFeedback(result) {
    var debug = result.debugEvidence || {};
    var candidates = debug.holeCandidates || [];
    var scorecard = debug.scorecardHoles || [];
    var scorecardEvidence = debug.scorecardEvidence || {};
    var assigned = result.holes || [];
    var measuredRange = distanceRange(candidates.map(function (candidate) { return candidate.pathDistanceM; }));
    var scorecardRange = distanceRange(scorecard.map(function (hole) { return hole.distanceM; }));
    var poor = assigned.filter(function (hole) { return hole.assignmentEvidence && hole.assignmentEvidence.normalizedDistanceDelta > 0.22; }).map(function (hole) { return hole.holeNumber; });
    var tieBreakers = {};
    assigned.forEach(function (hole) {
      (hole.assignmentEvidence && hole.assignmentEvidence.tieBreakersUsed || []).forEach(function (key) { tieBreakers[key] = (tieBreakers[key] || 0) + 1; });
    });
    return {
      stage: result.status === "resolved" ? "Completed" : result.status === "partially-resolved" ? "Partially resolved" : result.status === "geometry-resolved-numbering-unavailable" ? "Numbering unavailable" : "Fallback required",
      geometry: {
        osmFeatures: debug.osmFeatureCount || 0,
        greenCandidates: (debug.greenCandidates || []).length + (debug.rejectedGreenCandidates || []).length,
        acceptedGreens: (debug.greenCandidates || []).length,
        rejectedGreens: (debug.rejectedGreenCandidates || []).length,
        fairwayCorridors: debug.fairwayCount || 0,
        osmFairways: debug.osmFairwayCount || 0,
        candidatePaths: candidates.length,
        missingCandidates: Math.max(0, (debug.expectedHoleCount || 18) - candidates.length)
      },
      distance: {
        measuredRange: measuredRange,
        scorecardRange: scorecardRange,
        globalScale: debug.assignmentContext && debug.assignmentContext.scale || 1,
        averageNormalisedError: assigned.length ? assigned.reduce(function (sum, hole) { return sum + number(hole.assignmentEvidence && hole.assignmentEvidence.normalizedDistanceDelta, 0); }, 0) / assigned.length : null,
        rankAgreement: assigned.filter(function (hole) { return hole.assignmentEvidence && hole.assignmentEvidence.rankScore >= 0.75; }).length + " / " + assigned.length,
        multiSourceAgreement: assigned.filter(function (hole) { return hole.assignmentEvidence && hole.assignmentEvidence.multiSourceScore >= 0.78; }).length + " / " + assigned.length,
        poorAgreementHoles: poor,
        distanceUsed: scorecardEvidence.distanceCount >= (scorecardEvidence.requiredDistanceCount || 1) ? "relative-rank" : "not-used",
        scorecardEvidence: scorecardEvidence,
        confidence: result.confidence >= HIGH_CONFIDENCE ? "High" : result.confidence >= MEDIUM_CONFIDENCE ? "Medium" : "Low"
      },
      assignment: {
        scorecardHoles: scorecard.length,
        geometryCandidates: candidates.length,
        resolvedHoles: assigned.length,
        unresolvedHoles: (result.unresolvedScorecardHoles || []).map(function (hole) { return hole.holeNumber; }),
        duplicateAssignmentsBlocked: true,
        unusedCandidates: (result.unresolvedCandidates || []).length,
        overallAssignmentScore: number(debug.assignmentScore, 0),
        overallConfidence: result.confidence
      },
      tieBreakers: tieBreakers,
      explanations: assigned.map(function (hole) {
        return { holeNumber: hole.holeNumber, explanation: hole.assignmentEvidence && hole.assignmentEvidence.explanation || [] };
      }).filter(function (row) { return row.explanation.length; })
    };
  }

  function resolverDebugDetails(result) {
    var feedback = result.feedback || {};
    var geometry = feedback.geometry || {};
    var distance = feedback.distance || {};
    var assignment = feedback.assignment || {};
    var debug = result.debugEvidence || {};
    var checkpoints = result.checkpoints || [];
    return {
      resolverRunId: result.resolverRunId,
      status: result.status,
      analysisBoundaryPoints: Array.isArray(result.analysisBoundary) ? result.analysisBoundary.length : 0,
      osmFeaturesReceived: geometry.osmFeatures || debug.osmFeatureCount || 0,
      greenCandidates: geometry.greenCandidates || 0,
      acceptedGreens: geometry.acceptedGreens || 0,
      rejectedGreens: geometry.rejectedGreens || 0,
      fairwayGroups: geometry.fairwayCorridors || 0,
      pathCandidates: geometry.candidatePaths || 0,
      scorecardHoleCount: assignment.scorecardHoles || 0,
      scorecardEvidence: distance.scorecardEvidence || debug.scorecardEvidence || {},
      measuredDistanceRange: distance.measuredRange || null,
      scorecardDistanceRange: distance.scorecardRange || null,
      globalDistanceScale: distance.globalScale || 1,
      rankAgreement: distance.rankAgreement || "",
      resolvedHoles: assignment.resolvedHoles || 0,
      unresolvedHoles: assignment.unresolvedHoles || [],
      tieBreakersUsed: feedback.tieBreakers || {},
      confidence: result.confidence || 0,
      finalOutcome: result.status,
      sourceLoadError: result.sourceLoadError || null,
      fallbackReason: result.status === "resolved" ? "" : result.sourceLoadError ? result.sourceLoadError.message : result.status === "geometry-resolved-numbering-unavailable" ? ((debug.scorecardEvidence && debug.scorecardEvidence.distanceCount) ? "Scorecard distances unavailable" : "Scorecard unavailable") : "Resolver did not reach trusted assignment confidence.",
      checkpointAvailability: checkpoints.map(function (checkpoint) {
        return {
          stage: checkpoint.stage,
          createdAt: checkpoint.createdAt,
          metadata: checkpoint.metadata || {}
        };
      }),
      warnings: result.warnings || []
    };
  }

  async function resolveCourseGeometryForAutoMapper(input) {
    input = input || {};
    var payload = input.osmPayload || {};
    var elements = payload.elements || input.elements || [];
    var course = input.course || {};
    var courseId = String(course.courseId || course.id || input.courseId || course.name || course.courseName || "course");
    var resolverRunId = makeRunId(courseId);
    var mappingRunId = String(input.debugRunId || input.mappingRunId || "");
    var debugStartedAt = Date.now();
    if (!mappingRunId && mappingDebug() && typeof mappingDebug().getOrStartRun === "function") {
      mappingRunId = mappingDebug().getOrStartRun({ course: course, courseId: courseId, courseName: course.courseName || course.name || courseId });
    }
    if (!input.debugSuppressLifecycle) {
      recordMappingDebug(mappingRunId, {
        source: "native-resolver",
        phase: "started",
        event: "native-resolver-started",
        summary: "Native resolver started",
        details: {
          invokedBy: input.debugInvokedBy || "direct",
          osmFeatureCount: elements.length,
          expectedHoleCount: input.expectedHoleCount || "",
          eligibilityReason: input.debugEligibilityReason || "direct resolver call"
        }
      });
    }
    activeRunId = resolverRunId;
    var warnings = [];
    var analysisBoundary = deriveAnalysisBoundary(input, elements);
    var scorecardSources = normalizeScorecardSources(input);
    var scorecard = normalizeScorecard(input, scorecardSources);
    var acquisitionError = sourceEvidenceError(input, elements, analysisBoundary);
    if (acquisitionError) {
      return sourceLoadFailureResult(input, courseId, resolverRunId, mappingRunId, debugStartedAt, acquisitionError, elements, analysisBoundary, scorecard);
    }
    var greenResult = detectGreenCandidates(elements, analysisBoundary);
    var candidates = detectHoleGeometryCandidates(elements, greenResult.accepted, analysisBoundary);
    var expected = expectedHoleCount(input, scorecard);
    var requiredDistanceCount = scorecard.length ? Math.max(1, Math.min(expected || scorecard.length || 18, scorecard.length, 18)) : Math.max(1, Math.min(expected || 18, 18));
    var distanceEvidenceCount = scorecardDistanceCount(scorecard);
    var scorecardUsableForNumbering = !!scorecard.length && distanceEvidenceCount >= requiredDistanceCount;
    var match = null;
    if (scorecardUsableForNumbering) {
      match = matchCandidatesToScorecard(candidates, scorecard, expected, scorecardSources);
    } else {
      var unavailableReason = scorecard.length ? "Scorecard distances unavailable" : "Scorecard unavailable";
      match = {
        assignments: [],
        unresolvedScorecardHoles: scorecard,
        confidence: 0,
        warnings: [unavailableReason],
        alternatives: [],
        context: {
          scale: 1,
          candidateRanks: rankMap(candidates, function (candidate) { return candidate.pathDistanceM; }, function (candidate) { return candidate.candidateId; }),
          scorecardRanks: rankMap(scorecard, function (hole) { return hole.distanceM; }, function (hole) { return hole.holeNumber; }),
          sourceRankMaps: [],
          scorecardLengthOrder: scorecardLengthOrder(scorecard),
          candidateLengthOrder: candidateLengthOrder(candidates)
        },
        score: 0,
        numberingUnavailableReason: unavailableReason
      };
    }
    match.scorecardEvidence = scorecardEvidenceSummary(input, scorecardSources, scorecard, expected);
    match.scorecardEvidence.requiredDistanceCount = requiredDistanceCount;
    warnings = warnings.concat(match.warnings || []);
    if (match.numberingUnavailableReason && warnings.indexOf(match.numberingUnavailableReason) < 0) warnings.push(match.numberingUnavailableReason);
    if (greenResult.accepted.length < Math.min(6, expected)) warnings.push("Few reliable green polygons were found inside the course boundary.");
    if (!candidates.length) warnings.push("No candidate centre-lines could be constructed.");
    var status = resolveStatus(match.assignments, match.confidence, expected, scorecardUsableForNumbering);
    var assignedIds = {};
    match.assignments.forEach(function (assignment) { assignedIds[assignment.candidate.candidateId] = true; });
    var checkpoints = buildCheckpoints(input, resolverRunId, courseId, analysisBoundary, greenResult, candidates, match);
    checkpoints.forEach(function (checkpoint) {
      attachMappingCheckpoint(mappingRunId, checkpoint);
    });
    var result = {
      courseId: courseId,
      resolverRunId: resolverRunId,
      status: status,
      holes: match.assignments,
      unresolvedCandidates: candidates.filter(function (candidate) { return !assignedIds[candidate.candidateId]; }),
      unresolvedScorecardHoles: match.unresolvedScorecardHoles,
      analysisBoundary: analysisBoundary,
      confidence: match.confidence,
      overallConfidence: match.confidence,
      warnings: warnings,
      checkpoints: checkpoints,
      resolverVersion: RESOLVER_VERSION,
      resolvedAt: nowIso(),
      source: SOURCE,
      debugEvidence: {
        resolverRunId: resolverRunId,
        analysisBoundary: analysisBoundary,
        osmFeatureCount: elements.length,
        fairwayCount: fairwayCorridorCount(elements, candidates),
        osmFairwayCount: elements.filter(function (element) { return golfTag(element) === "fairway"; }).length,
        expectedHoleCount: expected,
        greenCandidates: greenResult.accepted,
        rejectedGreenCandidates: greenResult.rejected,
        holeCandidates: candidates,
        scorecardHoles: scorecard,
        scorecardEvidence: match.scorecardEvidence,
        scorecardSources: scorecardSources,
        scorecardDistanceCount: distanceEvidenceCount,
        assignmentContext: match.context || {},
        assignmentScore: match.score || 0,
        assignmentAlternatives: match.alternatives || []
      }
    };
    result.feedback = buildFeedback(result);
    if (activeRunId !== resolverRunId) {
      result.status = "failed";
      result.cancelled = true;
      result.warnings = result.warnings.concat("Resolver run was superseded before completion.");
      recordMappingDebug(mappingRunId, {
        source: "native-resolver",
        phase: "superseded",
        event: "native-resolver-superseded",
        summary: "Native resolver run was superseded",
        details: resolverDebugDetails(result),
        durationMs: Date.now() - debugStartedAt,
        confidence: result.confidence || 0
      });
    } else if (!input.debugSuppressLifecycle) {
      recordMappingDebug(mappingRunId, {
        source: "native-resolver",
        phase: result.status === "resolved" ? "completed" : "fallback",
        event: "native-resolver-" + result.status,
        summary: result.status === "resolved" ? "Native resolver completed" : "Native resolver requested manual fallback",
        details: resolverDebugDetails(result),
        durationMs: Date.now() - debugStartedAt,
        confidence: result.confidence || 0
      });
    }
    publishResult(result);
    return result;
  }

  function debugEnabled() {
    try {
      if (!adminOrDeveloperAllowed()) return false;
      return !!window.gdCourseGeometryResolverDebug ||
        localStorage.getItem("gd_course_geometry_resolver_debug") === "1" ||
        localStorage.getItem("gd_course_play_debug_enabled") === "1" ||
        /[?&](gd_course_play_debug|gd_course_geometry_debug|debug-course-play)(=1|=true|=[^&]+|&|$)/i.test(location.search);
    } catch (e) {
      return !!window.gdCourseGeometryResolverDebug && adminOrDeveloperAllowed();
    }
  }

  function adminOrDeveloperAllowed() {
    try {
      var permission = String(document.body && document.body.dataset && document.body.dataset.gdPermission || "").toLowerCase();
      if (permission === "admin" || permission === "developer") return true;
      var account = window.GolfDaddyAccounts && typeof window.GolfDaddyAccounts.current === "function" ? window.GolfDaddyAccounts.current() : null;
      var role = String(account && account.role || "").toLowerCase();
      return role === "admin" || role === "developer";
    } catch (e) {
      return false;
    }
  }

  function publishResult(result) {
    try {
      window.__gdCourseGeometryResolverLastResult = result;
      window.dispatchEvent(new CustomEvent("gd:native-course-resolver-updated", { detail: result }));
    } catch (e) { /* no-op */ }
    try {
      if (debugEnabled() && window.GDCourseMappingDebug && typeof window.GDCourseMappingDebug.renderAdminPanel === "function") {
        window.GDCourseMappingDebug.renderAdminPanel();
      }
    } catch (e) { /* no-op */ }
  }

  function fmtPercent(value) {
    var n = number(value, NaN);
    return Number.isFinite(n) ? Math.round(n * 100) + "%" : "";
  }

  function fmtRange(range) {
    return range ? Math.round(range.min) + "-" + Math.round(range.max) + " m" : "n/a";
  }

  function checkpointFor(result, stage) {
    return (result.checkpoints || []).filter(function (checkpoint) { return checkpoint.stage === stage; })[0] || null;
  }

  function feedbackMetric(label, value) {
    return '<div class="gdNcrMetric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value == null || value === "" ? "n/a" : value) + '</strong></div>';
  }

  function feedbackEvidenceHtml(result) {
    var feedback = result.feedback || {};
    var geometry = feedback.geometry || {};
    var distance = feedback.distance || {};
    var assignment = feedback.assignment || {};
    var tieBreakers = feedback.tieBreakers || {};
    var explanations = feedback.explanations || [];
    var scorecardEvidence = distance.scorecardEvidence || {};
    var lengthOrder = scorecardEvidence.lengthOrder || [];
    return [
      '<div class="gdNcrGrid">',
      feedbackMetric("OSM features", geometry.osmFeatures),
      feedbackMetric("Greens accepted", geometry.acceptedGreens + " / " + geometry.greenCandidates),
      feedbackMetric("Fairway corridors", geometry.fairwayCorridors),
      feedbackMetric("Candidate paths", geometry.candidatePaths),
      feedbackMetric("Measured range", fmtRange(distance.measuredRange)),
      feedbackMetric("Scorecard range", fmtRange(distance.scorecardRange)),
      feedbackMetric("Global scale", number(distance.globalScale, 1).toFixed(2)),
      feedbackMetric("Rank agreement", distance.rankAgreement),
      feedbackMetric("Multi-source", scorecardEvidence.sourceCount ? scorecardEvidence.sourceCount + " sources" : "n/a"),
      feedbackMetric("Scorecard lengths", (scorecardEvidence.distanceCount || 0) + " / " + (scorecardEvidence.requiredDistanceCount || 18)),
      feedbackMetric("Resolved", assignment.resolvedHoles + " / " + assignment.scorecardHoles),
      feedbackMetric("Unused candidates", assignment.unusedCandidates),
      feedbackMetric("Confidence", fmtPercent(assignment.overallConfidence)),
      feedbackMetric("Fallback", assignment.unresolvedHoles && assignment.unresolvedHoles.length ? "H" + assignment.unresolvedHoles.join(", H") : "No"),
      '</div>',
      '<div class="gdNcrSubhead">Tie-breakers used</div>',
      '<div class="gdNcrChips">' + (Object.keys(tieBreakers).length ? Object.keys(tieBreakers).map(function (key) {
        return '<span>' + escapeHtml(key) + ': ' + escapeHtml(tieBreakers[key]) + '</span>';
      }).join("") : '<span>None</span>') + '</div>',
      '<div class="gdNcrSubhead">Scorecard length order</div>',
      '<div class="gdNcrChips">' + (lengthOrder.length ? lengthOrder.slice(0, 18).map(function (row, index) {
        return '<span>' + escapeHtml(index + 1) + '. H' + escapeHtml(row.hole) + ' ' + escapeHtml(row.distanceM) + 'm</span>';
      }).join("") : '<span>Unavailable</span>') + '</div>',
      '<div class="gdNcrSubhead">Resolved ties</div>',
      '<div class="gdNcrExplain">' + (explanations.length ? explanations.slice(0, 8).map(function (row) {
        return '<p><strong>Hole ' + escapeHtml(row.holeNumber) + ':</strong> ' + escapeHtml(row.explanation.join(" ")) + '</p>';
      }).join("") : '<p>No tie-breaker changed the winning assignment.</p>') + '</div>'
    ].join("");
  }

  function renderFeedbackWindow(result) {
    try {
      if (!document || !document.body || !adminOrDeveloperAllowed()) return;
      var el = document.getElementById("gdNativeCourseResolverWindow");
      if (!el) {
        el = document.createElement("div");
        el.id = "gdNativeCourseResolverWindow";
        document.body.appendChild(el);
        var style = document.createElement("style");
        style.id = "gdNativeCourseResolverStyle";
        style.textContent = [
          "#gdNativeCourseResolverWindow{position:fixed;right:max(10px,env(safe-area-inset-right));bottom:calc(max(10px,env(safe-area-inset-bottom)) + 10px);z-index:2602;width:min(390px,calc(100vw - 20px));max-height:min(72vh,620px);overflow:hidden;border-radius:12px;background:rgba(6,12,10,.94);border:1px solid rgba(92,214,137,.28);box-shadow:0 18px 44px rgba(0,0,0,.42);color:#fff;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif}",
          "#gdNativeCourseResolverWindow .gdNcrHead{display:flex;justify-content:space-between;gap:10px;padding:10px 11px 8px;border-bottom:1px solid rgba(255,255,255,.08)}",
          "#gdNativeCourseResolverWindow .gdNcrHead strong{display:block;font-size:13px;font-weight:950}#gdNativeCourseResolverWindow .gdNcrHead span{display:block;margin-top:2px;color:rgba(255,255,255,.58);font-size:10px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:250px}",
          "#gdNativeCourseResolverWindow .gdNcrBadge{align-self:flex-start;border-radius:999px;padding:4px 7px;background:rgba(92,214,137,.14);border:1px solid rgba(92,214,137,.25);font-size:9px;font-weight:950;text-transform:uppercase;color:#8dffbc}",
          "#gdNativeCourseResolverWindow .gdNcrTabs{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:8px 9px}#gdNativeCourseResolverWindow .gdNcrTabs button{height:28px;border:0;border-radius:8px;background:rgba(255,255,255,.08);color:rgba(255,255,255,.72);font-size:10px;font-weight:900}#gdNativeCourseResolverWindow .gdNcrTabs button.active{background:rgba(92,214,137,.22);color:#fff}",
          "#gdNativeCourseResolverWindow .gdNcrBody{padding:0 9px 10px;overflow:auto;max-height:calc(min(72vh,620px) - 88px)}#gdNativeCourseResolverWindow img{display:block;width:100%;height:auto;border-radius:8px;border:1px solid rgba(255,255,255,.08);background:#07110c}",
          "#gdNativeCourseResolverWindow .gdNcrGrid{display:grid;grid-template-columns:1fr 1fr;gap:6px}#gdNativeCourseResolverWindow .gdNcrMetric{min-width:0;padding:7px;border-radius:8px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.06)}#gdNativeCourseResolverWindow .gdNcrMetric span{display:block;color:rgba(255,255,255,.5);font-size:8px;font-weight:950;text-transform:uppercase;letter-spacing:.04em}#gdNativeCourseResolverWindow .gdNcrMetric strong{display:block;margin-top:2px;font-size:12px;font-weight:950;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
          "#gdNativeCourseResolverWindow .gdNcrSubhead{margin:10px 0 5px;color:rgba(255,255,255,.68);font-size:10px;font-weight:950;text-transform:uppercase;letter-spacing:.05em}#gdNativeCourseResolverWindow .gdNcrChips{display:flex;gap:5px;flex-wrap:wrap}#gdNativeCourseResolverWindow .gdNcrChips span{border-radius:999px;padding:4px 7px;background:rgba(255,255,255,.08);font-size:10px;font-weight:850}#gdNativeCourseResolverWindow .gdNcrExplain p{margin:0 0 6px;color:rgba(255,255,255,.76);font-size:11px;line-height:1.35}",
          "@media(max-width:520px){#gdNativeCourseResolverWindow{right:8px;left:8px;width:auto;bottom:8px}}"
        ].join("");
        document.head.appendChild(style);
      }
      var activeTab = el.getAttribute("data-tab") || "evidence";
      var tabs = [
        ["initial", "Initial", checkpointFor(result, "initial-snapshot")],
        ["lines", "Lines", checkpointFor(result, "fairway-lines")],
        ["numbers", "Numbers", checkpointFor(result, "number-allocation")],
        ["evidence", "Evidence", null]
      ];
      var body = activeTab === "evidence"
        ? feedbackEvidenceHtml(result)
        : (tabs.filter(function (tab) { return tab[0] === activeTab; })[0] || tabs[0])[2];
      var bodyHtml = typeof body === "string" ? body : body && body.imageDataUrl ? '<img alt="' + escapeHtml(activeTab) + ' resolver checkpoint" src="' + body.imageDataUrl + '">' : '<div class="gdNcrExplain"><p>No checkpoint available.</p></div>';
      el.innerHTML = [
        '<div class="gdNcrHead"><div><strong>Native Course Resolver</strong><span>' + escapeHtml(result.courseId) + " | " + escapeHtml(result.resolverRunId) + '</span></div><div class="gdNcrBadge">' + escapeHtml(result.feedback && result.feedback.stage || result.status) + '</div></div>',
        '<div class="gdNcrTabs">' + tabs.map(function (tab) {
          return '<button type="button" data-tab="' + tab[0] + '" class="' + (activeTab === tab[0] ? "active" : "") + '">' + escapeHtml(tab[1]) + '</button>';
        }).join("") + '</div>',
        '<div class="gdNcrBody">' + bodyHtml + '</div>'
      ].join("");
      Array.prototype.forEach.call(el.querySelectorAll("button[data-tab]"), function (button) {
        button.onclick = function () {
          el.setAttribute("data-tab", button.getAttribute("data-tab") || "evidence");
          renderFeedbackWindow(result);
        };
      });
    } catch (e) { /* no-op */ }
  }

  function drawDebug(result, leafletMap) {
    try {
      var map = leafletMap || window.map;
      var L = window.L;
      if (!map || !L || !result) return false;
      clearDebug();
      var group = L.layerGroup().addTo(map);
      window.__gdCourseGeometryResolverDebugLayer = group;
      if (Array.isArray(result.analysisBoundary) && result.analysisBoundary.length >= 3) {
        L.polygon(result.analysisBoundary, { color: "#f8d24a", weight: 2, fillOpacity: 0.04, interactive: false }).addTo(group);
      }
      var debug = result.debugEvidence || {};
      (debug.greenCandidates || []).forEach(function (green) {
        if (green.polygon) L.polygon(green.polygon, { color: "#35d07f", weight: 2, fillOpacity: 0.18, interactive: false }).addTo(group);
      });
      (debug.rejectedGreenCandidates || []).forEach(function (green) {
        if (green.polygon) L.polygon(green.polygon, { color: "#f66", weight: 1, dashArray: "4 4", fillOpacity: 0.08, interactive: false }).addTo(group);
      });
      (debug.holeCandidates || []).forEach(function (candidate) {
        L.polyline(candidate.path, { color: "#72b7ff", weight: 3, opacity: 0.72, interactive: false }).addTo(group);
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearDebug() {
    try {
      if (window.__gdCourseGeometryResolverDebugLayer) {
        window.__gdCourseGeometryResolverDebugLayer.remove();
        window.__gdCourseGeometryResolverDebugLayer = null;
      }
    } catch (e) { /* no-op */ }
  }

  window.GDCourseGeometryResolver = {
    source: SOURCE,
    resolverVersion: RESOLVER_VERSION,
    highConfidence: HIGH_CONFIDENCE,
    mediumConfidence: MEDIUM_CONFIDENCE,
    shouldRunForAutoMapper: hasNumberingIssue,
    resolveCourseGeometryForAutoMapper: resolveCourseGeometryForAutoMapper,
    debugEnabled: debugEnabled,
    drawDebug: drawDebug,
    clearDebug: clearDebug,
    _test: {
      distanceM: distanceM,
      normalizeScorecard: normalizeScorecard,
      normalizeScorecardSources: normalizeScorecardSources,
      detectGreenCandidates: detectGreenCandidates,
      detectHoleGeometryCandidates: detectHoleGeometryCandidates,
      matchCandidatesToScorecard: matchCandidatesToScorecard
    }
  };
})();
