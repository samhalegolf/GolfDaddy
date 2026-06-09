(function () {
  'use strict';

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  var STORAGE_KEY = 'gd_shot_events_v1';
  var ROUND_KEY = 'gd_active_round_id';
  var MERGE_TIME_MS = 20000;
  var MERGE_DISTANCE_M = 5;
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

  function samePlayerScope(a, b) {
    var aId = itemPlayerId(a);
    var bId = itemPlayerId(b);
    if (aId || bId) return !!aId && !!bId && aId === bId;
    return true;
  }

  function itemMatchesScope(item, scope) {
    if (!scope || !scope.playerId) return true;
    return itemPlayerId(item) === scope.playerId;
  }

  function ensureStoreOwnership(store) {
    return store || defaultStore();
  }

  function scopedCopy(store, scope) {
    scope = scope || activePlayerScope();
    store = ensureStoreOwnership(store || getStore());
    return {
      version: store.version || 1,
      ballEvents: (store.ballEvents || []).filter(function (event) { return itemMatchesScope(event, scope); }),
      plannedShots: (store.plannedShots || []).filter(function (shot) { return itemMatchesScope(shot, scope); }),
      outcomes: (store.outcomes || []).filter(function (outcome) { return itemMatchesScope(outcome, scope); }),
      updatedAt: store.updatedAt
    };
  }

  function defaultStore() {
    return {
      version: 1,
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
    } catch (error) {
      console.warn('[GolfDaddy] shot event save failed', error);
    }
  }

  function getStore() {
    var store = readJson(STORAGE_KEY) || defaultStore();
    store.ballEvents = Array.isArray(store.ballEvents) ? store.ballEvents : [];
    store.plannedShots = Array.isArray(store.plannedShots) ? store.plannedShots : [];
    store.outcomes = Array.isArray(store.outcomes) ? store.outcomes : [];
    return ensureStoreOwnership(store);
  }

  function saveStore(store) {
    store.updatedAt = new Date().toISOString();
    writeJson(STORAGE_KEY, store);
    return store;
  }

  function createId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function asNumber(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function hasLatLng(input) {
    return input && Number.isFinite(Number(input.lat)) && Number.isFinite(Number(input.lng));
  }

  function activeRoundId() {
    var scope = activePlayerScope();
    var playerPart = scope.playerId ? '-' + scope.playerId.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 24) : '';
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

    var source = normalizeSource(input.source);
    var scope = resolvePlayerScope(input);
    return applyPlayerScope({
      eventId: input.eventId || createId('bpe'),
      roundId: input.roundId || activeRoundId(),
      holeId: input.holeId || null,
      source: source,
      timestamp: input.timestamp || new Date().toISOString(),
      lat: asNumber(input.lat, 0),
      lng: asNumber(input.lng, 0),
      gpsAccuracyM: Number.isFinite(Number(input.gpsAccuracyM)) ? Number(input.gpsAccuracyM) : null,
      motionContext: input.motionContext || 'unknown',
      courseContext: input.courseContext || 'unknown',
      confidence: input.confidence || SOURCE_CONFIDENCE[source] || 'medium',
      mergedEventIds: Array.isArray(input.mergedEventIds) ? input.mergedEventIds.slice() : []
    }, scope);
  }

  function findMergeCandidate(events, event) {
    var eventTime = Date.parse(event.timestamp);
    for (var i = events.length - 1; i >= 0; i -= 1) {
      var candidate = events[i];
      if (!samePlayerScope(candidate, event)) continue;
      if (candidate.roundId !== event.roundId) continue;
      var candidateTime = Date.parse(candidate.timestamp);
      if (!Number.isFinite(candidateTime) || Math.abs(eventTime - candidateTime) > MERGE_TIME_MS) continue;
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

    return applyPlayerScope({
      shotId: input.shotId || createId('shot'),
      roundId: input.roundId || originEvent.roundId || activeRoundId(),
      holeId: input.holeId || originEvent.holeId || null,
      originEventId: originEvent.eventId,
      origin: { lat: asNumber(originEvent.lat, 0), lng: asNumber(originEvent.lng, 0) },
      plannedBubble: {
        centerLat: asNumber(bubble.centerLat, 0),
        centerLng: asNumber(bubble.centerLng, 0),
        orientationDeg: asNumber(bubble.orientationDeg, 0),
        lengthYards: asNumber(bubble.lengthYards, 0),
        widthYards: asNumber(bubble.widthYards, 0),
        shape: bubble.shape === 'capsule' ? 'capsule' : 'oval'
      },
      club: input.club || null,
      expectedDistanceYards: Number.isFinite(Number(input.expectedDistanceYards)) ? Number(input.expectedDistanceYards) : null,
      renderKey: input.renderKey || plannedShotRenderKey(input, originEvent),
      createdAt: input.createdAt || new Date().toISOString(),
      pairedOutcomeId: null
    }, scope);
  }

  function plannedShotRenderKey(input, originEvent) {
    var bubble = input.plannedBubble || {};
    var scope = resolvePlayerScope(input, originEvent);
    return [
      scope.playerId || 'player-unknown',
      input.roundId || originEvent.roundId || activeRoundId(),
      input.holeId || originEvent.holeId || 'hole-unknown',
      input.club || 'club-unknown',
      Math.round(asNumber(originEvent.lat, 0) * 100000),
      Math.round(asNumber(originEvent.lng, 0) * 100000),
      Math.round(asNumber(bubble.centerLat, 0) * 100000),
      Math.round(asNumber(bubble.centerLng, 0) * 100000),
      Math.round(asNumber(bubble.lengthYards, 0) * 10),
      Math.round(asNumber(bubble.widthYards, 0) * 10)
    ].join(':');
  }

  function findRecentPlannedShot(store, shot) {
    if (!shot.renderKey) return null;
    var created = Date.parse(shot.createdAt);
    for (var i = store.plannedShots.length - 1; i >= 0; i -= 1) {
      var existing = store.plannedShots[i];
      if (existing.renderKey !== shot.renderKey || existing.pairedOutcomeId) continue;
      var existingCreated = Date.parse(existing.createdAt);
      if (!Number.isFinite(created) || !Number.isFinite(existingCreated) || Math.abs(created - existingCreated) <= 30000) {
        existing.updatedAt = new Date().toISOString();
        return existing;
      }
    }
    return null;
  }

  function scorePair(plannedShot, event) {
    var sourceScore = { bubble_rendered: 0.95, at_my_ball_button: 0.9, phone_shake: 0.65 }[event.source] || 0.55;
    var created = Date.parse(plannedShot.createdAt);
    var happened = Date.parse(event.timestamp);
    var minutes = Number.isFinite(created) && Number.isFinite(happened) ? Math.max((happened - created) / 60000, 0) : 0;
    var timePenalty = minutes > 45 ? 0.25 : minutes > 20 ? 0.12 : 0;
    var accuracy = Number(event.gpsAccuracyM);
    var accuracyPenalty = Number.isFinite(accuracy) && accuracy > 30 ? 0.2 : Number.isFinite(accuracy) && accuracy > 15 ? 0.08 : 0;
    return Math.max(0.1, Math.min(0.98, sourceScore - timePenalty - accuracyPenalty));
  }

	  function outcomeExists(store, shotId) {
	    return store.outcomes.some(function (outcome) {
	      return outcome.shotId === shotId;
	    });
	  }

  function pairPendingShots(store) {
    var outcomeModule = root.modules.shotOutcomes;
    if (!outcomeModule || typeof outcomeModule.computeShotOutcome !== 'function') {
      return [];
    }

    var createdOutcomes = [];
    store.plannedShots.forEach(function (shot) {
      if (shot.pairedOutcomeId || outcomeExists(store, shot.shotId)) return;

      var created = Date.parse(shot.createdAt);
      var result = store.ballEvents
        .filter(function (event) {
	          var happened = Date.parse(event.timestamp);
	          return event.roundId === shot.roundId &&
	            samePlayerScope(shot, event) &&
	            event.eventId !== shot.originEventId &&
	            Number.isFinite(created) &&
            Number.isFinite(happened) &&
            happened >= created;
        })
        .sort(function (a, b) {
          return Date.parse(a.timestamp) - Date.parse(b.timestamp);
        })[0];

      if (!result) return;

      var outcomeId = createId('outcome');
      var outcome = outcomeModule.computeShotOutcome(shot, result, {
        outcomeId: outcomeId,
        pairedConfidence: scorePair(shot, result)
      });
	      if (!outcome) return;

	      outcome.outcomeId = outcomeId;
	      applyPlayerScope(outcome, resolvePlayerScope(shot, result));
	      shot.pairedOutcomeId = outcomeId;
      store.outcomes.push(outcome);
      createdOutcomes.push(outcome);
    });

    return createdOutcomes;
  }

  function logBallPosition(input) {
    var store = getStore();
    var event = createBallPositionEvent(input);
    var mergeTarget = findMergeCandidate(store.ballEvents, event);
    if (mergeTarget) {
      mergeEvents(mergeTarget, event);
      pairPendingShots(store);
      saveStore(store);
      return { event: mergeTarget, merged: true };
    }

    store.ballEvents.push(event);
    pairPendingShots(store);
    saveStore(store);
    return { event: event, merged: false };
  }

  function logPlannedShot(input) {
    var store = getStore();
    input = input || {};
    var originEvent = null;

    if (input.originEventId) {
      originEvent = store.ballEvents.find(function (event) {
        return event.eventId === input.originEventId;
      });
    }

    if (!originEvent && hasLatLng(input.origin)) {
      originEvent = createBallPositionEvent({
        roundId: input.roundId,
        holeId: input.holeId,
        source: 'bubble_rendered',
        timestamp: input.createdAt,
        lat: input.origin.lat,
        lng: input.origin.lng,
        confidence: 'high'
      });
      store.ballEvents.push(originEvent);
    }

    var shot = buildPlannedShot(input, originEvent);
    var existingShot = findRecentPlannedShot(store, shot);
    if (existingShot) {
      saveStore(store);
      return existingShot;
    }
    store.plannedShots.push(shot);
    pairPendingShots(store);
    saveStore(store);
    return shot;
  }

  function captureBubbleRendered(input) {
    input = input || {};
    if (!hasLatLng(input.origin)) {
      throw new Error('captureBubbleRendered requires origin lat/lng');
    }

    var logged = logBallPosition({
      roundId: input.roundId,
      holeId: input.holeId,
      source: 'bubble_rendered',
      lat: input.origin.lat,
      lng: input.origin.lng,
      gpsAccuracyM: input.gpsAccuracyM,
      courseContext: input.courseContext || 'unknown',
      timestamp: input.createdAt || new Date().toISOString(),
      confidence: 'high'
    });

    return logPlannedShot({
      roundId: input.roundId,
      holeId: input.holeId,
      originEventId: logged.event.eventId,
      plannedBubble: input.plannedBubble,
      club: input.club,
      expectedDistanceYards: input.expectedDistanceYards,
      createdAt: input.createdAt
    });
  }

  function clearStore() {
    var scope = activePlayerScope();
    var store = getStore();
    if (scope.playerId) {
      store.ballEvents = (store.ballEvents || []).filter(function (event) { return !itemMatchesScope(event, scope); });
      store.plannedShots = (store.plannedShots || []).filter(function (shot) { return !itemMatchesScope(shot, scope); });
      store.outcomes = (store.outcomes || []).filter(function (outcome) { return !itemMatchesScope(outcome, scope); });
    } else {
      store = defaultStore();
    }
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
    if (scope.playerId) {
      incoming.ballEvents.forEach(function (event) { applyPlayerScope(event, scope); });
      incoming.plannedShots.forEach(function (shot) { applyPlayerScope(shot, scope); });
      incoming.outcomes.forEach(function (outcome) { applyPlayerScope(outcome, scope); });
      store.ballEvents = (store.ballEvents || []).filter(function (event) { return !itemMatchesScope(event, scope); }).concat(incoming.ballEvents);
      store.plannedShots = (store.plannedShots || []).filter(function (shot) { return !itemMatchesScope(shot, scope); }).concat(incoming.plannedShots);
      store.outcomes = (store.outcomes || []).filter(function (outcome) { return !itemMatchesScope(outcome, scope); }).concat(incoming.outcomes);
    } else {
      store = incoming;
    }
    return saveStore(store);
  }

  function deleteShot(shotId) {
    var id = String(shotId || '');
    if (!id) return false;
    var scope = activePlayerScope();
    var store = getStore();
    var target = (store.plannedShots || []).find(function (shot) {
      return shot && shot.shotId === id && itemMatchesScope(shot, scope);
    });
    if (!target) return false;
    store.plannedShots = (store.plannedShots || []).filter(function (shot) {
      return !(shot && shot.shotId === id && itemMatchesScope(shot, scope));
    });
    store.outcomes = (store.outcomes || []).filter(function (outcome) {
      return !(outcome && outcome.shotId === id && itemMatchesScope(outcome, scope));
    });
    saveStore(store);
    return true;
  }

  var api = {
    storageKey: STORAGE_KEY,
    createBallPositionEvent: createBallPositionEvent,
    logBallPosition: logBallPosition,
    logPlannedShot: logPlannedShot,
    captureBubbleRendered: captureBubbleRendered,
    pairPendingShots: function () {
      var store = getStore();
      var outcomes = pairPendingShots(store);
      saveStore(store);
      return outcomes;
    },
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
