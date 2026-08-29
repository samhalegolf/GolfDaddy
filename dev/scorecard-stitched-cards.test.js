/* AN AGGREGATOR'S SCRAPE IS NOT A COURSE.
 *
 * Howeston is a 27-hole club - 27 tees, 27 fairways in OSM - with two real
 * nine-hole cards published, Howard and Westward. An aggregator also publishes
 * an "18-hole" card for it, and that card is not a course anybody plays: its
 * holes are lifted from the club's real nines and put back in the wrong order.
 *
 *   holes 1-4   317,104,250,308   Howard 1-4, exactly
 *   holes 5-6   345,125           WESTWARD 2-3, exactly
 *   holes 8-9   295,290           Howard 8-9, exactly
 *
 * Matched as a course it claimed eighteen fairways spanning two real loops,
 * absorbed the Westward card whole, and published an eighteen that does not
 * exist while a third of the facility went unmapped.
 *
 * The trap in fixing it: "its holes come from the sibling cards" is also the
 * exact definition of a LEGITIMATE combined card. Red + White really is Red's
 * nine followed by White's nine, and rejecting that would throw away the
 * composite evidence the facility reconciler is built to slice. These lock the
 * distinction - ORDER, not origin - and the direction that keeps a real card
 * from being accused because a fake one borrowed from it. */
const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const card = (name, distances) => ({
  name,
  holes: distances.map((distanceM, index) => ({ hole: index + 1, par: 4, distanceM }))
});

/* The real stored rows, distances as scraped. */
const HOWARD = card("Howeston Golf Course - Howard", [317, 104, 250, 308, 271, 87, 493, 295, 290]);
const WESTWARD = card("Howeston Golf Course - Westward", [300, 345, 125, 300, 140, 386, 239, 235, 436]);
const ALL_SQUARE = card("Howeston Golf Course | All Square Golf",
  [317, 104, 250, 308, 345, 125, 365, 295, 290, 112, 300, 386, 455, 92, 360, 330, 298, 436]);

(async () => {
  const core = await import("file://" + path.join(ROOT, "functions", "lib", "gd-scorecard-resolve.mjs"));
  const { stitchedCardVerdict } = core;

  test("the aggregator's spliced 18 is rejected", () => {
    const verdict = stitchedCardVerdict(ALL_SQUARE, [HOWARD, WESTWARD]);
    assert.strictEqual(verdict.stitched, true);
    assert.strictEqual(verdict.drawnFrom, 12, "twelve of its eighteen holes come straight off the two nines");
    assert.strictEqual(verdict.longestRun, 4, "and it never carries either nine whole and in order");
  });

  test("a GENUINE combined card is kept - this is the regression that matters", () => {
    /* Red + White: both nines present, contiguous, in play order. Rejecting this
       would destroy composite-facility support entirely. */
    const combined = card("Howard + Westward",
      HOWARD.holes.map(h => h.distanceM).concat(WESTWARD.holes.map(h => h.distanceM)));
    const verdict = stitchedCardVerdict(combined, [HOWARD, WESTWARD]);
    assert.strictEqual(verdict.stitched, false);
    assert.strictEqual(verdict.longestRun, 9, "a whole nine survives in order, which is what a play order looks like");
  });

  test("a real nine is never accused because a fake eighteen borrowed from it", () => {
    /* Symmetric matching accused the victim: Howard came back 'stitched' out of
       the aggregator card that had copied it. A nine is not assembled from an
       eighteen, and the test carries that direction. */
    assert.strictEqual(stitchedCardVerdict(HOWARD, [WESTWARD, ALL_SQUARE]).stitched, false);
    assert.strictEqual(stitchedCardVerdict(WESTWARD, [HOWARD, ALL_SQUARE]).stitched, false);
  });

  test("an ordinary 18 at a club with a nine is left alone", () => {
    const championship = card("Championship",
      [350, 160, 410, 380, 500, 170, 395, 340, 420, 365, 150, 430, 375, 510, 180, 400, 355, 440]);
    const parThree = card("Par 3 Course", [95, 120, 88, 140, 105, 132, 99, 115, 127]);
    assert.strictEqual(stitchedCardVerdict(championship, [parThree]).stitched, false);
  });

  test("a card with nothing to compare against is not judged", () => {
    assert.strictEqual(stitchedCardVerdict(HOWARD, []).stitched, false);
    assert.strictEqual(stitchedCardVerdict(HOWARD, []).reason, "not-enough-to-judge");
  });

  test("distances that are close but not equal still count as the same hole", () => {
    /* Two sources round and re-measure differently; a metre or two either way is
       the same fairway, and demanding exactness would let a fake card through. */
    const nudged = card("Aggregator",
      HOWARD.holes.map(h => h.distanceM + 2).concat([112, 455, 92, 360, 330, 298, 300, 386, 436]));
    assert.strictEqual(stitchedCardVerdict(nudged, [HOWARD, WESTWARD]).longestRun, 9,
      "a two-metre drift does not break the run that proves this is a real composite");
  });

  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("scorecard-stitched-cards failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("scorecard-stitched-cards passed: " + tests.length + " checks");
})();
