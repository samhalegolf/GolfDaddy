/* Scorecard parsing, against the two real layouts Te Arai Links appears in.
 *
 * Both grids below are transcribed from live pages on 2026-08-25, not invented:
 * GolfPass renders one wide table with Out/In/Tot columns, 18Birdies stacks two
 * nine-hole blocks. Between them they cover the two shapes every course-profile
 * site uses, and neither matches what the old parser assumed - holes as rows with
 * five tee columns in a fixed order.
 *
 * The payoff test is at the bottom: the two Te Arai courses have to be
 * distinguishable from par structure alone, because that is what the mapper will
 * use to decide which mapped loop is the North and which is the South.
 *
 * Run: node dev/scorecard-parse-core.test.js */

const assert = require("assert");
const path = require("path");
const CORE = "file://" + path.join(__dirname, "..", "functions", "lib", "gd-scorecard-parse-core.mjs");
const MATCH = "file://" + path.join(__dirname, "..", "functions", "lib", "gd-scorecard-match-core.mjs");

/* golfpass.com/travel-advisor/courses/43275-te-arai-links-golf-club-south-course
   One table, holes as columns, Out/In/Tot interleaved, seven tee rows, yards. */
const GOLFPASS_SOUTH = [
  ["Hole", "1", "2", "3", "4", "5", "6", "7", "8", "9", "Out", "10", "11", "12", "13", "14", "15", "16", "17", "18", "In", "Tot"],
  ["Handicap", "15", "1", "11", "7", "9", "3", "5", "17", "13", "", "4", "2", "12", "14", "16", "6", "8", "18", "10", "", ""],
  ["Par", "5", "4", "4", "4", "3", "4", "5", "3", "4", "36", "4", "4", "3", "5", "4", "4", "4", "3", "5", "36", "72"],
  ["Championship", "530", "444", "355", "484", "170", "381", "571", "156", "342", "3433", "433", "434", "226", "496", "317", "409", "340", "119", "571", "3345", "6778"],
  ["Back Combo", "530", "444", "355", "484", "153", "367", "550", "156", "342", "3381", "421", "416", "226", "480", "317", "383", "335", "119", "557", "3254", "6635"],
  ["Back", "507", "399", "340", "458", "153", "367", "550", "151", "342", "3267", "421", "416", "185", "480", "274", "383", "335", "113", "557", "3164", "6431"],
  ["Middle Combo", "507", "360", "327", "458", "149", "335", "501", "151", "328", "3116", "421", "384", "185", "480", "274", "366", "335", "113", "534", "3092", "6208"],
  ["Middle", "467", "360", "327", "437", "149", "335", "501", "132", "328", "3036", "358", "384", "154", "446", "254", "366", "297", "109", "534", "2902", "5938"],
  ["Forward Combo", "467", "305", "327", "399", "121", "335", "501", "132", "328", "2915", "293", "350", "154", "446", "254", "366", "284", "94", "470", "2711", "5626"],
  ["Forward", "441", "305", "284", "399", "121", "325", "439", "110", "287", "2711", "293", "350", "130", "427", "234", "297", "284", "94", "470", "2579", "5290"]
];

/* 18birdies.com/golf-courses/club/.../te-arai-links - North Course, Championship.
   Two stacked blocks, each with its own header and label rows. */
const BIRDIES_NORTH_FRONT = [
  ["Hole", "1", "2", "3", "4", "5", "6", "7", "8", "9", "OUT", "TOT"],
  ["Par", "4", "3", "4", "4", "4", "4", "3", "4", "5", "35", ""],
  ["Handicap", "17", "5", "15", "1", "3", "13", "11", "7", "9", "", ""],
  ["Championship", "311", "242", "386", "482", "468", "452", "191", "395", "560", "3487", ""]
];
const BIRDIES_NORTH_BACK = [
  ["Hole", "10", "11", "12", "13", "14", "15", "16", "17", "18", "IN", "TOT"],
  ["Par", "4", "5", "3", "4", "5", "3", "4", "3", "5", "36", "71"],
  ["Handicap", "6", "4", "14", "2", "10", "8", "16", "12", "18", "", ""],
  ["Championship", "451", "572", "209", "468", "539", "186", "315", "166", "538", "3444", "6931"]
];

