/*
  Course Transfer Score + implementation insight.
  Run: node dev/course-transfer-score.test.js

  Fixture bubble: centred at 0,0 with rx 10 and ry 20, untilted, so every
  expected radius is hand-checkable:
    r = sqrt((x / 10)^2 + (y / 20)^2)
  A point at { x: 12, y: 0 } therefore has r = 1.2 and needs a 120% bubble.

  Units are deliberately unnamed here, exactly as the module treats them. The
  Course Data graph hands in lateral degrees and depth as a percentage of carry;
  the maths is the same whatever the caller plots.
*/

const assert = require("assert");
const h = require("./conditions-engine-harness");

function approx(actual, expected, tolerance, message) {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${message} (expected ~${expected}, got ${actual})`
  );
}

const ELLIPSE = { cx: 0, cy: 0, rx: 10, ry: 20, tiltDeg: 0 };

/* A point at a chosen radius, laid out along the x-axis. */
function atRadius(r) {
  return { x: r * 10, y: 0 };
}

/* n points in one quadrant, comfortably inside so they never disturb coverage. */
function inQuadrant(quadrant, n) {
  const x = quadrant.indexOf("left") !== -1 ? -3 : 3;
  const y = quadrant.indexOf("short") !== -1 ? -6 : 6;
  return Array.from({ length: n }, () => ({ x, y }));
}

function mix(spec) {
  return Object.keys(spec).reduce((all, quadrant) => all.concat(inQuadrant(quadrant, spec[quadrant])), []);
}

const score = h.load().transferScore;
const insight = h.load().insight;

/* --------------------------------------------------------------------------
 * Geometry
 * ------------------------------------------------------------------------ */
{
  approx(score.radiusFor({ x: 5, y: 0 }, ELLIPSE), 0.5, 1e-9, "half a radius out");
  approx(score.radiusFor({ x: 0, y: 20 }, ELLIPSE), 1, 1e-9, "on the boundary at the top");
  approx(score.radiusFor({ x: 12, y: 0 }, ELLIPSE), 1.2, 1e-9, "12 on a 10 radius needs 120%");

  assert.strictEqual(
    score.isPointInsideScaledBubble({ x: 5, y: 0 }, ELLIPSE, 100), true,
    "a shot inside at 100% is inside"
  );
  assert.strictEqual(
    score.isPointInsideScaledBubble({ x: 12, y: 0 }, ELLIPSE, 100), false,
    "a shot outside at 100% is outside"
  );
  assert.strictEqual(
    score.isPointInsideScaledBubble({ x: 12, y: 0 }, ELLIPSE, 120), true,
    "and is inside at exactly the scale its radius demands"
  );

  // Scaling must not change the centre, the orientation or the proportions. If
  // it did, a point's radius would depend on the scale -- so asserting the
  // radius is scale-independent asserts all three at once.
  const point = { x: 7, y: -9 };
  const base = score.radiusFor(point, ELLIPSE);
  [100, 137, 200].forEach((pct) => {
    const scaled = { cx: 0, cy: 0, rx: 10 * pct / 100, ry: 20 * pct / 100, tiltDeg: 0 };
    approx(score.radiusFor(point, scaled) * (pct / 100), base, 1e-9,
      `growing to ${pct}% only rescales the radius, it does not reshape the bubble`);
  });

  // Tilt is honoured, and matches the rotation the graph itself uses to decide
  // which dots light up.
  const tilted = { cx: 0, cy: 0, rx: 10, ry: 20, tiltDeg: 90 };
  approx(score.radiusFor({ x: 0, y: 10 }, tilted), 1, 1e-9,
    "under a 90 degree tilt the short axis points up the chart");

  // The slider must never move a point.
  const dist = score.distribution([{ x: 7, y: -9 }], ELLIPSE);
  const before = { x: dist.points[0].x, y: dist.points[0].y };
  const after = score.analyse([{ x: 7, y: -9 }], ELLIPSE, { sliderScalePercent: 180 });
  assert.strictEqual(before.x, 7, "slider interaction leaves x alone");
  assert.strictEqual(before.y, -9, "slider interaction leaves y alone");
  assert.strictEqual(after.currentSliderScalePercent, 180, "the slider position is reported back untouched");
}

/* --------------------------------------------------------------------------
 * Coverage
 * ------------------------------------------------------------------------ */
{
  const points = [0.4, 0.6, 0.9, 1.1, 1.3, 1.6].map(atRadius);
  const dist = score.distribution(points, ELLIPSE);

  assert.strictEqual(score.calculateCoverage(dist, 100).inside, 3, "three of six inside at full size");
  approx(score.calculateCoverage(dist, 100).insidePercent, 50, 1e-9, "50% coverage at 100%");
  assert.strictEqual(score.calculateCoverage(dist, 130).inside, 5, "five inside at 130%");
  assert.strictEqual(score.calculateCoverage(dist, 200).inside, 6, "all six inside at 200%");

  // The slider may explore below full size; only the score floors at 100%.
  assert.strictEqual(score.calculateCoverage(dist, 50).inside, 1, "coverage below full size is still answerable");

  // ceil(0.75 * 6) = 5, so the 5th smallest radius (1.3) is required.
  approx(score.findScaleForTargetCoverage(dist), 130, 1e-9, "the 5th smallest radius is the required scale");

  // Exactly on target: 20 points, 15 at or under 1.2.
  const exact = Array.from({ length: 20 }, (_, i) => atRadius(i < 15 ? 1.2 : 1.9));
  const exactDist = score.distribution(exact, ELLIPSE);
  approx(score.findScaleForTargetCoverage(exactDist), 120, 1e-9, "exactly 75% reached at 120%");
  approx(score.calculateCoverage(exactDist, 120).insidePercent, 75, 1e-9, "and that scale holds exactly 75%");

  // Everything already inside: the bubble never shrinks to flatter the score.
  const tight = Array.from({ length: 20 }, () => atRadius(0.2));
  approx(score.findScaleForTargetCoverage(score.distribution(tight, ELLIPSE)), 100, 1e-9,
    "a pattern tighter than the bubble still requires 100%, never less");

  // One extreme outlier must not drag the score.
  const withOutlier = Array.from({ length: 20 }, (_, i) => atRadius(i === 19 ? 9 : 1.05));
  const outlierScore = score.analyse(withOutlier, ELLIPSE);
  approx(outlierScore.requiredGrowthPercent, 5, 1e-9, "a single wild miss does not move the 75% threshold");
  assert.strictEqual(outlierScore.transferScore, 10, "and does not move the score");
}

/* --------------------------------------------------------------------------
 * Score bands, at every published boundary
 * ------------------------------------------------------------------------ */
{
  const cfg = score.config();
  [[0, 10], [10, 10], [20, 9], [30, 8], [40, 7], [50, 6], [60, 5], [70, 4], [80, 3], [100, 2]]
    .forEach(([growth, expected]) => {
      assert.strictEqual(
        score.calculateTransferScore(growth, cfg), expected,
        `${growth}% growth scores ${expected}`
      );
    });

  // Just over a boundary drops exactly one band.
  assert.strictEqual(score.calculateTransferScore(10.1, cfg), 9, "just past 10% drops to 9");
  assert.strictEqual(score.calculateTransferScore(70.1, cfg), 3, "just past 70% drops to 3");
}

/* --------------------------------------------------------------------------
 * Sample gates and the unreadable state
 * ------------------------------------------------------------------------ */
{
  const thin = score.analyse(Array.from({ length: 8 }, () => atRadius(0.5)), ELLIPSE);
  assert.strictEqual(thin.analysisState, "insufficient_data", "under ten shots there is no result");
  assert.strictEqual(thin.transferScore, null, "and no score is manufactured");
  assert.strictEqual(thin.alignmentConfidence, "none", "and no directional conclusion");

  const provisional = score.analyse(Array.from({ length: 12 }, () => atRadius(0.5)), ELLIPSE);
  assert.strictEqual(provisional.analysisState, "provisional", "ten to nineteen shots is provisional");
  assert.strictEqual(provisional.transferScore, 10, "a provisional score is still produced");

  const valid = score.analyse(Array.from({ length: 20 }, () => atRadius(0.5)), ELLIPSE);
  assert.strictEqual(valid.analysisState, "valid", "twenty shots opens the gates");

  // 75% not reachable inside the configured maximum.
  const wild = score.analyse(Array.from({ length: 20 }, () => atRadius(2.6)), ELLIPSE);
  assert.strictEqual(wild.analysisState, "unreadable", "beyond 200% the result is outside the readable range");
  assert.strictEqual(wild.transferScore, 1, "which is the lowest category");
  approx(wild.requiredScalePercent, 260, 1e-9, "the raw requirement is still reported, not extrapolated away");

  const noBubble = score.analyse([{ x: 1, y: 1 }], null);
  assert.strictEqual(noBubble.unavailableReason, "INVALID_BUBBLE", "a missing bubble is stated, not thrown");
  assert.strictEqual(noBubble.analysisState, "insufficient_data", "and produces no score");
}

/* --------------------------------------------------------------------------
 * Quadrants
 * ------------------------------------------------------------------------ */
{
  assert.strictEqual(score.classifyQuadrant({ x: -3, y: -6 }, ELLIPSE), "short-left", "negative x and y");
  assert.strictEqual(score.classifyQuadrant({ x: 3, y: 6 }, ELLIPSE), "long-right", "positive x and y");
  assert.strictEqual(score.classifyQuadrant({ x: 0, y: 0 }, ELLIPSE), "long-right",
    "exact zeros tie to long-right so every shot lands in exactly one quadrant");

  // Screen coordinates grow downwards, so on the real chart a LONG shot sits at
  // a smaller y than the centre. Getting this backwards would produce confident,
  // exactly-inverted distance feedback, so the caller states its axis.
  assert.strictEqual(score.classifyQuadrant({ x: 3, y: 6 }, ELLIPSE), "long-right", "y-up: positive y is long");
  const flipped = score.distribution([{ x: 3, y: 6 }], ELLIPSE, { yAxisDown: true });
  assert.strictEqual(flipped.points[0].quadrant, "short-right", "y-down: the same point is short");
  approx(flipped.points[0].radius, score.radiusFor({ x: 3, y: 6 }, ELLIPSE), 1e-9,
    "the axis direction never changes a radius, only the Short/Long label");

  const balanced = score.analyse(mix({ "short-left": 5, "short-right": 5, "long-left": 5, "long-right": 5 }), ELLIPSE);
  approx(balanced.leftShare, 50, 1e-9, "balanced left share");
  approx(balanced.shortShare, 50, 1e-9, "balanced short share");
  assert.strictEqual(balanced.alignmentBias, "balanced", "even data leans nowhere");
  assert.strictEqual(balanced.distanceBias, "balanced", "in either axis");
  assert.strictEqual(balanced.quadrantConfidence, "none", "and no corner stands out");

  const leftHeavy = score.analyse(mix({ "short-left": 8, "long-left": 7, "short-right": 3, "long-right": 2 }), ELLIPSE);
  approx(leftHeavy.leftShare, 75, 1e-9, "75% left");
  assert.strictEqual(leftHeavy.alignmentBias, "left_outcome_bias", "left-heavy is reported as a left outcome bias");
  assert.strictEqual(leftHeavy.alignmentConfidence, "strong", "and above 70% it is strong");

  const rightHeavy = score.analyse(mix({ "short-right": 8, "long-right": 7, "short-left": 3, "long-left": 2 }), ELLIPSE);
  assert.strictEqual(rightHeavy.alignmentBias, "right_outcome_bias", "the mirror case");

  const shortHeavy = score.analyse(mix({ "short-left": 8, "short-right": 7, "long-left": 3, "long-right": 2 }), ELLIPSE);
  assert.strictEqual(shortHeavy.distanceBias, "short", "short-heavy");
  const longHeavy = score.analyse(mix({ "long-left": 8, "long-right": 7, "short-left": 3, "short-right": 2 }), ELLIPSE);
  assert.strictEqual(longHeavy.distanceBias, "long", "long-heavy");

  // Each corner dominant in turn.
  [["short-left", "short", "left_outcome_bias"], ["short-right", "short", "right_outcome_bias"],
   ["long-left", "long", "left_outcome_bias"], ["long-right", "long", "right_outcome_bias"]]
    .forEach(([quadrant, expectedDistance, expectedAlignment]) => {
      const rest = ["short-left", "short-right", "long-left", "long-right"].filter((q) => q !== quadrant);
      const spec = { [quadrant]: 12 };
      rest.forEach((q, i) => { spec[q] = i === 0 ? 4 : 2; });
      const result = score.analyse(mix(spec), ELLIPSE);
      assert.strictEqual(result.dominantQuadrant, quadrant, `${quadrant} dominant`);
      assert.strictEqual(result.quadrantConfidence, "dominant", `${quadrant} at 60% is a dominant concentration`);
      assert.strictEqual(result.distanceBias, expectedDistance, `${quadrant} reads ${expectedDistance}`);
      assert.strictEqual(result.alignmentBias, expectedAlignment, `${quadrant} reads ${expectedAlignment}`);
    });
}

/* --------------------------------------------------------------------------
 * Confidence gating
 * ------------------------------------------------------------------------ */
{
  // Exactly at the balanced ceiling: 11 left of 20 is 55%, which must not speak.
  const atCeiling = score.analyse(mix({ "short-left": 6, "long-left": 5, "short-right": 5, "long-right": 4 }), ELLIPSE);
  approx(atCeiling.leftShare, 55, 1e-9, "exactly 55% left");
  assert.strictEqual(atCeiling.alignmentConfidence, "none", "55% is balanced, not a tendency");

  const tendency = score.analyse(mix({ "short-left": 7, "long-left": 5, "short-right": 5, "long-right": 3 }), ELLIPSE);
  approx(tendency.leftShare, 60, 1e-9, "60% left");
  assert.strictEqual(tendency.alignmentConfidence, "tendency", "55-62% is a mild tendency");

  const clear = score.analyse(mix({ "short-left": 8, "long-left": 6, "short-right": 4, "long-right": 2 }), ELLIPSE);
  approx(clear.leftShare, 70, 1e-9, "70% left");
  assert.strictEqual(clear.alignmentConfidence, "clear", "62-70% is a clear pattern");

  // A big lean on a small sample is capped, never strong.
  const smallButLopsided = score.analyse(mix({ "short-left": 10, "long-right": 2 }), ELLIPSE);
  assert.strictEqual(smallButLopsided.analysisState, "provisional", "twelve shots is provisional");
  approx(smallButLopsided.leftShare, 83.33, 0.01, "83% left");
  assert.strictEqual(smallButLopsided.alignmentConfidence, "provisional",
    "a lopsided small sample is capped at provisional, never strong");

  const belowGate = score.analyse(mix({ "short-left": 8 }), ELLIPSE);
  assert.strictEqual(belowGate.alignmentConfidence, "none", "below the sample gate nothing is said at all");
}

/* --------------------------------------------------------------------------
 * Insight copy
 * ------------------------------------------------------------------------ */
{
  const leftShort = score.analyse(
    mix({ "short-left": 10, "short-right": 3, "long-left": 4, "long-right": 3 }),
    ELLIPSE
  );
  const built = insight.buildCourseInsight(leftShort);

  assert.strictEqual(built.state, "valid", "a full sample builds a valid insight");

  // TWO SECTIONS, ALWAYS: the score, and the tab behind it. Alignment, distance
  // and the quadrant sentence are no longer rendered - the quadrant read moved
  // onto the graph as four corner percentages - so the screen cannot show them
  // even if a future edit puts them back in the array by accident.
  assert.strictEqual(built.sections.map((s) => s.key).join(","), "score,explain",
    "the screen is a score and the evidence behind it, nothing else");

  const scoreSection = built.sections[0];
  assert.strictEqual(scoreSection.title, "Course Score", "the section is named for what it is");
  assert.strictEqual(scoreSection.headline, String(leftShort.transferScore), "the headline is the bare number");
  assert.strictEqual(scoreSection.outOf, 10, "with a fixed denominator the screen draws beside it");
  assert(scoreSection.headline.indexOf("/10") === -1, "the denominator is not baked into the reading");
  assert(scoreSection.headline.indexOf("provisional") === -1, "and provisional is the chip's job");

  // The colour is a named band, never a hex: the stylesheet owns the hexes so
  // the decision stays testable here.
  const BANDS = [[1, "low"], [4, "low"], [5, "mid"], [7, "mid"], [8, "high"], [10, "high"]];
  BANDS.forEach(([value, tone]) => {
    const at = insight.buildCourseInsight(Object.assign({}, leftShort, { transferScore: value }));
    assert.strictEqual(at.sections[0].tone, tone, `a ${value} is in the ${tone} band`);
    assert(!/#[0-9a-f]{3,6}/i.test(at.sections[0].tone), "the insight layer names bands, not colours");
  });

  // THE RAIL IS THE WHOLE SCALE. Each segment carries the band IT sits in, not
  // the band the score landed in, so a 7 shows red behind it and green ahead.
  // Built here because the boundaries are the same ones tone uses - derived on
  // the screen instead, a tuning change would recolour the number and leave the
  // rail under it saying something else.
  {
    const at7 = insight.buildCourseInsight(Object.assign({}, leftShort, { transferScore: 7 })).sections[0];
    assert.strictEqual(at7.rail.length, 10, "ten segments, one per point on the scale");
    assert.strictEqual(at7.rail.map((s) => s.band).join(","), "low,low,low,low,mid,mid,mid,high,high,high",
      "the bands are fixed to the scale, not to the score");
    assert.strictEqual(at7.rail.map((s) => s.state).join(","), "on,on,on,on,on,on,at,off,off,off",
      "lit up to the score, and exactly one segment is AT it");
    BANDS.forEach(([value]) => {
      const rail = insight.buildCourseInsight(Object.assign({}, leftShort, { transferScore: value })).sections[0].rail;
      assert.strictEqual(rail.filter((s) => s.state === "at").length, 1, `a ${value} lights exactly one segment`);
      assert.strictEqual(rail.filter((s) => s.state !== "off").length, value, `and ${value} segments in total`);
      assert.strictEqual(rail[value - 1].band, insight.buildCourseInsight(
        Object.assign({}, leftShort, { transferScore: value })).sections[0].tone,
        "the segment AT the score wears the same band as the number above it");
    });
    const none = insight.buildCourseInsight(score.analyse(mix({ "short-left": 6 }), ELLIPSE)).sections[0].rail;
    assert.strictEqual(none.filter((s) => s.state !== "off").length, 0, "no score lights nothing");
    assert.strictEqual(none.map((s) => s.band).join(","), at7.rail.map((s) => s.band).join(","),
      "but the scale underneath is the same one");
  }

  // The retired wording is kept, and kept correct, so restoring a section is a
  // render decision rather than a rewrite.
  const alignment = insight.retiredSections.alignment(leftShort);
  assert(alignment.body.indexOf("finished left") !== -1, "the evidence is stated first");
  assert(alignment.body.indexOf("tending right") !== -1, "then framed as an alignment tendency the other way");
  const balancedAlignment = insight.retiredSections.alignment(
    score.analyse(mix({ "short-left": 5, "short-right": 5, "long-left": 5, "long-right": 5 }), ELLIPSE)
  );
  assert(balancedAlignment.body.indexOf("well matched") !== -1, "balanced alignment is stated positively");
  assert.strictEqual(
    insight.retiredSections.quadrant(
      score.analyse(mix({ "short-left": 5, "short-right": 5, "long-left": 5, "long-right": 5 }), ELLIPSE)
    ),
    null,
    "no quadrant sentence when nothing stands out"
  );

  // Below the gate: a dash and a Collecting chip, never a fabricated score.
  const collecting = insight.buildCourseInsight(score.analyse(mix({ "short-left": 6 }), ELLIPSE));
  assert.strictEqual(collecting.state, "insufficient_data", "under the gate it is a collecting state");
  assert.strictEqual(collecting.sections[0].headline, "—", "with no number to show");
  assert.strictEqual(collecting.sections[0].tone, "none", "and no colour to imply one");
  assert(collecting.sections[0].chip.indexOf("Collecting") === 0, "the chip says which state this is");
  assert(collecting.sections[0].chip.indexOf("6 shots") !== -1, "and on how many shots");

  // A full sample states the sample size and nothing else.
  assert.strictEqual(built.sections[0].chip, `${leftShort.sampleSize} shots`,
    "a valid sample is the unqualified case and carries no state word");

  const unreadable = insight.buildCourseInsight(
    score.analyse(Array.from({ length: 20 }, () => atRadius(2.6)), ELLIPSE)
  );
  assert.strictEqual(unreadable.sections[0].headline, "1", "an unreachable threshold still scores, at the floor");
  assert(unreadable.sections[0].chip.indexOf("Unreadable") === 0, "and the chip says why it is a 1");

  // The info tab: what the score measures, then how much the bubble held. Both
  // read off the analysis - the containment figure is not recounted here.
  const explain = built.sections[1];
  assert.strictEqual(explain.title, "What this means", "the tab names itself");
  assert(explain.body.indexOf("Out of 10") === 0, "the definition comes first");
  assert(explain.note.indexOf("finished inside the bubble") !== -1, "then the containment line");
  assert.strictEqual(
    explain.note.indexOf(`${leftShort.coverageAtMyBubble.inside} of ${leftShort.coverageAtMyBubble.sampleSize} shots`),
    0,
    "counted at the bubble's own size, straight off the analysis"
  );
  assert.strictEqual(insight.buildCourseInsight(score.analyse([], ELLIPSE)).sections[1].note, null,
    "with no shots there is no containment line to draw");
}

/* --------------------------------------------------------------------------
 * Copy safety: the bubble placement is never treated as wrong
 * ------------------------------------------------------------------------ */
{
  const FORBIDDEN = [
    "move the bubble", "moving the bubble", "reposition", "re-position",
    "placed incorrectly", "placement is wrong", "wrong bubble", "bad placement",
    // "you aimed" on its own is not the offence - the score block's definition
    // sentence refers to where the player aimed the bubble, which is a neutral
    // statement of what the number is measured against. What is banned is any
    // phrasing that treats that aim as the thing to change.
    "should have aimed", "you aimed too", "you aimed wrong", "aim further", "aim more",
    "swing", "your fault", "fix your"
  ];

  const fixtures = [];
  [0, 6, 12, 20, 40].forEach((n) => {
    ["short-left", "short-right", "long-left", "long-right"].forEach((quadrant) => {
      const spec = {};
      spec[quadrant] = n;
      spec["long-right"] = (spec["long-right"] || 0) + Math.floor(n / 4);
      fixtures.push(score.analyse(mix(spec), ELLIPSE));
    });
  });
  fixtures.push(score.analyse(mix({ "short-left": 5, "short-right": 5, "long-left": 5, "long-right": 5 }), ELLIPSE));
  fixtures.push(score.analyse(Array.from({ length: 20 }, () => atRadius(2.6)), ELLIPSE));
  fixtures.push(score.analyse(Array.from({ length: 25 }, (_, i) => atRadius(0.4 + i * 0.06)), ELLIPSE));

  let checked = 0;
  fixtures.forEach((analysis) => {
    const built = insight.buildCourseInsight(analysis);
    if (!built) return;
    built.sections.forEach((section) => {
      const text = `${section.title} ${section.headline || ""} ${section.body}`.toLowerCase();
      checked += 1;
      FORBIDDEN.forEach((phrase) => {
        assert(
          text.indexOf(phrase) === -1,
          `insight copy must never say "${phrase}" -- got: ${section.body}`
        );
      });
    });
  });
  assert(checked > 40, `enough copy was actually generated to be worth checking (${checked} sections)`);

  // The same rule pinned at the source, so a future edit cannot slip copy in.
  const fs = require("fs");
  const path = require("path");
  const scoreSource = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "course-data", "gd-course-transfer-score.js"), "utf8");
  assert(!scoreSource.includes("document."), "the score layer touches no DOM");
  assert(!scoreSource.includes("localStorage"), "the score layer persists nothing");
  assert(!scoreSource.includes("fetch("), "the score layer performs no network access");

  const insightSource = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "course-data", "gd-course-implementation-insight.js"), "utf8");
  assert(!insightSource.includes("document."), "the insight layer touches no DOM");
  assert(!insightSource.includes("Math.sqrt"), "the insight layer does no geometry of its own");
}

console.log("course-transfer-score tests passed");
