/*
 * Headless scorecard pixels — a test fixture, not shipped code.
 *
 * Renders a scorecard into a raw RGBA buffer with a 5x7 bitmap font, and reads
 * glyphs back out of one by matching components against that same font. That
 * gives the scan pipeline REAL pixels to work on — its own connected-component
 * pass, its own column corridors, its own row bands — without a browser, a
 * canvas library or a Tesseract download.
 *
 * The recogniser here is not a stand-in for Tesseract's accuracy. It is a
 * stand-in for its INTERFACE: the pipeline gets a string per crop and has to
 * cope with whatever comes back, including the wrong thing (see the noise
 * option, which flips characters on purpose).
 */
"use strict";

/* 5x7, one string per row, '#' is ink. 0 carries a diagonal so it cannot be
   confused with O — which is exactly the confusion `readInteger` has to survive
   on a real card, where OUT sits in the hole row. */
const GLYPHS = {
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  J: ["..###", "...#.", "...#.", "...#.", "#..#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".###.", "#...#", "#....", ".###.", "....#", "#...#", ".###."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"]
};

const GLYPH_W = 5, GLYPH_H = 7, ADVANCE = 6;

function blank(width, height, rgb) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
  }
  return { width, height, data };
}

function fillRect(img, x0, y0, x1, y1, rgb) {
  for (let y = Math.max(0, y0 | 0); y < Math.min(img.height, y1 | 0); y += 1) {
    for (let x = Math.max(0, x0 | 0); x < Math.min(img.width, x1 | 0); x += 1) {
      const i = (y * img.width + x) * 4;
      img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = 255;
    }
  }
}

function textWidth(text, scale) {
  const n = String(text).length;
  return n ? (n * ADVANCE - 1) * scale : 0;
}

function drawText(img, text, x, y, scale, rgb) {
  let cursor = x;
  String(text).toUpperCase().split("").forEach(ch => {
    const glyph = GLYPHS[ch];
    if (glyph) {
      for (let gy = 0; gy < GLYPH_H; gy += 1) {
        for (let gx = 0; gx < GLYPH_W; gx += 1) {
          if (glyph[gy][gx] !== "#") continue;
          fillRect(img, cursor + gx * scale, y + gy * scale, cursor + (gx + 1) * scale, y + (gy + 1) * scale, rgb);
        }
      }
    }
    cursor += ADVANCE * scale;
  });
  return cursor;
}

/* Render a card.
 *
 * spec = { columns:["1","2",..,"OUT",..], rows:[{label, cells:[...], fill?}] }
 * `fill` paints a row's band a solid dark colour and prints it in white — the
 * layout that erases a tee row entirely under a fixed dark-ink mask. */
function renderCard(spec, options = {}) {
  const scale = options.scale || 3;
  const rowPitch = options.rowPitch || 24 * scale;
  const colPitch = options.colPitch || 34 * scale;
  const marginX = options.marginX || 22 * scale;
  const marginY = options.marginY || 10 * scale;
  const labelW = options.labelW || 42 * scale;
  const glyphH = GLYPH_H * scale;
  const columns = spec.columns;
  const width = marginX + labelW + columns.length * colPitch + marginX;
  const height = marginY * 2 + spec.rows.length * rowPitch;
  const img = blank(width, height, [252, 251, 248]);
  const ink = [26, 26, 26];

  spec.rows.forEach((row, r) => {
    const top = marginY + r * rowPitch;
    const textY = top + Math.round((rowPitch - glyphH) / 2);
    let rowInk = ink;
    if (row.fill) {
      fillRect(img, 0, top, width, top + rowPitch, row.fill);
      rowInk = [255, 255, 255];
    }
    if (row.label) drawText(img, row.label, marginX, textY, scale, rowInk);
    (row.cells || []).forEach((cell, c) => {
      const text = String(cell == null ? "" : cell);
      if (!text) return;
      const centre = marginX + labelW + c * colPitch + colPitch / 2;
      drawText(img, text, Math.round(centre - textWidth(text, scale) / 2), textY, scale, rowInk);
    });
  });
  // Ruled column separators, as a printed card has. The component filter is
  // supposed to discard these; leaving them in is the point.
  if (options.rules !== false) {
    for (let c = 0; c <= columns.length; c += 1) {
      const x = marginX + labelW + c * colPitch;
      fillRect(img, x, marginY, x + Math.max(1, scale - 2), height - marginY, [150, 150, 150]);
    }
  }
  return img;
}

