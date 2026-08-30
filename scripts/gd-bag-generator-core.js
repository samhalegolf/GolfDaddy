/* Bag-generator model.
 *
 * A seven-iron carry is the only player measurement.  The inferred speed is
 * deliberately internal: it shapes the ladder but is never presented as a
 * launch-monitor reading.  This file is pure so its envelope can be tested
 * without the UI or localStorage.
 */
(function () {
  "use strict";
  var win = typeof window !== "undefined" ? window : globalThis;
  if (win.GDBagGenerator && win.GDBagGenerator.__owner === "GDBagGenerator") return;

  var STANDARD = [
    ["Driver", 10.5, "driver", 230], ["3W", 15, "fairway", 205], ["4H", 22, "hybrid", 180],
    ["4i", 24, "iron", 178], ["5i", 26, "iron", 170], ["6i", 28, "iron", 160], ["7i", 32, "iron", 155],
    ["8i", 36, "iron", 142], ["9i", 40, "iron", 130], ["PW", 45, "wedge", 115], ["GW", 50, "wedge", 98],
    ["SW", 55, "wedge", 82], ["LW", 59, "wedge", 66]
  ];
  var SPEED_POINTS = [[90, 23], [100, 24.5], [130, 29.5], [155, 33.5], [175, 37], [185, 38.5]];

  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
  function number(value, fallback) { var n = Number(value); return Number.isFinite(n) ? n : fallback; }
  function key(label) { return String(label || "").toLowerCase().replace(/\s+/g, ""); }
  function interpolate(points, x) {
    if (x <= points[0][0]) return points[0][1];
    for (var i = 1; i < points.length; i++) {
      if (x <= points[i][0]) {
        var a = points[i - 1], b = points[i], t = (x - a[0]) / (b[0] - a[0]);
        return a[1] + (b[1] - a[1]) * t;
      }
    }
    return points[points.length - 1][1];
  }
  function inferredSevenIronSpeed(carry) { return interpolate(SPEED_POINTS, clamp(number(carry, 155), 90, 185)); }

  function descriptor(label) {
    var name = String(label || "").trim() || "Club";
    var normal = key(name);
    var known = STANDARD.filter(function (entry) { return key(entry[0]) === normal; })[0];
    if (known) return { club: name, loft: known[1], headType: known[2], reference: known[3] };
    var headType = /driver|\b1w\b/.test(normal) ? "driver"
      : /\b(?:3|5|7|9)w\b|wood/.test(normal) ? "fairway"
      : /\d\s*h\b|\d+h\b|hybrid|rescue/.test(normal) ? "hybrid"
      : /\bpw\b|\bgw\b|\baw\b|\bsw\b|\blw\b|wedge/.test(normal) ? "wedge" : "iron";
    var match = normal.match(/(\d{1,2}(?:\.\d+)?)\s*(?:°|deg)?/);
    var loft = match ? Number(match[1]) : null;
    if (headType === "iron" && /\d\s*i\b|\d+i\b|iron/.test(normal)) {
      var iron = normal.match(/(\d+)\s*i/); if (iron) loft = 16 + Number(iron[1]) * 2;
    }
    var fallbackLoft = { driver: 10.5, fairway: 18, hybrid: 22, iron: 32, wedge: 52 }[headType];
    return { club: name, loft: loft == null ? fallbackLoft : clamp(loft, 8, 64), headType: headType, reference: null };
  }
  function referenceCarry(desc) {
    if (desc.reference) return desc.reference;
    /* A local, curved loft relationship.  This is intentionally not metres
       per degree: it interpolates the surrounding established club shapes. */
    var same = STANDARD.filter(function (entry) { return entry[2] === desc.headType; });
    if (same.length < 2) same = STANDARD.filter(function (entry) { return entry[2] === "iron" || entry[2] === "wedge"; });
    var points = same.map(function (entry) { return [entry[1], entry[3]]; }).sort(function (a, b) { return a[0] - b[0]; });
    var base = interpolate(points, desc.loft);
    var efficiency = { driver: 1.08, fairway: 1.025, hybrid: 1.01, iron: 1, wedge: 0.97 }[desc.headType] || 1;
    return base * efficiency;
  }
  function gapFactor(headType, carry) {
    /* Carry position controls the speed-shaped gap.  The slow end deliberately
       compresses long clubs more than scoring clubs; normal players remain
       close to the existing 155 m ladder. */
    var x = clamp((carry - 155) / 65, -1, 0.46);
    var ends = {
      driver: [0.45, 1.30], fairway: [0.46, 1.27], hybrid: [0.56, 1.21],
      iron: [0.78, 1.11], wedge: [0.60, 1.42]
    }[headType] || [0.78, 1.11];
    return x < 0 ? 1 + x * (1 - ends[0]) : 1 + x * (ends[1] - 1);
  }
  function carryFor(desc, sevenCarry) {
    var reference = referenceCarry(desc);
    var gap = reference - 155;
    var estimate = sevenCarry + gap * gapFactor(desc.headType, sevenCarry);
    /* Short-game loft does not vanish just because the long-game speed is low.
       This low-speed guard is deliberately limited below 130 m, so it cannot
       disturb ordinary bags. */
    if (desc.headType === "wedge" && sevenCarry < 130) estimate = Math.max(estimate, sevenCarry - 55);
    return estimate;
  }
  function defaultLabels() { return STANDARD.map(function (entry) { return entry[0]; }); }
  function generate(sevenIronCarry, labels) {
    var seven = Math.round(clamp(number(sevenIronCarry, 155), 90, 185));
    var list = Array.isArray(labels) && labels.length ? labels : defaultLabels();
    var rows = list.map(function (label) {
      var desc = descriptor(label);
      return { club: desc.club, baseCarry: Math.max(20, Math.round(carryFor(desc, seven))), _desc: desc };
    });
    var sevenRow = rows.filter(function (row) { return /^7\s*i(?:ron)?$/i.test(row.club); })[0];
    if (sevenRow) sevenRow.baseCarry = seven; // player measurement always wins exactly
    /* Standard bags are emitted longest to shortest.  Guard the shape against
       rounding crossovers without changing the measured seven iron. */
    rows.sort(function (a, b) { return b.baseCarry - a.baseCarry; });
    for (var i = 1; i < rows.length; i++) rows[i].baseCarry = Math.min(rows[i].baseCarry, rows[i - 1].baseCarry - 1);
    return rows.map(function (row) { return { club: row.club, baseCarry: Math.max(20, row.baseCarry) }; });
  }
  function generateRest(existingRows, sevenIronCarry) {
    var existing = Array.isArray(existingRows) ? existingRows : [];
    var seven = number(sevenIronCarry, NaN);
    if (!(seven > 0)) {
      var row = existing.filter(function (item) { return /^7\s*i(?:ron)?$/i.test(String(item && (item.club || item.name) || "")); })[0];
      seven = number(row && (row.baseCarry != null ? row.baseCarry : row.carry), NaN);
    }
    if (!(seven > 0)) return { error: "Enter your 7-iron carry first", rows: existing.slice(), added: 0, retained: existing.length };
    var estimates = generate(seven);
    var present = new Set(existing.map(function (row) { return key(row && (row.club || row.name)); }));
    var additions = estimates.filter(function (row) { return !present.has(key(row.club)); });
    return { rows: existing.concat(additions), added: additions.length, retained: existing.length, sevenIronCarry: Math.round(seven) };
  }

  win.GDBagGenerator = { __owner: "GDBagGenerator", version: "20260830", descriptor: descriptor,
    inferSevenIronSpeed: inferredSevenIronSpeed, generate: generate, generateRest: generateRest, defaultLabels: defaultLabels };
})();
