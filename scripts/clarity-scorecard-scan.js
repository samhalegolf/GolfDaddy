/*
 * Clarity Scorecard Scan — the processor.
 *
 * The scorecard counterpart of gdClarityTableOcrScanFromCheckpoint. Same shape
 * as the practice-photo scan and the same stage-by-stage honesty, with the one
 * step the practice scanner leans on removed:
 *
 *   NO MANUAL CORNER STRETCH. The practice scanner reopens "drag the four pins
 *   onto the value-grid corners" whenever a stage is unhappy — the column split
 *   found too few columns, the headers would not resolve, the flat image was
 *   missing. Every one of those bounces is gone. This runs start to finish on
 *   the image it is given and, if it cannot read the card, says which stage
 *   stopped it and what it saw. Framing the photo is the caller's problem; if a
 *   caller has a flattener it passes the flattened image in, and nothing in here
 *   knows or cares.
 *
 * STAGES
 *   1  boxes     pixels -> value boxes (geometry first, OCR second)
 *   2  read      one small crop per box, through the injected recognizer
 *   3  columns   number-like boxes -> hole columns (ported corridor split)
 *   4  strips    row bands -> one strip per printed row, cut and labelled
 *   5  identify  each strip classified BY ITS VALUES: holes / par / index / tee
 *   6  grids     strips -> grids of strings for gd-scorecard-parse-core
 *
 * Stage 6 is the handover. `parseScorecardCards(grids)` turns those into
 * [{name, holes:[{hole, par, distanceM}]}] — the same function, and the same
 * card shape, that the club-website path produces. The photo lane does not get
 * its own resolver, its own row shape, or its own storage table; that split is
 * what left two practice pipelines in the app and only one of them consumed.
 *
 * THE RECOGNIZER IS INJECTED
 *   recognize(image, {whitelist, psm, tag}) -> Promise<string>
 * `image` is whatever ClarityScorecardOcrPixels.toRenderable returns: a canvas
 * in a browser, a raw pixel buffer under node. Keeping OCR out of this file is
 * what lets the whole pipeline be tested headlessly, which the practice reader
 * could never do past its geometry.
 */
