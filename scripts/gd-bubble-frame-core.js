/* The Bubble's frame of reference. One definition, for every surface.
 *
 * WHY THIS FILE EXISTS
 *
 * The Bubble was drawn by four different pieces of code that each defined their
 * own axes, each documented locally, none of them reconciled:
 *
 *   gd-app-core.js          x = forward (long), y = right; angle via
 *                           atan2(y, x), so tilt was measured off the TARGET
 *                           LINE
 *   gd-route-audit.js       an SVG ellipse with rx from lateral and ry from
 *                           depth, rotated with transform="rotate()", which
 *                           turns from the SCREEN X AXIS - the lateral one
 *   gd-course-transfer-score.js  same swapped axes as the graph (its own tests
 *                           pin radiusFor({x:5,y:0}) against rx), plus a
 *                           yAxisDown boolean every caller had to pass right
 *   gd-conditions-geometry.js    forward along a compass bearing, lateral
 *                           positive right - the same meaning as the engine,
 *                           written in different words
 *
 * Two of those take their tilt from the SAME function and apply it to
 * perpendicular reference axes. A 10 degree iron tilt therefore meant "10
 * degrees off the target line" in GPS Play and "10 degrees off the
 * perpendicular" in the graphs - the 90 degree disagreement, sitting in plain
 * sight in both files and visible in neither, because each surface was
 * self-consistent. Nothing looked wrong until a value moved between them, and
 * then the orientation appeared to flip at random.
 *
 * THE DEFINITION
 *
 * Angles are measured in a full 360 from the ORIGIN, which is what every
 * surface already has: GPS Play knows where the shot starts, and the graphs
 * have a plotted origin at the centre of the chart.
 *
 *     0    degrees  ->  straight down the origin -> target line
 *     90   degrees  ->  square right of it
 *     180  degrees  ->  straight back toward the origin
 *     270  degrees  ->  square left
 *
 * Clockwise is positive, because right-of-target is positive everywhere else in
 * this codebase (spin axis, start direction, offline) and a second sign
 * convention is how the first one gets lost.
 *
 * WHAT THIS FILE IS NOT
 *
 * It is not a claim about how big a Bubble is or what proportions it has. The
 * shapes are generated - a fixed per-club ratio scaled by carry - and they are
 * produced consistently. Nothing here sizes anything, and nothing here should
 * ever be given a say in GPS Play's scaling, which is deliberately its own.
 *
 * This file settles ORIENTATION and nothing else: which way the object is laid
 * down once something else has decided how big it is.
 *
 *     acrossM   the semi-axis lying along 90/270, square to the shot
 *     alongM    the semi-axis lying along 0/180, down the shot
 *
 * `tiltDeg` rotates those axes off their nominal positions, clockwise positive,
 * and mirrors with handedness. A tilt of zero is a Bubble lying exactly square
 * to the target line.
 *
 * WHAT A CONSUMER DOES
 *
 * Never re-derive any of the above. Build an ellipse here, ask for its ring or
 * its major axis here, and convert at the boundary with toBearing (for the map)
 * or toScreen (for SVG). The converters own the y-down flip and the
 * bearing-vs-maths rotation, which is exactly the pair of details each surface
 * used to get subtly differently. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GDBubbleFrameCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var FRAME_VERSION = 1;

  /* The four cardinal directions of the frame, named so call sites read as
     golf rather than as trigonometry. */
  var LONG_DEG = 0;
  var RIGHT_DEG = 90;
  var SHORT_DEG = 180;
  var LEFT_DEG = 270;

  function num(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  function round(v, d) { var f = Math.pow(10, d || 0); return Math.round(v * f) / f; }
  var toRad = function (deg) { return (deg * Math.PI) / 180; };
  var toDeg = function (rad) { return (rad * 180) / Math.PI; };

  /* Any angle into 0..360. */
  function normaliseDeg(deg) {
    var d = num(deg, 0) % 360;
    return d < 0 ? d + 360 : d;
  }

  /* An AXIS is a line, not a direction: 170 degrees and 350 degrees describe
     the same axis. Folded to (-90, 90] so two orientations can be compared
     without one of them arriving half a turn out - which is what made the
     handedness mirror look broken when it was only pointing the other way
     along the same line. */
  function foldAxisDeg(deg) {
    var d = normaliseDeg(deg) % 180;
    return d > 90 ? d - 180 : d;
  }

  /* Smallest angle between two directions, 0..180. */
  function angleBetween(a, b) {
    var d = Math.abs(normaliseDeg(a) - normaliseDeg(b)) % 360;
    return d > 180 ? 360 - d : d;
  }

  /* { alongM, acrossM, tiltDeg } -> a validated ellipse in this frame.
   *
   * Returns null rather than a repaired guess when the radii are unusable: a
   * bubble drawn from nothing is worse than no bubble, because it looks like an
   * answer. */
  function ellipse(spec) {
    var alongM = num(spec && spec.alongM, NaN);
    var acrossM = num(spec && spec.acrossM, NaN);
    if (!(alongM > 0) || !(acrossM > 0)) return null;
    return {
      alongM: alongM,
      acrossM: acrossM,
      tiltDeg: num(spec && spec.tiltDeg, 0),
      frameVersion: FRAME_VERSION
    };
  }

  /* A point on the ring at parameter t (degrees, 0..360).
   *
   * t is the ELLIPSE PARAMETER, not the polar angle - for any ellipse that is
   * not a circle the two differ, and conflating them is why a region bias aimed
   * at "Long" can land a few degrees off it. bearingOf() below answers the
   * polar question when that is what is wanted. */
  function ringPoint(el, t, radiusFactor) {
    if (!el) return null;
    var rf = num(radiusFactor, 1);
    var p = toRad(num(t, 0));
    /* Unrotated: along lies on 0/180, across on 90/270. */
    var along = Math.cos(p) * el.alongM * rf;
    var across = Math.sin(p) * el.acrossM * rf;
    return rotate({ alongM: along, acrossM: across }, el.tiltDeg);
  }

  /* Rotate a frame point clockwise by deg. One implementation, so no consumer
     writes the matrix again and gets a sign the other way. */
  function rotate(point, deg) {
    var t = toRad(num(deg, 0));
    var a = num(point && point.alongM, 0);
    var c = num(point && point.acrossM, 0);
    return {
      alongM: a * Math.cos(t) - c * Math.sin(t),
      acrossM: a * Math.sin(t) + c * Math.cos(t)
    };
  }

  function ring(el, steps, radiusFactorAt) {
    if (!el) return [];
    var count = Math.max(8, Math.floor(num(steps, 168)));
    var out = [];
    for (var i = 0; i < count; i++) {
      var t = (360 * i) / count;
      out.push(ringPoint(el, t, typeof radiusFactorAt === 'function' ? radiusFactorAt(t) : 1));
    }
    return out;
  }

  /* Which way a frame point actually lies, in frame degrees 0..360. */
  function bearingOf(point) {
    return normaliseDeg(toDeg(Math.atan2(num(point && point.acrossM, 0), num(point && point.alongM, 0))));
  }

  /* Where the LONG axis of this ellipse points, folded to (-90, 90].
   *
   * With across as the long axis an untilted bubble answers 90 - square across
   * the target line - and the tilt moves it from there. This is the number to
   * assert in a test, because it is the one a person can look at the screen and
   * check. */
  function majorAxisDeg(el) {
    if (!el) return null;
    var longer = el.acrossM >= el.alongM ? RIGHT_DEG : LONG_DEG;
    return foldAxisDeg(longer + num(el.tiltDeg, 0));
  }

  /* How far the long axis sits off square-across-the-line. Zero means a bubble
     lying exactly perpendicular to the shot. */
  function tiltFromSquareDeg(el) {
    if (!el) return null;
    return round(foldAxisDeg(majorAxisDeg(el) - RIGHT_DEG), 4);
  }

  /* ---------------------------------------------------------------------
     Boundary converters. Every surface leaves the frame exactly here.
     --------------------------------------------------------------------- */

  /* Frame degrees -> a compass bearing, given the shot's own bearing.
   *
   * Frame 0 IS the shot bearing, and both grow clockwise, so this is an
   * addition. It is a named function anyway because the map path used to inline
   * `shotBrg + atan2(y, x)` and that is the exact spot where an axis swap hides. */
  function toBearing(frameDeg, shotBearingDeg) {
    return normaliseDeg(num(shotBearingDeg, 0) + num(frameDeg, 0));
  }
  function toFrameDeg(bearingDeg, shotBearingDeg) {
    return normaliseDeg(num(bearingDeg, 0) - num(shotBearingDeg, 0));
  }

  /* A frame point -> map polar coordinates, ready for project(centre, brg, m). */
  function toMapPolar(point, shotBearingDeg) {
    var a = num(point && point.alongM, 0);
    var c = num(point && point.acrossM, 0);
    return {
      bearingDeg: toBearing(bearingOf(point), shotBearingDeg),
      distanceM: Math.sqrt(a * a + c * c)
    };
  }

  /* A frame point -> SVG/screen pixels.
   *
   * opts: { cx, cy, pxPerM, headingUp }
   *
   * headingUp (the default) draws the shot going UP the page, which is how
   * every chart in the app is read: long is toward the top, right is to the
   * right. Screen y grows downwards, so along must be NEGATED - and that single
   * minus sign is what the old `yAxisDown` boolean was asking each caller to
   * remember. It is not a parameter any more because there is no correct
   * alternative: a chart with long pointing down is simply wrong. */
  function toScreen(point, opts) {
    var o = opts || {};
    var scale = num(o.pxPerM, 1);
    var a = num(point && point.alongM, 0);
    var c = num(point && point.acrossM, 0);
    return {
      x: num(o.cx, 0) + c * scale,
      y: num(o.cy, 0) - a * scale
    };
  }
  function fromScreen(px, opts) {
    var o = opts || {};
    var scale = num(o.pxPerM, 1) || 1;
    return {
      alongM: (num(o.cy, 0) - num(px && px.y, 0)) / scale,
      acrossM: (num(px && px.x, 0) - num(o.cx, 0)) / scale
    };
  }

  /* The rotation an SVG `transform="rotate()"` needs to draw this ellipse with
     rx = acrossM and ry = alongM.
   *
   * It is the SAME sign as the frame tilt, which is not the obvious answer and
   * is worth the arithmetic rather than the intuition. toScreen maps
   * (along, across) -> (across, -along); as a matrix that is [[0,1],[-1,0]],
   * whose determinant is +1. A determinant of +1 is a pure rotation, so the
   * mapping carries the sense of rotation across unchanged - the y-flip and the
   * axis swap cancel. Had it been a reflection (determinant -1) the sign would
   * invert, which is what it looks like it should do at a glance.
   *
   * This function got it backwards on the first attempt and the round-trip test
   * below caught it. That is precisely the error that produced the original
   * 90-degree bug, arrived at the same way: by reasoning about the flip instead
   * of composing the two transforms. */
  function toSvgRotateDeg(el) {
    return el ? round(num(el.tiltDeg, 0), 4) : 0;
  }

  /* ---------------------------------------------------------------------
     Regions - the same eight the Signals engine names, on the same 360.
     --------------------------------------------------------------------- */

  var REGIONS = ['long', 'longRight', 'right', 'shortRight', 'short', 'shortLeft', 'left', 'longLeft'];

  function regionAngleDeg(name) {
    var index = REGIONS.indexOf(name);
    return index === -1 ? null : index * 45;
  }
  function regionAt(frameDeg) {
    var d = normaliseDeg(frameDeg);
    return REGIONS[Math.round(d / 45) % 8];
  }

  /* Is a frame point inside the ellipse, and by how much? 1.0 is exactly on the
     boundary. The one containment test - the picture and the score must never
     be able to disagree, which is only guaranteed if they call the same code. */
  function normalisedRadius(point, el) {
    if (!el) return null;
    var local = rotate(point, -num(el.tiltDeg, 0));
    var a = local.alongM / el.alongM;
    var c = local.acrossM / el.acrossM;
    return Math.sqrt(a * a + c * c);
  }
  function contains(point, el, scalePercent) {
    var r = normalisedRadius(point, el);
    if (r === null) return false;
    return r <= num(scalePercent, 100) / 100 + 1e-9;
  }

  return {
    FRAME_VERSION: FRAME_VERSION,
    LONG_DEG: LONG_DEG, RIGHT_DEG: RIGHT_DEG, SHORT_DEG: SHORT_DEG, LEFT_DEG: LEFT_DEG,
    REGIONS: REGIONS,
    normaliseDeg: normaliseDeg,
    foldAxisDeg: foldAxisDeg,
    angleBetween: angleBetween,
    ellipse: ellipse,
    rotate: rotate,
    ringPoint: ringPoint,
    ring: ring,
    bearingOf: bearingOf,
    majorAxisDeg: majorAxisDeg,
    tiltFromSquareDeg: tiltFromSquareDeg,
    toBearing: toBearing,
    toFrameDeg: toFrameDeg,
    toMapPolar: toMapPolar,
    toScreen: toScreen,
    fromScreen: fromScreen,
    toSvgRotateDeg: toSvgRotateDeg,
    regionAngleDeg: regionAngleDeg,
    regionAt: regionAt,
    normalisedRadius: normalisedRadius,
    contains: contains
  };
});
