(function () {
  'use strict';

  /*
    Course Bubble / Comparison Layer.

    Sits between the Conditions Engine and anything that plots Course Data
    against My Bubble. It attaches each course record's active analysis and
    decides which position the comparison should use.

    Raw is never destroyed. Every enriched record keeps its original
    actualDistanceM / lateralM alongside the normalised values, and a record with
    no analysis, a failed analysis, or an analysis where normalisation was
    rejected simply compares raw — exactly as it did before this layer existed.

    This layer selects and labels. It does not re-derive normalisation, re-score
    Bubble fit, or interpret anything: the engine already decided whether
    normalising produced a more faithful comparison.

    Coordinate note: the engine's bubbleFit reports longitudinalError and
    lateralError in metres relative to the active bubble's centre, in the
    bubble's orientation frame — the same frame and sign convention that
    normalizeRecord in gd-shot-cluster-analysis.js uses to build depthM and
    lateralM. That is why the mapping below needs no conversion.
  */

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  var PREFERENCE_KEY = 'gd_course_data_comparison_v1';
  var DEFAULT_NORMALISATION_ENABLED = true;

  function intake() {
    return (root.modules && root.modules.courseDataIntake) || window.GolfDaddyCourseDataIntake;
  }

  function asNumber(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function storage() {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    } catch (e) { /* locked-down context */ }
    return null;
  }

  /*
    Whether the comparison uses normalised positions. Defaults on: normalisation
    is only ever applied when the engine's safeguards passed AND the Bubble fit
    materially improved, so the normalised comparison is the more faithful one by
    construction. Kept switchable so the behaviour can be reverted without a code
    change when diagnosing a suspect result.
  */
  function isNormalisationEnabled() {
    var store = storage();
    if (!store) return DEFAULT_NORMALISATION_ENABLED;
    try {
      var raw = store.getItem(PREFERENCE_KEY);
      if (!raw) return DEFAULT_NORMALISATION_ENABLED;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed.normalisationEnabled === 'boolean'
        ? parsed.normalisationEnabled
        : DEFAULT_NORMALISATION_ENABLED;
    } catch (e) {
      return DEFAULT_NORMALISATION_ENABLED;
    }
  }

  function setNormalisationEnabled(enabled) {
    var store = storage();
    if (!store) return false;
    try {
      store.setItem(PREFERENCE_KEY, JSON.stringify({
        normalisationEnabled: enabled !== false,
        updatedAt: new Date().toISOString()
      }));
      return true;
    } catch (e) {
      return false;
    }
  }

  /*
    Neutral conditions block for one course record. Returns null when the record
    has no usable analysis, which callers treat as "compare raw".
  */
  function conditionsForRecord(record) {
    if (!record || !record.shotId) return null;
    var store = intake();
    if (!store) return null;

    var analysis = null;
    try {
      analysis = store.getActiveAnalysis(record.shotId);
    } catch (e) {
      return null;
    }
    if (!analysis) return null;

    var block = {
      analysisId: analysis.analysisId,
      status: analysis.status,
      engineVersion: analysis.engineVersion,
      toleranceProfileVersion: analysis.toleranceProfileVersion,
      myBubbleVersionId: analysis.myBubbleVersionId,
      normalisationApplied: analysis.normalisationApplied === true,
      normalisationType: analysis.normalisationType || null,
      normalisationConfidence: analysis.normalisationConfidence,
      bubbleFitImprovement: analysis.bubbleFitImprovement,
      userSelectedWind: analysis.userSelectedWind === true,
      userSelectedSlope: analysis.userSelectedSlope === true,
      normalisedLateralM: null,
      normalisedDepthM: null,
      normalisedActualDistanceM: null,
      available: false,
      unavailableReason: null,

      // Rescue-only counterfactual, carried through for tuning. Never affects
      // which position this record compares on.
      symmetricEvaluation: analysis.symmetricEvaluation || null,
      wouldDemoteUnderSymmetric: !!(analysis.symmetricEvaluation && analysis.symmetricEvaluation.wouldChangeUnderSymmetric)
    };

    if (analysis.status !== 'ok') {
      block.unavailableReason = analysis.status === 'failed' ? 'ANALYSIS_FAILED' : 'ANALYSIS_UNAVAILABLE';
      return block;
    }
    if (!block.normalisationApplied) {
      block.unavailableReason = 'NORMALISATION_NOT_APPLIED';
      return block;
    }

    var fit = analysis.selectedBubbleFit;
    if (!fit || fit.valid !== true) {
      block.unavailableReason = 'SELECTED_BUBBLE_FIT_INVALID';
      return block;
    }

    var lateral = asNumber(fit.lateralError, null);
    var depth = asNumber(fit.longitudinalError, null);
    var expected = asNumber(record.expectedDistanceM, null);
    if (lateral === null || depth === null) {
      block.unavailableReason = 'SELECTED_BUBBLE_FIT_INCOMPLETE';
      return block;
    }

    block.normalisedLateralM = lateral;
    block.normalisedDepthM = depth;
    // Mirrors normalizeRecord: actual distance is the expected distance plus the
    // longitudinal error against the bubble centre.
    block.normalisedActualDistanceM = expected === null ? null : expected + depth;
    block.available = block.normalisedActualDistanceM !== null;
    if (!block.available) block.unavailableReason = 'MISSING_EXPECTED_DISTANCE';

    return block;
  }

  /* Non-mutating: returns a copy with a conditions block attached. */
  function enrichCourseRecord(record) {
    if (!record) return record;
    var copy = {};
    Object.keys(record).forEach(function (key) { copy[key] = record[key]; });
    copy.conditions = conditionsForRecord(record);
    return copy;
  }

  function enrichCourseRecords(records) {
    return (records || []).map(enrichCourseRecord);
  }

  /*
    The values the comparison layer should plot for one record. Raw is always
    carried through so a chart can show both, and normalisationApplied says which
    one was used.
  */
  function comparisonValues(record, options) {
    options = options || {};
    var conditions = record && Object.prototype.hasOwnProperty.call(record, 'conditions')
      ? record.conditions
      : conditionsForRecord(record);

    var rawActual = asNumber(record && record.actualDistanceM, null);
    if (rawActual === null) {
      var expected = asNumber(record && record.expectedDistanceM, null);
      var depth = asNumber(record && record.depthM, null);
      if (expected !== null && depth !== null) rawActual = expected + depth;
      else rawActual = expected;
    }
    var rawLateral = asNumber(record && record.lateralM, null);

    var enabled = options.useNormalised === undefined ? isNormalisationEnabled() : options.useNormalised !== false;
    var usable = enabled && conditions && conditions.available === true;

    return {
      actualDistanceM: usable ? conditions.normalisedActualDistanceM : rawActual,
      lateralM: usable ? conditions.normalisedLateralM : rawLateral,
      rawActualDistanceM: rawActual,
      rawLateralM: rawLateral,
      normalisationApplied: !!usable,
      normalisationType: usable ? conditions.normalisationType : null,
      bubbleFitImprovement: usable ? conditions.bubbleFitImprovement : null,
      conditions: conditions || null
    };
  }

  /* How many of a record set the comparison actually normalised. Diagnostics
     only — no interpretation, no thresholds. */
  function summarise(records) {
    var summary = {
      total: 0, normalised: 0, raw: 0, failed: 0, unavailable: 0, noAnalysis: 0,
      wouldDemoteUnderSymmetric: 0
    };
    (records || []).forEach(function (record) {
      summary.total += 1;
      var values = comparisonValues(record);
      if (values.conditions && values.conditions.wouldDemoteUnderSymmetric) {
        summary.wouldDemoteUnderSymmetric += 1;
      }
      if (values.normalisationApplied) { summary.normalised += 1; return; }
      summary.raw += 1;
      var conditions = values.conditions;
      if (!conditions) { summary.noAnalysis += 1; return; }
      if (conditions.status === 'failed') summary.failed += 1;
      else if (conditions.status === 'unavailable') summary.unavailable += 1;
    });
    return summary;
  }

  /*
    The readout for choosing between rescue-only and symmetric selection.

    rescued  - shots the current policy pulled INTO the bubble
    wouldDemote - shots a symmetric policy would push OUT, which rescue-only
                  currently leaves as hits
    netBias  - rescued minus wouldDemote. Positive means the current policy is
               net-flattering by that many shots.

    Counts only. Whether a given net bias is acceptable is a judgement for
    whoever is tuning, not for this module.
  */
  function biasReadout(records) {
    var readout = { total: 0, rescued: 0, wouldDemote: 0, netBias: 0, policy: null };

    (records || []).forEach(function (record) {
      var conditions = comparisonValues(record).conditions;
      if (!conditions || !conditions.symmetricEvaluation) return;
      readout.total += 1;
      readout.policy = readout.policy || conditions.symmetricEvaluation.policy;

      if (conditions.wouldDemoteUnderSymmetric) readout.wouldDemote += 1;

      if (conditions.normalisationApplied) {
        var directions = conditions.symmetricEvaluation.candidateDirections || [];
        directions.forEach(function (entry) {
          if (entry.variantType === conditions.normalisationType && entry.direction === 'rescue') {
            readout.rescued += 1;
          }
        });
      }
    });

    readout.netBias = readout.rescued - readout.wouldDemote;
    return readout;
  }

  var api = {
    PREFERENCE_KEY: PREFERENCE_KEY,
    isNormalisationEnabled: isNormalisationEnabled,
    setNormalisationEnabled: setNormalisationEnabled,
    conditionsForRecord: conditionsForRecord,
    enrichCourseRecord: enrichCourseRecord,
    enrichCourseRecords: enrichCourseRecords,
    comparisonValues: comparisonValues,
    summarise: summarise,
    biasReadout: biasReadout
  };

  root.modules.courseDataComparison = api;
  window.GolfDaddyCourseDataComparison = api;
  window.ClarityCaddieCourseDataComparison = api;
  if (window.ClarityCaddie) window.ClarityCaddie.modules = root.modules;
})();
