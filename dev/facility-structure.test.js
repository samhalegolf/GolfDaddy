/* WHAT IS ACTUALLY ON THE GROUND - the ten shapes the mapper has to survive.
 *
 * The old mapper asked one question, "is this bigger than the card?", and every
 * yes meant nines. That is how Howeston published a generic 18-hole aggregator
 * card as a whole course over two of its three loops, and it is how a genuine
 * eighteen-plus-par-3-nine would have been cut into three nines that do not
 * exist.
 *
 * These lock the separation the fix rests on:
 *
 *   structure   what physically exists      <- assessFacilityStructure
 *   method      how the holes were found    <- recorded, never inferred
 *   grouping    what a player may pair      <- organiseFacility, downstream
 *
 * and the one rule that makes structure decidable at all: read the GROUND the
 * claims sit on, never the hole counts on their own. */
const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* Ground, named. What matters is which claims reach for the same ids. */
function claim(cardName, ids, confidence) {
  return {
    cardName,
    confidence: confidence == null ? 0.8 : confidence,
    holes: ids.map((id, index) => ({ holeNumber: index + 1, candidateId: id }))
  };
}
const nine = prefix => Array.from({ length: 9 }, (_, i) => prefix + (i + 1));
const A = nine("a"), B = nine("b"), C = nine("c");
const FRONT = nine("f"), BACK = nine("k");
const noise = count => Array.from({ length: count }, (_, i) => "noise" + i);

