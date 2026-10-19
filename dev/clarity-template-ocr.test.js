/*
 * Headless tests for template mode (scripts/clarity-template-ocr.js).
 *
 * A synthetic table is drawn into an ink mask: a two-line header, a label
 * column, eleven value columns of uneven width (digits as solid blocks), a
 * horizontal rule under the header, thirteen shot rows and two summary rows.
 * The template given to the fit has EQUAL slots, so the test proves the
 * boundaries snap onto the real gaps, the header is found from the ink, the
 * bands are the shot rows, and assembleRows turns fake OCR text back into
 * rows - dropping the summary rows by label and by zone, keeping direction
 * letters, and refusing a row with hardly any values.
 *
 * Run: node dev/clarity-template-ocr.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OCR = require(path.join(ROOT, "scripts", "clarity-table-ocr.js"));
const TPL = require(path.join(ROOT, "scripts", "clarity-template-ocr.js"));
const layouts = require(path.join(ROOT, "scripts", "gd-launch-monitor-layouts.js"));

/* ---- a synthetic table ---- */
const W = 1800, H = 900;
function blankMask() { return { mask: new Uint8Array(W * H), w: W, h: H }; }
function fill(m, x0, y0, x1, y1) {
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x += 1) m.mask[y * W + x] = 1;
  }
}
/* "digits": a run of glyph blocks with 1-pixel gaps, centred in the cell. */
function text(m, cx, cy, glyphs, glyphW, glyphH) {
  const total = glyphs * glyphW + (glyphs - 1) * 3;
  let x = Math.round(cx - total / 2);
  for (let g = 0; g < glyphs; g += 1) { fill(m, x, Math.round(cy - glyphH / 2), x + glyphW, Math.round(cy + glyphH / 2)); x += glyphW + 3; }
}

/* Uneven real columns inside a 1800px frame with a 130px label column. */
const LABEL_RIGHT = 130;
const COL_EDGES = [130, 300, 440, 560, 740, 880, 1040, 1160, 1300, 1480, 1640, 1800];
const ROWS = 13, SUMMARY = 2;
const HEADER_BOTTOM = 110;
const ROW_PITCH = 50, FIRST_ROW_CY = 150;

function buildTable() {
  const m = blankMask();
  /* two-line header */
  for (let c = 0; c < COL_EDGES.length - 1; c += 1) {
    const cx = (COL_EDGES[c] + COL_EDGES[c + 1]) / 2;
    text(m, cx, 40, 5, 12, 16);
    text(m, cx, 80, 3, 12, 14);
  }
  /* horizontal rule under the header, a vertical rule down the label column */
  fill(m, 0, HEADER_BOTTOM, W, HEADER_BOTTOM + 2);
  fill(m, LABEL_RIGHT - 1, 0, LABEL_RIGHT + 1, H);
  /* 13 shots + 2 summary rows */
  for (let r = 0; r < ROWS + SUMMARY; r += 1) {
    const cy = FIRST_ROW_CY + r * ROW_PITCH;
    text(m, 60, cy, r < ROWS ? 2 : 7, 11, 18);          /* shot number / AVERAGE */
    for (let c = 0; c < COL_EDGES.length - 1; c += 1) {
      const cx = (COL_EDGES[c] + COL_EDGES[c + 1]) / 2;
      text(m, cx, cy, 4, 11, 18);
      if (c === 2 || c === 4 || c === 6) text(m, cx + 36, cy, 1, 9, 16); /* an L/R marker right of the number */
    }
  }
  return m;
}

const layout = layouts.get("foresight-fsx-ball");
assert.strictEqual(layout.columns.length, COL_EDGES.length - 1, "the synthetic table has one slot per Foresight column");

const m = buildTable();
const fit = TPL.fitTemplate(layout, W, H, m);

/* ---- the header is found from the ink, not the template fraction ---- */
assert.ok(fit.headerBottom > 95 && fit.headerBottom < 140, "header bottom sits between the header and the first shot, got " + fit.headerBottom);
assert.ok(fit.notes.some((n) => /from ink/.test(n)), "and says it came from the ink");

