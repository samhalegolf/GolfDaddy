/* Bubble Signals + Micro-Geometry - the single implementation.
 *
 * Loaded two ways, and it must stay portable between them:
 *   - browser, via <script> in index.html, as window.GDBubbleSignalsCore
 *   - Netlify function, via require("../scripts/gd-bubble-signals-core.js")
 *     from functions/bubble-model.js
 *
 * Same policy as scripts/gd-practice-parser-core.js: one file, no platform
 * APIs above the export tail (no localStorage, no window, no fetch). The
 * reason is stronger here than it was for the parser. This file decides how a
 * player's bubble is shaped, which is the modelling opinion Clarity wants to
 * tune centrally without shipping a phone build - so the phone must not own a
 * second copy of it that could drift, and Studio must be able to publish a new
 * config that the server applies immediately.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS IS NOT
 *
 * It does not replace the Bubble. The Bubble model is unchanged and remains
 * primary:
 *
 *     practice data -> player pattern -> normal club progression -> Bubble
 *
 * This file adds one layer AFTER that: small, evidence-gated moulding of the
 * shape the engine already produced. Club-labelled shots inform the PLAYER
 * MODEL; they never create an independent bubble for their own club.
 *
 * WITH EVERY SIGNAL DISABLED - the shipped default - buildMicroGeometry()
 * returns IDENTITY_GEOMETRY: every region 1.0, axis 0. The engine multiplies
 * its radius by 1.0 and adds 0 degrees, so nothing about today's bubble
 * changes. dev/bubble-signals-core.test.js pins that.
 *
 * ------------------------------------------------------------------------
 * REGION ORIENTATION - must match the engine's ring
 *
 * buildBubbleShape() in gd-app-core.js walks rel = 0..2pi building
 * { x: cos(rel)*lateral, y: sin(rel)*depth }, and localPointToLatLng() turns
 * that into a bearing of shotBearing + atan2(y, x). So x is ALONG the shot
 * (long) and y is to its RIGHT. Therefore:
 *
 * (The radii on those axes were swapped in 2026-08 - the ACROSS axis lies
 * square to the shot, which is the orientation the graphs always used and the
 * 90 degrees GPS Play was out by. rel is unaffected: rel=0 is still Long, so
 * every region below still means what it says. See gd-bubble-frame-core.js.)
 *
 *     rel = 0      -> Long
 *     rel = pi/2   -> Right
 *     rel = pi     -> Short
 *     rel = 3pi/2  -> Left
 *
 * Right and Left are sides of the target line, not sides of the player, so
 * nothing here needs handedness: every evidence value the engine reads
 * (spin axis, start direction, offline) is already signed in target-line
 * space. Handedness belongs to the aim offset, which this layer never touches.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GDBubbleSignalsCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Bumped when the payload SHAPE changes. The app reads this to decide
     whether a cached model is still one it understands. */
  var MODEL_VERSION = 1;

  /* Bumped when defaultConfig()'s shape changes. A published Studio config
     records the version it was authored against. */
  var CONFIG_VERSION = 1;

  var PI = Math.PI;

  /* ---------------------------------------------------------------------
     Regions
     --------------------------------------------------------------------- */

  var REGIONS = [
    'long', 'longRight', 'right', 'shortRight',
    'short', 'shortLeft', 'left', 'longLeft'
  ];

  var REGION_LABELS = {
    long: 'Long', longRight: 'Long Right', right: 'Right', shortRight: 'Short Right',
    short: 'Short', shortLeft: 'Short Left', left: 'Left', longLeft: 'Long Left'
  };

  /* Index i sits at rel = i * pi/4, in the order above. */
  var REGION_ANGLES = REGIONS.reduce(function (out, name, index) {
    out[name] = (index * PI) / 4;
    return out;
  }, {});

  /* The left/right swap a mirrored Signal applies when its observation is
     negative. Long and Short are on the mirror axis and map to themselves. */
  var MIRROR_REGION = {
    long: 'long', longRight: 'longLeft', right: 'left', shortRight: 'shortLeft',
    short: 'short', shortLeft: 'shortRight', left: 'right', longLeft: 'longRight'
  };

  function identityGeometry() {
    var out = { axisAdjustmentDeg: 0 };
    REGIONS.forEach(function (name) { out[name] = 1; });
    return out;
  }

  var IDENTITY_GEOMETRY = identityGeometry();

  /* ---------------------------------------------------------------------
     Numbers
     --------------------------------------------------------------------- */

  function asNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function round(value, decimals) {
    var factor = Math.pow(10, decimals || 0);
    var n = Number(value);
    return Number.isFinite(n) ? Math.round(n * factor) / factor : 0;
  }

  function finite(list) {
    return (Array.isArray(list) ? list : []).filter(function (v) { return Number.isFinite(Number(v)); }).map(Number);
  }

  function median(list) {
    var sorted = finite(list).sort(function (a, b) { return a - b; });
    if (!sorted.length) return null;
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function mean(list) {
    var clean = finite(list);
    if (!clean.length) return null;
    return clean.reduce(function (sum, v) { return sum + v; }, 0) / clean.length;
  }

  function stdDev(list) {
    var clean = finite(list);
    if (clean.length < 2) return 0;
    var m = mean(clean);
    return Math.sqrt(clean.reduce(function (sum, v) { return sum + (v - m) * (v - m); }, 0) / clean.length);
  }

  /* Fraction of values sharing the majority sign. 1 = every shot the same way,
     0.5 = a coin toss. Zeros count as neither side. */
  function signConsistency(list) {
    var clean = finite(list).filter(function (v) { return v !== 0; });
    if (!clean.length) return 0;
    var positive = clean.filter(function (v) { return v > 0; }).length;
    return Math.max(positive, clean.length - positive) / clean.length;
  }

  /* Least-squares fit with the coefficient of determination, so a Signal can
     ask "is this a trend or a scatter plot" rather than only "which way does
     the line point". */
  function linearFit(points) {
    var clean = (Array.isArray(points) ? points : []).filter(function (p) {
      return p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y));
    });
    if (clean.length < 3) return null;
    var xs = clean.map(function (p) { return Number(p.x); });
    var ys = clean.map(function (p) { return Number(p.y); });
    var mx = mean(xs);
    var my = mean(ys);
    var sxx = 0;
    var sxy = 0;
    for (var i = 0; i < clean.length; i++) {
      sxx += (xs[i] - mx) * (xs[i] - mx);
      sxy += (xs[i] - mx) * (ys[i] - my);
    }
    if (!(sxx > 0)) return null;
    var slope = sxy / sxx;
    var intercept = my - slope * mx;
    var ssTot = 0;
    var ssRes = 0;
    for (var j = 0; j < clean.length; j++) {
      var predicted = intercept + slope * xs[j];
      ssTot += (ys[j] - my) * (ys[j] - my);
      ssRes += (ys[j] - predicted) * (ys[j] - predicted);
    }
    var r2 = ssTot > 0 ? clamp(1 - ssRes / ssTot, 0, 1) : 0;
    return { slope: slope, intercept: intercept, r2: r2, n: clean.length, spanX: Math.max.apply(null, xs) - Math.min.apply(null, xs) };
  }

  /* ---------------------------------------------------------------------
     Evidence aliases (section 11)

     A Signal consumes a Clarity OBSERVATION. An observation can be reached by
     more than one evidence ROUTE, and the Signal engine downstream is not told
     which provider supplied it - only how much that route is worth.

     confidence (section 12) is two separate questions, deliberately:
       measurement    - how well the source measures the value at all
       representation - how well that value represents the golfer's normal golf

     Their product becomes the route's authority, and authority drives three
     things: the minimum sample, the trend threshold, and the ceiling on how
     much the Signal may move the bubble. There is no separate "weak device"
     code path - a weak route simply has to show a stronger, more persistent
     trend before it is allowed to move anything at all.
     --------------------------------------------------------------------- */

  /* Baseline per-provider confidence, before any route override. Anything not
     listed falls to `unknown`, which is deliberately mediocre rather than
     zero: an unlabelled CSV is still the player's real data. */
  var PROVIDER_CONFIDENCE = {
    trackman: { measurement: 0.95, representation: 0.92 },
    foresight: { measurement: 0.92, representation: 0.90 },
    uneekor: { measurement: 0.85, representation: 0.85 },
    flightscope: { measurement: 0.78, representation: 0.88 },
    fullswing: { measurement: 0.78, representation: 0.82 },
    skytrak: { measurement: 0.62, representation: 0.78 },
    rapsodo: { measurement: 0.55, representation: 0.80 },
    garmin_r10: { measurement: 0.52, representation: 0.82 },
    toptracer: { measurement: 0.48, representation: 0.86 },
    awesome_golf: { measurement: 0.45, representation: 0.75 },
    unknown: { measurement: 0.45, representation: 0.70 }
  };

  /* Per-route overrides of the provider baseline. These encode the known weak
     spots the launch-monitor layer already tracks in its source-trust preloads
     (radar-estimated club delivery, modelled spin) as a confidence number
     instead of an on/off "don't trust" rule - which is the whole point of
     section 12: weight the route, do not blacklist the device. */
  var ROUTE_PROVIDER_OVERRIDES = {
    face_to_path: { garmin_r10: { measurement: 0.28 }, rapsodo: { measurement: 0.30 }, toptracer: { measurement: 0.18 } },
    spin_axis: { toptracer: { measurement: 0.25 }, garmin_r10: { measurement: 0.40 }, skytrak: { measurement: 0.55 } },
    dynamic_lie_start: { garmin_r10: { measurement: 0.20 }, rapsodo: { measurement: 0.22 }, toptracer: { measurement: 0.12 } },
    dynamic_loft_launch: { garmin_r10: { measurement: 0.25 }, toptracer: { measurement: 0.15 }, rapsodo: { measurement: 0.25 } },
    peak_height_spin: { toptracer: { measurement: 0.35 }, garmin_r10: { measurement: 0.42 }, skytrak: { measurement: 0.50 } },
    carry_total: { toptracer: { measurement: 0.55, representation: 0.60 }, skytrak: { measurement: 0.60, representation: 0.55 }, foresight: { representation: 0.62 }, uneekor: { representation: 0.62 } }
  };

  /* An observation, the routes that can produce it, and what each route needs.
     `fields` are read from the normalised shot shape produced by
     normaliseRows() below. A route whose fields are absent simply does not
     run - it is not an error, and it is not a zero. */
  var EVIDENCE_ROUTES = {
    CURVATURE_BIAS: [
      { id: 'face_to_path', label: 'Face-to-Path', fields: ['faceToPathDeg'], saturation: 3.0, weight: 1.0 },
      { id: 'spin_axis', label: 'Spin Axis', fields: ['spinAxisDeg'], saturation: 6.0, weight: 1.0 },
      { id: 'start_vs_finish', label: 'Start Direction vs finish', fields: ['startDirectionDeg', 'normalizedDeg'], saturation: 4.0, weight: 0.75 }
    ],
    DIRECTION_PROGRESSION: [
      { id: 'dynamic_lie_start', label: 'Dynamic Lie + Start Direction', fields: ['dynamicLieDeg', 'startDirectionDeg'], saturation: 2.2, weight: 1.0 },
      { id: 'start_progression', label: 'Start Direction progression', fields: ['startDirectionDeg'], saturation: 2.2, weight: 0.6 }
    ],
    LAUNCH_CONVERSION: [
      { id: 'dynamic_loft_launch', label: 'Dynamic Loft + Launch Angle', fields: ['dynamicLoftDeg', 'launchAngleDeg'], saturation: 0.10, weight: 1.0 },
      { id: 'launch_for_carry', label: 'Launch Angle for carry band', fields: ['launchAngleDeg'], saturation: 4.0, weight: 0.45 }
    ],
    FLIGHT_EXPOSURE: [
      { id: 'peak_height_spin', label: 'Peak Height + Spin', fields: ['peakHeightM', 'spinRpm'], saturation: 0.055, weight: 1.0 },
      { id: 'peak_height_only', label: 'Peak Height', fields: ['peakHeightM'], saturation: 0.070, weight: 0.5 }
    ],
    ROLLOUT_CHARACTER: [
      { id: 'carry_total', label: 'Carry : Total through the bag', fields: ['carryM', 'totalM'], saturation: 0.060, weight: 1.0 }
    ]
  };

  function routeConfidence(routeId, providerMix) {
    var overrides = ROUTE_PROVIDER_OVERRIDES[routeId] || {};
    var measurement = 0;
    var representation = 0;
    var total = 0;
    Object.keys(providerMix || {}).forEach(function (provider) {
      var share = Number(providerMix[provider]) || 0;
      if (!(share > 0)) return;
      var base = PROVIDER_CONFIDENCE[provider] || PROVIDER_CONFIDENCE.unknown;
      var over = overrides[provider] || {};
      measurement += share * (over.measurement === undefined ? base.measurement : over.measurement);
      representation += share * (over.representation === undefined ? base.representation : over.representation);
      total += share;
    });
    if (!(total > 0)) {
      var fallback = PROVIDER_CONFIDENCE.unknown;
      return { measurement: fallback.measurement, representation: fallback.representation, authority: fallback.measurement * fallback.representation };
    }
    measurement = measurement / total;
    representation = representation / total;
    return { measurement: measurement, representation: representation, authority: measurement * representation };
  }

  /* ---------------------------------------------------------------------
     Signal definitions

     Every Signal follows the same sentence:

       IF   relationship A is present
       AND  relationship B supports it
       THEN this is evidence of observation C
       EFFECT apply a small adjustment to selected regions

     `deformation` is written for a POSITIVE observation and is in PERCENT of
     the base radius at that region. `mirror: true` means a negative
     observation swaps left for right (a fade bias and a draw bias are the same
     shape pointing the other way). `mirror: false` means a negative
     observation simply inverts the numbers (less rollout pulls Long in).

     Only Curvature Bias may request a genuine axis correction, and its request
     is capped at half a degree.
     --------------------------------------------------------------------- */

  var SIGNAL_DEFINITIONS = [
    {
      id: 'curvature_bias',
      label: 'Curvature Bias',
      observation: 'CURVATURE_BIAS',
      /* SHIPPED OFF. Section "V1 Success Condition": with all Signals disabled,
         nothing changes. Studio turns them on per config version. */
      enabled: false,
      kind: 'central',
      mirror: true,
      minShots: 8,
      minClubs: 1,
      evidenceThreshold: 0.35,
      /* Fraction of the player's own carry range this Signal applies over.
         Curvature is a whole-bag characteristic, so it is the full range. */
      applies: { fromCarryFraction: 0, toCarryFraction: 1 },
      allowAxis: true,
      axisAdjustmentDeg: 0.5,
      maxEffectPct: 1.2,
      deformation: {
        right: 0.90, longRight: 0.60, shortRight: 0.35,
        long: 0, short: 0,
        left: -0.25, longLeft: -0.15, shortLeft: -0.10
      }
    },
    {
      id: 'direction_progression',
      label: 'Direction Progression',
      observation: 'DIRECTION_PROGRESSION',
      enabled: false,
      kind: 'progression',
      mirror: true,
      minShots: 15,
      minClubs: 3,
      evidenceThreshold: 0.40,
      /* The example in the job spec reads "Applies to: 6i -> Driver" - the
         longer part of the bag, expressed against the player's own range so it
         still means the same clubs for a player who hits it 30m shorter. On a
         full nine-club ladder 0.35 lands exactly on 6i. */
      applies: { fromCarryFraction: 0.35, toCarryFraction: 1 },
      allowAxis: false,
      axisAdjustmentDeg: 0,
      maxEffectPct: 1.0,
      deformation: {
        right: 0.70, longRight: 0.40, shortRight: 0.30,
        long: 0, short: 0, left: 0, longLeft: 0, shortLeft: 0
      }
    },
    {
      id: 'launch_conversion',
      label: 'Launch Conversion',
      observation: 'LAUNCH_CONVERSION',
      enabled: false,
      kind: 'central',
      mirror: false,
      minShots: 12,
      minClubs: 2,
      evidenceThreshold: 0.40,
      applies: { fromCarryFraction: 0, toCarryFraction: 1 },
      allowAxis: false,
      axisAdjustmentDeg: 0,
      maxEffectPct: 1.0,
      /* Launching higher than the delivered loft would predict lands steeper
         and shorter: pull the long edge in, let the short edge out. */
      deformation: {
        long: -0.50, longRight: -0.30, longLeft: -0.30,
        right: 0, left: 0,
        short: 0.40, shortRight: 0.25, shortLeft: 0.25
      }
    },
    {
      id: 'flight_exposure',
      label: 'Flight Exposure',
      observation: 'FLIGHT_EXPOSURE',
      enabled: false,
      kind: 'central',
      mirror: false,
      minShots: 12,
      minClubs: 2,
      evidenceThreshold: 0.42,
      applies: { fromCarryFraction: 0, toCarryFraction: 1 },
      allowAxis: false,
      axisAdjustmentDeg: 0,
      maxEffectPct: 1.0,
      /* More time in the air, more of everything that happens up there. The
         shape gets wider and gives up a little at the long edge. */
      deformation: {
        right: 0.50, left: 0.50,
        shortRight: 0.30, shortLeft: 0.30,
        short: 0.40, long: -0.20,
        longRight: -0.10, longLeft: -0.10
      }
    },
    {
      id: 'rollout_character',
      label: 'Rollout Character',
      observation: 'ROLLOUT_CHARACTER',
      enabled: false,
      kind: 'progression',
      mirror: false,
      minShots: 15,
      minClubs: 3,
      evidenceThreshold: 0.40,
      applies: { fromCarryFraction: 0, toCarryFraction: 1 },
      allowAxis: false,
      axisAdjustmentDeg: 0,
      maxEffectPct: 2.0,
      /* The worked example in the job spec, verbatim. */
      deformation: {
        long: 1.50, longRight: 0.50, longLeft: 0.50,
        right: 0, shortRight: 0, short: 0, shortLeft: 0, left: 0
      }
    }
  ];

  /* ---------------------------------------------------------------------
     Config - the whole tunable surface Studio publishes

     Everything a modelling decision depends on is in here, so a new opinion
     about how the bubble should mould is a config version rather than an App
     Store release.
     --------------------------------------------------------------------- */

  function defaultConfig() {
    return {
      configVersion: CONFIG_VERSION,
      modelVersion: MODEL_VERSION,
      /* Master switch. false means buildMicroGeometry() short-circuits to
         identity no matter what any individual Signal says. */
      enabled: false,
      /* Hard ceilings the merged result may never exceed, whatever the
         Signals ask for. Production stays subtle by construction. */
      caps: {
        maxRegionPct: 2.5,
        maxAxisDeg: 0.5,
        maxTotalRegionPct: 3.0
      },
      /* How evidence turns into authority. */
      evidence: {
        /* Sample the strongest route would need. A weaker route needs this
           divided by its authority, clamped by maxSampleShots. */
        baseSampleShots: 10,
        maxSampleShots: 90,
        /* A slope-based Signal needs this much R2 before its trend quality
           counts as whole. */
        fullTrendR2: 0.55,
        /* A median-based Signal needs this much sign agreement before its
           consistency counts as whole. */
        fullSignConsistency: 0.75,
        /* What a Signal is worth when it fired on one route with no
           corroborating relationship. Section 1's shape is IF/AND/THEN - a
           solo route is allowed to speak, quietly. */
        soloRouteWeight: 0.45,
        /* How much a weak route RAISES its own evidence threshold.

           Authority deliberately does not multiply into evidence strength.
           It used to, and that made a weak route unfirable rather than
           demanding: a route with authority 0.33 could never produce an
           evidence strength above 0.33, so a 0.35 threshold refused it no
           matter how much consistent evidence the player supplied. Section 12
           says the opposite - weak evidence needs MORE consistent evidence,
           not a locked door. So authority raises the bar the trend has to
           clear, and separately caps the effect once it does. */
        weakRouteThresholdPenalty: 0.6,
        /* Minimum carry span (metres) a progression must cover before its
           slope means anything. Three clubs 6m apart is not a progression. */
        minProgressionSpanM: 45
      },
      /* Where each relationship sits for a NORMAL golfer. Every observation is
         a departure from one of these, never a raw value - because the raw
         values are not zero for a normal player and reading them as if they
         were would fire a Signal on ordinary golf.

         The clearest case is rollout: a real bag runs out more with the long
         clubs than the wedges, so the carry:total slope through the bag is
         positive for everybody. What the Rollout Character Signal is looking
         for is a slope UNLIKE that one. */
      normals: {
        /* degrees of launch per degree of delivered loft */
        launchToLoftSlope: 0.78,
        /* degrees of launch lost per 100m of carry, walking up the bag */
        launchPerCarryPer100m: -20.9,
        /* peak height / carry at the reference spin */
        peakToCarryRatio: 0.175,
        /* how much that ratio moves per 1.0 of spin ratio */
        peakPerSpinUnit: 0.09,
        referenceSpinRpm: 6000,
        /* carry:total ratio gained per 100m of carry, walking up the bag */
        rolloutSlopePer100m: 0.07
      },
      /* Per-Signal overrides, keyed by Signal id. Anything absent falls back
         to the definition above. Studio writes into here. */
      signals: SIGNAL_DEFINITIONS.reduce(function (out, def) {
        out[def.id] = {
          enabled: def.enabled,
          evidenceThreshold: def.evidenceThreshold,
          maxEffectPct: def.maxEffectPct,
          axisAdjustmentDeg: def.axisAdjustmentDeg,
          minShots: def.minShots,
          minClubs: def.minClubs,
          applies: { fromCarryFraction: def.applies.fromCarryFraction, toCarryFraction: def.applies.toCarryFraction },
          deformation: Object.assign({}, def.deformation)
        };
        return out;
      }, {}),
      /* Clubs the Projected Clubs view walks, longest last. Resolved against
         the player's real bag; missing clubs are still projected. */
      representativeClubs: ['PW', '8i', '6i', '4i', 'Driver']
    };
  }

  /* Deep-ish merge of a stored config over the defaults, so a config authored
     against an older CONFIG_VERSION still boots with the new keys present. */
  function resolveConfig(stored) {
    var base = defaultConfig();
    if (!stored || typeof stored !== 'object') return base;
    var out = Object.assign({}, base, stored);
    out.caps = Object.assign({}, base.caps, stored.caps || {});
    out.evidence = Object.assign({}, base.evidence, stored.evidence || {});
    out.normals = Object.assign({}, base.normals, stored.normals || {});
    out.signals = {};
    Object.keys(base.signals).forEach(function (id) {
      var storedSignal = (stored.signals || {})[id] || {};
      out.signals[id] = Object.assign({}, base.signals[id], storedSignal);
      out.signals[id].applies = Object.assign({}, base.signals[id].applies, storedSignal.applies || {});
      out.signals[id].deformation = Object.assign({}, base.signals[id].deformation, storedSignal.deformation || {});
    });
    out.representativeClubs = Array.isArray(stored.representativeClubs) && stored.representativeClubs.length
      ? stored.representativeClubs.slice()
      : base.representativeClubs.slice();
    out.configVersion = Number(stored.configVersion) || base.configVersion;
    out.modelVersion = MODEL_VERSION;
    return out;
  }

  /* ---------------------------------------------------------------------
     Row normalisation

     Accepts every shape a Clarity practice shot arrives in, so there is one
     engine rather than one per caller:
       - gate rows from buildPracticeGateInput() (delivery/flight sub-objects)
       - native practice shots straight from the parser core
       - Shot Library rows from gd-launch-monitor-data.js (delivery block plus
         a metrics[] array carrying whatever the monitor reported)
       - already-normalised rows (idempotent)
     --------------------------------------------------------------------- */

  function pick() {
    for (var i = 0; i < arguments.length; i++) {
      var value = asNumber(arguments[i]);
      if (value !== null) return value;
    }
    return null;
  }

  /* A Shot Library row keeps everything the monitor reported in metrics[],
     each entry labelled with the header it came from and the field the parser
     thought it was. Reading it here is what lets the Studio visualiser and the
     server run over a REAL session rather than only over generated rows -
     without a second copy of the alias table, because these are the same
     canonical field names gd-practice-parser-core.js resolves headers to. */
  function metricFromRow(row, names) {
    var metrics = row && Array.isArray(row.metrics) ? row.metrics : null;
    if (!metrics) return null;
    for (var i = 0; i < names.length; i++) {
      var wanted = String(names[i]).trim().toLowerCase();
      for (var j = 0; j < metrics.length; j++) {
        var metric = metrics[j];
        if (!metric) continue;
        var candidate = String(metric.candidateMetric || '').trim().toLowerCase();
        var raw = String(metric.rawLabel || '').trim().toLowerCase();
        if (candidate === wanted || raw === wanted) {
          var value = asNumber(metric.value);
          if (value !== null) return value;
        }
      }
    }
    return null;
  }

  function normaliseRow(row) {
    if (!row || typeof row !== 'object') return null;
    var delivery = row.delivery && typeof row.delivery === 'object' ? row.delivery : {};
    var flight = row.flight && typeof row.flight === 'object' ? row.flight : {};
    var carryM = pick(row.carryM, row.carryDistance);
    var totalM = pick(row.totalM, row.totalDistance);
    var lateralM = pick(row.lateralM, row.offlineDistance);
    var expectedM = carryM !== null ? carryM : totalM;
    var normalizedDeg = pick(row.normalizedDeg, row.normalisedDeg);
    if (normalizedDeg === null && lateralM !== null && expectedM !== null && expectedM > 0) {
      normalizedDeg = Math.atan2(lateralM, expectedM) * 180 / PI;
    }
    var club = String(row.club || '').trim() || 'Unknown';
    var provider = String(row.providerGuess || row.provider || (row.rawSource && row.rawSource.providerGuess) || '')
      .trim().toLowerCase() || 'unknown';
    return {
      shotId: row.shotId || '',
      sessionId: row.sessionId || '',
      importBatchId: row.importBatchId || '',
      club: club,
      providerGuess: PROVIDER_CONFIDENCE[provider] ? provider : 'unknown',
      carryM: carryM,
      totalM: totalM,
      lateralM: lateralM,
      normalizedDeg: normalizedDeg,
      faceAngleDeg: pick(delivery.faceAngleDeg, row.faceAngle, metricFromRow(row, ['faceAngle', 'face angle'])),
      /* clubPathDeg is what the Shot Library row calls it; pathAngle is the
         parser's name for the same number. */
      pathAngleDeg: pick(delivery.pathAngleDeg, delivery.clubPathDeg, row.pathAngle, metricFromRow(row, ['pathAngle', 'club path'])),
      faceToPathDeg: pick(delivery.faceToPathDeg, row.faceToPath, metricFromRow(row, ['faceToPath', 'face to path'])),
      startDirectionDeg: pick(delivery.startDirectionDeg, row.startDirection, metricFromRow(row, ['startDirection', 'launch direction', 'side angle'])),
      dynamicLoftDeg: pick(delivery.dynamicLoftDeg, row.dynamicLoft, metricFromRow(row, ['dynamicLoft', 'dynamic loft', 'loft angle'])),
      dynamicLieDeg: pick(delivery.dynamicLieDeg, row.dynamicLie, metricFromRow(row, ['dynamicLie', 'dynamic lie', 'lie angle'])),
      attackAngleDeg: pick(delivery.attackAngleDeg, row.attackAngle, metricFromRow(row, ['attackAngle', 'attack angle', 'angle of attack'])),
      launchAngleDeg: pick(flight.launchAngleDeg, row.launchAngle, metricFromRow(row, ['launchAngle', 'launch angle'])),
      spinRpm: pick(flight.spinRpm, row.spin, row.totalSpin, metricFromRow(row, ['spin', 'spinRate', 'spin rate', 'totalSpin', 'back spin'])),
      spinAxisDeg: pick(flight.spinAxisDeg, row.spinAxis, metricFromRow(row, ['spinAxis', 'spin axis', 'spin tilt axis'])),
      peakHeightM: pick(flight.peakHeight, row.peakHeight, metricFromRow(row, ['peakHeight', 'peak height', 'apex', 'apex height', 'height'])),
      descentAngleDeg: pick(flight.descentAngleDeg, row.descentAngle, metricFromRow(row, ['descentAngle', 'descent angle', 'landing angle'])),
      hangTimeSec: pick(flight.hangTimeSec, row.hangTime, metricFromRow(row, ['hangTime', 'hang time', 'flight time'])),
      ballSpeed: pick(flight.ballSpeed, row.ballSpeed, metricFromRow(row, ['ballSpeed', 'ball speed'])),
      clubSpeed: pick(flight.clubSpeed, row.clubSpeed, metricFromRow(row, ['clubSpeed', 'club speed', 'club head speed']))
    };
  }

  function normaliseRows(rows) {
    return (Array.isArray(rows) ? rows : [])
      .map(normaliseRow)
      .filter(function (row) {
        /* A row with no distance cannot be placed in the bag and cannot
           contribute to any progression, so it is not evidence of anything. */
        return row && (row.carryM !== null || row.totalM !== null);
      });
  }

  function providerMix(rows) {
    var counts = {};
    var total = 0;
    rows.forEach(function (row) {
      counts[row.providerGuess] = (counts[row.providerGuess] || 0) + 1;
      total += 1;
    });
    if (!total) return { unknown: 1 };
    Object.keys(counts).forEach(function (key) { counts[key] = counts[key] / total; });
    return counts;
  }

  /* Per-club aggregate, ordered short to long by the club's own median carry.
     This is the bag as the player's data actually describes it - no club
     table, no assumed distances. */
  function clubProfiles(rows) {
    var groups = {};
    rows.forEach(function (row) {
      groups[row.club] = groups[row.club] || [];
      groups[row.club].push(row);
    });
    return Object.keys(groups).map(function (club) {
      var list = groups[club];
      var carry = median(list.map(function (r) { return r.carryM; }));
      var total = median(list.map(function (r) { return r.totalM; }));
      return {
        club: club,
        shots: list.length,
        carryM: carry,
        totalM: total,
        rows: list
      };
    }).filter(function (entry) {
      return entry.carryM !== null || entry.totalM !== null;
    }).map(function (entry) {
      if (entry.carryM === null) entry.carryM = entry.totalM;
      return entry;
    }).sort(function (a, b) { return a.carryM - b.carryM; });
  }

  /* The clubs a Signal applies to, as a slice of the player's own bag rather
     than absolute metres - so "the longer half of the bag" means the same
     clubs for someone who hits it 30m shorter. */
  function clubsInRange(clubs, applies) {
    if (!clubs.length) return [];
    var min = clubs[0].carryM;
    var max = clubs[clubs.length - 1].carryM;
    var span = max - min;
    if (!(span > 0)) return clubs.slice();
    var from = min + span * clamp(Number(applies.fromCarryFraction) || 0, 0, 1);
    var to = min + span * clamp(applies.toCarryFraction === undefined ? 1 : Number(applies.toCarryFraction), 0, 1);
    return clubs.filter(function (entry) { return entry.carryM >= from - 0.001 && entry.carryM <= to + 0.001; });
  }

  /* Rows belonging to those clubs.

     Selected by CLUB, not by each shot's own carry. Testing every shot against
     the range dropped the shots that happened to fly shorter than their club's
     own median - so a full-bag Signal with a 0..1 range silently lost about a
     fifth of the session to the boundary, and a progression Signal lost the
     bad strikes that are part of what the progression is made of. The club is
     what the range is about. */
  function rowsInRange(rows, clubs, applies) {
    if (!clubs.length) return rows;
    var selected = clubsInRange(clubs, applies);
    if (selected.length === clubs.length) return rows;
    var allowed = {};
    selected.forEach(function (entry) { allowed[entry.club] = true; });
    return rows.filter(function (row) { return allowed[row.club]; });
  }

  /* ---------------------------------------------------------------------
     Observations

     Each returns the same envelope so detectSignals() can treat them
     identically:

       { value, magnitude, quality, corroborated, sampleShots, sampleClubs,
         route, evidence[] }

     value       signed, in the relationship's own units
     magnitude   |value| / route.saturation, clamped 0..1
     quality     trend R2 (progressions) or sign consistency (central values)
     evidence[]  what Studio prints under "Evidence:"
     --------------------------------------------------------------------- */

  function emptyObservation(reason) {
    return {
      available: false, reason: reason || 'no_evidence', value: 0, magnitude: 0,
      quality: 0, corroborated: false, sampleShots: 0, sampleClubs: 0,
      route: null, evidence: []
    };
  }

  /* Pick the evidence route with the most to say, not merely the first one
     that technically qualifies.

     Declaration order alone was wrong: a file with Face-to-Path on three rows
     and Spin Axis on all forty would take the three-row route because it is
     listed first, then be told off downstream for having a small sample. The
     score weighs the route's own authority against how much of the session it
     can actually read, so a strong route only wins while it has the data to
     back it. Ties keep declaration order. */
  function routeFor(observation, rows) {
    var routes = EVIDENCE_ROUTES[observation] || [];
    var best = null;
    routes.forEach(function (route, index) {
      var usable = rows.filter(function (row) {
        return route.fields.every(function (field) { return row[field] !== null; });
      });
      if (usable.length < 3) return;
      var coverage = Math.min(1, usable.length / 8);
      var score = (route.weight === undefined ? 1 : route.weight) * coverage;
      if (!best || score > best.score + 1e-9) best = { route: route, rows: usable, score: score, index: index };
    });
    return best ? { route: best.route, rows: best.rows } : null;
  }

  /* Curvature Bias - a stable sideways shaping bias across the shots. */
  function observeCurvatureBias(rows, cfg) {
    var chosen = routeFor('CURVATURE_BIAS', rows);
    if (!chosen) return emptyObservation('no_curvature_route');
    var route = chosen.route;
    var values;
    if (route.id === 'face_to_path') values = chosen.rows.map(function (r) { return r.faceToPathDeg; });
    else if (route.id === 'spin_axis') values = chosen.rows.map(function (r) { return r.spinAxisDeg; });
    else values = chosen.rows.map(function (r) { return r.normalizedDeg - r.startDirectionDeg; });

    var centre = median(values);
    if (centre === null) return emptyObservation('no_curvature_values');
    var consistency = signConsistency(values);
    var evidence = [{ label: route.label, detail: round(centre, 2) + ' deg median', ok: true }];

    /* The AND. A curvature bias that the finishing position does not agree
       with is a delivery quirk, not a ball-flight bias. */
    var finishes = chosen.rows.map(function (r) { return r.normalizedDeg; }).filter(function (v) { return v !== null; });
    var finishCentre = median(finishes);
    var corroborated = finishCentre !== null && finishes.length >= 5 && (finishCentre === 0 ? false : (finishCentre > 0) === (centre > 0));
    evidence.push({
      label: 'Finish position agrees',
      detail: finishCentre === null ? 'not reported' : round(finishCentre, 2) + ' deg median',
      ok: corroborated
    });

    return {
      available: true, reason: '', value: centre,
      magnitude: clamp(Math.abs(centre) / route.saturation, 0, 1),
      quality: clamp(consistency / cfg.evidence.fullSignConsistency, 0, 1),
      corroborated: corroborated,
      sampleShots: chosen.rows.length,
      sampleClubs: new Set(chosen.rows.map(function (r) { return r.club; })).size,
      route: route, evidence: evidence
    };
  }

  /* Direction Progression - start direction walking one way through the bag,
     with dynamic lie moving with it where the monitor reports lie. */
  function observeDirectionProgression(rows, clubs, cfg) {
    var chosen = routeFor('DIRECTION_PROGRESSION', rows);
    if (!chosen) return emptyObservation('no_direction_route');
    var route = chosen.route;
    var byClub = clubProfiles(chosen.rows);
    if (byClub.length < 3) return emptyObservation('too_few_clubs');

    var startPoints = byClub.map(function (entry) {
      return { x: entry.carryM, y: median(entry.rows.map(function (r) { return r.startDirectionDeg; })) };
    });
    var startFit = linearFit(startPoints);
    if (!startFit) return emptyObservation('no_start_trend');
    if (!(startFit.spanX >= cfg.evidence.minProgressionSpanM)) return emptyObservation('carry_span_too_short');

    /* Slope reported per 100m of carry so the number reads the same for a
       player who hits it short and one who hits it long. */
    var slopePer100 = startFit.slope * 100;
    var evidence = [{ label: 'Start Direction progression', detail: round(slopePer100, 2) + ' deg / 100m', ok: true }];

    var corroborated = false;
    if (route.id === 'dynamic_lie_start') {
      var liePoints = byClub.map(function (entry) {
        return { x: entry.carryM, y: median(entry.rows.map(function (r) { return r.dynamicLieDeg; })) };
      });
      var lieFit = linearFit(liePoints);
      corroborated = !!lieFit && lieFit.r2 >= 0.25 && lieFit.slope !== 0 && (lieFit.slope > 0) === (startFit.slope > 0);
      evidence.unshift({
        label: 'Dynamic Lie progression',
        detail: lieFit ? round(lieFit.slope * 100, 2) + ' deg / 100m' : 'not reported',
        ok: corroborated
      });
    } else {
      evidence.push({ label: 'Dynamic Lie progression', detail: 'not reported by this source', ok: false });
    }

    return {
      available: true, reason: '', value: slopePer100,
      magnitude: clamp(Math.abs(slopePer100) / route.saturation, 0, 1),
      quality: clamp(startFit.r2 / cfg.evidence.fullTrendR2, 0, 1),
      corroborated: corroborated,
      sampleShots: chosen.rows.length,
      sampleClubs: byClub.length,
      route: route, evidence: evidence
    };
  }

  /* Launch Conversion - how much launch the player gets per degree of loft
     they deliver, against the relationship a normal golfer shows.

     Measured as a SLOPE, not a ratio. A bag ranges from a 42 degree wedge to a
     12 degree driver, and the launch:loft ratio is legitimately different at
     the two ends; the slope through them is the relationship the spec asks
     about, and it does not care how much wedge play happened to be in the
     session. */
  function observeLaunchConversion(rows, cfg) {
    var chosen = routeFor('LAUNCH_CONVERSION', rows);
    if (!chosen) return emptyObservation('no_launch_route');
    var route = chosen.route;
    var fit;
    var normal;
    var evidence = [];

    if (route.id === 'dynamic_loft_launch') {
      fit = linearFit(chosen.rows
        .filter(function (r) { return r.dynamicLoftDeg > 1; })
        .map(function (r) { return { x: r.dynamicLoftDeg, y: r.launchAngleDeg }; }));
      normal = cfg.normals.launchToLoftSlope;
      if (!fit) return emptyObservation('no_launch_trend');
      evidence.push({
        label: 'Launch per degree of Dynamic Loft',
        detail: round(fit.slope, 3) + ' vs ' + round(normal, 3) + ' normal',
        ok: true
      });
    } else {
      /* Weak proxy: how launch falls away as the clubs get longer. It cannot
         separate a real conversion difference from an unusual set of lofts,
         which is exactly why its route weight is low and its sample
         requirement correspondingly large. */
      var byClub = clubProfiles(chosen.rows);
      fit = linearFit(byClub.map(function (entry) {
        return { x: entry.carryM, y: median(entry.rows.map(function (r) { return r.launchAngleDeg; })) };
      }));
      if (!fit) return emptyObservation('no_launch_baseline');
      fit = { slope: fit.slope * 100, r2: fit.r2, n: fit.n, spanX: fit.spanX };
      normal = cfg.normals.launchPerCarryPer100m;
      evidence.push({
        label: 'Launch per 100m of carry (proxy route)',
        detail: round(fit.slope, 2) + ' vs ' + round(normal, 2) + ' normal',
        ok: true
      });
    }

    /* Positive means MORE launch than the relationship predicts. On the proxy
       route a shallower (less negative) slope is also more launch, so the
       subtraction gives the same sign either way. */
    var departure = fit.slope - normal;

    /* The AND. A launch difference the descent angle does not echo is noise in
       one number rather than a flight characteristic. */
    var pairs = chosen.rows
      .filter(function (r) { return r.descentAngleDeg !== null && r.launchAngleDeg !== null; })
      .map(function (r) { return { x: r.launchAngleDeg, y: r.descentAngleDeg }; });
    var descentFit = pairs.length >= 5 ? linearFit(pairs) : null;
    var corroborated = !!descentFit && descentFit.r2 >= 0.2 && descentFit.slope > 0;
    evidence.push({
      label: 'Descent angle follows launch',
      detail: descentFit ? 'r2 ' + round(descentFit.r2, 2) : 'not reported',
      ok: corroborated
    });

    return {
      available: true, reason: '', value: departure,
      magnitude: clamp(Math.abs(departure) / route.saturation, 0, 1),
      quality: clamp(fit.r2 / cfg.evidence.fullTrendR2, 0, 1),
      corroborated: corroborated,
      sampleShots: chosen.rows.length,
      sampleClubs: new Set(chosen.rows.map(function (r) { return r.club; })).size,
      route: route, evidence: evidence
    };
  }

  /* Flight Exposure - how much of the shot happens in the air: peak height
     against carry, referenced to the spin that produced it. A player who
     spins it more is EXPECTED to fly it higher, so the spin correction is
     part of the normal, not a separate test. */
  function observeFlightExposure(rows, cfg) {
    var chosen = routeFor('FLIGHT_EXPOSURE', rows);
    if (!chosen) return emptyObservation('no_flight_route');
    var route = chosen.route;
    var withSpin = route.id === 'peak_height_spin';

    var residuals = chosen.rows
      .filter(function (r) { return (r.carryM === null ? r.totalM : r.carryM) > 1; })
      .map(function (r) {
        var carry = r.carryM === null ? r.totalM : r.carryM;
        var expected = cfg.normals.peakToCarryRatio;
        if (withSpin && r.spinRpm !== null) {
          expected += cfg.normals.peakPerSpinUnit * (r.spinRpm / cfg.normals.referenceSpinRpm - 1);
        }
        return r.peakHeightM / carry - expected;
      });
    var centre = median(residuals);
    if (centre === null) return emptyObservation('no_height_values');
    var evidence = [{
      label: withSpin ? 'Peak Height : carry, for the spin generated' : 'Peak Height : carry',
      detail: round(centre * 100, 2) + ' pts vs normal',
      ok: true
    }];

    /* The AND. The same lean has to show up in EVERY club.

       Deliberately not "does peak height rise with launch angle": across a bag
       it does the opposite, because a wedge launches at 34 degrees and a
       driver at 11 and they finish at almost the same height. That is normal
       golf, not evidence. What separates a player who genuinely flies it high
       from a session with one ballooned club is that the residual leans the
       same way club after club. */
    var perClub = clubProfiles(chosen.rows).map(function (entry) {
      return median(entry.rows.map(function (r) {
        var carry = r.carryM === null ? r.totalM : r.carryM;
        if (!(carry > 1) || r.peakHeightM === null) return null;
        var expected = cfg.normals.peakToCarryRatio;
        if (withSpin && r.spinRpm !== null) {
          expected += cfg.normals.peakPerSpinUnit * (r.spinRpm / cfg.normals.referenceSpinRpm - 1);
        }
        return r.peakHeightM / carry - expected;
      }));
    }).filter(function (v) { return v !== null; });
    var clubAgreement = perClub.length >= 2 ? signConsistency(perClub) : 0;
    var corroborated = perClub.length >= 2 && clubAgreement >= 0.66
      && centre !== 0 && (median(perClub) > 0) === (centre > 0);
    evidence.push({
      label: 'Same lean in every club',
      detail: perClub.length >= 2 ? Math.round(clubAgreement * 100) + '% of clubs agree' : 'one club only',
      ok: corroborated
    });

    return {
      available: true, reason: '', value: centre,
      magnitude: clamp(Math.abs(centre) / route.saturation, 0, 1),
      quality: clamp(signConsistency(residuals) / cfg.evidence.fullSignConsistency, 0, 1),
      corroborated: corroborated,
      sampleShots: chosen.rows.length,
      sampleClubs: new Set(chosen.rows.map(function (r) { return r.club; })).size,
      route: route, evidence: evidence
    };
  }

  /* Rollout Character - the carry:total ratio drifting through the bag FASTER
     OR SLOWER than a normal bag does.

     Every golfer's long clubs run out more than their wedges, so the raw slope
     is positive for everyone and means nothing on its own. The departure from
     normals.rolloutSlopePer100m is the observation. */
  function observeRolloutCharacter(rows, cfg) {
    var usable = rows.filter(function (r) { return r.carryM !== null && r.totalM !== null && r.carryM > 1; });
    if (usable.length < 6) return emptyObservation('no_rollout_pairs');
    var byClub = clubProfiles(usable);
    if (byClub.length < 3) return emptyObservation('too_few_clubs');

    var points = byClub.map(function (entry) {
      return {
        x: entry.carryM,
        y: median(entry.rows.map(function (r) { return r.totalM / r.carryM; }))
      };
    });
    var fit = linearFit(points);
    if (!fit) return emptyObservation('no_rollout_trend');
    if (!(fit.spanX >= cfg.evidence.minProgressionSpanM)) return emptyObservation('carry_span_too_short');

    var slopePer100 = fit.slope * 100;
    var departure = slopePer100 - cfg.normals.rolloutSlopePer100m;
    var route = EVIDENCE_ROUTES.ROLLOUT_CHARACTER[0];
    var evidence = [{
      label: 'Carry : Total progression',
      detail: round(slopePer100, 3) + ' vs ' + round(cfg.normals.rolloutSlopePer100m, 3) + ' normal, per 100m',
      ok: true
    }];

    /* The AND. A trend the ratio level itself contradicts (every club already
       pinned at 1.00) is arithmetic, not character. */
    var levels = points.map(function (p) { return p.y; });
    var levelSpread = Math.max.apply(null, levels) - Math.min.apply(null, levels);
    var corroborated = levelSpread >= 0.02;
    evidence.push({
      label: 'Ratio genuinely differs across the bag',
      detail: round(levelSpread, 3) + ' spread',
      ok: corroborated
    });

    return {
      available: true, reason: '', value: departure,
      magnitude: clamp(Math.abs(departure) / route.saturation, 0, 1),
      quality: clamp(fit.r2 / cfg.evidence.fullTrendR2, 0, 1),
      corroborated: corroborated,
      sampleShots: usable.length,
      sampleClubs: byClub.length,
      route: route, evidence: evidence
    };
  }

  /* ---------------------------------------------------------------------
     Detection
     --------------------------------------------------------------------- */

  function signalDefinition(id) {
    for (var i = 0; i < SIGNAL_DEFINITIONS.length; i++) {
      if (SIGNAL_DEFINITIONS[i].id === id) return SIGNAL_DEFINITIONS[i];
    }
    return null;
  }

  function observeFor(definition, rows, clubs, cfg) {
    switch (definition.observation) {
      case 'CURVATURE_BIAS': return observeCurvatureBias(rows, cfg);
      case 'DIRECTION_PROGRESSION': return observeDirectionProgression(rows, clubs, cfg);
      case 'LAUNCH_CONVERSION': return observeLaunchConversion(rows, cfg);
      case 'FLIGHT_EXPOSURE': return observeFlightExposure(rows, cfg);
      case 'ROLLOUT_CHARACTER': return observeRolloutCharacter(rows, cfg);
      default: return emptyObservation('unknown_observation');
    }
  }

  /* One Signal, one verdict. Returns a record whether or not it fired, because
     Studio has to be able to show why a Signal did NOT fire - that is most of
     the debugging value. */
  function detectSignal(definition, allRows, allClubs, cfg) {
    var tuning = (cfg.signals || {})[definition.id] || {};
    var enabled = tuning.enabled !== undefined ? !!tuning.enabled : !!definition.enabled;
    var applies = tuning.applies || definition.applies;
    var scopedRows = rowsInRange(allRows, allClubs, applies);
    var scopedClubs = clubsInRange(allClubs, applies);

    var record = {
      id: definition.id,
      label: definition.label,
      observation: definition.observation,
      enabled: enabled,
      fired: false,
      reason: '',
      evidenceStrength: 0,
      effectiveThreshold: 0,
      effectStrength: 0,
      direction: 0,
      value: 0,
      route: '',
      routeLabel: '',
      confidence: null,
      requiredShots: 0,
      sampleShots: 0,
      sampleClubs: 0,
      appliesToClubs: scopedClubs.map(function (entry) { return entry.club; }),
      evidence: [],
      effect: REGIONS.reduce(function (out, name) { out[name] = 0; return out; }, {}),
      axisAdjustmentDeg: 0
    };

    if (!cfg.enabled) { record.reason = 'engine_disabled'; return record; }
    if (!enabled) { record.reason = 'signal_disabled'; return record; }
    if (!scopedRows.length) { record.reason = 'no_rows_in_range'; return record; }

    var observation = observeFor(definition, scopedRows, scopedClubs, cfg);
    record.sampleShots = observation.sampleShots;
    record.sampleClubs = observation.sampleClubs;
    record.evidence = observation.evidence;
    record.value = round(observation.value, 4);
    if (!observation.available) { record.reason = observation.reason; return record; }

    record.route = observation.route.id;
    record.routeLabel = observation.route.label;

    var mix = providerMix(scopedRows);
    var confidence = routeConfidence(observation.route.id, mix);
    /* The route's own weight multiplies its provider authority: a proxy route
       on a great monitor is still a proxy. */
    var authority = clamp(confidence.authority * (observation.route.weight === undefined ? 1 : observation.route.weight), 0.05, 1);
    record.confidence = {
      measurement: round(confidence.measurement, 3),
      representation: round(confidence.representation, 3),
      routeWeight: observation.route.weight === undefined ? 1 : observation.route.weight,
      authority: round(authority, 3),
      providerMix: mix
    };

    /* Weak evidence is not given a different model - it is given a bigger
       homework requirement. Same rule, more of it. */
    var requiredShots = Math.min(
      cfg.evidence.maxSampleShots,
      Math.max(
        tuning.minShots === undefined ? definition.minShots : tuning.minShots,
        Math.ceil(cfg.evidence.baseSampleShots / authority)
      )
    );
    record.requiredShots = requiredShots;

    var minClubs = tuning.minClubs === undefined ? definition.minClubs : tuning.minClubs;
    if (observation.sampleClubs < minClubs) { record.reason = 'not_enough_clubs'; return record; }

    var sampleAdequacy = clamp(observation.sampleShots / requiredShots, 0, 1);
    var corroboration = observation.corroborated ? 1 : cfg.evidence.soloRouteWeight;
    /* Authority is NOT a factor here - see evidence.weakRouteThresholdPenalty
       for why. This is purely "how much evidence is there", and the route's
       authority decides how much of it is needed. */
    var evidenceStrength = clamp(
      observation.magnitude * observation.quality * sampleAdequacy * corroboration,
      0, 1
    );
    record.evidenceStrength = round(evidenceStrength, 3);

    var threshold = clamp(
      tuning.evidenceThreshold === undefined ? definition.evidenceThreshold : Number(tuning.evidenceThreshold),
      0, 0.99
    );
    /* The weaker the route, the stronger and more persistent the trend has to
       be. Always leaves headroom below 1 so no route is silently unfirable. */
    var effectiveThreshold = clamp(
      threshold * (1 + cfg.evidence.weakRouteThresholdPenalty * (1 - authority)),
      0, 0.95
    );
    record.effectiveThreshold = round(effectiveThreshold, 3);
    if (evidenceStrength < effectiveThreshold) { record.reason = 'below_evidence_threshold'; return record; }

    /* Above the threshold, effect ramps from zero rather than stepping up - a
       Signal that has only just qualified must not lurch the bubble - and is
       then capped by the route's authority, which is the third thing section
       12 says confidence controls. */
    var effectStrength = clamp((evidenceStrength - effectiveThreshold) / (1 - effectiveThreshold), 0, 1) * authority;
    record.effectStrength = round(effectStrength, 3);
    record.fired = true;
    record.direction = observation.value > 0 ? 1 : observation.value < 0 ? -1 : 0;

    var deformation = tuning.deformation || definition.deformation;
    var maxEffectPct = Math.abs(tuning.maxEffectPct === undefined ? definition.maxEffectPct : Number(tuning.maxEffectPct));
    var negative = record.direction < 0;

    REGIONS.forEach(function (name) {
      var sourceRegion = definition.mirror && negative ? MIRROR_REGION[name] : name;
      var base = Number(deformation[sourceRegion]) || 0;
      /* Mirrored Signals flip WHICH SIDE the shape moves on and keep the
         magnitudes. Unmirrored ones invert the numbers themselves. */
      var signed = definition.mirror ? base * effectStrength : base * effectStrength * (negative ? -1 : 1);
      record.effect[name] = round(clamp(signed, -maxEffectPct, maxEffectPct), 4);
    });

    if (definition.allowAxis) {
      var axisRequest = Math.abs(tuning.axisAdjustmentDeg === undefined ? definition.axisAdjustmentDeg : Number(tuning.axisAdjustmentDeg));
      record.axisAdjustmentDeg = round(
        clamp(axisRequest * effectStrength * record.direction, -cfg.caps.maxAxisDeg, cfg.caps.maxAxisDeg),
        3
      );
    }

    return record;
  }

  function detectSignals(rows, config) {
    var cfg = resolveConfig(config);
    var normalised = normaliseRows(rows);
    var clubs = clubProfiles(normalised);
    return SIGNAL_DEFINITIONS.map(function (definition) {
      return detectSignal(definition, normalised, clubs, cfg);
    });
  }

  /* ---------------------------------------------------------------------
     Micro-Geometry

     One shared deformation system. A Signal contributes region percentages;
     it does not get to invent its own way of drawing anything.
     --------------------------------------------------------------------- */

  function buildMicroGeometry(detected, config) {
    var cfg = resolveConfig(config);
    var geometry = identityGeometry();
    if (!cfg.enabled) return geometry;

    var fired = (Array.isArray(detected) ? detected : []).filter(function (record) { return record && record.fired; });
    if (!fired.length) return geometry;

    var totals = REGIONS.reduce(function (out, name) { out[name] = 0; return out; }, {});
    var axis = 0;

    fired.forEach(function (record) {
      REGIONS.forEach(function (name) {
        totals[name] += Number(record.effect[name]) || 0;
      });
      axis += Number(record.axisAdjustmentDeg) || 0;
    });

    /* Two ceilings, both hard. maxRegionPct bounds any single region;
       maxTotalRegionPct bounds the whole shape's total departure so a stack of
       individually-legal Signals cannot add up to something that is not
       subtle any more. */
    var totalAbs = REGIONS.reduce(function (sum, name) { return sum + Math.abs(totals[name]); }, 0);
    var scale = totalAbs > cfg.caps.maxTotalRegionPct ? cfg.caps.maxTotalRegionPct / totalAbs : 1;

    REGIONS.forEach(function (name) {
      var pct = clamp(totals[name] * scale, -cfg.caps.maxRegionPct, cfg.caps.maxRegionPct);
      geometry[name] = round(1 + pct / 100, 5);
    });
    geometry.axisAdjustmentDeg = round(clamp(axis, -cfg.caps.maxAxisDeg, cfg.caps.maxAxisDeg), 3);
    return geometry;
  }

  function isIdentityGeometry(geometry) {
    if (!geometry) return true;
    if (Math.abs(Number(geometry.axisAdjustmentDeg) || 0) > 1e-9) return false;
    return REGIONS.every(function (name) {
      var value = geometry[name];
      return value === undefined || Math.abs(Number(value) - 1) < 1e-9;
    });
  }

  /* Periodic Catmull-Rom through the eight control values.

     Why not just a cosine blend between neighbours: the control points are 45
     degrees apart, and a linear or cosine blend leaves a visible crease at
     every one of them once the shape is exaggerated 10x in Studio. Catmull-Rom
     is C1 continuous and still passes exactly through each control value, so
     the region table Studio prints is literally what the ring does there. */
  function microGeometryFactor(geometry, rel, exaggeration) {
    if (!geometry) return 1;
    var exaggerate = Number(exaggeration);
    if (!Number.isFinite(exaggerate)) exaggerate = 1;

    var values = REGIONS.map(function (name) {
      var value = Number(geometry[name]);
      return Number.isFinite(value) ? value : 1;
    });

    var step = (PI * 2) / values.length;
    var angle = Number(rel) || 0;
    /* Bring into [0, 2pi) without assuming the caller already did. */
    angle = angle % (PI * 2);
    if (angle < 0) angle += PI * 2;

    var index = Math.floor(angle / step);
    var t = (angle - index * step) / step;
    var n = values.length;
    var p0 = values[(index - 1 + n) % n];
    var p1 = values[index % n];
    var p2 = values[(index + 1) % n];
    var p3 = values[(index + 2) % n];

    var t2 = t * t;
    var t3 = t2 * t;
    var interpolated = 0.5 * (
      2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );

    return 1 + (interpolated - 1) * exaggerate;
  }

  /* The ring Studio draws, and the same numbers the engine multiplies by. */
  function geometryRing(geometry, steps, exaggeration) {
    var count = Math.max(24, Number(steps) || 168);
    var points = [];
    for (var i = 0; i < count; i++) {
      var rel = (PI * 2 * i) / count;
      points.push({ rel: rel, factor: microGeometryFactor(geometry, rel, exaggeration) });
    }
    return points;
  }

  /* ---------------------------------------------------------------------
     Player model

     The compact, versioned payload the phone hydrates. The app does not need
     to know why longRight is 1.006 - only how to render the approved geometry.
     --------------------------------------------------------------------- */

  /* A short human label for the pattern, from the observations themselves. */
  function describePattern(detected, offsetDeg) {
    var parts = [];
    var curvature = detected.filter(function (r) { return r.id === 'curvature_bias' && r.fired; })[0];
    if (curvature) parts.push(curvature.direction > 0 ? 'fade-side curvature' : 'draw-side curvature');
    var exposure = detected.filter(function (r) { return r.id === 'flight_exposure' && r.fired; })[0];
    if (exposure) parts.push(exposure.direction > 0 ? 'high flight' : 'low flight');
    var rollout = detected.filter(function (r) { return r.id === 'rollout_character' && r.fired; })[0];
    if (rollout) parts.push(rollout.direction > 0 ? 'running long clubs' : 'stopping long clubs');
    if (!parts.length) {
      if (Math.abs(offsetDeg) < 0.6) return 'centred';
      return offsetDeg > 0 ? 'right of centre' : 'left of centre';
    }
    return parts.join(', ');
  }

  /* Observed lateral spread against the spread the club ratios already
     predict. 1.0 means the engine's normal dispersion is right for this
     player; the engine clamps it to its own 0.6..1.8 window downstream. */
  function deriveDispersionScale(rows, expectedLateralRatio) {
    var angles = rows.map(function (row) { return row.normalizedDeg; }).filter(function (v) { return v !== null; });
    if (angles.length < 5) return 1;
    var spreadDeg = stdDev(angles);
    var expectedDeg = Number(expectedLateralRatio) > 0 ? Number(expectedLateralRatio) : 2.6;
    if (!(spreadDeg > 0)) return 1;
    return round(clamp(spreadDeg / expectedDeg, 0.6, 1.8), 3);
  }

  /* Representative clubs spaced through the bag. Named clubs are used when the
     player has them; otherwise the bag is sampled evenly, because the point is
     to SHOW THE PROGRESSION, not to insist on five particular club names. */
  function representativeProjection(clubs, requested) {
    if (!clubs.length) return [];
    var wanted = (Array.isArray(requested) ? requested : []).map(function (c) { return String(c).trim().toLowerCase(); });
    var matched = wanted.map(function (name) {
      return clubs.filter(function (entry) { return entry.club.trim().toLowerCase() === name; })[0] || null;
    }).filter(Boolean);
    if (matched.length >= 3) {
      return matched.map(function (entry) { return { club: entry.club, carryM: round(entry.carryM, 1), fromData: true }; });
    }
    var count = Math.min(5, clubs.length);
    var out = [];
    for (var i = 0; i < count; i++) {
      var index = count === 1 ? 0 : Math.round((i * (clubs.length - 1)) / (count - 1));
      var entry = clubs[index];
      if (!out.some(function (existing) { return existing.club === entry.club; })) {
        out.push({ club: entry.club, carryM: round(entry.carryM, 1), fromData: true });
      }
    }
    return out;
  }

  /* THE entry point. rows in, versioned player model out.

     `base.offsetDeg` is passed IN, not computed here: the aim belongs to My
     Bubble and only Practice Bubble adoption may change it (Bubble Bible s1).
     This layer reads it so the payload is complete for the app, and never
     writes back to it. */
  function buildPlayerModel(input) {
    input = input || {};
    var cfg = resolveConfig(input.config);
    var normalised = normaliseRows(input.rows);
    var clubs = clubProfiles(normalised);
    var detected = SIGNAL_DEFINITIONS.map(function (definition) {
      return detectSignal(definition, normalised, clubs, cfg);
    });
    var geometry = buildMicroGeometry(detected, cfg);

    var offsetDeg = asNumber(input.offsetDeg);
    if (offsetDeg === null) offsetDeg = 0;
    var handedness = input.handedness === 'left' ? 'left' : 'right';

    var signals = {};
    detected.forEach(function (record) {
      signals[record.id] = {
        fired: record.fired,
        enabled: record.enabled,
        evidenceStrength: record.evidenceStrength,
        effectStrength: record.effectStrength,
        direction: record.direction,
        route: record.route,
        reason: record.reason
      };
    });

    return {
      bubbleModelVersion: MODEL_VERSION,
      configVersion: cfg.configVersion,
      engineEnabled: !!cfg.enabled,
      generatedAt: typeof input.generatedAt === 'string' ? input.generatedAt : null,
      base: {
        offsetDeg: round(offsetDeg, 3),
        handedness: handedness,
        dispersionScale: deriveDispersionScale(normalised, input.expectedLateralSpreadDeg),
        playerPattern: describePattern(detected, offsetDeg),
        sampleShots: normalised.length,
        clubsSeen: clubs.length
      },
      geometry: geometry,
      signals: signals,
      projection: {
        referenceCarryM: clubs.length ? round(median(clubs.map(function (entry) { return entry.carryM; })), 1) : null,
        minCarryM: clubs.length ? round(clubs[0].carryM, 1) : null,
        maxCarryM: clubs.length ? round(clubs[clubs.length - 1].carryM, 1) : null,
        clubs: clubs.map(function (entry) {
          return { club: entry.club, carryM: round(entry.carryM, 1), totalM: entry.totalM === null ? null : round(entry.totalM, 1), shots: entry.shots };
        }),
        representativeClubs: representativeProjection(clubs, cfg.representativeClubs)
      },
      /* Diagnostic only. compactModel() strips it for the phone. */
      detected: detected
    };
  }

  /* What actually travels to the phone: the approved geometry and enough to
     project it, with the detection reasoning left behind. */
  function compactModel(model) {
    if (!model) return null;
    return {
      bubbleModelVersion: model.bubbleModelVersion,
      configVersion: model.configVersion,
      engineEnabled: model.engineEnabled,
      generatedAt: model.generatedAt,
      base: model.base,
      geometry: model.geometry,
      signals: model.signals,
      projection: {
        referenceCarryM: model.projection.referenceCarryM,
        minCarryM: model.projection.minCarryM,
        maxCarryM: model.projection.maxCarryM,
        representativeClubs: model.projection.representativeClubs
      }
    };
  }

  /* True when a cached model is one this build knows how to render. An older
     phone must fall back to the plain bubble rather than guess. */
  function modelIsUsable(model) {
    return !!model
      && Number(model.bubbleModelVersion) === MODEL_VERSION
      && !!model.geometry
      && REGIONS.every(function (name) { return Number.isFinite(Number(model.geometry[name])); });
  }

  return {
    MODEL_VERSION: MODEL_VERSION,
    CONFIG_VERSION: CONFIG_VERSION,
    REGIONS: REGIONS,
    REGION_LABELS: REGION_LABELS,
    REGION_ANGLES: REGION_ANGLES,
    MIRROR_REGION: MIRROR_REGION,
    IDENTITY_GEOMETRY: IDENTITY_GEOMETRY,
    SIGNAL_DEFINITIONS: SIGNAL_DEFINITIONS,
    EVIDENCE_ROUTES: EVIDENCE_ROUTES,
    PROVIDER_CONFIDENCE: PROVIDER_CONFIDENCE,
    ROUTE_PROVIDER_OVERRIDES: ROUTE_PROVIDER_OVERRIDES,
    defaultConfig: defaultConfig,
    resolveConfig: resolveConfig,
    identityGeometry: identityGeometry,
    normaliseRow: normaliseRow,
    normaliseRows: normaliseRows,
    clubProfiles: clubProfiles,
    providerMix: providerMix,
    routeConfidence: routeConfidence,
    signalDefinition: signalDefinition,
    detectSignal: detectSignal,
    detectSignals: detectSignals,
    buildMicroGeometry: buildMicroGeometry,
    isIdentityGeometry: isIdentityGeometry,
    microGeometryFactor: microGeometryFactor,
    geometryRing: geometryRing,
    buildPlayerModel: buildPlayerModel,
    compactModel: compactModel,
    modelIsUsable: modelIsUsable,
    /* exported for the generator and the tests */
    median: median,
    mean: mean,
    stdDev: stdDev,
    linearFit: linearFit,
    signConsistency: signConsistency,
    clamp: clamp,
    round: round
  };
});
