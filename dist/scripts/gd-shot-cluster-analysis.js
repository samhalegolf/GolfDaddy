(function () {
  'use strict';

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  var YARDS_TO_METERS = 0.9144;
  var DEFAULTS = {
    consistencyMinPct: 51,
    consistencyMaxPct: 80,
    consistencyDefaultPct: 68,
    distanceWindowPct: 0.18,
    distanceWindowMinM: 10,
    distanceWindowMaxM: 35,
    viableDegreeAbs: 8,
    alignmentDegreeAbs: 10,
    minClusterShots: 5,
    minSuggestionClubs: 2,
    maxClusterStdDeg: 2.2,
    maxClusterRangeDeg: 6
  };

  function asNumber(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function round(value, decimals) {
    var factor = Math.pow(10, decimals || 0);
    return Math.round(asNumber(value, 0) * factor) / factor;
  }

  function settings(overrides) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (key) { out[key] = DEFAULTS[key]; });

    try {
      var dev = window.GolfDaddyDev;
      var tuned = dev && typeof dev.get === 'function' ? dev.get('statsCluster') : null;
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

    out.consistencyMinPct = clamp(out.consistencyMinPct, 1, 99);
    out.consistencyMaxPct = clamp(out.consistencyMaxPct, out.consistencyMinPct, 99);
    out.consistencyDefaultPct = clamp(out.consistencyDefaultPct, out.consistencyMinPct, out.consistencyMaxPct);
    return out;
  }

  function median(values) {
    var sorted = values.filter(function (v) { return Number.isFinite(Number(v)); }).sort(function (a, b) { return a - b; });
    if (!sorted.length) return 0;
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function mean(values) {
    var clean = values.filter(function (v) { return Number.isFinite(Number(v)); });
    if (!clean.length) return 0;
    return clean.reduce(function (sum, v) { return sum + v; }, 0) / clean.length;
  }

  function std(values) {
    var clean = values.filter(function (v) { return Number.isFinite(Number(v)); });
    if (clean.length < 2) return 0;
    var m = mean(clean);
    var variance = clean.reduce(function (sum, v) {
      return sum + Math.pow(v - m, 2);
    }, 0) / clean.length;
    return Math.sqrt(variance);
  }

  function percentile(values, pct) {
    var sorted = values.filter(function (v) { return Number.isFinite(Number(v)); }).sort(function (a, b) { return a - b; });
    if (!sorted.length) return 0;
    var index = clamp((pct / 100) * (sorted.length - 1), 0, sorted.length - 1);
    var lower = Math.floor(index);
    var upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    var t = index - lower;
    return sorted[lower] * (1 - t) + sorted[upper] * t;
  }

  function byId(list, field) {
    var map = {};
    (list || []).forEach(function (item) {
      if (item && item[field]) map[item[field]] = item;
    });
    return map;
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

  function groupBy(list, keyFn) {
    var groups = {};
    list.forEach(function (item) {
      var key = keyFn(item) || 'unknown';
      groups[key] = groups[key] || [];
      groups[key].push(item);
    });
    return groups;
  }

  function distanceWindow(expectedM, cfg) {
    return clamp(expectedM * cfg.distanceWindowPct, cfg.distanceWindowMinM, cfg.distanceWindowMaxM);
  }

  function normalizeRecord(shot, outcome, resultEvent, cfg) {
    var expectedM = asNumber(shot.expectedDistanceYards, 0) * YARDS_TO_METERS;
    var lateralM = asNumber(outcome.lateralErrorYards, 0) * YARDS_TO_METERS;
    var depthM = asNumber(outcome.distanceErrorYards, 0) * YARDS_TO_METERS;
    var actualDistanceM = expectedM + depthM;
    var degreeBaseM = expectedM > 1 ? expectedM : Math.max(actualDistanceM, 1);
    var degree = Math.atan2(lateralM, degreeBaseM) * 180 / Math.PI;
    var windowM = distanceWindow(Math.max(expectedM, 1), cfg);
    var distanceDeltaM = actualDistanceM - expectedM;
    var distanceViable = expectedM > 0 && Math.abs(distanceDeltaM) <= windowM;
    var degreeViable = Math.abs(degree) <= cfg.viableDegreeAbs;

    return {
      playerId: shot.playerId || outcome.playerId || resultEvent && resultEvent.playerId || '',
      playerName: shot.playerName || outcome.playerName || resultEvent && resultEvent.playerName || '',
      accountId: shot.accountId || outcome.accountId || resultEvent && resultEvent.accountId || '',
      shotId: shot.shotId,
      outcomeId: outcome.outcomeId,
      resultEventId: outcome.resultEventId,
      timestamp: resultEvent && resultEvent.timestamp || outcome.computedAt || shot.createdAt || null,
      roundId: shot.roundId || resultEvent && resultEvent.roundId || null,
      holeId: shot.holeId || resultEvent && resultEvent.holeId || null,
      club: shot.club || 'Unknown',
      expectedDistanceM: round(expectedM, 1),
      actualDistanceM: round(actualDistanceM, 1),
      distanceDeltaM: round(distanceDeltaM, 1),
      distanceWindowM: round(windowM, 1),
      lateralM: round(lateralM, 1),
      depthM: round(depthM, 1),
      presumedBubbleWidthM: round(asNumber(shot.plannedBubble && shot.plannedBubble.widthYards, 0) * YARDS_TO_METERS, 1),
      presumedBubbleDepthM: round(asNumber(shot.plannedBubble && shot.plannedBubble.lengthYards, 0) * YARDS_TO_METERS, 1),
      normalizedDeg: round(degree, 2),
      insideBubble: !!outcome.insideBubble,
      distanceViable: distanceViable,
      degreeViable: degreeViable,
      counted: distanceViable,
      bubbleWasSet: !!shot.plannedBubble,
      pairedConfidence: asNumber(outcome.pairedConfidence, 0),
      sourceConfidence: outcome.sourceConfidence || resultEvent && resultEvent.confidence || 'unknown'
    };
  }

  function buildRecords(store, cfg) {
    store = store || {};
    var shots = byId(store.plannedShots || [], 'shotId');
    var events = byId(store.ballEvents || [], 'eventId');
    return (store.outcomes || []).map(function (outcome) {
      var shot = shots[outcome.shotId];
      if (!shot) return null;
      if (!samePlayerScope(shot, outcome)) return null;
      return normalizeRecord(shot, outcome, events[outcome.resultEventId], cfg);
    }).filter(Boolean);
  }

  function analyzeBubbleFit(records, cfg, consistencyPct) {
    var pct = clamp(asNumber(consistencyPct, cfg.consistencyDefaultPct), cfg.consistencyMinPct, cfg.consistencyMaxPct);
    var grouped = groupBy(records.filter(function (r) { return r.bubbleWasSet && r.counted; }), function (r) { return r.club; });
    return Object.keys(grouped).map(function (club) {
      var rows = grouped[club];
      var centerLateral = median(rows.map(function (r) { return r.lateralM; }));
      var centerDepth = median(rows.map(function (r) { return r.depthM; }));
      var presumedWidthM = median(rows.map(function (r) { return r.presumedBubbleWidthM; }));
      var presumedDepthM = median(rows.map(function (r) { return r.presumedBubbleDepthM; }));
      var lateralSpread = rows.map(function (r) { return Math.abs(r.lateralM - centerLateral); });
      var depthSpread = rows.map(function (r) { return Math.abs(r.depthM - centerDepth); });
      var resultWidthM = Math.max(1, percentile(lateralSpread, pct) * 2);
      var resultDepthM = Math.max(1, percentile(depthSpread, pct) * 2);
      var widthRatio = presumedWidthM > 0 ? resultWidthM / presumedWidthM : 0;
      var depthRatio = presumedDepthM > 0 ? resultDepthM / presumedDepthM : 0;
      var fitRatio = widthRatio && depthRatio ? (widthRatio + depthRatio) / 2 : 0;
      var insidePct = rows.length ? rows.filter(function (r) { return r.insideBubble; }).length / rows.length * 100 : 0;
      var offsetDeg = Math.atan2(centerLateral, Math.max(mean(rows.map(function (r) { return r.expectedDistanceM; })), 1)) * 180 / Math.PI;
      var status = 'collecting';
      if (rows.length >= cfg.minClusterShots) {
        status = Math.abs(offsetDeg) > cfg.viableDegreeAbs ? 'alignment_check' : 'bubble_fit_check';
      }
      return {
        club: club,
        consistencyPct: round(pct, 0),
        shots: rows.length,
        insidePresumedBubblePct: round(insidePct, 0),
        resultBubble: {
          lateralOffsetM: round(centerLateral, 1),
          depthOffsetM: round(centerDepth, 1),
          widthM: round(resultWidthM, 1),
          depthM: round(resultDepthM, 1),
          normalizedDeg: round(offsetDeg, 2)
        },
        presumedBubble: {
          widthM: round(presumedWidthM, 1),
          depthM: round(presumedDepthM, 1)
        },
        fitRatio: round(fitRatio, 2),
        sizeDeltaPct: round((fitRatio - 1) * 100, 0),
        fitGuidance: fitRatio > 1.12 ? 'expand_bubble' : fitRatio < 0.78 ? 'wait_or_tighten' : 'close_match',
        status: status
      };
    });
  }

  function analyzeBubbleFitRange(records, cfg) {
    var byPct = [];
    for (var pct = Math.round(cfg.consistencyMinPct); pct <= Math.round(cfg.consistencyMaxPct); pct += 1) {
      byPct.push({ pct: pct, fits: analyzeBubbleFit(records, cfg, pct) });
    }

    var clubs = {};
    byPct.forEach(function (entry) {
      entry.fits.forEach(function (fit) {
        clubs[fit.club] = clubs[fit.club] || [];
        clubs[fit.club].push(Object.assign({ consistencyPct: entry.pct }, fit));
      });
    });

    return Object.keys(clubs).map(function (club) {
      var fits = clubs[club];
      var best = fits.slice().sort(function (a, b) {
        return Math.abs((a.fitRatio || 0) - 1) - Math.abs((b.fitRatio || 0) - 1);
      })[0];
      var selected = fits.find(function (fit) { return fit.consistencyPct === Math.round(cfg.consistencyDefaultPct); }) || best;
      return {
        club: club,
        bestConsistencyPct: best ? best.consistencyPct : null,
        bestFitRatio: best ? best.fitRatio : null,
        bestSizeDeltaPct: best ? best.sizeDeltaPct : null,
        selectedFitRatio: selected ? selected.fitRatio : null,
        selectedSizeDeltaPct: selected ? selected.sizeDeltaPct : null,
        guidance: best ? best.fitGuidance : 'collecting',
        shots: best ? best.shots : 0
      };
    });
  }

  function clusterSummary(rows, cfg) {
    var degrees = rows.map(function (r) { return r.normalizedDeg; });
    var min = Math.min.apply(null, degrees);
    var max = Math.max.apply(null, degrees);
    var avg = mean(degrees);
    var spread = std(degrees);
    var strong = rows.length >= cfg.minClusterShots &&
      spread <= cfg.maxClusterStdDeg &&
      (max - min) <= cfg.maxClusterRangeDeg;
    var viable = Math.abs(avg) <= cfg.viableDegreeAbs;
    var alignment = !viable && strong && Math.abs(avg) >= cfg.alignmentDegreeAbs;
    return {
      shots: rows.length,
      meanDeg: round(avg, 2),
      stdDeg: round(spread, 2),
      rangeDeg: round(max - min, 2),
      strong: strong,
      degreeViable: viable,
      status: !strong ? 'collecting' : viable ? 'bubble_offset_candidate' : alignment ? 'alignment_check' : 'outside_viable_range'
    };
  }

  function analyzeClusterHunter(records, cfg) {
    var rows = records.filter(function (r) { return r.distanceViable; });
    var grouped = groupBy(rows, function (r) { return r.club; });
    var byClub = Object.keys(grouped).map(function (club) {
      var summary = clusterSummary(grouped[club], cfg);
      summary.club = club;
      return summary;
    });

    var viableClubSuggestions = byClub.filter(function (item) {
      return item.status === 'bubble_offset_candidate' && item.club !== 'Unknown';
    });
    var alignmentChecks = byClub.filter(function (item) {
      return item.status === 'alignment_check';
    });
    var crossClub = null;

    if (viableClubSuggestions.length >= cfg.minSuggestionClubs) {
      crossClub = clusterSummary(viableClubSuggestions.map(function (item) {
        return { normalizedDeg: item.meanDeg };
      }), Object.assign({}, cfg, { minClusterShots: cfg.minSuggestionClubs }));
      crossClub.clubs = viableClubSuggestions.map(function (item) { return item.club; });
      crossClub.status = crossClub.strong && crossClub.degreeViable ? 'profile_offset_option' : 'forming';
    }

    return {
      viableShots: rows.length,
      byClub: byClub,
      alignmentChecks: alignmentChecks,
      crossClub: crossClub
    };
  }

  function analyzeStore(store, options) {
    var cfg = settings(options && options.settings);
    var consistencyPct = options && options.consistencyPct;
    var selectedPct = clamp(Number(consistencyPct) || cfg.consistencyDefaultPct, cfg.consistencyMinPct, cfg.consistencyMaxPct);
    var rangeCfg = Object.assign({}, cfg, { consistencyDefaultPct: selectedPct });
    var records = buildRecords(store, cfg);
    return {
      settings: cfg,
      records: records,
      bubbleFit: analyzeBubbleFit(records, cfg, selectedPct),
      bubbleFitRange: analyzeBubbleFitRange(records, rangeCfg),
      clusterHunter: analyzeClusterHunter(records, cfg),
      generatedAt: new Date().toISOString()
    };
  }

  function analyzeCurrent(options) {
    var events = root.modules.shotEvents;
    var store = null;
    if (events && typeof events.getScopedStore === 'function') store = events.getScopedStore();
    else if (events && typeof events.getStore === 'function') store = events.getStore();
    return analyzeStore(store, options || {});
  }

  var api = {
    defaults: DEFAULTS,
    settings: settings,
    analyzeStore: analyzeStore,
    analyzeCurrent: analyzeCurrent,
    analyzeBubbleFit: analyzeBubbleFit,
    analyzeClusterHunter: analyzeClusterHunter,
    buildRecords: buildRecords,
    analyzeBubbleFitRange: analyzeBubbleFitRange
  };

  root.modules.shotClusterAnalysis = api;
  window.GolfDaddyShotClusterAnalysis = api;
  window.ClarityCaddieShotClusterAnalysis = api;
})();