/* ---- the recogniser ---------------------------------------------------- */

function componentsOf(img) {
  const { width: w, height: h, data } = img;
  // Polarity from the crop itself, same principle the pixels module uses.
  let sum = 0;
  for (let p = 0; p < w * h; p += 1) sum += data[p * 4] * 0.299 + data[p * 4 + 1] * 0.587 + data[p * 4 + 2] * 0.114;
  const mean = sum / Math.max(1, w * h);
  const mask = new Uint8Array(w * h);
  let dark = 0, light = 0;
  for (let p = 0; p < w * h; p += 1) {
    const g = data[p * 4] * 0.299 + data[p * 4 + 1] * 0.587 + data[p * 4 + 2] * 0.114;
    if (g < mean * 0.62) dark += 1; else if (g > mean * 1.3) light += 1;
  }
  const useLight = light > 0 && dark > 0 && light * 1.6 < dark;
  for (let p = 0; p < w * h; p += 1) {
    const g = data[p * 4] * 0.299 + data[p * 4 + 1] * 0.587 + data[p * 4 + 2] * 0.114;
    mask[p] = useLight ? (g > mean * 1.3 ? 1 : 0) : (g < mean * 0.62 ? 1 : 0);
  }
  const seen = new Uint8Array(w * h);
  const comps = [];
  const stack = [];
  for (let sy = 0; sy < h; sy += 1) {
    for (let sx = 0; sx < w; sx += 1) {
      const start = sy * w + sx;
      if (!mask[start] || seen[start]) continue;
      seen[start] = 1; stack.length = 0; stack.push(start);
      let area = 0, minX = sx, minY = sy, maxX = sx, maxY = sy;
      const pixels = [];
      while (stack.length) {
        const cur = stack.pop();
        const x = cur % w, y = (cur - x) / w;
        area += 1; pixels.push(cur);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        for (let dy = -1; dy <= 1; dy += 1) {
          const ny = y + dy; if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx; if (nx < 0 || nx >= w) continue;
            const nb = ny * w + nx;
            if (!mask[nb] || seen[nb]) continue;
            seen[nb] = 1; stack.push(nb);
          }
        }
      }
      comps.push({ x0: minX, y0: minY, x1: maxX, y1: maxY, area, w: maxX - minX + 1, h: maxY - minY + 1, pixels });
    }
  }
  return { comps, mask, w, h };
}

function gridOf(comp, maskInfo) {
  const { mask, w } = maskInfo;
  const cw = comp.x1 - comp.x0 + 1, ch = comp.y1 - comp.y0 + 1;
  const out = [];
  for (let gy = 0; gy < GLYPH_H; gy += 1) {
    let row = "";
    for (let gx = 0; gx < GLYPH_W; gx += 1) {
      const x0 = comp.x0 + Math.floor((gx * cw) / GLYPH_W), x1 = comp.x0 + Math.max(1, Math.ceil(((gx + 1) * cw) / GLYPH_W));
      const y0 = comp.y0 + Math.floor((gy * ch) / GLYPH_H), y1 = comp.y0 + Math.max(1, Math.ceil(((gy + 1) * ch) / GLYPH_H));
      let on = 0, total = 0;
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { total += 1; if (mask[y * w + x]) on += 1; }
      row += total && on / total >= 0.42 ? "#" : ".";
    }
    out.push(row);
  }
  return out;
}

