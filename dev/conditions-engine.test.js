/*
  Conditions Engine — significance gates, variant generation, safeguards and
  neutrality. Run: node dev/conditions-engine.test.js
*/

const assert = require("assert");
const h = require("./conditions-engine-harness");

const harness = h.load();
const profile = harness.tolerances.latest();

function approx(actual, expected, tolerance, message) {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${message} (expected ~${expected}, got ${actual})`
  );
}

// 1. Wind at or below level 1 is effectively neutral: no wind variant.
{
  const snap = h.snapshot(Object.assign(h.liveWind({ liveWindScaleLevel: 1 }), {
    shotLandingPosition: h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, 0)
  }));
  const result = h.analyse(harness, snap);

  assert.strictEqual(h.variantOf(result, "windNormalised"), null, "level 1 wind creates no wind variant");
  assert.strictEqual(result.selectedVariant, "raw", "level 1 wind leaves raw selected");
  assert.strictEqual(result.normalisationApplied, false, "level 1 wind applies no normalisation");
  assert(
    result.windEvidence.gateFailures.indexOf("WIND_SCALE_BELOW_THRESHOLD") !== -1,
    "level 1 wind records the scale gate failure"
  );
}

// 2. Wind above level 1 with no user selection creates a wind candidate.
{
  const snap = h.snapshot(Object.assign(h.liveWind(), {
    shotLandingPosition: h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, 0)
  }));
  const result = h.analyse(harness, snap);
  const wind = h.variantOf(result, "windNormalised");

  assert(wind, "level 2 wind creates a wind candidate");
  assert.strictEqual(result.userSelectedWind, false, "wind was not user selected");
  approx(wind.adjustmentMagnitude, h.EXPECTED_WIND_EFFECT_M, 0.01, "wind adjustment magnitude matches the model");
  approx(wind.adjustmentVector.bearingDeg, 90, 0.01, "wind correction points back into the wind");
  approx(wind.adjustmentVector.lateral, h.EXPECTED_WIND_EFFECT_M, 0.01, "wind correction is lateral to a due-north shot");
  approx(wind.adjustmentVector.forward, 0, 0.01, "crosswind correction has no along-line component");
}

// 3. Wind candidate is rejected when confidence is too low.
{
  const snap = h.snapshot(Object.assign(h.liveWind({ liveWindConfidence: "low" }), {
    shotLandingPosition: h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, 0)
  }));
  const result = h.analyse(harness, snap);

  assert.strictEqual(h.variantOf(result, "windNormalised"), null, "low confidence wind creates no candidate");
  assert.strictEqual(result.selectedVariant, "raw", "low confidence wind leaves raw selected");
  assert(
    result.windEvidence.gateFailures.indexOf("WIND_CONFIDENCE_BELOW_MINIMUM") !== -1,
    "low confidence wind records the confidence gate failure"
  );
}

// 4. Wind candidate is rejected when Bubble fit improvement is below tolerance.
//    Raw already sits dead centre, so normalising can only move it away.
{
  const snap = h.snapshot(Object.assign(h.liveWind(), {
    shotLandingPosition: h.landingOffset(0, 0)
  }));
  const result = h.analyse(harness, snap);
  const wind = h.variantOf(result, "windNormalised");

  assert(wind, "candidate is still generated so the rejection is inspectable");
  assert.strictEqual(result.selectedVariant, "raw", "raw stays selected when fit does not improve");
  assert.strictEqual(result.normalisationApplied, false, "no normalisation applied");
  assert(
    wind.rejectionReason.indexOf("BUBBLE_FIT_IMPROVEMENT_BELOW_MINIMUM") !== -1,
    "rejection names the fit improvement safeguard"
  );
  assert(wind.bubbleFitImprovement < profile.minimumBubbleFitImprovement, "improvement is below tolerance");
}

// 5. Wind candidate is rejected when the correction exceeds the maximum range.
//    A headwind is the only case that can reach the cap under 1.1.0: at 260 m
//    carry, level 3 gives 11.7 x 3 = 35.1 m along the line, over the 25 m cap.
//    The same wind across the line would be 35.1 x 0.65 = 22.8 m and allowed.
{
  const longShot = 260;
  const snap = h.snapshot(Object.assign(h.headWind(), {
    shotDistance: longShot,
    shotLandingPosition: h.landingOffset(0, -35.1)
  }));
  const result = h.analyse(harness, snap);
  const wind = h.variantOf(result, "windNormalised");

  assert(wind, "an over-range candidate is still generated");
  assert(
    wind.adjustmentMagnitude > profile.maximumCorrectionDistanceMetres,
    "fixture exceeds the configured maximum correction distance"
  );
  assert(
    wind.rejectionReason.indexOf("CORRECTION_EXCEEDS_MAXIMUM_DISTANCE") !== -1,
    "rejection names the maximum distance safeguard"
  );
  assert.strictEqual(result.selectedVariant, "raw", "over-range correction leaves raw selected");
}

// 6. Wind selected by the user preserves both selected and live evidence.
{
  const snap = h.snapshot(Object.assign(h.liveWind(), {
    shotLandingPosition: h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, 0),
    userSelectedWind: true,
    userWindSelection: { scaleLevel: 1, directionDeg: 90 },
    userWindIntent: "manual-wind-tool"
  }));
  const result = h.analyse(harness, snap);
  const evidence = result.windEvidence;

  assert.strictEqual(result.userSelectedWind, true, "user selection is preserved");
  assert.strictEqual(evidence.windWasUserSelected, true, "evidence records the user selection");
  // Selected level 1 across the line: 6.75 x 0.65 = 4.3875.
  // Live level 3 across the line:     20.25 x 0.65 = 13.1625.
  approx(evidence.selectedWindAdjustmentVector.magnitudeM, h.WIND_BASE_M * 1 * h.WIND_FACTORS.cross, 0.01, "selected level 1 adjustment retained");
  approx(evidence.liveWindAdjustmentVector.magnitudeM, h.EXPECTED_WIND_EFFECT_M, 0.01, "live level 3 adjustment retained");
  approx(evidence.windAdjustmentDifferenceVector.magnitudeM, h.EXPECTED_WIND_EFFECT_M - h.WIND_BASE_M * h.WIND_FACTORS.cross, 0.01, "difference between selected and live retained");
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(evidence.userWindSelection)),
    { scaleLevel: 1, directionDeg: 90 },
    "raw user selection is carried through untouched"
  );
  // The selected value is evidence, not truth: normalisation still backs out
  // the live wind that physically acted on the ball.
  approx(
    h.variantOf(result, "windNormalised").adjustmentMagnitude,
    h.EXPECTED_WIND_EFFECT_M,
    0.01,
    "normalisation uses live wind, not the selected value"
  );
}

// 7. Slope below the significance threshold produces no slope variant.
{
  const snap = h.snapshot(Object.assign(h.liveSlope({ liveSlopeValue: 1 }), {
    shotLandingPosition: h.landingOffset(0, -1)
  }));
  const result = h.analyse(harness, snap);

  assert.strictEqual(h.variantOf(result, "slopeNormalised"), null, "sub-threshold slope creates no variant");
  assert(
    result.slopeEvidence.gateFailures.indexOf("SLOPE_EFFECT_BELOW_MINIMUM") !== -1,
    "sub-threshold slope records the effect gate failure"
  );
  assert.strictEqual(result.selectedVariant, "raw", "sub-threshold slope leaves raw selected");
}

// 8. Slope above the threshold creates a slope candidate.
{
  const snap = h.snapshot(Object.assign(h.liveSlope(), {
    shotLandingPosition: h.landingOffset(0, -8)
  }));
  const result = h.analyse(harness, snap);
  const slope = h.variantOf(result, "slopeNormalised");

  assert(slope, "8 m of rise creates a slope candidate");
  approx(slope.adjustmentMagnitude, 8, 0.01, "slope adjustment equals the elevation delta");
  approx(slope.adjustmentVector.forward, 8, 0.01, "uphill correction pushes the position further along the shot line");
  approx(slope.adjustmentVector.lateral, 0, 0.01, "slope correction has no lateral component");
  approx(slope.bubbleFitScore, 1, 0.001, "normalised slope position lands on the bubble centre");
}

// 9. Wind and slope together create a combined candidate.
{
  const snap = h.snapshot(Object.assign(h.liveWind(), h.liveSlope(), {
    shotLandingPosition: h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, -8)
  }));
  const result = h.analyse(harness, snap);
  const combined = h.variantOf(result, "combinedNormalised");

  assert(h.variantOf(result, "windNormalised"), "wind-only variant is retained");
  assert(h.variantOf(result, "slopeNormalised"), "slope-only variant is retained");
  assert(combined, "combined variant is generated");
  approx(combined.adjustmentVector.lateral, h.EXPECTED_WIND_EFFECT_M, 0.01, "combined carries the wind component");
  approx(combined.adjustmentVector.forward, 8, 0.01, "combined carries the slope component");
  approx(
    combined.adjustmentMagnitude,
    Math.sqrt(h.EXPECTED_WIND_EFFECT_M * h.EXPECTED_WIND_EFFECT_M + 64),
    0.01,
    "combined magnitude is the vector sum, not the scalar sum"
  );
  assert.strictEqual(result.selectedVariant, "combinedNormalised", "combined wins when it fits best");
  approx(combined.bubbleFitScore, 1, 0.001, "combined lands on the bubble centre");
  assert.strictEqual(result.debugFlags.combinedFromWindAndSlope, true, "combined provenance is flagged for debugging");
}

// 10. Raw remains selected when every candidate fails its safeguards.
{
  const snap = h.snapshot(Object.assign(h.liveWind(), h.liveSlope(), {
    shotLandingPosition: h.landingOffset(0, 0)
  }));
  const result = h.analyse(harness, snap);

  assert.strictEqual(result.selectedVariant, "raw", "raw survives when nothing improves the fit");
  assert.strictEqual(result.normalisationApplied, false, "no normalisation applied");
  assert.strictEqual(result.normalisationType, null, "no normalisation type recorded");
  assert.strictEqual(result.bubbleFitImprovement, 0, "improvement is zero when raw is selected");
  ["windNormalised", "slopeNormalised", "combinedNormalised"].forEach((type) => {
    const variant = h.variantOf(result, type);
    assert(variant && variant.rejectionReason, `${type} records why it was rejected`);
  });
}

// 11. A normalised variant is selected when it passes every safeguard and
//     materially improves the Bubble fit.
{
  const snap = h.snapshot(Object.assign(h.liveWind(), {
    shotLandingPosition: h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, 0)
  }));
  const result = h.analyse(harness, snap);
  const wind = h.variantOf(result, "windNormalised");

  assert.strictEqual(result.selectedVariant, "windNormalised", "wind variant is selected");
  assert.strictEqual(result.normalisationApplied, true, "normalisation is applied");
  assert.strictEqual(result.normalisationType, "windNormalised", "normalisation type recorded");
  assert.strictEqual(wind.rejectionReason, null, "selected variant has no rejection reason");
  assert.strictEqual(result.rawBubbleFit.insideBubble, false, "raw finished outside the bubble");
  assert.strictEqual(result.selectedBubbleFit.insideBubble, true, "normalised position sits inside the bubble");
  // 13.1625 m off centre against a 10 m half-width = 1.31625 radii,
  // so score = 1 - 1.31625/2 = 0.341875.
  approx(result.rawBubbleFitScore, 0.341875, 0.001, "raw fit score matches the 1.31625 normalised radius");
  approx(result.selectedBubbleFitScore, 1, 0.001, "normalised fit score is dead centre");
  assert(
    result.bubbleFitImprovement >= profile.minimumBubbleFitImprovement,
    "improvement clears the configured minimum"
  );
  approx(result.rawPosition.lng, h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, 0).lng, 1e-9, "raw position is unchanged");
}

// --- Profile 1.1.0: directional wind model -----------------------------------

// The along-line component is asymmetric: a headwind hurts more than an equal
// tailwind helps, and neither produces any lateral movement.
{
  const magnitude = h.WIND_BASE_M * 3;   // 20.25 m before factors

  const head = h.analyse(harness, h.snapshot(Object.assign(h.headWind(), {
    shotLandingPosition: h.landingOffset(0, -10)
  })));
  const headVector = h.variantOf(head, "windNormalised").adjustmentVector;

  const tail = h.analyse(harness, h.snapshot(Object.assign(h.tailWind(), {
    shotLandingPosition: h.landingOffset(0, 10)
  })));
  const tailVector = h.variantOf(tail, "windNormalised").adjustmentVector;

  approx(headVector.forward, magnitude * h.WIND_FACTORS.head, 0.01, "headwind applies the full hurting factor");
  approx(headVector.lateral, 0, 0.001, "a dead headwind produces no lateral movement");

  approx(tailVector.forward, -magnitude * h.WIND_FACTORS.tail, 0.01, "tailwind applies the smaller helping factor");
  approx(tailVector.lateral, 0, 0.001, "a dead tailwind produces no lateral movement");

  assert(
    Math.abs(headVector.forward) > Math.abs(tailVector.forward),
    "an equal headwind hurts more than the tailwind helps"
  );
}

// The crosswind gate: lateral stays suppressed until the wind is clearly across
// the shot line, then applies with its own factor.
{
  const magnitude = h.WIND_BASE_M * 3;

  function windAt(offLineDeg) {
    const snap = h.snapshot(Object.assign(h.liveWind({ liveWindDirection: offLineDeg }), {
      shotLandingPosition: h.landingOffset(-5, -5)
    }));
    const variant = h.variantOf(h.analyse(harness, snap), "windNormalised");
    return variant ? variant.adjustmentVector : null;
  }

  // Inside the gate: treated as a pure distance effect.
  const quartering = windAt(40);
  approx(quartering.lateral, 0, 0.001, "a 40 deg quartering wind produces no lateral correction");
  approx(quartering.forward, magnitude * Math.cos(40 * Math.PI / 180) * h.WIND_FACTORS.head, 0.01, "its distance effect still applies");
  assert.strictEqual(quartering.crosswindGateOpen, false, "the gate is recorded as closed");

  // Just outside the gate: lateral engages.
  const across = windAt(50);
  approx(
    across.lateral,
    magnitude * Math.sin(50 * Math.PI / 180) * h.WIND_FACTORS.cross,
    0.01,
    "a 50 deg wind engages the lateral component"
  );
  assert.strictEqual(across.crosswindGateOpen, true, "the gate is recorded as open");

  // The gate is symmetric about the shot line: a quartering TAILWIND at 140 deg
  // is 40 deg off the reverse line and stays closed.
  const quarteringTail = windAt(140);
  approx(quarteringTail.lateral, 0, 0.001, "a 140 deg quartering tailwind is also inside the gate");
  assert(quarteringTail.forward < 0, "and still applies its helping distance effect");

  // The budget is no longer conserved: a dead crosswind now displaces less than
  // a dead headwind of the same strength, which was the whole point.
  const cross = windAt(90);
  approx(cross.magnitudeM, magnitude * h.WIND_FACTORS.cross, 0.01, "a dead crosswind is scaled by the crosswind factor");
  assert(
    cross.magnitudeM < magnitude * h.WIND_FACTORS.head,
    "a crosswind displaces less than an equal headwind"
  );
}

// Profile 1.0.0 still reprocesses to its original conserved-budget behaviour:
// absent factors default to 1 and an absent gate to 0.
{
  const snap = h.snapshot(Object.assign(h.liveWind(), {
    shotLandingPosition: h.landingOffset(-13.5, 0)
  }));

  const legacy = harness.engine.analyse({
    shotSnapshot: snap,
    activeMyBubble: snap.myBubbleGeometry,
    toleranceProfileVersion: "1.0.0"
  });

  assert.strictEqual(legacy.toleranceProfileVersion, "1.0.0", "the older profile is still resolvable");
  approx(
    h.variantOf(legacy, "windNormalised").adjustmentMagnitude,
    h.WIND_BASE_M * 3,
    0.01,
    "1.0.0 keeps the unscaled conserved-budget magnitude"
  );

  const current = h.analyse(harness, snap);
  assert(
    h.variantOf(current, "windNormalised").adjustmentMagnitude < h.variantOf(legacy, "windNormalised").adjustmentMagnitude,
    "1.1.0 produces a smaller crosswind correction than 1.0.0"
  );
}

// --- Admin tuning derives a new profile version, never mutates a published one

{
  const tol = harness.tolerances;
  const base = tol.resolve("1.1.0");

  // No real change -> no new identity, so routine analysis does not accumulate
  // pointless version strings.
  assert.strictEqual(
    tol.derive(null, { crosswindFactor: base.windModel.crosswindFactor }).version,
    "1.1.0",
    "overrides identical to the base return the base profile unchanged"
  );
  assert.strictEqual(tol.derive(null, null).version, "1.1.0", "absent overrides return the base profile");

  // A real change mints a derived version.
  const tuned = tol.derive(null, { crosswindFactor: 0.4, crosswindGateDegrees: 75 });
  assert(/^1\.1\.0\+[0-9a-f]{8}$/.test(tuned.version), "a tuned profile carries a hashed version suffix");
  assert.strictEqual(tuned.derivedFrom, "1.1.0", "the derived profile records its base");
  assert.strictEqual(tuned.windModel.crosswindFactor, 0.4, "the override is applied");
  assert.strictEqual(tuned.windModel.crosswindGateDegrees, 75, "every override is applied");
  assert.strictEqual(tuned.windModel.carryFactor, base.windModel.carryFactor, "untouched values are inherited");

  // The published profile is untouched.
  assert.strictEqual(base.windModel.crosswindFactor, 0.65, "the base profile is not mutated");
  assert.strictEqual(tol.resolve("1.1.0").windModel.crosswindGateDegrees, 45, "the registry still returns the base");

  // Same overrides always hash to the same version: a profile is identified by
  // its contents, not by when it was edited.
  assert.strictEqual(
    tol.derive(null, { crosswindFactor: 0.4, crosswindGateDegrees: 75 }).version,
    tuned.version,
    "identical overrides produce an identical version"
  );
  assert.notStrictEqual(
    tol.derive(null, { crosswindFactor: 0.3 }).version,
    tuned.version,
    "different overrides produce a different version"
  );

  // A derived profile drives the analysis when handed to the engine directly.
  const snap = h.snapshot(Object.assign(h.liveWind(), {
    shotLandingPosition: h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, 0)
  }));
  const tunedResult = harness.engine.analyse({
    shotSnapshot: snap,
    activeMyBubble: snap.myBubbleGeometry,
    toleranceProfile: tol.derive(null, { crosswindFactor: 0.4 })
  });

  assert(/^1\.1\.0\+/.test(tunedResult.toleranceProfileVersion), "the analysis records the derived version");
  approx(
    h.variantOf(tunedResult, "windNormalised").adjustmentMagnitude,
    h.WIND_BASE_M * 3 * 0.4,
    0.01,
    "the tuned crosswind factor changes the correction"
  );

  // Raising the gate past the wind angle suppresses the lateral component
  // entirely, which is how a narrower "clearly across" window behaves.
  const gated = harness.engine.analyse({
    shotSnapshot: h.snapshot(Object.assign(h.liveWind({ liveWindDirection: 50 }), {
      shotLandingPosition: h.landingOffset(-5, -5)
    })),
    activeMyBubble: snap.myBubbleGeometry,
    toleranceProfile: tol.derive(null, { crosswindGateDegrees: 75 })
  });
  const gatedVector = h.variantOf(gated, "windNormalised").adjustmentVector;
  approx(gatedVector.lateral, 0, 0.001, "a 50 deg wind is inside a 75 deg gate, so no lateral applies");
  assert.strictEqual(gatedVector.crosswindGateOpen, false, "the tuned gate is recorded as closed");
}

// --- Option C: the symmetric counterfactual is recorded, never applied -------

// A crosswind that pushed the ball INTO the bubble. Raw sits 5 m right of
// centre (inside, half-width 10 m); backing the wind out puts it 18.5 m right
// (outside). Rescue-only must leave this as a hit while recording that a
// symmetric policy would not have.
{
  const snap = h.snapshot(Object.assign(h.liveWind(), {
    shotLandingPosition: h.landingOffset(5, 0)
  }));
  const result = h.analyse(harness, snap);
  const wind = h.variantOf(result, "windNormalised");
  const symmetric = result.symmetricEvaluation;

  // Selection is unchanged: rescue-only never demotes.
  assert.strictEqual(result.selectedVariant, "raw", "rescue-only leaves the wind-assisted hit as raw");
  assert.strictEqual(result.normalisationApplied, false, "no normalisation is applied");
  assert.strictEqual(symmetric.policy, "rescue-only", "the active policy is recorded");

  // But the counterfactual is fully recorded.
  assert.strictEqual(symmetric.rawInsideBubble, true, "raw finished inside the bubble");
  assert.strictEqual(wind.direction, "demotion", "the wind candidate is a demotion");
  assert.strictEqual(wind.physicallyValid, true, "the demotion is physically valid");
  assert.strictEqual(wind.variantInsideBubble, false, "the normalised position is outside the bubble");
  assert.strictEqual(wind.wouldApplyUnderSymmetric, true, "a symmetric policy would have applied it");
  assert.strictEqual(symmetric.wouldChangeUnderSymmetric, true, "the verdict would change under symmetric");

  assert(symmetric.demotionCandidate, "the demotion candidate is captured");
  assert.strictEqual(symmetric.demotionCandidate.variantType, "windNormalised", "the demoting variant is named");
  approx(result.rawBubbleFitScore, 0.75, 0.001, "raw fit score for a 0.5-radius position");
  // 5 + 13.1625 = 18.1625 m off centre = 1.81625 radii -> score 0.091875.
  approx(symmetric.demotionCandidate.bubbleFitScore, 0.091875, 0.001, "demoted fit score for a 1.81625-radius position");
  assert(symmetric.demotionCandidate.improvement < 0, "a demotion has a negative fit improvement");

  // The rejection still reads as a fit-improvement failure, unchanged.
  assert(
    wind.rejectionReason.indexOf("BUBBLE_FIT_IMPROVEMENT_BELOW_MINIMUM") !== -1,
    "the demotion is rejected on the improvement gate"
  );
}

// A rescue is labelled as such, and records no demotion candidate.
{
  const snap = h.snapshot(Object.assign(h.liveWind(), {
    shotLandingPosition: h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, 0)
  }));
  const result = h.analyse(harness, snap);
  const symmetric = result.symmetricEvaluation;

  assert.strictEqual(result.selectedVariant, "windNormalised", "the rescue is applied");
  assert.strictEqual(symmetric.rawInsideBubble, false, "raw finished outside");
  assert.strictEqual(h.variantOf(result, "windNormalised").direction, "rescue", "the candidate is a rescue");
  assert.strictEqual(symmetric.demotionCandidate, null, "no demotion candidate on a rescue");
  assert.strictEqual(symmetric.wouldChangeUnderSymmetric, false, "symmetric would reach the same verdict");
}

// A physically invalid correction is not counted as a demotion, even if it
// would move an inside shot out. Validity is assessed before direction.
{
  const snap = h.snapshot(Object.assign(h.headWind(), {
    shotDistance: 260,
    shotLandingPosition: h.landingOffset(0, 5)
  }));
  const result = h.analyse(harness, snap);
  const wind = h.variantOf(result, "windNormalised");

  assert(
    wind.adjustmentMagnitude > profile.maximumCorrectionDistanceMetres,
    "the correction is over the distance cap"
  );
  assert.strictEqual(wind.physicallyValid, false, "an over-range correction is not physically valid");
  assert.strictEqual(wind.wouldApplyUnderSymmetric, false, "symmetric would not apply it either");
  assert.strictEqual(
    result.symmetricEvaluation.demotionCandidate,
    null,
    "an invalid correction is never counted as a demotion"
  );
}

// 15. No Conditions Engine output contains recommendation or coaching copy.
{
  const snap = h.snapshot(Object.assign(h.liveWind(), h.liveSlope(), {
    shotLandingPosition: h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, -8),
    userSelectedWind: true,
    userWindSelection: { scaleLevel: 1, directionDeg: 90 }
  }));
  const result = h.analyse(harness, snap);

  const banned = [
    "you", "your", "should", "recommend", "suggest", "try", "consider",
    "club up", "club down", "misread", "did not allow", "didn't allow",
    "swing", "well done", "nice", "poor", "improve your",
    "advice", "coach", "practice more", "show this", "insight"
  ];

  // Word boundaries, not substrings: "try" must not match inside "asymmetry",
  // and "tip" must not match inside "multiple".
  const haystack = JSON.stringify(result).toLowerCase();
  banned.forEach((phrase) => {
    const pattern = new RegExp("\\b" + phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
    assert(
      !pattern.test(haystack),
      `engine output must not contain recommendation or coaching copy: "${phrase}"`
    );
  });

  // Everything human-readable in the output should be a machine code.
  (result.candidateVariants || []).forEach((variant) => {
    if (!variant.rejectionReason) return;
    variant.rejectionReason.split(",").forEach((code) => {
      assert(
        /^[A-Z0-9_]+$/.test(code),
        `rejection reasons must be machine codes, got "${code}"`
      );
    });
  });
  (result.processingWarnings || []).forEach((warning) => {
    assert(/^[A-Z0-9_]+$/.test(warning), `warnings must be machine codes, got "${warning}"`);
  });
}

console.log("conditions-engine tests passed");
