(function () {
  'use strict';

  /*
    Conditions Engine diagnostic surface.

    Internal only. Gated behind the same permission check Course Data admin
    already uses (gdCourseDataCanManage → admin or coach). Never rendered in the
    normal player experience, and it carries no player-facing copy — it exists so
    a bad combined result can be traced to wind maths, slope maths, vector
    orientation, stale evidence, target direction, coordinate conversion or
    tolerance selection.
  */

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  function intake() {
    return (root.modules && root.modules.courseDataIntake) || window.GolfDaddyCourseDataIntake;
  }

  function tolerances() {
    return (root.modules && root.modules.conditionsToleranceProfile) || window.GolfDaddyConditionsToleranceProfile;
  }

  function canViewDiagnostics() {
    if (typeof window.gdCourseDataCanManage === 'function') {
      try { return window.gdCourseDataCanManage() === true; } catch (e) { return false; }
    }
    // No permission owner loaded (e.g. tests, headless tooling): stay closed.
    return false;
  }

  function ageOf(capturedAt, shotAt) {
    var a = Date.parse(capturedAt);
    var b = Date.parse(shotAt);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.abs(b - a);
  }

  /*
    Structured debug payload for one processed shot. Pass { force: true } only
    from internal tooling that has already established its own gating.
  */
  function getDebugPayload(shotId, options) {
    options = options || {};
    if (!options.force && !canViewDiagnostics()) {
      return { available: false, reason: 'PERMISSION_DENIED' };
    }

    var store = intake();
    var tol = tolerances();
    if (!store) return { available: false, reason: 'INTAKE_UNAVAILABLE' };

    var snapshot = store.getSnapshot(shotId);
    if (!snapshot) return { available: false, reason: 'SNAPSHOT_NOT_FOUND' };

    var record = store.getActiveAnalysis(shotId);
    if (!record) {
      return {
        available: true,
        shotId: shotId,
        shotSnapshot: snapshot,
        analysis: null,
        reason: 'NO_ANALYSIS_RECORD'
      };
    }

    var candidates = [];
    [record.rawPosition ? {
      variantType: 'raw',
      analyticalPosition: record.rawPosition,
      adjustmentVector: null,
      adjustmentMagnitude: 0,
      bubbleFit: record.rawBubbleFit,
      rejectionReason: null
    } : null, record.windVariant, record.slopeVariant, record.combinedVariant].forEach(function (variant) {
      if (variant) candidates.push(variant);
    });

    var rejected = candidates.filter(function (variant) { return !!variant.rejectionReason; });

    return {
      available: true,
      shotId: shotId,
      engineVersion: record.engineVersion,
      status: record.status,

      shotSnapshot: snapshot,
      activeMyBubbleVersionId: record.myBubbleVersionId,
      activeMyBubble: record.myBubbleVersionId ? store.getMyBubbleVersion(record.myBubbleVersionId) : null,

      environmentalEvidence: {
        wind: record.windEvidence,
        slope: record.slopeEvidence
      },
      environmentalEvidenceAgeMs: {
        wind: ageOf(snapshot.liveWindCapturedAt, snapshot.capturedAt),
        slope: ageOf(snapshot.liveSlopeCapturedAt, snapshot.capturedAt)
      },

      targetOrientation: {
        intendedDirection: snapshot.intendedDirection,
        targetPosition: snapshot.targetPosition,
        startPosition: snapshot.shotStartPosition
      },

      generatedVectors: {
        liveWind: record.windEvidence ? record.windEvidence.liveWindAdjustmentVector : null,
        selectedWind: record.windEvidence ? record.windEvidence.selectedWindAdjustmentVector : null,
        windDifference: record.windEvidence ? record.windEvidence.windAdjustmentDifferenceVector : null,
        liveSlope: record.slopeEvidence ? record.slopeEvidence.liveSlopeAdjustmentVector : null,
        selectedSlope: record.slopeEvidence ? record.slopeEvidence.selectedSlopeAdjustmentVector : null,
        slopeDifference: record.slopeEvidence ? record.slopeEvidence.slopeAdjustmentDifferenceVector : null,
        combined: record.combinedVariant ? record.combinedVariant.adjustmentVector : null
      },

      candidatePositions: candidates.map(function (variant) {
        return { variantType: variant.variantType, analyticalPosition: variant.analyticalPosition };
      }),
      bubbleFitByCandidate: candidates.map(function (variant) {
        return {
          variantType: variant.variantType,
          bubbleFit: variant.bubbleFit || null,
          bubbleFitScore: variant.bubbleFitScore == null ? null : variant.bubbleFitScore,
          bubbleFitImprovement: variant.bubbleFitImprovement == null ? null : variant.bubbleFitImprovement
        };
      }),

      toleranceProfile: tol ? tol.resolve(record.toleranceProfileVersion) : null,
      toleranceProfileVersion: record.toleranceProfileVersion,

      selectedVariant: record.selectedVariant,
      selectionReason: record.normalisationApplied
        ? 'SAFEGUARDS_PASSED_AND_FIT_IMPROVED'
        : (rejected.length ? 'ALL_CANDIDATES_REJECTED' : 'NO_SIGNIFICANT_ENVIRONMENTAL_EFFECT'),
      rejectedVariants: rejected.map(function (variant) {
        return { variantType: variant.variantType, rejectionReason: variant.rejectionReason };
      }),

      // Rescue-only counterfactual: what a symmetric selection policy would
      // have decided for this shot, recorded but not acted on.
      symmetricEvaluation: record.symmetricEvaluation || null,

      warnings: record.processingWarnings,
      debugFlags: record.debugFlags,

      analysisHistory: store.listAnalyses(shotId).map(function (entry) {
        return {
          analysisId: entry.analysisId,
          engineVersion: entry.engineVersion,
          toleranceProfileVersion: entry.toleranceProfileVersion,
          processedAt: entry.processedAt,
          selectedVariant: entry.selectedVariant,
          status: entry.status
        };
      })
    };
  }

  var api = {
    canViewDiagnostics: canViewDiagnostics,
    getDebugPayload: getDebugPayload
  };

  root.modules.conditionsDebug = api;
  window.GolfDaddyConditionsDebug = api;
  window.ClarityCaddieConditionsDebug = api;
  if (window.ClarityCaddie) window.ClarityCaddie.modules = root.modules;
})();
