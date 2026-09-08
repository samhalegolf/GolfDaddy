/* Demo Course Data provider (read-side only).
 *
 * Builds synthetic on-course records and runs them through the REAL
 * GolfDaddyShotClusterAnalysis.analyzeStore(store, options) - the exact
 * function gdCurrentStatsAnalysis() calls for a real round - so every
 * derived number (bubble fit, cluster hunter, viability) is computed by the
 * real engine. The synthetic store is passed in memory; it is never written
 * to gd_shot_events_v1, and GolfDaddyCourseDataIntake.submitShotSnapshot is
 * never called, so the durable intake (gd_shot_snapshots_v1 /
 * gd_conditions_analyses_v1 / gd_my_bubble_versions_v1) stays untouched.
 *
 * Story: a round is messier than a range session, and it is played with the
 * whole bag rather than one club. So these records span several clubs, scatter
 * wider than the practice shots do, and only about one in four finishes inside
 * the plan - the point of the screen being that a bubble adopted on the range
 * has to survive a golf course.
 */
(function () {
  'use strict';

  var YARDS_TO_METERS = 0.9144;

  /* THE PLAN BUBBLE ON THIS SCREEN IS FIXED AT DEAD CENTRE.
   *
   * Course Data draws one bubble at 0.0 deviation and measures every stored
   * outcome against it (gd-route-audit.js: "NO CLUSTER FINDING ON THIS
   * SCREEN"). It is the preset 7-iron shape, and because both preset ratios
   * are ratios OF the carry, its half-axes come out the same for every club on
   * the chart: +-atan(0.148/2) = 4.23 degrees of lateral deviation, +-9.75% of
   * that club's own carry in distance. Building records in units of those radii
   * is what makes "three quarters of these miss the plan" a fact about the
   * drawn picture rather than a hope. */
  var IRON_WIDTH_RATIO = 0.148;
  var IRON_DEPTH_RATIO = 0.195;
  var BUBBLE_ANGLE_RADIUS_DEG = Math.atan(IRON_WIDTH_RATIO / 2) * 180 / Math.PI;
  var BUBBLE_DEPTH_RADIUS_PCT = IRON_DEPTH_RATIO / 2;

  /* A shot is dropped from the analysis, and drawn as a faint excluded dot, once
     it misses its target distance by more than clamp(expected * 0.18, 10, 35)
     metres (gd-shot-cluster-analysis.js normalizeRecord). Note the 35m cap: on a
     long club that window is a good deal tighter than 18%, so the band has to be
     worked out per club rather than assumed - see countedDepthLimitRadii. */
  function countedDepthLimitRadii(expectedM) {
    var windowM = clamp(expectedM * 0.18, 10, 35);
    return (windowM / Math.max(expectedM, 1)) / BUBBLE_DEPTH_RADIUS_PCT;
  }

  /* Only a fraction of the practice pattern survives adoption: the player took
     the bubble their range session proposed, so what is left on the course is
     the residual drift, not the original aim error. That residual is the whole
     reason to look at this screen after a round. */
  var COURSE_RESIDUAL_BIAS = 0.35;

  /* A quarter of the round finishes inside the plan. Lower than the practice
     side's core share on purpose - a course has lies, wind, nerves and targets
     a range does not. */
  var COURSE_CORE_SHARE = 0.26;

  /* Wider on both axes than the practice miss shapes, and with the round's own
     misses in it (long/short of the flag, the bail-out, the one that got away).
     Sides and depths pair off the same way the practice deck does. */
  var COURSE_MISS_SHAPES = [
    { id: 'push-right', side: 'right', depthBias: 'flat', angle: [1.5, 3.2], depth: [-0.7, 0.7] },
    { id: 'bail-right', side: 'right', depthBias: 'short', angle: [2.2, 4.1], depth: [-1.5, -0.3] },
    { id: 'long-right', side: 'right', depthBias: 'long', angle: [1.5, 3.0], depth: [1.05, 1.75] },
    { id: 'pull-left', side: 'left', depthBias: 'flat', angle: [-3.2, -1.5], depth: [-0.7, 0.7] },
    { id: 'hook-left', side: 'left', depthBias: 'flat', angle: [-4.3, -2.6], depth: [-0.8, 0.8] },
    { id: 'short-left', side: 'left', depthBias: 'short', angle: [-3.0, -1.5], depth: [-1.75, -1.05] },
    { id: 'came-up-short', side: 'centre', depthBias: 'short', angle: [-1.1, 1.1], depth: [-1.8, -1.05] },
    { id: 'flew-it', side: 'centre', depthBias: 'long', angle: [-1.1, 1.1], depth: [1.05, 1.8] }
  ];

  /* The one everybody has had: pushed past its club's counted window on purpose,
     so the screen also shows what an excluded shot looks like. One or two a
     round, never more, or the count the player reads stops matching the
     picture. */
  var BLOWN_SHOT_ANGLE = [-4.5, 4.5];

  /* Carries relative to a 7 iron, from the same stand-in bag the rest of the
     app scales (GD_DEFAULT_CLUB_CARRY_M). Approach clubs only: this screen is
     about shots played at a target, and a tee shot has no plan bubble. */
  var COURSE_CLUBS = [
    { club: '5i', ratio: 170 / 155 },
    { club: '6i', ratio: 160 / 155 },
    { club: '7i', ratio: 1 },
    { club: '8i', ratio: 142 / 155 },
    { club: '9i', ratio: 130 / 155 },
    { club: 'PW', ratio: 115 / 155 },
    { club: 'GW', ratio: 98 / 155 }
  ];

  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }
  function nowIso() { return new Date().toISOString(); }
  function randId(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

  function jitter(spread) {
    var u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return spread * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
  function between(range) { return range[0] + Math.random() * (range[1] - range[0]); }

  function shuffled(list) {
    var out = list.slice();
    for (var i = out.length - 1; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1));
      var swap = out[i];
      out[i] = out[j];
      out[j] = swap;
    }
    return out;
  }

  /* Same shape as the practice deck and for the same reason - one wing each
     way plus both centre misses, so the round's misses cannot all pile up on
     one side of a screen whose whole job is to show which way they went. */
  function missDeck() {
    var rights = COURSE_MISS_SHAPES.filter(function (shape) { return shape.side === 'right'; });
    var lefts = COURSE_MISS_SHAPES.filter(function (shape) { return shape.side === 'left'; });
    var centres = COURSE_MISS_SHAPES.filter(function (shape) { return shape.side === 'centre'; });
    var right = pick(rights);
    var balanced = lefts.filter(function (shape) { return shape.depthBias === 'flat' || shape.depthBias !== right.depthBias; });
    var left = pick(balanced.length ? balanced : lefts);
    return shuffled([right, left].concat(centres));
  }

  /* Four to six clubs, always including the 7 iron the practice bubble was
     measured on, so the screen can be read against Practice Data. */
  function roundClubs(sevenIronCarryM) {
    var others = shuffled(COURSE_CLUBS.filter(function (row) { return row.club !== '7i'; })).slice(0, 3 + Math.floor(Math.random() * 3));
    return [{ club: '7i', ratio: 1 }].concat(others).map(function (row) {
      return { club: row.club, expectedM: Math.round(sevenIronCarryM * row.ratio * 10) / 10 };
    });
  }

  function buildDemoCourseStore(demoSession) {
    var carryM = Number(demoSession && demoSession.sevenIronCarryM) || 150;
    var patternDeg = Number(demoSession && demoSession.patternCenterDeg);
    if (!Number.isFinite(patternDeg)) patternDeg = Number(demoSession && demoSession.adoptedBubble && demoSession.adoptedBubble.offsetDeg) || 0;
    var biasDeg = patternDeg * COURSE_RESIDUAL_BIAS;

    var clubs = roundClubs(carryM);
    var total = 20 + Math.floor(Math.random() * 11);
    var coreCount = Math.max(5, Math.ceil(total * COURSE_CORE_SHARE));
    var blownCount = 1 + Math.floor(Math.random() * 2);
    var deck = missDeck();

    var placed = [];
    var i;
    for (i = 0; i < total; i += 1) {
      if (i < coreCount) {
        placed.push({ kind: 'core', angleRadii: clamp(jitter(0.34), -0.72, 0.72), depthRadii: clamp(jitter(0.4), -0.8, 0.8) });
      } else if (i < coreCount + blownCount) {
        placed.push({ kind: 'blown', angleRadii: between(BLOWN_SHOT_ANGLE), depthRadii: Math.random() < 0.5 ? -1 : 1 });
      } else {
        var shape = deck[(i - coreCount - blownCount) % deck.length];
        placed.push({ kind: 'miss', angleRadii: between(shape.angle), depthRadii: between(shape.depth) });
      }
    }

    var plannedShots = [];
    var ballEvents = [];
    var outcomes = [];

    /* Shuffled so the round does not read as "every good shot, then every bad
       one" - the club a shot was played with is drawn per shot for the same
       reason, a round moves through the bag rather than down it. */
    shuffled(placed).forEach(function (spot, index) {
      /* Dealt round the chosen clubs rather than drawn at random for each shot:
         the shots are already shuffled, so this still mixes good and bad across
         the bag, and it cannot leave a club that was picked for the round with
         no shots played on it. */
      var clubRow = clubs[index % clubs.length];
      var expectedYards = clubRow.expectedM / YARDS_TO_METERS;
      var shotId = randId('demo-course-shot');
      var eventId = randId('demo-course-event');
      var limitRadii = countedDepthLimitRadii(clubRow.expectedM);
      var sign = spot.depthRadii < 0 ? -1 : 1;
      var depthRadii = spot.depthRadii;
      var angleRadii = spot.angleRadii;
      if (spot.kind === 'blown') {
        depthRadii = sign * (limitRadii + 0.5 + Math.random());
      } else if (Math.abs(depthRadii) > limitRadii - 0.1) {
        /* Held inside this club's counted window: a distance miss is meant to be
           outside the plan and still count, and only the blown shot above is
           meant to be set aside. */
        depthRadii = sign * Math.max(0, limitRadii - 0.1);
      }
      if (spot.kind === 'miss' && Math.abs(depthRadii) < 1.05 && Math.abs(angleRadii) < 1.5) {
        /* The clamp above took a long club's distance miss back inside the plan.
           It misses sideways instead rather than quietly becoming a good shot -
           a miss shape that lands in the bubble is a miss shape that lied. */
        angleRadii = (angleRadii < 0 ? -1 : 1) * (1.55 + Math.random() * 0.9);
      }
      var angleDeg = clamp(biasDeg + angleRadii * BUBBLE_ANGLE_RADIUS_DEG, -19, 19);
      var lateralYards = Math.tan(angleDeg * Math.PI / 180) * expectedYards;
      var distanceErrorYards = depthRadii * BUBBLE_DEPTH_RADIUS_PCT * expectedYards;
      var normalisedRadius = Math.sqrt(
        Math.pow(angleDeg / BUBBLE_ANGLE_RADIUS_DEG, 2) +
        Math.pow(depthRadii, 2)
      );

      plannedShots.push({
        shotId: shotId,
        club: clubRow.club,
        expectedDistanceYards: expectedYards,
        /* The plan the shot was played to: the same preset shape the chart
           draws, so presumed-vs-result bubble fit compares like with like. */
        plannedBubble: {
          widthYards: expectedYards * IRON_WIDTH_RATIO,
          lengthYards: expectedYards * IRON_DEPTH_RATIO
        },
        createdAt: nowIso()
      });
      ballEvents.push({ eventId: eventId, timestamp: nowIso() });
      outcomes.push({
        outcomeId: randId('demo-course-outcome'),
        shotId: shotId,
        resultEventId: eventId,
        lateralErrorYards: lateralYards,
        distanceErrorYards: distanceErrorYards,
        /* Answered by the same ellipse the chart draws, rather than by a
           separate rule of thumb - the headline count and the picture are
           supposed to be the same answer. */
        insideBubble: normalisedRadius <= 1,
        computedAt: nowIso(),
        pairedConfidence: 0.86 + Math.random() * 0.12,
        sourceConfidence: 'demo'
      });
    });

    return { plannedShots: plannedShots, ballEvents: ballEvents, outcomes: outcomes };
  }

  /* ONE ROUND PER DEMO, NOT ONE PER READER.
     Course Data asks for its analysis several times over a single render - the
     chart, the landing counts, the shot library, the admin list - and building a
     fresh random store for each of them put three different rounds on one
     screen: a 30-dot chart sitting above a "28 paired" count that had never seen
     those dots. The store is built once per demo session and re-analysed on
     every call, so the consistency slider still moves the numbers while the
     round underneath them holds still.

     In memory only, and keyed on the session it was built for: a new demo (or a
     different 7-iron carry) rebuilds, and nothing about a demo round is meant to
     outlive the tab. */
  var cachedStore = null;
  var cachedStoreKey = '';
  function storeKey(demoSession) {
    return [
      Number(demoSession && demoSession.sevenIronCarryM) || 0,
      Number(demoSession && demoSession.patternCenterDeg) || 0,
      Number(demoSession && demoSession.adoptedBubble && demoSession.adoptedBubble.offsetDeg) || 0
    ].join('|');
  }

  function store(demoSession) {
    var key = storeKey(demoSession);
    if (!cachedStore || cachedStoreKey !== key) {
      cachedStore = buildDemoCourseStore(demoSession);
      cachedStoreKey = key;
    }
    return cachedStore;
  }

  function analysis(demoSession, options) {
    var engine = window.GolfDaddyShotClusterAnalysis;
    if (!engine || typeof engine.analyzeStore !== 'function') return null;
    return safe(function () { return engine.analyzeStore(store(demoSession), options || {}); }, null);
  }

  /* store() is published for the same reason analysis() is: the Course Data
     screen counts plans and pairs straight off a store, and pointing that count
     at the durable one during a demo reads "0 plans, 0 pairs" beside a full
     round - the durable store being empty is the isolation guarantee working,
     not something to show the player. */
  window.GDDemoCourseDataProvider = { analysis: analysis, store: store, _buildDemoCourseStore: buildDemoCourseStore };
})();
