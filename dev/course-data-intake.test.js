/*
  Course Data intake — snapshot immutability, idempotency, non-blocking
  submission, failure fallback, historical reprocessing and bubble version
  pinning. Run: node dev/course-data-intake.test.js
*/

const assert = require("assert");
const h = require("./conditions-engine-harness");

// 12. Conditions Engine failure still saves the raw shot.
{
  const harness = h.load();
  harness.modules.conditionsEngine.analyse = function () {
    throw new Error("SIMULATED_ENGINE_FAILURE");
  };

  const snap = h.snapshot(Object.assign(h.liveWind(), {
    shotId: "shot-engine-failure",
    shotLandingPosition: h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, 0)
  }));

  const submission = harness.intake.submitShotSnapshot(snap);
  assert.strictEqual(submission.accepted, true, "submission is accepted despite the engine being broken");
  harness.flushTimers();

  const stored = harness.intake.getSnapshot("shot-engine-failure");
  assert(stored, "raw snapshot survives an engine failure");
  assert.strictEqual(stored.shotLandingPosition.lng, snap.shotLandingPosition.lng, "raw landing position is intact");

  const record = harness.intake.getActiveAnalysis("shot-engine-failure");
  assert(record, "a failed analysis record is still written");
  assert.strictEqual(record.status, "failed", "analysis status is failed");
  assert.strictEqual(record.selectedVariant, "raw", "raw is the active outcome after a failure");
  assert.strictEqual(record.normalisationApplied, false, "no normalisation applied after a failure");
  assert.strictEqual(
    record.debugFlags.errorMessage,
    "SIMULATED_ENGINE_FAILURE",
    "the error is stored as debug context rather than hidden"
  );
  assert(
    record.processingWarnings.indexOf("CONDITIONS_ENGINE_THREW") !== -1,
    "the failure is recorded for later reprocessing"
  );
  assert(harness.intake.listFailures()["shot-engine-failure"], "the shot is queued in the failure list");
}

// 13. Historical reprocessing creates a new analysis record without changing
//     the snapshot, and preserves every earlier record.
{
  const harness = h.load();
  const snap = h.snapshot(Object.assign(h.liveWind(), {
    shotId: "shot-reprocess",
    shotLandingPosition: h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, 0)
  }));

  harness.intake.submitShotSnapshot(snap);
  harness.flushTimers();

  const before = JSON.stringify(harness.intake.getSnapshot("shot-reprocess"));
  const first = harness.intake.getActiveAnalysis("shot-reprocess");
  assert.strictEqual(harness.intake.listAnalyses("shot-reprocess").length, 1, "one analysis after intake");

  const reprocessed = harness.intake.reprocessShot("shot-reprocess", {
    engineVersion: "1.0.0",
    toleranceProfileVersion: "1.0.0",
    markActive: true
  });

  assert.strictEqual(reprocessed.ok, true, "reprocessing succeeds");
  assert.notStrictEqual(reprocessed.analysisId, first.analysisId, "reprocessing mints a new analysis id");

  const all = harness.intake.listAnalyses("shot-reprocess");
  assert.strictEqual(all.length, 2, "the earlier analysis record is preserved");
  assert(all.some((r) => r.analysisId === first.analysisId), "the original record is still present");

  assert.strictEqual(
    JSON.stringify(harness.intake.getSnapshot("shot-reprocess")),
    before,
    "the raw snapshot is byte-identical after reprocessing"
  );
  assert.strictEqual(
    harness.intake.getActiveAnalysis("shot-reprocess").analysisId,
    reprocessed.analysisId,
    "the new record can be marked active"
  );

  // Reprocessing without markActive must leave the active interpretation alone.
  const passive = harness.intake.reprocessShot("shot-reprocess", {});
  assert.strictEqual(harness.intake.listAnalyses("shot-reprocess").length, 3, "a third record is stored");
  assert.strictEqual(
    harness.intake.getActiveAnalysis("shot-reprocess").analysisId,
    reprocessed.analysisId,
    "the active record is unchanged when markActive is not set"
  );
  assert.strictEqual(passive.ok, true, "passive reprocessing still reports success");
}

