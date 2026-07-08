/*
 * Headless test for Stage 0 (value-box detection) of clarity-table-ocr.
 * Proves the fix that PREVENTS fusion: grouping digit components across a row
 * band with a data-driven gap threshold keeps closely-spaced columns separate,
 * so the splitter never needs the positional fallback.
 *
 * Run:  node dev/table-ocr-boxes.test.js
 */
const { groupComponentsIntoValues } = require("../scripts/clarity-table-ocr.js");

const GLYPH_W = 8, GLYPH_H = 20, INTRA_GAP = 3; // digit spacing inside one number

// Emit `glyphs` digit components for one value starting at x0; return next x.
function emitValue(components, x0, glyphs, cy) {
  let x = x0;
  for (let i = 0; i < glyphs; i += 1) {
    components.push({ x0: x, x1: x + GLYPH_W, y0: cy - GLYPH_H / 2, y1: cy + GLYPH_H / 2, area: GLYPH_W * GLYPH_H * 0.5 });
    x += GLYPH_W + INTRA_GAP;
  }
  return x - INTRA_GAP; // right edge of last glyph
}

// One row: 11 values. Cols 1-3 and 10-11 packed tight (12px inter-column gap);
// the rest at a normal spacing (100px). glyph counts mimic real values.
function buildRow(cy) {
  const glyphCounts = [3, 4, 3, 4, 3, 3, 4, 2, 3, 3, 3]; // 94.4, 11.2, 3.7, 4596, 176 ...
  const interGap = [12, 12, 100, 100, 100, 100, 100, 100, 12]; // gap AFTER each value (10 gaps for 11 values)
  const comps = [];
  let x = 100;
  for (let c = 0; c < glyphCounts.length; c += 1) {
    const right = emitValue(comps, x, glyphCounts[c], cy);
    x = right + (interGap[c] || 100);
  }
  return comps;
}

let allOk = true;
function check(name, got, expected) {
  const ok = got === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: got ${got}, expected ${expected}`);
  if (!ok) allOk = false;
}

// Main: a full row with two tight clusters must yield 11 separate value-boxes.
const rowComps = buildRow(120);
const values = groupComponentsIntoValues(rowComps, { charHeight: GLYPH_H });
check("row with tight columns -> 11 value boxes (no fusion)", values.length, 11);

// Guard: a single multi-digit number must stay ONE box (not over-split).
const one = [];
emitValue(one, 100, 4, 120); // "1018"
check("single number stays one box", groupComponentsIntoValues(one, { charHeight: GLYPH_H }).length, 1);

// Guard: a decimal value "94.4" (digits + dot component) stays one box.
const dec = [];
emitValue(dec, 100, 4, 120);
check("decimal value stays one box", groupComponentsIntoValues(dec, { charHeight: GLYPH_H }).length, 1);

console.log(allOk ? "\nALL TESTS PASSED" : "\nTESTS FAILED");
process.exit(allOk ? 0 : 1);
