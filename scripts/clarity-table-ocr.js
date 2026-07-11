/*
 * Clarity Table OCR — standalone, DOM-agnostic launch-monitor table reader.
 *
 * This module is deliberately isolated from the main app so its behaviour
 * cannot be broken by unrelated changes in index.html. It is the "as designed"
 * pipeline, stage by stage, with one contract per stage:
 *
 *   Stage 1  splitColumns(numberBoxes, opts)  -> columns          (pure geometry)
 *   Stage 2  allocateHeaders(...)             -> labelled columns  (todo)
 *   Stage 3  extractCells(...)                -> rows              (todo)
 *
 * Stage 1 (the column splitter) is the one that regresses in the app: the
 * corridor detector's mergeGap glues closely-spaced columns (Ball Speed /
 * Launch Angle / Side Angle, and Total / To Pin) into one wide corridor, so
 * three real columns collapse into one and their digits garble. This file ports
 * that logic verbatim plus the outlier re-split, so it can be tested headlessly
 * with synthetic number-boxes — no image, no OCR, no browser.
 *
 * Runs in Node (module.exports) and the browser (global ClarityTableOcr).
 */
(function (global) {
  "use strict";

  // ---------- shared numeric helpers ----------
  function median(values) {
    var nums = (Array.isArray(values) ? values : [])
      .map(Number)
      .filter(Number.isFinite)
      .sort(function (a, b) { return a - b; });
    if (!nums.length) return NaN;
    var mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  }

  // Cluster number-boxes into tracks along an axis ("x" = columns, "y" = rows).
  function trackClusters(boxes, axis) {
    axis = axis || "x";
    var horizontal = axis === "x";
    var centerKey = horizontal ? "cx" : "cy";
    var sizeKey = horizontal ? "w" : "h";
    var source = (Array.isArray(boxes) ? boxes : [])
      .filter(function (box) { return box && Number.isFinite(Number(box[centerKey])) && Number(box[sizeKey]) > 0; })
      .slice()
      .sort(function (a, b) { return Number(a[centerKey]) - Number(b[centerKey]); });
    if (!source.length) return [];
    var medianSize = median(source.map(function (box) { return Number(box[sizeKey]); }).filter(Number.isFinite)) || (horizontal ? 24 : 16);
    var tolerance = horizontal
      ? Math.max(18, Math.min(48, medianSize * 1.15))
      : Math.max(9, Math.min(23, medianSize * 0.85));
    var clusters = [];
    function updateCluster(cluster) {
      var items = cluster.items;
      var centers = items.map(function (item) { return Number(item[centerKey]); }).filter(Number.isFinite);
      cluster.center = median(centers) || centers.reduce(function (s, i) { return s + i; }, 0) / Math.max(1, centers.length);
      cluster.x0 = Math.min.apply(null, items.map(function (i) { return i.x0; }));
      cluster.x1 = Math.max.apply(null, items.map(function (i) { return i.x1; }));
      cluster.y0 = Math.min.apply(null, items.map(function (i) { return i.y0; }));
      cluster.y1 = Math.max.apply(null, items.map(function (i) { return i.y1; }));
      cluster.cx = median(items.map(function (i) { return i.cx; })) || ((cluster.x0 + cluster.x1) / 2);
      cluster.cy = median(items.map(function (i) { return i.cy; })) || ((cluster.y0 + cluster.y1) / 2);
      cluster.width = Math.max(1, cluster.x1 - cluster.x0);
      cluster.height = Math.max(1, cluster.y1 - cluster.y0);
    }
    source.forEach(function (box) {
      var best = null, bestDistance = Infinity;
      for (var i = 0; i < clusters.length; i += 1) {
        var d = Math.abs(Number(box[centerKey]) - clusters[i].center);
        if (d < bestDistance) { bestDistance = d; best = clusters[i]; }
      }
      if (best && bestDistance <= tolerance) {
        best.items.push(box);
        updateCluster(best);
      } else {
        var cluster = { items: [box] };
        updateCluster(cluster);
        clusters.push(cluster);
      }
    });
    return clusters.sort(function (a, b) { return Number(a.center) - Number(b.center); });
  }

  // ---------- value-box detection (Stage 0): prevent fusion ----------
  // Given digit/ink components (connected blobs) across a ROW BAND, group them
  // into one tight box per value. The failure mode we design against: closely-
  // spaced columns whose inter-column whitespace is small. A fixed gap cap
  // fuses them; instead we find the natural valley between intra-value gaps
  // (tiny, between digits of one number) and inter-column gaps (larger), so
  // adjacent columns stay separate boxes even when packed tight.
  function valueGapThreshold(gaps, charHeight) {
    var g = (Array.isArray(gaps) ? gaps : []).filter(function (v) { return Number.isFinite(v) && v >= 0; }).slice().sort(function (a, b) { return a - b; });
    var floor = Math.max(4, charHeight * 0.28);
    var ceil = Math.max(floor + 1, charHeight * 0.95);
    if (g.length < 2) return floor;
    // First significant jump OUT of the intra-value cluster: the smallest gap
    // that is clearly larger than the tiny digit gaps beneath it.
    var jumpMin = Math.max(3, charHeight * 0.22);
    var intraCeil = charHeight * 0.5; // intra-digit gaps live below ~half the glyph height
    for (var i = 1; i < g.length; i += 1) {
      if (g[i] - g[i - 1] >= jumpMin && g[i - 1] <= intraCeil) {
        return Math.min(ceil, Math.max(floor, (g[i] + g[i - 1]) / 2));
      }
    }
    return Math.min(ceil, Math.max(floor, charHeight * 0.4));
  }

  function groupComponentsIntoValues(components, opts) {
    opts = opts || {};
    var comps = (Array.isArray(components) ? components : [])
      .filter(function (c) { return c && Number.isFinite(Number(c.x0)) && Number.isFinite(Number(c.x1)) && Number(c.x1) > Number(c.x0); })
      .slice()
      .sort(function (a, b) { return Number(a.x0) - Number(b.x0); });
    if (!comps.length) return [];
    var charHeight = Number(opts.charHeight) ||
      median(comps.map(function (c) { return Number(c.y1) - Number(c.y0); }).filter(function (v) { return v > 0; })) || 16;
    var gaps = [];
    for (var i = 1; i < comps.length; i += 1) gaps.push(Number(comps[i].x0) - Number(comps[i - 1].x1));
    var threshold = Number.isFinite(Number(opts.threshold)) ? Number(opts.threshold) : valueGapThreshold(gaps, charHeight);
    var groups = [];
    var group = null;
    comps.forEach(function (c) {
      if (!group) { group = { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, ink: Number(c.area) || 0, count: 1 }; return; }
      var gap = Number(c.x0) - group.x1;
      if (gap <= threshold) {
        group.x0 = Math.min(group.x0, c.x0); group.y0 = Math.min(group.y0, c.y0);
        group.x1 = Math.max(group.x1, c.x1); group.y1 = Math.max(group.y1, c.y1);
        group.ink += Number(c.area) || 0; group.count += 1;
      } else {
        groups.push(group);
        group = { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, ink: Number(c.area) || 0, count: 1 };
      }
    });
    if (group) groups.push(group);
    return groups.map(function (b) {
      return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, w: b.x1 - b.x0, h: b.y1 - b.y0, ink: b.ink };
    });
  }

  // ---------- column-split (Stage 1) ----------
  function clearanceConfig(boxes, sourceWidth) {
    sourceWidth = sourceWidth || 0;
    var widths = (Array.isArray(boxes) ? boxes : []).map(function (b) { return Number(b.w); }).filter(function (v) { return Number.isFinite(v) && v > 0; });
    var medianWidth = median(widths) || 36;
    var sourceMax = Number(sourceWidth) || Math.max.apply(null, [0].concat((Array.isArray(boxes) ? boxes : []).map(function (b) { return Number(b.x1) || 0; })));
    var sourceLimit = sourceMax ? sourceMax * 0.018 : 28;
    var corridorWidth = Math.max(8, Math.min(28, sourceLimit || 28, medianWidth * 0.38));
    return {
      corridorWidth: corridorWidth,
      half: corridorWidth / 2,
      mergeGap: Math.max(4, Math.min(16, corridorWidth * 0.65)),
      step: Math.max(1, Math.round(corridorWidth / 4)),
      minColumnWidth: Math.max(42, corridorWidth * 2.2, sourceMax * 0.024),
      edgeGuard: Math.max(8, corridorWidth * 0.65),
      sourceMax: sourceMax
    };
  }

  function mergeIntervals(items, mergeGap) {
    var sorted = (Array.isArray(items) ? items : [])
      .filter(function (b) { return Number.isFinite(Number(b.x0)) && Number.isFinite(Number(b.x1)) && Number(b.x1) > Number(b.x0); })
      .slice()
      .sort(function (a, b) { return Number(a.x0) - Number(b.x0); });
    var intervals = [];
    sorted.forEach(function (box) {
      var current = intervals[intervals.length - 1];
      if (current && Number(box.x0) - Number(current.x1) <= mergeGap) {
        current.x1 = Math.max(Number(current.x1), Number(box.x1));
        current.x0 = Math.min(Number(current.x0), Number(box.x0));
        current.cx = (current.x0 + current.x1) / 2;
        current.items.push(box);
        return;
      }
      intervals.push({ x0: Number(box.x0), x1: Number(box.x1), cx: (Number(box.x0) + Number(box.x1)) / 2, items: [box] });
    });
    return intervals;
  }

  function clearanceRows(boxes, cfg) {
    var rowTracks = trackClusters(boxes, "y").filter(function (c) { return c.items.length >= 3 && Number.isFinite(Number(c.cy)); });
    return rowTracks
      .map(function (row, index) {
        var items = (Array.isArray(row.items) ? row.items : [])
          .filter(function (b) { return Number.isFinite(Number(b.cx)) && Number.isFinite(Number(b.x0)) && Number.isFinite(Number(b.x1)); })
          .sort(function (a, b) { return Number(a.x0) - Number(b.x0); });
        return {
          rowIndex: index,
          cy: Number(row.cy),
          top: Number(row.y0),
          bottom: Number(row.y1),
          count: items.length,
          items: items,
          intervals: mergeIntervals(items, cfg.mergeGap)
        };
      })
      .filter(function (row) { return row.items.length >= 3 && row.intervals.length >= 2; });
  }

  function corridorBands(rows, cfg) {
    var sourceMax = Number(cfg && cfg.sourceMax) || 0;
    if (!sourceMax || !Array.isArray(rows) || rows.length < 3) return [];
    var half = Number(cfg.half) || 9;
    var step = Math.max(1, Number(cfg.step) || 3);
    var minSupport = Math.max(3, Math.ceil(rows.length * 0.52));
    var maxBlocked = Math.max(1, Math.floor(rows.length * 0.2));
    var samples = [];
    for (var x = 0; x <= sourceMax; x += step) {
      var support = 0, blocked = 0, clearRows = 0;
      rows.forEach(function (row) {
        var intervals = Array.isArray(row.intervals) ? row.intervals : [];
        var hit = intervals.some(function (iv) { return Number(iv.x0) < x + half && Number(iv.x1) > x - half; });
        if (hit) { blocked += 1; return; }
        var hasLeft = intervals.some(function (iv) { return Number(iv.x1) <= x - half; });
        var hasRight = intervals.some(function (iv) { return Number(iv.x0) >= x + half; });
        if (hasLeft && hasRight) support += 1;
        clearRows += 1;
      });
      if (support >= minSupport && blocked <= maxBlocked) {
        samples.push({ x: x, support: support, blocked: blocked, clearRows: clearRows, score: support * 10 - blocked * 18 + clearRows });
      }
    }
    var bands = [];
    var current = null;
    samples.forEach(function (sample) {
      if (!current || sample.x - current.end > step * 1.5) {
        if (current) bands.push(current);
        current = { start: sample.x, end: sample.x, best: sample, samples: [sample] };
        return;
      }
      current.end = sample.x;
      current.samples.push(sample);
      if (sample.score > current.best.score) current.best = sample;
    });
    if (current) bands.push(current);
    return bands
      .map(function (band) {
        return Object.assign({}, band, {
          // Cut through the MIDDLE of the clear corridor (centre of the gap), not
          // band.best.x — every x in a clear gap scores the same, so best.x ties
          // to the leftmost sample and the cut hugs the right edge of the value.
          x: Math.round((Number(band.start) + Number(band.end)) / 2),
          width: Math.max(step, Number(band.end) - Number(band.start) + step),
          support: Number(band.best && band.best.support) || 0,
          blocked: Number(band.best && band.best.blocked) || 0,
          score: Number(band.best && band.best.score) || 0
        });
      })
      .filter(function (band) { return Number.isFinite(Number(band.x)) && band.x >= cfg.edgeGuard && band.x <= sourceMax - cfg.edgeGuard; })
      .sort(function (a, b) { return Number(a.x) - Number(b.x); });
  }

  function pruneCuts(bands, cfg) {
    var minGap = Math.max(1, Number(cfg && cfg.minColumnWidth) || 32);
    var cuts = [];
    (Array.isArray(bands) ? bands : []).forEach(function (band) {
      var previous = cuts[cuts.length - 1];
      if (previous && Number(band.x) - Number(previous.x) < minGap) {
        var bandScore = Number(band.score) + Number(band.width) * 0.2;
        var previousScore = Number(previous.score) + Number(previous.width) * 0.2;
        if (bandScore > previousScore) cuts[cuts.length - 1] = band;
        return;
      }
      cuts.push(band);
    });
    return cuts;
  }

  function outlierScanSpan(rows, left, right, pass) {
    var half = Number(pass.half);
    var localRows = rows
      .map(function (row) {
        var items = (Array.isArray(row.items) ? row.items : []).filter(function (b) { return Number(b.cx) > left && Number(b.cx) < right; });
        return { items: items, intervals: mergeIntervals(items, pass.mergeGap) };
      })
      .filter(function (row) { return row.intervals.length; });
    if (localRows.length < 3) return { bands: [], rowCount: localRows.length };
    var minSupport = Math.max(3, Math.ceil(localRows.length * pass.supportRatio));
    var maxBlocked = Math.max(1, Math.floor(localRows.length * pass.blockedRatio));
    var guard = Math.max(6, half);
    var samples = [];
    for (var x = Math.ceil(left + guard); x <= right - guard; x += 1) {
      var support = 0, blocked = 0, clearRows = 0;
      localRows.forEach(function (row) {
        var hit = row.intervals.some(function (iv) { return Number(iv.x0) < x + half && Number(iv.x1) > x - half; });
        if (hit) { blocked += 1; return; }
        var hasLeft = row.intervals.some(function (iv) { return Number(iv.x1) <= x - half; });
        var hasRight = row.intervals.some(function (iv) { return Number(iv.x0) >= x + half; });
        if (hasLeft && hasRight) support += 1;
        clearRows += 1;
      });
      if (support >= minSupport && blocked <= maxBlocked) {
        samples.push({ x: x, support: support, blocked: blocked, clearRows: clearRows, score: support * 10 - blocked * 18 + clearRows });
      }
    }
    var bands = [];
    var current = null;
    samples.forEach(function (sample) {
      if (!current || sample.x - current.end > 3) {
        if (current) bands.push(current);
        current = { start: sample.x, end: sample.x, best: sample };
        return;
      }
      current.end = sample.x;
      if (sample.score > current.best.score) current.best = sample;
    });
    if (current) bands.push(current);
    return { bands: bands, rowCount: localRows.length };
  }

  function acceptOutlierBands(bands, left, right, localMinGap) {
    var accepted = [];
    bands
      .slice()
      .sort(function (a, b) { return Number(a.best.x) - Number(b.best.x); })
      .forEach(function (band) {
        var cut = {
          x: Math.round((Number(band.start) + Number(band.end)) / 2),
          width: Math.max(1, Number(band.end) - Number(band.start) + 1),
          support: Number(band.best.support) || 0,
          blocked: Number(band.best.blocked) || 0,
          score: Number(band.best.score) || 0,
          source: "outlier-corridor-resplit"
        };
        if (!Number.isFinite(cut.x) || cut.x - left < localMinGap || right - cut.x < localMinGap) return;
        var previous = accepted[accepted.length - 1];
        if (previous && cut.x - Number(previous.x) < localMinGap) {
          if (cut.score > Number(previous.score)) accepted[accepted.length - 1] = cut;
          return;
        }
        accepted.push(cut);
      });
    return accepted;
  }

  function outlierSplitCuts(rows, columns, cfg, debug) {
    var list = Array.isArray(columns) ? columns : [];
    if (list.length < 3 || !Array.isArray(rows) || rows.length < 3) return [];
    var widths = list.map(function (c) { return Number(c.right) - Number(c.left); }).filter(function (v) { return Number.isFinite(v) && v > 0; });
    var medianWidth = median(widths) || 0;
    if (!medianWidth) return [];
    var passes = [
      { mergeGap: Math.max(2, Number(cfg.mergeGap) * 0.4), half: Math.max(2, Number(cfg.half) * 0.5), supportRatio: 0.52, blockedRatio: 0.2 },
      { mergeGap: Math.max(2, Number(cfg.mergeGap) * 0.25), half: Math.max(2, Number(cfg.half) * 0.3), supportRatio: 0.4, blockedRatio: 0.3 },
      { mergeGap: 2, half: 2, supportRatio: 0.35, blockedRatio: 0.5 }
    ];
    var extraCuts = [];
    list.forEach(function (column) {
      var left = Number(column.left);
      var right = Number(column.right);
      var width = right - left;
      if (!Number.isFinite(width) || width <= medianWidth * 1.6) return;
      var expected = Math.max(2, Math.round(width / medianWidth));
      var pitch = width / expected;
      var localMinGap = Math.max(24, (Number(cfg.minColumnWidth) || 42) * 0.45 + 2, Math.min(medianWidth * 0.55, pitch * 0.6));
      var best = null;
      var bestPass = -1;
      for (var passIndex = 0; passIndex < passes.length; passIndex += 1) {
        var scan = outlierScanSpan(rows, left, right, passes[passIndex]);
        var accepted = acceptOutlierBands(scan.bands, left, right, localMinGap);
        if (!best || accepted.length > best.length) { best = accepted; bestPass = passIndex; }
        if (best.length >= expected - 1) break;
      }
      if (debug) {
        console.debug("[ClarityTableOcr] outlier re-split", {
          span: { left: Math.round(left), right: Math.round(right), width: Math.round(width) },
          medianWidth: Math.round(medianWidth),
          expectedColumns: expected,
          localMinGap: Math.round(localMinGap),
          passUsed: bestPass,
          cuts: (best || []).map(function (c) { return Math.round(c.x); })
        });
      }
      (best || []).forEach(function (c) { extraCuts.push(c); });
    });
    return extraCuts;
  }

  function columnsFromCuts(rows, cuts, cfg) {
    var sourceMax = Number(cfg && cfg.sourceMax) || 0;
    if (!sourceMax || !Array.isArray(rows) || rows.length < 3 || !Array.isArray(cuts) || !cuts.length) return [];
    var boundaries = [0]
      .concat(cuts.map(function (c) { return Number(c.x); }).filter(Number.isFinite), [sourceMax])
      .filter(function (value, index, array) { return index === 0 || value > array[index - 1] + 1; });
    var minSupport = Math.max(2, Math.ceil(rows.length * 0.30));
    var columns = [];
    for (var index = 0; index < boundaries.length - 1; index += 1) {
      var left = Number(boundaries[index]);
      var right = Number(boundaries[index + 1]);
      if (right - left < Math.max(12, Number(cfg.minColumnWidth) * 0.45)) continue;
      var rowHits = [];
      var hits = [];
      rows.forEach(function (row) {
        var rowItems = (Array.isArray(row.items) ? row.items : []).filter(function (b) { return Number(b.cx) > left && Number(b.cx) < right; });
        if (rowItems.length) { rowHits.push(row.rowIndex); rowItems.forEach(function (b) { hits.push(b); }); }
      });
      if (rowHits.length < minSupport || !hits.length) continue;
      var x0 = Math.min.apply(null, hits.map(function (b) { return Number(b.x0); }).filter(Number.isFinite));
      var x1 = Math.max.apply(null, hits.map(function (b) { return Number(b.x1); }).filter(Number.isFinite));
      var valueCx = median(hits.map(function (b) { return Number(b.cx); }).filter(Number.isFinite)) || ((left + right) / 2);
      var n = String(columns.length + 1).padStart(2, "0");
      columns.push({
        key: "gridCol" + n, label: "C" + n, x0: x0, x1: x1, left: left, right: right,
        dividerLeft: left, dividerRight: right, cx: (left + right) / 2, valueCx: valueCx,
        valueBoxCount: hits.length, valueSkewerSupport: rowHits.length,
        source: "ocr_value_clearance_corridor"
      });
    }
    return columns;
  }

  function reindex(columns) {
    return (Array.isArray(columns) ? columns : []).map(function (column, index) {
      var n = String(index + 1).padStart(2, "0");
      return Object.assign({}, column, { key: "gridCol" + n, label: "C" + n });
    });
  }

  // Positional de-fuse: the gap-search cannot split a corridor when OCR fused
  // several values into one solid box (no internal gap exists). For any column
  // still anomalously wide vs the median, divide it into the expected number of
  // equal sub-columns by position. Extraction re-crops the flat image per
  // column, so it does not need the fused word-box to be separated — only the
  // column x-boundaries need to be right. Additive: normal columns are untouched.
  function positionalDefuse(columns) {
    var list = Array.isArray(columns) ? columns : [];
    if (list.length < 3) return list;
    var widths = list.map(function (c) { return Number(c.right) - Number(c.left); }).filter(function (v) { return Number.isFinite(v) && v > 0; });
    var medianWidth = median(widths) || 0;
    if (!medianWidth) return list;
    var out = [];
    list.forEach(function (col) {
      var w = Number(col.right) - Number(col.left);
      if (!Number.isFinite(w) || w <= medianWidth * 1.6) { out.push(col); return; }
      var expected = Math.max(2, Math.round(w / medianWidth));
      // Anchor the sub-columns on the value-box extent so left/right margins
      // don't skew the pitch; keep the outer edges at the corridor bounds.
      var vx0 = Number.isFinite(Number(col.x0)) ? Number(col.x0) : Number(col.left);
      var vx1 = Number.isFinite(Number(col.x1)) ? Number(col.x1) : Number(col.right);
      if (!(vx1 > vx0)) { vx0 = Number(col.left); vx1 = Number(col.right); }
      var pitch = (vx1 - vx0) / expected;
      for (var k = 0; k < expected; k += 1) {
        var subL = k === 0 ? Number(col.left) : (vx0 + k * pitch);
        var subR = k === expected - 1 ? Number(col.right) : (vx0 + (k + 1) * pitch);
        var cx = (subL + subR) / 2;
        out.push(Object.assign({}, col, {
          left: subL, right: subR, dividerLeft: subL, dividerRight: subR,
          x0: subL, x1: subR, cx: cx, valueCx: cx, source: "outlier-positional-defuse"
        }));
      }
    });
    return out;
  }

  /**
   * Stage 1 — split a flat table into value columns from number-box geometry.
   * @param {Array} numberBoxes  boxes {x0,y0,x1,y1,cx,cy,w,h}
   * @param {Object} opts        { sourceWidth, debug }
   * @returns {Array} columns
   */
  function splitColumns(numberBoxes, opts) {
    opts = opts || {};
    var boxes = Array.isArray(numberBoxes) ? numberBoxes : [];
    if (boxes.length < 4) return [];
    var cfg = clearanceConfig(boxes, opts.sourceWidth || 0);
    var rows = clearanceRows(boxes, cfg);
    if (rows.length < 3) return [];
    var bands = corridorBands(rows, cfg);
    var cuts = pruneCuts(bands, cfg);
    var columns = columnsFromCuts(rows, cuts, cfg);
    var allCuts = cuts.slice();
    for (var attempt = 0; attempt < 3; attempt += 1) {
      var extraCuts = outlierSplitCuts(rows, columns, cfg, opts.debug);
      if (!extraCuts.length) break;
      allCuts = allCuts.concat(extraCuts).sort(function (a, b) { return Number(a.x) - Number(b.x); });
      columns = columnsFromCuts(rows, allCuts, cfg);
    }
    // Final safety net for fused OCR boxes the gap-search can't separate.
    columns = positionalDefuse(columns);
    return reindex(columns);
  }

  // ---------- OCR word helpers (number filtering before the cut) ----------
  // Normalise a Tesseract word ({text, bbox:{x0,y0,x1,y1}} or flat) to a box.
  function wordBox(word) {
    var b = (word && word.bbox) ? word.bbox : word || {};
    var x0 = Number(b.x0), y0 = Number(b.y0), x1 = Number(b.x1), y1 = Number(b.y1);
    return { x0: x0, y0: y0, x1: x1, y1: y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, text: String((word && word.text) || "").trim() };
  }

  // Keep only number-like words — this is the "filter to number-like BEFORE the
  // cut" step. Header labels (letters) and stray marks are dropped, so they can
  // never distort the column geometry. Whatever letters remain on a strip are
  // the header, read separately in Stage 2.
  function numberBoxesFromWords(words) {
    return (Array.isArray(words) ? words : [])
      .map(wordBox)
      .filter(function (b) { return Number.isFinite(b.x0) && Number.isFinite(b.y0) && b.x1 > b.x0 && looksLikeValue(b.text); });
  }

  // Assign each leftover NON-number word to the column whose CENTRE it is
  // nearest to (header labels are wider than the narrow value columns, so a
  // multi-word header like "LAUNCH ANGLE" would otherwise split across strips).
  // opts.headerBottom limits to the header band so direction markers (R/L) and
  // the units row don't leak in.
  function headerTextForColumns(columns, words, opts) {
    opts = opts || {};
    var maxY = Number.isFinite(Number(opts.headerBottom)) ? Number(opts.headerBottom) : Infinity;
    var cols = Array.isArray(columns) ? columns : [];
    if (!cols.length) return [];
    var centers = cols.map(function (c) { return (Number(c.left) + Number(c.right)) / 2; });
    var textWords = (Array.isArray(words) ? words : []).map(wordBox)
      .filter(function (b) { return b.text && !looksLikeValue(b.text) && b.cy <= maxY; });
    var buckets = cols.map(function () { return []; });
    textWords.forEach(function (w) {
      var best = 0, bestD = Infinity;
      centers.forEach(function (cc, i) { var d = Math.abs(w.cx - cc); if (d < bestD) { bestD = d; best = i; } });
      buckets[best].push(w);
    });
    return buckets.map(function (bucket) {
      return bucket.sort(function (a, b) { return a.x0 - b.x0; }).map(function (w) { return w.text; }).join(" ").trim();
    });
  }

  // Summary rows (AVERAGE / STD DEV) carry these labels in the left margin and
  // are not shots — used to drop them before import.
  function isSummaryLabel(text) {
    return /(average|avg|std|dev|deviation|mean)/i.test(String(text || ""));
  }

  // Cluster number-boxes into value rows by vertical centre.
  function clusterValueRows(boxes) {
    var tracks = trackClusters(boxes, "y").filter(function (c) { return c.items.length >= 2; });
    return tracks.map(function (t) { return { cy: t.cy, y0: t.y0, y1: t.y1, items: t.items }; })
      .sort(function (a, b) { return a.cy - b.cy; });
  }

  // ---------- header allocation (Stage 2) ----------
  function compactToken(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""); }

  function levenshtein(a, b) {
    a = String(a || ""); b = String(b || "");
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = [], i, j;
    for (j = 0; j <= b.length; j += 1) prev[j] = j;
    for (i = 1; i <= a.length; i += 1) {
      var cur = [i];
      for (j = 1; j <= b.length; j += 1) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // Resolve header text -> metric key. Tries the registry's exact token match,
  // then a fuzzy fallback so OCR typos (e.g. "LAUNEH ANGLE") still resolve.
  function resolveMetricKey(headerText, resolver, registry) {
    var reg = registry || (typeof globalThis !== "undefined" && globalThis.LaunchMonitorAliasRegistry) || null;
    var fn = resolver || (reg && reg.canonicalKey) || null;
    var text = String(headerText || "").trim();
    if (!text) return "";
    if (typeof fn === "function") {
      var key = fn(text);
      if (key) return key;
      var cleaned = text.replace(/\b(mph|rpm|deg|ft|m)\b/gi, "").replace(/[°º]/g, "").trim();
      if (cleaned && cleaned !== text) { var k2 = fn(cleaned); if (k2) return k2; }
    }
    if (reg && Array.isArray(reg.entries)) {
      var token = compactToken(text);
      if (token.length < 3) return "";
      // Substring pass: the LONGEST known alias contained in the header text.
      // Handles noise words mixed into the crop (e.g. "BALL: STANDARD" landing in
      // the Ball Speed header -> "ballstandardballspeed" still contains "ballspeed").
      var subKey = "", subLen = 0;
      reg.entries.forEach(function (entry) {
        [entry.key, entry.label, entry.rawLabel, entry.candidateMetric].concat(entry.aliases || [], entry.headerAliases || []).forEach(function (alias) {
          var at = compactToken(alias);
          // Floor of 5 so generic 4-char fragments (ball, side, spin, peak, path,
          // axis, desc) can't hijack a noisy header — e.g. the club column
          // "BALL: STANDARD" must NOT match ballSpeed via "ball". Real metric names
          // (carry, total, topin, ballspeed, sideangle, ...) are all >= 5.
          if (at.length >= 5 && token.indexOf(at) >= 0 && at.length > subLen) { subLen = at.length; subKey = entry.key; }
        });
      });
      if (subKey) return subKey;
      // Fuzzy fallback against the registry's alias tokens.
      var best = "", bestDist = Infinity;
      reg.entries.forEach(function (entry) {
        [entry.key, entry.label, entry.rawLabel, entry.candidateMetric]
          .concat(entry.aliases || [], entry.headerAliases || [])
          .forEach(function (alias) {
            var at = compactToken(alias);
            if (at.length < 3) return;
            var d = levenshtein(token, at);
            var tol = Math.max(1, Math.floor(Math.max(token.length, at.length) * 0.25));
            if (d <= tol && d < bestDist) { bestDist = d; best = entry.key; }
          });
      });
      return best;
    }
    return "";
  }

  function allocateHeaders(columns, headerTexts, opts) {
    opts = opts || {};
    var cols = Array.isArray(columns) ? columns : [];
    var texts = Array.isArray(headerTexts) ? headerTexts : [];
    var reg = opts.registry || (typeof globalThis !== "undefined" && globalThis.LaunchMonitorAliasRegistry) || null;
    return cols.map(function (col, i) {
      var headerText = texts[i] != null ? texts[i] : ((col && col.rawHeaderText) || "");
      var metricKey = resolveMetricKey(headerText, opts.resolver, reg);
      return Object.assign({}, col, { headerText: String(headerText || ""), metricKey: metricKey });
    });
  }

  // Strip boundaries: use the SPLITTER'S OWN cut bounds (col.left/col.right) so a
  // strip is exactly the column the splitter drew — do NOT re-derive midpoints
  // between centres, which "splits the difference" and can put a strip edge where
  // no cut was ever made. valLeft/valRight are the tight value extent (col.x0/x1)
  // for an optional tighter extraction crop.
  function stripBoundaries(columns, sourceWidth) {
    var cols = Array.isArray(columns) ? columns : [];
    if (!cols.length) return [];
    var W = Number(sourceWidth) || 0;
    return cols.map(function (c, i) {
      var left = Number(c.left), right = Number(c.right);
      var vl = Number.isFinite(Number(c.x0)) ? Number(c.x0) : left;
      var vr = Number.isFinite(Number(c.x1)) ? Number(c.x1) : right;
      return {
        index: i,
        left: Math.max(0, Math.round(left)),
        right: Math.round(W ? Math.min(W, right) : right),
        valLeft: vl, valRight: vr,
        cx: (left + right) / 2,
        metricKey: c.metricKey, headerText: c.headerText
      };
    });
  }

  // Trim spurious columns (club marker / margins) from the LEFT and RIGHT edges
  // that resolved to no metric, keeping the contiguous run of real columns. This
  // undoes the "7i read as 7 -> phantom left column" shift.
  function trimUnresolvedEdges(allocatedColumns) {
    var list = Array.isArray(allocatedColumns) ? allocatedColumns : [];
    var lo = 0, hi = list.length - 1;
    while (lo <= hi && !(list[lo] && list[lo].metricKey)) lo += 1;
    while (hi >= lo && !(list[hi] && list[hi].metricKey)) hi -= 1;
    return lo <= hi ? list.slice(lo, hi + 1) : [];
  }

  // ---------- cell value parsing + validation (Stage 3) ----------
  var DIRECTION_METRICS = ["sideAngle", "sideSpin", "offline"];
  function needsDirection(key) { return DIRECTION_METRICS.indexOf(String(key || "")) >= 0; }

  function directionFromText(text) {
    var raw = String(text || "").trim().toUpperCase();
    if (!raw) return "";
    if (/[+]/.test(raw)) return "R";
    if (/[-−–—]/.test(raw)) return "L";
    var letters = raw.replace(/[^LR]/g, "");
    if (letters === "L" || letters === "R") return letters;
    var m = raw.match(/(?:^|[^A-Z])([LR])(?:[^A-Z]|$)/);
    return m ? m[1] : "";
  }

  // Ported from gdLmParseNumber: tolerant number parse + per-metric implied
  // decimal repair (launch monitors often drop the decimal point in OCR).
  function parseNumber(value, key) {
    var raw = String(value == null ? "" : value).trim();
    if (!raw || /^[-=—–]+$/.test(raw)) return NaN;
    if (/[A-KM-QS-Z]/i.test(raw.replace(/[Oo]/g, "").replace(/[°º]/g, ""))) return NaN;
    var text = raw.replace(/[−–—]/g, "-").replace(/[Oo]/g, "0").replace(/[^0-9,.\-+]/g, "");
    if (!text || /^[-+.]$/.test(text)) return NaN;
    var hasDecimal = /[,.]/.test(text);
    if (text.indexOf(",") >= 0 && text.indexOf(".") < 0) text = text.replace(/,/g, ".");
    else if (text.indexOf(",") >= 0 && text.indexOf(".") >= 0) text = text.replace(/,/g, "");
    var n = Number(text);
    if (!Number.isFinite(n)) return NaN;
    var abs = Math.abs(n);
    var k = String(key || "");
    if (!hasDecimal) {
      if (["clubSpeed", "ballSpeed"].indexOf(k) >= 0 && abs >= 400 && abs <= 1900) n = n / 10;
      else if (k === "offline" && abs >= 30 && abs < 300) n = n / 10;
      else if (["carry", "total"].indexOf(k) >= 0 && abs >= 380 && abs < 3300) n = n / 10;
      else if (["attackAngle", "sideAngle", "launchDirection", "spinAxis", "faceToPath", "swingDirection", "clubPath", "faceAngle", "dynamicLoft", "launch", "descent"].indexOf(k) >= 0 && abs >= 10 && abs < 900) n = n / 10;
      else if (k === "smashFactor" && abs >= 80 && abs < 220) n = n / 100;
    }
    return n;
  }

  // Ported from gdLmMetricPlausible: rejects impossible reads (this is what
  // catches garbage like launch=942031 before it can be saved).
  function metricPlausible(key, value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return false;
    var abs = Math.abs(n);
    switch (String(key || "")) {
      case "ballSpeed": return n >= 40 && n <= 190;
      case "carry": return n >= 20 && n <= 260;
      case "total": return n >= 20 && n <= 300;
      case "offline": return abs <= 80;
      case "launch": return n >= -5 && n <= 45;
      case "sideAngle": return abs <= 25;
      case "descent": return n >= 5 && n <= 65;
      case "peakHeight": return n >= 1 && n <= 80;
      case "backspin": return n >= 1000 && n <= 12000;
      case "sideSpin": return abs <= 2500;
      case "toPin": return n >= 0 && n <= 400;
      default: return true;
    }
  }

  function looksLikeValue(text) {
    var raw = String(text || "").trim();
    if (!/[0-9Oo]/.test(raw)) return false;
    var letters = raw.replace(/[OoRrLl]/g, "").replace(/[°º]/g, "").replace(/[^A-Z]/gi, "");
    if (letters) return false;
    return Number.isFinite(parseNumber(raw));
  }

  // Parse one cell's OCR text for a given metric -> value + direction + valid.
  function parseCell(text, metricKey) {
    var key = String(metricKey || "");
    var value = parseNumber(text, key);
    var direction = needsDirection(key) ? directionFromText(text) : "";
    var valid = Number.isFinite(value) && metricPlausible(key, value);
    return { raw: String(text || ""), value: Number.isFinite(value) ? value : null, direction: direction, valid: valid };
  }

  // ---------- deep scan (Stage 3.5): blanking method for direction markers ----------
  // A direction cell is a NUMBER plus a small marker glyph that is one of exactly
  // four shapes: L, R, + or -. The blanking method removes the number (the value
  // cluster) from consideration and classifies whatever ink remains. All pure
  // mask/geometry work lives here; the browser glue only supplies pixels.

  // Crop a sub-rectangle out of a {mask,w,h} ink mask (clamped, inclusive bounds).
  function cropMask(maskObj, x0, y0, x1, y1) {
    var w = Number(maskObj && maskObj.w) || 0, h = Number(maskObj && maskObj.h) || 0;
    var cx0 = Math.max(0, Math.floor(Math.min(x0, x1)));
    var cy0 = Math.max(0, Math.floor(Math.min(y0, y1)));
    var cx1 = Math.min(w - 1, Math.ceil(Math.max(x0, x1)));
    var cy1 = Math.min(h - 1, Math.ceil(Math.max(y0, y1)));
    var cw = Math.max(0, cx1 - cx0 + 1), ch = Math.max(0, cy1 - cy0 + 1);
    var out = new Uint8Array(cw * ch);
    for (var y = 0; y < ch; y += 1) {
      for (var x = 0; x < cw; x += 1) {
        out[y * cw + x] = maskObj.mask[(cy0 + y) * w + (cx0 + x)] ? 1 : 0;
      }
    }
    return { mask: out, w: cw, h: ch };
  }

  // Fraction-of-ink fill grid (rows x cols) over a glyph mask, normalised so the
  // densest cell is 1. The classifier reasons about WHERE the strokes are, not
  // how thick they are.
  function glyphFillGrid(maskObj, rows, cols) {
    rows = rows || 3; cols = cols || 3;
    var w = maskObj.w, h = maskObj.h, mask = maskObj.mask;
    var grid = [];
    for (var r = 0; r < rows; r += 1) { grid.push([]); for (var c = 0; c < cols; c += 1) grid[r].push(0); }
    if (!w || !h) return grid;
    for (var y = 0; y < h; y += 1) {
      var gr = Math.min(rows - 1, Math.floor((y / h) * rows));
      for (var x = 0; x < w; x += 1) {
        if (!mask[y * w + x]) continue;
        var gc = Math.min(cols - 1, Math.floor((x / w) * cols));
        grid[gr][gc] += 1;
      }
    }
    var max = 0;
    for (r = 0; r < rows; r += 1) for (c = 0; c < cols; c += 1) if (grid[r][c] > max) max = grid[r][c];
    if (max > 0) for (r = 0; r < rows; r += 1) for (c = 0; c < cols; c += 1) grid[r][c] = grid[r][c] / max;
    return grid;
  }

  // Count fully ENCLOSED background regions (holes) in a glyph mask. Cheap and
  // decisive: L / + / - have 0 holes, R has exactly 1 (its bowl), while closed
  // digits like 8 (2 holes) and 0 (1 hole, but a closed bottom) are the false
  // positives this guards against.
  function countMaskHoles(maskObj) {
    var w = maskObj.w, h = maskObj.h, mask = maskObj.mask;
    if (!w || !h) return 0;
    var seen = new Uint8Array(w * h);
    var queue = [];
    function pushBg(x, y) {
      var i = y * w + x;
      if (x < 0 || y < 0 || x >= w || y >= h || mask[i] || seen[i]) return;
      seen[i] = 1; queue.push(i);
    }
    for (var x = 0; x < w; x += 1) { pushBg(x, 0); pushBg(x, h - 1); }
    for (var y = 0; y < h; y += 1) { pushBg(0, y); pushBg(w - 1, y); }
    while (queue.length) {
      var cur = queue.pop();
      var cx = cur % w, cy = (cur - cx) / w;
      pushBg(cx - 1, cy); pushBg(cx + 1, cy); pushBg(cx, cy - 1); pushBg(cx, cy + 1);
    }
    var holes = [];
    for (var i = 0; i < mask.length; i += 1) {
      if (mask[i] || seen[i]) continue;
      // flood this hole so it counts once, tracking its bounding box — WHERE a
      // hole sits separates R (bowl hole in the top half) from 0/O (hole spans
      // nearly the full height).
      var hx0 = i % w, hy0 = (i - hx0) / w, hx1 = hx0, hy1 = hy0;
      queue.push(i); seen[i] = 1;
      while (queue.length) {
        var c = queue.pop();
        var hx = c % w, hy = (c - hx) / w;
        if (hx < hx0) hx0 = hx; if (hx > hx1) hx1 = hx;
        if (hy < hy0) hy0 = hy; if (hy > hy1) hy1 = hy;
        [[hx - 1, hy], [hx + 1, hy], [hx, hy - 1], [hx, hy + 1]].forEach(function (p) {
          var px = p[0], py = p[1], pi = py * w + px;
          if (px < 0 || py < 0 || px >= w || py >= h || mask[pi] || seen[pi]) return;
          seen[pi] = 1; queue.push(pi);
        });
      }
      holes.push({ x0: hx0, y0: hy0, x1: hx1, y1: hy1 });
    }
    return { count: holes.length, boxes: holes };
  }

  // Classify a single glyph mask (TIGHT bounding-box crop of one component) as
  // one of the four possible markers. Returns { glyph:"L"|"R"|"+"|"-"|"",
  // score:0..1, grid, holes } — grid + holes are kept so the debug window can
  // show exactly what the classifier saw.
  function classifyGlyphMask(maskObj) {
    var w = Number(maskObj && maskObj.w) || 0, h = Number(maskObj && maskObj.h) || 0;
    var mask = maskObj && maskObj.mask;
    var none = { glyph: "", score: 0, grid: null, holes: 0 };
    if (!mask || w < 2 || h < 2) return none;
    var ink = 0;
    for (var i = 0; i < mask.length; i += 1) if (mask[i]) ink += 1;
    if (ink < 6) return none;
    var aspect = w / h;
    var density = ink / (w * h);
    var holeInfo = countMaskHoles(maskObj);
    var holes = holeInfo.count;
    var grid = glyphFillGrid(maskObj, 3, 3);
    // Raw thirds (fractions of TOTAL ink, not normalised) for the +/- checks.
    var rowThirds = [0, 0, 0], colThirds = [0, 0, 0], corners = 0;
    for (var y = 0; y < h; y += 1) {
      var rt = Math.min(2, Math.floor((y / h) * 3));
      for (var x = 0; x < w; x += 1) {
        if (!mask[y * w + x]) continue;
        var ct = Math.min(2, Math.floor((x / w) * 3));
        rowThirds[rt] += 1; colThirds[ct] += 1;
        if ((rt === 0 || rt === 2) && (ct === 0 || ct === 2)) corners += 1;
      }
    }
    var midRow = rowThirds[1] / ink, midCol = colThirds[1] / ink, cornerFrac = corners / ink;
    // '-' : a tight crop of a dash is a solid, wide, flat block.
    if (holes === 0 && aspect >= 1.7 && density >= 0.7) {
      return { glyph: "-", score: Math.min(1, 0.6 + density * 0.4), grid: grid, holes: holes };
    }
    // '+' : roughly square cross — ink lives in the middle row band + middle
    // column band, corners empty.
    if (holes === 0 && aspect >= 0.55 && aspect <= 1.8 && cornerFrac <= 0.10 && (midRow + midCol) >= 1.0 && midRow >= 0.3 && midCol >= 0.3) {
      return { glyph: "+", score: Math.min(1, 0.55 + (1 - cornerFrac) * 0.35), grid: grid, holes: holes };
    }
    // Letters. Both L and R have a full-height stroke on the LEFT; the main
    // difference is ink in the TOP-RIGHT (R's bar + bowl) vs none (L). Holes
    // arbitrate against look-alike digits: 8 (2 holes) is never a letter, a
    // closed 0 (1 hole) has a full bottom-middle where R has a gap between its
    // legs, and L can never contain a hole.
    if (holes <= 1 && aspect >= 0.3 && aspect <= 1.25) {
      var leftCol = (grid[0][0] + grid[1][0] + grid[2][0]) / 3;
      var topRight = (grid[0][1] + grid[0][2] + grid[1][2]) / 3;
      var bottomBar = (grid[2][1] + grid[2][2]) / 2;
      var bottomRight = grid[2][2];
      var bottomMid = grid[2][1];
      if (leftCol >= 0.35) {
        var lScore = leftCol * 0.45 + bottomBar * 0.35 + (1 - topRight) * 0.20;
        var rScore = leftCol * 0.35 + topRight * 0.45 + bottomRight * 0.20;
        // Hole evidence: a single hole confined to the TOP half is R's bowl —
        // strong evidence. A hole reaching into the bottom third means a closed
        // digit (0/O/6), which is never a direction marker.
        var holeBox = holes === 1 ? holeInfo.boxes[0] : null;
        var holeIsTopBowl = !!holeBox && (holeBox.y1 / Math.max(1, h - 1)) <= 0.65;
        if (holes === 1 && !holeIsTopBowl) return { glyph: "", score: 0, grid: grid, holes: holes };
        if (holes === 1) rScore += 0.15; else rScore -= 0.10; // closed bowl is strong R evidence
        if (holes === 0 && topRight <= 0.22 && bottomBar >= 0.3 && lScore >= rScore) {
          return { glyph: "L", score: Math.min(1, lScore), grid: grid, holes: holes };
        }
        if (topRight >= 0.30 && bottomMid <= 0.5 && rScore > lScore) {
          return { glyph: "R", score: Math.min(1, rScore), grid: grid, holes: holes };
        }
      }
    }
    return { glyph: "", score: 0, grid: grid, holes: holes };
  }

  function markerGlyphToDirection(glyph) {
    var g = String(glyph || "");
    if (g === "L" || g === "-") return "L";
    if (g === "R" || g === "+") return "R";
    return "";
  }

  // Partition a direction cell's components into the VALUE cluster (the number —
  // the group with the most ink) and MARKER candidates (glyph-sized components
  // outside it). This is the "blanking": everything in the value cluster is
  // removed from consideration before classification.
  function partitionDirectionCell(components, opts) {
    opts = opts || {};
    var comps = (Array.isArray(components) ? components : []).filter(function (c) {
      return c && Number.isFinite(Number(c.x0)) && Number.isFinite(Number(c.x1));
    });
    if (!comps.length) return { valueBox: null, markerComponents: [] };
    var charHeight = Number(opts.charHeight) ||
      median(comps.map(function (c) { return Number(c.y1) - Number(c.y0); }).filter(function (v) { return v > 0; })) || 16;
    var groups = groupComponentsIntoValues(comps, { charHeight: charHeight });
    if (!groups.length) return { valueBox: null, markerComponents: [] };
    var valueGroup = groups.reduce(function (best, g) { return (Number(g.ink) || 0) > (Number(best.ink) || 0) ? g : best; }, groups[0]);
    var valueH = Math.max(1, Number(valueGroup.y1) - Number(valueGroup.y0));
    var markerComponents = comps.filter(function (c) {
      // outside the value cluster's box (with a small pad)…
      var pad = Math.max(1, charHeight * 0.12);
      var insideValue = Number(c.x0) >= Number(valueGroup.x0) - pad && Number(c.x1) <= Number(valueGroup.x1) + pad;
      if (insideValue) return false;
      // …and plausibly a marker glyph, not dust or a table artefact. Letters
      // (L/R/+) are digit-sized; a '-' dash is much FLATTER than a digit but
      // clearly wide, so wide-flat components stay in.
      var ch = Number(c.y1) - Number(c.y0), cw = Number(c.x1) - Number(c.x0);
      var letterSized = ch >= valueH * 0.3;
      var dashShaped = cw >= valueH * 0.35 && ch >= Math.max(1, valueH * 0.06) && cw / Math.max(1, ch) >= 1.7;
      if (!letterSized && !dashShaped) return false;
      if (ch > valueH * 1.5) return false;
      if (cw > charHeight * 1.8) return false;
      if ((Number(c.area) || (cw * ch)) < 6) return false;
      return true;
    });
    return { valueBox: valueGroup, markerComponents: markerComponents, charHeight: charHeight };
  }

  // Full deep-scan analysis of one direction cell: blank the value, classify the
  // remainder. Returns everything the caller (and the debug window) needs:
  //   { direction, glyph, score, valueBox, candidates:[{box, glyph, score, grid}] }
  // direction is "" when nothing classifies confidently — the caller decides the
  // fallback, this function never guesses.
  function deepScanDirectionCell(maskObj, components, opts) {
    opts = opts || {};
    var minScore = Number.isFinite(Number(opts.minScore)) ? Number(opts.minScore) : 0.55;
    var parts = partitionDirectionCell(components, opts);
    var out = { direction: "", glyph: "", score: 0, valueBox: parts.valueBox || null, candidates: [] };
    if (!parts.valueBox || !parts.markerComponents.length || !maskObj) return out;
    parts.markerComponents.forEach(function (c) {
      var crop = cropMask(maskObj, Number(c.x0), Number(c.y0), Number(c.x1), Number(c.y1));
      var cls = classifyGlyphMask(crop);
      out.candidates.push({ box: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }, glyph: cls.glyph, score: cls.score, grid: cls.grid });
    });
    out.candidates.sort(function (a, b) { return Number(b.score) - Number(a.score); });
    var best = out.candidates[0];
    if (best && best.glyph && Number(best.score) >= minScore) {
      out.glyph = best.glyph;
      out.score = Number(best.score);
      out.direction = markerGlyphToDirection(best.glyph);
    }
    return out;
  }

  var api = {
    splitColumns: splitColumns,
    allocateHeaders: allocateHeaders,
    trimUnresolvedEdges: trimUnresolvedEdges,
    stripBoundaries: stripBoundaries,
    parseCell: parseCell,
    numberBoxesFromWords: numberBoxesFromWords,
    headerTextForColumns: headerTextForColumns,
    clusterValueRows: clusterValueRows,
    isSummaryLabel: isSummaryLabel,
    groupComponentsIntoValues: groupComponentsIntoValues,
    deepScanDirectionCell: deepScanDirectionCell,
    _internals: {
      median: median, trackClusters: trackClusters, clearanceConfig: clearanceConfig,
      mergeIntervals: mergeIntervals, clearanceRows: clearanceRows, corridorBands: corridorBands,
      pruneCuts: pruneCuts, outlierSplitCuts: outlierSplitCuts, columnsFromCuts: columnsFromCuts,
      valueGapThreshold: valueGapThreshold, positionalDefuse: positionalDefuse,
      resolveMetricKey: resolveMetricKey, parseNumber: parseNumber,
      metricPlausible: metricPlausible, directionFromText: directionFromText,
      needsDirection: needsDirection, looksLikeValue: looksLikeValue,
      cropMask: cropMask, glyphFillGrid: glyphFillGrid, classifyGlyphMask: classifyGlyphMask, countMaskHoles: countMaskHoles,
      partitionDirectionCell: partitionDirectionCell, markerGlyphToDirection: markerGlyphToDirection
    }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.ClarityTableOcr = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