// 14. A historical shot uses its linked My Bubble version, not the current one.
{
  const harness = h.load();

  // The bubble that was live when the shot was played.
  const historical = harness.intake.registerMyBubbleVersion(h.bubble({ versionId: null, club: "7i" }));
  assert(historical && historical.versionId, "the historical bubble version is registered");

  // A later, very different My Bubble. Registering it must not disturb the
  // earlier version, and must never be picked up by the historical shot.
  const current = harness.intake.registerMyBubbleVersion(
    h.bubble({ versionId: null, club: "7i", widthM: 90, depthM: 120, centerLat: h.north(210) })
  );
  assert.notStrictEqual(current.versionId, historical.versionId, "the two bubbles get distinct version ids");

  // Snapshot pins the version id only, forcing resolution through the registry.
  const snap = h.snapshot(Object.assign(h.liveWind(), {
    shotId: "shot-historical-bubble",
    shotLandingPosition: h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, 0),
    myBubbleVersionId: historical.versionId,
    myBubbleGeometry: null
  }));

  harness.intake.submitShotSnapshot(snap);
  harness.flushTimers();

  const record = harness.intake.getActiveAnalysis("shot-historical-bubble");
  assert.strictEqual(record.status, "ok", "analysis ran against the linked version");
  assert.strictEqual(record.myBubbleVersionId, historical.versionId, "the analysis records the historical version");

  // Against the historical 20 x 30 bubble the raw landing is 1.35 radii out.
  // Against the current 90 x 120 bubble it would have been comfortably inside,
  // so this assertion is what proves the newer bubble was not used.
  assert.strictEqual(record.rawBubbleFit.insideBubble, false, "raw is outside the historical bubble");
  assert(
    Math.abs(record.rawBubbleFit.score - 0.341875) < 0.001,
    "raw fit score matches the historical bubble geometry, not the current one"
  );
  assert.strictEqual(record.selectedVariant, "windNormalised", "normalisation is judged against the historical bubble");

  assert.strictEqual(
    harness.intake.getMyBubbleVersion(historical.versionId).geometry.widthM,
    20,
    "the historical bubble geometry is unchanged by the newer registration"
  );
}

// 16. GPS Play does not block while Course Data analysis is running.
{
  const harness = h.load();
  const snap = h.snapshot(Object.assign(h.liveWind(), {
    shotId: "shot-non-blocking",
    shotLandingPosition: h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, 0)
  }));

  const submission = harness.intake.submitShotSnapshot(snap);

  assert.strictEqual(submission.accepted, true, "submission returns accepted");
  assert.strictEqual(submission.analysisScheduled, true, "analysis is scheduled, not executed inline");
  assert.strictEqual(harness.pendingTimers.length, 1, "analysis is deferred to a later tick");

  // The durable part is synchronous: the raw shot is saved before we return.
  assert(harness.intake.getSnapshot("shot-non-blocking"), "raw snapshot is persisted synchronously");
  assert.strictEqual(
    harness.intake.getActiveAnalysis("shot-non-blocking"),
    null,
    "no analysis record exists until the deferred tick runs"
  );

  harness.flushTimers();
  assert(harness.intake.getActiveAnalysis("shot-non-blocking"), "analysis lands once the tick runs");
}

// 17. Duplicate submission of the same Shot Snapshot is idempotent.
{
  const harness = h.load();
  const snap = h.snapshot(Object.assign(h.liveWind(), {
    shotId: "shot-duplicate",
    shotLandingPosition: h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, 0)
  }));

  const first = harness.intake.submitShotSnapshot(snap);
  harness.flushTimers();
  const afterFirst = JSON.stringify(harness.intake.getSnapshot("shot-duplicate"));
  const analysesAfterFirst = harness.intake.listAnalyses("shot-duplicate").length;

  const second = harness.intake.submitShotSnapshot(snap);
  harness.flushTimers();

  assert.strictEqual(first.duplicate, false, "the first submission is not a duplicate");
  assert.strictEqual(second.accepted, true, "the repeat submission is still accepted");
  assert.strictEqual(second.duplicate, true, "the repeat submission is reported as a duplicate");
  assert.strictEqual(second.conflict, false, "identical content is not a conflict");
  assert.strictEqual(second.analysisScheduled, false, "a duplicate does not schedule a second analysis");
  assert.strictEqual(
    harness.intake.listAnalyses("shot-duplicate").length,
    analysesAfterFirst,
    "no extra analysis record is created by the duplicate"
  );
  assert.strictEqual(
    JSON.stringify(harness.intake.getSnapshot("shot-duplicate")),
    afterFirst,
    "the stored raw snapshot is unchanged"
  );
  assert.strictEqual(harness.intake.listSnapshots().length, 1, "only one snapshot is stored");

  // A different payload under the same shotId must not overwrite the original.
  const conflicting = harness.intake.submitShotSnapshot(
    h.snapshot({ shotId: "shot-duplicate", shotLandingPosition: h.landingOffset(40, 40) })
  );
  assert.strictEqual(conflicting.conflict, true, "a conflicting re-submission is flagged");
  assert.strictEqual(
    JSON.stringify(harness.intake.getSnapshot("shot-duplicate")),
    afterFirst,
    "the immutable raw snapshot is never overwritten"
  );
}

