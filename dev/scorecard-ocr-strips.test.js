/*
 * Strip identification — the stage that replaces the practice reader's header
 * alias registry. No image, no OCR: values in, a kind out.
 *
 * Run:  node dev/scorecard-ocr-strips.test.js
 */
"use strict";
const assert = require("assert");
const OCR = require("../scripts/clarity-scorecard-ocr.js");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("PASS  " + name); }
  catch (error) { failures += 1; console.log("FAIL  " + name + "\n      " + error.message); }
}
const strip = list => list.map((n, i) => ({ column: i, n }));
const kindOf = list => OCR.classifyStrip(strip(list)).kind;

// ---- readInteger --------------------------------------------------------
check("plain digits read", () => assert.strictEqual(OCR.readInteger("437"), 437));
check("thousands separator dropped", () => assert.strictEqual(OCR.readInteger("3,433"), 3433));
check("a majority-digit token has its lookalikes corrected", () => {
  assert.strictEqual(OCR.readInteger("4O6"), 406);
  assert.strictEqual(OCR.readInteger("l7"), 17);
});
check("a word is not a number, however much it looks like one", () => {
  // The whole reason the correction is narrow: OUT sits on the hole row of every
  // card printed, and "0UT" there would be hole 0 and shift the card sideways.
  assert.strictEqual(OCR.readInteger("OUT"), null);
  assert.strictEqual(OCR.readInteger("IN"), null);
  assert.strictEqual(OCR.readInteger("TOT"), null);
  assert.strictEqual(OCR.readInteger("Blue"), null);
  assert.strictEqual(OCR.readInteger(""), null);
});
check("five digits is not a scorecard value", () => assert.strictEqual(OCR.readInteger("12345"), null));

// ---- classifyStrip ------------------------------------------------------
check("1..18 is the hole row", () =>
  assert.strictEqual(kindOf([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]), "holes"));
check("10..18 is a hole row too — a card printed in two halves", () =>
  assert.strictEqual(kindOf([10,11,12,13,14,15,16,17,18]), "holes"));
check("a hole row with a blanked cell still counts", () =>
  assert.strictEqual(kindOf([1,2,3,4,6,7,8,9]), "holes"));
check("3s to 5s are par", () =>
  assert.strictEqual(kindOf([5,4,4,3,4,4,5,3,4]), "par"));
check("a par-3 course is still par", () =>
  assert.strictEqual(kindOf([3,3,3,3,3,3,3,3,3]), "par"));
check("distinct 1-18 out of order is the stroke index", () =>
  assert.strictEqual(kindOf([7,3,11,15,1,9,13,17,5]), "index"));
check("three-digit yardages are a tee", () =>
  assert.strictEqual(kindOf([530,444,355,175,421,398,512,168,430]), "distance"));
check("metres are a tee as well", () =>
  assert.strictEqual(kindOf([485,406,325,160,385,364,468,154,393]), "distance"));
check("a stroke index is never mistaken for a tee", () =>
  assert.notStrictEqual(kindOf([7,3,11,15,1,9,13,17,5]), "distance"));
check("an ascending run is holes, not the index it also resembles", () => {
  // The distinguishing fact is that hole numbers COUNT. Requiring a start at 1
  // instead would drop the back nine of a stacked card.
  assert.strictEqual(kindOf([1,2,3,4,5,6,7,8,9]), "holes");
  assert.strictEqual(kindOf([1,3,5,7,9,11,13,15,17]), "index");
});
check("too few values identifies as nothing rather than guessing", () => {
  const out = OCR.classifyStrip(strip([4, 4, 5]));
  assert.strictEqual(out.kind, "");
  assert.ok(/only 3 values/.test(out.reason), out.reason);
});
check("scores and putts fall through unidentified", () =>
  assert.strictEqual(kindOf([28, 31, 29, 33, 27, 30, 35, 26, 32]), ""));

// ---- labels -------------------------------------------------------------
check("a readable tee name is kept", () =>
  assert.strictEqual(OCR.labelForStrip("distance", "Championship", 1), "Championship"));
