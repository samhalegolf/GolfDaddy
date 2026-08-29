/*
 * Column split on scorecard geometry — the practice reader's Stage 1, given the
 * shape it actually meets on a card rather than on a launch-monitor table.
 *
 * A card is a harder split than a launch-monitor table in one specific way:
 * twenty-one narrow columns of one to four digits, packed at a tight pitch,
 * with a wide label margin on the left that belongs to no column at all. The
 * launch-monitor case is eleven wide columns and a narrow club margin.
 *
 * No image, no OCR — synthetic value boxes only.
 *
 * Run:  node dev/scorecard-ocr-split.test.js
 */
"use strict";
const assert = require("assert");
const OCR = require("../scripts/clarity-scorecard-ocr.js");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("PASS  " + name); }
  catch (error) { failures += 1; console.log("FAIL  " + name + "\n      " + error.message); }
}

const MARGIN = 200;         // label column: Hole / Par / Index / tee names
const PITCH = 100;
const COLUMNS = 21;         // 9 holes + Out + 9 holes + In + Total
const FIRST_CX = MARGIN + PITCH / 2;
const centres = Array.from({ length: COLUMNS }, (_, i) => FIRST_CX + i * PITCH);
const SOURCE_WIDTH = MARGIN + COLUMNS * PITCH + 40;

/* One box per cell per row. `widths` gives each row's value width, so the hole
   row's one- and two-digit numbers and a tee row's three-digit ones are laid
   out the way they really sit: centred, with the narrow rows leaving more air. */
function boxesFor(rows, options = {}) {
  const fused = options.fused || [];
  const boxes = [];
  rows.forEach((row, r) => {
    const cy = 100 + r * 70;
    const half = row.width / 2;
    centres.forEach((cx, c) => {
      if (row.skip && row.skip.includes(c)) return;
      const group = fused.find(g => g.row === r && g.columns[0] === c);
      if (group) {
        const first = centres[group.columns[0]], last = centres[group.columns[group.columns.length - 1]];
        boxes.push(box(first - half, last + half, cy));
        return;
      }
      if (fused.some(g => g.row === r && g.columns.includes(c) && g.columns[0] !== c)) return;
      boxes.push(box(cx - half, cx + half, cy));
    });
  });
  return boxes;
}
function box(x0, x1, cy) {
  return { x0, x1, y0: cy - 13, y1: cy + 13, cx: (x0 + x1) / 2, cy, w: x1 - x0, h: 26 };
}

const CARD_ROWS = [
  { width: 30 },   // hole numbers
  { width: 22 },   // par
  { width: 30 },   // stroke index
  { width: 56 },   // tee
  { width: 56 },   // tee
  { width: 56 }    // tee
];

check("a full card splits into its 21 columns", () => {
  const columns = OCR.splitColumns(boxesFor(CARD_ROWS), { sourceWidth: SOURCE_WIDTH });
  assert.strictEqual(columns.length, COLUMNS, "spans: " + columns.map(c => `${Math.round(c.left)}-${Math.round(c.right)}`).join(" "));
});

check("the label margin does not become a column of its own", () => {
  // It cannot be dropped outright — the split runs from x=0 — but it must be
  // folded into the first column, and that column's boundary must then be
  // pulled back off the margin so the caller has somewhere to read tee names.
  const columns = OCR.splitColumns(boxesFor(CARD_ROWS), { sourceWidth: SOURCE_WIDTH });
  assert.ok(columns[0].left > MARGIN * 0.5,
    `first column starts at ${Math.round(columns[0].left)}; the margin runs to ${MARGIN}`);
  assert.ok(columns[0].left < FIRST_CX,
    `first column starts at ${Math.round(columns[0].left)}, past its own values`);
});

check("fused reads are pulled apart again", () => {
  // Two neighbouring three-digit yardages read as one box, on two of the three
  // tee rows — the exact failure the outlier re-split and positional de-fuse
  // exist for.
  const columns = OCR.splitColumns(boxesFor(CARD_ROWS, {
    fused: [{ row: 3, columns: [4, 5] }, { row: 4, columns: [4, 5] }, { row: 5, columns: [11, 12] }]
  }), { sourceWidth: SOURCE_WIDTH });
  assert.strictEqual(columns.length, COLUMNS, "got " + columns.length);
});

check("a card printed as nine columns splits into nine", () => {
  const nine = centres.slice(0, 9);
  const rows = CARD_ROWS.map(r => Object.assign({}, r, { skip: centres.map((_, i) => i).filter(i => i >= 9) }));
  const columns = OCR.splitColumns(boxesFor(rows), { sourceWidth: MARGIN + 9 * PITCH + 40 });
  assert.strictEqual(columns.length, 9, "spans: " + columns.map(c => Math.round(c.left)).join(","));
  assert.ok(nine.length === 9);
});

check("blank cells do not collapse a column", () => {
  // The stroke index has no value in the Out / In / Total columns on most cards.
  const rows = CARD_ROWS.map((r, i) => (i === 2 ? Object.assign({}, r, { skip: [9, 19, 20] }) : r));
  const columns = OCR.splitColumns(boxesFor(rows), { sourceWidth: SOURCE_WIDTH });
  assert.strictEqual(columns.length, COLUMNS, "got " + columns.length);
});

check("too little to be a table returns nothing rather than a guess", () => {
  assert.deepStrictEqual(OCR.splitColumns([box(10, 40, 10), box(60, 90, 10)], { sourceWidth: 200 }), []);
});

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL TESTS PASSED");
process.exit(failures ? 1 : 0);
