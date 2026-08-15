/* Bubble Signal Test Data Generator - the single implementation.
 *
 * Loaded two ways, same policy as the parser and signals cores:
 *   - browser, via <script> in index.html, as window.GDBubbleSignalTestData
 *   - node, via require("../scripts/gd-bubble-signal-test-data.js")
 *
 * ------------------------------------------------------------------------
 * WHAT IT IS FOR
 *
 * Not "random numbers that look like golf". The point is Bubble-eligible data
 * with a DELIBERATELY PLANTED relationship, so the loop
 *
 *     generate evidence -> detect Signal -> inspect geometry effect
 *
 * can be closed without waiting for a real player to develop a real tendency.
 * Every generated set is put back through the real detector before it is
 * returned, and reports whether the relationship it planted is actually
 * detectable - see verify() and the `detection` block on the result.
 *
 * ------------------------------------------------------------------------
 * PROVIDERS
 *
 * There is no second provider registry here. The keys (trackman, foresight,
 * flightscope, garmin_r10, skytrak, toptracer, uneekor, fullswing, rapsodo,
 * awesome_golf) are the ones scripts/gd-launch-monitor-data.js already
 * fingerprints, and PROVIDER_EMIT below only says two things per provider:
 * which metrics that monitor actually reports, and the column names it prints
 * them under. Those column names are chosen from the same verbiage
 * LM_PROVIDER_SIGNATURES matches on, so text produced here is identified as
 * that provider by the existing fingerprinter rather than by anything new.
 * verifyProviderText() asserts exactly that when the launch-monitor module is
 * present.
 *
 * ------------------------------------------------------------------------
 * REPRODUCIBILITY
 *
 * Everything random comes from seedRandom(). Pass a seed and the same data
 * comes back byte for byte; omit it and one is generated and returned on the
 * result so a useful case can be pinned afterwards.
 */