/* ---- boundaries snap onto the real, uneven gaps ---- */
assert.strictEqual(fit.columns.length, 11);
/* The ink extents of each column: 4 glyphs of 11px with 3px gaps (53px) centred
   in the real column, plus a 9px marker 36px right of centre in the three
   direction columns. A boundary is right when it falls in the quiet corridor
   between one column's ink and the next's - that is what "snapped to the gap"
   means, whatever the template fraction said. */
const inkLeft = (c) => (COL_EDGES[c] + COL_EDGES[c + 1]) / 2 - 26.5;
const inkRight = (c) => (COL_EDGES[c] + COL_EDGES[c + 1]) / 2 + ((c === 2 || c === 4 || c === 6) ? 40.5 : 26.5);
const labelInkRight = 60 + (7 * 11 + 6 * 3) / 2;  /* AVERAGE is the widest label */
assert.ok(fit.labelRight > labelInkRight && fit.labelRight < inkLeft(0), "label column edge sits in the corridor between the labels and the first value column, got " + fit.labelRight);
fit.columns.forEach((col, i) => {
  if (i > 0) assert.ok(col.x0 > inkRight(i - 1) && col.x0 < inkLeft(i), "column " + i + " (" + col.key + ") starts in the gap before its ink (" + Math.round(inkRight(i - 1)) + ".." + Math.round(inkLeft(i)) + "), got " + col.x0);
  assert.strictEqual(col.key, layout.columns[i].key, "column " + i + " carries the layout key");
});
/* And the template alone would NOT have done that: equal slots put boundary 1
   at 282 which is inside the real column 0..1 gap only by luck; boundary 3
   (equal: 585) would cut through column 3's ink, which starts at 596 - the
   snap is what moves it to the gap at 560. */
assert.ok(fit.columns[3].x0 < inkLeft(3) && fit.columns[3].x0 > inkRight(2), "uneven column 3 is cut on its real gap, not the equal-slot line");
assert.ok(fit.columns[2].direction && fit.columns[4].direction && fit.columns[6].direction, "side angle, sidespin and offline are direction columns");
assert.ok(!fit.columns[0].direction, "ball speed is not");

/* ---- the bands are the rows ---- */
assert.strictEqual(fit.bands.length, ROWS + SUMMARY, "every row is a band (" + fit.bands.length + ")");
fit.bands.forEach((b, r) => {
  const cy = FIRST_ROW_CY + r * ROW_PITCH;
  assert.ok(b.y0 < cy && b.y1 > cy, "band " + r + " brackets its row");
});
assert.ok(fit.bands.slice(ROWS).every((b) => b.summaryZone), "the two bottom bands are in the summary zone");
assert.ok(fit.bands.slice(0, ROWS - 1).every((b) => !b.summaryZone), "the shot rows are not");

/* ---- cells ---- */
const cells = TPL.cellRects(fit, 3);
assert.strictEqual(cells.length, fit.bands.length * fit.columns.length, "one cell per band per column");
assert.ok(cells.every((c) => c.rect.x1 > c.rect.x0 && c.rect.y1 > c.rect.y0 && c.rect.x0 >= 0 && c.rect.y1 <= H), "every cell rect is inside the image");

/* ---- rows from fake OCR ---- */
const truth = require(path.join(ROOT, "dev", "fixtures", "launch-monitor-7i.groundtruth.json"));
const reads = {};
const labels = {};
const fixtureKey = { launch: "launchAngle", peakHeight: "peak", descent: "descentAngle" };
truth.rows.forEach((row, r) => {
  labels[r] = String(r + 1);
  fit.columns.forEach((col) => {
    const fk = fixtureKey[col.key] || col.key;
    let value = row[fk];
    let textOut = value == null ? "" : String(value);
    if (col.direction) {
      const dir = row[fk + "Dir"];
      if (dir) textOut += " " + dir;
    }
    reads[r + ":" + col.index] = textOut;
  });
});
/* summary rows: one labelled, one with an unreadable label */
labels[ROWS] = "AVERAGE";
labels[ROWS + 1] = "";
fit.columns.forEach((col) => { reads[ROWS + ":" + col.index] = "100.0"; reads[(ROWS + 1) + ":" + col.index] = "1.2"; });

