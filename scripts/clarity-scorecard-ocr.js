/*
 * Clarity Scorecard OCR — standalone, DOM-agnostic scorecard reader.
 *
 * A copy of the practice-shot photo processor (`clarity-table-ocr.js`), adapted
 * to read a photo of a golf SCORECARD. It is a copy on purpose: the launch
 * monitor reader is proven on its own image and must not drift because a
 * scorecard needed a different rule.
 *
 * WHAT CHANGED FROM THE PRACTICE READER
 *
 * 1. No manual corner-stretch step. The practice scanner bounces back to a
 *    "drag the four pins" tool whenever a stage is unhappy. This one never asks
 *    the user to move a line: it either reads the card or reports why it could
 *    not. Framing is the caller's business, not a stage in here.
 * 2. Strips are ROWS, not columns. A card lays holes out ACROSS the page and
 *    labels each row down the side (Hole / Par / Index / Championship / White),
 *    which is the transpose of a launch-monitor table.
 * 3. Strips are identified by their VALUES, not by a header alias registry.
 *    A row of six or more ascending small integers is the hole row; a row of
 *    3-6s is par; a row of distinct 1-18s is the stroke index; a row of
 *    three-digit numbers is a tee. No header text has to be read correctly for
 *    any of that to work, which is the single biggest source of failure in the
 *    practice reader (LAUNEH ANGLE).
 * 4. Output is a GRID OF STRINGS, not shot rows. `gd-scorecard-parse-core.mjs`
 *    already turns a grid into `[{hole, par, distanceM}]` for the geometry
 *    resolver, and it is the same code the HTML path uses. Emitting a grid means
 *    a photo and a club website arrive at the resolver through one parser.
 *
 * WHAT STAYED
 *
 * The geometry. `groupComponentsIntoValues` / `splitColumns` / `clusterValueRows`
 * / `stripBoundaries` are ported verbatim from the practice reader — corridor
 * clearance split, outlier re-split and positional de-fuse included. That is the
 * part that took the longest to get right and it is orientation-agnostic.
 *
 * Runs in Node (module.exports) and the browser (global ClarityScorecardOcr).
 */
