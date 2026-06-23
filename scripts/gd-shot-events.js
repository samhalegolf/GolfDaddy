(function () {
  'use strict';

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  var STORAGE_KEY = 'gd_shot_events_v1';
  var ROUND_KEY = 'gd_active_round_id';
  var MERGE_TIME_MS = 20000;
  var MERGE_DISTANCE_M = 5;
  var MAX_OUTCOME_AGE_MS = 45 * 60 * 1000;
  var MAX_ENDPOINT_GPS_ACCURACY_M = 50;
  var MIN_ENDPOINT_CONFIDENCE_RANK = 2;
  var MIN_PAIR_CONFIDENCE = 0.5;
  var SOURCE_PRIORITY = {
    bubble_rendered: 3,
    at_my_ball_button: 2,
    phone_shake: 1
  };
  var SOURCE_CONFIDENCE = {
    bubble_rendered: 'high',
    at_my_ball_button: 'high',
    phone_shake: 'medium'
  };
  var ENDPOINT_SOURCES = {
    at_my_ball_button: true,
    phone_shake: true
  };
  var lastRejection = null;

  function normalizeId(value) {
    return String(value == null ? '' : value).trim();
  }

  function scopeIdFromParts(playerId, accountId, explicitScopeId) {
    var player = normalizeId(playerId);
    if (player) return 'player:' + player;
    var account = normalizeId(accountId);
    if (account) return 'account:' + account;
    var explicit = normalizeId(explicitScopeId);
    if (explicit) return explicit;
    return 'anonymous';
  }

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

    var playerId = normalizeId(profile && profile.id || session && session.viewedProfileId || account && account.profileId || '');
    var playerName = normalizeId(profile && profile.name || session && session.accountName || account && account.name || 'Player');
    var accountId = normalizeId(profile && profile.accountId || account && account.accountId || session && session.accountId || '');

    return {
      playerId: playerId,
      playerName: playerName || 'Player',
      accountId: accountId,
      playerScopeId: scopeIdFromParts(playerId, accountId, '')
    };
  }

  function resolvePlayerScope(input, fallback) {
    input = input || {};
    fallback = fallback || {};
    var active = activePlayerScope();
    var playerId = normalizeId(input.playerId || input.profileId || fallback.playerId || fallback.profileId || active.playerId || '');
    var accountId = normalizeId(input.accountId || fallback.accountId || active.accountId || '');
    var explicitScopeId = normalizeId(input.playerScopeId || fallback.playerScopeId || '');
    return {
      playerId: playerId,
      playerName: normalizeId(input.playerName || fallback.playerName || active.playerName || 'Player') || 'Player',
      accountId: accountId,
      playerScopeId: scopeIdFromParts(playerId, accountId, explicitScopeId)
    };
  }

  function applyPlayerScope(item, scope) {
    if (!item || !scope) return item;
    item.playerScopeId = scope.playerScopeId || scopeIdFromParts(scope.playerId, scope.accountId, '');
    if (scope.playerId) item.playerId = scope.playerId;
    item.playerName = scope.playerName || item.playerName || 'Player';
    if (scope.accountId) item.accountId = scope.accountId;
    return item;
  }

  function itemScopeId(item) {
    return scopeIdFromParts(
      item && (item.playerId || item.profileId || item.playerProfileId),
      item && item.accountId,
      item && item.playerScopeId
    );
  }

  function samePlayerScope(a, b) {
    return itemScopeId(a) === itemScopeId(b);
  }

  function itemMatchesScope(item, scope) {
    if (!scope) return false;
    return itemScopeId(item) === scope.playerScopeId;
  }

  function ensureStoreOwnership(store) {
    return store || defaultStore();
  }

  function scopedCopy(store, scope) {
    scope = scope || activePlayerScope();
    store = ensureStoreOwnership(store || getStore());
    return {
      version: store.version || 1,
      pairingVersion: store.pairingVersion || 2,
      ballEvents: (store.ballEvents || []).filter(function (event) { return itemMatchesScope(event, scope); }),
      plannedShots: (store.plannedShots || []).filter(function (shot) { return itemMatchesScope(shot, scope); }),
      outcomes: (store.outcomes || []).filter(function (outcome) { return itemMatchesScope(outcome, scope); }),
      updatedAt: store.updatedAt
    };
  }

  function defaultStore() {
    return {
      version: 1,
      pairingVersion: 2,
      ballEvents: [],
      plannedShots: [],
      outcomes: [],
      updatedAt: new Date().toISOString()
    };
  }

  function readJson(key) {
    try {
      var value = window.localStorage.getItem(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.warn('[GolfDaddy] shot event read failed', error);
      return null;
    }
  }

  function writeJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.warn('[GolfDaddy] shot event save failed', error);
      return false;
    }
  }

  function getStore() {
    var store = readJson(STORAGE_KEY) || defaultStore();
    store.version = store.version || 1;
    store.pairingVersion = 2;
    store.ballEvents = Array.isArray(store.ballEvents) ? store.ballEvents : [];
    store.plannedShots = Array.isArray(store.plannedShots) ? store.plannedShots : [];
    store.outcomes = Array.isArray(store.outcomes) ? store.outcomes : [];
    return ensureStoreOwnership(store);
  }

  function saveStore(store) {
    store.pairingVersion = 2;
    store.updatedAt = new Date().toISOString();
    writeJson(STORAGE_KEY, store);
    return store;
  }

  function createId(prefix) {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return prefix + '-' + window.crypto.randomUUID();
      }
    } catch (error) {}
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function createTransactionId() {
    return createId('shot-tx');
  }

  function hasNumericValue(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  }

  function asNumber(value, fallback) {
    return hasNumericValue(value) ? Number(value) : fallback;
  }

  function optionalNumber(value) {
    return hasNumericValue(value) ? Number(value) : null;
  }

  function hasLatLng(input) {
    if (!input || !hasNumericValue(input.lat) || !hasNumericValue(input.lng)) return false;
    var lat = Number(input.lat);
    var lng = Number(input.lng);
    return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  }

  function activeRoundId() {
    var scope = activePlayerScope();
    var scopePart = normalizeId(scope.playerId || scope.accountId || 'anonymous')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
    var playerPart = scopePart ? '-' + scopePart : '';
    try {
      var key = ROUND_KEY + playerPart;
      var existing = window.sessionStorage.getItem(key);
      if (existing) return existing;
      var created = 'round' + playerPart + '-' + new Date().toISOString().slice(0, 10);
      window.sessionStorage.setItem(key, created);
      return created;
    } catch (error) {
      return 'round' + playerPart + '-' + new Date().toISOString().slice(0, 10);
    }
  }

  function normalizeSource(source) {
    return SOURCE_PRIORITY[source] ? source : 'at_my_ball_button';
  }

  function eventTypeOf(event) {
    return normalizeId(event && (event.eventType || event.type || event.source));
  }

  function transactionIdOf(item) {
    return normalizeId(item && (item.transactionId || item.shotTransactionId));
  }

  function confidenceRank(confidence) {
    if (confidence === 'high') return 3;
    if (confidence === 'medium') return 2;
    if (confidence === 'low') return 1;
    return 0;
  }

  function distanceMeters(a, b) {
    if (!hasLatLng(a) || !hasLatLng(b)) return Infinity;
    var lat1 = asNumber(a.lat, 0) * Math.PI / 180;
    var lat2 = asNumber(b.lat, 0) * Math.PI / 180;
    var dLat = lat2 - lat1;
    var dLng = (asNumber(b.lng, 0) - asNumber(a.lng, 0)) * Math.PI / 180;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 6371000 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  function createBallPositionEvent(input) {
    input = input || {};
    if (!hasLatLng(input)) {
      throw new Error('BallPositionEvent requires lat and lng');
    }

    var requestedType = normalizeId(input.eventType || input.type || input.source);
    var source = normalizeSource(input.source || requestedType);
    var scope = resolvePlayerScope(input);
    var transactionId = normalizeId(input.transactionId || input.shotTransactionId);
    var eventRole = normalizeId(input.eventRole) || (source === 'bubble_rendered' ? 'origin' : (transactionId ? 'endpoint' : 'position'));
    return applyPlayerScope({
      eventId: input.eventId || createId('bpe'),
      roundId: normalizeId(input.roundId || activeRoundId()),
      holeId: normalizeId(input.holeId),
      source: source,
      eventType: requestedType || source,
      eventRole: eventRole,
      transactionId: transactionId || null,
      plannedShotId: normalizeId(input.plannedShotId || input.shotId) || null,
      timestamp: input.timestamp || new Date().toISOString(),
      lat: asNumber(input.lat, 0),
      lng: asNumber(input.lng, 0),
      gpsAccuracyM: optionalNumber(input.gpsAccuracyM),
      motionContext: input.motionContext || 'unknown',
      courseContext: input.courseContext || 'unknown',
      confidence: input.confidence || SOURCE_CONFIDENCE[source] || 'medium',
      mergedEventIds: Array.isArray(input.mergedEventIds) ? input.mergedEventIds.slice() : [],
      consumedByShotId: normalizeId(input.consumedByShotId) || null,
      consumedByOutcomeId: normalizeId(input.consumedByOutcomeId) || null,
      consumedAt: input.consumedAt || null
    }, scope);
  }

  function eventIsConsumed(store, event) {
    if (!event) return true;
    if (event.consumedByShotId || event.consumedByOutcomeId || event.consumedAt) return true;
    return (store.outcomes || []).some(function (outcome) {
      return outcome && outcome.resultEventId === event.eventId;
    });
  }

  function findMergeCandidate(store, event) {
    var events = store.ballEvents || [];
    var eventTime = Date.parse(event.timestamp);
    for (var i = events.length - 1; i >= 0; i -= 1) {
      var candidate = events[i];
      if (eventIsConsumed(store, candidate)) continue;
      if (!samePlayerScope(candidate, event)) continue;
      if (normalizeId(candidate.roundId) !== normalizeId(event.roundId)) continue;
      if (normalizeId(candidate.holeId) !== normalizeId(event.holeId)) continue;
      if (transactionIdOf(candidate) !== transactionIdOf(event)) continue;
      if (normalizeId(candidate.eventRole) !== normalizeId(event.eventRole)) continue;
      if (eventTypeOf(candidate) !== eventTypeOf(event)) continue;
      var candidateTime = Date.parse(candidate.timestamp);
      if (!Number.isFinite(eventTime) || !Number.isFinite(candidateTime) || Math.abs(eventTime - candidateTime) > MERGE_TIME_MS) continue;
      if (distanceMeters(candidate, event) <= MERGE_DISTANCE_M) return candidate;
    }
    return null;
  }

  function mergeEvents(existing, incoming) {
    var existingPriority = SOURCE_PRIORITY[existing.source] || 0;
    var incomingPriority = SOURCE_PRIORITY[incoming.source] || 0;
    var stronger = incomingPriority > existingPriority ? incoming : existing;
    var weaker = stronger === incoming ? existing : incoming;
    var mergedIds = [];

    [existing.eventId, incoming.eventId]
      .concat(existing.mergedEventIds || [], incoming.mergedEventIds || [])
      .forEach(function (id) {
        if (id && mergedIds.indexOf(id) === -1 && id !== stronger.eventId) mergedIds.push(id);
      });

    existing.source = stronger.source;
    existing.eventType = stronger.eventType || stronger.source;
    existing.eventRole = stronger.eventRole || existing.eventRole;
    existing.transactionId = transactionIdOf(stronger) || transactionIdOf(existing) || null;
    existing.plannedShotId = stronger.plannedShotId || existing.plannedShotId || null;
    existing.confidence = confidenceRank(incoming.confidence) > confidenceRank(existing.confidence) ? incoming.confidence : existing.confidence;
    existing.timestamp = incoming.timestamp > existing.timestamp ? incoming.timestamp : existing.timestamp;
    existing.lat = stronger.lat;
    existing.lng = stronger.lng;
    existing.gpsAccuracyM = stronger.gpsAccuracyM || weaker.gpsAccuracyM || null;
    existing.motionContext = stronger.motionContext || weaker.motionContext || 'unknown';
    existing.courseContext = stronger.courseContext || weaker.courseContext || 'unknown';
    existing.mergedEventIds = mergedIds;
    return existing;
  }

  function plannedShotRenderKey(input, originEvent) {
    var bubble = input.plannedBubble || {};
    var scope = resolvePlayerScope(input, originEvent);
    return [
      scope.playerScopeId,
      normalizeId(input.roundId || originEvent.roundId || activeRoundId()),
      normalizeId(input.holeId || originEvent.holeId || 'hole-unknown'),
      input.club || 'club-unknown',
      Math.round(asNumber(originEvent.lat, 0) * 100000),
      Math.round(asNumber(originEvent.lng, 0) * 100000),
      Math.round(asNumber(bubble.centerLat, 0) * 100000),
      Math.round(asNumber(bubble.centerLng, 0) * 100000),
      Math.round(asNumber(bubble.lengthYards, 0) * 10),
      Math.round(asNumber(bubble.widthYards, 0) * 10)
    ].join(':');
  }

  function buildPlannedShot(input, originEvent) {
    input = input || {};
    var bubble = input.plannedBubble || {};
    var scope = resolvePlayerScope(input, originEvent);
    if (!originEvent || !hasLatLng(originEvent)) {
      throw new Error('PlannedShot requires an origin event');
    }
    if (!Number.isFinite(Number(bubble.centerLat)) || !Number.isFinite(Number(bubble.centerLng))) {
      throw new Error('PlannedShot requires plannedBubble centerLat and centerLng');
    }

    var transactionId = normalizeId(input.transactionId || originEvent.transactionId) || createTransactionId();
    var roundId = normalizeId(input.roundId || originEvent.roundId || activeRoundId());
    var holeId = normalizeId(input.holeId || originEvent.holeId);
    if (!roundId || !holeId) {
      throw new Error('PlannedShot requires roundId and holeId');
    }

    var createdAt = input.createdAt || new Date().toISOString();
    var heldAt = input.heldAt || createdAt;
    if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(heldAt))) {
      throw new Error('PlannedShot requires valid createdAt and heldAt timestamps');
    }
    return applyPlayerScope({
      shotId: input.shotId || createId('shot'),
      transactionId: transactionId,
      transactionStatus: 'active',
      transactionConsumedAt: null,
      transactionClosedAt: null,
      transactionCloseReason: null,
      isActive: true,
      roundId: roundId,
      holeId: holeId,
      originEventId: originEvent.eventId,
      origin: { lat: asNumber(originEvent.lat, 0), lng: asNumber(originEvent.lng, 0) },
      plannedBubble: {
        transactionId: transactionId,
        centerLat: asNumber(bubble.centerLat, 0),
        centerLng: asNumber(bubble.centerLng, 0),
        orientationDeg: asNumber(bubble.orientationDeg, 0),
        lengthYards: asNumber(bubble.lengthYards, 0),
        widthYards: asNumber(bubble.widthYards, 0),
        shape: bubble.shape === 'capsule' ? 'capsule' : 'oval'
      },
      club: input.club || null,
      expectedDistanceYards: optionalNumber(input.expectedDistanceYards),
      renderKey: input.renderKey || plannedShotRenderKey(input, originEvent),
      captureReason: input.captureReason || null,
      createdAt: createdAt,
      heldAt: heldAt,
      pairedOutcomeId: null,
      endpointEventId: null
    }, scope);
  }

  function shotIsOpen(shot) {
    if (!shot || shot.pairedOutcomeId || shot.transactionConsumedAt) return false;
    if (!transactionIdOf(shot)) return false;
    var status = normalizeId(shot.transactionStatus || 'active');
    return shot.isActive !== false && status === 'active';
  }

  function findOriginEvent(store, shot) {
    return (store.ballEvents || []).find(function (event) {
      return event && event.eventId === shot.originEventId;
    }) || null;
  }

  function validateHeldShot(store, shot) {
    if (!shotIsOpen(shot)) return { valid: false, reason: 'no_active_transaction' };
    if (!shot.plannedBubble || !hasLatLng({ lat: shot.plannedBubble.centerLat, lng: shot.plannedBubble.centerLng })) {
      return { valid: false, reason: 'invalid_held_bubble' };
    }
    if (!hasLatLng(shot.origin)) return { valid: false, reason: 'invalid_held_origin' };
    var transactionId = transactionIdOf(shot);
    if (!transactionId) return { valid: false, reason: 'missing_transaction_id' };
    if (normalizeId(shot.plannedBubble.transactionId) !== transactionId) {
      return { valid: false, reason: 'held_bubble_transaction_mismatch' };
    }
    if (!normalizeId(shot.roundId)) return { valid: false, reason: 'missing_round_id' };
    if (!normalizeId(shot.holeId)) return { valid: false, reason: 'missing_hole_id' };
    if (!Number.isFinite(Date.parse(shot.heldAt || shot.createdAt))) return { valid: false, reason: 'invalid_held_timestamp' };
    var originEvent = findOriginEvent(store, shot);
    if (!originEvent) return { valid: false, reason: 'missing_held_origin_event' };
    if (eventTypeOf(originEvent) !== 'bubble_rendered' && normalizeId(originEvent.source) !== 'bubble_rendered') {
      return { valid: false, reason: 'invalid_held_origin_event' };
    }
    if (normalizeId(originEvent.eventRole) !== 'origin') return { valid: false, reason: 'invalid_held_origin_role' };
    if (originEvent.plannedShotId && originEvent.plannedShotId !== shot.shotId) return { valid: false, reason: 'origin_planned_shot_mismatch' };
    if (eventIsConsumed(store, originEvent)) return { valid: false, reason: 'held_origin_already_consumed' };
    if (transactionIdOf(originEvent) !== transactionId) return { valid: false, reason: 'origin_transaction_mismatch' };
    if (!samePlayerScope(shot, originEvent)) return { valid: false, reason: 'player_scope_mismatch' };
    if (normalizeId(shot.roundId) !== normalizeId(originEvent.roundId)) return { valid: false, reason: 'round_mismatch' };
    if (normalizeId(shot.holeId) !== normalizeId(originEvent.holeId)) return { valid: false, reason: 'hole_mismatch' };
    return { valid: true, originEvent: originEvent };
  }

  function findRecentPlannedShot(store, shot) {
    if (!shot.renderKey) return null;
    var created = Date.parse(shot.createdAt);
    for (var i = store.plannedShots.length - 1; i >= 0; i -= 1) {
      var existing = store.plannedShots[i];
      if (!shotIsOpen(existing)) continue;
      if (!samePlayerScope(existing, shot)) continue;
      if (normalizeId(existing.roundId) !== normalizeId(shot.roundId)) continue;
      if (normalizeId(existing.holeId) !== normalizeId(shot.holeId)) continue;
      if (existing.renderKey !== shot.renderKey) continue;
      var existingCreated = Date.parse(existing.createdAt);
      if (!Number.isFinite(created) || !Number.isFinite(existingCreated) || Math.abs(created - existingCreated) <= 30000) {
        existing.updatedAt = new Date().toISOString();
        return existing;
      }
    }
    return null;
  }

  function supersedeOtherActiveShots(store, activeShot) {
    var closedAt = new Date().toISOString();
    (store.plannedShots || []).forEach(function (shot) {
      if (!shot || shot.shotId === activeShot.shotId || !shotIsOpen(shot)) return;
      if (!samePlayerScope(shot, activeShot)) return;
      shot.transactionStatus = 'superseded';
      shot.transactionClosedAt = closedAt;
      shot.transactionCloseReason = 'new_held_shot';
      shot.isActive = false;
    });
  }

  function scorePair(plannedShot, event) {
    if (eventTypeOf(event) === 'bubble_rendered' || event.source === 'bubble_rendered') return 0;
    var sourceScore = { at_my_ball_button: 0.9, phone_shake: 0.65 }[event.source] || 0.55;
    var created = Date.parse(plannedShot.heldAt || plannedShot.createdAt);
    var happened = Date.parse(event.timestamp);
    var minutes = Number.isFinite(created) && Number.isFinite(happened) ? Math.max((happened - created) / 60000, 0) : Infinity;
    var timePenalty = minutes > 30 ? 0.2 : minutes > 15 ? 0.08 : 0;
    var accuracy = Number(event.gpsAccuracyM);
    var accuracyPenalty = Number.isFinite(accuracy) && accuracy > 30 ? 0.2 : Number.isFinite(accuracy) && accuracy > 15 ? 0.08 : 0;
    return Math.max(0, Math.min(0.98, sourceScore - timePenalty - accuracyPenalty));
  }

  function outcomeExistsForShot(store, shot) {
    return (store.outcomes || []).some(function (outcome) {
      return outcome && (outcome.shotId === shot.shotId || (transactionIdOf(outcome) && transactionIdOf(outcome) === transactionIdOf(shot)));
    });
  }

  function validateOutcomeCandidate(store, shot, event) {
    var held = validateHeldShot(store, shot);
    if (!held.valid) return held;
    if (!event || !hasLatLng(event)) return { valid: false, reason: 'invalid_endpoint' };
    if (eventTypeOf(event) === 'bubble_rendered' || normalizeId(event.source) === 'bubble_rendered' || normalizeId(event.eventRole) === 'origin') {
      return { valid: false, reason: 'bubble_rendered_not_outcome' };
    }
    if (normalizeId(event.eventRole) !== 'endpoint') return { valid: false, reason: 'unpaired_endpoint' };
    if (!ENDPOINT_SOURCES[normalizeId(event.source)]) return { valid: false, reason: 'unsupported_endpoint_type' };

    var shotTransactionId = transactionIdOf(shot);
    var eventTransactionId = transactionIdOf(event);
    if (!eventTransactionId) return { valid: false, reason: 'unpaired_endpoint' };
    if (eventTransactionId !== shotTransactionId) return { valid: false, reason: 'transaction_mismatch' };
    if (event.plannedShotId && event.plannedShotId !== shot.shotId) return { valid: false, reason: 'planned_shot_mismatch' };
    if (!samePlayerScope(shot, event)) return { valid: false, reason: 'player_scope_mismatch' };
    if (normalizeId(event.roundId) !== normalizeId(shot.roundId)) return { valid: false, reason: 'round_mismatch' };
    if (normalizeId(event.holeId) !== normalizeId(shot.holeId)) return { valid: false, reason: 'hole_mismatch' };
    if (event.eventId === shot.originEventId) return { valid: false, reason: 'origin_cannot_be_endpoint' };
    if (eventIsConsumed(store, event)) return { valid: false, reason: 'endpoint_reused' };
    if (outcomeExistsForShot(store, shot)) return { valid: false, reason: 'transaction_consumed' };

    var heldAt = Date.parse(shot.heldAt || shot.createdAt);
    var happenedAt = Date.parse(event.timestamp);
    if (!Number.isFinite(heldAt) || !Number.isFinite(happenedAt) || happenedAt < heldAt) {
      return { valid: false, reason: 'endpoint_before_held_shot' };
    }
    if (happenedAt - heldAt > MAX_OUTCOME_AGE_MS) return { valid: false, reason: 'stale_outcome' };
    if (confidenceRank(event.confidence) < MIN_ENDPOINT_CONFIDENCE_RANK) return { valid: false, reason: 'low_confidence' };
    var gpsAccuracyM = optionalNumber(event.gpsAccuracyM);
    if (gpsAccuracyM !== null && gpsAccuracyM < 0) return { valid: false, reason: 'invalid_gps_accuracy' };
    if (gpsAccuracyM !== null && gpsAccuracyM > MAX_ENDPOINT_GPS_ACCURACY_M) {
      return { valid: false, reason: 'weak_gps' };
    }

    var pairedConfidence = scorePair(shot, event);
    if (pairedConfidence < MIN_PAIR_CONFIDENCE) return { valid: false, reason: 'low_pair_confidence' };
    return { valid: true, pairedConfidence: pairedConfidence, originEvent: held.originEvent };
  }

  function rejection(reason, details) {
    var result = {
      saved: false,
      rejected: true,
      rejectedReason: reason || 'rejected'
    };
    details = details || {};
    Object.keys(details).forEach(function (key) { result[key] = details[key]; });
    lastRejection = result;
    return result;
  }

  function consumeOutcome(store, shot, event, eventAlreadyStored) {
    var validation = validateOutcomeCandidate(store, shot, event);
    if (!validation.valid) {
      return rejection(validation.reason, {
        shotId: shot && shot.shotId || null,
        transactionId: transactionIdOf(shot) || transactionIdOf(event) || null,
        eventId: event && event.eventId || null
      });
    }

    var outcomeModule = root.modules.shotOutcomes;
    if (!outcomeModule || typeof outcomeModule.computeShotOutcome !== 'function') {
      return rejection('outcome_engine_unavailable', {
        shotId: shot.shotId,
        transactionId: transactionIdOf(shot),
        eventId: event.eventId
      });
    }

    var outcomeId = createId('outcome');
    var outcome = outcomeModule.computeShotOutcome(shot, event, {
      outcomeId: outcomeId,
      pairedConfidence: validation.pairedConfidence
    });
    if (!outcome) {
      return rejection('outcome_not_computable', {
        shotId: shot.shotId,
        transactionId: transactionIdOf(shot),
        eventId: event.eventId
      });
    }

    var consumedAt = new Date().toISOString();
    outcome.outcomeId = outcomeId;
    outcome.transactionId = transactionIdOf(shot);
    outcome.roundId = shot.roundId;
    outcome.holeId = shot.holeId;
    outcome.resultEventType = eventTypeOf(event);
    applyPlayerScope(outcome, resolvePlayerScope(shot, event));

    event.eventRole = 'endpoint';
    event.transactionId = transactionIdOf(shot);
    event.plannedShotId = shot.shotId;
    event.consumedByShotId = shot.shotId;
    event.consumedByOutcomeId = outcomeId;
    event.consumedAt = consumedAt;

    shot.pairedOutcomeId = outcomeId;
    shot.endpointEventId = event.eventId;
    shot.transactionStatus = 'consumed';
    shot.transactionConsumedAt = consumedAt;
    shot.transactionClosedAt = consumedAt;
    shot.transactionCloseReason = 'shot_end_saved';
    shot.isActive = false;

    if (!eventAlreadyStored) store.ballEvents.push(event);
    store.outcomes.push(outcome);
    lastRejection = null;
    return {
      saved: true,
      rejected: false,
      event: event,
      outcome: outcome,
      shot: shot,
      shotId: shot.shotId,
      transactionId: transactionIdOf(shot)
    };
  }

  function findPendingShot(store, criteria) {
    criteria = criteria || {};
    var scope = resolvePlayerScope(criteria);
    var roundId = normalizeId(criteria.roundId);
    var holeId = normalizeId(criteria.holeId);
    var transactionId = normalizeId(criteria.transactionId || criteria.shotTransactionId);
    var shotId = normalizeId(criteria.shotId || criteria.plannedShotId);
    var candidates = (store.plannedShots || []).filter(function (shot) {
      if (!shot || !itemMatchesScope(shot, scope)) return false;
      if (roundId && normalizeId(shot.roundId) !== roundId) return false;
      if (holeId && normalizeId(shot.holeId) !== holeId) return false;
      if (transactionId && transactionIdOf(shot) !== transactionId) return false;
      if (shotId && shot.shotId !== shotId) return false;
      return validateHeldShot(store, shot).valid;
    }).sort(function (a, b) {
      return Date.parse(b.heldAt || b.createdAt) - Date.parse(a.heldAt || a.createdAt);
    });
    return candidates[0] || null;
  }

  function getPendingShot(criteria) {
    return findPendingShot(getStore(), criteria || {});
  }

  function clearPendingShot(criteria) {
    criteria = criteria || {};
    var store = getStore();
    var scope = resolvePlayerScope(criteria);
    var roundId = normalizeId(criteria.roundId);
    var holeId = normalizeId(criteria.holeId);
    var transactionId = normalizeId(criteria.transactionId || criteria.shotTransactionId);
    var shotId = normalizeId(criteria.shotId || criteria.plannedShotId);
    var closedAt = new Date().toISOString();
    var cleared = [];

    (store.plannedShots || []).forEach(function (shot) {
      if (!shot || !shotIsOpen(shot) || !itemMatchesScope(shot, scope)) return;
      if (roundId && normalizeId(shot.roundId) !== roundId) return;
      if (holeId && normalizeId(shot.holeId) !== holeId) return;
      if (transactionId && transactionIdOf(shot) !== transactionId) return;
      if (shotId && shot.shotId !== shotId) return;
      shot.transactionStatus = 'abandoned';
      shot.transactionClosedAt = closedAt;
      shot.transactionCloseReason = criteria.reason || 'cleared';
      shot.isActive = false;
      cleared.push(shot);
    });

    if (cleared.length) saveStore(store);
    return cleared;
  }

  function pairPendingShots(store) {
    store = store || getStore();
    var createdOutcomes = [];
    var shots = (store.plannedShots || []).filter(function (shot) {
      return validateHeldShot(store, shot).valid;
    }).sort(function (a, b) {
      return Date.parse(a.heldAt || a.createdAt) - Date.parse(b.heldAt || b.createdAt);
    });

    shots.forEach(function (shot) {
      var result = (store.ballEvents || []).filter(function (event) {
        if (!event || transactionIdOf(event) !== transactionIdOf(shot)) return false;
        return validateOutcomeCandidate(store, shot, event).valid;
      }).sort(function (a, b) {
        return Date.parse(a.timestamp) - Date.parse(b.timestamp);
      })[0];

      if (!result) return;
      var consumed = consumeOutcome(store, shot, result, true);
      if (consumed && consumed.saved) createdOutcomes.push(consumed.outcome);
    });

    return createdOutcomes;
  }

  function logOutcomeForPending(input) {
    input = input || {};
    var store = getStore();
    var transactionId = normalizeId(input.transactionId || input.shotTransactionId);
    var roundId = normalizeId(input.roundId);
    var holeId = normalizeId(input.holeId);
    if (!transactionId) return rejection('unpaired_endpoint', { transactionId: null });
    if (!roundId) return rejection('missing_round_id', { transactionId: transactionId });
    if (!holeId) return rejection('missing_hole_id', { transactionId: transactionId });

    var shot = findPendingShot(store, {
      playerId: input.playerId,
      profileId: input.profileId,
      playerScopeId: input.playerScopeId,
      accountId: input.accountId,
      roundId: roundId,
      holeId: holeId,
      transactionId: transactionId,
      shotId: input.shotId || input.plannedShotId
    });
    if (!shot) {
      return rejection('no_valid_held_shot', {
        transactionId: transactionId,
        shotId: normalizeId(input.shotId || input.plannedShotId) || null,
        roundId: roundId,
        holeId: holeId
      });
    }

    var event;
    try {
      event = createBallPositionEvent({
        eventId: input.eventId,
        roundId: roundId,
        holeId: holeId,
        playerId: input.playerId,
        profileId: input.profileId,
        playerName: input.playerName,
        playerScopeId: input.playerScopeId,
        accountId: input.accountId,
        source: input.source,
        eventType: input.eventType || input.source,
        eventRole: 'endpoint',
        transactionId: transactionId,
        plannedShotId: shot.shotId,
        timestamp: input.timestamp,
        lat: input.lat,
        lng: input.lng,
        gpsAccuracyM: input.gpsAccuracyM,
        motionContext: input.motionContext,
        courseContext: input.courseContext,
        confidence: input.confidence
      });
    } catch (error) {
      return rejection('invalid_endpoint', {
        transactionId: transactionId,
        shotId: shot.shotId
      });
    }

    var consumed = consumeOutcome(store, shot, event, false);
    if (!consumed.saved) return consumed;
    saveStore(store);
    return consumed;
  }

  function logBallPosition(input) {
    input = input || {};
    var source = normalizeSource(input.source || input.eventType);
    if (source === 'at_my_ball_button' || source === 'phone_shake' || normalizeId(input.eventRole) === 'endpoint') {
      return logOutcomeForPending(input);
    }

    var store = getStore();
    var event = createBallPositionEvent(input);
    var mergeTarget = findMergeCandidate(store, event);
    if (mergeTarget) {
      mergeEvents(mergeTarget, event);
      saveStore(store);
      return { event: mergeTarget, merged: true, saved: true };
    }

    store.ballEvents.push(event);
    saveStore(store);
    return { event: event, merged: false, saved: true };
  }

  function transactionIdIsUsed(store, transactionId, exceptShotId) {
    var id = normalizeId(transactionId);
    if (!id) return false;
    return (store.plannedShots || []).some(function (shot) {
      return shot && shot.shotId !== exceptShotId && transactionIdOf(shot) === id;
    }) || (store.outcomes || []).some(function (outcome) {
      return outcome && transactionIdOf(outcome) === id;
    });
  }

  function uniqueTransactionId(store, preferred, exceptShotId) {
    var candidate = normalizeId(preferred);
    if (candidate && !transactionIdIsUsed(store, candidate, exceptShotId)) return candidate;
    do {
      candidate = createTransactionId();
    } while (transactionIdIsUsed(store, candidate, exceptShotId));
    return candidate;
  }

  function logPlannedShot(input) {
    var store = getStore();
    input = input || {};
    var originEvent = null;
    var originNeedsSave = false;

    if (input.originEventId) {
      originEvent = store.ballEvents.find(function (event) {
        return event.eventId === input.originEventId;
      });
    }

    var originOwner = originEvent && (store.plannedShots || []).find(function (shot) {
      return shot && shot.originEventId === originEvent.eventId;
    });
    if (originOwner) {
      throw new Error('Origin event already belongs to a held shot');
    }
    var originTransactionId = normalizeId(originEvent && originEvent.transactionId);
    var requestedTransactionId = normalizeId(input.transactionId);
    if (originTransactionId && requestedTransactionId && originTransactionId !== requestedTransactionId) {
      throw new Error('Origin event transaction does not match requested transaction');
    }
    var transactionId = uniqueTransactionId(store, originTransactionId || requestedTransactionId, normalizeId(input.shotId));
    if (!originEvent && hasLatLng(input.origin)) {
      originEvent = createBallPositionEvent({
        roundId: input.roundId,
        holeId: input.holeId,
        playerId: input.playerId,
        profileId: input.profileId,
        playerName: input.playerName,
        playerScopeId: input.playerScopeId,
        accountId: input.accountId,
        source: 'bubble_rendered',
        eventType: 'bubble_rendered',
        eventRole: 'origin',
        transactionId: transactionId,
        timestamp: input.createdAt,
        lat: input.origin.lat,
        lng: input.origin.lng,
        confidence: 'high'
      });
      originNeedsSave = true;
    }

    if (!originEvent || eventTypeOf(originEvent) !== 'bubble_rendered') {
      throw new Error('PlannedShot requires a bubble_rendered origin event');
    }
    originEvent.transactionId = transactionId;
    originEvent.eventRole = 'origin';

    var shot = buildPlannedShot({
      shotId: input.shotId,
      transactionId: transactionId,
      roundId: input.roundId,
      holeId: input.holeId,
      playerId: input.playerId,
      profileId: input.profileId,
      playerName: input.playerName,
      playerScopeId: input.playerScopeId,
      accountId: input.accountId,
      plannedBubble: input.plannedBubble,
      club: input.club,
      expectedDistanceYards: input.expectedDistanceYards,
      renderKey: input.renderKey,
      captureReason: input.captureReason,
      createdAt: input.createdAt,
      heldAt: input.heldAt
    }, originEvent);

    var existingShot = findRecentPlannedShot(store, shot);
    if (existingShot) {
      saveStore(store);
      return existingShot;
    }

    originEvent.plannedShotId = shot.shotId;
    supersedeOtherActiveShots(store, shot);
    if (originNeedsSave) store.ballEvents.push(originEvent);
    store.plannedShots.push(shot);
    saveStore(store);
    return shot;
  }

  function captureBubbleRendered(input) {
    input = input || {};
    if (!hasLatLng(input.origin)) {
      throw new Error('captureBubbleRendered requires origin lat/lng');
    }

    var transactionId = normalizeId(input.transactionId) || createTransactionId();
    return logPlannedShot({
      transactionId: transactionId,
      roundId: input.roundId,
      holeId: input.holeId,
      playerId: input.playerId,
      profileId: input.profileId,
      playerName: input.playerName,
      playerScopeId: input.playerScopeId,
      accountId: input.accountId,
      origin: input.origin,
      plannedBubble: input.plannedBubble,
      club: input.club,
      expectedDistanceYards: input.expectedDistanceYards,
      renderKey: input.renderKey,
      captureReason: input.captureReason,
      createdAt: input.createdAt,
      heldAt: input.heldAt
    });
  }

  function clearStore() {
    var scope = activePlayerScope();
    var store = getStore();
    store.ballEvents = (store.ballEvents || []).filter(function (event) { return !itemMatchesScope(event, scope); });
    store.plannedShots = (store.plannedShots || []).filter(function (shot) { return !itemMatchesScope(shot, scope); });
    store.outcomes = (store.outcomes || []).filter(function (outcome) { return !itemMatchesScope(outcome, scope); });
    saveStore(store);
    return store;
  }

  function replaceScopedStore(nextStore) {
    var scope = activePlayerScope();
    var store = getStore();
    var incoming = nextStore || defaultStore();
    incoming.ballEvents = Array.isArray(incoming.ballEvents) ? incoming.ballEvents : [];
    incoming.plannedShots = Array.isArray(incoming.plannedShots) ? incoming.plannedShots : [];
    incoming.outcomes = Array.isArray(incoming.outcomes) ? incoming.outcomes : [];
    incoming.ballEvents.forEach(function (event) { applyPlayerScope(event, scope); });
    incoming.plannedShots.forEach(function (shot) { applyPlayerScope(shot, scope); });
    incoming.outcomes.forEach(function (outcome) { applyPlayerScope(outcome, scope); });
    store.ballEvents = (store.ballEvents || []).filter(function (event) { return !itemMatchesScope(event, scope); }).concat(incoming.ballEvents);
    store.plannedShots = (store.plannedShots || []).filter(function (shot) { return !itemMatchesScope(shot, scope); }).concat(incoming.plannedShots);
    store.outcomes = (store.outcomes || []).filter(function (outcome) { return !itemMatchesScope(outcome, scope); }).concat(incoming.outcomes);
    return saveStore(store);
  }

  function deleteShot(shotId) {
    var id = normalizeId(shotId);
    if (!id) return false;
    var scope = activePlayerScope();
    var store = getStore();
    var target = (store.plannedShots || []).find(function (shot) {
      return shot && shot.shotId === id && itemMatchesScope(shot, scope);
    });
    if (!target) return false;
    var outcomeIds = (store.outcomes || []).filter(function (outcome) {
      return outcome && outcome.shotId === id && itemMatchesScope(outcome, scope);
    }).map(function (outcome) { return outcome.outcomeId; });
    store.plannedShots = (store.plannedShots || []).filter(function (shot) {
      return !(shot && shot.shotId === id && itemMatchesScope(shot, scope));
    });
    store.outcomes = (store.outcomes || []).filter(function (outcome) {
      return !(outcome && outcome.shotId === id && itemMatchesScope(outcome, scope));
    });
    store.ballEvents = (store.ballEvents || []).filter(function (event) {
      if (!event || !itemMatchesScope(event, scope)) return true;
      if (event.eventId === target.originEventId || event.plannedShotId === id || event.consumedByShotId === id) return false;
      if (event.consumedByOutcomeId && outcomeIds.indexOf(event.consumedByOutcomeId) !== -1) return false;
      return true;
    });
    saveStore(store);
    return true;
  }

  var api = {
    storageKey: STORAGE_KEY,
    pairingRules: {
      maxOutcomeAgeMs: MAX_OUTCOME_AGE_MS,
      maxEndpointGpsAccuracyM: MAX_ENDPOINT_GPS_ACCURACY_M,
      minEndpointConfidence: 'medium',
      minPairConfidence: MIN_PAIR_CONFIDENCE,
      bubbleRenderedCanBeOutcome: false,
      endpointReuseAllowed: false,
      transactionMatchRequired: true,
      sameHoleRequired: true,
      sameRoundRequired: true,
      samePlayerScopeRequired: true
    },
    createBallPositionEvent: createBallPositionEvent,
    logBallPosition: logBallPosition,
    logPlannedShot: logPlannedShot,
    captureBubbleRendered: captureBubbleRendered,
    getPendingShot: getPendingShot,
    clearPendingShot: clearPendingShot,
    logOutcomeForPending: logOutcomeForPending,
    pairPendingShots: function () {
      var store = getStore();
      var outcomes = pairPendingShots(store);
      if (outcomes.length) saveStore(store);
      return outcomes;
    },
    getLastRejection: function () { return lastRejection; },
    getStore: getStore,
    getScopedStore: function () { return scopedCopy(getStore(), activePlayerScope()); },
    replaceScopedStore: replaceScopedStore,
    deleteShot: deleteShot,
    clearStore: clearStore,
    listBallEvents: function () { return scopedCopy(getStore(), activePlayerScope()).ballEvents.slice(); },
    listPlannedShots: function () { return scopedCopy(getStore(), activePlayerScope()).plannedShots.slice(); },
    listOutcomes: function () { return scopedCopy(getStore(), activePlayerScope()).outcomes.slice(); },
    activePlayerScope: activePlayerScope,
    distanceMeters: distanceMeters
  };

  root.modules.shotEvents = api;
  window.GolfDaddyShotEvents = api;
  window.ClarityCaddieShotEvents = api;
})();
