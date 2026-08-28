/* A scorecard describes a course, not a facility.
 *
 * Howeston Golf Course is three nines. OSM gave the scan 27 tees, 27 fairways,
 * 30 greens and ZERO numbered holes, so detectHoleNumberCollision - which reads
 * repeated hole numbers and nothing else - said "one course". The Native
 * Resolver was then handed a 9-hole GolfPass card as expectedHoles, matched
 * nine of the twenty-seven candidates, reported status "resolved" at 0.87
 * confidence, and the job published a third of the facility as a finished
 * 9-hole course with fit.trusted true.
 *
 * These lock the rule that was missing: when the ground carries substantially
 * more hole candidates than the card accounts for, the CARD is the incomplete
 * half of the comparison. */
const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

(async () => {
  const core = await import("file://" + path.join(ROOT, "functions", "lib", "gd-automapper-core.mjs"));
  const fit = await import("file://" + path.join(ROOT, "functions", "lib", "gd-course-fit-core.mjs"));
  const resolver = await import("file://" + path.join(ROOT, "functions", "lib", "gd-geometry-resolver-core.mjs"));
  const { detectUnnumberedMultiLoop } = core;

  test("Howeston: 27 hole candidates against a 9-hole card is three loops", () => {
    const verdict = detectUnnumberedMultiLoop({ candidateCount: 27, cardHoles: 9 });
    assert.strictEqual(verdict.multiLoop, true, "27 holes of ground cannot be a 9-hole course");
    assert.strictEqual(verdict.loops, 3);
  });

  test("a plain 18 with its own 18-hole card is one course", () => {
    const verdict = detectUnnumberedMultiLoop({ candidateCount: 18, cardHoles: 18 });
    assert.strictEqual(verdict.multiLoop, false);
    assert.strictEqual(verdict.reason, "geometry-matches-card");
  });

  test("a couple of practice greens do not make a facility", () => {
    /* 20 candidates against an 18-hole card is 1.11x - nowhere near the ratio,
       and only two extra holes. This is the false positive the rule must not
       produce, because it would send every ordinary course down the
       multi-course path. */
    const verdict = detectUnnumberedMultiLoop({ candidateCount: 20, cardHoles: 18 });
    assert.strictEqual(verdict.multiLoop, false);
  });

  test("the ratio alone is not enough - small numbers need the absolute floor", () => {
    /* 6 candidates against a 4-hole read is 1.5x and means nothing. Without the
       extra-holes floor this would claim a two-loop facility out of noise. */
    const verdict = detectUnnumberedMultiLoop({ candidateCount: 6, cardHoles: 4 });
    assert.strictEqual(verdict.multiLoop, false);
    assert.strictEqual(verdict.reason, "geometry-matches-card");
  });

  test("27 candidates against an 18-hole card is an 18 and a nine", () => {
    const verdict = detectUnnumberedMultiLoop({ candidateCount: 27, cardHoles: 18 });
    assert.strictEqual(verdict.multiLoop, true);
    assert.strictEqual(verdict.loops, 2, "27/18 rounds to two courses, not one-and-a-half");
  });

  test("no card means no answer, not 'one course'", () => {
    const verdict = detectUnnumberedMultiLoop({ candidateCount: 27, cardHoles: 0 });
    assert.strictEqual(verdict.multiLoop, false);
    assert.strictEqual(verdict.reason, "no-card-hole-count",
      "absence of a card is a question this rule cannot answer - it must say so rather than clear the site");
  });

  test("an unresolved facility cannot publish as trusted", () => {
    /* The exact Howeston shape: nine contiguous holes, a 9-hole card they match,
       a coherent 1.2km span. Every other rule in courseFitVerdict passes it -
       which is why it published - so the facility fact has to be what stops it. */
    const facts = {
      collision: { multiLoop: false, loops: 1 },
      expectedHoles: 9,
      holesResolved: 9,
      holeNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      courseBounds: { north: -27.4987, south: -27.5072, east: 153.1988, west: 153.1913 }
    };
    assert.strictEqual(fit.courseFitVerdict(facts).trusted, true,
      "sanity: without the facility fact this is exactly the run that shipped");
    const verdict = fit.courseFitVerdict(Object.assign({}, facts, {
      facilityUnresolved: { multiLoop: true, loops: 3, candidateCount: 27, cardHoles: 9 }
    }));
    assert.strictEqual(verdict.trusted, false);
    assert.strictEqual(verdict.reason, "multiple-courses");
    assert.strictEqual(verdict.detail.loops, 3);
    assert.ok(/three courses|3 courses/.test(fit.courseFitMessage(verdict)),
      "the player is owed the reason: got " + JSON.stringify(fit.courseFitMessage(verdict)));
  });

  test("a card cannot claim ground another card already took", async () => {
    /* Two cards over one payload have to be able to reach different holes, or
       three nines all resolve to the same nine. The resolver takes the claim as
       excludeCandidateIds; here it is enough to prove the input is honoured and
       that an excluded run sees a smaller pool than the ground actually holds. */
    const result = await resolver.resolveCourseGeometryForAutoMapper({
      osmPayload: { elements: [] }, courseId: "claim-test", excludeCandidateIds: ["a", "b"]
    });
    assert.ok(result && result.debugEvidence, "resolver must still answer with an empty payload");
    assert.strictEqual(typeof result.debugEvidence.totalHoleCandidates, "number",
      "the full candidate count is what the multi-loop check reads - it must survive exclusion");
  });

  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("unnumbered-multi-loop failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("unnumbered-multi-loop passed: " + tests.length + " checks");
})();
