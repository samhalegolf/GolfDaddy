(function () {
  'use strict';

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  /* Parsing lives in scripts/gd-practice-parser-core.js, shared verbatim with
     the Netlify import function. This file owns only the browser side: the
     localStorage store, the active-player scope, and the gate input. If the
     core is missing the module still loads, but every parse throws rather than
     silently returning nothing - a missing script tag should be loud. */
  var core = window.GDPracticeParserCore;
  if (!core) throw new Error('gd-native-practice-data: load scripts/gd-practice-parser-core.js first');

  var STORAGE_KEY = 'gd_native_practice_shot_data_v1';
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

  function emptyStore() {
    return {
      version: 1,
      schemaVersion: SCHEMA_VERSION,
      importBatches: [],
      sessions: [],
      shots: [],
      updatedAt: nowIso()
    };
  }

  function normalizeStore(store) {
    store = store && typeof store === 'object' ? store : emptyStore();
    store.version = store.version || 1;
    store.schemaVersion = store.schemaVersion || SCHEMA_VERSION;
    store.importBatches = Array.isArray(store.importBatches) ? store.importBatches : [];
    store.sessions = Array.isArray(store.sessions) ? store.sessions : [];
    store.shots = Array.isArray(store.shots) ? store.shots : [];
    store.updatedAt = store.updatedAt || nowIso();
    return store;
  }

  function readStore() {
    return normalizeStore(safe(function () {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : emptyStore();
    }, emptyStore()));
  }

  function writeStore(store) {
    store = normalizeStore(store);
    store.updatedAt = nowIso();
    safe(function () {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    });
    return store;
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
  var cleanString = core.cleanString;

  /* The core, bound to this platform: browser ids, and the signed-in player as
     the ambient scope for an import that does not name one. */
  var parser = core.createPracticeParser({
    createId: createId,
    resolveScope: activePlayerScope
  });

  function activeStatus(item) {
    return cleanString(item && item.status || 'active').toLowerCase() !== 'deleted';
  }

  function itemPlayerId(item) {
    return cleanString(item && (item.playerId || item.profileId || item.player_id || item.player_key));
  }

  function itemMatchesPlayer(item, playerId) {
    playerId = cleanString(playerId);
    if (!playerId) return true;
    return itemPlayerId(item) === playerId;
  }

  function importIdSet(values) {
    return (Array.isArray(values) ? values : [values]).reduce(function (set, value) {
      var id = cleanString(value);
      if (id) set[id] = true;
      return set;
    }, {});
  }

  var parsePracticeImportText = parser.parsePracticeImportText;
  var normalizeNativeShot = parser.normalizeNativeShot;
  var validateNativePracticeShot = parser.validateNativePracticeShot;

  /* The core builds the batch/session envelope the server also persists; the
     browser store needs a few more fields on top - the local record status the
     soft-delete path reads, the raw text kept for re-parsing, and importId,
     the older key name still present in stored batches.
     Note `status` here is the RECORD status (active vs deleted), which is not
     the staging gate - that is gateStatus. provenanceGaps is advisory: it says
     what the source never told us (unit, date, monitor) so the UI can offer to
     fill it in, and it does not stop the import. */
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
      gateStatus: parser.batchGateStatus(built.batch),
      provenanceGaps: parser.batchProvenanceGaps(built.batch),
      status: 'active',
      deletedAt: '',
      deletedBy: ''
    });
    var session = Object.assign({}, built.session, {
      status: 'active',
      deletedAt: '',
      deletedBy: ''
    });
    return { batch: batch, session: session, rows: built.rows };
  }

  function saveNativePracticeShots(batchPayload) {
    var payload = batchPayload || {};
    var store = readStore();
    if (payload.batch) store.importBatches.push(payload.batch);
    if (payload.session) store.sessions.push(payload.session);
    var rows = (payload.rows || []).filter(function (row) { return row && !row.errors.length; }).map(function (row) {
      return Object.assign({}, row, {
        status: 'ready_for_gate',
        recordStatus: 'active',
        deletedAt: '',
        deletedBy: '',
        updatedAt: nowIso()
      });
    });
    store.shots = store.shots.concat(rows);
    writeStore(store);
    return {
      savedCount: rows.length,
      rejectedCount: (payload.rows || []).length - rows.length,
      store: store,
      rows: rows
    };
  }

  function loadNativePracticeShots(opts) {
    opts = opts || {};
    var store = readStore();
    var shots = store.shots.filter(activeStatus).filter(function (shot) {
      return cleanString(shot.recordStatus || 'active').toLowerCase() !== 'deleted';
    });
    if (opts.sessionId) shots = shots.filter(function (shot) { return shot.sessionId === opts.sessionId; });
    if (opts.importBatchId) shots = shots.filter(function (shot) { return shot.importBatchId === opts.importBatchId; });
    if (opts.playerId) shots = shots.filter(function (shot) { return shot.playerId === opts.playerId; });
    return shots;
  }

  function buildPracticeGateInput(sessionId, opts) {
    opts = opts || {};
    var rows = loadNativePracticeShots({ sessionId: sessionId || '' }).filter(function (shot) {
      if (opts.importBatchId && shot.importBatchId !== opts.importBatchId) return false;
      if (cleanString(shot.recordStatus || 'active').toLowerCase() === 'deleted') return false;
      return shot.status === 'ready_for_gate' || shot.status === 'native_valid';
    });
    var accepted = [];
    var rejected = [];
    rows.forEach(function (shot) {
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
          startDirectionDeg: asNumber(shot.startDirection)
        },
        sourceType: shot.sourceType,
        sourceNative: true,
        rawSource: shot.rawSource || null
      });
    });
    return {
      sessionId: sessionId || '',
      importBatchId: opts.importBatchId || '',
      storageKey: STORAGE_KEY,
      schemaVersion: SCHEMA_VERSION,
      accepted: accepted,
      rejected: rejected,
      counts: {
        nativeRows: rows.length,
        gateReady: accepted.length,
        rejected: rejected.length
      },
      generatedAt: nowIso()
    };
  }

  function clearNativePracticeData() {
    return writeStore(emptyStore());
  }

  function softDeletePracticeImports(importIds, opts) {
    opts = opts || {};
    var ids = importIdSet(importIds);
    var store = readStore();
    var deletedAt = opts.deletedAt || nowIso();
    var deletedBy = cleanString(opts.deletedBy) || cleanString(activePlayerScope().accountId || activePlayerScope().playerId || 'local');
    var playerId = cleanString(opts.playerId);
    var deletedImports = 0;
    var deletedRows = 0;
    var deletedSessions = 0;

    store.importBatches = (store.importBatches || []).map(function (batch) {
      var id = cleanString(batch && (batch.importBatchId || batch.importId));
      if (!id || !ids[id] || !itemMatchesPlayer(batch, playerId)) return batch;
      deletedImports += cleanString(batch.status).toLowerCase() === 'deleted' ? 0 : 1;
      return Object.assign({}, batch, {
        status: 'deleted',
        deletedAt: deletedAt,
        deletedBy: deletedBy,
        updatedAt: deletedAt
      });
    });

    store.sessions = (store.sessions || []).map(function (session) {
      var id = cleanString(session && (session.importBatchId || session.importId));
      if (!id || !ids[id] || !itemMatchesPlayer(session, playerId)) return session;
      deletedSessions += cleanString(session.status).toLowerCase() === 'deleted' ? 0 : 1;
      return Object.assign({}, session, {
        status: 'deleted',
        deletedAt: deletedAt,
        deletedBy: deletedBy,
        updatedAt: deletedAt
      });
    });

    store.shots = (store.shots || []).map(function (shot) {
      var id = cleanString(shot && (shot.importBatchId || shot.importId));
      if (!id || !ids[id] || !itemMatchesPlayer(shot, playerId)) return shot;
      deletedRows += cleanString(shot.recordStatus || 'active').toLowerCase() === 'deleted' ? 0 : 1;
      return Object.assign({}, shot, {
        recordStatus: 'deleted',
        deletedAt: deletedAt,
        deletedBy: deletedBy,
        updatedAt: deletedAt
      });
    });

    writeStore(store);
    return { deletedImports: deletedImports, deletedSessions: deletedSessions, deletedRows: deletedRows, store: store };
  }

  function deletePracticeImport(importId, opts) {
    return softDeletePracticeImports([importId], opts);
  }

  function deleteSelectedPracticeImports(importIds, opts) {
    return softDeletePracticeImports(importIds, opts);
  }

  function clearPracticeLibraryForPlayer(playerId, opts) {
    playerId = cleanString(playerId || activePlayerScope().playerId);
    if (!playerId) return { deletedImports: 0, deletedSessions: 0, deletedRows: 0, store: readStore(), error: 'missing_player_id' };
    var store = readStore();
    var ids = (store.importBatches || [])
      .filter(function (batch) { return itemMatchesPlayer(batch, playerId) && activeStatus(batch); })
      .map(function (batch) { return cleanString(batch.importBatchId || batch.importId); })
      .filter(Boolean);
    return softDeletePracticeImports(ids, Object.assign({}, opts || {}, { playerId: playerId }));
  }

  var api = {
    storageKey: STORAGE_KEY,
    schemaVersion: SCHEMA_VERSION,
    getStore: readStore,
    saveStore: writeStore,
    activePlayerScope: activePlayerScope,
    normalizeNativeShot: normalizeNativeShot,
    validateNativePracticeShot: validateNativePracticeShot,
    parsePracticeImportText: parsePracticeImportText,
    createPracticeImportBatch: createPracticeImportBatch,
    saveNativePracticeShots: saveNativePracticeShots,
    loadNativePracticeShots: loadNativePracticeShots,
    buildPracticeGateInput: buildPracticeGateInput,
    clearNativePracticeData: clearNativePracticeData,
    deletePracticeImport: deletePracticeImport,
    deleteSelectedPracticeImports: deleteSelectedPracticeImports,
    clearPracticeLibraryForPlayer: clearPracticeLibraryForPlayer
  };

  root.modules.nativePracticeData = api;
  window.GDPracticeDataImport = api;
  window.GolfDaddyNativePracticeData = api;
})();
