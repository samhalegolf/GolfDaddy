/*
 * Headless test for strip boundaries: each column is cut at the midpoint between
 * adjacent column centres, so a strip owns its full (wide) header + values +
 * direction marker, with no overlap into neighbours.
 *
 * Run:  node dev/table-ocr-strips.test.js
 */
const OCR = require("../scripts/clarity-table-ocr.js");

let allOk = true;
function check(name, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: got ${JSON.stringify(got)}${ok ? "" : `, expected ${JSON.stringify(expected)}`}`);
  if (!ok) allOk = false;
}

// Three narrow value columns centred at 100 / 250 / 400 in a 500-wide image.
const columns = [
  { left: 85, right: 115, metricKey: "ballSpeed" },
  { left: 235, right: 265, metricKey: "launch" },
  { left: 385, right: 415, metricKey: "carry" }
];
const strips = OCR.stripBoundaries(columns, 500);

// Boundaries should tile at the midpoints (175, 325) with symmetric edges.
check("strip count", strips.length, 3);
check("strip spans (midpoint tiling)", strips.map(s => `${s.left}-${s.right}`), ["25-175", "175-325", "325-475"]);
check("no gaps/overlaps between strips", strips.slice(1).every((s, i) => s.left === strips[i].right), true);
check("names carried through", strips.map(s => s.metricKey), ["ballSpeed", "launch", "carry"]);

console.log(allOk ? "\nALL TESTS PASSED" : "\nTESTS FAILED");
process.exit(allOk ? 0 : 1);