(async () => {
  const core = await import(CORE);
  const match = await import(MATCH);

  /* ---------- GolfPass: one wide table -------------------------------- */
  const south = core.parseScorecardPage([GOLFPASS_SOUTH], { name: "South Course", unit: "yards" });
  assert.strictEqual(south.holeCount, 18, "all 18 holes, no Out/In/Tot mistaken for a hole");
  assert.strictEqual(south.par, 72, "par 72");
  assert.deepStrictEqual(south.holes.map(h => h.hole), Array.from({ length: 18 }, (_, i) => i + 1));

  /* Second-longest of seven tee rows: Championship is longest, Back Combo next. */
  assert.strictEqual(south.teeName, "Back Combo", "picks second-from-longest, not the tips");
  assert.deepStrictEqual(south.teeOptions,
    ["Championship", "Back Combo", "Back", "Middle Combo", "Middle", "Forward Combo", "Forward"],
    "all seven tee rows kept, in order, none swallowed as par or handicap");
  assert(!south.teeOptions.includes("Par"), "the par row is not a tee");
  assert(!south.teeOptions.includes("Handicap"), "the handicap row is not a tee");

  /* Back Combo hole 1 is 530 yards = 485m. */
  assert.strictEqual(south.holes[0].distanceM, Math.round(530 * 0.9144), "yards converted to metres");
  assert.strictEqual(south.holes[0].par, 5);
  assert.strictEqual(south.holes[0].strokeIndex, 15);
  /* Hole 17, the short one: 119 yards off the Championship tee, 119 off Back Combo. */
  assert.strictEqual(south.holes[16].par, 3);

  /* ---------- 18Birdies: two stacked blocks --------------------------- */
  const north = core.parseScorecardPage([BIRDIES_NORTH_FRONT, BIRDIES_NORTH_BACK], { name: "North Course", unit: "yards" });
  assert.strictEqual(north.holeCount, 18, "stacked nine-hole blocks merge into one card");
  assert.strictEqual(north.par, 71, "par 71 - and NOT 72, which is the South");
  assert.strictEqual(north.teeName, "Championship", "one tee row means it is also the preferred one");
  assert.strictEqual(north.holes[10].par, 5, "hole 11 is a par 5");
  assert.strictEqual(north.holes[10].distanceM, Math.round(572 * 0.9144));

  /* ---------- the fingerprint that identifies the course -------------- */
  const parThrees = card => card.holes.filter(h => h.par === 3).map(h => h.hole);
  const parFives = card => card.holes.filter(h => h.par === 5).map(h => h.hole);
  assert.deepStrictEqual(parThrees(south), [5, 8, 12, 17], "South par 3s");
  assert.deepStrictEqual(parThrees(north), [2, 7, 12, 15, 17], "North par 3s");
  assert.deepStrictEqual(parFives(south), [1, 7, 13, 18], "South par 5s");
  assert.deepStrictEqual(parFives(north), [9, 11, 14, 18], "North par 5s");
  /* Two par 3s in common out of seven distinct positions. The two courses are
     built by different architects to different pars and their short holes fall in
     different places - which is why relative structure identifies a course and
     total yardage does not. */
  const shared = parThrees(south).filter(h => parThrees(north).includes(h));
  assert.deepStrictEqual(shared, [12, 17], "the courses overlap on only two par 3s");

  /* ---------- matching a mapped loop back to the right card ----------- */
  /* Stand in for OSM playing lines: the South's own distances, scaled 1.06 and
     jittered, as a geometry measurement of the same ground would be. Absolute
     values are deliberately wrong; only the shape is right. */
  const asLoop = (card, id, scale) => ({
    id,
    lengths: card.holes.reduce((acc, h, i) => {
      if (h.distanceM) acc[h.hole] = Math.round(h.distanceM * scale + (i % 3) * 7 - 7);
      return acc;
    }, {})
  });
  const result = match.matchLoopsToCards(
    [asLoop(south, "loop-a", 1.06), asLoop(north, "loop-b", 1.06)],
    [north, south]
  );
  assert.strictEqual(result.resolved, true, "the assignment is confident: " + JSON.stringify(result.score));
  const byLoop = Object.fromEntries(result.assignment.map(p => [p.loopId, p.cardName]));
  assert.strictEqual(byLoop["loop-a"], "South Course", "the loop measured off the South card matches the South");
  assert.strictEqual(byLoop["loop-b"], "North Course", "and the North to the North");
  assert(result.margin > 0, "the winning assignment beats the swapped one");

  /* ---------- prose, for the pages with no table --------------------- */
  const facts = core.courseFactsFromText("The 18 hole, par 72 golf course has been designed as a traditional walking links golf experience");
  assert.strictEqual(facts.holeCount, 18, "the expectedHoles that was null when Te Arai broke");
  assert.strictEqual(facts.par, 72);
  assert.strictEqual(core.courseFactsFromText("Holes 18 Par 72 Length 6843 yds").holeCount, 18, "GolfPass's own summary block");
  assert.strictEqual(core.courseFactsFromText("a lovely day at the club").holeCount, null, "no invention when nothing is stated");

  /* ---------- gaps are kept, not thrown away ------------------------- */
  const partial = GOLFPASS_SOUTH.map(row => row.slice(0, 10));
  const front = core.parseScorecardPage([partial], { unit: "yards" });
  assert.strictEqual(front.holeCount, 9, "nine holes is a usable card, not a failure");

  console.log("scorecard parse tests passed");
})().catch(error => { console.error(error); process.exit(1); });
