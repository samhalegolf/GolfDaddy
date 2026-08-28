/* The three shapes a 27-hole site comes in, and one 18 that must not be touched.
 *
 * A 27-hole facility is not one thing:
 *
 *   18 proper + a par-3 nine    two real courses, no shared ground
 *   three named nines           Red, White, Blue
 *   three nines, 3x18 orders    Red+White, White+Blue, Blue+Red - three
 *                               EIGHTEEN-hole cards over twenty-seven holes
 *
 * The last one is the trap. Claiming ground exclusively card by card drops two
 * of its three courses, because card 2 finds only nine holes free and looks
 * like a failure. These lock the rule that survives all three: the nine is the
 * atom, compositing is detected by OVERLAP rather than by hole count, and the
 * 18s become play orders over the nines instead of courses of their own. */
const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* A card claiming a named run of ground. ids are stand-ins for candidateIds -
   what matters is which claims reach for the same ones. */
function claim(cardName, ids, confidence) {
  return {
    cardName,
    confidence: confidence == null ? 0.8 : confidence,
    holes: ids.map((id, index) => ({ holeNumber: index + 1, candidateId: id }))
  };
}
const RED = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"];
const WHITE = ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "w9"];
const BLUE = ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9"];

(async () => {
  const core = await import("file://" + path.join(ROOT, "functions", "lib", "gd-facility-loops-core.mjs"));
  const { reconcileFacilityClaims, atomicLoopCount, sliceClaimIntoLoops, claimOverlap } = core;

  test("ground is counted in nines", () => {
    assert.strictEqual(atomicLoopCount(27), 3);
    assert.strictEqual(atomicLoopCount(18), 2);
    assert.strictEqual(atomicLoopCount(9), 1);
    assert.strictEqual(atomicLoopCount(28), 3, "a stray candidate is not a quarter of a loop");
    assert.strictEqual(atomicLoopCount(4), 0, "less than a nine is not a loop at all");
  });

  test("scenario 1: an 18 proper plus a par-3 nine publishes as two courses", () => {
    /* Different lengths, no shared ground. The 18 is a WHOLE course and
       slicing it in half would invent a facility that does not exist. */
    const result = reconcileFacilityClaims([
      claim("Championship Course", RED.concat(WHITE)),
      claim("Par 3 Course", BLUE)
    ], { candidateCount: 27 });
    assert.strictEqual(result.composite, false, "nothing overlaps, so nothing is a composite");
    assert.strictEqual(result.loops.length, 2, "two cards, two courses");
    assert.strictEqual(result.loops[0].holes.length, 18, "the 18 stays an 18");
    assert.strictEqual(result.loops[1].holes.length, 9);
    assert.strictEqual(result.complete, true);
  });

  test("scenario 2: three named nines publish as three courses, named", () => {
    const result = reconcileFacilityClaims([
      claim("Red Nine", RED), claim("White Nine", WHITE), claim("Blue Nine", BLUE)
    ], { candidateCount: 27 });
    assert.strictEqual(result.composite, false);
    assert.strictEqual(result.loops.length, 3);
    assert.deepStrictEqual(result.loops.map(l => l.cardName).sort(),
      ["Blue Nine", "Red Nine", "White Nine"], "cards that share no ground keep their own names");
    assert.strictEqual(result.complete, true);
  });

  test("scenario 3: three 18-hole play orders over three nines", () => {
    /* The case exclusive claiming loses. Three cards, eighteen holes each,
       twenty-seven holes of ground, every pair sharing exactly one nine. */
    const result = reconcileFacilityClaims([
      claim("Red + White", RED.concat(WHITE)),
      claim("White + Blue", WHITE.concat(BLUE)),
      claim("Blue + Red", BLUE.concat(RED))
    ], { candidateCount: 27 });
    assert.strictEqual(result.composite, true, "cards wanting the same ground is what says 'composite'");
    assert.strictEqual(result.loops.length, 3, "three nines, not three eighteens and not one course");
    result.loops.forEach(loop => {
      assert.strictEqual(loop.holes.length, 9, "every published course is a nine");
      assert.deepStrictEqual(loop.holes.map(h => h.holeNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9],
        "a sliced nine is renumbered 1-9 - White's last hole is its 9th, not the card's 18th");
    });
    assert.strictEqual(result.unclaimedCandidates, 0, "all twenty-seven holes are accounted for");
    assert.strictEqual(result.complete, true);
  });

  test("the club's own combinations are deliberately NOT stored", () => {
    /* Three siblings sharing a facility_key is everything the round-start
       prompt needs: the player taps the two nines they are playing today, in
       whichever order they like. A stored "Red + White" would be a worse
       version of that - clubs rotate their pairings, and it cannot express
       White then Red. */
    const result = reconcileFacilityClaims([
      claim("Red + White", RED.concat(WHITE)),
      claim("White + Blue", WHITE.concat(BLUE)),
      claim("Blue + Red", BLUE.concat(RED))
    ], { candidateCount: 27 });
    assert.strictEqual(result.playOrders, undefined,
      "combinations are not data - three nines are");
    assert.strictEqual(result.loops.length, 3, "and the nines are all that comes out");
  });

  test("a sliced nine publishes unnamed - 'Red + White' names neither of them", () => {
    const result = reconcileFacilityClaims([
      claim("Red + White", RED.concat(WHITE)),
      claim("White + Blue", WHITE.concat(BLUE))
    ], { candidateCount: 27 });
    result.loops.forEach(loop => {
      assert.strictEqual(loop.cardName, "",
        "a composite card cannot name its halves - labelling is course-scorecard-update's job");
      assert.ok(loop.alsoFromCards.length >= 1, "but which cards reached it is worth keeping");
    });
  });

  test("the shared nine is recorded once, against both cards that reached it", () => {
    const result = reconcileFacilityClaims([
      claim("Red + White", RED.concat(WHITE)),
      claim("White + Blue", WHITE.concat(BLUE))
    ], { candidateCount: 27 });
    const shared = result.loops.find(loop => loop.alsoFromCards.length === 2);
    assert.ok(shared, "White is reached by both cards and must publish once, not twice");
    assert.deepStrictEqual(shared.alsoFromCards.sort(), ["Red + White", "White + Blue"]);
  });

  test("AN ORDINARY 18 IS NEVER SPLIT INTO TWO NINES", () => {
    /* The worst thing this module could do, and it did it.
     *
     * An 18-hole course that also turns up a 9-hole card - an aggregator
     * listing the front nine separately, or a wrong card that fits half the
     * ground - has two claims overlapping by nine. The first version read that
     * as a composite facility, sliced the 18 down the middle, and published two
     * nine-hole courses in place of one eighteen.
     *
     * The nine is CONTAINED in the 18: it owns no ground of its own. A real
     * play order does - Red+White and White+Blue each keep a nine the other
     * lacks. Containment is a duplicate; mutual partial overlap is a composite. */
    const eighteen = RED.concat(WHITE);
    const result = reconcileFacilityClaims([
      claim("Front Nine", RED),
      claim("The Course", eighteen)
    ], { candidateCount: 18 });
    assert.strictEqual(result.composite, false,
      "a card inside another card is a duplicate, not a facility");
    assert.strictEqual(result.loops.length, 1, "ONE course, not two nines");
    assert.strictEqual(result.loops[0].holes.length, 18, "and it keeps all eighteen holes");
    assert.strictEqual(result.loops[0].cardName, "The Course", "named by the card that covers it");
  });

  test("the containing card wins however the cards arrive", () => {
    /* Order must not decide it - the 18 leads whether it was found first or
       second, because dropContainedClaims sorts by size before filtering. */
    const eighteen = RED.concat(WHITE);
    ["nine-first", "eighteen-first"].forEach(order => {
      const claims = order === "nine-first"
        ? [claim("Front Nine", RED), claim("The Course", eighteen)]
        : [claim("The Course", eighteen), claim("Front Nine", RED)];
      const result = reconcileFacilityClaims(claims, { candidateCount: 18 });
      assert.strictEqual(result.loops.length, 1, "split with cards ordered " + order);
      assert.strictEqual(result.loops[0].holes.length, 18, "wrong survivor with " + order);
    });
  });

  test("two same-size claims over mostly the same ground publish ONCE", () => {
    /* Neither contains the other - both are nines - so containment does not
       apply and the dedupe has to catch it instead. Two cards landing on
       largely the same nine is a matching failure, not two courses, and
       publishing both would put two courses on one piece of ground. Collapsing
       to one is the safe answer; the other card is recorded against it. */
    const overlapping = RED.slice(0, 6).concat(["x1", "x2", "x3"]);
    const result = reconcileFacilityClaims([
      claim("Red", RED), claim("Odd Nine", overlapping)
    ], { candidateCount: 18 });
    assert.strictEqual(result.loops.length, 1, "same ground publishes once");
    assert.strictEqual(result.loops[0].alsoFromCards.length, 2, "and remembers both cards reached it");
  });

  test("two nines that share NOTHING are two courses", () => {
    /* The other side of that rule: genuinely separate nines have no ground in
       common, and must both survive. */
    const result = reconcileFacilityClaims([
      claim("Red", RED), claim("Blue", BLUE)
    ], { candidateCount: 18 });
    assert.strictEqual(result.loops.length, 2);
    assert.strictEqual(result.composite, false, "no shared ground is not a composite");
  });

  test("a genuine composite is still detected after the containment rule", () => {
    /* The fix must not cost the case the module exists for. */
    const result = reconcileFacilityClaims([
      claim("Red + White", RED.concat(WHITE)),
      claim("White + Blue", WHITE.concat(BLUE))
    ], { candidateCount: 27 });
    assert.strictEqual(result.composite, true, "mutual partial overlap is still a composite");
    assert.strictEqual(result.loops.length, 3, "and it still yields three nines");
  });

  test("an ordinary 18 with one card is left completely alone", () => {
    const result = reconcileFacilityClaims([claim("The Course", RED.concat(WHITE))], { candidateCount: 18 });
    assert.strictEqual(result.composite, false);
    assert.strictEqual(result.loops.length, 1);
    assert.strictEqual(result.loops[0].holes.length, 18, "one card, one course, eighteen holes");
    assert.strictEqual(result.loops[0].cardName, "The Course");
    assert.strictEqual(result.complete, true);
  });

  test("ground nobody claimed says 'keep fetching'", () => {
    /* One nine found at a 27-hole site: eighteen holes unspoken for, which is
       two more loops. This is the flag the worker's retry loop reads. */
    const result = reconcileFacilityClaims([claim("Red Nine", RED)], { candidateCount: 27 });
    assert.strictEqual(result.unclaimedCandidates, 18);
    assert.strictEqual(result.complete, false, "eighteen unclaimed holes is not a finished facility");
    assert.strictEqual(result.expectedLoops, 3);
  });

  test("a few leftover candidates do not keep the run going forever", () => {
    /* Practice greens and holes the resolver could not build a centre-line for
       always leave a remainder. Chasing it is what the hard stop exists for. */
    const result = reconcileFacilityClaims([claim("Red Nine", RED)], { candidateCount: 12 });
    assert.strictEqual(result.unclaimedCandidates, 3);
    assert.strictEqual(result.complete, true, "three stray candidates are not another loop");
  });

  test("a claim that is not a whole number of nines is never sliced", () => {
    /* A 12-hole read is a bad match or a genuinely odd course. Cutting it into
       a nine and a three would invent a loop. */
    const twelve = claim("Odd Course", RED.concat(["x1", "x2", "x3"]));
    assert.deepStrictEqual(sliceClaimIntoLoops(twelve), [twelve]);
  });

  test("overlap is measured on ground, not on names", () => {
    assert.strictEqual(claimOverlap(claim("A", RED), claim("B", RED)), 9);
    assert.strictEqual(claimOverlap(claim("A", RED), claim("B", BLUE)), 0);
    assert.strictEqual(claimOverlap(claim("Red Nine", RED), claim("Red Nine", BLUE)), 0,
      "two cards with the same title over different ground are different courses");
  });

  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("facility-loops failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("facility-loops passed: " + tests.length + " checks");
})();
