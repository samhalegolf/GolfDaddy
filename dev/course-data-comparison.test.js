/*
  Course Bubble / Comparison Layer — selects between the raw and the normalised
  position when comparing Course Data against My Bubble, without ever destroying
  raw. Run: node dev/course-data-comparison.test.js
*/

const assert = require("assert");
const h = require("./conditions-engine-harness");

function approx(actual, expected, tolerance, message) {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${message} (expected ~${expected}, got ${actual})`
  );
}

/*
  A course record as gd-shot-cluster-analysis.js normalizeRecord builds it:
  errors are expressed against the planned bubble centre, in the bubble's
  orientation frame. The shot finished 13.1625 m west (left) of the centre --
  exactly the crosswind displacement the engine will back out, derived from the
  harness so the two stay in step when the wind model is tuned.
*/
const RAW_LATERAL_M = -h.EXPECTED_WIND_EFFECT_M;
function courseRecord(overrides) {
  return Object.assign({
    shotId: "shot-compare",
    club: "7i",
    expectedDistanceM: 150,
    actualDistanceM: 150,
    lateralM: RAW_LATERAL_M,
    depthM: 0,
    counted: true
  }, overrides || {});
}

function seedAnalysedShot(harness, shotId, snapshotOverrides) {
  const snap = h.snapshot(Object.assign({
    shotId: shotId,
    shotLandingPosition: h.landingOffset(-h.EXPECTED_WIND_EFFECT_M, 0)
  }, snapshotOverrides || {}));
  harness.intake.submitShotSnapshot(snap);
  harness.flushTimers();
  return snap;
}

// The engine's frame matches the course record's frame. This is the assumption
// the whole layer rests on, so it is asserted directly rather than implied.
{
  const harness = h.load();
  seedAnalysedShot(harness, "shot-compare", h.liveWind());
  const analysis = harness.intake.getActiveAnalysis("shot-compare");

  approx(
    analysis.rawBubbleFit.lateralError,
    courseRecord().lateralM,
    0.01,
    "engine raw lateral error matches the course record's lateralM, same sign and frame"
  );
  approx(
    analysis.rawBubbleFit.longitudinalError,
    courseRecord().depthM,
    0.01,
    "engine raw longitudinal error matches the course record's depthM"
  );
}

// A normalised shot compares on the normalised position, with raw preserved.
{
  const harness = h.load();
  seedAnalysedShot(harness, "shot-compare", h.liveWind());

  const record = courseRecord();
  const values = harness.comparison.comparisonValues(record);

  assert.strictEqual(values.normalisationApplied, true, "normalisation is used for the comparison");
  assert.strictEqual(values.normalisationType, "windNormalised", "the normalisation type is reported");
  approx(values.lateralM, 0, 0.01, "the comparison plots the wind-normalised lateral position");
  approx(values.actualDistanceM, 150, 0.01, "the comparison plots the normalised distance");

  // Raw survives on the same point.
  approx(values.rawLateralM, RAW_LATERAL_M, 0.01, "raw lateral is preserved alongside the normalised value");
  approx(values.rawActualDistanceM, 150, 0.01, "raw distance is preserved");
  assert.strictEqual(record.lateralM, RAW_LATERAL_M, "the source record is not mutated");
}

// No analysis at all: the comparison behaves exactly as it did before.
{
  const harness = h.load();
  const values = harness.comparison.comparisonValues(courseRecord({ shotId: "shot-unanalysed" }));

  assert.strictEqual(values.normalisationApplied, false, "an unanalysed record compares raw");
  assert.strictEqual(values.conditions, null, "no conditions block is attached");
  approx(values.lateralM, RAW_LATERAL_M, 0.01, "raw lateral is used");
  approx(values.actualDistanceM, 150, 0.01, "raw distance is used");
}

// Analysis ran but rejected normalisation: compare raw, and say why.
{
  const harness = h.load();
  // Raw already sits dead centre, so every candidate fails the fit-improvement
  // safeguard and raw stays selected.
  seedAnalysedShot(harness, "shot-rejected", Object.assign(h.liveWind(), {
    shotLandingPosition: h.landingOffset(0, 0)
  }));

  const values = harness.comparison.comparisonValues(courseRecord({ shotId: "shot-rejected" }));

  assert.strictEqual(values.normalisationApplied, false, "a rejected normalisation compares raw");
  assert.strictEqual(values.conditions.status, "ok", "the analysis itself succeeded");
  assert.strictEqual(
    values.conditions.unavailableReason,
    "NORMALISATION_NOT_APPLIED",
    "the layer reports that the engine declined to normalise"
  );
  approx(values.lateralM, RAW_LATERAL_M, 0.01, "raw lateral is used");
}

// A failed analysis compares raw and is labelled as failed.
{
  const harness = h.load();
  harness.modules.conditionsEngine.analyse = function () { throw new Error("BOOM"); };
  seedAnalysedShot(harness, "shot-failed", h.liveWind());

  const values = harness.comparison.comparisonValues(courseRecord({ shotId: "shot-failed" }));

  assert.strictEqual(values.normalisationApplied, false, "a failed analysis compares raw");
  assert.strictEqual(values.conditions.status, "failed", "the failure is visible to the comparison layer");
  assert.strictEqual(values.conditions.unavailableReason, "ANALYSIS_FAILED", "the reason is machine readable");
  approx(values.lateralM, RAW_LATERAL_M, 0.01, "raw lateral is used after a failure");
}

// The normalisation preference switches the comparison back to raw.
{
  const harness = h.load();
  seedAnalysedShot(harness, "shot-compare", h.liveWind());

  assert.strictEqual(harness.comparison.isNormalisationEnabled(), true, "normalisation is on by default");
  approx(
    harness.comparison.comparisonValues(courseRecord()).lateralM,
    0,
    0.01,
    "normalised while enabled"
  );

  harness.comparison.setNormalisationEnabled(false);
  assert.strictEqual(harness.comparison.isNormalisationEnabled(), false, "the preference persists");

  const off = harness.comparison.comparisonValues(courseRecord());
  assert.strictEqual(off.normalisationApplied, false, "normalisation is not applied while disabled");
  approx(off.lateralM, RAW_LATERAL_M, 0.01, "raw lateral is used while disabled");
  assert.strictEqual(
    off.conditions.available,
    true,
    "the analysis is still attached, only the selection changed"
  );

  harness.comparison.setNormalisationEnabled(true);
  approx(harness.comparison.comparisonValues(courseRecord()).lateralM, 0, 0.01, "re-enabling restores normalisation");

  // An explicit override beats the stored preference, for side-by-side views.
  approx(
    harness.comparison.comparisonValues(courseRecord(), { useNormalised: false }).lateralM,
    RAW_LATERAL_M,
    0.01,
    "an explicit override forces raw"
  );
}

// Enrichment is non-mutating and reusable.
{
  const harness = h.load();
  seedAnalysedShot(harness, "shot-compare", h.liveWind());

  const record = courseRecord();
  const enriched = harness.comparison.enrichCourseRecord(record);

  assert.notStrictEqual(enriched, record, "enrichment returns a copy");
  assert.strictEqual(record.conditions, undefined, "the source record is untouched");
  assert.strictEqual(enriched.conditions.normalisationApplied, true, "the copy carries the conditions block");
  assert.strictEqual(enriched.lateralM, RAW_LATERAL_M, "the copy keeps its raw fields");

  // comparisonValues reuses an attached block rather than re-reading storage.
  approx(harness.comparison.comparisonValues(enriched).lateralM, 0, 0.01, "an enriched record compares normalised");

  const all = harness.comparison.enrichCourseRecords([record, courseRecord({ shotId: "shot-none" })]);
  assert.strictEqual(all.length, 2, "every record is enriched");
  assert.strictEqual(all[1].conditions, null, "a record with no analysis gets a null block");
}

// Diagnostics summary counts what was normalised and what fell back.
{
  const harness = h.load();
  seedAnalysedShot(harness, "shot-normalised", h.liveWind());
  seedAnalysedShot(harness, "shot-rejected", Object.assign(h.liveWind(), {
    shotLandingPosition: h.landingOffset(0, 0)
  }));

  const summary = harness.comparison.summarise([
    courseRecord({ shotId: "shot-normalised" }),
    courseRecord({ shotId: "shot-rejected" }),
    courseRecord({ shotId: "shot-none" })
  ]);

  assert.strictEqual(summary.total, 3, "every record is counted");
  assert.strictEqual(summary.normalised, 1, "one record compared normalised");
  assert.strictEqual(summary.raw, 2, "two records fell back to raw");
  assert.strictEqual(summary.noAnalysis, 1, "the unanalysed record is identified");
}

// Option C: the bias readout that decides rescue-only vs symmetric.
{
  const harness = h.load();

  // One rescue: wind pushed it out, correcting brings it back in.
  seedAnalysedShot(harness, "shot-rescued", h.liveWind());

  // One demotion: raw landed inside, correcting pushes it out. Rescue-only
  // leaves it as a hit.
  seedAnalysedShot(harness, "shot-demoted", Object.assign(h.liveWind(), {
    shotLandingPosition: h.landingOffset(5, 0)
  }));

  // One untouched by wind.
  seedAnalysedShot(harness, "shot-neutral", { shotLandingPosition: h.landingOffset(1, 0) });

  const rescued = harness.comparison.comparisonValues(courseRecord({ shotId: "shot-rescued" }));
  const demoted = harness.comparison.comparisonValues(
    courseRecord({ shotId: "shot-demoted", lateralM: 5, actualDistanceM: 150 })
  );

  assert.strictEqual(rescued.normalisationApplied, true, "the rescued shot compares normalised");
  assert.strictEqual(
    demoted.normalisationApplied,
    false,
    "the demoted shot still compares raw under rescue-only"
  );
  approx(demoted.lateralM, 5, 0.01, "the wind-assisted hit keeps its raw position");
  assert.strictEqual(
    demoted.conditions.wouldDemoteUnderSymmetric,
    true,
    "but the record knows a symmetric policy would have moved it out"
  );

  const readout = harness.comparison.biasReadout([
    courseRecord({ shotId: "shot-rescued" }),
    courseRecord({ shotId: "shot-demoted", lateralM: 5 }),
    courseRecord({ shotId: "shot-neutral", lateralM: 1 })
  ]);

  assert.strictEqual(readout.policy, "rescue-only", "the readout names the active policy");
  assert.strictEqual(readout.total, 3, "every analysed record is counted");
  assert.strictEqual(readout.rescued, 1, "one shot was pulled into the bubble");
  assert.strictEqual(readout.wouldDemote, 1, "one shot would have been pushed out");
  assert.strictEqual(readout.netBias, 0, "net bias is rescues minus demotions");

  // The summary carries the same signal for the plotted set.
  const summary = harness.comparison.summarise([
    courseRecord({ shotId: "shot-rescued" }),
    courseRecord({ shotId: "shot-demoted", lateralM: 5 })
  ]);
  assert.strictEqual(summary.normalised, 1, "one record compared normalised");
  assert.strictEqual(summary.wouldDemoteUnderSymmetric, 1, "one record would demote under symmetric");
}

// The comparison layer stays neutral: selection and labels only.
{
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "course-data", "gd-course-data-comparison.js"),
    "utf8"
  );

  ["recommend", "should", "you ", "coach", "advice", "insight"].forEach((phrase) => {
    const literals = (source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
      .match(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g) || []).map((raw) => raw.slice(1, -1).toLowerCase());
    literals.forEach((literal) => {
      assert(
        literal.indexOf(phrase) === -1,
        `comparison layer must not emit copy ("${phrase}" in "${literal}")`
      );
    });
  });

  // It must not re-derive normalisation or re-score Bubble fit.
  ["evaluateBubbleFit", "windEffectMetres", "adjustmentVector", "analyse("].forEach((token) => {
    assert(
      !source.includes(token),
      `comparison layer must not re-implement engine logic ("${token}")`
    );
  });
}

console.log("course-data-comparison tests passed");