(async () => {
  const structure = await import("file://" + path.join(ROOT, "functions", "lib", "gd-facility-structure-core.mjs"));
  const loops = await import("file://" + path.join(ROOT, "functions", "lib", "gd-facility-loops-core.mjs"));
  const { assessFacilityStructure, describeClaimGround, organiseFacility, isIndependentClaim, planNextRound, summariseMappingMethod, FACILITY_STRUCTURE, MAPPING_METHOD } = structure;
  const { reconcileFacilityClaims } = loops;

  /* ---- 1. clean standalone 18 ------------------------------------------- */

  test("1: a clean 18 with its own card is one course and stays one course", () => {
    const verdict = assessFacilityStructure({
      candidateCount: 18,
      claims: [claim("Championship", FRONT.concat(BACK))]
    });
    assert.strictEqual(verdict.structure, FACILITY_STRUCTURE.SINGLE);
    assert.strictEqual(verdict.confident, true);
    const result = reconcileFacilityClaims([claim("Championship", FRONT.concat(BACK))], {
      candidateCount: 18, structure: verdict.structure
    });
    assert.strictEqual(result.loops.length, 1, "an 18 is never cut in half");
    assert.strictEqual(result.loops[0].holes.length, 18);
  });

  test("1b: a stray front-nine card does not make a plain 18 into a facility", () => {
    /* Containment with NOTHING beyond it is one course described twice. This is
       the regression that gets an ordinary 18 sliced if structure is decided
       from containment alone. */
    const verdict = assessFacilityStructure({
      candidateCount: 18,
      claims: [claim("Championship", FRONT.concat(BACK)), claim("Front Nine", FRONT)]
    });
    assert.notStrictEqual(verdict.structure, FACILITY_STRUCTURE.MULTI_NINE);
    assert.strictEqual(verdict.structure, FACILITY_STRUCTURE.SINGLE);
  });

  /* ---- 2. clean standalone 9 -------------------------------------------- */

  test("2: a clean 9 with its own card is one course", () => {
    const verdict = assessFacilityStructure({ candidateCount: 9, claims: [claim("The Nine", A)] });
    assert.strictEqual(verdict.structure, FACILITY_STRUCTURE.SINGLE);
    assert.strictEqual(verdict.confident, true);
    assert.strictEqual(verdict.expectedLoops, 1);
  });

  /* ---- 3. clean 27 already separated by numbering ------------------------ */

  test("3: three nines the numbering already separated need no resolver", () => {
    const verdict = assessFacilityStructure({
      candidateCount: 27,
      osmNineLoops: 3,
      claims: [claim("Red", A), claim("White", B), claim("Blue", C)]
    });
    assert.strictEqual(verdict.structure, FACILITY_STRUCTURE.MULTI_NINE);
    assert.strictEqual(verdict.confident, true);
    assert.strictEqual(verdict.reason, "numbering-separated-nine-hole-loops",
      "decided by the numbering, not by re-resolving anything");
    const organised = organiseFacility(
      [{ name: "Red", holeNumbers: A }, { name: "White", holeNumbers: B }, { name: "Blue", holeNumbers: C }],
      { structure: verdict.structure, mappingMethod: MAPPING_METHOD.OSM_NUMBERED });
    assert.strictEqual(organised.siblings, 3);
    assert.strictEqual(organised.needsLabelling, false);
    assert.strictEqual(organised.courses[0].role, "selectable-nine");
  });

  /* ---- 4. Howeston -------------------------------------------------------- */

  test("4: a named nine INSIDE a generic 18, with ground beyond, is a multi-nine site", () => {
    /* 30 candidates, three physical nines. The aggregator's 18 covers A and B;
       Westward's own card covers A. The old rule read that containment as a
       duplicate and dropped Westward. */
    const claims = [
      claim("All Square Golf", A.concat(B)),
      claim("Westward", A),
      claim("Howard", C)
    ];
    const verdict = assessFacilityStructure({ candidateCount: 30, claims });
    assert.strictEqual(verdict.structure, FACILITY_STRUCTURE.MULTI_NINE);
    assert.strictEqual(verdict.confident, true);
  });

  test("4b: the generic 18 cannot publish itself as a course over two real nines", () => {
    const claims = [
      claim("All Square Golf", A.concat(B)),
      claim("Westward", A),
      claim("Howard", C)
    ];
    const result = reconcileFacilityClaims(claims, {
      candidateCount: 30, structure: FACILITY_STRUCTURE.MULTI_NINE
    });
    assert.strictEqual(result.loops.length, 3, "three nines, not an 18 plus a nine");
    assert.ok(result.loops.every(loop => loop.holes.length === 9), "every published loop is a nine");
    const names = result.loops.map(loop => loop.cardName).sort();
    assert.ok(names.includes("Westward"), "the named nine names its loop instead of being dropped");
    assert.ok(names.includes("Howard"));
    assert.ok(!names.includes("All Square Golf"), "an aggregator card names no single loop");
    assert.strictEqual(result.complete, true);
  });

  test("4c: two loops out of three is NOT complete, however quiet the leftovers", () => {
    /* The exact stop that ended the Howeston run: eight candidates spare is
       under the noise floor, so the ground looked accounted for while a third
       of the facility was unresolved. */
    const result = reconcileFacilityClaims([claim("Westward", A), claim("Howard", B)], {
      candidateCount: 26, structure: FACILITY_STRUCTURE.MULTI_NINE
    });
    assert.strictEqual(result.claimedLoops, 2);
    assert.strictEqual(result.expectedLoops, 3);
    assert.ok(result.unclaimedCandidates < 9, "the leftovers really are below the noise floor");
    assert.strictEqual(result.complete, false, "a missing loop is not noise");
    assert.strictEqual(result.completionReason, "resolved-2-of-3-expected-loops");
  });

  test("4d: a later aggregator card cannot talk a multi-nine site back into one course", () => {
    const prior = { structure: FACILITY_STRUCTURE.MULTI_NINE, confident: true };
    const verdict = assessFacilityStructure({
      candidateCount: 30,
      claims: [claim("All Square Golf", A.concat(B))],
      prior
    });
    assert.strictEqual(verdict.structure, FACILITY_STRUCTURE.MULTI_NINE);
    assert.strictEqual(verdict.sticky, true);
  });

  /* ---- 5/6. starting from nothing, and from a partial success ------------- */

  test("5: no claims over multi-loop ground is a question, not a verdict", () => {
    const verdict = assessFacilityStructure({ candidateCount: 27, claims: [] });
    assert.strictEqual(verdict.structure, FACILITY_STRUCTURE.UNKNOWN);
    assert.strictEqual(verdict.confident, false,
      "27 candidates alone must never decide the shape of a facility");
  });

  test("6: one confident nine over three nines of ground leaves the rest open", () => {
    const verdict = assessFacilityStructure({ candidateCount: 27, claims: [claim("Westward", A)] });
    assert.strictEqual(verdict.structure, FACILITY_STRUCTURE.UNKNOWN);
    assert.strictEqual(verdict.confident, false);
    assert.strictEqual(verdict.unclaimedCandidates, 18,
      "the ground the resolver still has to explain, and all it has to explain");
  });

  test("6b: two nines on separate ground ARE two loops", () => {
    const verdict = assessFacilityStructure({ candidateCount: 27, claims: [claim("Westward", A), claim("Howard", B)] });
    assert.strictEqual(verdict.structure, FACILITY_STRUCTURE.MULTI_NINE);
    assert.strictEqual(verdict.confident, true);
  });

  /* ---- 7. genuine 18 + 9 -------------------------------------------------- */

  test("7: a real 18 plus a separate par-3 nine is two courses, NOT three nines", () => {
    const claims = [claim("Championship", FRONT.concat(BACK)), claim("Par 3 Course", C)];
    const verdict = assessFacilityStructure({ candidateCount: 27, claims });
    assert.strictEqual(verdict.structure, FACILITY_STRUCTURE.MULTI_COURSE,
      "the nine shares no ground with the eighteen, so neither is part of the other");
    const result = reconcileFacilityClaims(claims, { candidateCount: 27, structure: verdict.structure });
    assert.strictEqual(result.loops.length, 2);
    assert.strictEqual(result.loops[0].holes.length, 18, "the 18 stays whole");
    assert.strictEqual(result.complete, true);
  });

  /* ---- 8. composite 27 ---------------------------------------------------- */

  test("8: three play orders over three nines still find three nines", () => {
    const claims = [
      claim("Red + White", A.concat(B)),
      claim("White + Blue", B.concat(C)),
      claim("Blue + Red", C.concat(A))
    ];
    const verdict = assessFacilityStructure({ candidateCount: 27, claims });
    assert.strictEqual(verdict.structure, FACILITY_STRUCTURE.MULTI_NINE);
    const result = reconcileFacilityClaims(claims, { candidateCount: 27, structure: verdict.structure });
    assert.strictEqual(result.composite, true);
    assert.strictEqual(result.loops.length, 3);
  });

  test("8b: composite claims are never independent, so their ground is never taken away", () => {
    const claims = [
      claim("Red + White", A.concat(B)),
      claim("White + Blue", B.concat(C))
    ];
    assert.strictEqual(isIndependentClaim(claims[0], claims), false,
      "removing Red+White's ground would make White+Blue look like a failed match");
    assert.strictEqual(isIndependentClaim(claims[1], claims), false);
  });

  test("8c: a claim nobody partially shares IS independent and may be excluded", () => {
    const claims = [claim("Westward", A), claim("Howard", B)];
    assert.strictEqual(isIndependentClaim(claims[0], claims), true);
  });

  /* ---- 9. neighbouring geometry ------------------------------------------ */

  test("9: unrelated ground swept in does not manufacture an extra course", () => {
    const verdict = assessFacilityStructure({
      candidateCount: 26,
      claims: [claim("Championship", FRONT.concat(BACK))]
    });
    assert.strictEqual(verdict.expectedLoops, 3, "the arithmetic really does say three");
    assert.strictEqual(verdict.structure, FACILITY_STRUCTURE.SINGLE,
      "and the evidence says one course with eight candidates of noise around it");
    assert.strictEqual(verdict.confident, true);
  });

  test("9b: noise below a loop does not keep a finished single course running", () => {
    const result = reconcileFacilityClaims([claim("Championship", FRONT.concat(BACK))], {
      candidateCount: 26, structure: FACILITY_STRUCTURE.SINGLE
    });
    assert.strictEqual(result.complete, true);
    assert.strictEqual(result.completionReason, "ground-accounted-for");
  });

  /* ---- 10. not enough evidence -------------------------------------------- */

  test("10: evidence that cannot explain the ground invents nothing", () => {
    const verdict = assessFacilityStructure({
      candidateCount: 36,
      claims: [claim("Something", A.concat(noise(0)))]
    });
    assert.strictEqual(verdict.structure, FACILITY_STRUCTURE.UNKNOWN);
    assert.strictEqual(verdict.confident, false);
    const result = reconcileFacilityClaims([claim("Something", A)], { candidateCount: 36, structure: null });
    assert.strictEqual(result.complete, false, "27 candidates unexplained is a visible failure, not a finished job");
    assert.strictEqual(result.completionReason, "27-candidates-unclaimed");
  });

  /* ---- method and organisation are not structure -------------------------- */

  test("mapping method is recorded, never inferred from the structure", () => {
    assert.strictEqual(summariseMappingMethod([MAPPING_METHOD.OSM_NUMBERED]), MAPPING_METHOD.OSM_NUMBERED);
    assert.strictEqual(summariseMappingMethod([MAPPING_METHOD.AUTOMAPPER, MAPPING_METHOD.NATIVE_RESOLVER]), MAPPING_METHOD.MIXED);
    assert.strictEqual(summariseMappingMethod([]), null,
      "a facility with no accepted claims has no mapping method, not a default one");
  });

  test("a multi-nine facility publishes selectable nines; anything else publishes courses", () => {
    const nines = organiseFacility([{ name: "Red", holeNumbers: A }, { name: "", holeNumbers: B }], { structure: FACILITY_STRUCTURE.MULTI_NINE });
    assert.strictEqual(nines.courses[0].role, "selectable-nine");
    assert.strictEqual(nines.needsLabelling, true, "the unnamed loop is said out loud");
    const courses = organiseFacility([{ name: "Championship", holeNumbers: FRONT.concat(BACK) }], { structure: FACILITY_STRUCTURE.MULTI_COURSE });
    assert.strictEqual(courses.courses[0].role, "course");
  });

  test("the organiser stores no play order", () => {
    const organised = organiseFacility([{ name: "Red", holeNumbers: A }, { name: "White", holeNumbers: B }], { structure: FACILITY_STRUCTURE.MULTI_NINE });
    assert.ok(!("playOrders" in organised) && !("combinations" in organised),
      "which two nines a player walks today is asked at round start, not stored here");
  });

  /* ---- the round policy: what comes off the table, and what to fetch next -- */

  test("an independent claim's ground comes off the table for the next round", () => {
    const reconciled = reconcileFacilityClaims([claim("Westward", A), claim("Howard", B)], {
      candidateCount: 27, structure: FACILITY_STRUCTURE.MULTI_NINE
    });
    const plan = planNextRound(reconciled, { target: 2 });
    assert.strictEqual(plan.done, false, "one loop of ground is still unexplained");
    assert.strictEqual(plan.excludeCandidateIds.length, 18,
      "the two resolved nines are not offered to the next card as free ground");
    assert.strictEqual(plan.target, 4, "two resolved plus one more loop of ground plus one");
  });

  test("a composite facility never has ground taken away from it", () => {
    const reconciled = reconcileFacilityClaims([
      claim("Red + White", A.concat(B)),
      claim("White + Blue", B.concat(C))
    ], { candidateCount: 27, structure: FACILITY_STRUCTURE.MULTI_NINE });
    assert.strictEqual(reconciled.composite, true);
    const plan = planNextRound(reconciled, { target: 3 });
    assert.deepStrictEqual(plan.excludeCandidateIds, [],
      "Blue + Red has to be able to ask for the nines the other two already reached");
  });

  test("the next fetch is sized by unexplained ground, not by how many cards exist", () => {
    /* Howeston had three card rows for three loops and one of them described
       two of the others. Counting rows said "enough evidence" over a facility a
       third unexplained. */
    const reconciled = reconcileFacilityClaims([claim("Westward", A)], {
      candidateCount: 27, structure: FACILITY_STRUCTURE.MULTI_NINE
    });
    const plan = planNextRound(reconciled, { target: 3 });
    assert.strictEqual(plan.done, false);
    assert.strictEqual(plan.target, 4, "one resolved, two loops of ground left, plus one");
  });

  test("a finished facility stops", () => {
    const reconciled = reconcileFacilityClaims([claim("Westward", A), claim("Howard", B), claim("Third", C)], {
      candidateCount: 27, structure: FACILITY_STRUCTURE.MULTI_NINE
    });
    const plan = planNextRound(reconciled, { target: 3 });
    assert.strictEqual(plan.done, true);
    assert.strictEqual(plan.reason, "resolved-3-of-3-loops");
  });

  /* ---- the diagnostics that have to answer "which two collapsed?" -------- */

  test("the round record says which claim was absorbed into which loop", () => {
    /* The question the first rescan could not answer. Three claims, two loops -
       and counts alone cannot say whether the missing nine was swallowed by the
       aggregator's claim or never matched its own ground. */
    const claims = [
      claim("All Square Golf", A.concat(B)),
      claim("Westward", A),
      claim("Howard", C)
    ];
    const reconciled = reconcileFacilityClaims(claims, { candidateCount: 30, structure: null });
    const ground = describeClaimGround(claims, reconciled);
    const westward = ground.claims.find(entry => entry.card === "Westward");
    assert.strictEqual(westward.fate, "absorbed", "Westward did not publish as its own loop");
    assert.strictEqual(westward.into, "All Square Golf", "and this is what took its ground");
    assert.strictEqual(westward.sharedWithHost, 9);
  });

  test("the overlap matrix carries the two numbers every structure verdict turns on", () => {
    const claims = [claim("All Square Golf", A.concat(B)), claim("Westward", A)];
    const ground = describeClaimGround(claims, reconcileFacilityClaims(claims, { candidateCount: 30 }));
    const pair = ground.overlaps[0];
    assert.strictEqual(pair.shared, 9);
    assert.strictEqual(pair.aKeeps, 9, "the 18 keeps a nine of its own");
    assert.strictEqual(pair.bKeeps, 0, "the nine keeps nothing - that is containment, not a play order");
  });

  test("a claim that published as itself says so, and carries its ground", () => {
    const claims = [claim("Westward", A), claim("Howard", B)];
    const ground = describeClaimGround(claims, reconcileFacilityClaims(claims, { candidateCount: 27 }));
    assert.ok(ground.claims.every(entry => entry.fate === "published-as-own-loop"));
    assert.deepStrictEqual(ground.claims[0].candidateIds, A);
    assert.deepStrictEqual(ground.overlaps, [], "disjoint nines share nothing, and that is recorded as nothing");
  });

  test("a claim that reached no published ground is not silently missing", () => {
    const claims = [claim("Westward", A), claim("Howard", B)];
    const reconciled = reconcileFacilityClaims([claim("Westward", A)], { candidateCount: 27 });
    const ground = describeClaimGround(claims, reconciled);
    const howard = ground.claims.find(entry => entry.card === "Howard");
    assert.strictEqual(howard.fate, "no-ground-published");
  });

  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("facility-structure failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("facility-structure passed: " + tests.length + " checks");
})();
