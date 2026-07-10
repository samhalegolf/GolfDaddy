/*
 * Clarity Table OCR — pixel glue (browser only).
 *
 * The pure module (clarity-table-ocr.js) works on geometry. This layer turns a
 * flattened table <canvas>/<image> into the number-box geometry it needs:
 *   1. binarise to an ink mask
 *   2. connected-component labelling -> digit blobs
 *   3. cluster blobs into row bands
 *   4. group blobs per row into value-boxes (module Stage 0) -> number boxes
 * Plus small helpers to crop a cell region for per-cell OCR (Stage 3).
 *
 * Requires ClarityTableOcr (global) for groupComponentsIntoValues.
 */
(function (global) {
  "use strict";
  var OCR = global.ClarityTableOcr || (typeof require === "function" ? require("./clarity-table-ocr.js") : null);

  function toCanvas(source) {
    if (source && source.getContext) return source;
    var w = source.naturalWidth || source.width;
    var h = source.naturalHeight || source.height;
    var canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0, w, h);
    return canvas;
  }

  function imageData(source) {
    var canvas = toCanvas(source);
    return canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  }

  // Dark-ink mask: dark, low-saturation pixels are treated as glyph ink.
  function inkMask(id) {
    var w = id.width, h = id.height, data = id.data;
    var mask = new Uint8Array(w * h);
    for (var y = 0; y < h; y += 1) {
      for (var x = 0; x < w; x += 1) {
        var i = (y * w + x) * 4;
        if (data[i + 3] < 24) continue;
        var r = data[i], g = data[i + 1], b = data[i + 2];
        var gray = r * 0.299 + g * 0.587 + b * 0.114;
        var spread = Math.max(r, g, b) - Math.min(r, g, b);
        if ((gray < 170 && spread < 100) || gray < 112) mask[y * w + x] = 1;
      }
    }
    return { mask: mask, w: w, h: h };
  }

  // 8-connected components; drop lines and dust; return glyph-ish blobs.
  function connectedComponents(m) {
    var mask = m.mask, w = m.w, h = m.h;
    var seen = new Uint8Array(w * h);
    var stack = [];
    var comps = [];
    for (var sy = 0; sy < h; sy += 1) {
      for (var sx = 0; sx < w; sx += 1) {
        var start = sy * w + sx;
        if (!mask[start] || seen[start]) continue;
        seen[start] = 1; stack.length = 0; stack.push(start);
        var area = 0, minX = sx, minY = sy, maxX = sx, maxY = sy;
        while (stack.length) {
          var cur = stack.pop();
          var x = cur % w, y = (cur - x) / w;
          area += 1;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          for (var dy = -1; dy <= 1; dy += 1) {
            var ny = y + dy; if (ny < 0 || ny >= h) continue;
            for (var dx = -1; dx <= 1; dx += 1) {
              if (!dx && !dy) continue;
              var nx = x + dx; if (nx < 0 || nx >= w) continue;
              var nb = ny * w + nx;
              if (!mask[nb] || seen[nb]) continue;
              seen[nb] = 1; stack.push(nb);
            }
          }
        }
        comps.push({ x0: minX, y0: minY, x1: maxX, y1: maxY, area: area, w: maxX - minX + 1, h: maxY - minY + 1 });
      }
    }
    // Estimate glyph height from the blob population, then filter.
    var heights = comps.map(function (c) { return c.h; }).filter(function (v) { return v > 2; }).sort(function (a, b) { return a - b; });
    var medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 16;
    var minH = Math.max(4, medianH * 0.4);
    var minArea = Math.max(4, medianH * 0.9);
    return comps.filter(function (c) {
      // Reject table GRID LINES so the column split cuts on value gaps, not on
      // ink lines. A grid line is much taller than a digit and thin (or a very
      // high aspect ratio); a horizontal rule is short and wide.
      var horizontalLine = c.h <= Math.max(2, medianH * 0.22) && c.w > medianH * 1.8;
      var verticalLine = (c.h > medianH * 1.6 && c.w <= Math.max(3, medianH * 0.55)) ||
                         (c.w > 0 && c.h / c.w > 5.5 && c.h > medianH * 1.2);
      if (horizontalLine || verticalLine) return false;
      if (c.h < minH || c.area < minArea) return false;
      if (c.w / c.h > 8) return false;
      return true;
    });
  }

  function median(vals) {
    var a = vals.filter(function (v) { return Number.isFinite(v); }).sort(function (x, y) { return x - y; });
    if (!a.length) return NaN;
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // Cluster components into horizontal row bands by vertical centre.
  function clusterRows(comps) {
    var sorted = comps.slice().sort(function (a, b) { return (a.y0 + a.y1) - (b.y0 + b.y1); });
    var medianH = median(sorted.map(function (c) { return c.h; })) || 16;
    var tol = Math.max(6, medianH * 0.6);
    var rows = [];
    sorted.forEach(function (c) {
      var cy = (c.y0 + c.y1) / 2;
      var row = rows[rows.length - 1];
      if (row && cy - row.cy <= tol) {
        row.items.push(c);
        row.y0 = Math.min(row.y0, c.y0); row.y1 = Math.max(row.y1, c.y1);
        row.cy = row.items.reduce(function (s, it) { return s + (it.y0 + it.y1) / 2; }, 0) / row.items.length;
      } else {
        rows.push({ cy: cy, y0: c.y0, y1: c.y1, items: [c] });
      }
    });
    return rows.filter(function (r) { return r.items.length >= 2; });
  }

  // Flat image -> number boxes (Stage 0 grouping applied per row band).
  function detectNumberBoxes(source) {
    if (!OCR || typeof OCR.groupComponentsIntoValues !== "function") throw new Error("ClarityTableOcr not loaded");
    var id = imageData(source);
    var comps = connectedComponents(inkMask(id));
    var rows = clusterRows(comps);
    var boxes = [];
    rows.forEach(function (row) {
      var charH = median(row.items.map(function (c) { return c.h; })) || 16;
      OCR.groupComponentsIntoValues(row.items, { charHeight: charH }).forEach(function (b) { boxes.push(b); });
    });
    return { boxes: boxes, width: id.width, height: id.height, rows: rows, components: comps };
  }

  function cropCanvas(source, x0, y0, x1, y1, pad) {
    pad = pad || 0;
    var canvas = toCanvas(source);
    var sx = Math.max(0, Math.floor(x0 - pad));
    var sy = Math.max(0, Math.floor(y0 - pad));
    var sw = Math.min(canvas.width - sx, Math.ceil(x1 - x0 + pad * 2));
    var sh = Math.min(canvas.height - sy, Math.ceil(y1 - y0 + pad * 2));
    var out = document.createElement("canvas");
    out.width = Math.max(1, sw); out.height = Math.max(1, sh);
    out.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    return out;
  }

  global.ClarityTableOcrPixels = {
    toCanvas: toCanvas, imageData: imageData, inkMask: inkMask,
    connectedComponents: connectedComponents, clusterRows: clusterRows,
    detectNumberBoxes: detectNumberBoxes, cropCanvas: cropCanvas
  };
  if (typeof module !== "undefined" && module.exports) module.exports = global.ClarityTableOcrPixels;
})(typeof globalThis !== "undefined" ? globalThis : this);