const out = TPL.assembleRows(fit, reads, labels, { club: "7i", clubFromText: (t) => (/^pw$/i.test(t) ? "PW" : "") });
assert.strictEqual(out.rows.length, ROWS, "thirteen shots come back, got " + out.rows.length);
assert.deepStrictEqual(out.dropped.map((d) => d.why), ["summary label", "summary zone"], "AVERAGE dropped by its label, STD DEV by the zone");
out.rows.forEach((row, r) => {
  assert.strictEqual(row.club, "7i");
  const byKey = {};
  row.cells.forEach((c) => { byKey[c.key] = c; });
  const t = truth.rows[r];
  assert.strictEqual(byKey.ballSpeed.value, t.ballSpeed, "row " + r + " ball speed");
  assert.strictEqual(byKey.carry.value, t.carry, "row " + r + " carry");
  assert.strictEqual(byKey.sideAngle.direction, t.sideAngleDir, "row " + r + " side angle direction " + byKey.sideAngle.raw);
  assert.strictEqual(byKey.sideAngle.value, Math.abs(t.sideAngle), "direction columns carry the magnitude");
  assert.strictEqual(byKey.offline.direction, t.offlineDir, "row " + r + " offline direction");
  assert.ok(byKey.ballSpeed.geom && byKey.ballSpeed.geom.y0 === fit.bands[r].y0, "cells keep their band geometry for the deep scan");
});

/* a club in the label column names the row */
{
  const r = TPL.assembleRows(fit, reads, Object.assign({}, labels, { 0: "PW" }), { club: "7i", clubFromText: (t) => (/^pw$/i.test(t) ? "PW" : "") });
  assert.strictEqual(r.rows[0].club, "PW");
  assert.strictEqual(r.rows[1].club, "7i");
}

/* a row with hardly any readable values is not a shot */
{
  const sparse = Object.assign({}, reads);
  fit.columns.forEach((col) => { if (col.index > 1) sparse["3:" + col.index] = "~~"; });
  const r = TPL.assembleRows(fit, sparse, labels, { club: "7i" });
  assert.strictEqual(r.rows.length, ROWS - 1);
  assert.ok(r.dropped.some((d) => d.row === 3 && /values/.test(d.why)), "and the reason is recorded");
}

/* an implausible read stays in the row as a placeholder but is flagged */
{
  const bad = Object.assign({}, reads);
  bad["0:1"] = "942031";
  const r = TPL.assembleRows(fit, bad, labels, { club: "7i" });
  const cell = r.rows[0].cells.find((c) => c.key === "launch");
  assert.strictEqual(cell.plausible, false, "launch=942031 is marked implausible for the payload step to drop");
}

/* ---- the fit survives a blank image and a template-only guess ---- */
{
  const empty = TPL.fitTemplate(layout, W, H, blankMask());
  assert.strictEqual(empty.bands.length, 0, "no ink, no bands");
  assert.strictEqual(empty.headerBottom, Math.round(H * layout.headerBand), "header falls back to the template fraction");
  assert.strictEqual(empty.columns.length, 11, "slots still laid out");
  assert.strictEqual(TPL.assembleRows(empty, {}, {}, {}).rows.length, 0);
}

/* ---- a layout with no label column and no summary rows ---- */
{
  const generic = Object.assign({}, layouts.get("range-bay"), { labelColumn: 0 });
  const g = TPL.fitTemplate(generic, W, H, m);
  assert.strictEqual(g.labelRight, 0);
  assert.ok(g.bands.every((b) => !b.summaryZone), "no summary zone when the brand prints none");
}

/* ---- snapping rules ---- */
{
  const gaps = [{ x0: 95, x1: 105, cx: 100, w: 10 }, { x0: 195, x1: 215, cx: 205, w: 20 }];
  assert.deepStrictEqual(TPL.snapBoundary(100, gaps, 30).x, 100, "a boundary inside a gap moves to its centre");
  assert.deepStrictEqual(TPL.snapBoundary(120, gaps, 30).x, 100, "a nearby gap pulls the boundary");
  assert.deepStrictEqual(TPL.snapBoundary(150, gaps, 30), { x: 150, snapped: false, gap: null }, "too far from any gap, the template stands");
}

console.log("ok - template OCR: header from ink, boundaries snap to real gaps, " + ROWS + " rows assembled, summary rows dropped, directions kept");
