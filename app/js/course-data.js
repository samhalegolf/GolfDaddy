/* GPS Play → Course Data.

   Restores the on-course shot feed that was lost when the old play runtime was
   deleted (GPS_PLAY_DELETION_AUDIT_2026-08-02 §3b). It goes to COURSE DATA, and
   only there. gd-shot-snapshot.js states the contract this follows:

     "GPS Play's only analytical output ... GPS Play performs no wind
      correction, no slope correction, no My Bubble comparison, no variant
      selection and no recommendation logic — it records what happened and what
      the player chose."

   So this module measures and records. It does not compare, score, or correct,
   and gd-course-data-comparison.js — the My Bubble comparison layer — is
   deliberately NOT loaded on this surface. Comparing a shot against a bubble is
   a downstream question, asked where the analysis is read, not in the middle of
   a round.

   Two rules follow from "records what happened":

   1. Evidence and intent are separate fields. The wind picker and the elevation
      readout are aiming aids; what the player set is intent (userSelected*),
      what was measured is evidence (live*). Where there is no measurement the
      field stays null and its availability flag stays false. Nothing here
      substitutes one for the other to fill a gap.
   2. Nothing about this may interrupt play. Submission is wrapped, the intake
      persists synchronously and defers its own analysis, and every failure is
      swallowed after being reported. A round must not end because a shot could
      not be filed.
*/
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  var roundId = null;
  var sequence = 0;
  var state = { submitted: 0, onScreen: 0, rejected: 0, lastErrors: [] };

  function intake() {
    return window.GolfDaddyCourseDataIntake
      || (window.GolfDaddy && window.GolfDaddy.modules && window.GolfDaddy.modules.courseDataIntake)
      || null;
  }
  function snapshots() {
    return window.GolfDaddyShotSnapshot
      || (window.GolfDaddy && window.GolfDaddy.modules && window.GolfDaddy.modules.shotSnapshot)
      || null;
  }

  function shotEvents() {
    return window.GolfDaddyShotEvents
      || (window.GolfDaddy && window.GolfDaddy.modules && window.GolfDaddy.modules.shotEvents)
      || null;
  }

  function report(error, context) {
    try {
      if (window.ClarityErrorReporter && window.ClarityErrorReporter.report) {
        window.ClarityErrorReporter.report(error, Object.assign({ source: "course-data-feed" }, context || {}));
      }
    } catch (e) {}
  }

  /* Ids are derived, not random: the same round on the same device reproduces
     them, which is what makes the intake's idempotent re-submission useful
     rather than a source of duplicates. */
  function newRoundId(courseKey) {
    return "round:" + (courseKey || "unknown") + ":" + Date.now();
  }
  function shotIdFor(hole, index) {
    return roundId + ":h" + hole + ":s" + index;
  }

  function bearingDeg(from, to) {
    if (!from || !to) return null;
    var toRad = Math.PI / 180;
    var dLng = (to.lng - from.lng) * toRad;
    var y = Math.sin(dLng) * Math.cos(to.lat * toRad);
    var x = Math.cos(from.lat * toRad) * Math.sin(to.lat * toRad)
      - Math.sin(from.lat * toRad) * Math.cos(to.lat * toRad) * Math.cos(dLng);
    var deg = Math.atan2(y, x) / toRad;
    return (deg + 360) % 360;
  }

  function orUnmeasured(value) {
    return Number.isFinite(Number(value)) ? Number(value) : UNMEASURED;
  }

  /* The club the shot card was showing when the shot was taken - the engine's
     own answer for this distance, which is what the player saw. Null when there
     was no model up, which is a normal state, not a failure. */
  function clubForShot() {
    try {
      var model = window.GDBubbleEngine && window.GDBubbleEngine.renderModel();
      var payload = model && model.payload;
      return payload && payload.club ? String(payload.club) : null;
    } catch (e) { return null; }
  }

  /* Absent numeric evidence must be passed as undefined, NOT null.
     buildShotSnapshot runs every number through asNumber(value, null), and
     Number(null) is 0 - a finite value - so a null here is stored as a real
     measurement of zero. "No wind reading" would become "wind measured at
     0 km/h", which is precisely the invented observation the snapshot contract
     forbids. Number(undefined) is NaN, so the null fallback applies and the
     field stays honestly empty. */
  var UNMEASURED = undefined;

  function windFields() {
    var live = (app.wind && app.wind.liveReading && app.wind.liveReading()) || null;
    var chosen = (app.wind && app.wind.selection && app.wind.selection()) || null;
    return {
      liveWindAvailable: !!live,
      liveWindSpeed: live ? live.speedKmh : UNMEASURED,
      liveWindDirection: live ? live.directionDeg : UNMEASURED,
      liveWindScaleLevel: live ? live.level : UNMEASURED,
      liveWindSource: live ? live.source : null,
      liveWindCapturedAt: live ? live.capturedAt : null,

      userSelectedWind: !!chosen,
      userWindSelection: chosen
        ? { originAngleRad: chosen.originAngleRad, level: chosen.level }
        : null
    };
  }

  /* Elevation is the only slope evidence this surface has. plays-like.js answers
     null for every "not today" - no lookup yet, lookup failed, unusable points -
     and null passes straight through as "not measured". */
  function slopeFields(shot) {
    var reading = null;
    try {
      if (app.playsLike && shot.start && shot.end && app.distance) {
        var flat = app.distance.haversineMeters(shot.start, shot.end);
        reading = app.playsLike.forShot(shot.start, shot.end, flat);
      }
    } catch (e) { reading = null; }
    var delta = reading && Number(reading.deltaM);
    var known = Number.isFinite(delta);
    return {
      liveSlopeAvailable: known,
      liveSlopeValue: known ? delta : UNMEASURED,
      liveSlopeDirection: known ? (delta > 0 ? "uphill" : delta < 0 ? "downhill" : "level") : null,
      liveSlopeSource: known ? "open-meteo-elevation" : null,
      liveSlopeCapturedAt: known ? new Date().toISOString() : null
    };
  }

  var METERS_TO_YARDS = 1.0936132983;

  /* The Course Data screen does not read the snapshot store. It reads planned
     shots paired with landings from gd_shot_events_v1 (gd-shot-events.js), the
     store the old play runtime filled. Filing the snapshot alone left every
     round invisible on that screen, so the same shot is filed there too: the
     bubble the player was shown, and where the ball finished. That is still a
     record of what happened - the comparison is worked out on the screen.

     Returns false when there is no bubble on screen (no club model up): an
     outcome needs the bubble it is measured against, and inventing one would
     put a shot on the screen that was never planned. */
  function fileForScreen(shot, meta, shotId, clubId) {
    var events = shotEvents();
    if (!events || !shot.target) return false;
    var model = window.GDBubbleEngine && window.GDBubbleEngine.renderModel();
    var payload = model && model.payload;
    var center = model && model.center;
    if (!payload || !center) return false;

    var lengthM = Math.max(1, Number(payload.depthRadiusM) * 2 || 0);
    var widthM = Math.max(1, Number(payload.lateralRadiusM) * 2 || 0);
    var aimM = app.distance ? app.distance.haversineMeters(shot.start, shot.target) : null;
    var holeId = "hole-" + meta.hole;
    var planned = Date.now();

    events.logPlannedShot({
      shotId: shotId,
      roundId: roundId,
      holeId: holeId,
      origin: shot.start,
      plannedBubble: {
        centerLat: center.lat,
        centerLng: center.lng,
        orientationDeg: bearingDeg(shot.start, shot.target),
        lengthYards: lengthM * METERS_TO_YARDS,
        widthYards: widthM * METERS_TO_YARDS,
        shape: "oval"
      },
      club: clubId || "GPS",
      expectedDistanceYards: Number.isFinite(aimM) ? aimM * METERS_TO_YARDS : null,
      createdAt: new Date(planned).toISOString()
    });

    /* A millisecond later, so the landing pairs with this plan and not with
       one filed in the same tick. */
    var fix = (app.gps && app.gps.lastFix && app.gps.lastFix()) || null;
    events.logBallPosition({
      roundId: roundId,
      holeId: holeId,
      source: "at_my_ball_button",
      lat: shot.end.lat,
      lng: shot.end.lng,
      gpsAccuracyM: fix && fix.accuracy,
      motionContext: meta.captureMethod || "unknown",
      courseContext: "gps_course",
      timestamp: new Date(planned + 1).toISOString()
    });
    return true;
  }

  function submit(shot, meta) {
    var lib = snapshots();
    var sink = intake();
    if (!lib || !sink || !shot || !shot.start || !shot.end) return null;

    sequence += 1;
    var fix = (app.gps && app.gps.lastFix && app.gps.lastFix()) || null;
    var flatM = app.distance ? app.distance.haversineMeters(shot.start, shot.end) : null;
    var shotId = shotIdFor(meta.hole, sequence);
    var clubId = clubForShot();
    var events = shotEvents();
    var scope = events && events.activePlayerScope ? events.activePlayerScope() : null;

    var snapshot = lib.buildShotSnapshot(Object.assign({
      shotId: shotId,
      roundId: roundId,
      playerId: (scope && scope.playerId) || null,
      courseId: (app.marshal && app.marshal.round().courseKey) || null,
      holeNumber: meta.hole,
      capturedAt: new Date().toISOString(),

      clubId: clubId,
      shotStartPosition: shot.start,
      shotLandingPosition: shot.end,
      targetPosition: shot.target || null,
      intendedDirection: orUnmeasured(bearingDeg(shot.start, shot.target)),
      shotDistance: orUnmeasured(flatM),

      /* How the landing point was established, so an analysis can weigh a
         dragged ball differently from a walked-to fix. */
      shotCaptureMethod: meta.captureMethod || null,
      gpsAccuracy: orUnmeasured(fix && fix.accuracy)
    }, windFields(), slopeFields(shot)));

    var result = sink.submitShotSnapshot(snapshot);
    if (result && result.accepted) {
      state.submitted += 1;
      try {
        if (!result.duplicate && fileForScreen(shot, meta, shotId, clubId)) state.onScreen += 1;
      } catch (e) { report(e, { stage: "fileForScreen", shotId: shotId }); }
    } else {
      state.rejected += 1;
      state.lastErrors = (result && result.errors) || ["SUBMIT_REFUSED"];
      report(new Error("course data refused a shot: " + state.lastErrors.join(",")), {
        shotId: snapshot.shotId, errors: state.lastErrors
      });
    }
    return result;
  }

  app.courseData = {
    /* A round is the unit Course Data groups shots under, so it starts when the
       round does rather than being inferred later from timestamps. */
    startRound: function (courseKey) {
      roundId = newRoundId(courseKey);
      sequence = 0;
      state = { submitted: 0, onScreen: 0, rejected: 0, lastErrors: [] };
      return roundId;
    },
    roundId: function () { return roundId; },
    stats: function () { return Object.assign({}, state); },
    /* The Marshal calls this through its shotCompleted effect (wired in
       boot.js). There is no install() any more: subscribing to a shot module's
       own listener list was how this used to find out, and that module is gone
       — a completed shot is now something the Marshal states rather than
       something this file listens for. */
    submit: function (shot, meta) {
      try { return submit(shot, meta); }
      catch (e) { report(e, { stage: "shotCompleted" }); return null; }
    }
  };
})();
