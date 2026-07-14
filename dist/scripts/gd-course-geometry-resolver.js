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

  function number(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
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
    var center = toPoint(input.center) ||
      toPoint({ lat: course.courseLat || course.lat || course.latitude, lng: course.courseLng || course.lng || course.longitude });
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

  function farthestPair(points) {
    var pts = (points || []).map(toPoint).filter(Boolean);
    var best = null;
    for (var i = 0; i < pts.length; i += 1) {
      for (var j = i + 1; j < pts.length; j += 1) {
        var d = distanceM(pts[i], pts[j]);
        if (!best || d > best.distance) best = { a: pts[i], b: pts[j], distance: d };
      }
    }
    return best;
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

  function buildCandidate(id, rawPath, greens, elements, source, extraEvidence) {
    var oriented = orientPathToGreen(rawPath, greens);
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
    var confidence = source === "osm-hole-line" ? 0.72 : 0.48;
    if (green && oriented.greenDistanceM <= 95) confidence += 0.12;
    if (pathDistance >= 70 && pathDistance <= 620) confidence += 0.08;
    if (straightLine > 0 && pathDistance / straightLine < 1.55) confidence += 0.04;
    if (source === "fairway-axis") confidence -= 0.08;
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

  function detectHoleGeometryCandidates(elements, greens, boundary) {
    var candidates = [];
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
          candidates.push(candidate);
        }
      }
    });
    if (candidates.length >= 9) return dedupeCandidates(candidates);
    (elements || []).forEach(function (element, index) {
      if (golfTag(element) !== "fairway") return;
      var polygon = cleanPolygon(elementPoints(element));
      if (!polygon) return;
      var pair = farthestPair(polygon);
      if (!pair || pair.distance < 80) return;
      var candidate = buildCandidate(
        elementId(element, "fairway-" + index),
        [pair.a, centroid(polygon), pair.b].filter(Boolean),
        greens,
        elements,
        "fairway-axis",
        ["fairway-span:" + Math.round(pair.distance) + "m"]
      );
      if (candidate) candidates.push(candidate);
    });
    return dedupeCandidates(candidates);
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

  function scorecardSources(input) {
    var sources = [];
    if (Array.isArray(input.scorecardHoles)) sources.push(input.scorecardHoles);
    if (input.scorecard) sources.push(input.scorecard);
    try {
      if (window.scorecard) sources.push(window.scorecard);
      if (window.gdScorecard) sources.push(window.gdScorecard);
      if (window.currentScorecard) sources.push(window.currentScorecard);
    } catch (e) { /* no-op */ }
    return sources;
  }

  function normalizeScorecard(input) {
    var best = [];
    scorecardSources(input || {}).forEach(function (source) {
      var holes = [];
      if (Array.isArray(source)) holes = source;
      else if (Array.isArray(source && source.holes)) holes = source.holes;
      else if (Array.isArray(source && source.scorecard && source.scorecard.holes)) holes = source.scorecard.holes;
      if (!holes.length) return;
      var normalized = holes.map(function (hole, index) {
        return normalizeScorecardHole(hole, index + 1);
      }).filter(Boolean);
      var completeDistances = normalized.filter(function (hole) { return Number.isFinite(hole.distanceM); }).length;
      var bestDistances = best.filter(function (hole) { return Number.isFinite(hole.distanceM); }).length;
      if (normalized.length > best.length || completeDistances > bestDistances) best = normalized;
    });
    return best.sort(function (a, b) { return a.holeNumber - b.holeNumber; });
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
    if (Number.isFinite(candidate.existingHoleNumber) && candidate.existingHoleNumber === hole.holeNumber) {
      score += 0.28;
      evidence.push("existing-osm-ref-match");
    }
    if (Number.isFinite(hole.distanceM)) {
      var expected = hole.distanceM * context.scale;
      var diff = Math.abs(candidate.pathDistanceM - expected) / Math.max(80, expected);
      var distanceScore = clamp(1 - diff / 0.28, 0, 1);
      score += 0.34 * distanceScore;
      evidence.push("distance-score:" + distanceScore.toFixed(2));
      var cr = context.candidateRanks[candidate.candidateId];
      var hr = context.scorecardRanks[hole.holeNumber];
      if (Number.isFinite(cr) && Number.isFinite(hr)) {
        var rankScore = clamp(1 - Math.abs(cr - hr) / 0.55, 0, 1);
        score += 0.18 * rankScore;
        evidence.push("relative-rank:" + rankScore.toFixed(2));
      }
    }
    if (hole.par && candidate.inferredPar) {
      var parScore = hole.par === candidate.inferredPar ? 1 : Math.abs(hole.par - candidate.inferredPar) === 1 ? 0.42 : 0;
      score += 0.11 * parScore;
      evidence.push("par-score:" + parScore.toFixed(2));
    }
    var text = hole.descriptionEvidence || {};
    if (text.dogleg && candidate.shape.indexOf("dogleg") >= 0) {
      var expectedShape = text.dogleg === "left" ? "dogleg-left" : "dogleg-right";
      score += candidate.shape === expectedShape ? 0.06 : -0.04;
      evidence.push("description-dogleg:" + text.dogleg);
    }
    if (text.water && (candidate.nearbyWater || candidate.crossingWater)) {
      score += 0.04;
      evidence.push("description-water");
    }
    return {
      score: clamp(score, 0, 1),
      evidence: evidence
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

  function matchCandidatesToScorecard(candidates, scorecard, expectedHoleCount) {
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
      scorecardRanks: rankMap(holes, function (hole) { return hole.distanceM; }, function (hole) { return hole.holeNumber; })
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
      return {
        holeNumber: assignment.hole.holeNumber,
        par: assignment.hole.par,
        officialDistanceM: assignment.hole.distanceM,
        candidate: assignment.candidate,
        matchScore: assignment.pair.score,
        confidence: baseConfidence,
        evidence: assignment.pair.evidence.concat(assignment.continuity ? ["routing-continuity:" + assignment.continuity.toFixed(2)] : [])
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

  function resolveStatus(assignments, confidence, expected) {
    var high = assignments.filter(function (hole) { return hole.confidence >= HIGH_CONFIDENCE; }).length;
    if (assignments.length >= expected && confidence >= HIGH_CONFIDENCE && high >= expected) return "resolved";
    if (high > 0 && confidence >= MEDIUM_CONFIDENCE) return "partially-resolved";
    if (assignments.length && confidence >= MEDIUM_CONFIDENCE) return "partially-resolved";
    return "insufficient-confidence";
  }

  async function resolveCourseGeometryForAutoMapper(input) {
    input = input || {};
    var payload = input.osmPayload || {};
    var elements = payload.elements || input.elements || [];
    var course = input.course || {};
    var courseId = String(course.courseId || course.id || input.courseId || course.name || course.courseName || "course");
    var warnings = [];
    var analysisBoundary = deriveAnalysisBoundary(input, elements);
    var greenResult = detectGreenCandidates(elements, analysisBoundary);
    var candidates = detectHoleGeometryCandidates(elements, greenResult.accepted, analysisBoundary);
    var scorecard = normalizeScorecard(input);
    var expected = expectedHoleCount(input, scorecard);
    var match = matchCandidatesToScorecard(candidates, scorecard, expected);
    warnings = warnings.concat(match.warnings || []);
    if (greenResult.accepted.length < Math.min(6, expected)) warnings.push("Few reliable green polygons were found inside the course boundary.");
    if (!candidates.length) warnings.push("No candidate centre-lines could be constructed.");
    var status = resolveStatus(match.assignments, match.confidence, expected);
    var assignedIds = {};
    match.assignments.forEach(function (assignment) { assignedIds[assignment.candidate.candidateId] = true; });
    return {
      courseId: courseId,
      status: status,
      holes: match.assignments,
      unresolvedCandidates: candidates.filter(function (candidate) { return !assignedIds[candidate.candidateId]; }),
      unresolvedScorecardHoles: match.unresolvedScorecardHoles,
      analysisBoundary: analysisBoundary,
      confidence: match.confidence,
      warnings: warnings,
      resolverVersion: RESOLVER_VERSION,
      resolvedAt: new Date().toISOString(),
      source: SOURCE,
      debugEvidence: {
        analysisBoundary: analysisBoundary,
        greenCandidates: greenResult.accepted,
        rejectedGreenCandidates: greenResult.rejected,
        holeCandidates: candidates,
        scorecardHoles: scorecard,
        assignmentAlternatives: match.alternatives || []
      }
    };
  }

  function debugEnabled() {
    try {
      return !!window.gdCourseGeometryResolverDebug ||
        localStorage.getItem("gd_course_geometry_resolver_debug") === "1";
    } catch (e) {
      return !!window.gdCourseGeometryResolverDebug;
    }
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
      detectGreenCandidates: detectGreenCandidates,
      detectHoleGeometryCandidates: detectHoleGeometryCandidates,
      matchCandidatesToScorecard: matchCandidatesToScorecard
    }
  };
})();
