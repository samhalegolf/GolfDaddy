/* Drawing a bubble ring, once.
 *
 * Studio's Bubble Geometry workspace and Practice's Projected Clubs view both
 * need the same picture: the engine's bubble for a club, optionally moulded by
 * an approved Micro-Geometry model, drawn down the line. Two copies of that
 * drawing would drift the moment one of them was tweaked - and a bubble that
 * looks different in Studio from how it looks in Practice is worse than no
 * Studio view at all, because it is confidently wrong.
 *
 * Two rules this file exists to keep:
 *
 *   THE RING IS THE ENGINE'S RING. Points come from the same parameterisation
 *   buildBubbleShape() uses (rel = 0..2pi, x along the shot, y to its right),
 *   multiplied by the same bubbleRadiusFactor() and the same
 *   GDBubbleSignalsCore.microGeometryFactor(). Nothing here re-derives shape.
 *
 *   DOWN THE LINE IS THE ONLY ORIENTATION (Bubble Bible s3). The origin is at
 *   the centre, the shot travels UP the drawing, and a right miss is drawn on
 *   the right. Flip either and the drawing would need axis labels to be
 *   readable at all.
 */
(function () {
  'use strict';

  function core() { return window.GDBubbleSignalsCore || null; }

  function safe(fn, fallback) {
    try { return fn(); } catch (error) { return fallback; }
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* The engine's own payload for a club at a distance - the same call GPS Play
     makes. When it is not reachable (a page without the app core), a shape
     derived from the club ratios stands in and says so via `synthetic`, so a
     caller can label it honestly rather than passing it off as the real one. */
  function basePayload(club, carryM) {
    var carry = Number(carryM) > 0 ? Number(carryM) : 150;
    if (typeof window.getGDBForClub === 'function') {
      var payload = safe(function () { return window.getGDBForClub(club, carry); }, null);
      if (payload && Number.isFinite(Number(payload.lateralRadiusM))) return payload;
    }
    return {
      lateralRadiusM: Math.max(6, carry * 0.075),
      depthRadiusM: Math.max(8, carry * 0.105),
      distanceTendencyPct: 0,
      clusterTiltDeg: 0,
      visual: { visualTiltDeg: 0, visualSkewDeg: 0 },
      baseCarry: carry,
      synthetic: true
    };
  }

  function radiusFactor(rel, payload) {
    if (typeof window.bubbleRadiusFactor === 'function') {
      var value = safe(function () { return Number(window.bubbleRadiusFactor(rel, payload)); }, NaN);
      if (Number.isFinite(value)) return value;
    }
    return 1;
  }

  /* Ring in metres, in the engine's local frame: x along the shot, y right. */
  function ringPoints(payload, geometry, exaggeration, steps) {
    var api = core();
    var exaggerate = Number(exaggeration) > 0 ? Number(exaggeration) : 1;
    var count = Math.max(48, Number(steps) || 168);
    var lateral = Math.max(1, Number(payload.lateralRadiusM) || 1);
    var depth = Math.max(1, Number(payload.depthRadiusM) || 1);
    var tiltDeg = Number((payload.visual && payload.visual.visualTiltDeg) || payload.clusterTiltDeg || 0);
    if (geometry && api) tiltDeg += (Number(geometry.axisAdjustmentDeg) || 0) * exaggerate;
    var tilt = (tiltDeg * Math.PI) / 180;

    var points = [];
    for (var i = 0; i < count; i++) {
      var rel = (Math.PI * 2 * i) / count;
      var rf = radiusFactor(rel, payload);
      if (geometry && api) rf *= api.microGeometryFactor(geometry, rel, exaggerate);
      var x = Math.cos(rel) * depth * rf;
      var y = Math.sin(rel) * lateral * rf;
      points.push({
        x: x * Math.cos(tilt) - y * Math.sin(tilt),
        y: x * Math.sin(tilt) + y * Math.cos(tilt)
      });
    }
    return points;
  }

  function pathFor(points, cx, cy, scale) {
    return points.map(function (point, index) {
      /* engine x (long) -> screen -y; engine y (right) -> screen +x */
      return (index ? 'L' : 'M')
        + (cx + point.y * scale).toFixed(2) + ' '
        + (cy - point.x * scale).toFixed(2);
    }).join(' ') + ' Z';
  }

  /* One SVG showing the base ring and, when a model is supplied, the adjusted
     ring over it. opts:
       width, height       drawing box
       exaggeration        1 in production; Studio's magnifying glass above it
       showAxes            faint centre cross + LONG/RIGHT labels
       label               caption drawn under the shape
       baseColour/adjColour
       scaleTo             fix the metres-per-pixel across several drawings, so
                           a row of projected clubs shows real size differences
                           instead of each being normalised to its own box */
  function bubbleSvg(payload, geometry, opts) {
    opts = opts || {};
    var width = Number(opts.width) || 320;
    var height = Number(opts.height) || 300;
    var exaggerate = Number(opts.exaggeration) > 0 ? Number(opts.exaggeration) : 1;
    var baseColour = opts.baseColour || '#8fa79c';
    var adjColour = opts.adjColour || '#3cff8d';

    var base = ringPoints(payload, null, 1);
    var adjusted = geometry && core() && !core().isIdentityGeometry(geometry)
      ? ringPoints(payload, geometry, exaggerate)
      : null;

    var reach = Number(opts.scaleTo) > 0 ? Number(opts.scaleTo) : 0;
    if (!reach) {
      base.concat(adjusted || []).forEach(function (point) {
        reach = Math.max(reach, Math.abs(point.x), Math.abs(point.y));
      });
    }
    var pad = opts.label ? 24 : 14;
    var scale = reach > 0 ? (Math.min(width, height) / 2 - pad) / reach : 1;
    var cx = width / 2;
    var cy = height / 2 - (opts.label ? 6 : 0);

    var axes = opts.showAxes === false ? '' :
      '<line x1="' + cx + '" y1="6" x2="' + cx + '" y2="' + (height - 6) + '" stroke="rgba(255,255,255,.07)" stroke-width="1"/>'
      + '<line x1="6" y1="' + cy + '" x2="' + (width - 6) + '" y2="' + cy + '" stroke="rgba(255,255,255,.07)" stroke-width="1"/>';

    return '<svg class="gdBubbleGeometryView" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="'
      + esc(opts.ariaLabel || 'Bubble geometry') + '">'
      + axes
      + '<path d="' + pathFor(base, cx, cy, scale) + '" fill="' + baseColour + '" fill-opacity="0.05" stroke="' + baseColour
      + '" stroke-width="1.3"' + (adjusted ? ' stroke-dasharray="4 3"' : '') + '/>'
      + (adjusted ? '<path d="' + pathFor(adjusted, cx, cy, scale) + '" fill="' + adjColour
        + '" fill-opacity="0.07" stroke="' + adjColour + '" stroke-width="1.5"/>' : '')
      + '<circle cx="' + cx + '" cy="' + cy + '" r="2" fill="' + baseColour + '" fill-opacity="0.8"/>'
      + (opts.showLabels === false ? ''
        : '<text x="' + cx + '" y="14" fill="' + baseColour + '" font-size="9.5" text-anchor="middle" opacity="0.7">LONG</text>')
      + (opts.label
        ? '<text x="' + cx + '" y="' + (height - 5) + '" fill="' + baseColour + '" font-size="10.5" text-anchor="middle">'
          + esc(opts.label) + '</text>'
        : '')
      + '</svg>';
  }

  /* The largest reach across a set of payloads, so a row of projected clubs
     can share one scale. Without this every club is drawn the same size and
     the progression - the entire point of the view - is invisible. */
  function commonScale(payloads, geometry, exaggeration) {
    var reach = 0;
    (payloads || []).forEach(function (payload) {
      ringPoints(payload, geometry, exaggeration).forEach(function (point) {
        reach = Math.max(reach, Math.abs(point.x), Math.abs(point.y));
      });
    });
    return reach;
  }

  window.GDBubbleGeometryView = {
    basePayload: basePayload,
    ringPoints: ringPoints,
    bubbleSvg: bubbleSvg,
    commonScale: commonScale
  };
})();
