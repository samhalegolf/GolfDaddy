/*
 * Clarity Template OCR - template mode for the practice photo scanner.
 *
 * The no-template route (clarity-table-ocr.js) has to discover everything from
 * the pixels: where the columns are, what each one is called, which rows are
 * shots. Template mode is handed all of that by the player: they chose a
 * launch monitor layout (gd-launch-monitor-layouts.js) and framed the table
 * so the header row runs along the top edge and the shots sit underneath. So
 * this module only has to do three small things:
 *
 *   1. place the template on the flattened image - header band, label column,
 *      one slot per expected column - and nudge each boundary onto the nearest
 *      real gap in the ink so slightly uneven columns still cut cleanly;
 *   2. find the shot rows as bands of ink under the header;
 *   3. turn per-cell OCR text back into rows of {key, value, direction}.
 *
 * It never reads a header and never guesses a metric: the column order IS the
 * template. The only thing borrowed from the old route is the small-glyph
 * direction reading (L / R / + / -), which lives in clarity-table-ocr.js and is
 * applied by the browser adapter after the cells are read.
 *
 * Pure: masks and text in, geometry and rows out. No DOM, no OCR engine. The
 * browser adapter (gdClarityTemplateScanFromCheckpoint in gd-app-core.js)
 * supplies the ink mask and the OCR calls. Loaded by index.html and by
 * dev/clarity-template-ocr.test.js under Node.
 */
