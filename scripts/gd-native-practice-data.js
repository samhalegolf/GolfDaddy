(function () {
  'use strict';

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  /* Parsing lives in scripts/gd-practice-parser-core.js, shared verbatim with
     the Netlify import function. This file owns only the browser side: the
     active-player scope and the batch envelope the import lane previews.

     It used to own a second SHOT STORE as well (localStorage
     gd_native_practice_shot_data_v1), holding a copy of every imported shot
     alongside the Clarity Shot Library's own copy. That copy earned nothing:
     the graph, the cluster analysis and the Practice Bubble all read the
     library, only a debug panel ever displayed the native rows, cloud sync
     never carried them, and "clear my data" did not clear them - so a shadow
     copy of a player's shots survived a wipe and could disagree with the cloud
     after a restore. Two stores also meant two soft-delete implementations and
     two delete paths that had to be kept in step by hand.

     What remains is the contract: rows in Clarity-native shape, which
     gd-practice-library-adapter.js turns into library metrics. Staging before
     save is held in memory by the import lane, which is what staging is. */
  var core = window.GDPracticeParserCore;
  if (!core) throw new Error('gd-native-practice-data: load scripts/gd-practice-parser-core.js first');

  var SCHEMA_VERSION = core.SCHEMA_VERSION;

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (error) {
      return fallback;
    }
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function createId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function activePlayerScope() {
    var launchApi = window.GolfDaddyLaunchMonitorData || window.ClarityCaddieLaunchMonitorData;
    if (launchApi && typeof launchApi.activePlayerScope === 'function') {
      return launchApi.activePlayerScope() || {};
    }
    var session = safe(function () {
      return window.ClaritySession && typeof window.ClaritySession.get === 'function' ? window.ClaritySession.get() : null;
    }, null) || {};
    return {
      playerId: String(session.viewedProfileId || session.profileId || '').trim(),
      playerName: String(session.accountName || 'Player').trim(),
      accountId: String(session.accountId || '').trim()
    };
  }

  var asNumber = core.asNumber;

  /* The core, bound to this platform: browser ids, and the signed-in player as
     the ambient scope for an import that does not name one. */
  var parser = core.createPracticeParser({
    createId: createId,
    resolveScope: activePlayerScope
  });

  var parsePracticeImportText = parser.parsePracticeImportText;
  var normalizeNativeShot = parser.normalizeNativeShot;
  var validateNativePracticeShot = parser.validateNativePracticeShot;

  /* The batch/session envelope the import lane previews and the library bridge
     reads its provenance from. gateStatus answers "did the file read cleanly";
     provenanceGaps is advisory - it says what the source never told us (unit,
     date, monitor) so the UI can offer to fill it in, and it does not stop the
     import. */
  function createPracticeImportBatch(rows, source) {
    source = source || {};
    var built = parser.createPracticeImportBatch(rows, source);
    var scope = activePlayerScope();
    var batch = Object.assign({}, built.batch, {
      importId: built.batch.importBatchId,
      playerId: scope.playerId || '',
      playerName: scope.playerName || 'Player',
      accountId: scope.accountId || '',
      rawText: source.rawText || '',
      unitHints: source.unitHints || {},
      gateStatus: parser.batchGateStatus(built.batch),
      provenanceGaps: parser.batchProvenanceGaps(built.batch)
    });
    return { batch: batch, session: built.session, rows: built.rows };
  }

  /* The gate's view of a set of rows: signed lateral, the offline angle derived
     from it, and the delivery numbers. Pure - it reads the rows it is given
     rather than a store, so the same call works on a preview, on rows loaded
     back from the library, or on rows that arrived by email. */
  function buildPracticeGateInput(rows, opts) {
    opts = opts || {};
    var accepted = [];
    var rejected = [];
    (Array.isArray(rows) ? rows : []).forEach(function (shot) {
      var checked = validateNativePracticeShot(shot);
      if (checked.errors.length) {
        rejected.push({
          shotId: shot.shotId,
          club: shot.club || '',
          errors: checked.errors,
          warnings: checked.warnings
        });
        return;
      }
      var carryM = asNumber(shot.carryDistance);
      var totalM = asNumber(shot.totalDistance);
      var lateralM = asNumber(shot.offlineDistance);
      var expectedM = carryM || totalM || null;
      var normalizedDeg = Number.isFinite(Number(lateralM)) && Number.isFinite(Number(expectedM)) && Number(expectedM) > 0
        ? Math.atan2(Number(lateralM), Number(expectedM)) * 180 / Math.PI
        : null;
      accepted.push({
        shotId: shot.shotId,
        sessionId: shot.sessionId,
        importBatchId: shot.importBatchId,
        playerId: shot.playerId || '',
        playerName: shot.playerName || '',
        accountId: shot.accountId || '',
        club: shot.club || 'Unknown',
        shotNumber: shot.shotNumber,
        carryM: carryM,
        totalM: totalM,
        expectedM: expectedM,
        lateralM: lateralM,
        normalizedDeg: Number.isFinite(Number(normalizedDeg)) ? Math.round(Number(normalizedDeg) * 100) / 100 : null,
        delivery: {
          faceAngleDeg: asNumber(shot.faceAngle),
          pathAngleDeg: asNumber(shot.pathAngle),
          faceToPathDeg: asNumber(shot.faceToPath),
          startDirectionDeg: asNumber(shot.startDirection),
          /* Signal-engine delivery variables. Each is null unless the monitor
             actually reported it - the Bubble Signal engine gates on presence,
             so a missing value must stay missing rather than become a zero. */
          dynamicLoftDeg: asNumber(shot.dynamicLoft),
          dynamicLieDeg: asNumber(shot.dynamicLie),
          attackAngleDeg: asNumber(shot.attackAngle)
        },
        /* Ball-flight variables, same rule: present or null, never defaulted. */
        flight: {
          launchAngleDeg: asNumber(shot.launchAngle),
          spinRpm: asNumber(shot.spin) === null ? asNumber(shot.totalSpin) : asNumber(shot.spin),
          spinAxisDeg: asNumber(shot.spinAxis),
          peakHeight: asNumber(shot.peakHeight),
          descentAngleDeg: asNumber(shot.descentAngle),
          hangTimeSec: asNumber(shot.hangTime),
          ballSpeed: asNumber(shot.ballSpeed),
          clubSpeed: asNumber(shot.clubSpeed)
        },
        providerGuess: shot.providerGuess || (shot.rawSource && shot.rawSource.providerGuess) || '',
        sourceType: shot.sourceType,
        sourceNative: true,
        rawSource: shot.rawSource || null
      });
    });
    return {
      sessionId: opts.sessionId || '',
      importBatchId: opts.importBatchId || '',
      schemaVersion: SCHEMA_VERSION,
      accepted: accepted,
      rejected: rejected,
      counts: {
        nativeRows: (Array.isArray(rows) ? rows : []).length,
        gateReady: accepted.length,
        rejected: rejected.length
      },
      generatedAt: nowIso()
    };
  }

  var api = {
    schemaVersion: SCHEMA_VERSION,
    activePlayerScope: activePlayerScope,
    normalizeNativeShot: normalizeNativeShot,
    validateNativePracticeShot: validateNativePracticeShot,
    parsePracticeImportText: parsePracticeImportText,
    createPracticeImportBatch: createPracticeImportBatch,
    buildPracticeGateInput: buildPracticeGateInput
  };

  root.modules.nativePracticeData = api;
  window.GDPracticeDataImport = api;
  window.GolfDaddyNativePracticeData = api;
})();
