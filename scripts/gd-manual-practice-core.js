/* Manual Practice -> canonical Practice evidence.
 *
 * THE Manual Practice seam. A plotted observation is structured data already,
 * so it does not go near the CSV parser; this file is the one place a manual
 * observation becomes the same clubGroup shape every other practice importer
 * hands to gd-launch-monitor-data's importCapture(). Everything after that
 * point - gating, clustering, the recommendation, the Practice Bubble, My
 * Bubble adoption, Bag/GPS - is the canonical pipeline's job, not this file's.
 *
 * What this file must NOT do (it used to do all three):
 *   - cluster shots, score evidence or produce a recommendation. That was a
 *     second analysis pipeline imitating the Practice contract.
 *   - invent measurements. A plotted dot knows a carry and an offline and
 *     nothing else. No ball speed, spin, face angle, club path or launch
 *     direction is fabricated, so no quality gate downstream is ever fed a
 *     number nobody observed.
 *   - decide who a session belongs to. Ownership is the store's job
 *     (gd-manual-practice-data.js) and it fails closed without a player.
 *
 * Dependency-injected rather than reaching for globals, so the whole seam runs
 * headlessly in dev/manual-practice-core.test.js:
 *   deps.clubBaselineM(club)                      - gdClarityClubBaselineM
 *   deps.generatedBubbleForClub(club, carryM, 0)  - gdGeneratedShotBubbleForClub
 *   deps.metricForKey(key, value)                 - gdLmMetricForKey
 */
