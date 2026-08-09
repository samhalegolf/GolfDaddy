/* GPS bubble visual — parts builder.

   Design source: "GPS Bubble.dc.html" (options 2a corridor / 2b bubble only),
   handoff GPS-BUBBLE-V2.md. Pure geometry → SVG markup: it is handed the
   engine's render model and the painter's projection seam and returns the
   strings that go inside #bubbleSvg. It DECIDES NOTHING — same contract as the
   painter that calls it. No new inputs, no state, no maths of its own beyond
   turning metres into the points the projector already knows how to place.

   Everything is derived from PROJECTED points, never from a hard-coded
   ellipse, so the bubble renders at any position, size and screen angle:

     - the outline is the engine's own main ring, projected (model.rings.main)
     - the aim line is start → target, i.e. it already carries My Bubble's
       sideways offset; it is NOT drawn to the bubble's centre
     - the carry line is the real carry distance: a point stepped along the
       shot bearing from the start, then the perpendicular through it, clipped
       to the projected ring — so it lands wherever the carry actually falls
       inside the shape and sits at the shape's true on-screen angle.

   Consumer: app/js/painter.js drawShot(). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else { root.GDBubbleVisual = factory(); }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var R = 6378137;
  function toRad(d) { return (d * Math.PI) / 180; }
  function toDeg(r) { return (r * 180) / Math.PI; }

  /* Bearing start → end, degrees clockwise from north. */
  function bearing(a, b) {
    var p1 = toRad(a.lat), p2 = toRad(b.lat), dl = toRad(b.lng - a.lng);
    return (toDeg(Math.atan2(Math.sin(dl) * Math.cos(p2),
      Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl))) + 360) % 360;
  }

  /* Step metres along a bearing from a point. */
  function destination(from, bearingDeg, metres) {
    var d = metres / R, br = toRad(bearingDeg), p1 = toRad(from.lat), l1 = toRad(from.lng);
    var p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br));
    var l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: toDeg(p2), lng: toDeg(l2) };
  }

  function pathFrom(points) {
    return "M" + points.map(function (p) {
      return p.left.toFixed(1) + "," + p.top.toFixed(1);
    }).join("L") + "Z";
  }

  /* Segment/polygon intersections, sorted along the segment. Used to clip the
     carry line to the bubble however the shape is rotated or skewed. */
  function clipToPolygon(a, b, poly) {
    var hits = [];
    for (var i = 0; i < poly.length; i++) {
      var c = poly[i], d = poly[(i + 1) % poly.length];
      var r1 = { x: b.left - a.left, y: b.top - a.top };
      var r2 = { x: d.left - c.left, y: d.top - c.top };
      var den = r1.x * r2.y - r1.y * r2.x;
      if (!den) continue;
      var t = ((c.left - a.left) * r2.y - (c.top - a.top) * r2.x) / den;
      var u = ((c.left - a.left) * r1.y - (c.top - a.top) * r1.x) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        hits.push({ t: t, left: a.left + r1.x * t, top: a.top + r1.y * t });
      }
    }
    hits.sort(function (p, q) { return p.t - q.t; });
    return hits.length >= 2 ? [hits[0], hits[hits.length - 1]] : null;
  }

  var CHIP_GAP_PX = 34;        // chip height + breathing room, past the target
  var AIM_CLEAR_PX = 26;       // how far the aim line runs past the chip

  /* opts:
       project(latlng) → {left, top} | null      the painter's projector
       model                                      GDBubbleEngine.renderModel()
       start, target                              the shot (target carries the offset)
       carryM                                     payload.baseCarry, real metres
       corridor                                   draw the dispersion corridor edges
       aimLine                                    draw the aim ray (the player's setting)
       aimClearPx                                 override for AIM_CLEAR_PX
       idPrefix                                   unique per render pass

     Returns { defs, parts, chip, centre } — strings plus the viewport-pixel
     point the DOM club chip is positioned at. Caller writes
       svg.innerHTML = "<defs>" + defs + "</defs>" + parts.join("") */
  function buildBubbleParts(opts) {
    var project = opts.project, model = opts.model;
    if (!project || !model || !model.rings || !model.rings.main) return null;

    var ring = model.rings.main.map(project).filter(Boolean);
    if (ring.length < 8) return null;
    var centre = project(model.center);
    var startPx = opts.start ? project(opts.start) : null;
    var targetPx = opts.target ? project(opts.target) : null;
    if (!centre || !startPx || !targetPx) return null;

    var id = opts.idPrefix || "gdb";
    var defs = [], parts = [];

    /* ---- carry line: the real distance, in the shape's own frame -------- */
    var carryMask = "";
    var carryM = Number(opts.carryM);
    if (Number.isFinite(carryM) && carryM > 0) {
      var carryPt = project(destination(opts.start, bearing(opts.start, opts.target), carryM));
      if (carryPt) {
        /* Perpendicular to the shot line ON SCREEN, so it stays square to the
           bubble whatever the camera rotation or tilt is doing. */
        var dx = targetPx.left - startPx.left, dy = targetPx.top - startPx.top;
        var len = Math.hypot(dx, dy) || 1;
        var px = -dy / len, py = dx / len;
        var far = 400;
        var seg = clipToPolygon(
          { left: carryPt.left - px * far, top: carryPt.top - py * far },
          { left: carryPt.left + px * far, top: carryPt.top + py * far }, ring);
        if (seg) {
          var ang = toDeg(Math.atan2(seg[1].top - seg[0].top, seg[1].left - seg[0].left));
          var lx = (seg[1].left - 6).toFixed(1), ly = (seg[1].top + 10).toFixed(1);
          /* The line and its label are KNOCKED OUT of the bubble, not drawn on
             top of it — one mask, so they can never drift apart. */
          carryMask = '<mask id="' + id + '-carry">'
            + '<rect x="0" y="0" width="100%" height="100%" fill="#fff"/>'
            + '<line x1="' + seg[0].left.toFixed(1) + '" y1="' + seg[0].top.toFixed(1)
            + '" x2="' + seg[1].left.toFixed(1) + '" y2="' + seg[1].top.toFixed(1)
            + '" stroke="#000" stroke-width="1.8"/>'
            + '<text x="' + lx + '" y="' + ly + '" text-anchor="end" fill="#000"'
            + ' font-size="8" font-weight="800" letter-spacing=".14em"'
            + ' transform="rotate(' + ang.toFixed(1) + ' ' + lx + ' ' + ly + ')">CARRY</text>'
            + '</mask>';
          defs.push(carryMask);
        }
      }
    }
    var maskAttr = carryMask ? ' mask="url(#' + id + '-carry)"' : "";

    /* ---- the bubble: even fill + one thin border, no outer rings -------- */
    defs.push('<radialGradient id="' + id + '-fill" cx="50%" cy="50%" r="50%">'
      + '<stop offset="0%" stop-color="#fff" stop-opacity=".18"/>'
      + '<stop offset="74%" stop-color="#fff" stop-opacity=".17"/>'
      + '<stop offset="90%" stop-color="#fff" stop-opacity=".12"/>'
      + '<stop offset="100%" stop-color="#fff" stop-opacity="0"/></radialGradient>');
    var d = pathFrom(ring);
    parts.push('<path class="bubbleFill" d="' + d + '" fill="url(#' + id + '-fill)"' + maskAttr + '/>');
    parts.push('<path class="bubbleEdge" d="' + d + '" fill="none" stroke="#fff"'
      + ' stroke-opacity=".8" stroke-width="1.1"' + maskAttr + '/>');

    var ux = targetPx.left - startPx.left, uy = targetPx.top - startPx.top;
    var ul = Math.hypot(ux, uy) || 1; ux /= ul; uy /= ul;
    var nx = -uy, ny = ux;                             // screen normal to the shot

    /* ---- corridor: edge lines only, cut where they meet the bubble ------ */
    if (opts.corridor) {
      var left = null, right = null;
      ring.forEach(function (p) {
        var s = (p.left - centre.left) * nx + (p.top - centre.top) * ny;
        if (!left || s < left.s) left = { s: s, p: p };
        if (!right || s > right.s) right = { s: s, p: p };
      });
      defs.push('<mask id="' + id + '-corr">'
        + '<rect x="0" y="0" width="100%" height="100%" fill="#fff"/>'
        + '<path d="' + d + '" fill="#000"/></mask>');
      defs.push('<linearGradient id="' + id + '-cedge" gradientUnits="userSpaceOnUse"'
        + ' x1="' + startPx.left.toFixed(1) + '" y1="' + startPx.top.toFixed(1)
        + '" x2="' + centre.left.toFixed(1) + '" y2="' + centre.top.toFixed(1) + '">'
        + '<stop offset="0%" stop-color="#fff" stop-opacity="0"/>'
        + '<stop offset="55%" stop-color="#fff" stop-opacity=".18"/>'
        + '<stop offset="100%" stop-color="#fff" stop-opacity=".38"/></linearGradient>');
      parts.push('<g class="bubbleCorridor" fill="none" stroke="url(#' + id + '-cedge)"'
        + ' stroke-width="1.2" stroke-linecap="round" mask="url(#' + id + '-corr)">'
        + '<path d="' + corridorEdge(startPx, left.p) + '"/>'
        + '<path d="' + corridorEdge(startPx, right.p) + '"/></g>');
    }

    /* ---- aim line: start → target, extended past the club chip ---------- */
    var clear = Number(opts.aimClearPx);
    if (!Number.isFinite(clear)) clear = AIM_CLEAR_PX;
    var beyond = CHIP_GAP_PX + clear;                  // the club label sets the minimum
    var end = { left: targetPx.left + ux * beyond, top: targetPx.top + uy * beyond };
    if (opts.aimLine !== false) {
      parts.push('<path class="aimLine" d="M' + startPx.left.toFixed(1) + "," + startPx.top.toFixed(1)
        + "L" + end.left.toFixed(1) + "," + end.top.toFixed(1) + '"/>');
      parts.push('<line class="aimEnd" x1="' + (end.left - nx * 5.5).toFixed(1)
        + '" y1="' + (end.top - ny * 5.5).toFixed(1)
        + '" x2="' + (end.left + nx * 5.5).toFixed(1)
        + '" y2="' + (end.top + ny * 5.5).toFixed(1) + '"/>');
    }

    /* ---- club chip + the trumpet that ties it to the bubble ------------- */
    var chip = { left: targetPx.left + ux * CHIP_GAP_PX, top: targetPx.top + uy * CHIP_GAP_PX };
    defs.push('<linearGradient id="' + id + '-trumpet" gradientUnits="userSpaceOnUse"'
      + ' x1="' + chip.left.toFixed(1) + '" y1="' + chip.top.toFixed(1)
      + '" x2="' + centre.left.toFixed(1) + '" y2="' + centre.top.toFixed(1) + '">'
      + '<stop offset="0%" stop-color="#fff" stop-opacity=".92"/>'
      + '<stop offset="22%" stop-color="#fff" stop-opacity=".7"/>'
      + '<stop offset="55%" stop-color="#fff" stop-opacity=".26"/>'
      + '<stop offset="100%" stop-color="#fff" stop-opacity="0"/></linearGradient>');
    /* Flare measured BACK from the chip along the shot, so it always opens
       into the bubble rather than at a fixed screen angle. */
    function pt(back, side) {
      return {
        left: chip.left - ux * back + nx * side,
        top: chip.top - uy * back + ny * side
      };
    }
    var a1 = pt(0, -2), a2 = pt(0, 2), a3 = pt(52, 33), a4 = pt(52, -33);
    var c1 = pt(26, 14), c2 = pt(26, -14);
    parts.push('<path class="bubbleTrumpet" d="M' + xy(a1)
      + "C" + xy(c2) + " " + xy(a4) + " " + xy(a4)
      + "L" + xy(a3)
      + "C" + xy(c1) + " " + xy(a2) + " " + xy(a2)
      + 'Z" fill="url(#' + id + '-trumpet)"/>');

    return {
      defs: defs.join(""),
      parts: parts,
      chip: chip,          // where the DOM club chip is positioned
      centre: centre
    };
  }

  function xy(p) { return p.left.toFixed(1) + "," + p.top.toFixed(1); }

  /* Ball → bubble edge, bowed so the pair read as one opening corridor. */
  function corridorEdge(from, to) {
    return "M" + xy(from)
      + "Q" + xy({ left: (from.left + to.left) / 2, top: (from.top + to.top) / 2 })
      + " " + xy(to);
  }

  return {
    buildBubbleParts: buildBubbleParts,
    bearing: bearing,
    destination: destination,
    clipToPolygon: clipToPolygon
  };
});
