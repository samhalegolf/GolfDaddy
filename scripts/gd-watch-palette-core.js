/* Watch map colour palette: one fixed palette, tinted per course.

   The palette fixes how LIGHT each surface is - that is what keeps rough, fairway, green,
   sand and water apart on a watch face, in sunlight, and on the 64-colour Garmin screens that
   dither everything else away. A course only gets to nudge each surface's HUE and a little of
   its CHROMA towards what its own turf, sand and water look like. So no course's tint can ever
   cost the map its legibility: the lightness steps below are the same on every course.

   Colours are handled in OKLab/OKLCH, where L tracks perceived lightness and hue moves without
   dragging lightness with it - in plain RGB "a bit more yellow" is also "a bit brighter".

   Measurements come from two places (functions/course-watch-maps.mjs gathers both):
     aerial    - the course's own published hole photos: sharp, true to the camera, one day.
     seasonal  - Sentinel-2, roughly monthly over the last two years: coarse (10m), but every
                 season. Kept per month so a seasonal palette can be built later; today the
                 year-round median is what tints the map.
   For turf the year carries twice the weight of the single aerial day; sand and water come
   from the aerial alone (a bunker is smaller than a Sentinel-2 pixel).

   Pure: no network, no pixels decoded here. Shared by the bake (Node) and Studio (browser). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GDWatchPaletteCore = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  /* Base palette and how far each role may be tinted.
     L is fixed. h is the base hue; the course pulls it `pull` of the way towards its measured
     hue, then it is clamped to [hueMin, hueMax] so turf always reads as grass, sand as sand and
     water as water. Chroma moves the same way inside [chromaMin, chromaMax]. */
  var ROLES = {
    rough:   { L: 0.42, C: 0.075, h: 145, hueMin: 125, hueMax: 160, chromaMin: 0.055, chromaMax: 0.095, pull: 0.5 },
    fairway: { L: 0.62, C: 0.13,  h: 145, hueMin: 125, hueMax: 160, chromaMin: 0.10,  chromaMax: 0.15,  pull: 0.5 },
    green:   { L: 0.80, C: 0.12,  h: 145, hueMin: 125, hueMax: 160, chromaMin: 0.09,  chromaMax: 0.14,  pull: 0.5 },
    bunker:  { L: 0.89, C: 0.06,  h: 92,  hueMin: 78,  hueMax: 105, chromaMin: 0.02,  chromaMax: 0.08,  pull: 0.6 },
    water:   { L: 0.51, C: 0.11,  h: 250, hueMin: 220, hueMax: 265, chromaMin: 0.06,  chromaMax: 0.13,  pull: 0.5 }
  };
  /* Never tinted: markers have to read the same everywhere. */
  var FIXED = { tee: "#f4f4f2", outline: "rgba(8,18,8,0.35)" };
  /* The smallest lightness step allowed between surfaces that sit next to each other. */
  var MIN_LIGHTNESS_GAP = 0.08;
  /* Turf: the year of satellite months outweighs the one aerial day. */
  var SEASONAL_WEIGHT = 2, AERIAL_WEIGHT = 1;
  /* Below this many accepted pixels a measurement is noise, not a course. */
  var MIN_SAMPLES = 60;

  // ------------------------------------------------------------------ colour maths

  function srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function linearToSrgb(x) { return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; }

  function rgbToOklab(r, g, b) {
    var lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
    var l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    var m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    var s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return {
      L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    };
  }

  /* Linear sRGB, unclamped - callers decide what out-of-gamut means. */
  function oklabToLinear(L, a, b) {
    var l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    var m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    var s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    ];
  }

  function lchToLab(L, C, h) { var r = h * Math.PI / 180; return { L: L, a: C * Math.cos(r), b: C * Math.sin(r) }; }
  function labToLch(lab) {
    var h = Math.atan2(lab.b, lab.a) * 180 / Math.PI;
    return { L: lab.L, C: Math.hypot(lab.a, lab.b), h: (h + 360) % 360 };
  }

  function inGamut(rgb) { return rgb.every(function (v) { return v >= -1e-4 && v <= 1 + 1e-4; }); }

  /* OKLCH to hex at EXACTLY this lightness: if the colour is outside sRGB, chroma gives way,
     never lightness - lightness is the one thing the palette promises. */
  function lchToHex(L, C, h) {
    var c = C;
    for (var i = 0; i < 40; i++) {
      var lab = lchToLab(L, c, h);
      var rgb = oklabToLinear(lab.L, lab.a, lab.b);
      if (inGamut(rgb) || c <= 0) {
        return "#" + rgb.map(function (v) {
          var n = Math.round(Math.max(0, Math.min(1, linearToSrgb(Math.max(0, v)))) * 255);
          return (n < 16 ? "0" : "") + n.toString(16);
        }).join("");
      }
      c = Math.max(0, c - 0.005);
    }
    return "#000000";
  }

  function hexToOklab(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return rgbToOklab((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function median(values) {
    if (!values.length) return null;
    var s = values.slice().sort(function (x, y) { return x - y; });
    var mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // ------------------------------------------------------------------ measuring

  /* Which pixels count as a surface. Generous on purpose - the median does the rest - but strict
     enough that a tree, a path or a roof cannot become "the course's turf". */
  var FILTERS = {
    turf: function (lch) { return lch.L > 0.25 && lch.L < 0.9 && lch.C > 0.025 && lch.h > 70 && lch.h < 175; },
    sand: function (lch) { return lch.L > 0.6 && lch.C < 0.12 && (lch.C < 0.03 || (lch.h > 40 && lch.h < 120)); },
    water: function (lch) { return lch.L > 0.15 && lch.L < 0.75 && lch.C > 0.02 && lch.h > 160 && lch.h < 290; }
  };
  var ROLE_FILTER = { rough: "turf", fairway: "turf", green: "turf", bunker: "sand", water: "water" };

  /* rgb: flat [r,g,b, r,g,b, ...] of 0-255. Returns the median colour of the pixels that pass
     the role's filter, in OKLab, with how many passed - or null when too few did. Rough also
     drops its darkest third: rough beside a fairway is where tree canopy and shade live. */
  function summariseSamples(rgb, role) {
    var filter = FILTERS[ROLE_FILTER[role]];
    if (!filter) throw new Error("unknown palette role " + role);
    var kept = [];
    for (var i = 0; i + 2 < rgb.length; i += 3) {
      var lab = rgbToOklab(rgb[i], rgb[i + 1], rgb[i + 2]);
      if (filter(labToLch(lab))) kept.push(lab);
    }
    if (role === "rough" && kept.length) {
      kept.sort(function (x, y) { return x.L - y.L; });
      kept = kept.slice(Math.floor(kept.length / 3));
    }
    if (kept.length < MIN_SAMPLES) return null;
    return {
      L: round(median(kept.map(function (p) { return p.L; }))),
      a: round(median(kept.map(function (p) { return p.a; }))),
      b: round(median(kept.map(function (p) { return p.b; }))),
      n: kept.length
    };
  }

  /* The year from the monthly Sentinel-2 record: median over MONTHS, not pixels, so a run of
     cloud-free summer scenes cannot outvote a winter that only cleared twice. */
  function seasonalYear(months, role) {
    var entries = Object.keys(months || {}).map(function (k) { return months[k] && months[k][role]; })
      .filter(function (m) { return m && Number.isFinite(m.a) && Number.isFinite(m.b); });
    if (!entries.length) return null;
    return {
      L: round(median(entries.map(function (m) { return m.L; }))),
      a: round(median(entries.map(function (m) { return m.a; }))),
      b: round(median(entries.map(function (m) { return m.b; }))),
      months: entries.length
    };
  }

  /* One measured colour per role from both sources. Averaged in a/b (hue + chroma together),
     so two sources pulling in different directions meet in the middle rather than one
     angle-averaging artefact. */
  function combineMeasurements(aerial, seasonal) {
    var out = {};
    Object.keys(ROLES).forEach(function (role) {
      var a = aerial && aerial[role] || null;
      /* Sentinel-2 cannot see a putting surface (it is a few pixels), so a green is only
         measured when the aerial saw it - otherwise it follows the fairway, below. */
      if (role === "green" && !a) { out[role] = null; return; }
      var turf = ROLE_FILTER[role] === "turf";
      var s = turf ? seasonalYear(seasonal && seasonal.months, role === "green" ? "fairway" : role) : null;
      var parts = [];
      if (a) parts.push({ lab: a, w: AERIAL_WEIGHT, source: "aerial" });
      if (s) parts.push({ lab: s, w: SEASONAL_WEIGHT, source: "sentinel-2" });
      if (!parts.length) { out[role] = null; return; }
      var wSum = parts.reduce(function (t, p) { return t + p.w; }, 0);
      out[role] = {
        a: round(parts.reduce(function (t, p) { return t + p.lab.a * p.w; }, 0) / wSum),
        b: round(parts.reduce(function (t, p) { return t + p.lab.b * p.w; }, 0) / wSum),
        sources: parts.map(function (p) { return p.source; })
      };
    });
    /* The putting surface is small and often painted or shaded in the photos; it follows the
       fairway's measurement unless it has its own. */
    if (!out.green && out.fairway) out.green = { a: out.fairway.a, b: out.fairway.b, sources: out.fairway.sources.concat(["via-fairway"]) };
    return out;
  }

  // ------------------------------------------------------------------ the palette

  function tintRole(spec, measured) {
    if (!measured) return { L: spec.L, C: spec.C, h: spec.h, tinted: false };
    var m = labToLch({ L: spec.L, a: measured.a, b: measured.b });
    /* Pull towards the measured hue the short way round, then hold it inside the role's band. */
    var dh = ((m.h - spec.h + 540) % 360) - 180;
    var h = clamp(spec.h + spec.pull * dh, spec.hueMin, spec.hueMax);
    var C = clamp(spec.C + spec.pull * (m.C - spec.C), spec.chromaMin, spec.chromaMax);
    return { L: spec.L, C: round(C), h: round(h), tinted: true };
  }

  /* measured: the output of combineMeasurements (or null for the base palette).
     Returns recipe-shaped colours plus a report of what each role became and why. */
  function buildCoursePalette(measured) {
    var roles = {};
    Object.keys(ROLES).forEach(function (role) {
      var t = tintRole(ROLES[role], measured && measured[role]);
      roles[role] = { L: t.L, C: t.C, h: t.h, hex: lchToHex(t.L, t.C, t.h), tinted: t.tinted,
        sources: measured && measured[role] ? measured[role].sources : [] };
    });
    return {
      colors: {
        background: roles.rough.hex,
        fairway: roles.fairway.hex,
        green: roles.green.hex,
        bunker: roles.bunker.hex,
        water: roles.water.hex,
        tee: FIXED.tee,
        outline: FIXED.outline
      },
      roles: roles
    };
  }

  /* The promise, checkable: neighbouring turf surfaces stay at least MIN_LIGHTNESS_GAP apart,
     whatever the tint. Measured back from the hex, so gamut clipping is accounted for too. */
  function lightnessGaps(colors) {
    var L = function (hex) { var lab = hexToOklab(hex); return lab ? lab.L : NaN; };
    return {
      roughToFairway: round(L(colors.fairway) - L(colors.background)),
      fairwayToGreen: round(L(colors.green) - L(colors.fairway)),
      fairwayToWater: round(L(colors.fairway) - L(colors.water)),
      greenToBunker: round(L(colors.bunker) - L(colors.green))
    };
  }

  /* A measured colour as hex, at its own lightness - for showing what was measured. */
  function labToHex(lab) {
    if (!lab || !Number.isFinite(lab.L)) return null;
    var lch = labToLch(lab);
    return lchToHex(lch.L, lch.C, lch.h);
  }

  function round(n) { return Math.round(n * 10000) / 10000; }

  return {
    ROLES: ROLES,
    MIN_LIGHTNESS_GAP: MIN_LIGHTNESS_GAP,
    MIN_SAMPLES: MIN_SAMPLES,
    rgbToOklab: rgbToOklab,
    hexToOklab: hexToOklab,
    labToLch: labToLch,
    lchToHex: lchToHex,
    labToHex: labToHex,
    summariseSamples: summariseSamples,
    seasonalYear: seasonalYear,
    combineMeasurements: combineMeasurements,
    buildCoursePalette: buildCoursePalette,
    lightnessGaps: lightnessGaps,
    basePalette: function () { return buildCoursePalette(null); }
  };
});
