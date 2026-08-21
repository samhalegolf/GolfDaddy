(function (rootFactory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = rootFactory();
  } else {
    var api = rootFactory();
    if (typeof window !== 'undefined') {
      window.GolfDaddyManualPracticeCore = api;
      window.ClarityCaddieManualPracticeCore = api;
      window.GolfDaddy = window.GolfDaddy || {};
      window.GolfDaddy.modules = window.GolfDaddy.modules || {};
      window.GolfDaddy.modules.manualPracticeCore = api;
    }
  }
})(function () {
  'use strict';

  var DEFAULTS = {
    consistencyPct: 68,
    replicationToleranceDeg: 1.75,
    minRepresentativeShots: 3,
    minVerifiedClubs: 2,
    distanceScaleWeight: 0.45,
    referenceClub: '7i',
    fallbackCarryM: 155,
    fallbackWidthM: 28,
    fallbackDepthM: 24
  };

  function asNumber(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function cleanString(value, fallback) {
    var text = String(value == null ? '' : value).trim();
    return text || String(fallback == null ? '' : fallback).trim();
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function round(value, decimals) {
    var factor = Math.pow(10, decimals || 0);
    return Math.round(asNumber(value, 0) * factor) / factor;
  }

  function mean(values) {
    var clean = (values || []).filter(function (value) { return Number.isFinite(Number(value)); }).map(Number);
    if (!clean.length) return 0;
    return clean.reduce(function (sum, value) { return sum + value; }, 0) / clean.length;
  }

  function std(values) {
    var clean = (values || []).filter(function (value) { return Number.isFinite(Number(value)); }).map(Number);
    if (clean.length < 2) return 0;
    var avg = mean(clean);
    var variance = clean.reduce(function (sum, value) {
      return sum + Math.pow(value - avg, 2);
    }, 0) / clean.length;
    return Math.sqrt(variance);
  }

  function median(values) {
    return percentile(values, 50);
  }

  function percentile(values, pct) {
    var clean = (values || []).filter(function (value) { return Number.isFinite(Number(value)); }).map(Number).sort(function (a, b) { return a - b; });
    if (!clean.length) return 0;
    var index = clamp((Number(pct) / 100) * (clean.length - 1), 0, clean.length - 1);
    var lower = Math.floor(index);
    var upper = Math.ceil(index);
    if (lower === upper) return clean[lower];
    var t = index - lower;
    return clean[lower] * (1 - t) + clean[upper] * t;
  }

  function groupBy(list, keyFn) {
    var groups = {};
    (list || []).forEach(function (item) {
      var key = cleanString(keyFn(item), 'unknown');
      groups[key] = groups[key] || [];
      groups[key].push(item);
    });
    return groups;
  }

  function mergeSettings(overrides) {
    var next = {};
    Object.keys(DEFAULTS).forEach(function (key) {
      next[key] = DEFAULTS[key];
    });
    overrides = overrides || {};
    Object.keys(DEFAULTS).forEach(function (key) {
      if (overrides[key] != null && overrides[key] !== '') next[key] = overrides[key];
    });
    next.consistencyPct = clamp(asNumber(next.consistencyPct, DEFAULTS.consistencyPct), 51, 80);
    next.replicationToleranceDeg = Math.max(0.25, asNumber(next.replicationToleranceDeg, DEFAULTS.replicationToleranceDeg));
    next.minRepresentativeShots = Math.max(1, Math.round(asNumber(next.minRepresentativeShots, DEFAULTS.minRepresentativeShots)));
    next.minVerifiedClubs = Math.max(1, Math.round(asNumber(next.minVerifiedClubs, DEFAULTS.minVerifiedClubs)));
    next.distanceScaleWeight = clamp(asNumber(next.distanceScaleWeight, DEFAULTS.distanceScaleWeight), 0, 1.5);
    next.fallbackCarryM = Math.max(30, asNumber(next.fallbackCarryM, DEFAULTS.fallbackCarryM));
    next.fallbackWidthM = Math.max(8, asNumber(next.fallbackWidthM, DEFAULTS.fallbackWidthM));
    next.fallbackDepthM = Math.max(8, asNumber(next.fallbackDepthM, DEFAULTS.fallbackDepthM));
    next.referenceClub = cleanString(next.referenceClub, DEFAULTS.referenceClub);
    return next;
  }

  function defaultClubModel(club, settings) {
    return {
      club: cleanString(club, 'Unknown'),
      carryM: settings.fallbackCarryM,
      bubbleWidthM: settings.fallbackWidthM,
      bubbleDepthM: settings.fallbackDepthM
    };
  }

  function resolveClubModel(club, opts) {
    var settings = opts.settings;
    var resolver = opts.clubModelResolver;
    var fallback = defaultClubModel(club, settings);
    if (typeof resolver !== 'function') return fallback;
    var model = resolver(club) || {};
    return {
      club: cleanString(model.club || club, fallback.club),
      carryM: Math.max(30, asNumber(model.carryM, fallback.carryM)),
      bubbleWidthM: Math.max(8, asNumber(model.bubbleWidthM, fallback.bubbleWidthM)),
      bubbleDepthM: Math.max(8, asNumber(model.bubbleDepthM, fallback.bubbleDepthM))
    };
  }

  function observationClassification(observation) {
    return cleanString(observation && observation.classification, 'representative').toLowerCase() === 'disrupted'
      ? 'disrupted'
      : 'representative';
  }

  function observationTimestamp(observation, session) {
    return observation && (observation.updatedAt || observation.createdAt) || session && (session.updatedAt || session.createdAt) || new Date().toISOString();
  }

  function normalizeObservation(observation, session, opts) {
    var club = cleanString(observation && observation.clubId || observation && observation.club, 'Unknown');
    var model = resolveClubModel(club, opts);
    var normalizedX = clamp(asNumber(observation && observation.x, 0), -1, 1);
    var normalizedY = clamp(asNumber(observation && observation.y, 0), -1, 1);
    var lateralM = normalizedX * (model.bubbleWidthM / 2);
    var depthM = normalizedY * (model.bubbleDepthM / 2);
    var expectedM = model.carryM;
    var actualDistanceM = expectedM + depthM;
    var normalizedDeg = Math.atan2(lateralM, Math.max(expectedM, 1)) * 180 / Math.PI;
    var classification = observationClassification(observation);
    return {
      shotId: cleanString(observation && observation.observationId, 'manual-observation'),
      sessionId: cleanString(session && session.sessionId, ''),
      playerId: cleanString(session && session.playerId, ''),
      playerName: cleanString(session && session.playerName, 'Player'),
      accountId: cleanString(session && session.accountId, ''),
      club: model.club,
      carryM: round(expectedM, 1),
      expectedM: round(expectedM, 1),
      actualDistanceM: round(actualDistanceM, 1),
      depthM: round(depthM, 1),
      lateralM: round(lateralM, 1),
      normalizedDeg: round(normalizedDeg, 2),
      manualPractice: true,
      manualClassification: classification,
      counted: classification === 'representative',
      sourceType: 'manual_practice',
      source: cleanString(observation && observation.source, 'manual_practice'),
      timestamp: observationTimestamp(observation, session),
      plot: {
        x: round(normalizedX, 4),
        y: round(normalizedY, 4)
      }
    };
  }

  function summarizeClub(club, shots, opts) {
    var representative = (shots || []).filter(function (shot) { return shot.manualClassification === 'representative'; });
    if (!representative.length) {
      return {
        club: club,
        shots: (shots || []).length,
        countedShots: 0,
        consistencyPct: opts.settings.consistencyPct,
        centerDeg: null,
        radiusDeg: null,
        stdDeg: null,
        rangeDeg: null,
        meanExpectedM: round(mean((shots || []).map(function (shot) { return shot.expectedM; })), 1),
        evidenceScore: 0,
        status: 'needs_more_data',
        showToUser: false
      };
    }
    var degrees = representative.map(function (shot) { return Number(shot.normalizedDeg); }).filter(Number.isFinite);
    var center = median(degrees);
    var distances = degrees.map(function (value) { return Math.abs(value - center); });
    var radius = percentile(distances, opts.settings.consistencyPct);
    var counted = representative.filter(function (shot) {
      return Math.abs(Number(shot.normalizedDeg) - center) <= radius + 0.0001;
    });
    if (representative.length <= opts.settings.minRepresentativeShots && counted.length < representative.length) {
      counted = representative.slice();
      radius = Math.max.apply(null, distances.concat([radius]));
    }
    var countedDegrees = counted.map(function (shot) { return Number(shot.normalizedDeg); }).filter(Number.isFinite);
    var spread = std(countedDegrees);
    var range = countedDegrees.length ? Math.max.apply(null, countedDegrees) - Math.min.apply(null, countedDegrees) : 0;
    var avgExpected = mean(counted.map(function (shot) { return Number(shot.expectedM); }));
    var evidenceScore = counted.length * (1 + clamp(avgExpected / 240, 0, 1) * opts.settings.distanceScaleWeight);
    var strong = counted.length >= opts.settings.minRepresentativeShots;
    return {
      club: club,
      shots: (shots || []).length,
      countedShots: counted.length,
      consistencyPct: opts.settings.consistencyPct,
      centerDeg: round(center, 2),
      radiusDeg: round(radius, 2),
      stdDeg: round(spread, 2),
      rangeDeg: round(range, 2),
      meanExpectedM: round(avgExpected, 1),
      evidenceScore: round(evidenceScore, 2),
      status: strong ? 'cluster_candidate' : 'needs_more_data',
      showToUser: strong
    };
  }

  function buildResultMethod(clubClusters, representativeShots, opts, source) {
    var candidates = (clubClusters || []).filter(function (cluster) { return cluster && cluster.showToUser && Number.isFinite(Number(cluster.centerDeg)); });
    if (!candidates.length) {
      return {
        method: 'result_scaled_cluster',
        source: source || 'manual_practice',
        status: 'needs_more_data',
        anchorDeg: null,
        anchorClub: null,
        evidenceScore: 0,
        verificationClubs: [],
        toleranceDeg: opts.settings.replicationToleranceDeg,
        countedShots: representativeShots.length,
        availableShots: representativeShots.length,
        clubClusters: clubClusters || [],
        showToUser: false
      };
    }
    var anchor = candidates.slice().sort(function (a, b) {
      if ((b.countedShots || 0) !== (a.countedShots || 0)) return (b.countedShots || 0) - (a.countedShots || 0);
      return (b.evidenceScore || 0) - (a.evidenceScore || 0);
    })[0];
    var verified = candidates.filter(function (cluster) {
      return Math.abs(Number(cluster.centerDeg) - Number(anchor.centerDeg)) <= opts.settings.replicationToleranceDeg;
    });
    return {
      method: 'result_scaled_cluster',
      source: source || 'manual_practice',
      status: verified.length >= opts.settings.minVerifiedClubs ? 'cross_distance_verified' : 'cluster_candidate',
      anchorDeg: round(Number(anchor.centerDeg), 2),
      anchorClub: anchor.club,
      evidenceScore: round(Number(anchor.evidenceScore || 0), 2),
      verificationClubs: verified.map(function (cluster) { return cluster.club; }),
      toleranceDeg: opts.settings.replicationToleranceDeg,
      countedShots: representativeShots.length,
      availableShots: representativeShots.length,
      clubClusters: clubClusters || [],
      showToUser: true
    };
  }

  function recommendationFromMethod(method, sourceLabel) {
    var offset = Number(method && method.anchorDeg);
    if (!(method && method.showToUser && Number.isFinite(offset))) {
      return {
        status: 'needs_more_data',
        offsetDeg: null,
        evidence: [],
        deltaDeg: null,
        showToUser: false,
        source: sourceLabel
      };
    }
    return {
      status: method.status === 'cross_distance_verified' ? 'corroborated' : 'result_only',
      offsetDeg: round(offset, 2),
      evidence: ['result_scaled_cluster'],
      deltaDeg: null,
      showToUser: true,
      source: sourceLabel
    };
  }

  function analyzeSession(session, options) {
    var settings = mergeSettings(options);
    var opts = {
      settings: settings,
      clubModelResolver: options && options.clubModelResolver
    };
    session = session || {};
    var observations = Array.isArray(session.observations) ? session.observations.slice() : [];
    var acceptedShots = observations.map(function (observation) {
      return normalizeObservation(observation, session, opts);
    });
    var grouped = groupBy(acceptedShots, function (shot) { return shot.club; });
    var clubClusters = Object.keys(grouped).map(function (club) {
      return summarizeClub(club, grouped[club], opts);
    }).sort(function (a, b) {
      if ((b.countedShots || 0) !== (a.countedShots || 0)) return (b.countedShots || 0) - (a.countedShots || 0);
      return String(a.club || '').localeCompare(String(b.club || ''), undefined, { numeric: true });
    });
    var representativeShots = acceptedShots.filter(function (shot) { return shot.manualClassification === 'representative'; });
    var resultMethod = buildResultMethod(clubClusters, representativeShots, opts, 'manual_practice');
    return {
      source: 'manual_practice',
      manualPractice: true,
      sessionId: cleanString(session.sessionId, ''),
      generatedAt: new Date().toISOString(),
      totals: {
        sessions: session.sessionId ? 1 : 0,
        captures: 1,
        rawShots: observations.length,
        accepted: acceptedShots.length,
        rejected: 0,
        representative: representativeShots.length,
        disrupted: acceptedShots.filter(function (shot) { return shot.manualClassification === 'disrupted'; }).length
      },
      acceptedShots: acceptedShots,
      rejectedShots: [],
      clusters: clubClusters,
      methods: {
        resultScaledCluster: resultMethod,
        deliveryCluster: {
          method: 'delivery_cluster',
          status: 'not_used',
          anchorDeg: null,
          anchorClub: null,
          evidenceScore: 0,
          acceptedShots: 0,
          rejectedShots: 0,
          clubClusters: [],
          showToUser: false
        }
      },
      recommendation: recommendationFromMethod(resultMethod, 'manual_practice'),
      userSignals: resultMethod.showToUser ? [resultMethod] : [],
      metadata: {
        geometryPresetId: session.geometryPresetId == null ? null : session.geometryPresetId
      }
    };
  }

  function buildOverrideAnalysis(session, override, options) {
    var settings = mergeSettings(options);
    var base = analyzeSession(session, options || {});
    override = override || {};
    var offsetDeg = asNumber(override.offsetDeg, NaN);
    if (!Number.isFinite(offsetDeg)) return base;
    var club = cleanString(override.clubId || override.club || base.methods && base.methods.resultScaledCluster && base.methods.resultScaledCluster.anchorClub || settings.referenceClub, settings.referenceClub);
    var representativeShots = base.acceptedShots.filter(function (shot) { return shot.manualClassification === 'representative'; });
    var representativeCount = representativeShots.length;
    var meanExpectedM = round(mean(representativeShots.filter(function (shot) { return shot.club === club; }).map(function (shot) { return shot.expectedM; })), 1) || round(mean(representativeShots.map(function (shot) { return shot.expectedM; })), 1) || settings.fallbackCarryM;
    var radiusDeg = representativeShots.length
      ? round(percentile(representativeShots.map(function (shot) { return Math.abs(Number(shot.normalizedDeg) - offsetDeg); }), settings.consistencyPct), 2)
      : 0.45;
    var method = {
      method: 'result_scaled_cluster',
      source: 'coach_manual_override',
      status: 'manual_override',
      anchorDeg: round(offsetDeg, 2),
      anchorClub: club,
      evidenceScore: round(Math.max(representativeCount, 1), 2),
      verificationClubs: representativeCount ? [club] : [],
      toleranceDeg: settings.replicationToleranceDeg,
      countedShots: representativeCount,
      availableShots: representativeCount,
      clubClusters: [{
        club: club,
        shots: base.totals.rawShots,
        countedShots: representativeCount,
        consistencyPct: settings.consistencyPct,
        centerDeg: round(offsetDeg, 2),
        radiusDeg: Math.max(round(radiusDeg, 2), 0.25),
        stdDeg: representativeShots.length ? round(std(representativeShots.map(function (shot) { return Number(shot.normalizedDeg); })), 2) : 0,
        rangeDeg: representativeShots.length ? round(Math.max.apply(null, representativeShots.map(function (shot) { return Number(shot.normalizedDeg); })) - Math.min.apply(null, representativeShots.map(function (shot) { return Number(shot.normalizedDeg); })), 2) : 0,
        meanExpectedM: meanExpectedM,
        evidenceScore: representativeCount,
        status: 'manual_override',
        showToUser: true
      }],
      showToUser: true
    };
    base.source = 'coach_manual_override';
    base.manualPractice = true;
    base.methods.resultScaledCluster = method;
    base.recommendation = recommendationFromMethod(method, 'coach_manual_override');
    base.userSignals = [method];
    base.metadata = base.metadata || {};
    base.metadata.geometryPresetId = override.geometryPresetId == null ? null : override.geometryPresetId;
    base.metadata.override = {
      offsetDeg: round(offsetDeg, 2),
      club: club
    };
    return base;
  }

  return {
    defaults: DEFAULTS,
    mergeSettings: mergeSettings,
    normalizeObservation: normalizeObservation,
    analyzeSession: analyzeSession,
    buildOverrideAnalysis: buildOverrideAnalysis
  };
});
