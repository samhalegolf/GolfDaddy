/*
 * Headless test: number-like filtering BEFORE the cut, and header text taken
 * from the leftover (non-number) words on each strip.
 *
 * Run:  node dev/table-ocr-words.test.js
 */
const OCR = require("../scripts/clarity-table-ocr.js");

function word(text, x0, y0, x1, y1) { return { text, bbox: { x0, y0, x1, y1 } }; }

// A header row (letters) + one data row (numbers, plus an R direction marker).
const words = [
  word("BALL", 60, 0, 100, 20), word("SPEED", 105, 0, 145, 20),   // col1 header
  word("LAUNCH", 170, 0, 250, 20),                                  // col2 header
  word("SIDE", 285, 0, 320, 20), word("ANGLE", 325, 0, 365, 20),   // col3 header
  word("94.4", 70, 40, 130, 62),                                    // col1 value
  word("11.2", 180, 40, 240, 62),                                   // col2 value
  word("3.7", 285, 40, 330, 62), word("R", 335, 42, 350, 60)        // col3 value + dir
];
const columns = [
  { left: 50, right: 150 }, { left: 160, right: 260 }, { left: 270, right: 370 }
];

let allOk = true;
function check(name, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: got ${JSON.stringify(got)}${ok ? "" : `, expected ${JSON.stringify(expected)}`}`);
  if (!ok) allOk = false;
}

const numBoxes = OCR.numberBoxesFromWords(words);
check("number filter keeps only values (94.4, 11.2, 3.7)", numBoxes.map(b => b.text).sort(), ["11.2", "3.7", "94.4"]);
check("header text = leftover words per strip (header band only)", OCR.headerTextForColumns(columns, words, { headerBottom: 30 }), ["BALL SPEED", "LAUNCH", "SIDE ANGLE"]);

console.log(allOk ? "\nALL TESTS PASSED" : "\nTESTS FAILED");
process.exit(allOk ? 0 : 1);
