/*
 * Clarity Scorecard OCR — pixel glue.
 *
 * A copy of clarity-table-ocr-pixels.js with two deliberate changes:
 *
 * 1. IT RUNS HEADLESS. The practice version calls document.createElement for
 *    every crop, so nothing below the OCR module could be tested without a
 *    browser. Here every operation works on a plain {width, height, data}
 *    buffer — the same shape as ImageData — and canvases are only produced at
 *    the very edge, when something has to be handed to Tesseract or drawn. That
 *    is what lets the whole scorecard pipeline run under `node`.
 * 2. IT PICKS ITS OWN INK POLARITY. A scorecard's tee rows are routinely white
 *    figures on a solid colour band, and the practice reader's fixed dark-ink
 *    mask erases them completely. `inkMask` measures both polarities on the
 *    region it is given and keeps the one that looks like text rather than
 *    background.
 *
 * Requires ClarityScorecardOcr for groupComponentsIntoValues.
 */
(function (global) {
  "use strict";
  var OCR = global.ClarityScorecardOcr || (typeof require === "function" ? require("./clarity-scorecard-ocr.js") : null);
  var hasDocument = typeof document !== "undefined" && document && typeof document.createElement === "function";

  // ---------- image handles ----------
  // Everything internal is a raw buffer: {width, height, data:Uint8ClampedArray}.
  function imageData(source) {
    if (!source) throw new Error("no image source");
    if (source.data && Number.isFinite(source.width) && Number.isFinite(source.height)) return source;
    if (!hasDocument) throw new Error("headless: pass {width,height,data} pixels, not a DOM image");
    var canvas = toCanvas(source);
    return canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  }

  function toCanvas(source) {
    if (source && source.getContext) return source;
    if (!hasDocument) throw new Error("headless: no canvas available");
    var canvas = document.createElement("canvas");
    if (source && source.data && Number.isFinite(source.width)) {
      canvas.width = source.width; canvas.height = source.height;
      var id = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
      canvas.getContext("2d", { willReadFrequently: true }).putImageData(id, 0, 0);
      return canvas;
    }
    var w = source.naturalWidth || source.width;
    var h = source.naturalHeight || source.height;
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0, w, h);
    return canvas;
  }

  function blankImage(w, h, fill) {
    var out = { width: Math.max(1, w | 0), height: Math.max(1, h | 0), data: null };
    out.data = new Uint8ClampedArray(out.width * out.height * 4);
    var v = fill == null ? 255 : fill;
    for (var i = 0; i < out.data.length; i += 4) {
      out.data[i] = v; out.data[i + 1] = v; out.data[i + 2] = v; out.data[i + 3] = 255;
    }
    return out;
  }

  // ---------- ink ----------
  function gray(data, i) { return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114; }

  /* Ink mask, with the polarity decided PER SCANLINE.
   *
   * Cards mix both polarities on one page: the tee rows are routinely white
   * figures reversed out of a solid colour band while everything around them is
   * black on cream. A single mask for the whole image cannot serve both, and the
   * practice reader's fixed dark-ink threshold does not try — it erases the
   * reversed row outright, so a card loses a whole tee set with nothing to show
   * that it ever existed.
   *
   * A scanline darker than mid-grey cannot be carrying dark text: whatever the
   * page does elsewhere, on THAT line the ink is the light pixels. That test is
   * absolute rather than relative to the image, which is what makes it hold for
   * a tight crop taken entirely inside a dark band as well as for the whole page.
   * Each polarity then gets one threshold, computed over the scanlines that
   * chose it, so glyph strokes cannot fragment from the threshold drifting line
   * to line. */
  var MID_GREY = 128;

  function scanlineStats(id) {
    var w = id.width, h = id.height, data = id.data;
    var edge = Math.max(2, Math.round(w * 0.03));
    var means = new Float64Array(h);
    var edgeDark = new Uint8Array(h);
    for (var y = 0; y < h; y += 1) {
      var sum = 0, n = 0, leftSum = 0, leftN = 0, rightSum = 0, rightN = 0;
      for (var x = 0; x < w; x += 1) {
        var i = (y * w + x) * 4;
        if (data[i + 3] < 24) continue;
        var g = gray(data, i);
        sum += g; n += 1;
        if (x < edge) { leftSum += g; leftN += 1; }
        else if (x >= w - edge) { rightSum += g; rightN += 1; }
      }
      means[y] = n ? sum / n : 255;
      edgeDark[y] = (leftN && rightN && leftSum / leftN < MID_GREY && rightSum / rightN < MID_GREY) ? 1 : 0;
    }
    return { means: means, edgeDark: edgeDark };
  }

  /* Which way up is the ink on this scanline?
   *
   * A dark scanline is not enough on its own. The densest line through a row of
   * black digits — the bar of a 4, the top of a 7 — is darker than mid-grey too,
   * and flipping there turns the paper into ink and fuses the crop into one
   * blob, which is a far worse failure than the one this is here to fix.
   *
   * So the decision is made from the region's EDGE pixels alone, never from the
   * line's overall darkness. The edges are background by construction — a value
   * is centred in its cell and a crop carries a margin — so a line whose left
   * AND right edges are both dark is sitting on a fill, however much or little
   * text happens to be on it. Reading the whole-line mean instead is what breaks
   * on "530" reversed out of navy: the strokes are bright enough to pull the
   * line back over mid-grey and only the sparse lines above and below the digits
   * get flipped, leaving a crop half masked one way and half the other.
   *
   * A run-length filter then throws away short flips, since a band is tall and a
   * crossbar clipped at both edges is not. */
  function reversedScanlines(id, forced) {
    var stats = scanlineStats(id);
    var h = id.height;
    var out = new Uint8Array(h);
    var y;
    for (y = 0; y < h; y += 1) {
      if (forced === "light") { out[y] = 1; continue; }
      if (forced === "dark") { out[y] = 0; continue; }
      out[y] = stats.edgeDark[y] ? 1 : 0;
    }
    if (!forced) {
      var minRun = Math.max(4, Math.round(h * 0.06));
      var runStart = -1;
      for (y = 0; y <= h; y += 1) {
        if (y < h && out[y]) { if (runStart < 0) runStart = y; continue; }
        if (runStart >= 0 && y - runStart < minRun) {
          for (var k = runStart; k < y; k += 1) out[k] = 0;
        }
        runStart = -1;
      }
    }
    return { reversed: out, means: stats.means };
  }

  /* Ink mask, with the polarity decided per scanline.
   *
   * Cards mix both polarities on one page: the tee rows are routinely white
   * figures reversed out of a solid colour band while everything around them is
   * black on cream. One mask for the whole image cannot serve both, and the
   * practice reader's fixed dark-ink threshold does not try — it erases the
   * reversed row outright, so a card loses a whole tee set with nothing to show
   * that it ever existed.
   *
   * Each polarity gets ONE threshold, computed over the scanlines that chose it,
   * so a glyph's strokes cannot fragment from the threshold drifting line to
   * line within one character. */
  function inkMask(id, opts) {
    opts = opts || {};
    var w = id.width, h = id.height, data = id.data;
    var forced = String(opts.polarity || "");
    var decided = reversedScanlines(id, forced);
    var reversed = decided.reversed, means = decided.means;
    var darkSum = 0, darkRows = 0, lightSum = 0, lightRows = 0;
    var y, x, i, g;
    for (y = 0; y < h; y += 1) {
      if (reversed[y]) { lightSum += means[y]; lightRows += 1; } else { darkSum += means[y]; darkRows += 1; }
    }
    var darkMean = darkRows ? darkSum / darkRows : 255;
    var lightMean = lightRows ? lightSum / lightRows : 0;
    var darkThreshold = Number.isFinite(Number(opts.threshold)) ? Number(opts.threshold)
      : Math.max(70, Math.min(200, darkMean * 0.72));
    var lightThreshold = Math.max(lightMean + 60, Math.min(200, lightMean * 1.8));
    var mask = new Uint8Array(w * h);
    var ink = 0;
    for (y = 0; y < h; y += 1) {
      var limit = reversed[y] ? lightThreshold : darkThreshold;
      for (x = 0; x < w; x += 1) {
        i = (y * w + x) * 4;
        if (data[i + 3] < 24) continue;
        g = gray(data, i);
        if (reversed[y] ? g > limit : g < limit) { mask[y * w + x] = 1; ink += 1; }
      }
    }
    return {
      mask: mask, w: w, h: h, ink: ink,
      reversedRows: lightRows, darkThreshold: darkThreshold, lightThreshold: lightThreshold,
      polarity: lightRows && !darkRows ? "light" : (lightRows ? "mixed" : "dark")
    };
  }

  // 8-connected components; drop rules and dust; return glyph-ish blobs.
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
    // A scorecard is a RULED table — far more line ink than a launch-monitor
    // screenshot — so this filter does more work here than it does there.
    var heights = comps.map(function (c) { return c.h; }).filter(function (v) { return v > 2; }).sort(function (a, b) { return a - b; });
    var medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 16;
    var minH = Math.max(4, medianH * 0.4);
    var minArea = Math.max(4, medianH * 0.9);
    return comps.filter(function (c) {
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

  // Flat image -> value boxes (Stage 0 grouping applied per row band).
  function detectNumberBoxes(source, opts) {
    if (!OCR || typeof OCR.groupComponentsIntoValues !== "function") throw new Error("ClarityScorecardOcr not loaded");
    var id = imageData(source);
    var comps = connectedComponents(inkMask(id, opts));
    var rows = clusterRows(comps);
    var boxes = [];
    rows.forEach(function (row) {
      var charH = median(row.items.map(function (c) { return c.h; })) || 16;
      OCR.groupComponentsIntoValues(row.items, { charHeight: charH }).forEach(function (b) { boxes.push(b); });
    });
    return { boxes: boxes, width: id.width, height: id.height, rows: rows, components: comps };
  }

  // ---------- crops (headless) ----------
  function cropImage(source, x0, y0, x1, y1, pad) {
    pad = pad || 0;
    var id = imageData(source);
    var sx = Math.max(0, Math.floor(x0 - pad));
    var sy = Math.max(0, Math.floor(y0 - pad));
    var sw = Math.max(1, Math.min(id.width - sx, Math.ceil(x1 - x0 + pad * 2)));
    var sh = Math.max(1, Math.min(id.height - sy, Math.ceil(y1 - y0 + pad * 2)));
    var out = blankImage(sw, sh, 255);
    for (var y = 0; y < sh; y += 1) {
      var srcRow = ((sy + y) * id.width + sx) * 4;
      var dstRow = (y * sw) * 4;
      out.data.set(id.data.subarray(srcRow, srcRow + sw * 4), dstRow);
    }
    return out;
  }

  // Nearest-neighbour upscale. Small digits read far better enlarged, and
  // nearest-neighbour keeps the strokes hard-edged for the ink mask.
  function upscaleImage(source, factor) {
    factor = Math.max(1, Number(factor) || 1);
    var id = imageData(source);
    if (factor <= 1) return id;
    var w = Math.max(1, Math.round(id.width * factor));
    var h = Math.max(1, Math.round(id.height * factor));
    var out = blankImage(w, h, 255);
    for (var y = 0; y < h; y += 1) {
      var sy = Math.min(id.height - 1, Math.floor(y / factor));
      for (var x = 0; x < w; x += 1) {
        var sx = Math.min(id.width - 1, Math.floor(x / factor));
        var s = (sy * id.width + sx) * 4, d = (y * w + x) * 4;
        out.data[d] = id.data[s]; out.data[d + 1] = id.data[s + 1];
        out.data[d + 2] = id.data[s + 2]; out.data[d + 3] = 255;
      }
    }
    return out;
  }

  // White margin so no glyph touches the crop border — Tesseract drops those,
  // which is the practice reader's documented "111.6 -> 11.6" failure.
  function padImage(source, margin) {
    margin = Math.max(0, Number(margin) || 0);
    var id = imageData(source);
    if (!margin) return id;
    var out = blankImage(id.width + margin * 2, id.height + margin * 2, 255);
    for (var y = 0; y < id.height; y += 1) {
      var srcRow = (y * id.width) * 4;
      var dstRow = ((y + margin) * out.width + margin) * 4;
      out.data.set(id.data.subarray(srcRow, srcRow + id.width * 4), dstRow);
    }
    return out;
  }

  // Ink -> black, everything else -> white, using the same polarity-picking mask
  // the box detection used, so a white-on-colour tee row binarises right way up.
  function binarizeImage(source, opts) {
    var id = imageData(source);
    var m = inkMask(id, opts);
    var out = blankImage(id.width, id.height, 255);
    for (var i = 0; i < m.mask.length; i += 1) {
      var v = m.mask[i] ? 0 : 255;
      out.data[i * 4] = v; out.data[i * 4 + 1] = v; out.data[i * 4 + 2] = v; out.data[i * 4 + 3] = 255;
    }
    return out;
  }

  // The one place a buffer becomes something an OCR engine or the DOM accepts.
  function toRenderable(source) {
    return hasDocument ? toCanvas(source) : imageData(source);
  }

  global.ClarityScorecardOcrPixels = {
    hasDocument: hasDocument,
    imageData: imageData, toCanvas: toCanvas, toRenderable: toRenderable, blankImage: blankImage,
    inkMask: inkMask, connectedComponents: connectedComponents, clusterRows: clusterRows,
    detectNumberBoxes: detectNumberBoxes,
    cropImage: cropImage, upscaleImage: upscaleImage, padImage: padImage, binarizeImage: binarizeImage
  };
  if (typeof module !== "undefined" && module.exports) module.exports = global.ClarityScorecardOcrPixels;
})(typeof globalThis !== "undefined" ? globalThis : this);
