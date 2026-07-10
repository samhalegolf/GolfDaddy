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

// Columns as the splitter produces them: left/right are the CUT bounds (tile
// gap-to-gap); x0/x1 are the tight value extent inside each.
const columns = [
  { left: 0,   right: 150, x0: 85,  x1: 115, metricKey: "ballSpeed" },
  { left: 150, right: 300, x0: 235, x1: 265, metricKey: "launch" },
  { left: 300, right: 450, x0: 385, x1: 415, metricKey: "carry" }
];
const strips = OCR.stripBoundaries(columns, 500);

// Strips must be the splitter's OWN cut bounds — not re-derived midpoints.
check("strip count", strips.length, 3);
check("strip spans = column cut bounds", strips.map(s => `${s.left}-${s.right}`), ["0-150", "150-300", "300-450"]);
check("tight value bounds carried", strips.map(s => `${s.valLeft}-${s.valRight}`), ["85-115", "235-265", "385-415"]);
check("no gaps/overlaps between strips", strips.slice(1).every((s, i) => s.left === strips[i].right), true);
check("names carried through", strips.map(s => s.metricKey), ["ballSpeed", "launch", "carry"]);

console.log(allOk ? "\nALL TESTS PASSED" : "\nTESTS FAILED");
process.exit(allOk ? 0 : 1);
