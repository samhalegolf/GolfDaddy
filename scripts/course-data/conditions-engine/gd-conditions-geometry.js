(function () {
  'use strict';

  /*
    Conditions Engine geometry.

    Owns the local-frame maths and the ONE shared Bubble-fit comparison used by
    every candidate variant (raw, wind, slope, combined). There is deliberately
    no per-variant fit path — if raw and windNormalised were scored by different
    code, an improvement could be an artefact of the scoring rather than the
    normalisation.

    Frame convention matches scripts/gd-shot-outcomes.js exactly so analytical
    results agree with the outcome classifier already in the app:
      - orientation is a compass bearing in degrees
      - forward is along that bearing
      - lateral is positive to the RIGHT of that bearing
    Units here are metres throughout. plannedBubble stores yards; normaliseBubble
    converts once, at the boundary.
  */

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  var EARTH_LAT_M = 111320;
  var YARDS_TO_METERS = 0.9144;

  function asNumber(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function firstNumber() {
    for (var i = 0; i < arguments.length; i++) {
      var n = Number(arguments[i]);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function hasLatLng(point) {
    return !!point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng));
  }

  function toRad(degrees) { return asNumber(degrees, 0) * Math.PI / 180; }
  function toDeg(radians) { return asNumber(radians, 0) * 180 / Math.PI; }

  function normaliseDegrees(deg) {
    var d = asNumber(deg, 0) % 360;
    if (d < 0) d += 360;
    return d;
  }

  // Smallest signed angle from a to b, in (-180, 180].
  function angleDifference(a, b) {
    var diff = normaliseDegrees(b) - normaliseDegrees(a);
    if (diff > 180) diff -= 360;
    if (diff <= -180) diff += 360;
    return diff;
  }

  function lngScale(lat) {
    return EARTH_LAT_M * Math.cos(toRad(lat));
  }

  function toLocal(origin, point, orientationDeg) {
    if (!hasLatLng(origin) || !hasLatLng(point)) return { lateral: 0, forward: 0 };
    var originLat = asNumber(origin.lat, 0);
    var pointLat = asNumber(point.lat, 0);
    var north = (pointLat - originLat) * EARTH_LAT_M;
    var east = (asNumber(point.lng, 0) - asNumber(origin.lng, 0)) * lngScale((originLat + pointLat) / 2);
    var angle = toRad(orientationDeg);
    return {
      lateral: east * Math.cos(angle) - north * Math.sin(angle),
      forward: east * Math.sin(angle) + north * Math.cos(angle)
    };
  }

  function fromLocal(origin, local, orientationDeg) {
    if (!hasLatLng(origin)) return null;
    var angle = toRad(orientationDeg);
    var lateral = asNumber(local && local.lateral, 0);
    var forward = asNumber(local && local.forward, 0);
    var east = lateral * Math.cos(angle) + forward * Math.sin(angle);
    var north = -lateral * Math.sin(angle) + forward * Math.cos(angle);
    var originLat = asNumber(origin.lat, 0);
    var lat = originLat + north / EARTH_LAT_M;
    return {
      lat: lat,
      lng: asNumber(origin.lng, 0) + east / lngScale((originLat + lat) / 2)
    };
  }

  function distanceMetres(a, b) {
    if (!hasLatLng(a) || !hasLatLng(b)) return null;
    var local = toLocal(a, b, 0);
    return Math.sqrt(local.lateral * local.lateral + local.forward * local.forward);
  }

  function bearingDegrees(a, b) {
    if (!hasLatLng(a) || !hasLatLng(b)) return null;
    var local = toLocal(a, b, 0);
    if (local.lateral === 0 && local.forward === 0) return null;
    return normaliseDegrees(toDeg(Math.atan2(local.lateral, local.forward)));
  }

  function project(point, bearingDeg, distanceM) {
    if (!hasLatLng(point)) return null;
    var d = asNumber(distanceM, 0);
    return fromLocal(point, { lateral: 0, forward: d }, bearingDeg);
  }

  /*
    Collapse the many historical aliases for the same bubble quantity into one
    canonical metres-based shape. Mirrors gdMyBubbleStrictGpsSource in
    gd-route-audit.js; kept here so the engine has no load-order dependency on
    the My Bubble owner.

    A bubble stored as plannedBubble (yards) is converted by passing
    { units: 'yards' } or by supplying lengthYards / widthYards.
  */
  function normaliseBubble(raw) {
    if (!raw || typeof raw !== 'object') return null;

    var centerLat = firstNumber(raw.centerLat, raw.centreLat, raw.lat, raw.center && raw.center.lat);
    var centerLng = firstNumber(raw.centerLng, raw.centreLng, raw.lng, raw.center && raw.center.lng);
    if (centerLat === null || centerLng === null) return null;

    var yardsSource = raw.units === 'yards' || Number.isFinite(Number(raw.lengthYards)) || Number.isFinite(Number(raw.widthYards));

    var widthRaw = firstNumber(raw.widthM, raw.bubbleWidthM, raw.clusterWidthM, raw.visualWidthM, raw.widthYards);
    var depthRaw = firstNumber(raw.depthM, raw.bubbleDepthM, raw.clusterDepthM, raw.visualDepthM, raw.lengthYards, raw.depthYards);
    if (widthRaw === null || depthRaw === null) return null;

    var scale = yardsSource ? YARDS_TO_METERS : 1;
    var widthM = Math.abs(widthRaw) * scale;
    var depthM = Math.abs(depthRaw) * scale;
    if (!(widthM > 0) || !(depthM > 0)) return null;

    var carryM = firstNumber(raw.carryM, raw.baseCarry, raw.baseDistanceM, raw.expectedDistanceM, raw.meanExpectedM);
    var totalM = firstNumber(raw.totalM, raw.totalDistanceM);
    if (carryM !== null && yardsSource && raw.carryM == null && raw.baseCarry == null) {
      carryM = carryM * scale;
    }

    return {
      versionId: raw.versionId || raw.myBubbleVersionId || null,
      club: raw.club || raw.clubId || null,
      centerLat: centerLat,
      centerLng: centerLng,
      orientationDeg: normaliseDegrees(firstNumber(raw.orientationDeg, raw.orientation, 0)),
      widthM: widthM,
      depthM: depthM,
      offsetDeg: asNumber(firstNumber(raw.offsetDeg, raw.faceOffsetDeg, raw.faceAlignmentOffsetDeg, 0), 0),
      carryM: carryM,
      totalM: totalM,
      shape: raw.shape === 'capsule' ? 'capsule' : 'oval',
      confidence: raw.confidence == null ? null : raw.confidence,
      source: raw.source || raw.shapeSource || null
    };
  }

  /*
    THE shared Bubble-fit comparison.

    Scores a candidate position against the active My Bubble using the bubble's
    own centre, orientation, width and depth — not distance-from-centre. The
    normalised ellipse radius r is 0 at the centre and 1 on the boundary.

      score = clamp(1 - r/2, 0, 1)

    so 1.0 is dead centre, 0.5 sits exactly on the boundary, and 0 is two bubble
    radii out. Higher is always better, and an improvement is a plain
    subtraction, which keeps the safeguard thresholds readable.
  */
  function evaluateBubbleFit(bubble, position, options) {
    options = options || {};
    var normalised = bubble && bubble.widthM ? bubble : normaliseBubble(bubble);

    if (!normalised || !hasLatLng(position)) {
      return {
        score: 0,
        insideBubble: false,
        boundaryDistance: null,
        longitudinalError: null,
        lateralError: null,
        orientationUsed: null,
        distanceModel: null,
        confidence: 0,
        valid: false,
        reason: !normalised ? 'INVALID_BUBBLE' : 'INVALID_POSITION'
      };
    }

    var centre = { lat: normalised.centerLat, lng: normalised.centerLng };
    var orientation = normalised.orientationDeg;

    // The bubble centre already carries any club/offset placement applied
    // upstream. Only re-apply the degree offset when the caller explicitly
    // supplies an unplaced centre, so we never double-count it.
    if (options.applyOffset && normalised.offsetDeg && Number.isFinite(Number(normalised.carryM))) {
      var offsetM = Math.tan(toRad(normalised.offsetDeg)) * Number(normalised.carryM);
      centre = fromLocal(centre, { lateral: offsetM, forward: 0 }, orientation);
    }

    var local = toLocal(centre, position, orientation);
    var halfWidth = Math.max(normalised.widthM / 2, 0.5);
    var halfDepth = Math.max(normalised.depthM / 2, 0.5);

    var nx = local.lateral / halfWidth;
    var ny = local.forward / halfDepth;
    var r = Math.sqrt(nx * nx + ny * ny);

    var radial = Math.sqrt(local.lateral * local.lateral + local.forward * local.forward);
    var boundaryDistance = r > 0 ? radial * (1 - 1 / r) : -Math.min(halfWidth, halfDepth);

    return {
      score: Math.max(0, Math.min(1, 1 - r / 2)),
      insideBubble: r <= 1,
      normalisedRadius: r,
      boundaryDistance: boundaryDistance,
      longitudinalError: local.forward,
      lateralError: local.lateral,
      orientationUsed: orientation,
      distanceModel: Number.isFinite(Number(normalised.totalM)) && Number(normalised.totalM) > Number(normalised.carryM) ? 'total' : 'carry',
      confidence: asNumber(options.confidence, asNumber(normalised.confidence, 1)),
      valid: true,
      reason: null
    };
  }

  var api = {
    EARTH_LAT_M: EARTH_LAT_M,
    YARDS_TO_METERS: YARDS_TO_METERS,
    asNumber: asNumber,
    hasLatLng: hasLatLng,
    normaliseDegrees: normaliseDegrees,
    angleDifference: angleDifference,
    toLocal: toLocal,
    fromLocal: fromLocal,
    distanceMetres: distanceMetres,
    bearingDegrees: bearingDegrees,
    project: project,
    normaliseBubble: normaliseBubble,
    evaluateBubbleFit: evaluateBubbleFit
  };

  root.modules.conditionsGeometry = api;
  window.GolfDaddyConditionsGeometry = api;
  window.ClarityCaddieConditionsGeometry = api;
  if (window.ClarityCaddie) window.ClarityCaddie.modules = root.modules;
})();