(function (root, factory) {
  'use strict';
  var api = factory(
    typeof module === 'object' && module.exports
      ? require('./gd-bubble-signals-core.js')
      : (root.GDBubbleSignalsCore || null)
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GDBubbleSignalTestData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (signalsCore) {
  'use strict';

  if (!signalsCore) throw new Error('gd-bubble-signal-test-data: load scripts/gd-bubble-signals-core.js first');

  /* ---------------------------------------------------------------------
     Seeded randomness (mulberry32). Small, fast, and identical in node and
     the browser, which is the whole requirement.
     --------------------------------------------------------------------- */

  function seedRandom(seed) {
    var state = seed >>> 0;
    return function () {
      state = (state + 0x6D2B79F5) >>> 0;
      var t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeRng(seed) {
    var rng = seedRandom(seed);
    /* Box-Muller, so shot-to-shot scatter is actually normal rather than the
       flat spread a bare random() gives. Real dispersion has a middle. */
    function normal() {
      var u = 0;
      var v = 0;
      while (u === 0) u = rng();
      while (v === 0) v = rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    return {
      next: rng,
      normal: normal,
      jitter: function (sigma) { return normal() * sigma; },
      pick: function (list) { return list[Math.floor(rng() * list.length) % list.length]; }
    };
  }

  /* ---------------------------------------------------------------------
     The reference bag

     Chosen so that a shot set generated with NO planted relationship sits
     exactly on scripts/gd-bubble-signals-core.js's `normals`. That is what
     makes the Control scenario meaningful: identical Base and Adjusted Bubble
     is a real result, not a coincidence of numbers nobody checked.
     --------------------------------------------------------------------- */

  var CLUB_LADDER = [
    { club: 'PW', carryM: 118, dynamicLoft: 42.0, spin: 9000, attackAngle: -4.5, descentAngle: 50 },
    { club: '9i', carryM: 128, dynamicLoft: 38.0, spin: 8200, attackAngle: -4.2, descentAngle: 49 },
    { club: '8i', carryM: 138, dynamicLoft: 34.0, spin: 7400, attackAngle: -4.0, descentAngle: 48 },
    { club: '7i', carryM: 148, dynamicLoft: 30.0, spin: 6800, attackAngle: -3.8, descentAngle: 47 },
    { club: '6i', carryM: 158, dynamicLoft: 27.0, spin: 6200, attackAngle: -3.5, descentAngle: 46 },
    { club: '5i', carryM: 168, dynamicLoft: 24.0, spin: 5600, attackAngle: -3.2, descentAngle: 45 },
    { club: '4i', carryM: 178, dynamicLoft: 21.5, spin: 5100, attackAngle: -3.0, descentAngle: 44 },
    { club: '3w', carryM: 205, dynamicLoft: 15.0, spin: 3800, attackAngle: -1.5, descentAngle: 41 },
    { club: 'Driver', carryM: 230, dynamicLoft: 12.5, spin: 2600, attackAngle: 2.5, descentAngle: 38 }
  ];

  /* Launch intercept that pairs with normals.launchToLoftSlope. */
  var LAUNCH_INTERCEPT = 1.2;

  /* Carry:total at the shortest club; the rest comes from the normal slope. */
  var ROLLOUT_BASE_RATIO = 1.02;

  function ladderFor(clubCount) {
    var count = Math.max(1, Math.min(CLUB_LADDER.length, Number(clubCount) || CLUB_LADDER.length));
    if (count === CLUB_LADDER.length) return CLUB_LADDER.slice();
    /* Spread the requested number evenly across the bag rather than taking the
       first N - a "5 club" set that is all wedges cannot show a progression,
       which is the thing most of these scenarios exist to test. */
    var out = [];
    for (var i = 0; i < count; i++) {
      var index = count === 1 ? 0 : Math.round((i * (CLUB_LADDER.length - 1)) / (count - 1));
      if (!out.length || out[out.length - 1] !== CLUB_LADDER[index]) out.push(CLUB_LADDER[index]);
    }
    return out;
  }

  /* Fraction of the way up the bag, 0 at the shortest club, 1 at the longest.
     Every progression is written against this, so the same relationship
     strength means the same thing whatever clubs are in the set. */
  function bagPosition(ladder, entry) {
    if (ladder.length < 2) return 0;
    var min = ladder[0].carryM;
    var max = ladder[ladder.length - 1].carryM;
    return max > min ? (entry.carryM - min) / (max - min) : 0;
  }

  /* ---------------------------------------------------------------------
     What each monitor reports, and what it calls it

     `fields` is the metric list. `headers` is the label this monitor prints,
     chosen to match the tokens LM_PROVIDER_SIGNATURES already scores on.
     --------------------------------------------------------------------- */

  var ALL_FIELDS = [
    'club', 'carryDistance', 'totalDistance', 'offlineDistance', 'ballSpeed', 'clubSpeed',
    'faceAngle', 'pathAngle', 'faceToPath', 'spinAxis', 'dynamicLoft', 'dynamicLie',
    'launchAngle', 'startDirection', 'spin', 'peakHeight', 'attackAngle', 'descentAngle', 'hangTime'
  ];

  var PROVIDER_EMIT = {
    trackman: {
      label: 'Trackman',
      fields: ['club', 'ballSpeed', 'clubSpeed', 'launchAngle', 'startDirection', 'spin', 'spinAxis',
        'faceAngle', 'pathAngle', 'faceToPath', 'dynamicLoft', 'dynamicLie', 'attackAngle',
        'carryDistance', 'totalDistance', 'offlineDistance', 'peakHeight', 'hangTime'],
      headers: {
        club: 'Club', ballSpeed: 'Ball Speed', clubSpeed: 'Club Speed', launchAngle: 'Launch Angle',
        startDirection: 'Launch Direction', spin: 'Spin Rate', spinAxis: 'Spin Axis',
        faceAngle: 'Face Angle', pathAngle: 'Club Path', faceToPath: 'Face To Path',
        dynamicLoft: 'Dyn. Loft', dynamicLie: 'Dynamic Lie', attackAngle: 'Attack Angle',
        carryDistance: 'Carry', totalDistance: 'Total', offlineDistance: 'Side Total',
        peakHeight: 'Height', hangTime: 'Hang Time'
      },
      /* "swing direction" and "low point" are Trackman-only vocabulary; a
         preamble line carrying them makes the fingerprint unambiguous without
         inventing columns the parser would then have to ignore. */
      preamble: 'TrackMan Range Report - Swing Direction / Low Point session'
    },
    foresight: {
      label: 'Foresight (GCQuad/GC3)',
      fields: ['club', 'ballSpeed', 'clubSpeed', 'launchAngle', 'startDirection', 'spin', 'spinAxis',
        'faceAngle', 'pathAngle', 'dynamicLoft', 'dynamicLie', 'attackAngle',
        'carryDistance', 'totalDistance', 'offlineDistance', 'peakHeight', 'descentAngle'],
      headers: {
        club: 'Club', ballSpeed: 'Ball Speed', clubSpeed: 'Club Speed', launchAngle: 'Launch Angle',
        startDirection: 'Side Angle', spin: 'Spin', spinAxis: 'Spin Tilt Axis',
        faceAngle: 'Face To Target', pathAngle: 'Club Path', dynamicLoft: 'Loft Angle',
        dynamicLie: 'Lie', attackAngle: 'Angle Of Attack', carryDistance: 'Carry',
        totalDistance: 'Total', offlineDistance: 'Offline', peakHeight: 'Peak Height',
        descentAngle: 'Descent Angle'
      },
      preamble: 'GCQuad session export - Foresight Sports'
    },
    flightscope: {
      label: 'FlightScope / Mevo',
      fields: ['club', 'ballSpeed', 'clubSpeed', 'launchAngle', 'startDirection', 'spin', 'spinAxis',
        'faceAngle', 'pathAngle', 'attackAngle', 'carryDistance', 'totalDistance', 'offlineDistance', 'peakHeight'],
      headers: {
        club: 'Club', ballSpeed: 'Ball Speed', clubSpeed: 'Club Speed',
        launchAngle: 'Vertical Launch', startDirection: 'Horizontal Launch', spin: 'Spin Rate',
        spinAxis: 'Spin Axis', faceAngle: 'Face Angle', pathAngle: 'Club Path',
        attackAngle: 'AoA', carryDistance: 'Carry', totalDistance: 'Total',
        offlineDistance: 'Lateral', peakHeight: 'Height'
      },
      preamble: 'FlightScope Mevo Plus - session export (Roll included)'
    },
    garmin_r10: {
      label: 'Garmin R10',
      fields: ['club', 'ballSpeed', 'clubSpeed', 'launchAngle', 'startDirection', 'spin',
        'spinAxis', 'faceAngle', 'pathAngle', 'attackAngle', 'carryDistance', 'totalDistance',
        'offlineDistance', 'peakHeight'],
      headers: {
        club: 'Club Type', ballSpeed: 'Ball Speed', clubSpeed: 'Club Head Speed',
        launchAngle: 'Launch Angle', startDirection: 'Launch Direction', spin: 'Spin Rate',
        spinAxis: 'Spin Axis', faceAngle: 'Club Face', pathAngle: 'Club Path',
        attackAngle: 'Attack Angle', carryDistance: 'Carry Distance', totalDistance: 'Total Distance',
        offlineDistance: 'Deviation Distance', peakHeight: 'Apex Height'
      },
      preamble: 'Garmin Approach R10 - Deviation Angle / Deviation Distance export'
    },
    skytrak: {
      label: 'SkyTrak',
      fields: ['club', 'ballSpeed', 'launchAngle', 'startDirection', 'spin', 'spinAxis',
        'carryDistance', 'totalDistance', 'offlineDistance', 'peakHeight', 'descentAngle'],
      headers: {
        club: 'Club', ballSpeed: 'Ball Speed', launchAngle: 'Launch Angle',
        startDirection: 'Side Angle', spin: 'Back Spin', spinAxis: 'Side Spin',
        carryDistance: 'Carry', totalDistance: 'Total', offlineDistance: 'Offline',
        peakHeight: 'Peak Height', descentAngle: 'Descent Angle'
      },
      preamble: 'SkyTrak session - Roll Out / Flight Path'
    },
    toptracer: {
      label: 'Toptracer',
      fields: ['club', 'ballSpeed', 'launchAngle', 'spin', 'carryDistance', 'totalDistance',
        'offlineDistance', 'peakHeight', 'hangTime'],
      headers: {
        club: 'Club', ballSpeed: 'Ball Speed', launchAngle: 'Launch Angle', spin: 'Spin',
        carryDistance: 'Carry', totalDistance: 'Total', offlineDistance: 'From Centre',
        peakHeight: 'Height', hangTime: 'Hang Time'
      },
      preamble: 'Toptracer Range - Distance To Pin / Curve session'
    },
    uneekor: {
      label: 'Uneekor',
      fields: ['club', 'ballSpeed', 'clubSpeed', 'launchAngle', 'startDirection', 'spin', 'spinAxis',
        'faceAngle', 'pathAngle', 'dynamicLoft', 'dynamicLie', 'attackAngle',
        'carryDistance', 'totalDistance', 'offlineDistance', 'peakHeight', 'hangTime'],
      headers: {
        club: 'Club', ballSpeed: 'Ball Speed', clubSpeed: 'Club Speed', launchAngle: 'Launch Angle',
        startDirection: 'Side Angle', spin: 'Back Spin', spinAxis: 'Side Spin',
        faceAngle: 'Face Angle', pathAngle: 'Club Path', dynamicLoft: 'Loft Angle',
        dynamicLie: 'Lie Angle', attackAngle: 'Attack Angle', carryDistance: 'Carry',
        totalDistance: 'Total', offlineDistance: 'Side Distance', peakHeight: 'Apex',
        hangTime: 'Flight Time'
      },
      preamble: 'Uneekor EYE XO - session export'
    },
    fullswing: {
      label: 'Full Swing',
      fields: ['club', 'ballSpeed', 'clubSpeed', 'launchAngle', 'startDirection', 'spin', 'spinAxis',
        'faceAngle', 'pathAngle', 'carryDistance', 'totalDistance', 'offlineDistance', 'peakHeight'],
      headers: {
        club: 'Club', ballSpeed: 'Ball Speed', clubSpeed: 'Club Speed', launchAngle: 'Launch Angle',
        startDirection: 'Side Angle', spin: 'Spin', spinAxis: 'Spin Axis', faceAngle: 'Face Angle',
        pathAngle: 'Club Path', carryDistance: 'Carry', totalDistance: 'Total',
        offlineDistance: 'Offline', peakHeight: 'Apex'
      },
      preamble: 'Full Swing KIT - session export'
    },
    rapsodo: {
      label: 'Rapsodo MLM',
      fields: ['club', 'ballSpeed', 'clubSpeed', 'launchAngle', 'startDirection', 'spin',
        'carryDistance', 'totalDistance', 'offlineDistance', 'peakHeight', 'descentAngle'],
      headers: {
        club: 'Club', ballSpeed: 'Ball Speed', clubSpeed: 'Club Speed', launchAngle: 'Launch Angle',
        startDirection: 'Launch Direction', spin: 'Spin Rate', carryDistance: 'Carry',
        totalDistance: 'Total', offlineDistance: 'Offline', peakHeight: 'Apex',
        descentAngle: 'Descent Angle'
      },
      preamble: 'Rapsodo MLM2PRO - Shot Vision export'
    },
    awesome_golf: {
      label: 'Awesome Golf',
      fields: ['club', 'ballSpeed', 'launchAngle', 'startDirection', 'spin', 'carryDistance',
        'totalDistance', 'offlineDistance', 'peakHeight'],
      headers: {
        club: 'Club', ballSpeed: 'Ball Speed', launchAngle: 'Launch Angle',
        startDirection: 'Side Angle', spin: 'Spin', carryDistance: 'Carry',
        totalDistance: 'Total', offlineDistance: 'Offline', peakHeight: 'Apex'
      },
      preamble: 'Awesome Golf Simulator - session export'
    }
  };

  var PROVIDER_KEYS = Object.keys(PROVIDER_EMIT);

  /* ---------------------------------------------------------------------
     Relationships

     `apply(shot, ctx)` mutates the ideal shot BEFORE scatter is added, so the
     planted relationship lives in the central progression and the noise sits
     on top of it - which is the order section 8 asks for.
     --------------------------------------------------------------------- */

  var STRENGTHS = { none: 0, low: 0.45, medium: 1, high: 1.8 };

  var RELATIONSHIPS = {
    none: {
      label: 'Control - no Micro-Geometry Signal',
      targetSignal: null,
      apply: function () {}
    },

    curvature_bias: {
      label: 'Stable curvature bias',
      targetSignal: 'curvature_bias',
      /* A consistent face-to-path, the spin axis that follows from it, and a
         finish position that agrees. All three, because the Signal's AND asks
         whether the finish agrees with the delivery. */
      apply: function (shot, ctx) {
        var deg = 2.6 * ctx.strength * ctx.direction;
        shot.faceToPath += deg;
        shot.faceAngle += deg * 0.6;
        shot.spinAxis += deg * 2.1;
        shot.offlineDistance += deg * 0.011 * shot.carryDistance;
      }
    },

    direction_progression: {
      label: 'Dynamic Lie and Start Direction progressing through the bag',
      targetSignal: 'direction_progression',
      /* Both halves progress together, which is the IF and the AND of the
         Signal. Position is 0 at the shortest club and 1 at the longest. */
      apply: function (shot, ctx) {
        var walk = (ctx.position - 0.5) * 2;
        shot.startDirection += 2.3 * ctx.strength * ctx.direction * walk;
        shot.dynamicLie += 1.8 * ctx.strength * ctx.direction * walk;
        shot.offlineDistance += 2.3 * ctx.strength * ctx.direction * walk * 0.012 * shot.carryDistance;
      }
    },

    launch_conversion: {
      label: 'Launch Angle above/below the normal Dynamic Loft relationship',
      targetSignal: 'launch_conversion',
      /* Change the SLOPE, not the level: the Signal reads launch per degree of
         delivered loft, so a flat offset would move nothing. */
      apply: function (shot, ctx) {
        var delta = 0.09 * ctx.strength * ctx.direction;
        shot.launchAngle += delta * shot.dynamicLoft;
        shot.descentAngle += delta * shot.dynamicLoft * 0.8;
      }
    },

    flight_exposure: {
      label: 'Peak Height above/below the normal spin relationship',
      targetSignal: 'flight_exposure',
      apply: function (shot, ctx) {
        var delta = 0.040 * ctx.strength * ctx.direction;
        shot.peakHeight += delta * shot.carryDistance;
        shot.descentAngle += delta * 40 * ctx.direction;
        if (shot.hangTime) shot.hangTime += delta * 4;
      }
    },

    rollout_character: {
      label: 'Carry : Total progressing through the bag',
      targetSignal: 'rollout_character',
      /* On top of the normal rollout slope, not instead of it - the Signal
         measures the departure from normal, so replacing the normal slope
         would leave nothing to detect. */
      apply: function (shot, ctx) {
        var extra = 0.055 * ctx.strength * ctx.direction * (ctx.position - 0.5) * 2;
        shot.totalDistance = shot.carryDistance * (shot.rolloutRatio + extra);
      }
    }
  };

  /* ---------------------------------------------------------------------
     Generation
     --------------------------------------------------------------------- */

  function idealShot(entry, ladder, cfg) {
    var rolloutRatio = ROLLOUT_BASE_RATIO + (cfg.normals.rolloutSlopePer100m / 100) * (entry.carryM - ladder[0].carryM);
    var launch = cfg.normals.launchToLoftSlope * entry.dynamicLoft + LAUNCH_INTERCEPT;
    var peakRatio = cfg.normals.peakToCarryRatio
      + cfg.normals.peakPerSpinUnit * (entry.spin / cfg.normals.referenceSpinRpm - 1);
    return {
      club: entry.club,
      carryDistance: entry.carryM,
      rolloutRatio: rolloutRatio,
      totalDistance: entry.carryM * rolloutRatio,
      offlineDistance: 0,
      ballSpeed: 55 + entry.carryM * 0.29,
      clubSpeed: 33 + entry.carryM * 0.155,
      faceAngle: 0,
      pathAngle: 0,
      faceToPath: 0,
      spinAxis: 0,
      dynamicLoft: entry.dynamicLoft,
      dynamicLie: 0,
      launchAngle: launch,
      startDirection: 0,
      spin: entry.spin,
      peakHeight: peakRatio * entry.carryM,
      attackAngle: entry.attackAngle,
      descentAngle: entry.descentAngle,
      hangTime: 2.4 + peakRatio * entry.carryM * 0.11
    };
  }

  /* Shot-to-shot variation. Scaled per metric so the set still passes the
     Bubble's own eligibility window - a scatter wide enough to be thrown out
     as garbage is not a test of anything. */
  function addScatter(shot, rng, dispersion) {
    var d = Number(dispersion) > 0 ? Number(dispersion) : 1;
    /* Total follows carry through the ratio the relationship set. Scattering
       the two independently would put noise into carry:total itself, which is
       the exact quantity the Rollout Character Signal reads - the generator
       would then be adding the thing it is meant to be planting. */
    var ratio = shot.carryDistance > 0 ? shot.totalDistance / shot.carryDistance : 1;
    shot.carryDistance += rng.jitter(shot.carryDistance * 0.022 * d);
    shot.totalDistance = shot.carryDistance * (ratio + rng.jitter(0.006 * d));
    shot.offlineDistance += rng.jitter(shot.carryDistance * 0.035 * d);
    shot.ballSpeed += rng.jitter(1.4 * d);
    shot.clubSpeed += rng.jitter(0.9 * d);
    shot.faceAngle += rng.jitter(1.1 * d);
    shot.pathAngle += rng.jitter(1.3 * d);
    shot.faceToPath += rng.jitter(0.9 * d);
    shot.spinAxis += rng.jitter(2.2 * d);
    /* Kept tighter than the other delivery numbers on purpose. Dynamic loft is
       the X of the Launch Conversion fit, and noise on an X attenuates the
       fitted slope (regression dilution) - so an unrealistically noisy loft
       column quietly shrinks the very relationship this generator is planting.
       0.6 deg is also about what a camera-based monitor really resolves. */
    shot.dynamicLoft += rng.jitter(0.6 * d);
    shot.dynamicLie += rng.jitter(0.7 * d);
    shot.launchAngle += rng.jitter(0.8 * d);
    shot.startDirection += rng.jitter(0.9 * d);
    shot.spin += rng.jitter(shot.spin * 0.055 * d);
    shot.peakHeight += rng.jitter(shot.peakHeight * 0.05 * d);
    shot.attackAngle += rng.jitter(0.7 * d);
    shot.descentAngle += rng.jitter(1.1 * d);
    shot.hangTime += rng.jitter(0.09 * d);
    return shot;
  }

  /* The Bubble's own front door, in the terms scripts/gd-launch-monitor-data.js
     states them. Read from that module when it is loaded so there is one
     authority at runtime; the literals are the fallback for node, and are the
     module's own DEFAULTS. */
  function eligibilityBounds() {
    try {
      var lm = (typeof window !== 'undefined')
        && (window.GolfDaddyLaunchMonitorData || window.ClarityCaddieLaunchMonitorData);
      var cfg = lm && typeof lm.settings === 'function' ? lm.settings() : null;
      if (cfg) {
        return {
          minCarryM: cfg.minCarryM, maxCarryM: cfg.maxCarryM,
          maxAbsOfflineM: cfg.maxAbsOfflineM, viableDegreeAbs: cfg.viableDegreeAbs
        };
      }
    } catch (error) { /* node, or the module is not loaded - use the fallback */ }
    return { minCarryM: 20, maxCarryM: 330, maxAbsOfflineM: 70, viableDegreeAbs: 8 };
  }

  function checkEligibility(rows) {
    var bounds = eligibilityBounds();
    var failures = [];
    rows.forEach(function (row) {
      var carry = Number(row.carryDistance);
      var offline = Number(row.offlineDistance);
      if (!(carry >= bounds.minCarryM && carry <= bounds.maxCarryM)) failures.push({ shot: row.shotNumber, why: 'carry_out_of_window' });
      if (Math.abs(offline) > bounds.maxAbsOfflineM) failures.push({ shot: row.shotNumber, why: 'offline_out_of_window' });
      var deg = carry > 0 ? Math.atan2(offline, carry) * 180 / Math.PI : 0;
      if (Math.abs(deg) > bounds.viableDegreeAbs) failures.push({ shot: row.shotNumber, why: 'angle_outside_viable' });
    });
    return { bounds: bounds, eligible: failures.length === 0, failures: failures.slice(0, 12), failureCount: failures.length };
  }

  function fieldValue(shot, field) {
    switch (field) {
      case 'club': return shot.club;
      case 'carryDistance': return round1(shot.carryDistance);
      case 'totalDistance': return round1(shot.totalDistance);
      case 'offlineDistance': return round1(shot.offlineDistance);
      case 'ballSpeed': return round1(shot.ballSpeed);
      case 'clubSpeed': return round1(shot.clubSpeed);
      case 'faceAngle': return round2(shot.faceAngle);
      case 'pathAngle': return round2(shot.pathAngle);
      case 'faceToPath': return round2(shot.faceToPath);
      case 'spinAxis': return round2(shot.spinAxis);
      case 'dynamicLoft': return round2(shot.dynamicLoft);
      case 'dynamicLie': return round2(shot.dynamicLie);
      case 'launchAngle': return round2(shot.launchAngle);
      case 'startDirection': return round2(shot.startDirection);
      case 'spin': return Math.round(shot.spin);
      case 'peakHeight': return round1(shot.peakHeight);
      case 'attackAngle': return round2(shot.attackAngle);
      case 'descentAngle': return round2(shot.descentAngle);
      case 'hangTime': return round2(shot.hangTime);
      default: return '';
    }
  }

  function round1(value) { return Math.round(Number(value) * 10) / 10; }
  function round2(value) { return Math.round(Number(value) * 100) / 100; }

  /* Clarity-native practice rows: the same field names
     gd-practice-parser-core.js normalises to, so these can be handed straight
     to the parser, the gate, the library adapter or the Signal engine. */
  function toNativeRows(shots, emit, providerKey, sessionId, batchId) {
    var allowed = {};
    emit.fields.forEach(function (field) { allowed[field] = true; });
    return shots.map(function (shot, index) {
      var row = {
        shotId: 'gen-' + batchId + '-' + (index + 1),
        sessionId: sessionId,
        importBatchId: batchId,
        club: shot.club,
        shotNumber: index + 1,
        sourceType: 'generated',
        providerGuess: providerKey,
        schemaVersion: signalsCore.MODEL_VERSION
      };
      ALL_FIELDS.forEach(function (field) {
        if (field === 'club') return;
        /* A monitor that does not measure a metric must report NOTHING, not a
           zero. The Signal engine gates on presence, so a fabricated zero
           would be read as a measurement of "dead straight". */
        row[field] = allowed[field] ? fieldValue(shot, field) : null;
      });
      row.side = Number(row.offlineDistance) < 0 ? 'left' : Number(row.offlineDistance) > 0 ? 'right' : '';
      return row;
    });
  }

  /* Provider-flavoured text, so the generated set can also be driven through
     the real import lane (paste/CSV) rather than only handed to the engine as
     objects. Units are declared in the header because the parser refuses to
     infer them from magnitude, and rightly so. */
  function toProviderText(shots, emit) {
    var columns = emit.fields;
    var header = columns.map(function (field) {
      var label = emit.headers[field] || field;
      if (field === 'carryDistance' || field === 'totalDistance' || field === 'offlineDistance') return label + ' (m)';
      if (field === 'peakHeight') return label + ' (m)';
      if (field === 'ballSpeed' || field === 'clubSpeed') return label + ' (mph)';
      if (field === 'spin') return label + ' (rpm)';
      if (field === 'hangTime') return label + ' (sec)';
      return label;
    }).join(',');
    var lines = shots.map(function (shot) {
      return columns.map(function (field) { return fieldValue(shot, field); }).join(',');
    });
    return [emit.preamble, header].concat(lines).join('\n');
  }

  /* Confirms the fingerprinter that already exists agrees with the provider we
     said we were emitting. Returns null in node, where the module is not
     loaded - the check belongs to the browser/Studio path. */
  function verifyProviderText(text, providerKey) {
    try {
      var lm = (typeof window !== 'undefined')
        && (window.GolfDaddyLaunchMonitorData || window.ClarityCaddieLaunchMonitorData);
      if (!lm || typeof lm.identifyProviderFromText !== 'function') return null;
      var identified = lm.identifyProviderFromText(text);
      return {
        expected: providerKey,
        identified: identified.providerGuess,
        confidence: identified.confidence,
        agrees: identified.providerGuess === providerKey
      };
    } catch (error) { return null; }
  }

  /* ---------------------------------------------------------------------
     Public generate()
     --------------------------------------------------------------------- */

  function normaliseSpec(spec) {
    spec = spec || {};
    var relationshipId = RELATIONSHIPS[spec.relationship] ? spec.relationship : 'none';
    var provider = PROVIDER_EMIT[spec.provider] ? spec.provider : 'trackman';
    var strength = typeof spec.strength === 'number'
      ? spec.strength
      : (STRENGTHS[spec.strength] === undefined ? STRENGTHS.medium : STRENGTHS[spec.strength]);
    return {
      seed: Number.isFinite(Number(spec.seed)) ? Math.floor(Number(spec.seed)) : null,
      provider: provider,
      shots: Math.max(1, Math.min(500, Math.floor(Number(spec.shots) || 30))),
      clubs: Math.max(1, Math.min(CLUB_LADDER.length, Math.floor(Number(spec.clubs) || 5))),
      relationship: relationshipId,
      strength: strength,
      strengthLabel: typeof spec.strength === 'string' ? spec.strength : (spec.strength === undefined ? 'medium' : String(spec.strength)),
      direction: Number(spec.direction) < 0 ? -1 : 1,
      dispersion: Number(spec.dispersion) > 0 ? Number(spec.dispersion) : 1,
      config: spec.config || null
    };
  }

  function generate(spec) {
    var request = normaliseSpec(spec);
    var seed = request.seed === null ? Math.floor(Math.random() * 0x7fffffff) : request.seed;
    request.seed = seed;
    var rng = makeRng(seed);
    var cfg = signalsCore.resolveConfig(request.config);
    var ladder = ladderFor(request.clubs);
    var relationship = RELATIONSHIPS[request.relationship];

    var sessionId = 'gen-session-' + seed.toString(36);
    var batchId = 'gen-batch-' + seed.toString(36);
    var emit = PROVIDER_EMIT[request.provider];

    var shots = [];
    for (var i = 0; i < request.shots; i++) {
      /* Round-robin the ladder rather than randomising which club is hit, so
         a 30-shot 5-club request really is 6 shots of each. An uneven club
         count is the fastest way to fake a progression that is not there. */
      var entry = ladder[i % ladder.length];
      var shot = idealShot(entry, ladder, cfg);
      relationship.apply(shot, {
        strength: request.strength,
        direction: request.direction,
        position: bagPosition(ladder, entry),
        club: entry
      });
      shots.push(addScatter(shot, rng, request.dispersion));
    }

    var rows = toNativeRows(shots, emit, request.provider, sessionId, batchId);
    var text = toProviderText(shots, emit);
    var eligibility = checkEligibility(rows);

    return {
      spec: request,
      seed: seed,
      provider: { key: request.provider, label: emit.label, fields: emit.fields.slice() },
      relationship: { id: request.relationship, label: relationship.label, targetSignal: relationship.targetSignal },
      sessionId: sessionId,
      importBatchId: batchId,
      rows: rows,
      text: text,
      eligibility: eligibility,
      providerText: verifyProviderText(text, request.provider)
    };
  }

  /* Puts a generated set back through the real detector. This is the last step
     of section 8's flow - "confirm requested Signal remains detectable" - and
     it is deliberately the same detectSignals() the server runs, not a
     shortcut that would let the generator mark its own homework. */
  function verify(generated, config) {
    var cfg = signalsCore.resolveConfig(config);
    /* Detection is asked for with the engine and the target Signal ON,
       whatever the shipped config says, because the question here is "is the
       evidence in the data", not "is this Signal switched on in production". */
    var probe = signalsCore.resolveConfig(Object.assign({}, cfg, {
      enabled: true,
      signals: Object.keys(cfg.signals).reduce(function (out, id) {
        out[id] = Object.assign({}, cfg.signals[id], { enabled: true });
        return out;
      }, {})
    }));
    var detected = signalsCore.detectSignals(generated.rows, probe);
    var target = generated.relationship.targetSignal;
    var targetRecord = target ? detected.filter(function (r) { return r.id === target; })[0] || null : null;
    var others = detected.filter(function (r) { return r.fired && r.id !== target; });
    return {
      detected: detected,
      geometry: signalsCore.buildMicroGeometry(detected, probe),
      target: target,
      targetFired: !!(targetRecord && targetRecord.fired),
      targetRecord: targetRecord,
      unexpectedSignals: others.map(function (r) { return r.id; }),
      /* Control's contract: nothing fires, so Base and Adjusted are the same
         bubble. Anything else is a bug in the generator or the detector. */
      controlClean: target === null ? detected.every(function (r) { return !r.fired; }) : null
    };
  }

  function generateAndVerify(spec) {
    var generated = generate(spec);
    generated.detection = verify(generated, spec && spec.config);
    return generated;
  }

  /* ---------------------------------------------------------------------
     Pre-loaded scenarios (section 9)
     --------------------------------------------------------------------- */

  var SCENARIOS = [
    {
      id: 'curvature-bias', label: 'Curvature Bias',
      description: 'Stable Face-to-Path with the Spin Axis and finish position that follow from it.',
      spec: { relationship: 'curvature_bias', provider: 'trackman', shots: 24, clubs: 4, strength: 'medium', seed: 20260815 }
    },
    {
      id: 'curvature-bias-ball-only', label: 'Curvature Bias (GCQuad ball data)',
      description: '20 GCQuad ball-data shots - Spin Axis route, no Face-to-Path column at all. Normal Bubble-valid dispersion.',
      spec: { relationship: 'curvature_bias', provider: 'foresight', shots: 20, clubs: 4, strength: 'medium', seed: 20260816 }
    },
    {
      id: 'direction-progression', label: 'Direction Progression',
      description: 'Dynamic Lie and Start Direction progressing together through the longer clubs.',
      spec: { relationship: 'direction_progression', provider: 'trackman', shots: 30, clubs: 5, strength: 'medium', seed: 20260817 }
    },
    {
      id: 'launch-conversion', label: 'Launch Conversion',
      description: 'Launch Angle sitting above the normal Dynamic Loft relationship.',
      spec: { relationship: 'launch_conversion', provider: 'foresight', shots: 30, clubs: 5, strength: 'medium', seed: 20260818 }
    },
    {
      id: 'flight-exposure', label: 'Flight Exposure',
      description: 'Peak Height above what the spin generated would normally produce.',
      spec: { relationship: 'flight_exposure', provider: 'foresight', shots: 30, clubs: 5, strength: 'medium', seed: 20260819 }
    },
    {
      id: 'rollout-character', label: 'Rollout Character',
      description: 'Carry : Total ratio climbing through the longer clubs faster than a normal bag.',
      spec: { relationship: 'rollout_character', provider: 'trackman', shots: 40, clubs: 6, strength: 'medium', seed: 20260820 }
    },
    {
      id: 'control', label: 'Control',
      description: 'Bubble-valid data with no Micro-Geometry Signal. Base and Adjusted Bubble must be identical.',
      spec: { relationship: 'none', provider: 'trackman', shots: 40, clubs: 6, strength: 'none', seed: 20260821 }
    }
  ];

  function scenario(id, overrides) {
    var found = SCENARIOS.filter(function (item) { return item.id === id; })[0];
    if (!found) return null;
    return generateAndVerify(Object.assign({}, found.spec, overrides || {}));
  }

  return {
    CLUB_LADDER: CLUB_LADDER,
    PROVIDER_EMIT: PROVIDER_EMIT,
    PROVIDER_KEYS: PROVIDER_KEYS,
    ALL_FIELDS: ALL_FIELDS,
    RELATIONSHIPS: RELATIONSHIPS,
    STRENGTHS: STRENGTHS,
    SCENARIOS: SCENARIOS,
    seedRandom: seedRandom,
    ladderFor: ladderFor,
    eligibilityBounds: eligibilityBounds,
    checkEligibility: checkEligibility,
    toProviderText: toProviderText,
    verifyProviderText: verifyProviderText,
    generate: generate,
    verify: verify,
    generateAndVerify: generateAndVerify,
    scenario: scenario
  };
});
