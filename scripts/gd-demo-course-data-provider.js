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
 * Story: course shots share the practice bubble's center/orientation but are
 * modestly larger/noisier - real play introduces variation a range session
 * doesn't have.
 */
(function () {
  'use strict';

  var YARDS_TO_METERS = 0.9144;
  var COURSE_NOISE_MULTIPLIER = 1.7;
  var COURSE_DISTANCE_JITTER_PCT = 0.06;

  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }
  function nowIso() { return new Date().toISOString(); }
  function randId(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

  function jitter(spread) {
    var u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return spread * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function buildDemoCourseStore(demoSession) {
    var carryM = Number(demoSession && demoSession.sevenIronCarryM) || 150;
    var expectedYards = carryM / YARDS_TO_METERS;
    var centerDeg = Number(demoSession && demoSession.patternCenterDeg);
    var spreadDeg = Number(demoSession && demoSession.patternSpreadDeg);
    if (!Number.isFinite(centerDeg)) centerDeg = Number(demoSession && demoSession.adoptedBubble && demoSession.adoptedBubble.offsetDeg) || 0;
    if (!Number.isFinite(spreadDeg)) spreadDeg = 2.4;
    var courseSpreadDeg = spreadDeg * COURSE_NOISE_MULTIPLIER;

    var count = 10 + Math.floor(Math.random() * 6);
    var plannedShots = [];
    var ballEvents = [];
    var outcomes = [];

    for (var i = 0; i < count; i += 1) {
      var shotId = randId('demo-course-shot');
      var eventId = randId('demo-course-event');
      var angleDeg = centerDeg + jitter(courseSpreadDeg);
      var lateralYards = Math.tan(angleDeg * Math.PI / 180) * expectedYards;
      var distanceErrorYards = jitter(expectedYards * COURSE_DISTANCE_JITTER_PCT);

      plannedShots.push({
        shotId: shotId,
        club: '7i',
        expectedDistanceYards: expectedYards,
        plannedBubble: { widthYards: expectedYards * 0.14, lengthYards: expectedYards * 0.18 },
        createdAt: nowIso()
      });
      ballEvents.push({ eventId: eventId, timestamp: nowIso() });
      outcomes.push({
        outcomeId: randId('demo-course-outcome'),
        shotId: shotId,
        resultEventId: eventId,
        lateralErrorYards: lateralYards,
        distanceErrorYards: distanceErrorYards,
        insideBubble: Math.abs(angleDeg) <= 8,
        computedAt: nowIso(),
        pairedConfidence: 0.9,
        sourceConfidence: 'demo'
      });
    }

    return { plannedShots: plannedShots, ballEvents: ballEvents, outcomes: outcomes };
  }

  function analysis(demoSession, options) {
    var engine = window.GolfDaddyShotClusterAnalysis;
    if (!engine || typeof engine.analyzeStore !== 'function') return null;
    var store = buildDemoCourseStore(demoSession);
    return safe(function () { return engine.analyzeStore(store, options || {}); }, null);
  }

  window.GDDemoCourseDataProvider = { analysis: analysis, _buildDemoCourseStore: buildDemoCourseStore };
})();