check("a label the grid parser would discard becomes a tee ordinal", () => {
  assert.strictEqual(OCR.labelForStrip("distance", "Yards", 2), "Tee 2");
  assert.strictEqual(OCR.labelForStrip("distance", "", 3), "Tee 3");
  assert.strictEqual(OCR.labelForStrip("distance", "~~", 1), "Tee 1");
});
check("classification names the structural rows, not the OCR", () => {
  assert.strictEqual(OCR.labelForStrip("holes", "H0LE", 0), "Hole");
  assert.strictEqual(OCR.labelForStrip("par", "PRA", 0), "Par");
  assert.strictEqual(OCR.labelForStrip("index", "1NDEX", 0), "Index");
});
check("units are only reported when the card said so", () => {
  assert.strictEqual(OCR.unitFromText("Yards"), "yards");
  assert.strictEqual(OCR.unitFromText("Metres"), "metres");
  assert.strictEqual(OCR.unitFromText("Championship"), null);
});

// ---- buildGrids ---------------------------------------------------------
function makeStrip(kind, label, values, cy) {
  return { kind, label, cy, values: values.map((n, i) => ({ column: i, n })) };
}
check("one card becomes one grid, labelled row first", () => {
  const grids = OCR.buildGrids([
    makeStrip("holes", "HOLE", [1,2,3,4,5,6,7,8,9], 10),
    makeStrip("par", "PAR", [5,4,4,3,4,4,5,3,4], 20),
    makeStrip("distance", "Blue", [530,444,355,175,421,398,512,168,430], 30)
  ]);
  assert.strictEqual(grids.length, 1);
  assert.deepStrictEqual(grids[0][0], ["Hole","1","2","3","4","5","6","7","8","9"]);
  assert.deepStrictEqual(grids[0][1], ["Par","5","4","4","3","4","4","5","3","4"]);
  assert.strictEqual(grids[0][2][0], "Blue");
});
check("a second hole row that continues the first stays the same card", () => {
  const grids = OCR.buildGrids([
    makeStrip("holes", "HOLE", [1,2,3,4,5,6,7,8,9], 10),
    makeStrip("par", "PAR", [5,4,4,3,4,4,5,3,4], 20),
    makeStrip("holes", "HOLE", [10,11,12,13,14,15,16,17,18], 30),
    makeStrip("par", "PAR", [4,3,5,4,4,4,3,4,5], 40)
  ]);
  assert.strictEqual(grids.length, 2);
  assert.strictEqual(grids[1].continuation, true);
  assert.strictEqual(grids[1].label, "");
});
check("a second hole row that repeats the first is a second card", () => {
  const grids = OCR.buildGrids([
    makeStrip("holes", "HOLE", [1,2,3,4,5,6,7,8,9], 10),
    makeStrip("par", "PAR", [5,4,4,3,4,4,5,3,4], 20),
    makeStrip("holes", "HOLE", [1,2,3,4,5,6,7,8,9], 30),
    makeStrip("par", "PAR", [4,3,5,4,4,4,3,4,5], 40)
  ]);
  assert.strictEqual(grids.length, 2);
  assert.strictEqual(grids[1].continuation, false);
  assert.ok(grids[1].label, "the second card must be labelled or it merges into the first");
});
check("tee rows are numbered in the order they are printed", () => {
  const grids = OCR.buildGrids([
    makeStrip("holes", "HOLE", [1,2,3,4,5,6,7,8,9], 10),
    makeStrip("distance", "", [530,444,355,175,421,398,512,168,430], 20),
    makeStrip("distance", "", [498,421,332,158,400,372,486,150,407], 30)
  ]);
  assert.strictEqual(grids[0][1][0], "Tee 1");
  assert.strictEqual(grids[0][2][0], "Tee 2");
});
check("strips above the first hole row belong to no card", () => {
  const grids = OCR.buildGrids([
    makeStrip("distance", "stray", [530,444,355,175,421,398,512,168,430], 5),
    makeStrip("holes", "HOLE", [1,2,3,4,5,6,7,8,9], 10),
    makeStrip("par", "PAR", [5,4,4,3,4,4,5,3,4], 20)
  ]);
  assert.strictEqual(grids.length, 1);
  assert.strictEqual(grids[0].length, 2);
});
check("unidentified strips are left out rather than guessed at", () => {
  const grids = OCR.buildGrids([
    makeStrip("holes", "HOLE", [1,2,3,4,5,6,7,8,9], 10),
    makeStrip("", "SCORE", [28,31,29,33,27,30,35,26,32], 20),
    makeStrip("par", "PAR", [5,4,4,3,4,4,5,3,4], 30)
  ]);
  assert.strictEqual(grids[0].length, 2);
});

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL TESTS PASSED");
process.exit(failures ? 1 : 0);
