(function () {
  'use strict';

  /*
    Course Transfer Score + implementation shares.

    One question, asked of the shot set the Course Data graph is currently
    showing:

      how much larger would the bubble have to be to contain most of what
      actually happened out on the course?

    The bubble placement is always the player's intended plan. Nothing in here
    moves it, re-centres it, rotates it, or touches its degree offset. It only
    grows it uniformly and counts what falls inside. A player who needs 12% more
    bubble transferred their pattern well; one who needs 80% did not.

    UNITS ARE THE CALLER'S. This layer is deliberately unit-agnostic: it takes
    points and an ellipse as plain numbers and never asks what they mean. The
    Course Data graph plots lateral degrees against depth as a percentage of
    carry, so that is what it hands in, and the score is then computed in the
    exact frame the player is looking at. A metres-based version measured
    against each shot's own My Bubble would be a truer per-shot statement and a
    worse screen: the growth figure would not match where the dots visually sit
    against the drawn bubble, and one screen would be showing two numbers that
    disagree.

    Frame, in whatever units arrive:
      the ellipse centre is the origin
        x < 0 Left      x >= 0 Right
        y < 0 Short     y >= 0 Long
    Exact zeros are effectively impossible in real data but the rule has to be
    deterministic, so ties go to Right and Long. Every valid shot lands in
    exactly one quadrant.

    Why growth needs no search loop:
      a point's normalised ellipse radius is
        r = sqrt((ux / rx)^2 + (uy / ry)^2)
      in the ellipse's own rotated frame, and growing the bubble by a factor s
      multiplies both radii by s, so the point's radius becomes r/s. It is
      inside exactly when s >= r. A point's own radius IS the scale required to
      contain it. Coverage at any scale is therefore a count of radii, and the
      smallest scale reaching a target coverage is the k-th smallest radius.
      Exact, one sort, and it cannot disagree with the live slider.

    This layer measures and gates. It writes no copy: turning shares into
    sentences belongs to gd-course-implementation-insight.js.
  */

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  /*
    Every threshold lives here rather than in whatever renders the slider, so
    tuning the score or the confidence gates never means editing a UI
    component. Percentages are 0-100 throughout, matching the screen.

    Score bands are ascending and matched with <=, so a growth figure that falls
    between two published bands lands in the gentler one rather than off the end
    of the table.
  */
  var CONFIG = {
    targetCoverage: 0.75,
    minScalePercent: 100,
    maxScalePercent: 200,

    bands: [
      { maxGrowthPercent: 10, score: 10 },
      { maxGrowthPercent: 20, score: 9 },
      { maxGrowthPercent: 30, score: 8 },
      { maxGrowthPercent: 40, score: 7 },
      { maxGrowthPercent: 50, score: 6 },
      { maxGrowthPercent: 60, score: 5 },
      { maxGrowthPercent: 70, score: 4 },
      { maxGrowthPercent: 80, score: 3 },
      { maxGrowthPercent: 100, score: 2 }
    ],
    unreadableScore: 1,

    // Below provisionalMinShots there is no score and no directional reading.
    // Between the two there is a provisional one. At validMinShots the gates
    // open.
    provisionalMinShots: 10,
    validMinShots: 20,

    // Share of one side, as a percentage of valid shots. Below balancedMax the
    // sides are level and the screen should say so rather than invent a lean.
    sideThresholds: {
      balancedMaxPercent: 55,
      tendencyMaxPercent: 62,
      clearMaxPercent: 70
    },

    // Share held by the single biggest quadrant.
    quadrantThresholds: {
      noticeableMinPercent: 35,
      clearMinPercent: 45,
      dominantMinPercent: 55
    }
  };

  var EPSILON = 1e-9;
  var QUADRANTS = ['short-left', 'short-right', 'long-left', 'long-right'];
  var NUMERIC_KEYS = [
    'targetCoverage', 'minScalePercent', 'maxScalePercent', 'unreadableScore',
    'provisionalMinShots', 'validMinShots'
  ];

  /*
    Strict about absence. Number(null) is 0 -- a finite value -- so the usual
    asNumber would read "this shot has no lateral position" as "this shot
    finished dead on the centre line", quietly counting a broken row as a
    perfect one. Absent stays absent here.
  */
  function asNumber(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function share(count, total) {
    return total ? (count / total) * 100 : 0;
  }

  function config(overrides) {
    var out = {};
    Object.keys(CONFIG).forEach(function (key) { out[key] = CONFIG[key]; });
    out.bands = CONFIG.bands.map(function (band) {
      return { maxGrowthPercent: band.maxGrowthPercent, score: band.score };
    });
    out.sideThresholds = Object.assign({}, CONFIG.sideThresholds);
    out.quadrantThresholds = Object.assign({}, CONFIG.quadrantThresholds);

    var tuned = null;
    try {
      var dev = window.GolfDaddyDev;
      tuned = dev && typeof dev.get === 'function' ? dev.get('courseTransferScore') : null;
    } catch (e) { tuned = null; }

    [tuned, overrides].forEach(function (source) {
      if (!source || typeof source !== 'object') return;
      NUMERIC_KEYS.forEach(function (key) {
        if (Number.isFinite(Number(source[key]))) out[key] = Number(source[key]);
      });
      ['sideThresholds', 'quadrantThresholds'].forEach(function (group) {
        if (!source[group] || typeof source[group] !== 'object') return;
        Object.keys(out[group]).forEach(function (key) {
          if (Number.isFinite(Number(source[group][key]))) out[group][key] = Number(source[group][key]);
        });
      });
      if (Array.isArray(source.bands) && source.bands.length) {
        out.bands = source.bands.map(function (band) {
          return { maxGrowthPercent: Number(band.maxGrowthPercent), score: Number(band.score) };
        });
      }
    });

    out.targetCoverage = clamp(out.targetCoverage, 0.01, 1);
    out.minScalePercent = Math.max(out.minScalePercent, 1);
    out.maxScalePercent = Math.max(out.maxScalePercent, out.minScalePercent);
    out.validMinShots = Math.max(out.validMinShots, out.provisionalMinShots);
    out.bands.sort(function (a, b) { return a.maxGrowthPercent - b.maxGrowthPercent; });
    return out;
  }

  /*
    The bubble as the only five numbers growth cares about. rx/ry are its radii
    at 100% -- the size it is drawn at before any slider input.
  */
  function normaliseEllipse(spec) {
    if (!spec || typeof spec !== 'object') return null;
    var rx = asNumber(spec.rx, null);
    var ry = asNumber(spec.ry, null);
    if (rx === null || ry === null || !(rx > 0) || !(ry > 0)) return null;
    return {
      cx: asNumber(spec.cx, 0),
      cy: asNumber(spec.cy, 0),
      rx: rx,
      ry: ry,
      tiltDeg: asNumber(spec.tiltDeg, 0)
    };
  }

  /*
    Normalised radius in the ellipse's own rotated frame. The rotation is the
    same expression the graph uses to light a dot up, so what the score counts
    as inside is exactly what looks enclosed.
  */
  function radiusFor(point, ellipse) {
    var el = normaliseEllipse(ellipse);
    var x = asNumber(point && point.x, null);
    var y = asNumber(point && point.y, null);
    if (!el || x === null || y === null) return null;

    var t = -el.tiltDeg * Math.PI / 180;
    var dx = x - el.cx;
    var dy = y - el.cy;
    var ux = dx * Math.cos(t) - dy * Math.sin(t);
    var uy = dx * Math.sin(t) + dy * Math.cos(t);
    return Math.sqrt((ux * ux) / (el.rx * el.rx) + (uy * uy) / (el.ry * el.ry));
  }

  function isPointInsideScaledBubble(point, ellipse, scalePercent) {
    var r = radiusFor(point, ellipse);
    if (r === null) return false;
    return r <= (asNumber(scalePercent, 100) / 100) + EPSILON;
  }

  /*
    yAxisDown says which way "long" points. Screen coordinates grow downwards,
    so on an SVG chart a shot that finished LONG sits at a SMALLER y than the
    bubble centre. Radii do not care -- they square the offset -- but Short and
    Long would come out backwards, which is the kind of bug that produces
    confident, exactly-wrong coaching. The caller states its axis rather than
    this module guessing from the numbers.
  */
  function classifyQuadrant(point, ellipse, yAxisDown) {
    var el = normaliseEllipse(ellipse) || { cx: 0, cy: 0 };
    var x = asNumber(point && point.x, null);
    var y = asNumber(point && point.y, null);
    if (x === null || y === null) return null;
    var depth = y - el.cy;
    if (yAxisDown) depth = -depth;
    return (depth < 0 ? 'short' : 'long') + '-' + (x - el.cx < 0 ? 'left' : 'right');
  }

  /*
    The shot set as radii. Everything below is a question asked of this.
  */
  function distribution(points, ellipse, options) {
    options = options || {};
    var cfg = config(options.config);
    var el = normaliseEllipse(ellipse);

    var result = {
      config: cfg,
      ellipse: el,
      points: [],
      sampleSize: 0,
      invalidCount: 0,
      radii: [],
      unavailableReason: el ? null : 'INVALID_BUBBLE'
    };

    (points || []).forEach(function (input) {
      var radius = el ? radiusFor(input, el) : null;
      var point = {
        id: (input && (input.id || input.shotId)) || null,
        club: (input && input.club) || null,
        x: asNumber(input && input.x, null),
        y: asNumber(input && input.y, null),
        radius: radius,
        requiredScalePercent: radius === null ? null : Math.max(cfg.minScalePercent, radius * 100),
        insideAtFullSize: radius !== null && radius <= 1 + EPSILON,
        quadrant: radius === null ? null : classifyQuadrant(input, el, options.yAxisDown === true),
        valid: radius !== null,
        reason: radius !== null ? null : (el ? 'MISSING_POSITION' : 'INVALID_BUBBLE')
      };

      if (point.valid) {
        result.sampleSize += 1;
        result.radii.push(radius);
      } else {
        result.invalidCount += 1;
      }
      result.points.push(point);
    });

    result.radii.sort(function (a, b) { return a - b; });
    return result;
  }

  function asDistribution(input, ellipse, options) {
    return input && Array.isArray(input.radii) ? input : distribution(input, ellipse, options);
  }

  /*
    What the slider reads. The slider is free to explore below full size -- the
    player may want to see how tight their real pattern is -- so the requested
    scale is honoured as given. Only the SCORE floors at 100%, because a bubble
    that needs to shrink has not failed to transfer.
  */
  function calculateCoverage(input, scalePercent, ellipse, options) {
    var dist = asDistribution(input, ellipse, options);
    var scale = asNumber(scalePercent, dist.config.minScalePercent) / 100;

    var inside = 0;
    for (var i = 0; i < dist.radii.length; i++) {
      if (dist.radii[i] <= scale + EPSILON) inside += 1;
      else break; // sorted ascending
    }

    var n = dist.sampleSize;
    return {
      scalePercent: scale * 100,
      sampleSize: n,
      inside: inside,
      outside: n - inside,
      insidePercent: share(inside, n),
      outsidePercent: share(n - inside, n)
    };
  }

  /*
    The smallest bubble holding at least targetCoverage of the valid shots.
    k shots is ceil(target * n), and the k-th smallest radius is by definition
    the smallest scale containing k of them. Floored at 100%: the bubble is the
    plan and never shrinks to flatter the score.
  */
  function findScaleForTargetCoverage(input, ellipse, options) {
    var dist = asDistribution(input, ellipse, options);
    var cfg = dist.config;
    if (!dist.sampleSize) return null;

    var k = clamp(Math.ceil(cfg.targetCoverage * dist.sampleSize), 1, dist.sampleSize);
    return Math.max(cfg.minScalePercent, dist.radii[k - 1] * 100);
  }

  function calculateTransferScore(growthPercent, cfg) {
    cfg = cfg || config();
    if (growthPercent === null || growthPercent === undefined) return null;
    for (var i = 0; i < cfg.bands.length; i++) {
      if (growthPercent <= cfg.bands[i].maxGrowthPercent + EPSILON) return cfg.bands[i].score;
    }
    return cfg.unreadableScore;
  }

  function calculateQuadrantShares(input, ellipse, options) {
    var dist = asDistribution(input, ellipse, options);
    var counts = { 'short-left': 0, 'short-right': 0, 'long-left': 0, 'long-right': 0 };

    dist.points.forEach(function (point) {
      if (point.valid && counts[point.quadrant] !== undefined) counts[point.quadrant] += 1;
    });

    var n = dist.sampleSize;
    var shares = {
      sampleSize: n,
      counts: counts,
      shortLeftShare: share(counts['short-left'], n),
      shortRightShare: share(counts['short-right'], n),
      longLeftShare: share(counts['long-left'], n),
      longRightShare: share(counts['long-right'], n)
    };

    shares.leftShare = shares.longLeftShare + shares.shortLeftShare;
    shares.rightShare = shares.longRightShare + shares.shortRightShare;
    shares.shortShare = shares.shortLeftShare + shares.shortRightShare;
    shares.longShare = shares.longLeftShare + shares.longRightShare;
    return shares;
  }

  /*
    How firmly a side leans, given the gate the sample size has earned. A
    provisional sample can report a lean but never a strong one -- the plan's
    rule is that ten shots may hint and twenty may conclude.
  */
  function sideConfidence(dominantShare, cfg, ceiling) {
    var t = cfg.sideThresholds;
    var level = 'none';
    if (dominantShare > t.clearMaxPercent) level = 'strong';
    else if (dominantShare > t.tendencyMaxPercent) level = 'clear';
    else if (dominantShare > t.balancedMaxPercent) level = 'tendency';

    if (level === 'none') return 'none';
    if (ceiling === 'none') return 'none';
    if (ceiling === 'provisional') return 'provisional';
    return level;
  }

  function calculateBias(leftish, rightish, leftLabel, rightLabel, cfg, ceiling) {
    var dominantShare = Math.max(leftish, rightish);
    var confidence = sideConfidence(dominantShare, cfg, ceiling);
    if (confidence === 'none') {
      return { bias: 'balanced', confidence: 'none', dominantShare: dominantShare };
    }
    return {
      bias: leftish >= rightish ? leftLabel : rightLabel,
      confidence: confidence,
      dominantShare: dominantShare
    };
  }

  function calculateQuadrantConcentration(shares, cfg, ceiling) {
    var t = cfg.quadrantThresholds;
    var best = null;
    QUADRANTS.forEach(function (key) {
      var value = share(shares.counts[key], shares.sampleSize);
      if (!best || value > best.share) best = { quadrant: key, share: value };
    });
    if (!best) return { dominantQuadrant: null, dominantQuadrantShare: 0, quadrantConfidence: 'none' };

    var level = 'none';
    if (best.share >= t.dominantMinPercent) level = 'dominant';
    else if (best.share >= t.clearMinPercent) level = 'clear';
    else if (best.share >= t.noticeableMinPercent) level = 'noticeable';

    if (ceiling === 'none' || level === 'none') {
      return { dominantQuadrant: null, dominantQuadrantShare: best.share, quadrantConfidence: 'none' };
    }
    return {
      dominantQuadrant: best.quadrant,
      dominantQuadrantShare: best.share,
      quadrantConfidence: ceiling === 'provisional' ? 'noticeable' : level
    };
  }

  /*
    THE WHOLE READOUT for one shot set. Everything the screen says comes from
    this object, so the screen can never state a figure the analysis did not
    produce.

    options.sliderScalePercent is where the player has the slider right now. It
    is reported back untouched and deliberately has NO effect on the score: the
    score comes from the automatically found threshold, not from wherever the
    player happens to be dragging.
  */
  function analyse(points, ellipse, options) {
    options = options || {};
    var dist = asDistribution(points, ellipse, options);
    var cfg = dist.config;
    var n = dist.sampleSize;

    var shares = calculateQuadrantShares(dist);
    var requiredScalePercent = findScaleForTargetCoverage(dist);
    var growthPercent = requiredScalePercent === null
      ? null
      : requiredScalePercent - cfg.minScalePercent;

    var beyondRange = requiredScalePercent !== null
      && requiredScalePercent > cfg.maxScalePercent + EPSILON;

    // The sample size decides how loud anything downstream is allowed to be.
    var ceiling = n >= cfg.validMinShots ? 'full' : (n >= cfg.provisionalMinShots ? 'provisional' : 'none');

    var analysisState;
    if (dist.unavailableReason || !n) analysisState = 'insufficient_data';
    else if (ceiling === 'none') analysisState = 'insufficient_data';
    else if (beyondRange) analysisState = 'unreadable';
    else analysisState = ceiling === 'provisional' ? 'provisional' : 'valid';

    var transferScore = null;
    if (analysisState === 'unreadable') transferScore = cfg.unreadableScore;
    else if (analysisState !== 'insufficient_data') transferScore = calculateTransferScore(growthPercent, cfg);

    var alignment = calculateBias(
      shares.leftShare, shares.rightShare,
      'left_outcome_bias', 'right_outcome_bias',
      cfg, ceiling
    );
    var distance = calculateBias(
      shares.shortShare, shares.longShare,
      'short', 'long',
      cfg, ceiling
    );
    var concentration = calculateQuadrantConcentration(shares, cfg, ceiling);

    var sliderScalePercent = asNumber(options.sliderScalePercent, cfg.minScalePercent);

    return {
      config: cfg,
      sampleSize: n,
      invalidCount: dist.invalidCount,

      coverageAtMyBubble: calculateCoverage(dist, cfg.minScalePercent),
      currentSliderScalePercent: sliderScalePercent,
      currentSliderCoverage: calculateCoverage(dist, sliderScalePercent),

      targetCoverage: cfg.targetCoverage,
      requiredScalePercent: requiredScalePercent,
      requiredGrowthPercent: growthPercent,
      coverageAtRequiredScale: requiredScalePercent === null ? null : calculateCoverage(dist, requiredScalePercent),
      transferScore: transferScore,

      shortShare: shares.shortShare,
      longShare: shares.longShare,
      leftShare: shares.leftShare,
      rightShare: shares.rightShare,
      shortLeftShare: shares.shortLeftShare,
      shortRightShare: shares.shortRightShare,
      longLeftShare: shares.longLeftShare,
      longRightShare: shares.longRightShare,
      quadrantCounts: shares.counts,

      alignmentBias: alignment.bias,
      alignmentConfidence: alignment.confidence,
      alignmentShare: alignment.dominantShare,

      distanceBias: distance.bias,
      distanceConfidence: distance.confidence,
      distanceShare: distance.dominantShare,

      dominantQuadrant: concentration.dominantQuadrant,
      dominantQuadrantShare: concentration.dominantQuadrantShare,
      quadrantConfidence: concentration.quadrantConfidence,

      analysisState: analysisState,
      unavailableReason: dist.unavailableReason
    };
  }

  var api = {
    CONFIG: CONFIG,
    QUADRANTS: QUADRANTS,
    config: config,
    normaliseEllipse: normaliseEllipse,
    radiusFor: radiusFor,
    isPointInsideScaledBubble: isPointInsideScaledBubble,
    classifyQuadrant: classifyQuadrant,
    distribution: distribution,
    calculateCoverage: calculateCoverage,
    findScaleForTargetCoverage: findScaleForTargetCoverage,
    calculateTransferScore: calculateTransferScore,
    calculateQuadrantShares: calculateQuadrantShares,
    analyse: analyse
  };

  root.modules.courseTransferScore = api;
  window.GolfDaddyCourseTransferScore = api;
  window.ClarityCaddieCourseTransferScore = api;
  if (window.ClarityCaddie) window.ClarityCaddie.modules = root.modules;
})();