// Raw snapshots are frozen in memory as well as on disk.
{
  const harness = h.load();
  const snap = h.snapshot({ shotId: "shot-frozen" });
  harness.intake.submitShotSnapshot(snap, { analyse: false });

  const stored = harness.intake.getSnapshot("shot-frozen");
  stored.shotLandingPosition = { lat: 99, lng: 99 };
  assert.strictEqual(
    harness.intake.getSnapshot("shot-frozen").shotLandingPosition.lat,
    snap.shotLandingPosition.lat,
    "mutating a returned snapshot cannot affect the stored raw snapshot"
  );
}

// Older records without a linked bubble are marked unavailable, never analysed
// against today's My Bubble and never given invented evidence.
{
  const harness = h.load();
  const snap = h.snapshot({
    shotId: "shot-legacy",
    myBubbleVersionId: null,
    myBubbleGeometry: null
  });

  harness.intake.submitShotSnapshot(snap);
  harness.flushTimers();

  const record = harness.intake.getActiveAnalysis("shot-legacy");
  assert.strictEqual(record.status, "unavailable", "legacy records are marked unavailable");
  assert.strictEqual(record.normalisationApplied, false, "legacy records get no normalisation");
  assert.strictEqual(record.selectedVariant, "raw", "the legacy raw outcome is left intact");
  assert.strictEqual(record.windEvidence, null, "no environmental evidence is invented");
  assert(
    record.processingWarnings.indexOf("ENVIRONMENTAL_REPROCESSING_UNAVAILABLE") !== -1,
    "reprocessing is explicitly marked unavailable"
  );
}

// The Recommendations Engine handoff carries neutral evidence only.
{
  const harness = h.load();
  const snap = h.snapshot(Object.assign(h.liveWind(), {
    shotId: "shot-handoff",
    shotLandingPosition: h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, 0),
    userSelectedWind: true,
    userWindSelection: { scaleLevel: 1, directionDeg: 90 }
  }));

  harness.intake.submitShotSnapshot(snap);
  harness.flushTimers();

  const handoff = harness.intake.buildRecommendationsHandoff("shot-handoff");
  assert(handoff, "a handoff payload is produced");
  assert.strictEqual(handoff.normalisationApplied, true, "handoff reports normalisation state");
  assert.strictEqual(handoff.userSelectedWind, true, "handoff reports the user selection flag");
  assert.strictEqual(handoff.clubId, "7i", "handoff carries the club");
  assert.strictEqual(handoff.holeNumber, 7, "handoff carries the hole number");
  assert(handoff.selectedVersusLiveWindDifference, "handoff carries the selected-versus-live difference");
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(handoff, "message"),
    false,
    "handoff contains no copy field"
  );
}

// The diagnostic surface stays closed without admin or coach permission.
{
  const closed = h.load();
  closed.intake.submitShotSnapshot(h.snapshot({ shotId: "shot-debug" }));
  closed.flushTimers();
  assert.strictEqual(
    closed.debug.getDebugPayload("shot-debug").available,
    false,
    "debug payload is withheld without permission"
  );

  const open = h.load({ gdCourseDataCanManage: () => true });
  open.intake.submitShotSnapshot(
    h.snapshot(Object.assign(h.liveWind(), {
      shotId: "shot-debug",
      shotLandingPosition: h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, 0)
    }))
  );
  open.flushTimers();

  const payload = open.debug.getDebugPayload("shot-debug");
  assert.strictEqual(payload.available, true, "debug payload is available to admin or coach");
  assert(payload.shotSnapshot, "debug exposes the raw snapshot");
  assert(payload.toleranceProfile, "debug exposes the tolerance profile used");
  assert(payload.generatedVectors.liveWind, "debug exposes the generated vectors");
  assert(payload.bubbleFitByCandidate.length >= 2, "debug exposes bubble fit for every candidate");
  assert.strictEqual(payload.selectionReason, "SAFEGUARDS_PASSED_AND_FIT_IMPROVED", "debug states why a variant won");
  assert(payload.analysisHistory.length >= 1, "debug exposes the analysis history");
}

console.log("course-data-intake tests passed");