(function (global) {
  "use strict";

  var OCR = global.ClarityTableOcr || (typeof require === "function" ? require("./clarity-table-ocr.js") : null);

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function median(values) {
    var a = (values || []).filter(function (v) { return Number.isFinite(v); }).sort(function (x, y) { return x - y; });
    if (!a.length) return NaN;
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function percentile(values, p) {
    var a = (values || []).filter(function (v) { return Number.isFinite(v); }).sort(function (x, y) { return x - y; });
    if (!a.length) return NaN;
    return a[clamp(Math.floor(a.length * p), 0, a.length - 1)];
  }

  function region(maskObj, r) {
    var w = Number(maskObj && maskObj.w) || 0, h = Number(maskObj && maskObj.h) || 0;
    r = r || {};
    return {
      x0: clamp(Math.floor(Number.isFinite(r.x0) ? r.x0 : 0), 0, w),
      x1: clamp(Math.ceil(Number.isFinite(r.x1) ? r.x1 : w), 0, w),
      y0: clamp(Math.floor(Number.isFinite(r.y0) ? r.y0 : 0), 0, h),
      y1: clamp(Math.ceil(Number.isFinite(r.y1) ? r.y1 : h), 0, h)
    };
  }

  /* Ink count per row ("y") or per column ("x") of a mask over a region. */
  function projection(maskObj, r, axis) {
    var reg = region(maskObj, r);
    var w = maskObj.w, mask = maskObj.mask;
    var out = [];
    var y, x, i;
    if (axis === "x") {
      for (x = reg.x0; x < reg.x1; x += 1) out.push(0);
      for (y = reg.y0; y < reg.y1; y += 1) {
        for (x = reg.x0; x < reg.x1; x += 1) if (mask[y * w + x]) out[x - reg.x0] += 1;
      }
    } else {
      for (y = reg.y0; y < reg.y1; y += 1) {
        var n = 0;
        for (x = reg.x0, i = y * w + reg.x0; x < reg.x1; x += 1, i += 1) if (mask[i]) n += 1;
        out.push(n);
      }
    }
    return { values: out, offset: axis === "x" ? reg.x0 : reg.y0, span: axis === "x" ? (reg.y1 - reg.y0) : (reg.x1 - reg.x0) };
  }

  /* Contiguous index runs where test(value) holds, as [{start, end}] inclusive. */
  function runs(values, test) {
    var out = [], cur = null;
    for (var i = 0; i < values.length; i += 1) {
      if (test(values[i], i)) {
        if (cur) cur.end = i; else cur = { start: i, end: i };
      } else if (cur) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  }

  /* Grid lines are the one thing that looks like ink on every row (a vertical
     rule) or fills a row end to end (a horizontal rule). Zero them out of a
     projection so rows and gaps are decided by the digits alone. */
  function withoutRules(proj) {
    var span = Math.max(1, proj.span);
    var values = proj.values.map(function (v) { return v >= span * 0.55 ? 0 : v; });
    /* Baseline: the quietest fifth of the profile. A thin rule running the
       other way adds a constant to every entry; this takes it back out. */
    var base = percentile(values, 0.2) || 0;
    return { values: values.map(function (v) { return Math.max(0, v - base); }), offset: proj.offset, span: proj.span };
  }

  /* Bands of ink across a region: the rows of text. Bands split by a gap
     smaller than a third of a typical band (the gap over a decimal point, or
     between a digit and its descender) are joined; slivers below a third of a
     typical band (dust, a stray underline) are dropped. */
  function rowBands(maskObj, r, opts) {
    opts = opts || {};
    var proj = withoutRules(projection(maskObj, r, "y"));
    var threshold = Math.max(1, proj.span * (Number.isFinite(opts.inkFraction) ? opts.inkFraction : 0.006));
    var raw = runs(proj.values, function (v) { return v > threshold; }).map(function (run) {
      return { y0: run.start + proj.offset, y1: run.end + proj.offset + 1 };
    });
    if (!raw.length) return [];
    var typical = median(raw.map(function (b) { return b.y1 - b.y0; })) || 1;
    var merged = [];
    raw.forEach(function (b) {
      var last = merged[merged.length - 1];
      if (last && (b.y0 - last.y1) < typical * 0.34) last.y1 = b.y1;
      else merged.push({ y0: b.y0, y1: b.y1 });
    });
    typical = median(merged.map(function (b) { return b.y1 - b.y0; })) || 1;
    return merged.filter(function (b) { return (b.y1 - b.y0) >= typical * 0.34; })
      .map(function (b, i) { return { index: i, y0: b.y0, y1: b.y1, h: b.y1 - b.y0 }; });
  }

  /* Quiet vertical corridors across a region: where one column ends and the
     next begins. Returned left to right as {x0, x1, cx}. */
  function columnGaps(maskObj, r, opts) {
    opts = opts || {};
    var proj = withoutRules(projection(maskObj, r, "x"));
    var threshold = Math.max(0, proj.span * (Number.isFinite(opts.inkFraction) ? opts.inkFraction : 0.004));
    return runs(proj.values, function (v) { return v <= threshold; }).map(function (run) {
      var x0 = run.start + proj.offset, x1 = run.end + proj.offset + 1;
      return { x0: x0, x1: x1, w: x1 - x0, cx: (x0 + x1) / 2 };
    }).filter(function (g) { return g.w >= 2; });
  }

  /* Move a template boundary onto the ink gap it most plausibly belongs to: the
     gap that already contains it, else the nearest gap centre within
     `tolerance`. Outside tolerance the template boundary stands. */
  function snapBoundary(x, gaps, tolerance) {
    var list = Array.isArray(gaps) ? gaps : [];
    var inside = list.find(function (g) { return x >= g.x0 && x <= g.x1; });
    if (inside) return { x: inside.cx, snapped: true, gap: inside };
    var best = null, bestD = Infinity;
    list.forEach(function (g) {
      var d = Math.abs(g.cx - x);
      if (d < bestD) { bestD = d; best = g; }
    });
    if (best && bestD <= tolerance) return { x: best.cx, snapped: true, gap: best };
    return { x: x, snapped: false, gap: null };
  }

  function columnDirection(column) {
    if (!column) return false;
    if (column.direction === true) return true;
    return !!(OCR && OCR._internals && typeof OCR._internals.needsDirection === "function" && OCR._internals.needsDirection(column.key));
  }

  /* Place the layout on a flattened table image of width x height whose ink is
     maskObj. Returns the fit: header bottom, label column, column slots (with
     the layout's key on each), the shot bands under the header, and which of
     those bands sit in the summary zone. */
  function fitTemplate(layout, width, height, maskObj, opts) {
    opts = opts || {};
    var w = Math.max(1, Math.round(Number(width) || (maskObj && maskObj.w) || 1));
    var h = Math.max(1, Math.round(Number(height) || (maskObj && maskObj.h) || 1));
    var lay = layout || {};
    var cols = Array.isArray(lay.columns) ? lay.columns : [];
    var headerFrac = clamp(Number(lay.headerBand) || 0.12, 0.03, 0.35);
    var labelFrac = clamp(Number(lay.labelColumn) || 0, 0, 0.35);
    var summaryRows = Array.isArray(lay.summaryRows) ? lay.summaryRows : [];
    var notes = [];

    /* 1. Header bottom: the template says roughly where; the ink says exactly.
       Any band starting inside the template's header zone is header text (two
       stacked lines of header count as one), and the data begins under the
       lowest of them. With no ink up there, trust the template. */
    var headerGuess = h * headerFrac;
    var allBands = maskObj ? rowBands(maskObj, { x0: 0, x1: w, y0: 0, y1: h }, opts) : [];
    var headerBands = allBands.filter(function (b) { return b.y0 < headerGuess * 1.15 && b.y0 < h * 0.45; });
    var headerBottom;
    if (headerBands.length) {
      headerBottom = Math.max.apply(null, headerBands.map(function (b) { return b.y1; }));
      var next = allBands.find(function (b) { return b.y0 >= headerBottom; });
      headerBottom = next ? (headerBottom + next.y0) / 2 : headerBottom + 2;
      notes.push("header bottom from ink at y" + Math.round(headerBottom));
    } else {
      headerBottom = headerGuess;
      notes.push("no header ink found; template header bottom y" + Math.round(headerBottom));
    }
    headerBottom = clamp(Math.round(headerBottom), 0, h - 1);

    /* 2. Column boundaries: equal template slots, each boundary nudged onto the
       nearest real gap in the ink below the header. */
    var bodyRegion = { x0: 0, x1: w, y0: headerBottom, y1: h };
    var gaps = maskObj ? columnGaps(maskObj, bodyRegion, opts) : [];
    var labelRight = 0;
    if (labelFrac > 0) {
      var snapL = snapBoundary(w * labelFrac, gaps, w * labelFrac * 0.5);
      labelRight = Math.round(snapL.x);
      if (snapL.snapped) notes.push("label column snapped to x" + labelRight);
    }
    var slotW = cols.length ? (w - labelRight) / cols.length : (w - labelRight);
    var bounds = [labelRight];
    for (var i = 1; i < cols.length; i += 1) {
      var target = labelRight + slotW * i;
      var snap = snapBoundary(target, gaps, slotW * 0.35);
      var x = Math.round(snap.x);
      /* Boundaries must stay in order with room for a value between them. */
      if (x <= bounds[bounds.length - 1] + slotW * 0.3) x = Math.round(target);
      bounds.push(x);
    }
    bounds.push(w);
    var columns = cols.map(function (c, ci) {
      return {
        index: ci,
        key: c.key === undefined ? null : c.key,
        label: c.label,
        direction: columnDirection(c),
        x0: bounds[ci],
        x1: bounds[ci + 1],
        snapped: ci === 0 ? true : (Math.abs(bounds[ci] - (labelRight + slotW * ci)) > 0.5)
      };
    });

    /* 3. Shot bands: ink rows under the header, read across the value columns
       only (the label column may hold a tall club badge). */
    var valueRegion = { x0: labelRight, x1: w, y0: headerBottom, y1: h };
    var bands = maskObj ? rowBands(maskObj, valueRegion, opts) : [];
    var summaryTop = summaryRows.length ? h * (1 - clamp(0.07 * summaryRows.length, 0.05, 0.25) * 1.4) : Infinity;
    bands = bands.map(function (b, bi) {
      return { index: bi, y0: b.y0, y1: b.y1, h: b.h, summaryZone: b.y0 >= summaryTop };
    });

    return {
      layoutKey: lay.key || "",
      width: w,
      height: h,
      headerBottom: headerBottom,
      labelRight: labelRight,
      columns: columns,
      bands: bands,
      gaps: gaps,
      summaryRows: summaryRows.slice(),
      notes: notes
    };
  }

  /* Every cell the adapter has to read: one per band x column, padded a little
     so no glyph touches the crop edge. */
  function cellRects(fit, pad) {
    var p = Number.isFinite(pad) ? pad : 3;
    var out = [];
    (fit.bands || []).forEach(function (band) {
      (fit.columns || []).forEach(function (col) {
        out.push({
          row: band.index,
          col: col.index,
          key: col.key,
          direction: !!col.direction,
          rect: {
            x0: Math.max(0, col.x0 - p),
            y0: Math.max(0, band.y0 - p),
            x1: Math.min(fit.width, col.x1 + p),
            y1: Math.min(fit.height, band.y1 + p)
          }
        });
      });
    });
    return out;
  }

  function labelRect(fit, band, pad) {
    var p = Number.isFinite(pad) ? pad : 3;
    return { x0: 0, y0: Math.max(0, band.y0 - p), x1: Math.max(1, fit.labelRight + p), y1: Math.min(fit.height, band.y1 + p) };
  }

  function looksNumeric(text) {
    return /^[\s#]*\d{1,3}[\s.)]*$/.test(String(text || ""));
  }

  /* Rows of {club, cells} from the per-cell reads.
   *   reads:  { "row:col": "ocr text" }
   *   labels: { "row": "label column text" }  (optional)
   * A band whose label reads AVERAGE / STD DEV is a summary row, not a shot. A
   * band in the summary zone whose label is blank or is not a shot number is
   * dropped too, when the layout prints summary rows. A row with too few
   * readable values is dropped. Direction columns take their L/R from the
   * text here; the adapter's deep scan may refine it afterwards. */
  function assembleRows(fit, reads, labels, opts) {
    opts = opts || {};
    reads = reads || {};
    labels = labels || {};
    var cols = fit.columns || [];
    var valueCols = cols.filter(function (c) { return c.key; });
    var minValues = Math.max(2, Math.ceil(valueCols.length * (Number.isFinite(opts.minFraction) ? opts.minFraction : 0.4)));
    var expectSummary = (fit.summaryRows || []).length > 0;
    var clubFromText = typeof opts.clubFromText === "function" ? opts.clubFromText : function () { return ""; };
    var defaultClub = String(opts.club || "7i");
    var rows = [];
    var dropped = [];
    (fit.bands || []).forEach(function (band) {
      var label = String(labels[band.index] || "").trim();
      var summaryLabel = !!(OCR && typeof OCR.isSummaryLabel === "function" && OCR.isSummaryLabel(label));
      if (summaryLabel) { dropped.push({ row: band.index, why: "summary label", label: label }); return; }
      if (expectSummary && band.summaryZone && !looksNumeric(label) && !clubFromText(label)) {
        dropped.push({ row: band.index, why: "summary zone", label: label }); return;
      }
      var cells = [];
      var numeric = 0;
      cols.forEach(function (col) {
        if (!col.key) return;
        var text = String(reads[band.index + ":" + col.index] || "").trim();
        var parsed = OCR && typeof OCR.parseCell === "function" ? OCR.parseCell(text, col.key) : { raw: text, value: null, direction: "", valid: false };
        var direction = col.direction && OCR && OCR._internals ? (OCR._internals.directionFromText(text) || "") : (parsed.direction || "");
        var value = parsed.value;
        if (col.direction && Number.isFinite(value)) value = Math.abs(value);
        if (Number.isFinite(value)) numeric += 1;
        cells.push({
          key: col.key,
          value: Number.isFinite(value) ? value : null,
          direction: col.direction ? direction : "",
          valid: !!parsed.valid,
          plausible: Number.isFinite(value) ? !!parsed.valid : undefined,
          raw: text,
          geom: { x0: col.x0, y0: band.y0, x1: col.x1, y1: band.y1 },
          directionColumn: !!col.direction
        });
      });
      if (numeric < minValues) { dropped.push({ row: band.index, why: "only " + numeric + " values", label: label }); return; }
      var club = clubFromText(label) || defaultClub;
      rows.push({ club: club, band: band.index, label: label, cells: cells });
    });
    return { rows: rows, dropped: dropped };
  }

  var api = {
    version: "2026-10-19",
    projection: projection,
    rowBands: rowBands,
    columnGaps: columnGaps,
    snapBoundary: snapBoundary,
    fitTemplate: fitTemplate,
    cellRects: cellRects,
    labelRect: labelRect,
    assembleRows: assembleRows,
    _internals: { runs: runs, withoutRules: withoutRules, median: median, percentile: percentile, looksNumeric: looksNumeric, columnDirection: columnDirection }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.ClarityTemplateOcr = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
