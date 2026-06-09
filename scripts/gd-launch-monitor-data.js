(function () {
  'use strict';

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  var STORAGE_KEY = 'gd_launch_monitor_data_v1';
  var DEFAULTS = {
    minCarryM: 20,
    maxCarryM: 330,
    carryWindowPct: 0.18,
    carryWindowMinM: 8,
    carryWindowMaxM: 38,
    maxAbsOfflineM: 70,
    viableDegreeAbs: 8,
    alignmentDegreeAbs: 10,
    minClusterShots: 5,
    maxClusterStdDeg: 2.2,
    maxClusterRangeDeg: 6,
    minMetricConfidence: 0.35,
    resultConsistencyPct: 60,
    replicationDegreeTolerance: 1.75,
    minVerificationClubs: 2,
    distanceScaleWeight: 0.45,
    deliveryMinShots: 4,
    deliveryMaxStdDeg: 1.6,
    deliveryMaxRangeDeg: 4.5,
    deliveryResultToleranceDeg: 2.25,
    deliveryMinConfidence: 0.45,
    clusterHunterPct: 0.28,
    faceToPathMaxAbsDeg: 6,
    spinAxisMaxAbsDeg: 12,
    simulatorSpinAxisCurveFactor: 0.18,
    simulatorMinPlotConfidence: 0.35,
    simulatorReferenceSpinRpm: 6500,
    simulatorReferenceBallSpeedMph: 150,
    smashMin: 1.18,
    smashMax: 1.52,
    launchToleranceDeg: 6,
    dynamicLoftToleranceDeg: 8,
    spinTolerancePct: 0.35
  };

  function activePlayerScope() {
    var profile = null;
    var account = null;
    var session = null;

    try {
      var profileApi = window.GolfDaddyProfiles || window.ClarityCaddieProfiles;
      profile = profileApi && typeof profileApi.active === 'function' ? profileApi.active() : null;
    } catch (error) {}

    try {
      var accountApi = window.GolfDaddyAccounts || window.ClarityCaddieAccounts;
      account = accountApi && typeof accountApi.current === 'function' ? accountApi.current() : null;
    } catch (error) {}

    try {
      session = window.ClaritySession && typeof window.ClaritySession.get === 'function' ? window.ClaritySession.get() : null;
    } catch (error) {}

    var playerId = String(profile && profile.id || session && session.viewedProfileId || account && account.profileId || '').trim();
    var playerName = String(profile && profile.name || session && session.accountName || account && account.name || 'Player').trim();
    var accountId = String(profile && profile.accountId || account && account.accountId || session && session.accountId || '').trim();

    return {
      playerId: playerId,
      playerName: playerName || 'Player',
      accountId: accountId
    };
  }

  function resolvePlayerScope(input, fallback) {
    input = input || {};
    fallback = fallback || {};
    var active = activePlayerScope();
    return {
      playerId: String(input.playerId || input.profileId || fallback.playerId || fallback.profileId || active.playerId || '').trim(),
      playerName: String(input.playerName || fallback.playerName || active.playerName || 'Player').trim(),
      accountId: String(input.accountId || fallback.accountId || active.accountId || '').trim()
    };
  }

  function applyPlayerScope(item, scope) {
    if (!item || !scope || !scope.playerId) return item;
    item.playerId = scope.playerId;
    item.playerName = scope.playerName || item.playerName || 'Player';
    item.accountId = scope.accountId || item.accountId || '';
    return item;
  }

  function itemPlayerId(item) {
    return String(item && (item.playerId || item.profileId || item.playerProfileId) || '').trim();
  }

  function itemMatchesScope(item, scope) {
    if (!scope || !scope.playerId) return true;
    return itemPlayerId(item) === scope.playerId;
  }

  function ensureStoreOwnership(store) {
    return store || defaultStore();
  }

  function scopedStore(sourceStore, scope) {
    scope = scope || activePlayerScope();
    var store = ensureStoreOwnership(sourceStore || readStore());
    return {
      version: store.version || 1,
      sessions: (store.sessions || []).filter(function (session) { return itemMatchesScope(session, scope); }),
      captures: (store.captures || []).filter(function (capture) { return itemMatchesScope(capture, scope); }),
      shots: (store.shots || []).filter(function (shot) { return itemMatchesScope(shot, scope); }),
      rejects: (store.rejects || []).filter(function (shot) { return itemMatchesScope(shot, scope); }),
      updatedAt: store.updatedAt
    };
  }

  function defaultStore() {
    return {
      version: 1,
      sessions: [],
      captures: [],
      shots: [],
      rejects: [],
      updatedAt: new Date().toISOString()
    };
  }

  function readStore() {
    try {
      var value = window.localStorage.getItem(STORAGE_KEY);
      var store = value ? JSON.parse(value) : defaultStore();
      store.sessions = Array.isArray(store.sessions) ? store.sessions : [];
      store.captures = Array.isArray(store.captures) ? store.captures : [];
      store.shots = Array.isArray(store.shots) ? store.shots : [];
      store.rejects = Array.isArray(store.rejects) ? store.rejects : [];
      return ensureStoreOwnership(store);
    } catch (error) {
      console.warn('[GolfDaddy] launch monitor data read failed', error);
      return defaultStore();
    }
  }

  function saveStore(store) {
    store.updatedAt = new Date().toISOString();
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (error) {
      console.warn('[GolfDaddy] launch monitor data save failed', error);
    }
    return store;
  }

  function createId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function asNumber(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function hasNumber(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function round(value, decimals) {
    var factor = Math.pow(10, decimals || 0);
    return Math.round(asNumber(value, 0) * factor) / factor;
  }

  function settings(overrides) {
    var out = Object.assign({}, DEFAULTS);
    try {
      var dev = window.GolfDaddyDev;
      var tuned = dev && typeof dev.get === 'function' ? dev.get('launchMonitorCluster') : null;
      if (tuned && typeof tuned === 'object') {
        Object.keys(DEFAULTS).forEach(function (key) {
          if (Number.isFinite(Number(tuned[key]))) out[key] = Number(tuned[key]);
        });
      }
    } catch (error) {}
    overrides = overrides || {};
    Object.keys(DEFAULTS).forEach(function (key) {
      if (Number.isFinite(Number(overrides[key]))) out[key] = Number(overrides[key]);
    });
    return out;
  }

  function captureDisplayLane(inputType) {
    var type = String(inputType || '').toLowerCase();
    if (
      type === 'plain-text-table-upload' ||
      type === 'plain-text-upload' ||
      type === 'photo-ocr-reviewed' ||
      type === 'photo-ocr-fitted-cell-grid' ||
      type === 'photo-ocr-digitised-table' ||
      type === 'screenshot' ||
      type === 'generated-demo'
    ) return 'practice_evidence';
    return 'raw_import';
  }

  function captureCanDisplay(capture) {
    return captureDisplayLane(capture && capture.inputType) === 'practice_evidence';
  }

  function displayStore(sourceStore) {
    var store = scopedStore(sourceStore || readStore(), activePlayerScope());
    var captures = Array.isArray(store.captures) ? store.captures.filter(captureCanDisplay) : [];
    var captureIds = captures.reduce(function (ids, capture) {
      if (capture && capture.captureId) ids[capture.captureId] = true;
      return ids;
    }, {});
    var sessions = Array.isArray(store.sessions) ? store.sessions.filter(function (session) {
      return captures.some(function (capture) { return capture && capture.sessionId === session.sessionId; });
    }) : [];
    var shots = Array.isArray(store.shots) ? store.shots.filter(function (shot) {
      return !!(shot && captureIds[shot.captureId]);
    }) : [];
    var rejects = Array.isArray(store.rejects) ? store.rejects.filter(function (shot) {
      return !!(shot && captureIds[shot.captureId]);
    }) : [];
    return {
      version: store.version || 1,
      sessions: sessions,
      captures: captures,
      shots: shots,
      rejects: rejects,
      updatedAt: store.updatedAt
    };
  }

  function sameMetricName(value, name) {
    return String(value || '').trim().toLowerCase() === String(name || '').trim().toLowerCase();
  }

  function metricValue(group, names) {
    var metrics = Array.isArray(group.metrics) ? group.metrics : [];
    for (var i = 0; i < names.length; i += 1) {
      var name = names[i];
      var metric = metrics.find(function (item) {
        return item && (sameMetricName(item.candidateMetric, name) || sameMetricName(item.rawLabel, name));
      });
      if (metric && Number.isFinite(Number(metric.value))) return Number(metric.value);
    }
    return null;
  }

  function metricConfidence(group, names) {
    var metrics = Array.isArray(group.metrics) ? group.metrics : [];
    var values = [];
    names.forEach(function (name) {
      metrics.forEach(function (item) {
        if (item && (sameMetricName(item.candidateMetric, name) || sameMetricName(item.rawLabel, name)) && Number.isFinite(Number(item.confidence))) values.push(Number(item.confidence));
      });
    });
    if (!values.length) return 0.5;
    return values.reduce(function (sum, value) { return sum + value; }, 0) / values.length;
  }

  function normalizeClub(label) {
    var value = String(label || '').trim();
    if (!value) return 'Unknown';
    var lower = value.toLowerCase();
    if (lower === 'dr' || lower === '1w' || lower === 'driver') return 'Driver';
    var iron = lower.match(/^([2-9])\s*(i|iron)$/);
    if (iron) return iron[1] + 'i';
    if (/^p(w|itching wedge)?$/.test(lower)) return 'PW';
    if (/^(g|a)w|gap wedge|approach wedge$/.test(lower)) return 'GW';
    if (/^sw|sand wedge$/.test(lower)) return 'SW';
    if (/^lw|lob wedge$/.test(lower)) return 'LW';
    return value;
  }

  function spinAxisFromMetrics(group) {
    var direct = metricValue(group, ['spinAxis', 'spin axis', 'SpinAxis']);
    if (hasNumber(direct)) {
      return {
        value: Number(direct),
        source: 'spin_axis',
        confidence: metricConfidence(group, ['spinAxis', 'spin axis', 'SpinAxis'])
      };
    }
    var sideSpin = metricValue(group, ['sideSpin', 'side spin', 'sidespin']);
    var backspin = metricValue(group, ['totalSpin', 'total spin', 'spinRate', 'backspin', 'spin']);
    if (hasNumber(sideSpin) && hasNumber(backspin) && Math.abs(Number(backspin)) > 100) {
      return {
        value: Math.atan2(Number(sideSpin), Math.abs(Number(backspin))) * 180 / Math.PI,
        source: 'side_spin',
        confidence: metricConfidence(group, ['sideSpin', 'side spin', 'sidespin', 'totalSpin', 'total spin', 'backspin', 'spin', 'spinRate'])
      };
    }
    return null;
  }

  function ballSpeedMph(group) {
    var raw = metricValue(group, ['ballSpeed', 'ball speed', 'BallSpeed', 'b speed', 'bspd', 'ball velocity', 'initial velocity', 'speed']);
    if (!hasNumber(raw)) return null;
    var value = Math.abs(Number(raw));
    return value > 0 && value < 90 ? value * 2.2369362921 : value;
  }

  function resolveShotPlot(group, carryM, expectedM, offlineM, cfg) {
    var baseM = Number.isFinite(Number(expectedM)) && Number(expectedM) > 1 ? Number(expectedM) : Number.isFinite(Number(carryM)) && Number(carryM) > 1 ? Number(carryM) : 1;
    if (hasNumber(offlineM)) {
      var directLateralM = Number(offlineM);
      return {
        complete: true,
        source: 'direct_offline',
        simulated: false,
        lateralM: directLateralM,
        normalizedDeg: Math.atan2(directLateralM, baseM) * 180 / Math.PI,
        confidence: metricConfidence(group, ['offline', 'side', 'sideCarry', 'lateral', 'Offline', 'Side'])
      };
    }
    var directSideAngleDeg = metricValue(group, ['offlineAngle', 'sideAngle', 'side angle', 'lateralAngle', 'lateral angle', 'resultAngle', 'result angle']);
    if (hasNumber(directSideAngleDeg)) {
      var sideAngle = clamp(Number(directSideAngleDeg), -20, 20);
      return {
        complete: true,
        source: 'direct_side_angle',
        simulated: false,
        lateralM: Math.tan(sideAngle * Math.PI / 180) * baseM,
        normalizedDeg: sideAngle,
        confidence: metricConfidence(group, ['offlineAngle', 'sideAngle', 'side angle', 'lateralAngle', 'lateral angle', 'resultAngle', 'result angle'])
      };
    }
    var launchDirectionDeg = metricValue(group, ['launchDirection', 'launch direction', 'launchDir', 'startDirection', 'start direction', 'startLine', 'start line', 'horizontalLaunch', 'horizontal launch', 'azimuth', 'direction', 'HLA']);
    var spinAxis = spinAxisFromMetrics(group);
    if (!hasNumber(carryM)) return { complete: false, source: 'missing_carry', simulated: false, reason: 'missing_carry' };
    var hasStartLine = hasNumber(launchDirectionDeg);
    if (!spinAxis || !hasNumber(spinAxis.value)) {
      if (hasStartLine) {
        var startOnlyDeg = clamp(Number(launchDirectionDeg), -20, 20);
        var startOnlyConfidence = metricConfidence(group, ['launchDirection', 'launch direction', 'launchDir', 'startDirection', 'start direction', 'startLine', 'start line', 'horizontalLaunch', 'horizontal launch', 'azimuth', 'direction', 'HLA']) * 0.60;
        return {
          complete: startOnlyConfidence >= Math.max(0.05, Number(cfg && cfg.simulatorMinPlotConfidence) || 0.35),
          source: 'simulated_start_line_only',
          simulated: true,
          lateralM: Math.tan(startOnlyDeg * Math.PI / 180) * baseM,
          normalizedDeg: startOnlyDeg,
          startDirectionDeg: startOnlyDeg,
          curveDeg: 0,
          confidence: startOnlyConfidence,
          reason: startOnlyConfidence >= Math.max(0.05, Number(cfg && cfg.simulatorMinPlotConfidence) || 0.35) ? '' : 'low_simulation_confidence'
        };
      }
      return {
        complete: false,
        source: 'missing_plot_coordinates',
        simulated: false,
        reason: 'missing_spin_axis'
      };
    }
    var totalSpin = metricValue(group, ['totalSpin', 'total spin', 'spinRate', 'backspin', 'spin']);
    var ballSpeed = ballSpeedMph(group);
    var speedProxy = hasNumber(ballSpeed) ? Number(ballSpeed) : (hasStartLine && hasNumber(carryM) ? clamp(Number(carryM) * 0.82, 55, 185) : null);
    if (!hasStartLine && (!hasNumber(totalSpin) || !hasNumber(speedProxy))) return {
      complete: false,
      source: 'missing_plot_coordinates',
      simulated: false,
      reason: !hasNumber(totalSpin) ? 'missing_spin_rate' : 'missing_ball_speed'
    };
    var distanceScale = clamp(baseM / 155, 0.55, 1.55);
    var spinReference = Math.max(1000, Number(cfg && cfg.simulatorReferenceSpinRpm) || 6500);
    var speedReference = Math.max(50, Number(cfg && cfg.simulatorReferenceBallSpeedMph) || 150);
    var spinScale = hasNumber(totalSpin) ? clamp(Math.abs(Number(totalSpin)) / spinReference, 0.45, 1.65) : 1;
    var speedScale = hasNumber(speedProxy) ? clamp(speedReference / Math.max(40, Number(speedProxy)), 0.65, 1.45) : 1;
    var curveFactor = Number.isFinite(Number(cfg && cfg.simulatorSpinAxisCurveFactor)) ? Number(cfg.simulatorSpinAxisCurveFactor) : 0.18;
    var curveDeg = clamp(Number(spinAxis.value) * curveFactor * distanceScale * spinScale * speedScale, -7.5, 7.5);
    var startDeg = hasStartLine ? Number(launchDirectionDeg) : 0;
    var simulatedDeg = clamp(startDeg + curveDeg, -20, 20);
    var simulatedLateralM = Math.tan(simulatedDeg * Math.PI / 180) * baseM;
    var launchConfidence = metricConfidence(group, ['launchDirection', 'launch direction', 'launchDir', 'startDirection', 'start direction', 'startLine', 'start line', 'horizontalLaunch', 'horizontal launch', 'azimuth', 'direction', 'HLA']);
    var spinRateConfidence = metricConfidence(group, ['totalSpin', 'total spin', 'spinRate', 'backspin', 'spin']);
    var speedConfidence = metricConfidence(group, ['ballSpeed', 'ball speed', 'BallSpeed', 'b speed', 'bspd', 'ball velocity', 'initial velocity', 'speed']);
    var confidenceBase = hasStartLine ? (launchConfidence + spinAxis.confidence) / 2 : (spinAxis.confidence + spinRateConfidence + speedConfidence) / 3;
    var hasFullSpinRecipe = hasNumber(totalSpin) && hasNumber(ballSpeed);
    var confidence = Math.min(0.88, Math.max(0.05, confidenceBase * (hasStartLine ? (hasFullSpinRecipe ? 0.82 : 0.70) : 0.72)));
    return {
      complete: confidence >= Math.max(0.05, Number(cfg && cfg.simulatorMinPlotConfidence) || 0.35),
      source: hasStartLine ? (hasFullSpinRecipe ? 'simulated_launch_spin_speed' : 'simulated_launch_spin') : 'simulated_spin_ball_speed',
      simulated: true,
      lateralM: simulatedLateralM,
      normalizedDeg: simulatedDeg,
      startDirectionDeg: startDeg,
      launchDirectionDeg: hasStartLine ? Number(launchDirectionDeg) : null,
      spinAxisDeg: Number(spinAxis.value),
      totalSpinRpm: hasNumber(totalSpin) ? Number(totalSpin) : null,
      ballSpeedMph: hasNumber(ballSpeed) ? Number(ballSpeed) : null,
      ballSpeedProxyMph: !hasNumber(ballSpeed) && hasNumber(speedProxy) ? Number(speedProxy) : null,
      curveDeg: curveDeg,
      confidence: confidence,
      reason: confidence >= Math.max(0.05, Number(cfg && cfg.simulatorMinPlotConfidence) || 0.35) ? '' : 'low_simulation_confidence'
    };
  }

  function normalizeShot(group, session, capture) {
    group = group || {};
    var cfg = settings();
    var carryM = metricValue(group, ['carryDistance', 'carry', 'Carry']);
    var totalM = metricValue(group, ['totalDistance', 'total', 'Total']);
    var offlineM = metricValue(group, ['offline', 'side', 'sideCarry', 'lateral', 'Offline', 'Side']);
    var faceToPathDeg = metricValue(group, ['faceToPath', 'face to path', 'face path', 'face/path', 'FTP']);
    var faceAngleDeg = metricValue(group, ['faceAngle', 'face to target', 'face target', 'face', 'Face Angle']);
    var clubPathDeg = metricValue(group, ['clubPath', 'club path', 'path', 'Path']);
    var swingDirectionDeg = metricValue(group, ['swingDirection', 'swing direction']);
    var deliverySignalDeg = hasNumber(faceToPathDeg) ? Number(faceToPathDeg) : null;
    if (!hasNumber(deliverySignalDeg) && hasNumber(faceAngleDeg) && hasNumber(clubPathDeg)) {
      deliverySignalDeg = Number(faceAngleDeg) - Number(clubPathDeg);
    }
    if (!hasNumber(deliverySignalDeg) && hasNumber(faceAngleDeg)) {
      deliverySignalDeg = Number(faceAngleDeg);
    }
    var deliveryConfidence = metricConfidence(group, ['faceToPath', 'face to path', 'faceAngle', 'face to target', 'clubPath', 'club path']);
    var expectedM = Number.isFinite(Number(group.expectedDistanceM)) ? Number(group.expectedDistanceM) : carryM;
    var baseM = Number.isFinite(Number(expectedM)) && expectedM > 1 ? expectedM : Number.isFinite(Number(carryM)) ? carryM : 1;
    var plot = resolveShotPlot(group, carryM, expectedM, offlineM, cfg);
    var scope = resolvePlayerScope(group, session || capture);

    return applyPlayerScope({
      shotId: group.shotId || createId('lm-shot'),
      sessionId: session.sessionId,
      captureId: capture.captureId,
      source: 'launch_monitor',
      providerGuess: session.sourceIdentity && session.sourceIdentity.providerGuess || 'unknown',
      timestamp: group.timestamp || capture.timestamp || session.startedAt,
      originClubLabel: group.originClubLabel || group.candidateClub || '',
      club: normalizeClub(group.candidateClub || group.originClubLabel),
      carryM: Number.isFinite(Number(carryM)) ? carryM : null,
      totalM: Number.isFinite(Number(totalM)) ? totalM : null,
      expectedM: Number.isFinite(Number(expectedM)) ? expectedM : null,
      lateralM: plot.complete && Number.isFinite(Number(plot.lateralM)) ? plot.lateralM : null,
      depthM: Number.isFinite(Number(carryM)) && Number.isFinite(Number(expectedM)) ? carryM - expectedM : 0,
      normalizedDeg: plot.complete && Number.isFinite(Number(plot.normalizedDeg)) ? plot.normalizedDeg : null,
      plot: Object.assign({
        baseDistanceM: baseM
      }, plot),
      delivery: {
        faceToPathDeg: hasNumber(faceToPathDeg) ? Number(faceToPathDeg) : null,
        faceAngleDeg: hasNumber(faceAngleDeg) ? Number(faceAngleDeg) : null,
        clubPathDeg: hasNumber(clubPathDeg) ? Number(clubPathDeg) : null,
        swingDirectionDeg: hasNumber(swingDirectionDeg) ? Number(swingDirectionDeg) : null,
        signalDeg: hasNumber(deliverySignalDeg) ? Number(deliverySignalDeg) : null,
        confidence: deliveryConfidence
      },
      confidence: Math.min(metricConfidence(group, ['carryDistance', 'carry', 'Carry']), plot.confidence || 0),
      metrics: Array.isArray(group.metrics) ? group.metrics.slice() : [],
      rawGroup: group
    }, scope);
  }

  function importCapture(payload) {
    payload = payload || {};
    var store = readStore();
    var scope = resolvePlayerScope(payload);
    var session = applyPlayerScope({
      sessionId: payload.sessionId || createId('lm-session'),
      label: payload.label || 'Launch monitor capture',
      sourceIdentity: payload.sourceIdentity || { providerGuess: 'unknown', confidence: 0 },
      startedAt: payload.startedAt || payload.timestamp || new Date().toISOString(),
      importedAt: new Date().toISOString()
    }, scope);
    var capture = applyPlayerScope({
      captureId: payload.captureId || createId('lm-capture'),
      sessionId: session.sessionId,
      timestamp: payload.timestamp || session.startedAt,
      inputType: payload.inputType || 'unknown',
      displayLane: captureDisplayLane(payload.inputType),
      rawTextBlocks: Array.isArray(payload.rawTextBlocks) ? payload.rawTextBlocks.slice() : [],
      sourceIdentity: payload.sourceIdentity || session.sourceIdentity
    }, scope);
    var groups = Array.isArray(payload.clubGroups) ? payload.clubGroups : [];
    var shots = groups.map(function (group) { return normalizeShot(group, session, capture); });

    store.sessions.push(session);
    store.captures.push(capture);
    shots.forEach(function (shot) { store.shots.push(shot); });
    saveStore(store);
    return { session: session, capture: capture, shots: shots };
  }

  function idSet(values) {
    return (Array.isArray(values) ? values : [values]).reduce(function (set, value) {
      var id = String(value || '').trim();
      if (id) set[id] = true;
      return set;
    }, {});
  }

  function compactEmptyPracticeUploads(store, scope) {
    scope = scope || activePlayerScope();
    var liveCaptures = {};
    (store.shots || []).concat(store.rejects || []).forEach(function (shot) {
      if (shot && shot.captureId) liveCaptures[shot.captureId] = true;
    });
    store.captures = (store.captures || []).filter(function (capture) {
      if (!itemMatchesScope(capture, scope)) return true;
      return !!(capture && capture.captureId && liveCaptures[capture.captureId]);
    });
    var liveSessions = {};
    (store.captures || []).forEach(function (capture) {
      if (capture && capture.sessionId) liveSessions[capture.sessionId] = true;
    });
    store.sessions = (store.sessions || []).filter(function (session) {
      if (!itemMatchesScope(session, scope)) return true;
      return !!(session && session.sessionId && liveSessions[session.sessionId]);
    });
    return store;
  }

  function deleteShots(shotIds) {
    var ids = idSet(shotIds);
    var scope = activePlayerScope();
    var store = readStore();
    var deleted = 0;
    store.shots = (store.shots || []).filter(function (shot) {
      var remove = !!(shot && ids[shot.shotId] && itemMatchesScope(shot, scope));
      if (remove) deleted += 1;
      return !remove;
    });
    store.rejects = (store.rejects || []).filter(function (shot) {
      var remove = !!(shot && ids[shot.shotId] && itemMatchesScope(shot, scope));
      if (remove) deleted += 1;
      return !remove;
    });
    compactEmptyPracticeUploads(store, scope);
    saveStore(store);
    return { deleted: deleted, store: store };
  }

  function deleteCaptures(captureIds) {
    var ids = idSet(captureIds);
    var scope = activePlayerScope();
    var store = readStore();
    var deletedShots = 0;
    var deletedCaptures = 0;
    store.shots = (store.shots || []).filter(function (shot) {
      var remove = !!(shot && ids[shot.captureId] && itemMatchesScope(shot, scope));
      if (remove) deletedShots += 1;
      return !remove;
    });
    store.rejects = (store.rejects || []).filter(function (shot) {
      var remove = !!(shot && ids[shot.captureId] && itemMatchesScope(shot, scope));
      if (remove) deletedShots += 1;
      return !remove;
    });
    store.captures = (store.captures || []).filter(function (capture) {
      var remove = !!(capture && ids[capture.captureId] && itemMatchesScope(capture, scope));
      if (remove) deletedCaptures += 1;
      return !remove;
    });
    compactEmptyPracticeUploads(store, scope);
    saveStore(store);
    return { deletedShots: deletedShots, deletedCaptures: deletedCaptures, store: store };
  }

  function exclusionReason(shot, cfg) {
    if (!Number.isFinite(Number(shot.carryM))) return 'missing_carry';
    if (shot.carryM < cfg.minCarryM || shot.carryM > cfg.maxCarryM) return 'carry_out_of_range';
    if (!Number.isFinite(Number(shot.expectedM))) return 'missing_expected_distance';
    if (!shot.plot || !shot.plot.complete || !Number.isFinite(Number(shot.lateralM)) || !Number.isFinite(Number(shot.normalizedDeg))) return shot.plot && shot.plot.reason || 'missing_plot_coordinates';
    var windowM = clamp(shot.expectedM * cfg.carryWindowPct, cfg.carryWindowMinM, cfg.carryWindowMaxM);
    if (Math.abs(shot.carryM - shot.expectedM) > windowM) return 'distance_not_viable';
    if (Math.abs(asNumber(shot.lateralM, 0)) > cfg.maxAbsOfflineM) return 'offline_out_of_range';
    if (asNumber(shot.confidence, 0) < cfg.minMetricConfidence) return 'low_extraction_confidence';
    return null;
  }

  function mean(values) {
    if (!values.length) return 0;
    return values.reduce(function (sum, value) { return sum + value; }, 0) / values.length;
  }

  function std(values) {
    if (values.length < 2) return 0;
    var avg = mean(values);
    return Math.sqrt(values.reduce(function (sum, value) {
      return sum + Math.pow(value - avg, 2);
    }, 0) / values.length);
  }

  function percentile(values, pct) {
    if (!values.length) return 0;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var pos = clamp((pct / 100) * (sorted.length - 1), 0, sorted.length - 1);
    var low = Math.floor(pos);
    var high = Math.ceil(pos);
    if (low === high) return sorted[low];
    return sorted[low] + (sorted[high] - sorted[low]) * (pos - low);
  }

  function median(values) {
    return percentile(values, 50);
  }

  function groupByClub(shots) {
    return shots.reduce(function (groups, shot) {
      var club = shot.club || 'Unknown';
      groups[club] = groups[club] || [];
      groups[club].push(shot);
      return groups;
    }, {});
  }

  function isClusterHuntShot(shot) {
    if (!shot) return false;
    if (shot.analysisLane === 'cluster_hunt' || shot.sourceMethod === 'cluster_hunt') return true;
    var raw = shot.rawGroup || {};
    return raw.analysisLane === 'cluster_hunt' || raw.sourceMethod === 'cluster_hunt' || raw.simulatedShot === true;
  }

  function clubBaseline(club) {
    var key = String(club || '').toLowerCase();
    if (key === 'driver' || key === '1w') return { spin: 2600, launch: 13, dynamicLoft: 15 };
    if (key === '3w') return { spin: 3600, launch: 14, dynamicLoft: 17 };
    var iron = key.match(/^([2-9])i$/);
    if (iron) {
      var n = Number(iron[1]);
      return { spin: 3000 + n * 520, launch: 9 + n * 1.3, dynamicLoft: 12 + n * 2.2 };
    }
    if (key === 'pw') return { spin: 9200, launch: 29, dynamicLoft: 36 };
    if (key === 'gw') return { spin: 9800, launch: 31, dynamicLoft: 42 };
    if (key === 'sw') return { spin: 10500, launch: 33, dynamicLoft: 50 };
    if (key === 'lw') return { spin: 11200, launch: 35, dynamicLoft: 58 };
    return null;
  }

  function practiceQualityExclusionReason(shot, cfg) {
    var faceToPath = Number(shot && shot.delivery && shot.delivery.faceToPathDeg);
    if (Number.isFinite(faceToPath) && Math.abs(faceToPath) > Math.max(0.5, Number(cfg.faceToPathMaxAbsDeg) || 6)) return 'face_to_path';
    var spinAxis = metricValue(shot, ['spinAxis']);
    if (!Number.isFinite(spinAxis) && shot && shot.plot && Number.isFinite(Number(shot.plot.spinAxisDeg))) spinAxis = Number(shot.plot.spinAxisDeg);
    if (Number.isFinite(spinAxis) && Math.abs(spinAxis) > Math.max(1, Number(cfg.spinAxisMaxAbsDeg) || 12)) return 'spin_axis';
    var smash = metricValue(shot, ['smashFactor', 'smash']);
    var smashMin = Number.isFinite(Number(cfg.smashMin)) ? Number(cfg.smashMin) : 1.18;
    var smashMax = Number.isFinite(Number(cfg.smashMax)) ? Number(cfg.smashMax) : 1.52;
    if (Number.isFinite(smash) && (smash < smashMin || smash > smashMax)) return 'smash';
    var base = clubBaseline(shot && shot.club);
    var spin = metricValue(shot, ['totalSpin', 'total spin', 'backspin', 'spin', 'spinRate']);
    var spinTolerance = Math.max(0.05, Number(cfg.spinTolerancePct) || 0.35);
    if (base && Number.isFinite(spin) && Math.abs(spin - base.spin) > base.spin * spinTolerance) return 'spin_amount';
    var launch = metricValue(shot, ['launchAngle', 'launch']);
    if (base && Number.isFinite(launch) && Math.abs(launch - base.launch) > Math.max(1, Number(cfg.launchToleranceDeg) || 6)) return 'launch_angle';
    var dynamicLoft = metricValue(shot, ['dynamicLoft']);
    if (base && Number.isFinite(dynamicLoft) && Math.abs(dynamicLoft - base.dynamicLoft) > Math.max(1, Number(cfg.dynamicLoftToleranceDeg) || 8)) return 'dynamic_loft';
    return '';
  }

  function analyzeOvalCenterCluster(accepted, cfg) {
    var source = (accepted || []).filter(function (shot) {
      return shot && !practiceQualityExclusionReason(shot, cfg) && Number.isFinite(Number(shot.lateralM));
    });
    if (!source.length) return null;
    var carryValues = source.map(function (shot) { return Number(shot.carryM); }).filter(Number.isFinite);
    var rawDepths = source.map(function (shot) { return Number(shot.depthM); }).filter(Number.isFinite);
    var rawCarryMode = rawDepths.length && Math.max.apply(null, rawDepths.map(function (value) { return Math.abs(value); })) < 0.05 && carryValues.length > 1 && (Math.max.apply(null, carryValues) - Math.min.apply(null, carryValues)) > 1;
    var carryMin = rawCarryMode ? Math.min.apply(null, carryValues) : 0;
    var carryMax = rawCarryMode ? Math.max.apply(null, carryValues) : 0;
    var carryMid = (carryMin + carryMax) / 2;
    var carryHalfRange = Math.max(1, (carryMax - carryMin) / 2);
    var points = source.map(function (shot, index) {
      var depth = rawCarryMode && Number.isFinite(Number(shot.carryM)) ? ((Number(shot.carryM) - carryMid) / carryHalfRange) * 28 : Number(shot.depthM || 0);
      return {
        index: index,
        shot: shot,
        x: clamp(Number(shot.lateralM || 0) * 5.2, -190, 190),
        y: clamp(-depth * 3.2, -95, 95)
      };
    });
    var need = Math.max(Number(cfg.minClusterShots) || 5, Math.ceil(points.length * clamp(Number(cfg.clusterHunterPct) || 0.28, 0.18, 0.45)));
    if (points.length < need) return null;
    var best = null;
    points.forEach(function (anchor) {
      var ranked = points.map(function (point) {
        var dx = point.x - anchor.x;
        var dy = point.y - anchor.y;
        return { point: point, dist: dx * dx + dy * dy };
      }).sort(function (a, b) { return a.dist - b.dist; }).slice(0, need);
      var radius = Math.sqrt(Math.max.apply(null, ranked.map(function (item) { return item.dist; })));
      var xs = ranked.map(function (item) { return item.point.x; });
      var ys = ranked.map(function (item) { return item.point.y; });
      var area = (Math.max.apply(null, xs) - Math.min.apply(null, xs) + 1) * (Math.max.apply(null, ys) - Math.min.apply(null, ys) + 1);
      var score = radius * radius + area * 0.015;
      if (!best || score < best.score) best = { ranked: ranked, radius: radius, area: area, score: score };
    });
    var counted = best.ranked.map(function (item) { return item.point.shot; });
    var centerLateralM = mean(counted.map(function (shot) { return Number(shot.lateralM || 0); }));
    var baseM = mean(counted.map(function (shot) {
      return Number.isFinite(Number(shot.expectedM)) && Number(shot.expectedM) > 1 ? Number(shot.expectedM) : Number(shot.carryM || 0);
    }).filter(function (value) { return Number.isFinite(value) && value > 1; }));
    var offsetDeg = Math.atan2(centerLateralM, Math.max(baseM, 1)) * 180 / Math.PI;
    var degrees = counted.map(function (shot) {
      var shotBase = Number.isFinite(Number(shot.expectedM)) && Number(shot.expectedM) > 1 ? Number(shot.expectedM) : Math.max(Number(shot.carryM || 0), 1);
      return Math.atan2(Number(shot.lateralM || 0), shotBase) * 180 / Math.PI;
    });
    var range = degrees.length ? Math.max.apply(null, degrees) - Math.min.apply(null, degrees) : 0;
    return {
      method: 'result_scaled_cluster',
      source: 'oval_center',
      status: Math.abs(offsetDeg) >= cfg.alignmentDegreeAbs ? 'alignment_signal' : 'oval_center_candidate',
      anchorDeg: round(offsetDeg, 2),
      anchorClub: 'Practice oval',
      evidenceScore: round(counted.length * (1 + counted.length / Math.max(points.length, 1)), 2),
      verificationClubs: [],
      toleranceDeg: cfg.replicationDegreeTolerance,
      countedShots: counted.length,
      availableShots: points.length,
      stdDeg: round(std(degrees), 2),
      rangeDeg: round(range, 2),
      showToUser: counted.length >= need
    };
  }

  function summarizeCluster(club, shots, cfg) {
    var degrees = shots.map(function (shot) { return asNumber(shot.normalizedDeg, 0); });
    var min = Math.min.apply(null, degrees);
    var max = Math.max.apply(null, degrees);
    var avg = mean(degrees);
    var spread = std(degrees);
    var strong = shots.length >= cfg.minClusterShots && spread <= cfg.maxClusterStdDeg && (max - min) <= cfg.maxClusterRangeDeg;
    var viable = Math.abs(avg) <= cfg.viableDegreeAbs;
    var alignment = strong && !viable && Math.abs(avg) >= cfg.alignmentDegreeAbs;
    return {
      club: club,
      shots: shots.length,
      meanDeg: round(avg, 2),
      stdDeg: round(spread, 2),
      rangeDeg: round(max - min, 2),
      status: !strong ? 'needs_more_data' : viable ? 'cluster_candidate' : alignment ? 'alignment_signal' : 'scrap_cluster',
      showToUser: strong && (viable || alignment)
    };
  }

  function summarizeResultClub(club, shots, cfg) {
    var degrees = shots.map(function (shot) { return asNumber(shot.normalizedDeg, 0); });
    var center = median(degrees);
    var distances = degrees.map(function (deg) { return Math.abs(deg - center); });
    var radius = percentile(distances, clamp(cfg.resultConsistencyPct, 51, 80));
    var counted = shots.filter(function (shot) {
      return Math.abs(asNumber(shot.normalizedDeg, 0) - center) <= radius + 0.0001;
    });
    var countedDegrees = counted.map(function (shot) { return asNumber(shot.normalizedDeg, 0); });
    var avgExpected = mean(counted.map(function (shot) { return asNumber(shot.expectedM || shot.carryM, 0); }));
    var distanceWeight = 1 + clamp(avgExpected / Math.max(cfg.maxCarryM, 1), 0, 1) * cfg.distanceScaleWeight;
    var evidenceScore = counted.length * distanceWeight;
    var spread = std(countedDegrees);
    var range = countedDegrees.length ? Math.max.apply(null, countedDegrees) - Math.min.apply(null, countedDegrees) : 0;
    var requiredCount = Math.max(1, Math.ceil(shots.length * clamp(cfg.resultConsistencyPct, 51, 80) / 100));
    var strong = shots.length >= cfg.minClusterShots && counted.length >= requiredCount && spread <= cfg.maxClusterStdDeg && range <= cfg.maxClusterRangeDeg;
    var viable = Math.abs(center) <= cfg.viableDegreeAbs;
    var alignment = strong && !viable && Math.abs(center) >= cfg.alignmentDegreeAbs;
    return {
      club: club,
      shots: shots.length,
      countedShots: counted.length,
      requiredCount: requiredCount,
      consistencyPct: clamp(cfg.resultConsistencyPct, 51, 80),
      centerDeg: round(center, 2),
      radiusDeg: round(radius, 2),
      stdDeg: round(spread, 2),
      rangeDeg: round(range, 2),
      meanExpectedM: round(avgExpected, 1),
      evidenceScore: round(evidenceScore, 2),
      status: !strong ? 'needs_more_data' : viable ? 'cluster_candidate' : alignment ? 'alignment_signal' : 'scrap_cluster',
      showToUser: strong && (viable || alignment)
    };
  }

  function analyzeResultScaledClusters(accepted, cfg) {
    var clusterShots = (accepted || []).filter(isClusterHuntShot);
    if (!clusterShots.length) {
      var ovalCluster = analyzeOvalCenterCluster(accepted, cfg);
      if (ovalCluster) return ovalCluster;
    }
    var groups = groupByClub(clusterShots);
    var clubClusters = Object.keys(groups).map(function (club) {
      return summarizeResultClub(club, groups[club], cfg);
    });
    var candidates = clubClusters.filter(function (cluster) { return cluster.showToUser; });
    var anchor = candidates.slice().sort(function (a, b) { return b.evidenceScore - a.evidenceScore; })[0] || null;
    var verified = anchor ? candidates.filter(function (cluster) {
      return Math.abs(cluster.centerDeg - anchor.centerDeg) <= cfg.replicationDegreeTolerance;
    }) : [];
    var status = !anchor ? 'needs_more_data' : verified.length >= cfg.minVerificationClubs ? 'cross_distance_verified' : anchor.status;
    return {
      method: 'result_scaled_cluster',
      status: status,
      anchorDeg: anchor ? anchor.centerDeg : null,
      anchorClub: anchor ? anchor.club : null,
      evidenceScore: anchor ? anchor.evidenceScore : 0,
      verificationClubs: verified.map(function (cluster) { return cluster.club; }),
      toleranceDeg: cfg.replicationDegreeTolerance,
      clubClusters: clubClusters,
      showToUser: !!anchor && (status === 'cross_distance_verified' || status === 'cluster_candidate' || status === 'alignment_signal')
    };
  }

  function deliveryExclusionReason(shot, cfg) {
    var signal = shot && shot.delivery ? shot.delivery.signalDeg : null;
    if (!hasNumber(signal)) return 'missing_delivery_signal';
    if (asNumber(shot.delivery.confidence, 0) < cfg.deliveryMinConfidence) return 'low_delivery_confidence';
    if (Number.isFinite(Number(shot.carryM)) && (shot.carryM < cfg.minCarryM || shot.carryM > cfg.maxCarryM)) return 'carry_out_of_range';
    if (Number.isFinite(Number(shot.carryM)) && Number.isFinite(Number(shot.expectedM))) {
      var windowM = clamp(shot.expectedM * cfg.carryWindowPct, cfg.carryWindowMinM, cfg.carryWindowMaxM);
      if (Math.abs(shot.carryM - shot.expectedM) > windowM) return 'distance_not_viable';
    }
    if (Number.isFinite(Number(shot.lateralM)) && Math.abs(asNumber(shot.lateralM, 0)) > cfg.maxAbsOfflineM) return 'offline_out_of_range';
    return null;
  }

  function summarizeDeliveryClub(club, shots, cfg) {
    var signals = shots.map(function (shot) { return asNumber(shot.delivery && shot.delivery.signalDeg, 0); });
    var center = median(signals);
    var spread = std(signals);
    var range = signals.length ? Math.max.apply(null, signals) - Math.min.apply(null, signals) : 0;
    var strong = shots.length >= cfg.deliveryMinShots && spread <= cfg.deliveryMaxStdDeg && range <= cfg.deliveryMaxRangeDeg;
    var avgConfidence = mean(shots.map(function (shot) { return asNumber(shot.delivery && shot.delivery.confidence, 0); }));
    var evidenceScore = shots.length * (0.75 + avgConfidence);
    return {
      club: club,
      shots: shots.length,
      centerDeg: round(center, 2),
      stdDeg: round(spread, 2),
      rangeDeg: round(range, 2),
      confidence: round(avgConfidence, 2),
      evidenceScore: round(evidenceScore, 2),
      status: strong ? 'delivery_candidate' : 'needs_more_data',
      showToUser: strong
    };
  }

  function analyzeDeliveryClusters(storeShots, cfg, resultMethod) {
    var accepted = [];
    var rejected = [];
    (storeShots || []).forEach(function (shot) {
      var reason = deliveryExclusionReason(shot, cfg);
      if (reason) rejected.push(Object.assign({ rejectReason: reason }, shot));
      else accepted.push(shot);
    });
    var groups = groupByClub(accepted);
    var clubClusters = Object.keys(groups).map(function (club) {
      return summarizeDeliveryClub(club, groups[club], cfg);
    });
    var candidates = clubClusters.filter(function (cluster) { return cluster.showToUser; });
    var anchor = candidates.slice().sort(function (a, b) { return b.evidenceScore - a.evidenceScore; })[0] || null;
    var resultAnchor = resultMethod && hasNumber(resultMethod.anchorDeg) ? Number(resultMethod.anchorDeg) : null;
    var resultDelta = anchor && hasNumber(resultAnchor) ? anchor.centerDeg - resultAnchor : null;
    var status = !anchor ? 'needs_more_data' : hasNumber(resultDelta) && Math.abs(resultDelta) <= cfg.deliveryResultToleranceDeg ? 'verified_by_result' : hasNumber(resultDelta) ? 'conflict_check' : 'surplus_only';
    return {
      method: 'delivery_cluster',
      status: status,
      anchorDeg: anchor ? anchor.centerDeg : null,
      anchorClub: anchor ? anchor.club : null,
      evidenceScore: anchor ? anchor.evidenceScore : 0,
      resultDeltaDeg: hasNumber(resultDelta) ? round(resultDelta, 2) : null,
      acceptedShots: accepted.length,
      rejectedShots: rejected.length,
      clubClusters: clubClusters,
      showToUser: !!anchor && (status === 'verified_by_result' || status === 'surplus_only' || status === 'conflict_check')
    };
  }

  function combineMethods(resultMethod, deliveryMethod, cfg) {
    var resultDeg = resultMethod && hasNumber(resultMethod.anchorDeg) ? Number(resultMethod.anchorDeg) : null;
    var deliveryDeg = deliveryMethod && hasNumber(deliveryMethod.anchorDeg) ? Number(deliveryMethod.anchorDeg) : null;
    var delta = hasNumber(resultDeg) && hasNumber(deliveryDeg) ? deliveryDeg - resultDeg : null;
    if (hasNumber(delta) && Math.abs(delta) <= cfg.deliveryResultToleranceDeg) {
      return {
        status: 'corroborated',
        offsetDeg: resultDeg,
        evidence: ['result_scaled_cluster', 'delivery_cluster'],
        deltaDeg: round(delta, 2),
        showToUser: true
      };
    }
    if (resultMethod && resultMethod.showToUser && (!deliveryMethod || deliveryMethod.status === 'needs_more_data')) {
      return {
        status: resultMethod.status === 'alignment_signal' ? 'alignment_signal' : 'result_only',
        offsetDeg: resultMethod.anchorDeg,
        evidence: ['result_scaled_cluster'],
        deltaDeg: null,
        showToUser: true
      };
    }
    if (deliveryMethod && deliveryMethod.showToUser && (!resultMethod || resultMethod.status === 'needs_more_data')) {
      return {
        status: 'surplus_only',
        offsetDeg: null,
        evidence: ['delivery_cluster'],
        deltaDeg: null,
        showToUser: false
      };
    }
    if (hasNumber(delta)) {
      return {
        status: 'conflict_check',
        offsetDeg: resultDeg,
        evidence: ['result_scaled_cluster', 'delivery_cluster'],
        deltaDeg: round(delta, 2),
        showToUser: false
      };
    }
    return {
      status: 'needs_more_data',
      offsetDeg: null,
      evidence: [],
      deltaDeg: null,
      showToUser: false
    };
  }

  function analyze(options) {
    var cfg = settings(options && options.settings);
    var store = options && options.store || scopedStore(readStore(), activePlayerScope());
    var accepted = [];
    var rejected = [];
    (store.shots || []).forEach(function (shot) {
      var reason = exclusionReason(shot, cfg);
      if (reason) rejected.push(Object.assign({ rejectReason: reason }, shot));
      else accepted.push(shot);
    });
    var groups = groupByClub(accepted);
    var clusters = Object.keys(groups).map(function (club) {
      return summarizeCluster(club, groups[club], cfg);
    });
    var resultMethod = analyzeResultScaledClusters(accepted, cfg);
    var deliveryMethod = analyzeDeliveryClusters(store.shots || [], cfg, resultMethod);
    var recommendation = combineMethods(resultMethod, deliveryMethod, cfg);
    return {
      settings: cfg,
      totals: {
        sessions: (store.sessions || []).length,
        captures: (store.captures || []).length,
        rawShots: (store.shots || []).length,
        accepted: accepted.length,
        rejected: rejected.length
      },
      acceptedShots: accepted,
      rejectedShots: rejected,
      clusters: clusters,
      methods: {
        resultScaledCluster: resultMethod,
        deliveryCluster: deliveryMethod
      },
      recommendation: recommendation,
      userSignals: [resultMethod, deliveryMethod, recommendation].filter(function (signal) { return signal && signal.showToUser; }),
      generatedAt: new Date().toISOString()
    };
  }

  function analyzeDisplay(options) {
    options = options || {};
    return analyze(Object.assign({}, options, { store: displayStore(options.store) }));
  }

  function clearStore() {
    var scope = activePlayerScope();
    var store = readStore();
    if (scope.playerId) {
      store.sessions = (store.sessions || []).filter(function (session) { return !itemMatchesScope(session, scope); });
      store.captures = (store.captures || []).filter(function (capture) { return !itemMatchesScope(capture, scope); });
      store.shots = (store.shots || []).filter(function (shot) { return !itemMatchesScope(shot, scope); });
      store.rejects = (store.rejects || []).filter(function (shot) { return !itemMatchesScope(shot, scope); });
    } else {
      store = defaultStore();
    }
    saveStore(store);
    return store;
  }

  var api = {
    storageKey: STORAGE_KEY,
    defaults: DEFAULTS,
    getStore: readStore,
    getScopedStore: function () { return scopedStore(readStore(), activePlayerScope()); },
    getDisplayStore: displayStore,
    clearStore: clearStore,
    deleteShots: deleteShots,
    deleteCaptures: deleteCaptures,
    activePlayerScope: activePlayerScope,
    settings: settings,
    importCapture: importCapture,
    captureCanDisplay: captureCanDisplay,
    resolveShotPlot: resolveShotPlot,
    normalizeShot: normalizeShot,
    exclusionReason: exclusionReason,
    deliveryExclusionReason: deliveryExclusionReason,
    analyze: analyze,
    analyzeDisplay: analyzeDisplay
  };

  root.modules.launchMonitorData = api;
  window.GolfDaddyLaunchMonitorData = api;
  window.ClarityCaddieLaunchMonitorData = api;
})();