(function (rootFactory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = rootFactory();
  } else {
    var api = rootFactory();
    if (typeof window !== 'undefined') {
      window.GolfDaddyManualPracticeCore = api;
      window.ClarityCaddieManualPracticeCore = api;
      window.GolfDaddy = window.GolfDaddy || {};
      window.GolfDaddy.modules = window.GolfDaddy.modules || {};
      window.GolfDaddy.modules.manualPracticeCore = api;
    }
  }
})(function () {
  'use strict';

  /* Bumped when the plot -> metres rule changes. It is stamped on every
     observation's provenance so a historical manual session can always be read
     back against the rule that produced it, instead of being silently
     reinterpreted by whatever the current bubble-generation rules say. */
  var CALIBRATION_VERSION = 'manual-plot-v1';

  /* The inputType the Shot Library must count as practice evidence. An
     unlisted type imports fine and then never appears on the Practice Data
     screen, which reads to the user exactly like a failed import.
     dev/manual-practice-core.test.js holds this file and captureDisplayLane()
     in gd-launch-monitor-data.js to the same value. */
  var INPUT_TYPE = 'manual-practice';

  var SOURCE_MANUAL = 'manual_practice';
  var SOURCE_OVERRIDE = 'coach_manual_override';

  /* Both classifications are kept as evidence. The difference is only whether
     the shot is allowed to move the primary pattern - carried across the
     boundary as excludeFromPrimaryPattern, which the library honours for every
     source, not just this one. */
  var REPRESENTATIVE = 'representative';
  var DISRUPTED = 'disrupted';

  /* The per-club lane in the library's result-scaled cluster method (the same
     lane the generated-demo rows use). Without it every club is pooled into one
     oval, and the cross-club replication Manual Practice is built around could
     never be shown. */
  var PRIMARY_LANE = 'cluster_hunt';
  var DISRUPTED_LANE = 'manual_disrupted';

  /* Last-resort plot scale, used only when the app cannot generate a bubble for
     the club. Same numbers the module has always used - this pass makes the
     rule explicit and versionable, it does not retune it. */
  var FALLBACK = {
    carryM: 155,
    widthRatio: 0.16,
    depthRatio: 0.14,
    minSpanM: 12,
    minCarryM: 30,
    minHalfSpanM: 4
  };

  /* Mirrors gd-launch-monitor-alias-registry.js for the only two metrics a
     plotted dot can honestly claim. Used when no metricForKey is injected (the
     browser injects gdLmMetricForKey). dev/manual-practice-core.test.js holds
     these to the registry so the two cannot drift. */
  var METRIC_FALLBACK = {
    carry: { rawLabel: 'Carry', candidateMetric: 'carryDistance', unit: 'm', confidence: 0.72 },
    offline: { rawLabel: 'Offline', candidateMetric: 'offline', unit: 'm', confidence: 0.7 }
  };

  function asNumber(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function cleanString(value, fallback) {
    var text = String(value == null ? '' : value).trim();
    return text || String(fallback == null ? '' : fallback).trim();
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function round(value, decimals) {
    var factor = Math.pow(10, decimals || 0);
    return Math.round(asNumber(value, 0) * factor) / factor;
  }

  function classificationOf(observation) {
    return cleanString(observation && observation.classification, REPRESENTATIVE).toLowerCase() === DISRUPTED
      ? DISRUPTED
      : REPRESENTATIVE;
  }

  // === Plot calibration =====================================================
  //
  // The plotting surface is normalised: x and y run -1..1 with the target at
  // the centre, top long and right right. Turning that into metres needs three
  // numbers and a record of where they came from.

  function resolveManualPracticePlotCalibration(club, deps) {
    deps = deps || {};
    var label = cleanString(club, '7i');

    /* The bag distance, resolved by the same function every other importer
       uses for expectedDistanceM. A rival baseline here would put manual shots
       on a different denominator from the imported ones. */
    var carrySource = 'club_baseline';
    var carryM = NaN;
    if (typeof deps.clubBaselineM === 'function') {
      try {
        carryM = asNumber(deps.clubBaselineM(label), NaN);
      } catch (error) {
        carryM = NaN;
      }
    }
    if (!Number.isFinite(carryM) || carryM <= 0) {
      carryM = FALLBACK.carryM;
      carrySource = 'fallback_carry';
    }
    carryM = Math.max(FALLBACK.minCarryM, carryM);

    var generated = null;
    if (typeof deps.generatedBubbleForClub === 'function') {
      try {
        generated = deps.generatedBubbleForClub(label, carryM, 0) || null;
      } catch (error) {
        generated = null;
      }
    }
    var widthM = generated ? asNumber(generated.widthM || generated.bubbleWidthM || generated.clusterWidthM, NaN) : NaN;
    var depthM = generated ? asNumber(generated.depthM || generated.bubbleDepthM || generated.clusterDepthM, NaN) : NaN;
    var spanSource = 'generated_bubble';
    if (!Number.isFinite(widthM) || widthM <= 0 || !Number.isFinite(depthM) || depthM <= 0) {
      widthM = Math.max(FALLBACK.minSpanM, carryM * FALLBACK.widthRatio);
      depthM = Math.max(FALLBACK.minSpanM, carryM * FALLBACK.depthRatio);
      spanSource = 'carry_ratio';
    }

    return {
      club: label,
      expectedCarryM: round(carryM, 1),
      lateralHalfSpanM: round(Math.max(FALLBACK.minHalfSpanM, widthM / 2), 2),
      depthHalfSpanM: round(Math.max(FALLBACK.minHalfSpanM, depthM / 2), 2),
      calibrationSource: carrySource + '+' + spanSource,
      calibrationVersion: CALIBRATION_VERSION
    };
  }

  /* One calibration per club, resolved once per session so every observation of
     a club is converted on exactly the same scale. */
  function calibrationTableFor(session, deps) {
    var table = {};
    (session && Array.isArray(session.observations) ? session.observations : []).forEach(function (observation) {
      var club = cleanString(observation && (observation.clubId || observation.club), '7i');
      if (!table[club]) table[club] = resolveManualPracticePlotCalibration(club, deps);
    });
    return table;
  }

  // === Observation -> canonical evidence ====================================

  function buildMetric(key, value, deps) {
    if (deps && typeof deps.metricForKey === 'function') {
      var metric = deps.metricForKey(key, value);
      if (metric) return metric;
    }
    var config = METRIC_FALLBACK[key];
    if (!config) return null;
    return {
      rawLabel: config.rawLabel,
      candidateMetric: config.candidateMetric,
      rawValue: String(value),
      value: Number(value),
      unit: config.unit,
      confidence: config.confidence
    };
  }

  /* One plotted observation -> one Shot Library clubGroup.
   *
   * carry and offline are the only two measurements, and both are computed, not
   * guessed: offline is the plotted x across the club's lateral half-span, and
   * carry is the bag baseline plus the plotted y across the depth half-span.
   * expectedDistanceM stays the BAG BASELINE (never the shot's own carry), so
   * depth reads as carry-minus-bag exactly like an imported shot.
   */
  function manualObservationToEvidence(observation, session, calibration, deps) {
    observation = observation || {};
    session = session || {};
    var club = cleanString(observation.clubId || observation.club, calibration && calibration.club || '7i');
    var cal = calibration || resolveManualPracticePlotCalibration(club, deps);
    var x = clamp(asNumber(observation.x, 0), -1, 1);
    var y = clamp(asNumber(observation.y, 0), -1, 1);
    var lateralM = round(x * cal.lateralHalfSpanM, 2);
    var depthM = round(y * cal.depthHalfSpanM, 2);
    var carryM = round(cal.expectedCarryM + depthM, 2);
    var classification = classificationOf(observation);
    var representative = classification === REPRESENTATIVE;
    var source = cleanString(observation.source || session.source, SOURCE_MANUAL);
    var timestamp = observation.updatedAt || observation.createdAt || session.updatedAt || session.createdAt || new Date().toISOString();

    var metrics = [buildMetric('carry', carryM, deps), buildMetric('offline', lateralM, deps)].filter(Boolean);

    return {
      shotId: 'manual-' + cleanString(observation.observationId, 'observation'),
      originClubLabel: club,
      candidateClub: club,
      expectedDistanceM: cal.expectedCarryM,
      timestamp: timestamp,
      /* Player scope rides on the group; the library's resolvePlayerScope reads
         it off here rather than falling back to whoever is logged in. */
      playerId: cleanString(session.playerId, ''),
      playerName: cleanString(session.playerName, 'Player'),
      accountId: cleanString(session.accountId, ''),
      source: source,
      analysisLane: representative ? PRIMARY_LANE : DISRUPTED_LANE,
      sourceMethod: representative ? PRIMARY_LANE : DISRUPTED_LANE,
      /* Disrupted shots are evidence and are kept, stored, synced and plotted -
         they just must not move the primary pattern. The library honours this
         flag for any source, so no Manual-Practice conditional is needed
         downstream. */
      excludeFromPrimaryPattern: !representative,
      provenance: {
        source: source,
        manualPractice: true,
        classification: classification,
        observationId: cleanString(observation.observationId, ''),
        sessionId: cleanString(session.sessionId, ''),
        plot: { x: round(x, 4), y: round(y, 4) },
        calibration: {
          expectedCarryM: cal.expectedCarryM,
          lateralHalfSpanM: cal.lateralHalfSpanM,
          depthHalfSpanM: cal.depthHalfSpanM,
          calibrationSource: cal.calibrationSource,
          calibrationVersion: cal.calibrationVersion
        },
        geometryPresetId: session.geometryPresetId == null ? null : session.geometryPresetId
      },
      metrics: metrics
    };
  }

  /* A finished session -> the payload importCapture() takes. Same shape the
     CSV, photo, email and file routes produce; only the inputType and the
     provenance differ. */
  function manualSessionToLibraryPayload(session, options) {
    options = options || {};
    var deps = options.deps || options;
    session = session || {};
    var calibrations = calibrationTableFor(session, deps);
    var observations = Array.isArray(session.observations) ? session.observations : [];
    var timestamp = options.timestamp || session.completedAt || session.updatedAt || new Date().toISOString();
    var clubGroups = observations.map(function (observation) {
      var club = cleanString(observation && (observation.clubId || observation.club), '7i');
      return manualObservationToEvidence(observation, session, calibrations[club], deps);
    });
    return {
      label: cleanString(options.label, 'Manual Practice session'),
      inputType: INPUT_TYPE,
      timestamp: timestamp,
      startedAt: session.createdAt || timestamp,
      sessionDate: options.sessionDate || null,
      /* Never a launch monitor. Naming one here would attribute hand-plotted
         dots to a device that was never in the room. */
      sourceIdentity: {
        providerGuess: SOURCE_MANUAL,
        confidence: 1,
        evidence: ['Manual Practice plot']
      },
      rawTextBlocks: [],
      calibrations: calibrations,
      clubGroups: clubGroups
    };
  }

  // === Trusted coach override ===============================================
  //
  // The override is a coach restating the anchor, not a second analysis. It
  // takes the canonical analysis and replaces the anchor and the
  // recommendation; cluster membership, shot counts, spreads and the bubble's
  // shape all still come from the evidence the pipeline gated and clustered.

  function applyTrustedOverrideToAnalysis(analysis, override) {
    if (!analysis || !override) return analysis;
    var offsetDeg = asNumber(override.offsetDeg, NaN);
    if (!Number.isFinite(offsetDeg)) return analysis;
    var club = cleanString(override.club || override.clubId, '');
    var method = (analysis.methods && analysis.methods.resultScaledCluster) || {};
    var next = Object.assign({}, analysis);
    next.methods = Object.assign({}, analysis.methods, {
      resultScaledCluster: Object.assign({}, method, {
        method: 'result_scaled_cluster',
        source: SOURCE_OVERRIDE,
        status: 'manual_override',
        anchorDeg: round(offsetDeg, 2),
        anchorClub: club || method.anchorClub || '',
        showToUser: true
      })
    });
    next.recommendation = {
      status: 'manual_override',
      offsetDeg: round(offsetDeg, 2),
      evidence: ['result_scaled_cluster', SOURCE_OVERRIDE],
      deltaDeg: null,
      showToUser: true,
      source: SOURCE_OVERRIDE
    };
    next.userSignals = [next.methods.resultScaledCluster, next.recommendation];
    next.override = {
      source: SOURCE_OVERRIDE,
      offsetDeg: round(offsetDeg, 2),
      club: club,
      geometryPresetId: override.geometryPresetId == null ? null : override.geometryPresetId,
      createdAt: override.createdAt || '',
      createdBy: override.createdBy || ''
    };
    return next;
  }

  return {
    CALIBRATION_VERSION: CALIBRATION_VERSION,
    INPUT_TYPE: INPUT_TYPE,
    SOURCE_MANUAL: SOURCE_MANUAL,
    SOURCE_OVERRIDE: SOURCE_OVERRIDE,
    REPRESENTATIVE: REPRESENTATIVE,
    DISRUPTED: DISRUPTED,
    PRIMARY_LANE: PRIMARY_LANE,
    DISRUPTED_LANE: DISRUPTED_LANE,
    METRIC_FALLBACK: METRIC_FALLBACK,
    fallbacks: FALLBACK,
    classificationOf: classificationOf,
    resolveManualPracticePlotCalibration: resolveManualPracticePlotCalibration,
    calibrationTableFor: calibrationTableFor,
    manualObservationToEvidence: manualObservationToEvidence,
    manualSessionToLibraryPayload: manualSessionToLibraryPayload,
    applyTrustedOverrideToAnalysis: applyTrustedOverrideToAnalysis
  };
});
