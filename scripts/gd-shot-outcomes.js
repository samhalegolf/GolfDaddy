(function () {
  'use strict';

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  var METERS_TO_YARDS = 1.0936132983;
  var EARTH_LAT_M = 111320;

  function asNumber(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function hasLatLng(point) {
    return point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng));
  }

  function toRad(degrees) {
    return asNumber(degrees, 0) * Math.PI / 180;
  }

  function metersToYards(meters) {
    return asNumber(meters, 0) * METERS_TO_YARDS;
  }

  function localMeters(origin, point, orientationDeg) {
    if (!hasLatLng(origin) || !hasLatLng(point)) {
      return { lateral: 0, forward: 0 };
    }

    var originLat = asNumber(origin.lat, 0);
    var pointLat = asNumber(point.lat, 0);
    var avgLatRad = toRad((originLat + pointLat) / 2);
    var north = (pointLat - originLat) * EARTH_LAT_M;
    var east = (asNumber(point.lng, 0) - asNumber(origin.lng, 0)) * EARTH_LAT_M * Math.cos(avgLatRad);
    var angle = toRad(orientationDeg);

    return {
      lateral: east * Math.cos(angle) - north * Math.sin(angle),
      forward: east * Math.sin(angle) + north * Math.cos(angle)
    };
  }

  function localYards(origin, point, orientationDeg) {
    var local = localMeters(origin, point, orientationDeg);
    return {
      lateral: metersToYards(local.lateral),
      forward: metersToYards(local.forward)
    };
  }

  function classifyRelativeResult(delta, bubble) {
    var halfLength = Math.max(asNumber(bubble.lengthYards, 0) / 2, 1);
    var halfWidth = Math.max(asNumber(bubble.widthYards, 0) / 2, 1);
    var ovalScore = Math.pow(delta.forward / halfLength, 2) + Math.pow(delta.lateral / halfWidth, 2);

    if (ovalScore <= 1) {
      return 'inside';
    }

    var longShortLimit = Math.max(halfLength * 0.25, 4);
    var leftRightLimit = Math.max(halfWidth * 0.25, 3);
    var distancePart = '';
    var lateralPart = '';

    if (delta.forward > longShortLimit) {
      distancePart = 'long';
    } else if (delta.forward < -longShortLimit) {
      distancePart = 'short';
    }

    if (delta.lateral > leftRightLimit) {
      lateralPart = 'right';
    } else if (delta.lateral < -leftRightLimit) {
      lateralPart = 'left';
    }

    if (distancePart && lateralPart) {
      return distancePart + '_' + lateralPart;
    }
    return distancePart || lateralPart || 'unknown';
  }

  function computeShotOutcome(plannedShot, resultEvent, options) {
    options = options || {};
    if (!plannedShot || !plannedShot.plannedBubble || !resultEvent) {
      return null;
    }

    var bubble = plannedShot.plannedBubble;
    var origin = plannedShot.origin || plannedShot.originLatLng;
    var result = { lat: resultEvent.lat, lng: resultEvent.lng };
    var bubbleCenter = { lat: bubble.centerLat, lng: bubble.centerLng };

    if (!hasLatLng(origin) || !hasLatLng(result) || !hasLatLng(bubbleCenter)) {
      return {
        shotId: plannedShot.shotId,
        resultEventId: resultEvent.eventId,
        pairedConfidence: asNumber(options.pairedConfidence, 0),
        insideBubble: false,
        relativeResult: 'unknown'
      };
    }

    var orientation = asNumber(bubble.orientationDeg, 0);
    var centerLocal = localYards(origin, bubbleCenter, orientation);
    var resultLocal = localYards(origin, result, orientation);
    var delta = {
      lateral: resultLocal.lateral - centerLocal.lateral,
      forward: resultLocal.forward - centerLocal.forward
    };
    var relativeResult = classifyRelativeResult(delta, bubble);

    return {
      outcomeId: options.outcomeId || null,
      shotId: plannedShot.shotId,
      resultEventId: resultEvent.eventId,
      pairedConfidence: asNumber(options.pairedConfidence, 0),
      insideBubble: relativeResult === 'inside',
      relativeResult: relativeResult,
      lateralErrorYards: Number(delta.lateral.toFixed(1)),
      distanceErrorYards: Number(delta.forward.toFixed(1)),
      gpsAccuracyM: Number.isFinite(Number(resultEvent.gpsAccuracyM)) ? Number(resultEvent.gpsAccuracyM) : null,
      sourceConfidence: resultEvent.confidence || 'unknown',
      computedAt: new Date().toISOString()
    };
  }

  root.modules.shotOutcomes = {
    computeShotOutcome: computeShotOutcome,
    localMeters: localMeters,
    localYards: localYards,
    metersToYards: metersToYards
  };
  if (window.ClarityCaddie) window.ClarityCaddie.modules = root.modules;
})();
