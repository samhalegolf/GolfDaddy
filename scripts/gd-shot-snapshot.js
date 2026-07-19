(function () {
  'use strict';

  /*
    Immutable Shot Snapshot.

    GPS Play's only analytical output. At shot completion GPS Play builds a
    complete raw snapshot of the best evidence available at that moment and
    submits it to Course Data. GPS Play performs no wind correction, no slope
    correction, no My Bubble comparison, no variant selection and no
    recommendation logic — it records what happened and what the player chose.

    Note on the in-round aim tools: the wind picker and slope readout remain
    player-facing aiming aids. What they were set to is captured here as
    userSelectedWind / userWindSelection / userSelectedSlope / userSlopeSelection
    so the Conditions Engine can compare the player's intent against live
    evidence. The tools never alter the recorded positions.

    The returned object is deep-frozen. Nothing downstream may write a corrected
    result back onto it.
  */

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  var SNAPSHOT_VERSION = 1;

  function asNumber(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function latLng(point) {
    if (!point) return null;
    var lat = Number(point.lat);
    var lng = Number(point.lng == null ? point.lon : point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat: lat, lng: lng };
  }

  function isoTime(value) {
    if (!value) return null;
    if (typeof value === 'string') return value;
    var n = Number(value);
    if (Number.isFinite(n)) return new Date(n).toISOString();
    if (value instanceof Date) return value.toISOString();
    return null;
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object') return value;
    Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
    return Object.freeze(value);
  }

  /*
    Build a Shot Snapshot from raw GPS Play state.

    Everything is recorded as observed. Missing environmental evidence stays
    null and its availability flag stays false — the snapshot never invents
    conditions it did not measure.
  */
  function buildShotSnapshot(input) {
    input = input || {};

    var snapshot = {
      shotId: input.shotId || null,
      roundId: input.roundId || null,
      playerId: input.playerId || null,
      courseId: input.courseId || null,
      holeNumber: input.holeNumber == null ? null : input.holeNumber,
      capturedAt: isoTime(input.capturedAt) || new Date().toISOString(),

      clubId: input.clubId || input.club || null,
      shotStartPosition: latLng(input.shotStartPosition || input.start),
      shotLandingPosition: latLng(input.shotLandingPosition || input.landing),
      targetPosition: latLng(input.targetPosition || input.target),
      intendedDirection: asNumber(input.intendedDirection, null),
      shotDistance: asNumber(input.shotDistance, null),

      myBubbleVersionId: input.myBubbleVersionId || null,
      // Frozen copy of the bubble geometry that was live at capture time, so a
      // historical shot is never re-analysed against a newer My Bubble.
      myBubbleGeometry: input.myBubbleGeometry || null,
      bagVersionId: input.bagVersionId || null,

      liveWindAvailable: input.liveWindAvailable === true,
      liveWindSpeed: asNumber(input.liveWindSpeed, null),
      liveWindDirection: asNumber(input.liveWindDirection, null),
      liveWindScaleLevel: asNumber(input.liveWindScaleLevel, null),
      liveWindSource: input.liveWindSource || null,
      liveWindCapturedAt: isoTime(input.liveWindCapturedAt),
      liveWindConfidence: input.liveWindConfidence == null ? null : input.liveWindConfidence,

      userSelectedWind: input.userSelectedWind === true,
      userWindSelection: input.userWindSelection || null,
      userWindIntent: input.userWindIntent || null,

      liveSlopeAvailable: input.liveSlopeAvailable === true,
      liveSlopeValue: asNumber(input.liveSlopeValue, null),
      liveSlopeDirection: input.liveSlopeDirection || null,
      liveSlopeSource: input.liveSlopeSource || null,
      liveSlopeCapturedAt: isoTime(input.liveSlopeCapturedAt),
      liveSlopeConfidence: input.liveSlopeConfidence == null ? null : input.liveSlopeConfidence,

      userSelectedSlope: input.userSelectedSlope === true,
      userSlopeSelection: input.userSlopeSelection || null,
      userSlopeIntent: input.userSlopeIntent || null,

      gpsAccuracy: asNumber(input.gpsAccuracy, null),
      landingConfidence: input.landingConfidence == null ? null : input.landingConfidence,
      targetConfidence: input.targetConfidence == null ? null : input.targetConfidence,
      shotCaptureMethod: input.shotCaptureMethod || null,

      snapshotVersion: SNAPSHOT_VERSION
    };

    return deepFreeze(snapshot);
  }

  var api = {
    SNAPSHOT_VERSION: SNAPSHOT_VERSION,
    buildShotSnapshot: buildShotSnapshot
  };

  root.modules.shotSnapshot = api;
  window.GolfDaddyShotSnapshot = api;
  window.ClarityCaddieShotSnapshot = api;
  if (window.ClarityCaddie) window.ClarityCaddie.modules = root.modules;
})();