(function (global) {
  "use strict";
  var OCR = global.ClarityScorecardOcr || (typeof require === "function" ? require("./clarity-scorecard-ocr.js") : null);
  var PIX = global.ClarityScorecardOcrPixels || (typeof require === "function" ? require("./clarity-scorecard-ocr-pixels.js") : null);

  /* Letters are allowed in the VALUE pass on purpose. Restricting it to digits
   * would make Tesseract render OUT as some three-digit number, and a totals
   * heading that reads as a hole number puts every value on the card one column
   * out. Letting a word come back as a word is how `readInteger` gets to reject
   * it. */
  var CELL_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,-/ ";
  var LABEL_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'&/+-. ";

  function noop() {}

  function fail(stage, message, detail) {
    return { ok: false, stage: stage, error: message, detail: detail || null, grids: [], strips: [], columns: [] };
  }

  /* One box -> one string.
   *
   * Binarised, upscaled and padded, exactly as the practice reader does it, then
   * a second attempt on the untouched pixels when the first produced nothing:
   * a hard ink threshold can erase strokes under glare, and the raw crop
   * sometimes recovers precisely those cells. */
  async function readBox(image, box, recognize, opts) {
    var pad = Number(opts.boxPad) || 3;
    var raw = PIX.cropImage(image, box.x0 - pad, box.y0 - pad, box.x1 + pad, box.y1 + pad, 0);
    var scale = Number(opts.upscale) || 3;
    var prepared = PIX.padImage(PIX.binarizeImage(PIX.upscaleImage(raw, scale)), 12);
    var text = await recognize(PIX.toRenderable(prepared), { whitelist: opts.whitelist || null, psm: "7", tag: "scorecard-box" });
    text = String(text == null ? "" : text).trim();
    if (!text) {
      var fallback = PIX.padImage(PIX.upscaleImage(raw, scale), 12);
      text = String(await recognize(PIX.toRenderable(fallback), { whitelist: opts.whitelist || null, psm: "7", tag: "scorecard-box-raw" }) || "").trim();
    }
    return text;
  }

  /* The label strip: everything LEFT of the first hole column.
   *
   * Read as one image per row band rather than one pass down the whole margin.
   * The practice reader learned this the hard way in the other direction — its
   * per-row cutting misread 7i as 2i and was replaced by a single whole-offcut
   * read — but a scorecard's margin is the opposite case: every band holds a
   * DIFFERENT label, and which band a word sits in is the entire meaning. So the
   * cut is per band, and a band that reads as nothing simply has no label, which
   * costs a tee its name and nothing else. */
  async function readStripLabels(image, bands, marginRight, recognize) {
    var width = Math.floor(Number(marginRight) || 0);
    if (width < 12) return bands.map(function () { return ""; });
    var out = [];
    for (var i = 0; i < bands.length; i += 1) {
      var band = bands[i];
      var crop = PIX.cropImage(image, 0, band.top, width, band.bottom, 0);
      var prepared = PIX.padImage(PIX.upscaleImage(crop, 2), 10);
      var text = "";
      try {
        text = String(await recognize(PIX.toRenderable(prepared), { whitelist: LABEL_WHITELIST, psm: "7", tag: "scorecard-label" }) || "").trim();
      } catch (error) { text = ""; }
      out.push(text);
    }
    return out;
  }

  /**
   * Read a scorecard photo.
   *
   * @param {Object} image   {width, height, data} pixels, or a canvas/img in a browser
   * @param {Object} options
   *   recognize   async (image, {whitelist, psm, tag}) -> text          REQUIRED
   *   onStage     (name, info) -> void        progress, for a UI or a log
   *   name        card name to use for the first card
   *   minHoles    fewest hole columns worth reporting a card for (default 6)
   * @returns {Promise<Object>} { ok, grids, strips, columns, bands, unit, diagnostics }
   */
  async function scanScorecard(image, options) {
    var opts = options || {};
    var recognize = typeof opts.recognize === "function" ? opts.recognize : null;
    var onStage = typeof opts.onStage === "function" ? opts.onStage : noop;
    var minHoles = Number.isFinite(Number(opts.minHoles)) ? Number(opts.minHoles) : 6;
    if (!OCR || !PIX) return fail("load", "Clarity Scorecard OCR module is not loaded");
    if (!recognize) return fail("load", "scanScorecard needs a recognize(image, opts) function");
    if (!image || !Number.isFinite(Number(image.width))) return fail("load", "no image to scan");

    // ---- Stage 1: boxes ---------------------------------------------------
    var detected = PIX.detectNumberBoxes(image, { polarity: opts.polarity });
    onStage("boxes", { boxes: detected.boxes.length, components: detected.components.length, rows: detected.rows.length });
    if (detected.boxes.length < minHoles * 2) {
      return fail("boxes", "Found " + detected.boxes.length + " value boxes — not enough ink to be a scorecard table.", detected.boxes.length);
    }

    // ---- Stage 2: read every box -----------------------------------------
    var read = [];
    for (var i = 0; i < detected.boxes.length; i += 1) {
      var box = detected.boxes[i];
      var text = await readBox(image, box, recognize, { whitelist: opts.whitelist || CELL_WHITELIST, upscale: opts.upscale, boxPad: opts.boxPad });
      read.push(Object.assign({}, box, { text: text, n: OCR.readInteger(text) }));
      if (i % 12 === 0) onStage("read", { done: i + 1, total: detected.boxes.length });
    }
    var numberBoxes = read.filter(function (b) { return b.n !== null; });
    var textBoxes = read.filter(function (b) { return b.n === null && b.text; });
    onStage("read", { done: read.length, total: read.length, numbers: numberBoxes.length, words: textBoxes.length });
    if (numberBoxes.length < minHoles * 2) {
      return fail("read", "Only " + numberBoxes.length + " of " + read.length + " boxes read as numbers.", numberBoxes.length);
    }

    // ---- Stage 3: columns -------------------------------------------------
    // Number-like only, so a tee name or an OUT heading can never bend the
    // column geometry.
    var columns = OCR.splitColumns(numberBoxes, { sourceWidth: image.width, debug: !!opts.debug });
    onStage("columns", { columns: columns.length });
    if (columns.length < minHoles) {
      return fail("columns", "Column split found " + columns.length + " columns; a card needs at least " + minHoles + ".", columns.length);
    }

    // ---- Stage 4: strips --------------------------------------------------
    var rows = OCR.clusterValueRows(numberBoxes);
    var bands = OCR.bandBoundaries(rows, image.height);
    // The label margin is everything left of the first column. `trimOuterMargins`
    // has already pulled that boundary in off x=0 to the first column's own
    // values, so what is left really is the margin and nothing else.
    var marginRight = Math.max(0, Number(columns[0].left));
    var labels = await readStripLabels(image, bands, marginRight, recognize);
    onStage("strips", { strips: bands.length, marginWidth: Math.round(marginRight) });

    // ---- Stage 5: identify ------------------------------------------------
    // Assign each read number to (strip, column) by geometry, then let the
    // strip's own values say what it is. Nothing depends on `labels` being right.
    var strips = bands.map(function (band, index) {
      var values = [];
      columns.forEach(function (column, ci) {
        var hits = numberBoxes.filter(function (b) {
          return Number(b.cy) >= band.top && Number(b.cy) <= band.bottom &&
                 Number(b.cx) > Number(column.left) && Number(b.cx) <= Number(column.right);
        });
        if (!hits.length) return;
        // More than one read in a cell means the split put two values in one
        // column. Keep the one nearest the column centre and record the clash.
        hits.sort(function (a, b) { return Math.abs(a.cx - column.cx) - Math.abs(b.cx - column.cx); });
        values.push({ column: ci, n: hits[0].n, text: hits[0].text, box: hits[0], collisions: hits.length - 1 });
      });
      var classified = OCR.classifyStrip(values, { minRun: minHoles });
      return {
        index: index, top: band.top, bottom: band.bottom, cy: band.cy,
        label: labels[index] || "", values: values,
        kind: classified.kind, reason: classified.reason
      };
    });
    // Second pass, scoped to the hole columns. Out / In / Total are columns like
    // any other at this point, and a 3433 sitting in one of them is enough to
    // push a tee row out of every plausible distance range and leave it
    // unidentified. Which columns are holes is only known once a hole strip has
    // been found, so the rescope has to happen after the first pass, not during
    // it. The hole strip itself needs no rescoping: a totals heading is a word,
    // so it never produced a number up there in the first place.
    var holeColumns = null;
    strips.forEach(function (strip) {
      if (strip.kind === "holes") {
        holeColumns = strip.values.map(function (v) { return v.column; });
        strip.scoped = strip.values.length;
        return;
      }
      if (!holeColumns) return;
      var scoped = strip.values.filter(function (v) { return holeColumns.indexOf(v.column) >= 0; });
      var rescoped = OCR.classifyStrip(scoped, { minRun: minHoles });
      strip.kind = rescoped.kind;
      strip.reason = rescoped.reason + " (over " + scoped.length + " hole columns)";
      strip.scoped = scoped.length;
    });
    var holeStrips = strips.filter(function (s) { return s.kind === "holes"; });
    onStage("identify", {
      strips: strips.map(function (s) { return (s.kind || "?") + "[" + s.values.length + "]" + (s.label ? " " + s.label : ""); }),
      holes: holeStrips.length,
      par: strips.filter(function (s) { return s.kind === "par"; }).length,
      distance: strips.filter(function (s) { return s.kind === "distance"; }).length
    });
    if (!holeStrips.length) {
      return fail("identify",
        "No strip reads as a row of hole numbers, so there is nothing to hang par and distances on.",
        strips.map(function (s) { return (s.label || "row " + s.index) + ": " + (s.kind || "unidentified") + " — " + s.reason; }));
    }

    // ---- Stage 6: grids for the resolver ----------------------------------
    var unit = null;
    strips.forEach(function (s) { unit = unit || OCR.unitFromText(s.label); });
    var grids = OCR.buildGrids(strips, { name: opts.name || "" });
    onStage("grids", { grids: grids.length, unit: unit });

    return {
      ok: true, stage: "grids", error: "",
      grids: grids, unit: unit,
      strips: strips, columns: columns, bands: bands,
      boxes: read,
      diagnostics: {
        boxes: read.length, numbers: numberBoxes.length, words: textBoxes.length,
        columns: columns.length, strips: strips.length,
        kinds: strips.map(function (s) { return s.kind || ""; }),
        labels: strips.map(function (s) { return s.label || ""; }),
        marginWidth: Math.round(marginRight)
      }
    };
  }

  var api = { scanScorecard: scanScorecard, CELL_WHITELIST: CELL_WHITELIST, LABEL_WHITELIST: LABEL_WHITELIST };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.ClarityScorecardScan = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
