(function () {
  'use strict';

  /*
    Course Data intake.

    THE single entry point for Course Data shot processing. GPS Play submits an
    immutable Shot Snapshot here and returns immediately; everything downstream
    (persistence, Conditions Engine, versioned analysis records, failure
    recording, reprocessing) is owned by this module.

    Ordering guarantees:
      1. validate the incoming Shot Snapshot
      2. persist the immutable raw snapshot SYNCHRONOUSLY (durability first)
      3. return to GPS Play without waiting for analysis
      4. invoke the Conditions Engine on a deferred tick
      5. store a versioned analysis result
      6. on failure, fall back to the raw outcome and record it for reprocessing

    The raw snapshot is written exactly once. Re-submitting the same shotId is
    idempotent; a conflicting re-submission is refused rather than overwriting.
  */

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  var SNAPSHOT_KEY = 'gd_shot_snapshots_v1';
  var ANALYSIS_KEY = 'gd_conditions_analyses_v1';
  var BUBBLE_VERSION_KEY = 'gd_my_bubble_versions_v1';
  var STORE_VERSION = 1;
  var MAX_ANALYSES_PER_SHOT = 20;

  function engine() {
    return (root.modules && root.modules.conditionsEngine) || window.GolfDaddyConditionsEngine;
  }

  function geometry() {
    return (root.modules && root.modules.conditionsGeometry) || window.GolfDaddyConditionsGeometry;
  }

  function tolerances() {
    return (root.modules && root.modules.conditionsToleranceProfile) || window.GolfDaddyConditionsToleranceProfile;
  }

  /*
    Current admin settings for the directional wind model, from the same dev()
    tuning store every other Course Data control uses. Absent in headless
    contexts (tests, tooling), in which case the base profile applies unchanged.
  */
  function readAdminWindOverrides() {
    if (typeof window.dev !== 'function') return null;
    var overrides = {};
    var found = false;
    [
      ['headwindFactor', 'conditionsEngine.headwindFactor'],
      ['tailwindFactor', 'conditionsEngine.tailwindFactor'],
      ['crosswindFactor', 'conditionsEngine.crosswindFactor'],
      ['crosswindGateDegrees', 'conditionsEngine.crosswindGateDeg']
    ].forEach(function (pair) {
      var value;
      try { value = Number(window.dev(pair[1])); } catch (e) { return; }
      if (!Number.isFinite(value)) return;
      overrides[pair[0]] = value;
      found = true;
    });
    return found ? overrides : null;
  }

  /*
    The profile an analysis should run under. Named historical versions resolve
    exactly as recorded so reprocessing reproduces the original verdict; only
    the active default picks up current admin dials, and it does so by deriving
    a new version rather than mutating a published one.
  */
  function activeProfile(requestedVersion) {
    var tol = tolerances();
    if (!tol) return null;
    if (requestedVersion) return tol.resolve(requestedVersion);
    return tol.derive(null, readAdminWindOverrides());
  }

  function storage() {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
    } catch (e) { /* access can throw in locked-down contexts */ }
    return null;
  }

  function readStore(key, seed) {
    var store = storage();
    if (!store) return seed();
    try {
      var raw = store.getItem(key);
      if (!raw) return seed();
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : seed();
    } catch (e) {
      return seed();
    }
  }

  function writeStore(key, value) {
    var store = storage();
    if (!store) return false;
    try {
      value.updatedAt = new Date().toISOString();
      store.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function seedSnapshots() { return { version: STORE_VERSION, snapshots: {}, updatedAt: null }; }
  function seedAnalyses() { return { version: STORE_VERSION, analyses: {}, active: {}, failures: {}, updatedAt: null }; }
  function seedBubbleVersions() { return { version: STORE_VERSION, versions: {}, updatedAt: null }; }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object') return value;
    Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
    return Object.freeze(value);
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  // FNV-1a. Stable across sessions, which is what a version identity needs.
  function fingerprint(text) {
    var hash = 2166136261;
    var str = String(text);
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return ('00000000' + hash.toString(16)).slice(-8);
  }

  function makeId(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  // ---------------------------------------------------------------------------
  // My Bubble version registry (read-only view of My Bubble)
  // ---------------------------------------------------------------------------

  /*
    My Bubble has no native version identity, so Course Data derives one from the
    bubble's own geometry and stores a frozen copy alongside it. A shot captured
    today stays analysable against the geometry that was live at capture time,
    even if My Bubble is later edited. Registering NEVER mutates My Bubble.
  */
  function registerMyBubbleVersion(bubble, meta) {
    var geo = geometry();
    if (!geo) return null;
    var normalised = geo.normaliseBubble(bubble);
    if (!normalised) return null;

    var signature = [
      normalised.club || '',
      normalised.centerLat.toFixed(6),
      normalised.centerLng.toFixed(6),
      normalised.orientationDeg.toFixed(3),
      normalised.widthM.toFixed(3),
      normalised.depthM.toFixed(3),
      normalised.offsetDeg.toFixed(3),
      normalised.carryM == null ? '' : Number(normalised.carryM).toFixed(2),
      normalised.totalM == null ? '' : Number(normalised.totalM).toFixed(2)
    ].join('|');

    var versionId = 'mb_' + fingerprint(signature);
    var store = readStore(BUBBLE_VERSION_KEY, seedBubbleVersions);

    if (!store.versions[versionId]) {
      normalised.versionId = versionId;
      store.versions[versionId] = {
        versionId: versionId,
        signature: signature,
        geometry: normalised,
        source: (meta && meta.source) || normalised.source || null,
        bagVersionId: (meta && meta.bagVersionId) || null,
        registeredAt: new Date().toISOString()
      };
      writeStore(BUBBLE_VERSION_KEY, store);
    }

    return clone(store.versions[versionId]);
  }

  function getMyBubbleVersion(versionId) {
    if (!versionId) return null;
    var store = readStore(BUBBLE_VERSION_KEY, seedBubbleVersions);
    return clone(store.versions[versionId]) || null;
  }

  // ---------------------------------------------------------------------------
  // Snapshot persistence
  // ---------------------------------------------------------------------------

  function validateSnapshot(snapshot) {
    var errors = [];
    if (!snapshot || typeof snapshot !== 'object') {
      return ['MISSING_SNAPSHOT'];
    }
    if (!snapshot.shotId) errors.push('MISSING_SHOT_ID');
    var geo = geometry();
    if (!geo || !geo.hasLatLng(snapshot.shotStartPosition)) errors.push('INVALID_START_POSITION');
    if (!geo || !geo.hasLatLng(snapshot.shotLandingPosition)) errors.push('INVALID_LANDING_POSITION');
    if (!snapshot.capturedAt) errors.push('MISSING_CAPTURED_AT');
    return errors;
  }

  function snapshotSignature(snapshot) {
    return fingerprint(JSON.stringify({
      shotId: snapshot.shotId,
      capturedAt: snapshot.capturedAt,
      start: snapshot.shotStartPosition,
      landing: snapshot.shotLandingPosition,
      target: snapshot.targetPosition,
      clubId: snapshot.clubId,
      snapshotVersion: snapshot.snapshotVersion
    }));
  }

  function getSnapshot(shotId) {
    if (!shotId) return null;
    var store = readStore(SNAPSHOT_KEY, seedSnapshots);
    var record = store.snapshots[shotId];
    return record ? clone(record.snapshot) : null;
  }

  function listSnapshots() {
    var store = readStore(SNAPSHOT_KEY, seedSnapshots);
    return Object.keys(store.snapshots).map(function (id) { return clone(store.snapshots[id].snapshot); });
  }

  function persistSnapshot(snapshot) {
    var store = readStore(SNAPSHOT_KEY, seedSnapshots);
    var existing = store.snapshots[snapshot.shotId];
    var signature = snapshotSignature(snapshot);

    if (existing) {
      // Idempotent re-submission: identical content is a no-op, and the stored
      // raw snapshot is never replaced. A different payload under the same
      // shotId is a conflict, not an update.
      return {
        stored: false,
        duplicate: true,
        conflict: existing.signature !== signature,
        signature: existing.signature
      };
    }

    store.snapshots[snapshot.shotId] = {
      signature: signature,
      receivedAt: new Date().toISOString(),
      snapshot: snapshot
    };
    writeStore(SNAPSHOT_KEY, store);
    return { stored: true, duplicate: false, conflict: false, signature: signature };
  }

  // ---------------------------------------------------------------------------
  // Analysis records
  // ---------------------------------------------------------------------------

  function buildAnalysisRecord(analysisId, snapshot, result) {
    return {
      analysisId: analysisId,
      shotId: snapshot.shotId,
      roundId: snapshot.roundId || null,
      playerId: snapshot.playerId || null,
      holeNumber: snapshot.holeNumber == null ? null : snapshot.holeNumber,
      clubId: snapshot.clubId || null,

      engineVersion: result.engineVersion,
      toleranceProfileVersion: result.toleranceProfileVersion,
      // The exact coefficients used, stored alongside the version so a result
      // stays readable without having to resolve a derived profile later.
      effectiveWindModel: result.toleranceProfile ? result.toleranceProfile.windModel : null,
      processedAt: result.processedAt,
      myBubbleVersionId: result.bubbleVersionId || snapshot.myBubbleVersionId || null,

      rawPosition: result.rawPosition,
      rawBubbleFit: result.rawBubbleFit || null,

      windVariant: pickVariant(result, 'windNormalised'),
      slopeVariant: pickVariant(result, 'slopeNormalised'),
      combinedVariant: pickVariant(result, 'combinedNormalised'),

      selectedVariant: result.selectedVariant,
      selectedAnalyticalPosition: result.selectedAnalyticalPosition,
      selectedBubbleFit: result.selectedBubbleFit || null,
      bubbleFitImprovement: result.bubbleFitImprovement,

      normalisationApplied: result.normalisationApplied,
      normalisationType: result.normalisationType,
      normalisationConfidence: result.normalisationConfidence,

      userSelectedWind: result.userSelectedWind,
      userSelectedSlope: result.userSelectedSlope,

      windEvidence: result.windEvidence,
      slopeEvidence: result.slopeEvidence,

      // The rescue-only counterfactual. Recorded, never acted on.
      symmetricEvaluation: result.symmetricEvaluation || null,

      processingWarnings: result.processingWarnings || [],
      debugFlags: result.debugFlags || {},
      status: result.status
    };
  }

  function pickVariant(result, type) {
    var found = null;
    (result.candidateVariants || []).forEach(function (variant) {
      if (variant.variantType === type) found = variant;
    });
    return found;
  }

  function storeAnalysis(record, options) {
    options = options || {};
    var store = readStore(ANALYSIS_KEY, seedAnalyses);
    var list = store.analyses[record.shotId] || [];

    // Earlier analysis records are never overwritten — they are the audit trail
    // that makes a tolerance or engine change explainable after the fact.
    list.push(record);
    if (list.length > MAX_ANALYSES_PER_SHOT) list = list.slice(list.length - MAX_ANALYSES_PER_SHOT);
    store.analyses[record.shotId] = list;

    if (options.markActive !== false) {
      store.active[record.shotId] = record.analysisId;
    }

    if (record.status === 'failed') {
      store.failures[record.shotId] = {
        analysisId: record.analysisId,
        at: record.processedAt,
        warnings: record.processingWarnings,
        debugFlags: record.debugFlags
      };
    } else {
      delete store.failures[record.shotId];
    }

    writeStore(ANALYSIS_KEY, store);
    return record;
  }

  function listAnalyses(shotId) {
    var store = readStore(ANALYSIS_KEY, seedAnalyses);
    return clone(store.analyses[shotId] || []);
  }

  function getActiveAnalysis(shotId) {
    var store = readStore(ANALYSIS_KEY, seedAnalyses);
    var activeId = store.active[shotId];
    var list = store.analyses[shotId] || [];
    var found = null;
    list.forEach(function (record) { if (record.analysisId === activeId) found = record; });
    return clone(found);
  }

  function setActiveAnalysis(shotId, analysisId) {
    var store = readStore(ANALYSIS_KEY, seedAnalyses);
    var list = store.analyses[shotId] || [];
    var exists = list.some(function (record) { return record.analysisId === analysisId; });
    if (!exists) return false;
    store.active[shotId] = analysisId;
    writeStore(ANALYSIS_KEY, store);
    return true;
  }

  function listFailures() {
    var store = readStore(ANALYSIS_KEY, seedAnalyses);
    return clone(store.failures);
  }

  // ---------------------------------------------------------------------------
  // Analysis execution
  // ---------------------------------------------------------------------------

  function resolveBubbleForSnapshot(snapshot, override) {
    if (override) return override;
    // Prefer the geometry frozen onto the snapshot at capture time, then the
    // registry entry for its version. We never fall through to "whatever My
    // Bubble is now" — that would silently compare a historical shot against a
    // newer bubble.
    if (snapshot.myBubbleGeometry) return snapshot.myBubbleGeometry;
    if (snapshot.myBubbleVersionId) {
      var version = getMyBubbleVersion(snapshot.myBubbleVersionId);
      if (version) return version.geometry;
    }
    return null;
  }

  function runAnalysis(shotId, options) {
    options = options || {};
    var snapshot = options.snapshot || getSnapshot(shotId);
    var analysisId = options.analysisId || makeId('an');
    var conditions = engine();

    if (!snapshot) {
      return storeAnalysis(buildAnalysisRecord(analysisId, { shotId: shotId }, {
        status: 'failed',
        engineVersion: options.engineVersion || null,
        toleranceProfileVersion: options.toleranceProfileVersion || null,
        processedAt: new Date().toISOString(),
        rawPosition: null,
        selectedAnalyticalPosition: null,
        selectedVariant: 'raw',
        normalisationApplied: false,
        normalisationType: null,
        normalisationConfidence: null,
        bubbleFitImprovement: 0,
        userSelectedWind: false,
        userSelectedSlope: false,
        candidateVariants: [],
        processingWarnings: ['SNAPSHOT_NOT_FOUND'],
        debugFlags: { errors: ['SNAPSHOT_NOT_FOUND'] }
      }), options);
    }

    var bubble = resolveBubbleForSnapshot(snapshot, options.activeMyBubble);
    var result;

    try {
      if (!conditions) throw new Error('CONDITIONS_ENGINE_UNAVAILABLE');
      if (!bubble) {
        // Older records without a linked bubble stay intact with their raw
        // outcome; we mark reprocessing unavailable rather than inventing
        // environmental evidence or borrowing today's bubble.
        result = {
          status: 'unavailable',
          engineVersion: options.engineVersion || conditions.ENGINE_VERSION,
          toleranceProfileVersion: options.toleranceProfileVersion || null,
          processedAt: new Date().toISOString(),
          rawPosition: snapshot.shotLandingPosition,
          selectedAnalyticalPosition: snapshot.shotLandingPosition,
          selectedVariant: 'raw',
          normalisationApplied: false,
          normalisationType: null,
          normalisationConfidence: null,
          rawBubbleFit: null,
          selectedBubbleFit: null,
          bubbleFitImprovement: 0,
          userSelectedWind: snapshot.userSelectedWind === true,
          userSelectedSlope: snapshot.userSelectedSlope === true,
          windEvidence: null,
          slopeEvidence: null,
          candidateVariants: [],
          processingWarnings: ['ENVIRONMENTAL_REPROCESSING_UNAVAILABLE', 'NO_LINKED_MY_BUBBLE_VERSION'],
          debugFlags: { reprocessingAvailable: false }
        };
      } else {
        result = conditions.analyse({
          shotSnapshot: snapshot,
          activeMyBubble: bubble,
          toleranceProfile: activeProfile(options.toleranceProfileVersion),
          toleranceProfileVersion: options.toleranceProfileVersion,
          engineVersion: options.engineVersion,
          analysisId: analysisId
        });
      }
    } catch (error) {
      // Prefer a visible diagnostic failure over hidden fallback maths: the raw
      // outcome stands, and the error is stored for later reprocessing.
      result = {
        status: 'failed',
        engineVersion: options.engineVersion || null,
        toleranceProfileVersion: options.toleranceProfileVersion || null,
        processedAt: new Date().toISOString(),
        rawPosition: snapshot.shotLandingPosition,
        selectedAnalyticalPosition: snapshot.shotLandingPosition,
        selectedVariant: 'raw',
        normalisationApplied: false,
        normalisationType: null,
        normalisationConfidence: null,
        bubbleFitImprovement: 0,
        userSelectedWind: snapshot.userSelectedWind === true,
        userSelectedSlope: snapshot.userSelectedSlope === true,
        windEvidence: null,
        slopeEvidence: null,
        candidateVariants: [],
        processingWarnings: ['CONDITIONS_ENGINE_THREW'],
        debugFlags: {
          errorMessage: error && error.message ? String(error.message) : String(error),
          errorStack: error && error.stack ? String(error.stack) : null
        }
      };
    }

    return storeAnalysis(buildAnalysisRecord(analysisId, snapshot, result), options);
  }

  function defer(fn) {
    if (typeof setTimeout === 'function') { setTimeout(fn, 0); return; }
    fn();
  }

  /*
    GPS Play calls this at shot completion. It persists the raw snapshot and
    returns synchronously — analysis runs on a later tick so the round is never
    blocked, and a thrown engine still leaves the raw shot saved.
  */
  function submitShotSnapshot(snapshot, options) {
    options = options || {};
    var errors = validateSnapshot(snapshot);
    if (errors.length) {
      return { accepted: false, shotId: snapshot && snapshot.shotId, errors: errors, duplicate: false, analysisScheduled: false };
    }

    var frozen = deepFreeze(clone(snapshot));
    var persisted = persistSnapshot(frozen);

    if (persisted.duplicate) {
      return {
        accepted: true,
        shotId: frozen.shotId,
        errors: persisted.conflict ? ['SNAPSHOT_CONFLICT_IGNORED'] : [],
        duplicate: true,
        conflict: persisted.conflict,
        analysisScheduled: false
      };
    }

    var scheduled = false;
    if (options.analyse !== false) {
      scheduled = true;
      var run = function () {
        try {
          runAnalysis(frozen.shotId, {
            snapshot: frozen,
            engineVersion: options.engineVersion,
            toleranceProfileVersion: options.toleranceProfileVersion,
            activeMyBubble: options.activeMyBubble
          });
        } catch (e) { /* runAnalysis already records failures; never surface to play */ }
      };
      if (options.synchronous === true) run(); else defer(run);
    }

    return { accepted: true, shotId: frozen.shotId, errors: [], duplicate: false, conflict: false, analysisScheduled: scheduled };
  }

  /*
    Historical reprocessing. Creates a NEW analysis record against a specified
    engine/tolerance version, preserves every previous record, and never touches
    the raw snapshot.
  */
  function reprocessShot(shotId, options) {
    options = options || {};
    var before = getSnapshot(shotId);
    if (!before) return { ok: false, errors: ['SNAPSHOT_NOT_FOUND'] };

    var record = runAnalysis(shotId, {
      engineVersion: options.engineVersion,
      toleranceProfileVersion: options.toleranceProfileVersion,
      activeMyBubble: options.activeMyBubble,
      markActive: options.markActive === true
    });

    return { ok: true, analysisId: record.analysisId, status: record.status, record: clone(record) };
  }

  function reprocessAll(options) {
    options = options || {};
    var results = [];
    listSnapshots().forEach(function (snapshot) {
      results.push(reprocessShot(snapshot.shotId, options));
    });
    return results;
  }

  // ---------------------------------------------------------------------------
  // Recommendations Engine handoff
  // ---------------------------------------------------------------------------

  /*
    Neutral evidence only. This module states what the conditions were and what
    the normalisation did; it does not group across shots, decide whether a
    pattern is meaningful, or supply any language.
  */
  function buildRecommendationsHandoff(shotId) {
    var record = getActiveAnalysis(shotId);
    if (!record) return null;
    var snapshot = getSnapshot(shotId);

    return {
      shotId: record.shotId,
      analysisId: record.analysisId,
      roundId: record.roundId,
      holeNumber: record.holeNumber,
      clubId: record.clubId,
      distance: snapshot ? snapshot.shotDistance : null,

      normalisationApplied: record.normalisationApplied,
      normalisationType: record.normalisationType,
      normalisationConfidence: record.normalisationConfidence,
      bubbleFitImprovement: record.bubbleFitImprovement,

      userSelectedWind: record.userSelectedWind,
      userSelectedSlope: record.userSelectedSlope,
      selectedVersusLiveWindDifference: record.windEvidence ? record.windEvidence.windAdjustmentDifferenceVector : null,
      selectedVersusLiveSlopeDifference: record.slopeEvidence ? record.slopeEvidence.slopeAdjustmentDifferenceVector : null,

      status: record.status
    };
  }

  function clearAll() {
    var store = storage();
    if (!store) return;
    try {
      store.removeItem(SNAPSHOT_KEY);
      store.removeItem(ANALYSIS_KEY);
      store.removeItem(BUBBLE_VERSION_KEY);
    } catch (e) { /* nothing to clear */ }
  }

  var api = {
    SNAPSHOT_KEY: SNAPSHOT_KEY,
    ANALYSIS_KEY: ANALYSIS_KEY,
    BUBBLE_VERSION_KEY: BUBBLE_VERSION_KEY,

    submitShotSnapshot: submitShotSnapshot,
    validateSnapshot: validateSnapshot,
    getSnapshot: getSnapshot,
    listSnapshots: listSnapshots,

    runAnalysis: runAnalysis,
    listAnalyses: listAnalyses,
    getActiveAnalysis: getActiveAnalysis,
    setActiveAnalysis: setActiveAnalysis,
    listFailures: listFailures,

    reprocessShot: reprocessShot,
    reprocessAll: reprocessAll,

    registerMyBubbleVersion: registerMyBubbleVersion,
    getMyBubbleVersion: getMyBubbleVersion,

    buildRecommendationsHandoff: buildRecommendationsHandoff,
    clearAll: clearAll
  };

  root.modules.courseDataIntake = api;
  window.GolfDaddyCourseDataIntake = api;
  window.ClarityCaddieCourseDataIntake = api;
  if (window.ClarityCaddie) window.ClarityCaddie.modules = root.modules;
})();
