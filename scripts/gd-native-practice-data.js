(function () {
  'use strict';

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  var STORAGE_KEY = 'gd_native_practice_shot_data_v1';
  var SCHEMA_VERSION = 1;
  var VALID_STATUSES = {
    imported: true,
    native_valid: true,
    native_invalid: true,
    ready_for_gate: true,
    rejected: true
  };

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

  function asNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    var cleaned = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
    var n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  function cleanString(value) {
    return String(value === null || value === undefined ? '' : value).trim();
  }

  function sideFromOffline(value, explicitSide) {
    var side = cleanString(explicitSide).toLowerCase();
    if (side === 'left' || side === 'l') return 'left';
    if (side === 'right' || side === 'r') return 'right';
    if (Number.isFinite(Number(value))) {
      if (Number(value) < 0) return 'left';
      if (Number(value) > 0) return 'right';
    }
    return '';
  }

  function normalizeNativeShot(input, context) {
    input = input || {};
    context = context || {};
    var scope = Object.assign({}, activePlayerScope(), context.playerScope || {});
    var created = input.createdAt || nowIso();
    var shot = {
      shotId: cleanString(input.shotId) || createId('practice-shot'),
      sessionId: cleanString(input.sessionId || context.sessionId) || '',
      playerId: cleanString(input.playerId || scope.playerId),
      playerName: cleanString(input.playerName || scope.playerName || 'Player'),
      accountId: cleanString(input.accountId || scope.accountId),
      club: cleanString(input.club),
      shotNumber: asNumber(input.shotNumber),
      ballSpeed: asNumber(input.ballSpeed),
      clubSpeed: asNumber(input.clubSpeed),
      launchAngle: asNumber(input.launchAngle),
      spin: asNumber(input.spin),
      carryDistance: asNumber(input.carryDistance),
      totalDistance: asNumber(input.totalDistance),
      offlineDistance: asNumber(input.offlineDistance),
      side: sideFromOffline(input.offlineDistance, input.side),
      faceAngle: asNumber(input.faceAngle),
      pathAngle: asNumber(input.pathAngle),
      faceToPath: asNumber(input.faceToPath),
      startDirection: asNumber(input.startDirection),
      curve: asNumber(input.curve),
      targetLine: cleanString(input.targetLine),
      rawSource: input.rawSource || null,
      sourceType: cleanString(input.sourceType || context.sourceType || 'text') || 'text',
      importBatchId: cleanString(input.importBatchId || context.importBatchId),
      status: VALID_STATUSES[input.status] ? input.status : 'imported',
      schemaVersion: SCHEMA_VERSION,
      createdAt: created,
      updatedAt: input.updatedAt || created,
      errors: Array.isArray(input.errors) ? input.errors.slice() : [],
      warnings: Array.isArray(input.warnings) ? input.warnings.slice() : [],
      unknownFields: input.unknownFields && typeof input.unknownFields === 'object' ? Object.assign({}, input.unknownFields) : {}
    };
    return validateNativePracticeShot(shot);
  }

  function validateNativePracticeShot(input) {
    var shot = Object.assign({}, input || {});
    var errors = Array.isArray(shot.errors) ? shot.errors.slice() : [];
    var warnings = Array.isArray(shot.warnings) ? shot.warnings.slice() : [];
    if (!cleanString(shot.club)) errors.push('missing_club');
    if (!Number.isFinite(Number(shot.carryDistance)) && !Number.isFinite(Number(shot.totalDistance))) errors.push('missing_distance');
    if (Number.isFinite(Number(shot.carryDistance)) && Number(shot.carryDistance) <= 0) errors.push('invalid_carry_distance');
    if (Number.isFinite(Number(shot.totalDistance)) && Number(shot.totalDistance) <= 0) errors.push('invalid_total_distance');
    if (!Number.isFinite(Number(shot.offlineDistance))) warnings.push('missing_offline_distance');
    shot.errors = Array.from(new Set(errors));
    shot.warnings = Array.from(new Set(warnings));
    shot.status = shot.errors.length ? 'native_invalid' : 'native_valid';
    shot.updatedAt = nowIso();
    return shot;
  }

  function createPracticeImportBatch(rows, source) {
    source = source || {};
    var createdAt = nowIso();
    var importBatchId = createId('practice-import');
    var sessionId = cleanString(source.sessionId) || createId('practice-session');
    var scope = activePlayerScope();
    var nativeRows = (Array.isArray(rows) ? rows : []).map(function (row, index) {
      return normalizeNativeShot(Object.assign({}, row, {
        shotNumber: Number.isFinite(Number(row && row.shotNumber)) ? Number(row.shotNumber) : index + 1,
        importBatchId: importBatchId,
        sessionId: sessionId,
        sourceType: source.sourceType || row && row.sourceType || 'text'
      }), {
        importBatchId: importBatchId,
        sessionId: sessionId,
        sourceType: source.sourceType || 'text',
        playerScope: scope
      });
    });
    var batch = {
      importBatchId: importBatchId,
      sessionId: sessionId,
      sourceType: source.sourceType || 'text',
      sourceName: source.sourceName || '',
      rawText: source.rawText || '',
      rowCount: nativeRows.length,
      validCount: nativeRows.filter(function (row) { return !row.errors.length; }).length,
      invalidCount: nativeRows.filter(function (row) { return row.errors.length; }).length,
      createdAt: createdAt,
      updatedAt: createdAt
    };
    var session = {
      sessionId: sessionId,
      importBatchId: importBatchId,
      playerId: scope.playerId || '',
      playerName: scope.playerName || 'Player',
      accountId: scope.accountId || '',
      sourceType: batch.sourceType,
      sourceName: batch.sourceName,
      shotCount: nativeRows.length,
      createdAt: createdAt,
      updatedAt: createdAt
    };
    return { batch: batch, session: session, rows: nativeRows };
  }

  function splitDelimitedLine(line) {
    var cells = [];
    var cell = '';
    var quoted = false;
    for (var i = 0; i < line.length; i += 1) {
      var ch = line.charAt(i);
      var next = line.charAt(i + 1);
      if (ch === '"' && quoted && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = !quoted;
      } else if (ch === ',' && !quoted) {
        cells.push(cell.trim());
        cell = '';
      } else {
        cell += ch;
      }
    }
    cells.push(cell.trim());
    return cells;
  }

  function splitPracticeLine(line, delimiter) {
    if (delimiter === ',') return splitDelimitedLine(line);
    return String(line || '').trim().split(/\t|\s{2,}|[|;]/).map(function (cell) { return cell.trim(); });
  }

  function fieldKey(value) {
    return String(value || '').trim().toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]+/g, '');
  }

  var FIELD_ALIASES = {
    club: 'club',
    clubname: 'club',
    shot: 'shotNumber',
    shotno: 'shotNumber',
    shotnumber: 'shotNumber',
    ball: 'ballSpeed',
    ballspeed: 'ballSpeed',
    bs: 'ballSpeed',
    clubspeed: 'clubSpeed',
    chs: 'clubSpeed',
    launch: 'launchAngle',
    launchangle: 'launchAngle',
    spin: 'spin',
    backspin: 'spin',
    totalspin: 'spin',
    spinrate: 'spin',
    carry: 'carryDistance',
    carrydistance: 'carryDistance',
    carrym: 'carryDistance',
    total: 'totalDistance',
    totaldistance: 'totalDistance',
    totalm: 'totalDistance',
    offline: 'offlineDistance',
    offlinedistance: 'offlineDistance',
    lr: 'offlineDistance',
    left: 'offlineDistance',
    right: 'offlineDistance',
    side: 'side',
    face: 'faceAngle',
    faceangle: 'faceAngle',
    path: 'pathAngle',
    pathangle: 'pathAngle',
    clubpath: 'pathAngle',
    facetopath: 'faceToPath',
    f2p: 'faceToPath',
    start: 'startDirection',
    startdirection: 'startDirection',
    curve: 'curve',
    target: 'targetLine',
    targetline: 'targetLine'
  };

  function canonicalField(name) {
    return FIELD_ALIASES[fieldKey(name)] || '';
  }

  function looksLikeHeader(cells) {
    var known = 0;
    cells.forEach(function (cell) {
      if (canonicalField(cell)) known += 1;
    });
    return known >= 2 || (known >= 1 && cells.some(function (cell) { return /club|carry|total|offline|face|path/i.test(cell); }));
  }

  function inferHeaders(width) {
    var defaults = ['club', 'carryDistance', 'totalDistance', 'offlineDistance', 'faceAngle', 'pathAngle', 'startDirection'];
    var headers = [];
    for (var i = 0; i < width; i += 1) headers.push(defaults[i] || 'unknown' + (i + 1));
    return headers;
  }

  function normalizeHeaderCells(cells) {
    return cells.map(function (cell, index) {
      return canonicalField(cell) || ('unknown' + (index + 1));
    });
  }

  function parsePracticeImportText(text, opts) {
    opts = opts || {};
    var rawText = String(text || '');
    var lines = rawText.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
    var warnings = [];
    if (!lines.length) return { rows: [], warnings: ['empty_input'], sourceType: opts.sourceType || 'text', rawText: rawText };
    var delimiter = lines.some(function (line) { return line.indexOf(',') !== -1; }) ? ',' : 'auto';
    var firstCells = splitPracticeLine(lines[0], delimiter);
    var hasHeader = opts.headers === true || (opts.headers !== false && looksLikeHeader(firstCells));
    var headers = hasHeader ? normalizeHeaderCells(firstCells) : inferHeaders(firstCells.length);
    if (!hasHeader) warnings.push('header_inferred');
    var dataLines = hasHeader ? lines.slice(1) : lines;
    var rows = dataLines.map(function (line, index) {
      var cells = splitPracticeLine(line, delimiter);
      var rawSource = {};
      var unknownFields = {};
      var row = {
        rawSource: {
          line: line,
          lineNumber: hasHeader ? index + 2 : index + 1
        },
        sourceType: opts.sourceType || 'text'
      };
      cells.forEach(function (cell, cellIndex) {
        var key = headers[cellIndex] || ('unknown' + (cellIndex + 1));
        rawSource[key] = cell;
        if (key.indexOf('unknown') === 0) {
          if (cell) unknownFields[key] = cell;
          return;
        }
        row[key] = cell;
      });
      row.rawSource.cells = rawSource;
      row.unknownFields = unknownFields;
      row.warnings = Object.keys(unknownFields).length ? ['unknown_fields'] : [];
      return row;
    }).filter(function (row) {
      return Object.keys(row.rawSource.cells || {}).some(function (key) { return cleanString(row.rawSource.cells[key]); });
    });
    return {
      rows: rows,
      warnings: warnings,
      sourceType: opts.sourceType || 'text',
      sourceName: opts.sourceName || '',
      rawText: rawText,
      hasHeader: hasHeader,
      headers: headers
    };
  }

  function saveNativePracticeShots(batchPayload) {
    var payload = batchPayload || {};
    var store = readStore();
    if (payload.batch) store.importBatches.push(payload.batch);
    if (payload.session) store.sessions.push(payload.session);
    var rows = (payload.rows || []).filter(function (row) { return row && !row.errors.length; }).map(function (row) {
      return Object.assign({}, row, {
        status: 'ready_for_gate',
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
    var shots = store.shots.slice();
    if (opts.sessionId) shots = shots.filter(function (shot) { return shot.sessionId === opts.sessionId; });
    if (opts.importBatchId) shots = shots.filter(function (shot) { return shot.importBatchId === opts.importBatchId; });
    if (opts.playerId) shots = shots.filter(function (shot) { return shot.playerId === opts.playerId; });
    return shots;
  }

  function buildPracticeGateInput(sessionId, opts) {
    opts = opts || {};
    var rows = loadNativePracticeShots({ sessionId: sessionId || '' }).filter(function (shot) {
      if (opts.importBatchId && shot.importBatchId !== opts.importBatchId) return false;
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
    clearNativePracticeData: clearNativePracticeData
  };

  root.modules.nativePracticeData = api;
  window.GDPracticeDataImport = api;
  window.GolfDaddyNativePracticeData = api;
})();
