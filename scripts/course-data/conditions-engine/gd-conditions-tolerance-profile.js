(function () {
  'use strict';

  /*
    Conditions Engine tolerance profiles.

    Single, versioned home for every threshold and physical constant the
    Conditions Engine uses. Nothing in the engine may hard-code a number that
    belongs here — every analysis record stores the exact profile version it
    ran under so a historical result stays explainable after tolerances move.

    Profiles are immutable once published. To change a tolerance, register a
    new version; never edit an existing one in place.
  */

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  var PROFILE_ID = 'conditions-default';

  /*
    The profile used when a caller does not name one. Declared explicitly rather
    than derived by sorting version strings: '1.10.0' sorts below '1.9.0'
    lexically, and the default must never move on its own when a new profile is
    registered for comparison purposes.
  */
  var DEFAULT_VERSION = '1.1.0';

  // Named confidence levels seen on live environmental payloads
  // (the elevation channel emits 'none' / 'medium'; wind emits none today).
  var CONFIDENCE_SCALE = {
    none: 0,
    unknown: 0,
    low: 0.25,
    medium: 0.6,
    high: 0.9,
    exact: 1
  };

  var PROFILES = {};

  function freeze(value) {
    if (!value || typeof value !== 'object') return value;
    Object.keys(value).forEach(function (key) { freeze(value[key]); });
    return Object.freeze(value);
  }

  function register(profile) {
    var frozen = freeze(profile);
    PROFILES[frozen.version] = frozen;
    return frozen;
  }

  register({
    profileId: PROFILE_ID,
    version: '1.0.0',
    notes: 'Initial profile. Wind and slope models mirror the pre-existing GPS Play maths so analytical output stays consistent with what players saw in-round.',

    // --- Wind significance gates -------------------------------------------
    // Wind at or below level 1 is treated as effectively neutral: no variant.
    minimumWindScaleLevel: 1,
    minimumWindConfidence: 0.5,
    minimumWindEffectMetres: 3,

    // --- Slope significance gates ------------------------------------------
    minimumSlopeConfidence: 0.5,
    minimumSlopeEffectMetres: 2,

    // --- Variant selection safeguards --------------------------------------
    minimumBubbleFitImprovement: 0.05,
    // Kept below the largest correction the wind model can produce
    // (12 m x level 3 = 36 m) so the safeguard is actually reachable rather
    // than being a cap no real correction can ever hit.
    maximumCorrectionDistanceMetres: 25,
    maximumCorrectionDegrees: 25,
    minimumSelectionConfidence: 0.5,

    // Environmental evidence older than this is refused as stale.
    maximumEnvironmentalDataAgeMs: 1800000, // 30 minutes

    // --- Physical models ----------------------------------------------------
    // Wind drift magnitude, mirroring gdWindEffectMeters in gd-app-core.js:
    //   base = clamp(carry * windCarryFactor, min, max); effect = base * level
    windModel: {
      carryFactor: 0.045,
      minEffectMetres: 4,
      maxEffectMetres: 12,
      maxScaleLevel: 3,
      minCarryMetres: 40,
      maxCarryMetres: 260,
      fallbackCarryMetres: 140
    },

    // Slope plays-like model, mirroring gdSlopeAdjustedDistanceData:
    // a 1:1 metre-for-metre translation of elevation delta into distance.
    slopeModel: {
      metresPerMetreOfRise: 1,
      levelBandMetres: 0.5
    },

    // Shot geometry sanity limits used by input validation.
    shotLimits: {
      minShotDistanceMetres: 5,
      maxShotDistanceMetres: 500,
      maxGpsAccuracyMetres: 25
    }
  });

  /*
    Profile 1.1.0 — directional wind model.

    1.0.0 split a fixed magnitude between distance and lateral by pure cos/sin,
    so the total displacement was identical at every wind angle: a dead
    crosswind moved the ball exactly as far sideways as a dead headwind moved it
    short. This profile breaks that conserved budget.

      - The along-line component always applies, scaled by cos, with separate
        factors for hurting (headwind) and helping (tailwind).
      - The lateral component only applies once the wind is clearly across the
        shot line, i.e. outside the crosswindGateDegrees band either side.
        Below that the wind is treated as purely a distance effect, which keeps
        small quartering winds from injecting noise into the lateral axis --
        the axis the bubble is tightest on.

    Every other tolerance is unchanged from 1.0.0.
  */
  register({
    profileId: PROFILE_ID,
    version: '1.1.0',
    notes: 'Adds a directional wind model: head/tail asymmetry on the along-line component, and a crosswind gate so lateral only applies when the wind is clearly across the shot line.',

    minimumWindScaleLevel: 1,
    minimumWindConfidence: 0.5,
    minimumWindEffectMetres: 3,

    minimumSlopeConfidence: 0.5,
    minimumSlopeEffectMetres: 2,

    minimumBubbleFitImprovement: 0.05,
    maximumCorrectionDistanceMetres: 25,
    maximumCorrectionDegrees: 25,
    minimumSelectionConfidence: 0.5,

    maximumEnvironmentalDataAge: 1800000,

    // Rescue-only: a correction may apply only when it improves the Bubble fit,
    // so a shot the wind pushed INTO the bubble is never demoted. The symmetric
    // counterfactual is still recorded on every analysis.
    variantSelectionPolicy: 'rescue-only',

    windModel: {
      carryFactor: 0.045,
      minEffectMetres: 4,
      maxEffectMetres: 12,
      maxScaleLevel: 3,
      minCarryMetres: 40,
      maxCarryMetres: 260,
      fallbackCarryMetres: 140,

      // Admin-tunable. Defaults are rules of thumb, not measured values --
      // they exist to be tuned against real rounds via the bias readout.
      headwindFactor: 1,      // how much a headwind hurts
      tailwindFactor: 0.55,   // how much a tailwind helps (less than it hurts)
      crosswindFactor: 0.65,  // lateral push, once the gate opens
      crosswindGateDegrees: 45
    },

    slopeModel: {
      metresPerMetreOfRise: 1,
      levelBandMetres: 0.5
    },

    shotLimits: {
      minShotDistanceMetres: 5,
      maxShotDistanceMetres: 500,
      maxGpsAccuracyMetres: 25
    }
  });

  function resolve(version) {
    if (!version) return PROFILES[DEFAULT_VERSION];
    return PROFILES[version] || null;
  }

  /* The active default. Not necessarily the highest version number registered:
     older profiles stay resolvable so historical analyses remain explainable
     and so reprocessing can compare models. */
  function latest() {
    return PROFILES[DEFAULT_VERSION];
  }

  function listVersions() {
    return Object.keys(PROFILES).sort();
  }

  /*
    Environmental confidence arrives either as a 0..1 number or as one of the
    named levels above. Anything unrecognised scores 0 so an unknown source can
    never satisfy a confidence gate by accident.
  */
  // FNV-1a over the overridden values. Same overrides always produce the same
  // version suffix, so a profile is identified by its contents, not by when it
  // happened to be edited.
  function signature(text) {
    var hash = 2166136261;
    var str = String(text);
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return ('00000000' + hash.toString(16)).slice(-8);
  }

  var WIND_MODEL_OVERRIDES = ['headwindFactor', 'tailwindFactor', 'crosswindFactor', 'crosswindGateDegrees'];

  /*
    Apply admin overrides to a base profile.

    Published profiles are immutable, so an admin edit does not mutate one -- it
    derives a new profile whose version carries a hash of the overridden values,
    e.g. '1.1.0+a3f2c1d4'. Every analysis records the version it ran under, so a
    result stays explainable after the dials move, and reprocessing under the
    old version reproduces the old verdict exactly.

    Returns the base profile unchanged when nothing actually differs, so routine
    analysis does not accumulate pointless version identities.
  */
  function derive(baseVersion, overrides) {
    var base = resolve(baseVersion);
    if (!base) return null;
    if (!overrides || typeof overrides !== 'object') return base;

    var windOverrides = {};
    var changed = false;
    WIND_MODEL_OVERRIDES.forEach(function (key) {
      var value = Number(overrides[key]);
      if (!Number.isFinite(value)) return;
      if (value === Number(base.windModel[key])) return;
      windOverrides[key] = value;
      changed = true;
    });

    if (!changed) return base;

    var windModel = {};
    Object.keys(base.windModel).forEach(function (key) { windModel[key] = base.windModel[key]; });
    Object.keys(windOverrides).forEach(function (key) { windModel[key] = windOverrides[key]; });

    var derived = {};
    Object.keys(base).forEach(function (key) { derived[key] = base[key]; });
    derived.windModel = windModel;
    derived.version = base.version + '+' + signature(JSON.stringify(windOverrides));
    derived.derivedFrom = base.version;
    derived.overrides = windOverrides;

    return freeze(derived);
  }

  function normaliseConfidence(value) {
    var n = Number(value);
    if (Number.isFinite(n)) {
      if (n < 0) return 0;
      if (n > 1) return 1;
      return n;
    }
    var key = String(value == null ? '' : value).toLowerCase().trim();
    return Object.prototype.hasOwnProperty.call(CONFIDENCE_SCALE, key) ? CONFIDENCE_SCALE[key] : 0;
  }

  var api = {
    PROFILE_ID: PROFILE_ID,
    DEFAULT_VERSION: DEFAULT_VERSION,
    CONFIDENCE_SCALE: CONFIDENCE_SCALE,
    resolve: resolve,
    derive: derive,
    WIND_MODEL_OVERRIDES: WIND_MODEL_OVERRIDES,
    latest: latest,
    listVersions: listVersions,
    normaliseConfidence: normaliseConfidence
  };

  root.modules.conditionsToleranceProfile = api;
  window.GolfDaddyConditionsToleranceProfile = api;
  window.ClarityCaddieConditionsToleranceProfile = api;
  if (window.ClarityCaddie) window.ClarityCaddie.modules = root.modules;
})();