function matchGlyph(grid) {
  let best = "", bestScore = -1;
  Object.keys(GLYPHS).forEach(ch => {
    const ref = GLYPHS[ch];
    let same = 0;
    for (let y = 0; y < GLYPH_H; y += 1) for (let x = 0; x < GLYPH_W; x += 1) if (ref[y][x] === grid[y][x]) same += 1;
    const score = same / (GLYPH_W * GLYPH_H);
    if (score > bestScore) { bestScore = score; best = ch; }
  });
  return bestScore >= 0.72 ? best : "";
}

/* recognize(image) -> text. Left to right, a space inserted where the gap
   between components is wide enough to be a word break. */
function makeRecognizer(options = {}) {
  const noise = options.noise || null;   // (ch, index) -> replacement, for misread tests
  let calls = 0;
  const fn = async image => {
    const info = componentsOf(image);
    const glyphHeights = info.comps.map(c => c.h).sort((a, b) => a - b);
    const medianH = glyphHeights.length ? glyphHeights[Math.floor(glyphHeights.length / 2)] : 1;
    const usable = info.comps
      .filter(c => c.h >= Math.max(3, medianH * 0.5) && c.area >= 4)
      .sort((a, b) => a.x0 - b.x0);
    let text = "";
    usable.forEach((c, i) => {
      const previous = usable[i - 1];
      if (previous && c.x0 - previous.x1 > medianH * 0.75) text += " ";
      let ch = matchGlyph(gridOf(c, info));
      if (noise) ch = noise(ch, calls) ?? ch;
      text += ch;
    });
    calls += 1;
    return text.replace(/\s+/g, " ").trim();
  };
  fn.calls = () => calls;
  return fn;
}

/* A full 18-across card in one block, as most aggregators and most club cards
   print it. Yardages are Te Arai South's published Championship row shape:
   ordinary numbers, one par 3 short hole, nothing exotic. */
function standardCardSpec() {
  const holes = Array.from({ length: 18 }, (_, i) => i + 1);
  const par = [5, 4, 4, 3, 4, 4, 5, 3, 4, 4, 3, 5, 4, 4, 4, 3, 4, 5];
  const index = [7, 3, 11, 15, 1, 9, 13, 17, 5, 8, 16, 12, 2, 6, 10, 18, 4, 14];
  const champ = [530, 444, 355, 175, 421, 398, 512, 168, 430, 433, 190, 545, 406, 411, 388, 160, 425, 505];
  const members = [498, 421, 332, 158, 400, 372, 486, 150, 407, 410, 172, 519, 383, 389, 364, 145, 402, 478];
  const forward = [430, 360, 288, 128, 342, 318, 420, 122, 350, 352, 145, 448, 328, 334, 312, 118, 345, 410];
  const sum = (list, from, to) => list.slice(from, to).reduce((s, v) => s + v, 0);
  const withTotals = list => [
    ...list.slice(0, 9), sum(list, 0, 9),
    ...list.slice(9), sum(list, 9, 18), sum(list, 0, 18)
  ];
  return {
    columns: [...holes.slice(0, 9).map(String), "OUT", ...holes.slice(9).map(String), "IN", "TOT"],
    rows: [
      { label: "HOLE", cells: [...holes.slice(0, 9).map(String), "OUT", ...holes.slice(9).map(String), "IN", "TOT"] },
      { label: "PAR", cells: withTotals(par).map(String) },
      { label: "INDEX", cells: [...index.slice(0, 9).map(String), "", ...index.slice(9).map(String), "", ""] },
      { label: "CHAMP", cells: withTotals(champ).map(String) },
      { label: "MEMBERS", cells: withTotals(members).map(String) },
      { label: "FORWARD", cells: withTotals(forward).map(String) }
    ],
    truth: { holes, par, index, champ, members, forward }
  };
}

module.exports = { GLYPHS, renderCard, makeRecognizer, standardCardSpec, blank, drawText, textWidth };
