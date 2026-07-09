/*
 * Headless test for Stage 1 (column splitter) of clarity-table-ocr.
 * No image, no OCR — pure geometry. Reproduces the documented merge bug:
 * on the real image, Ball Speed / Launch Angle / Side Angle sit close enough
 * that their number-boxes fuse into one wide corridor (and Total / To Pin do
 * the same), collapsing 11 columns to ~8/9. The outlier re-split is supposed
 * to recover them. This test proves whether it does.
 *
 * Run:  node dev/table-ocr-split.test.js
 */
const { splitColumns } = require("../scripts/clarity-table-ocr.js");

// A "cell" is either a single column center, or a FUSED group of centers that
// OCR merged into one solid word-box (the real failure mode). makeBoxes emits
// one box per cell per row: a normal cell -> box of width `w`; a fused group
// -> one box spanning from the first center's left to the last center's right.
function makeBoxes(cells, { rows = 13, rowTop = 100, rowPitch = 46, boxH = 26, cellW = 70 } = {}) {
  const boxes = [];
  for (let r = 0; r < rows; r += 1) {
    const cy = rowTop + r * rowPitch;
    cells.forEach(cell => {
      const centers = cell.fused || [cell.cx];
      const x0 = Math.min(...centers) - cellW / 2;
      const x1 = Math.max(...centers) + cellW / 2;
      const y0 = cy - boxH / 2, y1 = cy + boxH / 2;
      boxes.push({ x0, y0, x1, y1, cx: (x0 + x1) / 2, cy, w: x1 - x0, h: y1 - y0 });
    });
  }
  return boxes;
}

// Real column centers: 11 columns at a normal ~150px pitch. The bug doc reports
// the merged corridor came out ~3x a normal column wide (432px) — i.e. the
// columns are NORMAL pitch, but OCR fused cols 1-3 (Ball Speed/Launch/Side) and
// cols 10-11 (Total/To Pin) into single solid boxes with no internal gap.
const CENTERS = Array.from({ length: 11 }, (_, i) => 140 + i * 150);

// Control: every column is its own box -> trivially 11.
const evenCells = CENTERS.map(cx => ({ cx }));

// Bug: cols 1-3 fused into one box, cols 10-11 fused into one box.
const bugCells = [
  { fused: [CENTERS[0], CENTERS[1], CENTERS[2]] },
  { cx: CENTERS[3] }, { cx: CENTERS[4] }, { cx: CENTERS[5] },
  { cx: CENTERS[6] }, { cx: CENTERS[7] }, { cx: CENTERS[8] },
  { fused: [CENTERS[9], CENTERS[10]] }
];

function run(name, cells, expected, opts) {
  const boxes = makeBoxes(cells);
  const sourceWidth = Math.round(Math.max(...CENTERS) + 100);
  const cols = splitColumns(boxes, { sourceWidth, debug: false, ...opts });
  const ok = cols.length === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: got ${cols.length} columns, expected ${expected}`);
  if (!ok) {
    console.log("        column spans:", cols.map(c => `${Math.round(c.left)}-${Math.round(c.right)}`).join("  "));
  }
  return ok;
}

let allOk = true;
allOk = run("even control (11 separate boxes)", evenCells, 11) && allOk;
allOk = run("bug case (fused OCR boxes)", bugCells, 11) && allOk;

console.log(allOk ? "\nALL TESTS PASSED" : "\nTESTS FAILED");
process.exit(allOk ? 0 : 1);