(function (global) {
  "use strict";

  // =========================================================================
  // PORTED GEOMETRY — identical to clarity-table-ocr.js. Do not "improve" here
  // without changing it there; divergence between the two is the bug this file
  // is copied to avoid.
  // =========================================================================

  function median(values) {
    var nums = (Array.isArray(values) ? values : [])
      .map(Number)
      .filter(Number.isFinite)
      .sort(function (a, b) { return a - b; });
    if (!nums.length) return NaN;
    var mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  }

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

  function valueGapThreshold(gaps, charHeight) {
    var g = (Array.isArray(gaps) ? gaps : []).filter(function (v) { return Number.isFinite(v) && v >= 0; }).slice().sort(function (a, b) { return a - b; });
    var floor = Math.max(4, charHeight * 0.28);
    var ceil = Math.max(floor + 1, charHeight * 0.95);
    if (g.length < 2) return floor;
    var jumpMin = Math.max(3, charHeight * 0.22);
    var intraCeil = charHeight * 0.5;
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

  function clearanceConfig(boxes, sourceWidth) {
    sourceWidth = sourceWidth || 0;
    var widths = (Array.isArray(boxes) ? boxes : []).map(function (b) { return Number(b.w); }).filter(function (v) { return Number.isFinite(v) && v > 0; });
    var medianWidth = median(widths) || 36;
    var sourceMax = Number(sourceWidth) || Math.max.apply(null, [0].concat((Array.isArray(boxes) ? boxes : []).map(function (b) { return Number(b.x1) || 0; })));
    var sourceLimit = sourceMax ? sourceMax * 0.018 : 28;
    var corridorWidth = Math.max(12, Math.min(28, sourceLimit || 28, medianWidth * 0.38));
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
        console.debug("[ClarityScorecardOcr] outlier re-split", {
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

  /* Pull the outer column boundaries in to the values they actually contain.
   *
   * `columnsFromCuts` runs its first boundary from x=0 and its last to the image
   * edge, so on a scorecard the leftmost column swallows the whole label margin
   * — every row's tee name included. Two things then go wrong: `positionalDefuse`
   * sees an anomalously wide first column and chops the margin into phantom
   * sub-columns, and the caller has no margin left to read the tee names off.
   * Neither happens to the launch-monitor reader, whose margin is one narrow club
   * label it reads by a different route.
   *
   * The air a value has on one side is the air it has on the other — values sit
   * centred in their cell — so the far side's slack is the right amount to keep.
   * Values are never moved, only the empty boundary is. */
  function trimOuterMargins(columns) {
    var list = (Array.isArray(columns) ? columns : []).slice();
    if (list.length < 2) return list;
    function tightened(col, side) {
      var left = Number(col.left), right = Number(col.right);
      var x0 = Number(col.x0), x1 = Number(col.x1);
      if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return col;
      var next;
      if (side === "left") {
        var rightAir = Math.max(0, right - x1);
        next = Math.max(left, x0 - rightAir);
        if (next <= left) return col;
        return Object.assign({}, col, { left: next, dividerLeft: next, cx: (next + right) / 2 });
      }
      var leftAir = Math.max(0, x0 - left);
      next = Math.min(right, x1 + leftAir);
      if (next >= right) return col;
      return Object.assign({}, col, { right: next, dividerRight: next, cx: (left + next) / 2 });
    }
    list[0] = tightened(list[0], "left");
    list[list.length - 1] = tightened(list[list.length - 1], "right");
    return list;
  }

  /**
   * Split a flat card into value columns from number-box geometry.
   * On a scorecard these are the HOLE columns (plus any Out / In / Total).
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
    columns = trimOuterMargins(columns);
    columns = positionalDefuse(columns);
    return reindex(columns);
  }

  // Cluster value boxes into row bands by vertical centre. On a scorecard each
  // band is one STRIP: Hole, Par, Index, or a tee's distances.
  function clusterValueRows(boxes) {
    var tracks = trackClusters(boxes, "y").filter(function (c) { return c.items.length >= 2; });
    return tracks.map(function (t) { return { cy: t.cy, y0: t.y0, y1: t.y1, items: t.items }; })
      .sort(function (a, b) { return a.cy - b.cy; });
  }

  // Column x-boundaries for cutting per-column images (kept for debug montages).
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
        cx: (left + right) / 2
      };
    });
  }

  // Row y-boundaries — the scorecard's own unit of cutting. Midpoint boundaries
  // between neighbouring bands so a strip carries its whole row of digits and
  // nothing of the row above or below.
  function bandBoundaries(rows, sourceHeight) {
    var list = (Array.isArray(rows) ? rows : []).slice().sort(function (a, b) { return Number(a.cy) - Number(b.cy); });
    if (!list.length) return [];
    var H = Number(sourceHeight) || 0;
    return list.map(function (r, i) {
      var previous = list[i - 1];
      var next = list[i + 1];
      var pad = Math.max(3, (Number(r.y1) - Number(r.y0)) * 0.35);
      var top = previous ? (Number(previous.y1) + Number(r.y0)) / 2 : Number(r.y0) - pad;
      var bottom = next ? (Number(r.y1) + Number(next.y0)) / 2 : Number(r.y1) + pad;
      return {
        index: i,
        top: Math.max(0, Math.round(top)),
        bottom: Math.round(H ? Math.min(H, bottom) : bottom),
        y0: Number(r.y0), y1: Number(r.y1), cy: Number(r.cy),
        items: Array.isArray(r.items) ? r.items : []
      };
    });
  }

  // =========================================================================
  // SCORECARD SEMANTICS — replaces the launch-monitor metric registry.
  //
  // Nothing here reads a header. A strip is identified by the numbers on it,
  // which is the only thing about a scorecard that every club agrees on.
  // =========================================================================

  // Column headings that are totals, not holes. Same list the HTML parser uses.
  var TOTAL_HEADING = /^(out|in|tot|total|front|back|f9|b9|sub|subtotal)$/i;
  // Labels the grid parser would throw away if we passed them through verbatim.
  var UNUSABLE_LABEL = /^(hole|holes|#|tee|tees|yards?|yds?|met(er|re)s?|rating|slope|score|putts|blank)$/i;
  var PAR_LABEL = /^(par|par m|par w|mens? par|womens? par)$/i;
  var INDEX_LABEL = /^(h(an)?di?(cap)?\.*|index|s\.?i\.?|stroke( index)?|hcp)\.*$/i;

  // OCR digit confusions, applied only when the surrounding text is otherwise
  // numeric. Deliberately narrow: turning every O into a 0 everywhere would
  // make "OUT" read as "0UT" and put a totals column on the hole row.
  var DIGIT_LOOKALIKES = { O: "0", o: "0", D: "0", Q: "0", I: "1", l: "1", "|": "1", i: "1", Z: "2", z: "2", S: "5", s: "5", B: "8", G: "6", g: "9", T: "7" };

  function cleanText(value) {
    return String(value == null ? "" : value).replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
  }

  /* An integer, from an OCR read of a scorecard cell.
   *
   * Returns null rather than guessing. A cell that is mostly letters is a label
   * or a totals heading, not a number, and forcing it to one is how "OUT" ends
   * up as hole 0. Only a token that is already majority-digit gets its
   * lookalikes corrected. */
  function readInteger(text) {
    var raw = cleanText(text).replace(/[.,](?=\d{3}\b)/g, "");
    if (!raw) return null;
    var token = raw.split(" ").filter(function (t) { return /\d/.test(t); })[0] || raw;
    if (TOTAL_HEADING.test(token)) return null;
    var digits = (token.match(/\d/g) || []).length;
    var glyphs = token.replace(/[^0-9A-Za-z|]/g, "").length;
    if (!digits || digits * 2 < glyphs) return null;
    var fixed = token.replace(/[A-Za-z|]/g, function (ch) { return DIGIT_LOOKALIKES[ch] || " "; });
    var cleaned = fixed.replace(/[^0-9]/g, "");
    if (!cleaned || cleaned.length > 4) return null;
    var n = parseInt(cleaned, 10);
    return Number.isFinite(n) ? n : null;
  }

  // A read that is a plausible cell value at all — the filter applied BEFORE the
  // column split, so labels and tee names can never distort column geometry.
  function looksLikeValue(text) {
    return readInteger(text) !== null;
  }

  /* What a strip of numbers IS.
   *
   * Ordered most-specific first, because the ranges overlap: par values are
   * inside the stroke-index range, and hole numbers are inside both. The order
   * is the classification.
   *
   *   holes     ascending small integers, 1..27      -> the header row
   *   par       every value 3..6                     -> par
   *   index     distinct values 1..27, not ascending -> stroke index, ignored
   *   distance  everything else in 30..800           -> a tee set
   *
   * `values` is [{column, n}] in column order. Totals columns must already be
   * excluded by the caller: an Out of 36 in a par row is fine, but 3433 in a
   * distance row would drag the median. */
  function classifyStrip(values, opts) {
    opts = opts || {};
    var list = (Array.isArray(values) ? values : []).filter(function (v) { return v && Number.isFinite(Number(v.n)); });
    var minRun = Number.isFinite(Number(opts.minRun)) ? Number(opts.minRun) : 6;
    var out = { kind: "", count: list.length, reason: "" };
    if (list.length < minRun) { out.reason = "only " + list.length + " values (need " + minRun + ")"; return out; }
    var ns = list.map(function (v) { return Number(v.n); });
    var ascending = ns.every(function (n, i) { return i === 0 || n > ns[i - 1]; });
    var maxN = Math.max.apply(null, ns);
    var minN = Math.min.apply(null, ns);
    var distinct = new Set(ns).size === ns.length;

    /* Hole numbers are the only row on a card that COUNTS: consecutive, not
       merely ascending. Requiring it to start at 1 instead would classify the
       10-18 row of a card printed in two halves as a stroke index, because 10 is
       not 1 — and a stroke index is exactly what a set of ascending distinct
       small integers looks like otherwise. Consecutiveness separates them and
       does not care where the row starts. A blanked cell costs one step, hence
       the tolerance rather than a demand that every step be 1. */
    var steps = ns.slice(1).map(function (n, i) { return n - ns[i]; });
    var byOne = steps.filter(function (d) { return d === 1; }).length;
    if (ascending && minN >= 1 && maxN <= 27 && steps.length && byOne >= steps.length * 0.8) {
      out.kind = "holes"; out.reason = "counts " + ns[0] + ".." + maxN + " (" + byOne + "/" + steps.length + " steps of 1)";
      return out;
    }
    if (ns.every(function (n) { return n >= 3 && n <= 6; })) { out.kind = "par"; out.reason = "all 3-6"; return out; }
    if (distinct && minN >= 1 && maxN <= 27) { out.kind = "index"; out.reason = "distinct 1-" + maxN + ", not ascending"; return out; }
    var mid = median(ns);
    if (minN >= 30 && maxN <= 800 && mid >= 70) { out.kind = "distance"; out.reason = "median " + Math.round(mid); return out; }
    out.reason = "no rule matched (" + minN + ".." + maxN + ")";
    return out;
  }

  /* The label a strip should carry into the grid.
   *
   * The read label is used when it is usable — a tee name ("Championship",
   * "White") is worth keeping because it lands in the card's teeOptions. When it
   * is missing, garbled, or one of the words the grid parser drops, the strip's
   * CLASSIFICATION supplies the label instead. That is the whole point of
   * classifying by value: the card still parses when every word on it is
   * unreadable. */
  function labelForStrip(kind, readLabel, teeOrdinal) {
    var text = cleanText(readLabel).replace(/[^A-Za-z0-9 '&/+-]/g, "").trim();
    if (kind === "holes") return "Hole";
    if (kind === "par") return "Par";
    if (kind === "index") return "Index";
    if (kind === "distance") {
      var usable = text && text.length >= 3 && /[A-Za-z]{3}/.test(text) &&
        !UNUSABLE_LABEL.test(text) && !PAR_LABEL.test(text) && !INDEX_LABEL.test(text) &&
        !/^\d+$/.test(text);
      return usable ? text : ("Tee " + (Number(teeOrdinal) || 1));
    }
    return text || "";
  }

  /* Units, from whatever words the card carried.
   *
   * Only ever returns what was actually READ. When nothing says, the answer is
   * null and `toMetres` in the parse core falls back to its magnitude test,
   * which is the honest order: a stated unit beats a guessed one, a guessed one
   * beats nothing. */
  function unitFromText(text) {
    var raw = cleanText(text).toLowerCase();
    if (/\b(yards?|yds?|yardage)\b/.test(raw)) return "yards";
    if (/\b(met(er|re)s?|mtrs?)\b/.test(raw)) return "metres";
    return null;
  }

  /* Strips -> grids, ready for gd-scorecard-parse-core.
   *
   * A grid is rows of strings with the label in column 0 and one column per
   * detected column, which is exactly the shape the HTML path produces. Columns
   * the hole strip gave no number for (Out, In, Total, and any column that was
   * simply unreadable up there) get an empty heading, so `findHoleColumns`
   * ignores them and their values go nowhere.
   *
   * CARD BOUNDARIES. A hole strip opens a card. A second hole strip either
   * continues it (holes 10-18 under holes 1-9 — a card printed in two halves) or
   * starts a new one (holes 1-18 again — two courses on one page). The test is
   * overlap, not position: the front/back split is the only case where a second
   * hole row is part of the same card, and it is exactly the case where the hole
   * numbers do not collide. Getting this wrong merges Te Arai North and South
   * into one 36-hole nonsense, which is why it is decided here rather than left
   * to the caller. */
  function buildGrids(strips, opts) {
    opts = opts || {};
    var list = (Array.isArray(strips) ? strips : []).slice().sort(function (a, b) { return Number(a.cy) - Number(b.cy); });
    var blocks = [];
    var block = null;
    var cardIndex = 0;

    list.forEach(function (strip) {
      if (!strip || !strip.kind) return;
      if (strip.kind === "holes") {
        var holes = strip.values.map(function (v) { return Number(v.n); });
        var overlaps = block && holes.some(function (h) { return block.holesSeen.indexOf(h) >= 0; });
        if (!block || overlaps) {
          cardIndex += 1;
          block = { cardIndex: cardIndex, continuation: false, holesSeen: [], strips: [] };
          blocks.push(block);
        } else {
          // Same card, second half: its own grid so the parse core's stacked
          // -block merge joins them by hole number instead of one grid carrying
          // two hole rows (which it reads as the end of the first block).
          block = { cardIndex: cardIndex, continuation: true, holesSeen: block.holesSeen.slice(), strips: [] };
          blocks.push(block);
        }
        holes.forEach(function (h) { if (block.holesSeen.indexOf(h) < 0) block.holesSeen.push(h); });
      }
      if (!block) return;   // strips above the first hole row belong to no card
      block.strips.push(strip);
    });

    return blocks.map(function (b) {
      var holeStrip = b.strips.filter(function (s) { return s.kind === "holes"; })[0];
      if (!holeStrip) return null;
      // Column order is the column order on the page; the grid keeps every
      // column so a value never shifts sideways, and unnamed ones are ignored.
      var columns = [];
      b.strips.forEach(function (s) {
        s.values.forEach(function (v) { if (columns.indexOf(v.column) < 0) columns.push(v.column); });
      });
      columns.sort(function (x, y) { return x - y; });
      var teeOrdinal = 0;
      var grid = [];
      b.strips.forEach(function (s) {
        if (s.kind === "distance") teeOrdinal += 1;
        var byColumn = {};
        s.values.forEach(function (v) { byColumn[v.column] = String(v.n); });
        var row = [labelForStrip(s.kind, s.label, teeOrdinal)];
        columns.forEach(function (c) { row.push(byColumn[c] == null ? "" : byColumn[c]); });
        grid.push(row);
      });
      // A continuation block carries no label so the parse core folds it into the
      // card above; a genuinely new card carries one so it does not.
      grid.label = b.continuation ? "" : (b.cardIndex === 1 && !opts.name ? "" : (opts.name || "Card " + b.cardIndex));
      grid.cardIndex = b.cardIndex;
      grid.continuation = b.continuation;
      grid.columns = columns;
      return grid;
    }).filter(Boolean);
  }

  var api = {
    // geometry (ported)
    splitColumns: splitColumns,
    trimOuterMargins: trimOuterMargins,
    clusterValueRows: clusterValueRows,
    stripBoundaries: stripBoundaries,
    bandBoundaries: bandBoundaries,
    groupComponentsIntoValues: groupComponentsIntoValues,
    // scorecard semantics
    readInteger: readInteger,
    looksLikeValue: looksLikeValue,
    classifyStrip: classifyStrip,
    labelForStrip: labelForStrip,
    unitFromText: unitFromText,
    buildGrids: buildGrids,
    isTotalHeading: function (text) { return TOTAL_HEADING.test(cleanText(text)); },
    _internals: {
      median: median, trackClusters: trackClusters, clearanceConfig: clearanceConfig,
      mergeIntervals: mergeIntervals, clearanceRows: clearanceRows, corridorBands: corridorBands,
      pruneCuts: pruneCuts, outlierSplitCuts: outlierSplitCuts, columnsFromCuts: columnsFromCuts,
      valueGapThreshold: valueGapThreshold, positionalDefuse: positionalDefuse, cleanText: cleanText
    }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.ClarityScorecardOcr = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
