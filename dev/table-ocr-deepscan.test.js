/*
 * Headless tests for the deep scan (Stage 3.5) blanking method:
 *   - classifyGlyphMask: L / R / + / - shape classification from an ink mask
 *   - partitionDirectionCell: value cluster vs marker candidates
 *   - deepScanDirectionCell: end-to-end on a synthetic cell mask
 *
 * Run:  node dev/table-ocr-deepscan.test.js
 */
const ocr = require("../scripts/clarity-table-ocr.js");
const { classifyGlyphMask, partitionDirectionCell, cropMask } = ocr._internals;

let allOk = true;
function check(name, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: got ${JSON.stringify(got)}${ok ? "" : `, expected ${JSON.stringify(expected)}`}`);
  if (!ok) allOk = false;
}

// ---- helpers: draw glyphs into a mask from ASCII art ("#" = ink) ----
function maskFromArt(lines) {
  const h = lines.length, w = Math.max(...lines.map(l => l.length));
  const mask = new Uint8Array(w * h);
  lines.forEach((line, y) => {
    for (let x = 0; x < line.length; x += 1) if (line[x] === "#") mask[y * w + x] = 1;
  });
  return { mask, w, h };
}

// Upscale a mask by an integer factor (deep scan crops are high-res).
function scaleMask(m, f) {
  const w = m.w * f, h = m.h * f;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      mask[y * w + x] = m.mask[Math.floor(y / f) * m.w + Math.floor(x / f)];
    }
  }
  return { mask, w, h };
}

// ---- glyph art (7 wide x 9 tall, like a rendered table marker) ----
const ART = {
  L: [
    "##     ",
    "##     ",
    "##     ",
    "##     ",
    "##     ",
    "##     ",
    "##     ",
    "#######",
    "#######"
  ],
  R: [
    "###### ",
    "##   ##",
    "##   ##",
    "##   ##",
    "###### ",
    "## ##  ",
    "##  ## ",
    "##   ##",
    "##   ##"
  ],
  plus: [
    "       ",
    "   #   ",
    "   #   ",
    "   #   ",
    "#######",
    "   #   ",
    "   #   ",
    "   #   ",
    "       "
  ],
  // NOTE: classifyGlyphMask receives TIGHT bounding-box crops, so glyph art
  // for direct classification must not carry blank padding rows/columns.
  minus: [
    "######",
    "######"
  ],
  // Digits that must NOT classify as marker letters.
  eight: [
    " ##### ",
    "##   ##",
    "##   ##",
    " ##### ",
    "##   ##",
    "##   ##",
    " ##### "
  ],
  zero: [
    " ##### ",
    "##   ##",
    "##   ##",
    "##   ##",
    "##   ##",
    "##   ##",
    " ##### "
  ]
};

// ---- classifyGlyphMask ----
for (const f of [1, 3]) { // raw size and deep-scan-style upscaled size
  check(`classify L (x${f})`, classifyGlyphMask(scaleMask(maskFromArt(ART.L), f)).glyph, "L");
  check(`classify R (x${f})`, classifyGlyphMask(scaleMask(maskFromArt(ART.R), f)).glyph, "R");
  check(`classify + (x${f})`, classifyGlyphMask(scaleMask(maskFromArt(ART.plus), f)).glyph, "+");
  check(`classify - (x${f})`, classifyGlyphMask(scaleMask(maskFromArt(ART.minus), f)).glyph, "-");
}
check("digit 8 is not a letter marker", ["L", "R"].includes(classifyGlyphMask(scaleMask(maskFromArt(ART.eight), 3)).glyph) ? "letter" : "not-letter", "not-letter");
check("digit 0 is not a letter marker", ["L", "R"].includes(classifyGlyphMask(scaleMask(maskFromArt(ART.zero), 3)).glyph) ? "letter" : "not-letter", "not-letter");
check("empty mask classifies as nothing", classifyGlyphMask({ mask: new Uint8Array(4), w: 2, h: 2 }).glyph, "");

// ---- build a synthetic direction cell: "3.7" then a gap then "R" ----
// Digits are ~14px tall blocks; marker sits ~10px to the right of the number.
function stampArt(cell, art, ox, oy) {
  art.forEach((line, y) => {
    for (let x = 0; x < line.length; x += 1) {
      if (line[x] === "#") cell.mask[(oy + y) * cell.w + (ox + x)] = 1;
    }
  });
}
function makeCell(markerArt) {
  const cell = { mask: new Uint8Array(90 * 20), w: 90, h: 20 };
  const digit = ["#####", "#   #", "#   #", "#   #", "#   #", "#   #", "#   #", "#####"]; // block "0"-ish digit
  stampArt(cell, digit.map(l => l), 4, 5);   // digit 1
  stampArt(cell, [".", "#"].map(() => "##"), 12, 11); // decimal dot
  stampArt(cell, digit.map(l => l), 17, 5);  // digit 2
  if (markerArt) stampArt(cell, markerArt, 44, 4); // marker after a clear gap
  return cell;
}
// components straight from the mask (simple two-pass grouping via the module's
// own partition path expects component boxes; derive them here with a tiny CC)
function componentsFromMask(m) {
  const seen = new Uint8Array(m.w * m.h), comps = [];
  for (let sy = 0; sy < m.h; sy += 1) for (let sx = 0; sx < m.w; sx += 1) {
    const s = sy * m.w + sx;
    if (!m.mask[s] || seen[s]) continue;
    const stack = [s]; seen[s] = 1;
    let x0 = sx, x1 = sx, y0 = sy, y1 = sy, area = 0;
    while (stack.length) {
      const cur = stack.pop(); const x = cur % m.w, y = (cur - x) / m.w; area += 1;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue;
        const nb = ny * m.w + nx;
        if (m.mask[nb] && !seen[nb]) { seen[nb] = 1; stack.push(nb); }
      }
    }
    comps.push({ x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
  }
  return comps;
}

const cellR = makeCell(ART.R);
const compsR = componentsFromMask(cellR);
const partsR = partitionDirectionCell(compsR, {});
check("partition finds a value cluster", !!partsR.valueBox, true);
check("partition finds exactly one marker candidate", partsR.markerComponents.length, 1);
check("marker candidate sits right of the value", partsR.markerComponents[0].x0 > partsR.valueBox.x1, true);

const deepR = ocr.deepScanDirectionCell(cellR, compsR, {});
check("deep scan R cell -> direction R", deepR.direction, "R");
const deepL = (() => { const c = makeCell(ART.L); return ocr.deepScanDirectionCell(c, componentsFromMask(c), {}); })();
check("deep scan L cell -> direction L", deepL.direction, "L");
const deepMinus = (() => { const c = makeCell(ART.minus); return ocr.deepScanDirectionCell(c, componentsFromMask(c), {}); })();
check("deep scan '-' cell -> direction L", deepMinus.direction, "L");
const deepPlus = (() => { const c = makeCell(ART.plus); return ocr.deepScanDirectionCell(c, componentsFromMask(c), {}); })();
check("deep scan '+' cell -> direction R", deepPlus.direction, "R");
const deepNone = (() => { const c = makeCell(null); return ocr.deepScanDirectionCell(c, componentsFromMask(c), {}); })();
check("deep scan cell with NO marker -> no direction (never guesses)", deepNone.direction, "");

// cropMask sanity
const cm = cropMask(cellR, 0, 0, 4, 4);
check("cropMask size", [cm.w, cm.h], [5, 5]);

// ---- findMarkerColumn: strip-level cross-row alignment ----
// Markers align in the same x-range on every row; number fragments land at
// varying x. The column must come from the aligned cluster only.
function band(groups) { return { y0: 0, y1: 10, groups }; }
function grp(x0, x1, ink) { return { x0, x1, cx: (x0 + x1) / 2, ink }; }
const CH = 10; // charHeight
// 13 bands: value cluster (heavy ink), marker at x 44-50 on 10 bands,
// stray fragments at varying x on a few bands.
const alignedBands = [];
for (let i = 0; i < 13; i += 1) {
  const groups = [grp(4, 4 + 8 + (i % 5), 300)]; // value width varies per row
  if (i < 10) groups.push(grp(44, 50, 30));      // aligned marker
  if (i % 4 === 0) groups.push(grp(16 + i, 20 + i, 8)); // wandering fragment, far from the marker
  alignedBands.push(band(groups));
}
const col = ocr.findMarkerColumn(alignedBands, { charHeight: CH });
check("marker column found", !!col, true);
check("marker column support", col ? col.support : 0, 10);
check("marker column covers the marker", col ? (col.x0 <= 44 && col.x1 >= 50) : false, true);
check("marker column excludes wandering fragments", col ? col.x0 >= 40 : false, true);

// No markers at all -> no column (fragments alone must not align)
const noMarkerBands = [];
for (let i = 0; i < 13; i += 1) {
  const groups = [grp(4, 24 + (i % 5), 300)];
  if (i % 5 === 0) groups.push(grp(28 + i * 2, 32 + i * 2, 8)); // scattered junk
  noMarkerBands.push(band(groups));
}
check("no aligned markers -> null", ocr.findMarkerColumn(noMarkerBands, { charHeight: CH }), null);

// Only 2 bands agreeing -> below the support floor -> null
const sparseBands = [];
for (let i = 0; i < 13; i += 1) {
  const groups = [grp(4, 24, 300)];
  if (i < 2) groups.push(grp(44, 50, 30));
  sparseBands.push(band(groups));
}
check("2 aligned rows is not a column", ocr.findMarkerColumn(sparseBands, { charHeight: CH }), null);

// side:"left" — +/- sign prefixes align LEFT of the value
const signBands = [];
for (let i = 0; i < 13; i += 1) {
  const groups = [grp(20, 20 + 12 + (i % 4), 300)]; // value
  if (i % 2 === 0) groups.push(grp(8, 13, 12));     // aligned '-' sign (negatives only)
  signBands.push(band(groups));
}
const leftCol = ocr.findMarkerColumn(signBands, { charHeight: CH, side: "left" });
check("signs mode: left column found", !!leftCol, true);
check("signs mode: covers the sign", leftCol ? (leftCol.x0 <= 8 && leftCol.x1 >= 13) : false, true);
check("signs mode ignores right-side markers", ocr.findMarkerColumn(alignedBands, { charHeight: CH, side: "left" }), null);
check("letters mode ignores left-side signs", ocr.findMarkerColumn(signBands, { charHeight: CH, side: "right" }), null);

// ---- isSummaryLabel: OCR-garbled summary labels must still be caught ----
check("summary: AVERAGE", ocr.isSummaryLabel("AVERAGE"), true);
check("summary: AVERACE (garbled)", ocr.isSummaryLabel("AVERACE"), true);
check("summary: AVFRAGE (garbled)", ocr.isSummaryLabel("AVFRAGE"), true);
check("summary: SID DEV (garbled)", ocr.isSummaryLabel("SID DEV"), true);
check("summary: STD. DEV", ocr.isSummaryLabel("STD. DEV"), true);
check("not summary: 7i", ocr.isSummaryLabel("7i"), false);
check("not summary: Driver", ocr.isSummaryLabel("Driver"), false);
check("not summary: empty", ocr.isSummaryLabel(""), false);

console.log(allOk ? "\nALL PASS" : "\nFAILURES PRESENT");
process.exit(allOk ? 0 : 1);
