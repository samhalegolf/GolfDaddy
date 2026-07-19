(function () {
  'use strict';

  /*
    Clarity Conditions Engine.

    One responsibility: decide whether wind and slope normalisation produces a
    more faithful comparison between a Course Data shot and the active My Bubble.

    This engine is ANALYTICAL AND SILENT. It emits evidence, vectors, scores and
    machine-readable rejection codes. It must never emit player-facing copy,
    recommendations, coaching statements, praise, criticism, pattern detection
    across rounds, or any judgement about whether an insight should be shown.
    Those belong to the Recommendations Engine, which consumes this output.

    My Bubble is READ-ONLY here. The engine never retrains, moves, resizes or
    otherwise mutates My Bubble, practice data, or Bag distances.
  */

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  var ENGINE_VERSION = '1.0.0';

  var VARIANT_RAW = 'raw';
  var VARIANT_WIND = 'windNormalised';
  var VARIANT_SLOPE = 'slopeNormalised';
  var VARIANT_COMBINED = 'combinedNormalised';

  var STATUS_OK = 'ok';
  var STATUS_FAILED = 'failed';
  var STATUS_UNAVAILABLE = 'unavailable';

  function geometry() {
    return (root.modules && root.modules.conditionsGeometry) || window.GolfDaddyConditionsGeometry;
  }

  function tolerances() {
    return (root.modules && root.modules.conditionsToleranceProfile) || window.GolfDaddyConditionsToleranceProfile;
  }

  function asNumber(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function toTime(value) {
    if (value == null) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    var parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function zeroVector() {
    return { lateral: 0, forward: 0, bearingDeg: null, magnitudeM: 0 };
  }

  /*
    Adjustment vectors are expressed twice on purpose: in the shot's local frame
    (lateral/forward relative to intendedDirection) and as an absolute
    bearing+magnitude. Storing both is what makes a bad combined result
    diagnosable — a sign error shows up in the local frame, a frame error shows
    up as a bearing that disagrees with the magnitude.
  */
  function makeVector(geo, bearingDeg, magnitudeM, intendedDirectionDeg) {
    var magnitude = asNumber(magnitudeM, 0);
    if (!Number.isFinite(Number(bearingDeg)) || magnitude === 0) return zeroVector();
    var relative = geo.angleDifference(intendedDirectionDeg, bearingDeg);
    var rad = relative * Math.PI / 180;
    return {
      lateral: magnitude * Math.sin(rad),
      forward: magnitude * Math.cos(rad),
      bearingDeg: geo.normaliseDegrees(bearingDeg),
      magnitudeM: magnitude
    };
  }

  /*
    Wind-specific decomposition.

    Unlike makeVector (a plain rotation, correct for slope which is purely
    along-line), wind scales its two axes independently, so the resulting vector
    no longer points along the wind bearing and its magnitude is no longer the
    input magnitude. Both are recomputed from the components.

    Along-line: always active, scaled by cos, with separate factors for a
    headwind (hurting) and a tailwind (helping).

    Lateral: gated. Only applies when the wind is clearly across the shot line
    -- outside crosswindGateDegrees either side. A quartering wind inside that
    band is treated as a pure distance effect, because a small spurious lateral
    correction does disproportionate damage on the axis the bubble is narrowest.

    With headwind/tailwind/crosswind factors of 1 and a gate of 0 this reduces
    exactly to the plain cos/sin rotation, which is how profile 1.0.0 keeps
    reprocessing to its original results.
  */
  function makeWindVector(geo, bearingDeg, magnitudeM, intendedDirectionDeg, model) {
    var magnitude = asNumber(magnitudeM, 0);
    if (!Number.isFinite(Number(bearingDeg)) || magnitude === 0) return zeroVector();
    model = model || {};

    var relative = geo.angleDifference(intendedDirectionDeg, bearingDeg);
    var rad = relative * Math.PI / 180;
    var offLine = Math.abs(relative);

    var alongRaw = Math.cos(rad);
    var alongFactor = alongRaw >= 0
      ? asNumber(model.headwindFactor, 1)
      : asNumber(model.tailwindFactor, 1);
    var forward = magnitude * alongRaw * alongFactor;

    var gate = asNumber(model.crosswindGateDegrees, 0);
    var clearlyAcross = offLine > gate && offLine < (180 - gate);
    var lateral = clearlyAcross
      ? magnitude * Math.sin(rad) * asNumber(model.crosswindFactor, 1)
      : 0;

    var resultant = Math.sqrt(lateral * lateral + forward * forward);
    if (resultant === 0) return zeroVector();

    return {
      lateral: lateral,
      forward: forward,
      bearingDeg: geo.normaliseDegrees(asNumber(intendedDirectionDeg, 0) + Math.atan2(lateral, forward) * 180 / Math.PI),
      magnitudeM: resultant,
      // Kept for diagnosis: distinguishes "the wind was weak" from "the gate
      // suppressed the lateral component".
      appliedMagnitudeBeforeFactors: magnitude,
      crosswindGateOpen: clearlyAcross,
      offLineDegrees: offLine
    };
  }

  function addVectors(geo, a, b, intendedDirectionDeg) {
    var lateral = asNumber(a && a.lateral, 0) + asNumber(b && b.lateral, 0);
    var forward = asNumber(a && a.forward, 0) + asNumber(b && b.forward, 0);
    var magnitude = Math.sqrt(lateral * lateral + forward * forward);
    if (magnitude === 0) return zeroVector();
    var relative = Math.atan2(lateral, forward) * 180 / Math.PI;
    return {
      lateral: lateral,
      forward: forward,
      bearingDeg: geo.normaliseDegrees(asNumber(intendedDirectionDeg, 0) + relative),
      magnitudeM: magnitude
    };
  }

  function applyVector(geo, position, vector, intendedDirectionDeg) {
    if (!vector || !vector.magnitudeM) return position;
    return geo.fromLocal(position, { lateral: vector.lateral, forward: vector.forward }, intendedDirectionDeg);
  }

  // ---------------------------------------------------------------------------
  // Input validation
  // ---------------------------------------------------------------------------

  function validateInput(snapshot, bubble, profile, geo) {
    var errors = [];
    var warnings = [];

    if (!snapshot || typeof snapshot !== 'object') {
      errors.push('MISSING_SNAPSHOT');
      return { valid: false, errors: errors, warnings: warnings };
    }
    if (!snapshot.shotId) errors.push('MISSING_SHOT_ID');
    if (!geo.hasLatLng(snapshot.shotStartPosition)) errors.push('INVALID_START_POSITION');
    if (!geo.hasLatLng(snapshot.shotLandingPosition)) errors.push('INVALID_LANDING_POSITION');
    if (!bubble) errors.push('MISSING_ACTIVE_BUBBLE');

    var limits = profile.shotLimits;
    var distance = asNumber(snapshot.shotDistance, null);
    if (distance === null && geo.hasLatLng(snapshot.shotStartPosition) && geo.hasLatLng(snapshot.shotLandingPosition)) {
      distance = geo.distanceMetres(snapshot.shotStartPosition, snapshot.shotLandingPosition);
      warnings.push('SHOT_DISTANCE_DERIVED');
    }
    if (distance !== null && (distance < limits.minShotDistanceMetres || distance > limits.maxShotDistanceMetres)) {
      errors.push('SHOT_DISTANCE_OUT_OF_RANGE');
    }

    // Target orientation is required: every adjustment vector is expressed
    // relative to it, so an unknown intended direction makes the whole
    // local frame meaningless.
    var intended = asNumber(snapshot.intendedDirection, null);
    if (intended === null && geo.hasLatLng(snapshot.shotStartPosition) && geo.hasLatLng(snapshot.targetPosition)) {
      intended = geo.bearingDegrees(snapshot.shotStartPosition, snapshot.targetPosition);
      warnings.push('INTENDED_DIRECTION_DERIVED_FROM_TARGET');
    }
    if (intended === null && geo.hasLatLng(snapshot.shotStartPosition) && geo.hasLatLng(snapshot.shotLandingPosition)) {
      intended = geo.bearingDegrees(snapshot.shotStartPosition, snapshot.shotLandingPosition);
      warnings.push('INTENDED_DIRECTION_DERIVED_FROM_LANDING');
    }
    if (intended === null) errors.push('MISSING_TARGET_ORIENTATION');

    var accuracy = asNumber(snapshot.gpsAccuracy, null);
    if (accuracy !== null && accuracy > limits.maxGpsAccuracyMetres) warnings.push('LOW_GPS_ACCURACY');
    if (snapshot.shotCaptureMethod === 'incomplete' || snapshot.unreliable === true) warnings.push('SHOT_MARKED_UNRELIABLE');

    return {
      valid: errors.length === 0,
      errors: errors,
      warnings: warnings,
      shotDistance: distance,
      intendedDirection: intended
    };
  }

  // ---------------------------------------------------------------------------
  // Wind evidence
  // ---------------------------------------------------------------------------

  function windEffectMetres(profile, carryM, scaleLevel) {
    var model = profile.windModel;
    var carry = Math.max(model.minCarryMetres, Math.min(model.maxCarryMetres, asNumber(carryM, model.fallbackCarryMetres)));
    var base = Math.max(model.minEffectMetres, Math.min(model.maxEffectMetres, carry * model.carryFactor));
    var level = Math.max(1, Math.min(model.maxScaleLevel, asNumber(scaleLevel, 1)));
    return base * level;
  }

  function buildWindEvidence(snapshot, profile, ctx, geo, tol) {
    var evidence = {
      windWasUserSelected: snapshot.userSelectedWind === true,
      liveWindAvailable: snapshot.liveWindAvailable === true,
      liveWindScaleLevel: asNumber(snapshot.liveWindScaleLevel, null),
      liveWindSpeed: asNumber(snapshot.liveWindSpeed, null),
      liveWindDirection: asNumber(snapshot.liveWindDirection, null),
      liveWindSource: snapshot.liveWindSource || null,
      liveWindCapturedAt: snapshot.liveWindCapturedAt || null,
      liveWindConfidence: tol.normaliseConfidence(snapshot.liveWindConfidence),
      evidenceAgeMs: null,
      liveWindAdjustmentVector: zeroVector(),
      selectedWindAdjustmentVector: zeroVector(),
      windAdjustmentDifferenceVector: zeroVector(),
      userWindSelection: snapshot.userWindSelection || null,
      userWindIntent: snapshot.userWindIntent || null,
      significant: false,
      gateFailures: []
    };

    var captured = toTime(snapshot.liveWindCapturedAt);
    var shotAt = toTime(snapshot.capturedAt);
    if (captured !== null && shotAt !== null) {
      evidence.evidenceAgeMs = Math.abs(shotAt - captured);
    }

    // The player's own wind selection is preserved as evidence regardless of
    // whether live wind passes its gates. It is never treated as ground truth.
    if (evidence.windWasUserSelected && snapshot.userWindSelection) {
      var sel = snapshot.userWindSelection;
      var selMagnitude = windEffectMetres(profile, ctx.shotDistance, sel.scaleLevel != null ? sel.scaleLevel : sel.level);
      // Neutralising means moving back INTO the wind, i.e. along the origin bearing.
      evidence.selectedWindAdjustmentVector = makeWindVector(geo, asNumber(sel.directionDeg, asNumber(sel.direction, null)), selMagnitude, ctx.intendedDirection, profile.windModel);
    }

    if (!evidence.liveWindAvailable) {
      evidence.gateFailures.push('LIVE_WIND_UNAVAILABLE');
    }
    if (!(evidence.liveWindScaleLevel > profile.minimumWindScaleLevel)) {
      // At or below the minimum scale level wind is effectively neutral.
      evidence.gateFailures.push('WIND_SCALE_BELOW_THRESHOLD');
    }
    if (!(evidence.liveWindConfidence >= profile.minimumWindConfidence)) {
      evidence.gateFailures.push('WIND_CONFIDENCE_BELOW_MINIMUM');
    }
    if (!Number.isFinite(evidence.liveWindDirection)) {
      evidence.gateFailures.push('WIND_DIRECTION_UNKNOWN');
    }
    if (evidence.evidenceAgeMs !== null && evidence.evidenceAgeMs > profile.maximumEnvironmentalDataAge) {
      evidence.gateFailures.push('WIND_EVIDENCE_STALE');
    }

    if (evidence.gateFailures.length === 0) {
      var magnitude = windEffectMetres(profile, ctx.shotDistance, evidence.liveWindScaleLevel);
      var vector = makeWindVector(geo, evidence.liveWindDirection, magnitude, ctx.intendedDirection, profile.windModel);
      evidence.crosswindGateOpen = vector.crosswindGateOpen === true;
      evidence.offLineDegrees = vector.offLineDegrees == null ? null : vector.offLineDegrees;

      // Significance is judged on the resultant AFTER the directional factors,
      // since that is the displacement actually being claimed. A tailwind or a
      // gated-off quartering wind can fall below the threshold where the raw
      // magnitude would not have.
      if (vector.magnitudeM < profile.minimumWindEffectMetres) {
        evidence.gateFailures.push('WIND_EFFECT_BELOW_MINIMUM');
      } else {
        evidence.liveWindAdjustmentVector = vector;
        evidence.significant = true;
      }
    }

    evidence.windAdjustmentDifferenceVector = addVectors(geo, evidence.liveWindAdjustmentVector, {
      lateral: -asNumber(evidence.selectedWindAdjustmentVector.lateral, 0),
      forward: -asNumber(evidence.selectedWindAdjustmentVector.forward, 0)
    }, ctx.intendedDirection);

    return evidence;
  }

  // ---------------------------------------------------------------------------
  // Slope evidence
  // ---------------------------------------------------------------------------

  function buildSlopeEvidence(snapshot, profile, ctx, geo, tol) {
    var evidence = {
      slopeWasUserSelected: snapshot.userSelectedSlope === true,
      liveSlopeAvailable: snapshot.liveSlopeAvailable === true,
      liveSlopeValue: asNumber(snapshot.liveSlopeValue, null),
      liveSlopeDirection: snapshot.liveSlopeDirection || null,
      liveSlopeSource: snapshot.liveSlopeSource || null,
      liveSlopeCapturedAt: snapshot.liveSlopeCapturedAt || null,
      liveSlopeConfidence: tol.normaliseConfidence(snapshot.liveSlopeConfidence),
      evidenceAgeMs: null,
      predictedSlopeEffectM: null,
      liveSlopeAdjustmentVector: zeroVector(),
      selectedSlopeAdjustmentVector: zeroVector(),
      slopeAdjustmentDifferenceVector: zeroVector(),
      userSlopeSelection: snapshot.userSlopeSelection || null,
      userSlopeIntent: snapshot.userSlopeIntent || null,
      significant: false,
      gateFailures: []
    };

    var captured = toTime(snapshot.liveSlopeCapturedAt);
    var shotAt = toTime(snapshot.capturedAt);
    if (captured !== null && shotAt !== null) {
      evidence.evidenceAgeMs = Math.abs(shotAt - captured);
    }

    if (evidence.slopeWasUserSelected && snapshot.userSlopeSelection) {
      var selValue = asNumber(snapshot.userSlopeSelection.valueM, asNumber(snapshot.userSlopeSelection.value, 0));
      evidence.selectedSlopeAdjustmentVector = makeVector(
        geo,
        selValue >= 0 ? ctx.intendedDirection : geo.normaliseDegrees(ctx.intendedDirection + 180),
        Math.abs(selValue * profile.slopeModel.metresPerMetreOfRise),
        ctx.intendedDirection
      );
    }

    if (!evidence.liveSlopeAvailable) {
      evidence.gateFailures.push('LIVE_SLOPE_UNAVAILABLE');
    }
    if (!Number.isFinite(evidence.liveSlopeValue)) {
      evidence.gateFailures.push('SLOPE_VALUE_UNKNOWN');
    }
    if (!(evidence.liveSlopeConfidence >= profile.minimumSlopeConfidence)) {
      evidence.gateFailures.push('SLOPE_CONFIDENCE_BELOW_MINIMUM');
    }
    if (evidence.evidenceAgeMs !== null && evidence.evidenceAgeMs > profile.maximumEnvironmentalDataAge) {
      evidence.gateFailures.push('SLOPE_EVIDENCE_STALE');
    }

    if (Number.isFinite(evidence.liveSlopeValue)) {
      // Uphill (positive delta) makes a shot play longer, so on flat ground the
      // same strike would have finished further on. Neutralising therefore
      // pushes the analytical position forward by the predicted effect.
      evidence.predictedSlopeEffectM = evidence.liveSlopeValue * profile.slopeModel.metresPerMetreOfRise;
    }

    if (evidence.gateFailures.length === 0) {
      var effect = evidence.predictedSlopeEffectM;
      if (Math.abs(effect) < profile.minimumSlopeEffectMetres) {
        evidence.gateFailures.push('SLOPE_EFFECT_BELOW_MINIMUM');
      } else {
        evidence.liveSlopeAdjustmentVector = makeVector(
          geo,
          effect >= 0 ? ctx.intendedDirection : geo.normaliseDegrees(ctx.intendedDirection + 180),
          Math.abs(effect),
          ctx.intendedDirection
        );
        evidence.significant = true;
      }
    }

    evidence.slopeAdjustmentDifferenceVector = addVectors(geo, evidence.liveSlopeAdjustmentVector, {
      lateral: -asNumber(evidence.selectedSlopeAdjustmentVector.lateral, 0),
      forward: -asNumber(evidence.selectedSlopeAdjustmentVector.forward, 0)
    }, ctx.intendedDirection);

    return evidence;
  }

  // ---------------------------------------------------------------------------
  // Variants
  // ---------------------------------------------------------------------------

  function buildVariant(type, ctx, geo, bubble, vector, inputEvidence, confidence) {
    var position = applyVector(geo, ctx.rawPosition, vector, ctx.intendedDirection);
    var fit = geo.evaluateBubbleFit(bubble, position);
    return {
      variantType: type,
      analyticalPosition: position,
      adjustmentVector: vector,
      adjustmentMagnitude: asNumber(vector && vector.magnitudeM, 0),
      inputEvidence: inputEvidence,
      confidence: confidence,
      bubbleFitScore: fit.score,
      bubbleFit: fit,
      rejectionReason: null,
      warnings: []
    };
  }

  /*
    Safeguards. A normalised variant may replace the raw analytical outcome only
    when every one of these passes. Any failure pins selectedVariant to raw.
    The engine never forces a shot into My Bubble.
  */
  function evaluateSafeguards(variant, rawVariant, profile, ctx) {
    var failures = [];

    if (!variant.inputEvidence || variant.inputEvidence.significant !== true) {
      failures.push('EFFECT_BELOW_SIGNIFICANCE_THRESHOLD');
    }
    if (!(asNumber(variant.confidence, 0) >= profile.minimumSelectionConfidence)) {
      failures.push('SOURCE_CONFIDENCE_INSUFFICIENT');
    }
    if (variant.warnings.length) {
      failures.push('VARIANT_CALCULATION_WARNINGS');
    }
    if (!(variant.adjustmentMagnitude > 0)) {
      failures.push('ADJUSTMENT_NOT_PHYSICALLY_PLAUSIBLE');
    }
    if (variant.adjustmentMagnitude > profile.maximumCorrectionDistanceMetres) {
      failures.push('CORRECTION_EXCEEDS_MAXIMUM_DISTANCE');
    }
    if (ctx.shotDistance > 0 && variant.adjustmentMagnitude > ctx.shotDistance) {
      failures.push('ADJUSTMENT_NOT_PHYSICALLY_PLAUSIBLE');
    }
    if (variant.adjustmentVector && Number.isFinite(Number(variant.adjustmentVector.bearingDeg))) {
      var angle = Math.abs(ctx.geo.angleDifference(ctx.intendedDirection, variant.adjustmentVector.bearingDeg));
      // Correction angle is measured against the shot line; a correction that is
      // near-perpendicular or reversed is capped by maximumCorrectionDegrees
      // only for its along-line component.
      var offAxis = Math.min(angle, 180 - angle);
      if (offAxis > profile.maximumCorrectionDegrees && variant.adjustmentMagnitude > profile.minimumWindEffectMetres) {
        // A large off-axis correction is allowed for genuine crosswind, but the
        // resulting angular displacement of the shot must stay bounded.
        var angularShift = Math.abs(Math.atan2(variant.adjustmentVector.lateral, Math.max(1, ctx.shotDistance)) * 180 / Math.PI);
        if (angularShift > profile.maximumCorrectionDegrees) {
          failures.push('CORRECTION_EXCEEDS_MAXIMUM_ANGLE');
        }
      }
    }
    if (!variant.bubbleFit || variant.bubbleFit.valid !== true) {
      failures.push('BUBBLE_FIT_INVALID');
    }
    if (ctx.unreliable) {
      failures.push('SHOT_MARKED_UNRELIABLE');
    }

    // Everything above is a PHYSICAL validity check: it asks whether this
    // correction is believable at all, and applies identically whichever
    // direction the correction moves the shot.
    var physicallyValid = failures.length === 0;

    // The improvement gate is a POLICY check, not a physical one. Under
    // 'rescue-only' a correction may only apply when it improves the fit, so a
    // shot a tailwind pushed INTO the bubble is never demoted. Under 'symmetric'
    // a large enough move in either direction applies. The two are separated so
    // the counterfactual can be recorded without changing what gets selected.
    var improvement = asNumber(variant.bubbleFitScore, 0) - asNumber(rawVariant.bubbleFitScore, 0);
    var threshold = profile.minimumBubbleFitImprovement;
    var passesRescueOnly = physicallyValid && improvement >= threshold;
    var passesSymmetric = physicallyValid && Math.abs(improvement) >= threshold;

    if (!(improvement >= threshold)) {
      failures.push('BUBBLE_FIT_IMPROVEMENT_BELOW_MINIMUM');
    }

    var policy = profile.variantSelectionPolicy || 'rescue-only';

    return {
      passed: policy === 'symmetric' ? passesSymmetric : passesRescueOnly,
      physicallyValid: physicallyValid,
      physicalFailures: failures.slice(0, physicallyValid ? 0 : failures.length),
      failures: failures,
      improvement: improvement,
      passesRescueOnly: passesRescueOnly,
      passesSymmetric: passesSymmetric,
      policy: policy
    };
  }

  /*
    Which way a candidate would move the shot across the bubble boundary.

      rescue   - raw finished outside, the correction brings it inside
      demotion - raw finished inside, the correction pushes it outside
      neutral  - stays on the same side either way

    Recorded for every candidate regardless of policy. Under 'rescue-only' a
    demotion is never applied, but counting how often one WOULD apply is what
    tells you how much the rescue-only bias is flattering the player.
  */
  function assessDirection(variant, rawVariant) {
    var rawInside = !!(rawVariant.bubbleFit && rawVariant.bubbleFit.insideBubble);
    var variantInside = !!(variant.bubbleFit && variant.bubbleFit.insideBubble);
    var direction = 'neutral';
    if (!rawInside && variantInside) direction = 'rescue';
    else if (rawInside && !variantInside) direction = 'demotion';
    return { direction: direction, rawInsideBubble: rawInside, variantInsideBubble: variantInside };
  }

  // ---------------------------------------------------------------------------
  // Main entry
  // ---------------------------------------------------------------------------

  function analyse(input) {
    input = input || {};
    var geo = geometry();
    var tol = tolerances();
    var processedAt = new Date().toISOString();

    if (!geo || !tol) {
      return failureResult(input, processedAt, ['CONDITIONS_MODULES_UNAVAILABLE'], null);
    }

    /*
      A caller may hand over an already-resolved profile -- that is how an
      admin-derived profile (base plus tuning overrides, carrying its own hashed
      version) reaches the engine without the registry needing to know about it.
      Otherwise resolve by version, which is what reprocessing a historical
      analysis does.
    */
    var profile = null;
    if (input.toleranceProfile && input.toleranceProfile.windModel && !input.toleranceProfileVersion) {
      profile = input.toleranceProfile;
    } else {
      profile = tol.resolve(input.toleranceProfileVersion || (input.toleranceProfile && input.toleranceProfile.version));
      if ((input.toleranceProfileVersion || (input.toleranceProfile && input.toleranceProfile.version)) && !profile) {
        return failureResult(input, processedAt, ['UNKNOWN_TOLERANCE_PROFILE_VERSION'], null);
      }
    }
    profile = profile || tol.latest();

    var engineVersion = input.engineVersion || ENGINE_VERSION;
    var snapshot = input.shotSnapshot;

    var bubble = geo.normaliseBubble(input.activeMyBubble);
    var validation = validateInput(snapshot, bubble, profile, geo);
    if (!validation.valid) {
      return failureResult(input, processedAt, validation.errors, profile, engineVersion, validation.warnings);
    }

    var warnings = validation.warnings.slice();
    var debugFlags = {};

    // A historical shot must be analysed against the bubble it was captured
    // with. If the caller hands us a mismatched version we record it loudly
    // rather than silently comparing against a newer My Bubble.
    if (snapshot.myBubbleVersionId && bubble.versionId && snapshot.myBubbleVersionId !== bubble.versionId) {
      warnings.push('BUBBLE_VERSION_MISMATCH');
      debugFlags.bubbleVersionMismatch = true;
      debugFlags.snapshotBubbleVersionId = snapshot.myBubbleVersionId;
      debugFlags.suppliedBubbleVersionId = bubble.versionId;
    }

    var ctx = {
      geo: geo,
      rawPosition: { lat: Number(snapshot.shotLandingPosition.lat), lng: Number(snapshot.shotLandingPosition.lng) },
      intendedDirection: validation.intendedDirection,
      shotDistance: validation.shotDistance,
      unreliable: warnings.indexOf('SHOT_MARKED_UNRELIABLE') !== -1
    };

    var positionConfidence = tol.normaliseConfidence(
      snapshot.landingConfidence != null ? snapshot.landingConfidence : 'medium'
    );

    var windEvidence = buildWindEvidence(snapshot, profile, ctx, geo, tol);
    var slopeEvidence = buildSlopeEvidence(snapshot, profile, ctx, geo, tol);

    var rawVariant = buildVariant(VARIANT_RAW, ctx, geo, bubble, zeroVector(), { significant: true }, positionConfidence);
    var candidates = [];

    if (windEvidence.significant) {
      candidates.push(buildVariant(
        VARIANT_WIND, ctx, geo, bubble,
        windEvidence.liveWindAdjustmentVector,
        windEvidence,
        Math.min(windEvidence.liveWindConfidence, positionConfidence)
      ));
    }

    if (slopeEvidence.significant) {
      candidates.push(buildVariant(
        VARIANT_SLOPE, ctx, geo, bubble,
        slopeEvidence.liveSlopeAdjustmentVector,
        slopeEvidence,
        Math.min(slopeEvidence.liveSlopeConfidence, positionConfidence)
      ));
    }

    // Combined runs through one transformation: the two local-frame vectors are
    // summed and applied once, so orientation and units are resolved in a single
    // place rather than by stacking two independent corrections.
    if (windEvidence.significant && slopeEvidence.significant) {
      var combinedVector = addVectors(geo, windEvidence.liveWindAdjustmentVector, slopeEvidence.liveSlopeAdjustmentVector, ctx.intendedDirection);
      var combined = buildVariant(
        VARIANT_COMBINED, ctx, geo, bubble, combinedVector,
        { significant: true, wind: windEvidence, slope: slopeEvidence },
        Math.min(windEvidence.liveWindConfidence, slopeEvidence.liveSlopeConfidence, positionConfidence)
      );
      candidates.push(combined);
      debugFlags.combinedFromWindAndSlope = true;
    }

    var selected = rawVariant;
    var selectedImprovement = 0;
    var best = null;
    var demotionCandidate = null;
    var candidateDirections = [];

    candidates.forEach(function (candidate) {
      var verdict = evaluateSafeguards(candidate, rawVariant, profile, ctx);
      var heading = assessDirection(candidate, rawVariant);

      candidate.bubbleFitImprovement = verdict.improvement;
      candidate.direction = heading.direction;
      candidate.physicallyValid = verdict.physicallyValid;
      candidate.rawInsideBubble = heading.rawInsideBubble;
      candidate.variantInsideBubble = heading.variantInsideBubble;
      candidate.wouldApplyUnderSymmetric = verdict.passesSymmetric;

      candidateDirections.push({
        variantType: candidate.variantType,
        direction: heading.direction,
        physicallyValid: verdict.physicallyValid,
        improvement: verdict.improvement,
        variantInsideBubble: heading.variantInsideBubble,
        wouldApplyUnderSymmetric: verdict.passesSymmetric
      });

      // A physically valid correction that would push an inside shot out is the
      // case rescue-only never applies. Recording it is what makes the
      // rescue-only bias measurable instead of invisible.
      if (heading.direction === 'demotion' && verdict.passesSymmetric && !demotionCandidate) {
        demotionCandidate = {
          variantType: candidate.variantType,
          bubbleFitScore: candidate.bubbleFitScore,
          improvement: verdict.improvement,
          adjustmentMagnitude: candidate.adjustmentMagnitude
        };
      }

      if (!verdict.passed) {
        candidate.rejectionReason = verdict.failures.join(',');
        return;
      }
      if (!best || candidate.bubbleFitScore > best.bubbleFitScore) {
        best = candidate;
        selectedImprovement = verdict.improvement;
      }
    });

    if (best) {
      selected = best;
    }

    var activePolicy = profile.variantSelectionPolicy || 'rescue-only';

    var normalisationApplied = selected.variantType !== VARIANT_RAW;

    return {
      status: STATUS_OK,
      shotId: snapshot.shotId,
      analysisId: input.analysisId || null,
      engineVersion: engineVersion,
      toleranceProfileVersion: profile.version,
      processedAt: processedAt,

      rawPosition: ctx.rawPosition,
      selectedAnalyticalPosition: selected.analyticalPosition,
      selectedVariant: selected.variantType,

      normalisationApplied: normalisationApplied,
      normalisationType: normalisationApplied ? selected.variantType : null,
      normalisationConfidence: normalisationApplied ? selected.confidence : null,

      rawBubbleFitScore: rawVariant.bubbleFitScore,
      selectedBubbleFitScore: selected.bubbleFitScore,
      bubbleFitImprovement: normalisationApplied ? selectedImprovement : 0,

      rawBubbleFit: rawVariant.bubbleFit,
      selectedBubbleFit: selected.bubbleFit,

      userSelectedWind: windEvidence.windWasUserSelected,
      userSelectedSlope: slopeEvidence.slopeWasUserSelected,

      windEvidence: windEvidence,
      slopeEvidence: slopeEvidence,

      candidateVariants: [rawVariant].concat(candidates),
      processingWarnings: warnings,
      debugFlags: debugFlags,

      /*
        Option C: the symmetric counterfactual is always computed and recorded,
        but never applied while the policy is 'rescue-only'. Aggregating
        demotionCandidate across shots shows how far the rescue-only bias is
        flattering the player, so the choice to go symmetric can be made on
        evidence rather than intuition.
      */
      symmetricEvaluation: {
        policy: activePolicy,
        rawInsideBubble: !!(rawVariant.bubbleFit && rawVariant.bubbleFit.insideBubble),
        demotionCandidate: demotionCandidate,
        wouldChangeUnderSymmetric: !!demotionCandidate && activePolicy !== 'symmetric',
        candidateDirections: candidateDirections
      },

      bubbleVersionId: bubble.versionId || snapshot.myBubbleVersionId || null,
      intendedDirection: ctx.intendedDirection,
      toleranceProfile: profile
    };
  }

  function failureResult(input, processedAt, errors, profile, engineVersion, warnings) {
    var snapshot = input.shotSnapshot || {};
    var rawPosition = snapshot.shotLandingPosition && Number.isFinite(Number(snapshot.shotLandingPosition.lat))
      ? { lat: Number(snapshot.shotLandingPosition.lat), lng: Number(snapshot.shotLandingPosition.lng) }
      : null;

    return {
      status: STATUS_FAILED,
      shotId: snapshot.shotId || null,
      analysisId: input.analysisId || null,
      engineVersion: engineVersion || input.engineVersion || ENGINE_VERSION,
      toleranceProfileVersion: profile ? profile.version : null,
      processedAt: processedAt,

      rawPosition: rawPosition,
      selectedAnalyticalPosition: rawPosition,
      selectedVariant: VARIANT_RAW,

      normalisationApplied: false,
      normalisationType: null,
      normalisationConfidence: null,

      rawBubbleFitScore: null,
      selectedBubbleFitScore: null,
      bubbleFitImprovement: 0,

      userSelectedWind: snapshot.userSelectedWind === true,
      userSelectedSlope: snapshot.userSelectedSlope === true,

      windEvidence: null,
      slopeEvidence: null,

      candidateVariants: [],
      processingWarnings: (warnings || []).concat(errors),
      debugFlags: { errors: errors },
      errors: errors
    };
  }

  var api = {
    ENGINE_VERSION: ENGINE_VERSION,
    VARIANT_RAW: VARIANT_RAW,
    VARIANT_WIND: VARIANT_WIND,
    VARIANT_SLOPE: VARIANT_SLOPE,
    VARIANT_COMBINED: VARIANT_COMBINED,
    STATUS_OK: STATUS_OK,
    STATUS_FAILED: STATUS_FAILED,
    STATUS_UNAVAILABLE: STATUS_UNAVAILABLE,
    analyse: analyse,
    analyze: analyse,
    windEffectMetres: windEffectMetres,
    validateInput: validateInput
  };

  root.modules.conditionsEngine = api;
  window.GolfDaddyConditionsEngine = api;
  window.ClarityCaddieConditionsEngine = api;
  if (window.ClarityCaddie) window.ClarityCaddie.modules = root.modules;
})();
