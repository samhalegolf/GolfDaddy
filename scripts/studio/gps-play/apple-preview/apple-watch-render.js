/* The Apple Watch map page, drawn in a browser. STUDIO ONLY.
 *
 * A line-for-line port of what the wrist draws: ios/App/ClarityCaddyWatch/AimableHoleMap.swift
 * (the map you can aim on, with HoleMapPage's chrome round it) and the pieces it leans on -
 * WatchMapCamera.swift (the shot framing), WatchMap.swift's TreeSprites, WatchConditions.swift.
 * The Swift is the source of truth: when it changes, this changes with it, the same way
 * garmin-watch-render.js follows the Monkey C.
 *
 * SwiftUI draws in POINTS on a 2x panel, so this draws in points on a canvas scaled by two.
 * What cannot be copied is said so: SF Rounded is approximated by whatever rounded sans the
 * browser has, and the band's buttons are drawn where SwiftUI lays them out.
 *
 * The page (watch-preview-page.js) owns the data and the inputs and hands this a `session`
 * shaped like WatchSessionManager + the page state AimableHoleMap is given. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("../watch-preview/watch-common.js"));
  else root.GDAppleWatchRender = factory(root.GDWatchCommon);
})(typeof window !== "undefined" ? window : globalThis, function (common) {
  "use strict";

  var Geo = common.Geo, formatDistance = common.formatDistance;

  // ------------------------------------------------------------------ devices

  /* Screens in POINTS, as SwiftUI sees them; every one is a 2x panel. `corner` is the glass's
     corner radius as a share of its width - the Series 7 and later are rounder than the SE. */
  var DEVICES = [
    { id: "s10-46", name: "Series 10 46 mm", width: 208, height: 248, shape: "roundedRect", corner: 0.21, pixelScale: 2, amoled: true, touch: true },
    { id: "s10-42", name: "Series 10 42 mm", width: 187, height: 223, shape: "roundedRect", corner: 0.21, pixelScale: 2, amoled: true, touch: true },
    { id: "ultra2", name: "Ultra 2 49 mm", width: 205, height: 251, shape: "roundedRect", corner: 0.19, pixelScale: 2, amoled: true, touch: true },
    { id: "s9-45", name: "Series 7 / 8 / 9 45 mm", width: 198, height: 242, shape: "roundedRect", corner: 0.21, pixelScale: 2, amoled: true, touch: true },
    { id: "s9-41", name: "Series 7 / 8 / 9 41 mm", width: 176, height: 215, shape: "roundedRect", corner: 0.21, pixelScale: 2, amoled: true, touch: true },
    { id: "se-44", name: "SE 44 mm", width: 184, height: 224, shape: "roundedRect", corner: 0.15, pixelScale: 2, amoled: true, touch: true },
    { id: "se-40", name: "SE 40 mm", width: 162, height: 197, shape: "roundedRect", corner: 0.15, pixelScale: 2, amoled: true, touch: true }
  ];

  var FONT = "'SF Pro Rounded', ui-rounded, -apple-system, 'Helvetica Neue', Arial, sans-serif";
  function font(size, weight) { return weight + " " + size + "px " + FONT; }

  // ------------------------------------------------------------------ constants (AimableHoleMap / WatchMapCamera)

  var MAXIMUM_SCALE = 3, PLAYER_HEIGHT_FRACTION = 0.82;
  var EDGE_INSET = 16, EDGE_DWELL_MS = 400, EDGE_PAN_SPEED = 45, PAN_TICK_MS = 1000 / 30;
  var TOP_BAND = 30, BOTTOM_EDGE = 40, READOUT = 38;
  var HOLD_MS = 200;             // LongPressGesture(minimumDuration: 0.2, maximumDistance: 12)
  var HOLD_MAX_DISTANCE = 12;
  var MINT = "rgba(99,230,226,", WHITE = "rgba(255,255,255,", BLACK = "rgba(0,0,0,";
  var WIND_BLUE = "#55AAFF", PLAYS_ORANGE = "#FFAA00", ORANGE = "#FF9F0A";
  var EDGE_GREEN = "rgb(41,74,48)";   // Color(red: 0.16, green: 0.29, blue: 0.19)
  var CANVAS_PER_CROWN = 109 / 96;
  var TREE_NAMES = ["tree_round", "tree_broadleaf", "tree_pine", "tree_yellow_green"];

  // ------------------------------------------------------------------ WatchMapCamera

  function Camera(focusX, focusY, scale, rotation, clampsToImage) {
    this.focusX = focusX; this.focusY = focusY; this.scale = scale;
    this.rotation = rotation || 0; this.clampsToImage = clampsToImage !== false;
  }
  Camera.shot = function (player, target, imageWidth, imageHeight, viewWidth, viewHeight) {
    var dx = target.x - player.x, dy = target.y - player.y, distance = Math.hypot(dx, dy);
    if (distance < 1 || viewHeight <= 0) return new Camera(target.x, target.y, MAXIMUM_SCALE, 0, false);
    var scale = Math.min(((PLAYER_HEIGHT_FRACTION - 0.5) * viewHeight) / distance, MAXIMUM_SCALE);
    return new Camera(target.x, target.y, scale, -Math.PI / 2 - Math.atan2(dy, dx), false);
  };
  Camera.resting = function (interest, imageWidth, imageHeight, viewWidth, viewHeight) {
    if (!(imageWidth > 0 && imageHeight > 0 && viewWidth > 0 && viewHeight > 0)) return new Camera(imageWidth / 2, imageHeight / 2, 1);
    var fitScale = Math.min(viewWidth / imageWidth, viewHeight / imageHeight);
    var points = interest.filter(function (p) { return Number.isFinite(p.x) && Number.isFinite(p.y); });
    if (points.length < 2) {
      var f = points[0] || { x: imageWidth / 2, y: imageHeight / 2 };
      return new Camera(f.x, f.y, Math.min(Math.max(fitScale, 1.4), MAXIMUM_SCALE));
    }
    var xs = points.map(function (p) { return p.x; }), ys = points.map(function (p) { return p.y; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs), minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var padding = Math.max(24, 0.22 * Math.max(maxX - minX, maxY - minY));
    var chosen = Math.min(Math.max(Math.min(viewWidth / ((maxX - minX) + padding * 2), viewHeight / ((maxY - minY) + padding * 2)), fitScale), MAXIMUM_SCALE);
    return new Camera((minX + maxX) / 2, (minY + maxY) / 2, chosen);
  };
  Camera.play = function (player, target, imageWidth, imageHeight, viewWidth, viewHeight) {
    if (!(imageWidth > 0 && imageHeight > 0 && viewWidth > 0 && viewHeight > 0)) return new Camera(imageWidth / 2, imageHeight / 2, 1);
    var fillWidth = viewWidth / imageWidth, centreX = imageWidth / 2, centreY = imageHeight / 2;
    if (player == null) return new Camera(centreX, target != null ? target.y : centreY, Math.min(fillWidth, MAXIMUM_SCALE));
    if (target == null) return Camera.low(player, centreX, Math.min(fillWidth, MAXIMUM_SCALE), viewHeight);
    var spanFraction = 0.72, span = Math.abs(target.y - player.y);
    var spanScale = span > 0 ? (viewHeight * spanFraction) / span : MAXIMUM_SCALE;
    var scale = Math.min(Math.max(spanScale, fillWidth), MAXIMUM_SCALE);
    if (span * scale <= viewHeight * spanFraction) return new Camera(centreX, (player.y + target.y) / 2, scale);
    return Camera.low(player, centreX, scale, viewHeight);
  };
  Camera.low = function (player, centreX, scale, viewHeight) {
    var playerHeightFraction = 0.78;
    return new Camera(centreX, player.y - (playerHeightFraction - 0.5) * (viewHeight / scale), scale);
  };
  Camera.edgeDirection = function (x, y, viewWidth, viewHeight) {
    if (!(viewWidth > 0 && viewHeight > 0)) return [0, 0];
    return [x <= EDGE_INSET ? -1 : (x >= viewWidth - EDGE_INSET ? 1 : 0), y <= EDGE_INSET ? -1 : (y >= viewHeight - EDGE_INSET ? 1 : 0)];
  };
  Camera.prototype.imageDirection = function (screenDx, screenDy) {
    var c = Math.cos(this.rotation), s = Math.sin(this.rotation);
    return [screenDx * c + screenDy * s, screenDy * c - screenDx * s];
  };
  Camera.prototype.panned = function (dx, dy, imageWidth, imageHeight) {
    if (!(this.scale > 0) || !Number.isFinite(dx) || !Number.isFinite(dy)) return this;
    var d = this.imageDirection(dx, dy);
    return new Camera(Math.min(Math.max(this.focusX + d[0] / this.scale, 0), Math.max(imageWidth, 0)),
      Math.min(Math.max(this.focusY + d[1] / this.scale, 0), Math.max(imageHeight, 0)), this.scale, this.rotation, this.clampsToImage);
  };
  Camera.axisOrigin = function (scaledLength, viewLength, focus) {
    if (scaledLength <= viewLength) return (viewLength - scaledLength) / 2;
    return Math.min(0, Math.max(viewLength - scaledLength, viewLength / 2 - focus));
  };
  Camera.prototype.origin = function (imageWidth, imageHeight, viewWidth, viewHeight) {
    if (!this.clampsToImage) return [viewWidth / 2 - this.focusX * this.scale, viewHeight / 2 - this.focusY * this.scale];
    return [Camera.axisOrigin(imageWidth * this.scale, viewWidth, this.focusX * this.scale), Camera.axisOrigin(imageHeight * this.scale, viewHeight, this.focusY * this.scale)];
  };
  /* The image->screen affine [a, b, tx, ty]: sx = tx + x*a - y*b, sy = ty + x*b + y*a (the
     CGAffineTransform(a, b, -b, a, tx, ty) the Swift hands GraphicsContext). */
  Camera.prototype.frame = function (imageWidth, imageHeight, viewWidth, viewHeight) {
    if (this.rotation === 0) { var o = this.origin(imageWidth, imageHeight, viewWidth, viewHeight); return [this.scale, 0, o[0], o[1]]; }
    var a = Math.cos(this.rotation) * this.scale, b = Math.sin(this.rotation) * this.scale;
    return [a, b, viewWidth / 2 - (this.focusX * a - this.focusY * b), viewHeight / 2 - (this.focusX * b + this.focusY * a)];
  };
  Camera.prototype.place = function (p, imageWidth, imageHeight, viewWidth, viewHeight) {
    var f = this.frame(imageWidth, imageHeight, viewWidth, viewHeight);
    return { x: f[2] + p.x * f[0] - p.y * f[1], y: f[3] + p.x * f[1] + p.y * f[0] };
  };
  Camera.prototype.imagePointFromView = function (x, y, imageWidth, imageHeight, viewWidth, viewHeight) {
    if (!(this.scale > 0)) return null;
    var f = this.frame(imageWidth, imageHeight, viewWidth, viewHeight), sx = x - f[2], sy = y - f[3], det = f[0] * f[0] + f[1] * f[1];
    return { x: (f[0] * sx + f[1] * sy) / det, y: (f[0] * sy - f[1] * sx) / det };
  };

  // ------------------------------------------------------------------ drawing helpers (GraphicsContext)

  function strokePath(ctx, points, close, colour, width, dash, round) {
    if (points.length < 2) return;
    ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
    for (var i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    if (close) ctx.closePath();
    ctx.setLineDash(dash || []); ctx.lineCap = round ? "round" : "butt"; ctx.lineJoin = round ? "round" : "miter";
    ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.stroke(); ctx.setLineDash([]);
  }
  function fillPath(ctx, points, colour) {
    if (points.length < 3) return;
    ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
    for (var i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath(); ctx.fillStyle = colour; ctx.fill();
  }
  function ellipse(ctx, cx, cy, r, fill, stroke, width) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.setLineDash([]); ctx.stroke(); }
  }
  /* context.draw(Text, at:) centres the text on the point. The four 0.8 pt offsets are the
     Swift's own ghost under a label. */
  function text(ctx, str, x, y, fontSpec, colour) {
    ctx.font = fontSpec; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = colour; ctx.fillText(str, x, y);
  }
  function ghostedText(ctx, str, x, y, fontSpec, colour, ghost) {
    [[0.8, 0.8], [-0.8, 0.8], [0.8, -0.8], [-0.8, -0.8]].forEach(function (o) { text(ctx, str, x + o[0], y + o[1], fontSpec, ghost); });
    text(ctx, str, x, y, fontSpec, colour);
  }
  function capsule(ctx, x, y, w, h, fill, stroke) {
    var r = h / 2;
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.stroke(); }
  }
  function textWidth(ctx, str, fontSpec) { ctx.font = fontSpec; return ctx.measureText(str).width; }

  // ------------------------------------------------------------------ TreeSprites (WatchMap.swift)

  function unpackTree(v) { return { x: v % 2048, y: Math.floor(v / 2048) % 2048, r: Math.floor(v / 4194304) % 128, type: Math.floor(v / 536870912) % 4 }; }
  function drawTrees(ctx, trees, scale, viewWidth, viewHeight, place, bitmap) {
    if (!trees || !trees.length) return;
    for (var i = 0; i < trees.length; i++) {
      var tree = unpackTree(trees[i]);
      var diameter = 2 * tree.r * scale;
      if (diameter < 1.5) continue;
      var centre = place({ x: tree.x, y: tree.y });
      var side = diameter * CANVAS_PER_CROWN, ox = centre.x - diameter / 2, oy = centre.y - diameter / 2;
      if (!(ox < viewWidth && oy < viewHeight && ox + side > 0 && oy + side > 0)) continue;
      var image = bitmap(tree.type);
      if (image) ctx.drawImage(image, ox, oy, side, side);
    }
  }

  // ------------------------------------------------------------------ AimableHoleMap

  /* `session`: the seam the page provides (watch-preview-page.js):
       scene.hasRound(), currentHole(), manifestHole(n) -> { spatialReference, greenLat, greenLng, skeleton, shapes }
       packageVersion(), bitmapFor(n) -> Image | null, playerPoint() -> {lat,lng} | null
       calculate(player, target) -> { target, targetDistanceM, club:{club,carryM,totalM}, centre, ring } | null
       bagMaxTotalM(), windEffect(p, t, flatM), playsLikeM(p, t, flatM, effect), greenDistances(), holeLine()
       sendAim(target), yards(), locked() -> Boolean
     device: an entry of DEVICES; treeBitmap(type) -> Image | null. */
  function MapFace(session, device, treeBitmap) {
    this.session = session; this.device = device; this.treeBitmap = treeBitmap;
    /* WatchPlayState, as the page owns it: player, target, bubble. */
    this.state = { player: null, target: null, bubble: null };
    this.camera = null;
    this.dragging = false; this.fingerAt = null; this.edgeSince = null; this.panning = false;
    this.pressAt = null; this.pressDown = null; this.pressMoved = false; this.pressBand = false;
    this.playsMode = false; this.playsRect = null; this.crownZoom = 1;
    this.origin = null;   // where the lock put the Bubble (WatchSessionManager.aimOrigin)
    this.aiming = false; this.dragActive = false;   // the page's readout reads these, as for the Garmin
    this.trace = null;
  }

  MapFace.prototype.imageSize = function () {
    var hole = this.session.manifestHole(this.session.currentHole());
    return hole ? { w: hole.spatialReference.imageWidth, h: hole.spatialReference.imageHeight } : null;
  };
  MapFace.prototype.imagePoint = function (geo) {
    var hole = this.session.manifestHole(this.session.currentHole());
    return hole && geo ? hole.spatialReference.imagePoint(geo.lat, geo.lng) : null;
  };
  MapFace.prototype.currentTarget = function () { return this.state.target || null; };
  MapFace.prototype.currentBubble = function () { return this.state.bubble || null; };

  /* WatchPlayState.moveTarget: the bag's roof, then the engine. */
  MapFace.prototype.moveTarget = function (coordinate) {
    if (!this.state.player) return null;
    var target = common.clampedToBag(coordinate, this.state.player, this.session.bagMaxTotalM());
    this.state.target = target;
    this.state.bubble = this.session.calculate(this.state.player, target);
    return this.state.bubble;
  };

  /* AimableHoleMap.settle: the wrist's shot for this hole, framed. A target of its own is
     kept; a locked shot opens where the lock put it; otherwise the wrist's default rule - the
     green when the bag reaches it, the fairway-line layup when it does not. The only place
     the camera is set besides the crown, a drag and Reset. */
  MapFace.prototype.settle = function () {
    var fix = this.session.playerPoint(), hole = this.session.manifestHole(this.session.currentHole());
    if (!fix || !hole) return;
    this.state.player = fix;
    if (this.state.target) this.moveTarget(this.state.target);
    else if (this.origin) this.moveTarget(this.origin);
    else {
      var green = hole.skeleton ? hole.skeleton.g : (hole.greenLat != null ? { lat: hole.greenLat, lng: hole.greenLng } : null);
      var defaulted = green ? common.defaultTarget(fix, green, this.session.holeLine(), this.session.bagMaxTotalM()) : null;
      if (defaulted) this.moveTarget(defaulted);
    }
    this.camera = this.restingCamera();
  };
  MapFace.prototype.enter = function () { this.state.target = null; this.state.bubble = null; this.origin = null; this.playsMode = false; this.settle(); };
  MapFace.prototype.onFix = function () { this.settle(); };
  MapFace.prototype.onHole = function () { this.enter(); };
  MapFace.prototype.onEngineReady = function () { this.settle(); };

  MapFace.prototype.restingCamera = function () {
    var size = this.imageSize(), d = this.device;
    if (!size) return null;
    var player = this.imagePoint(this.state.player), target = this.imagePoint(this.currentTarget());
    if (player && target) {
      /* Framed in the aim area, not the glass: with the band up the shot is sized to the area
         and lifted to its middle; unlocked, the area is the glass and nothing moves. */
      var area = this.aimArea();
      var camera = Camera.shot(player, target, size.w, size.h, area.w, area.h);
      var lift = camera.imageDirection(0, d.height / 2 - (area.y + area.h / 2));
      camera.focusX = target.x + lift[0] / camera.scale; camera.focusY = target.y + lift[1] / camera.scale;
      return camera;
    }
    var hole = this.session.manifestHole(this.session.currentHole());
    var green = hole && hole.greenLat != null ? this.imagePoint({ lat: hole.greenLat, lng: hole.greenLng }) : null;
    return Camera.play(player, target || green, size.w, size.h, d.width, d.height);
  };

  // ---- the frame

  MapFace.prototype.onUpdate = function (ctx) {
    var d = this.device, w = d.width, h = d.height, session = this.session, self = this;
    ctx.setTransform(d.pixelScale, 0, 0, d.pixelScale, 0, 0);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
    var holeNumber = session.currentHole(), hole = session.manifestHole(holeNumber);
    if (!session.scene.hasRound() || !hole) { this.emptyState(ctx, "No hole map yet"); return; }
    var bitmap = session.bitmapFor(holeNumber);
    if (!bitmap) { this.emptyState(ctx, "Hole " + holeNumber + " map arriving"); return; }
    var size = this.imageSize();
    var camera = this.camera || this.restingCamera();
    var f = camera.frame(size.w, size.h, w, h);
    var place = function (p) { return camera.place(p, size.w, size.h, w, h); };
    var imagePoint = function (geo) { return self.imagePoint(geo); };
    this.trace = "map frame: hole " + holeNumber + " image " + size.w + "x" + size.h + " view " + w + "x" + h + "pt focus " + camera.focusX.toFixed(1) + "," + camera.focusY.toFixed(1)
      + " scale " + camera.scale.toFixed(3) + " rotation " + (camera.rotation * 180 / Math.PI).toFixed(1) + "deg";

    /* Past the bake's edge: the map's own dark green. The picture through the camera's affine. */
    ctx.fillStyle = EDGE_GREEN; ctx.fillRect(0, 0, w, h);
    ctx.save(); ctx.transform(f[0], f[1], -f[1], f[0], f[2], f[3]);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(bitmap, 0, 0, size.w, size.h);
    ctx.restore();

    drawTrees(ctx, hole.shapes ? hole.shapes.c : [], camera.scale, w, h, place, this.treeBitmap);
    var playerAt = this.state.player ? place(imagePoint(this.state.player)) : null;
    var target = this.currentTarget(), targetAt = target ? place(imagePoint(target)) : null;
    var bubble = this.state.bubble, ring = bubble ? bubble.ring : [];

    var layup = this.layupGuide();
    if (layup) {
      var line = layup.line.map(function (p) { return imagePoint(p); }).filter(Boolean).map(place);
      strokePath(ctx, line, false, "rgba(235,255,242,0.35)", 1.5, [1, 7], true);
      var from = place(imagePoint(layup.from)), to = place(imagePoint(layup.green));
      var dx = to.x - from.x, dy = to.y - from.y, length = Math.max(Math.hypot(dx, dy), 1), trim = Math.min(10, length * 0.05);
      strokePath(ctx, [{ x: from.x + dx / length * trim, y: from.y + dy / length * trim }, { x: to.x - dx / length * trim, y: to.y - dy / length * trim }], false, WHITE + "0.52)", 1.8, [2, 8], true);
      var at = MapFace.guideLabelPoint(from, to, w, h);
      ghostedText(ctx, "Green " + formatDistance(layup.gapM, session.yards()), at.x, at.y, font(10, "700"), WHITE + "0.9)", BLACK + "0.75)");
    }

    if (playerAt && targetAt) strokePath(ctx, [playerAt, targetAt], false, MINT + "0.75)", 1.5, [3, 3]);

    var wind = this.windNow();
    if (bubble && ring.length >= 3 && wind && wind.ghost) {
      var dLat = wind.ghost.lat - bubble.target.lat, dLng = wind.ghost.lng - bubble.target.lng;
      var shifted = ring.map(function (p) { return imagePoint({ lat: p.lat + dLat, lng: p.lng + dLng }); }).filter(Boolean).map(place);
      strokePath(ctx, shifted, true, WIND_BLUE, 1);
      var fromB = place(imagePoint(bubble.target)), toB = place(imagePoint(wind.ghost));
      MapFace.drawWindStreaks(ctx, toB.x - fromB.x, toB.y - fromB.y, fromB, w);
    }

    var plays = this.playsShot();
    var mainRing = plays ? plays.result.ring.map(function (p) { return { lat: p.lat + plays.shiftLat, lng: p.lng + plays.shiftLng }; }) : ring;
    var tint = plays ? PLAYS_ORANGE : MINT + "1)", tintFill = plays ? "rgba(255,170,0,0.22)" : MINT + "0.22)";
    if (mainRing.length >= 3) {
      var points = mainRing.map(function (p) { return imagePoint(p); }).filter(Boolean).map(place);
      fillPath(ctx, points, tintFill);
      strokePath(ctx, points, true, tint, 1.5);
    }
    if (bubble) {
      var centreAt = place(imagePoint(bubble.centre));
      this.drawLabel(ctx, plays ? plays.result.club.club : bubble.club.club, bubble.targetDistanceM, centreAt);
    }
    if (hole.greenLat != null) { var g = place(imagePoint({ lat: hole.greenLat, lng: hole.greenLng })); ellipse(ctx, g.x, g.y, 6, null, MINT + "0.9)", 1.8); }
    if (targetAt) ellipse(ctx, targetAt.x, targetAt.y, this.dragging ? 6 : 4, MINT + "1)", BLACK + "0.7)", 1);
    if (playerAt) ellipse(ctx, playerAt.x, playerAt.y, 4.5, "#fff", BLACK + "0.8)", 1);

    this.drawChrome(ctx);
  };

  MapFace.prototype.emptyState = function (ctx, message) {
    var w = this.device.width, h = this.device.height;
    text(ctx, "□", w / 2, h / 2 - 10, font(20, "400"), "rgba(235,235,245,0.6)");
    text(ctx, message, w / 2, h / 2 + 10, font(11, "400"), "rgba(235,235,245,0.6)");
    this.drawClock(ctx);
  };

  /* HoleMapPage's chrome: the readout capsule, the band while locked (UNLOCK, or Unlock | Reset
     once the Bubble has moved), the plays capsule, and the clock the system draws top-right. */
  MapFace.prototype.drawChrome = function (ctx) {
    var w = this.device.width, h = this.device.height, session = this.session, locked = session.locked();
    var holeNumber = session.currentHole(), green = session.greenDistances();
    var holeText = holeNumber != null ? "HOLE " + holeNumber : "HOLE", distText = green ? formatDistance(green.centre, session.yards()) : null;
    var f1 = font(11, "600"), f2 = font(11, "700");
    var tw = textWidth(ctx, holeText, f1) + (distText ? 5 + textWidth(ctx, distText, f2) : 0), ch = 17, cw = tw + 14;
    var capY = locked ? h - BOTTOM_EDGE - 4 - ch : h - 2 - ch;
    capsule(ctx, (w - cw) / 2, capY, cw, ch, BLACK + "0.55)");
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.font = f1; ctx.fillStyle = WHITE + "0.85)"; ctx.fillText(holeText, (w - tw) / 2, capY + ch / 2);
    if (distText) { ctx.font = f2; ctx.fillStyle = MINT + "1)"; ctx.fillText(distText, (w - tw) / 2 + textWidth(ctx, holeText, f1) + 5, capY + ch / 2); }

    if (locked) {
      var moved = this.moved();
      ctx.fillStyle = MINT + "0.5)"; ctx.fillRect(0, h - BOTTOM_EDGE, moved ? w / 2 : w, BOTTOM_EDGE);
      if (moved) { ctx.fillStyle = "rgba(255,159,10,0.5)"; ctx.fillRect(w / 2, h - BOTTOM_EDGE, w / 2, BOTTOM_EDGE); }
      var by = h - BOTTOM_EDGE / 2 - 3;
      ctx.shadowColor = BLACK + "0.5)"; ctx.shadowBlur = 2;
      if (moved) {
        text(ctx, "Unlock", w / 4, by, font(11, "800"), "#fff");
        text(ctx, "Reset", (3 * w) / 4, by, font(11, "800"), "#fff");
      } else {
        text(ctx, "🔓 UNLOCK", w / 2, by, font(12, "800"), "#fff");
      }
      ctx.shadowColor = "transparent"; ctx.shadowBlur = 0;
    }

    var playsText = this.playsLabel();
    if (playsText) {
      var r = this.playsRectNow();
      capsule(ctx, r.x, r.y, r.w, r.h, this.playsMode ? PLAYS_ORANGE : BLACK + "0.7)", PLAYS_ORANGE);
      text(ctx, playsText, r.x + r.w / 2, r.y + r.h / 2, font(12, "700"), this.playsMode ? "#000" : PLAYS_ORANGE);
      this.playsRect = r;
    } else this.playsRect = null;

    this.drawClock(ctx);
  };
  /* The system's clock, top right: not the app's, drawn so the glass reads as a watch. */
  MapFace.prototype.drawClock = function (ctx) {
    var now = new Date();
    var hh = now.getHours() % 12 || 12, mm = (now.getMinutes() < 10 ? "0" : "") + now.getMinutes();
    ctx.font = font(13, "600"); ctx.textAlign = "right"; ctx.textBaseline = "top"; ctx.fillStyle = "#fff";
    ctx.fillText(hh + ":" + mm, this.device.width - 16, 8);
  };

  MapFace.prototype.drawLabel = function (ctx, club, metres, at) {
    ghostedText(ctx, club, at.x, at.y - 12, font(12, "800"), "#fff", BLACK + "0.85)");
    ghostedText(ctx, formatDistance(metres, this.session.yards()), at.x, at.y + 11, font(10, "600"), WHITE + "0.92)", BLACK + "0.85)");
  };

  MapFace.guideLabelPoint = function (from, to, viewWidth, viewHeight) {
    var dx = to.x - from.x, dy = to.y - from.y, length = Math.max(Math.hypot(dx, dy), 1), reach = Math.min(length * 0.52, 58);
    var ux = dx / length, uy = dy / length;
    var rawX = from.x + ux * reach - uy * 12, rawY = from.y + uy * reach + ux * 12;
    return { x: Math.min(Math.max(rawX, 34), viewWidth - 34), y: Math.min(Math.max(rawY, TOP_BAND + 8), viewHeight - BOTTOM_EDGE - 30) };
  };

  MapFace.drawWindStreaks = function (ctx, dx, dy, centre, width) {
    var len = Math.hypot(dx, dy);
    if (len <= 0.5) return;
    var ux = dx / len, uy = dy / len, px = -uy, py = ux;
    var reach = width * 0.22, length = width * 0.17, gap = width * 0.06;
    var amp = length * 0.09, thin = width * 0.003, thick = width * 0.0085;
    var headLen = length * 0.26, headHalf = headLen * 0.42, steps = 10;
    for (var i = 0; i < 4; i++) {
      var side = (i - 1.5) * gap, back = reach + (i % 2 === 0 ? 0 : length * 0.35);
      var tip = { x: centre.x - ux * back + px * side, y: centre.y - uy * back + py * side };
      var bodyEnd = length - headLen * 0.55, left = [], right = [];
      for (var k = 0; k <= steps; k++) {
        var fr = k / steps, along = -length + bodyEnd * fr, wave = amp * Math.sin(fr * Math.PI * 2), half = thin + (thick - thin) * fr;
        var x = tip.x + ux * along + px * wave, y = tip.y + uy * along + py * wave;
        left.push({ x: x + px * half, y: y + py * half });
        right.unshift({ x: x - px * half, y: y - py * half });
      }
      fillPath(ctx, left.concat(right), WIND_BLUE);
      var hb = { x: tip.x - ux * headLen, y: tip.y - uy * headLen }, notch = { x: tip.x - ux * headLen * 0.72, y: tip.y - uy * headLen * 0.72 };
      fillPath(ctx, [tip, { x: hb.x + px * headHalf, y: hb.y + py * headHalf }, notch, { x: hb.x - px * headHalf, y: hb.y - py * headHalf }], WIND_BLUE);
    }
  };

  // ---- wind, plays, layup

  MapFace.prototype.windNow = function () {
    var b = this.state.bubble;
    return b ? this.session.windEffect(this.state.player, b.target, b.targetDistanceM) : null;
  };
  MapFace.prototype.playsM = function () {
    var b = this.state.bubble;
    return b ? this.session.playsLikeM(this.state.player, b.target, b.targetDistanceM, this.windNow()) : null;
  };
  MapFace.prototype.playsLabel = function () { var m = this.playsM(); return m != null ? "plays " + formatDistance(m, this.session.yards()) : null; };
  MapFace.prototype.playsShot = function () {
    var plays = this.playsM(), b = this.state.bubble, fix = this.state.player;
    if (!this.playsMode || plays == null || !b || !fix) return null;
    var along = Geo.project(fix, Geo.trueBearing(fix, b.target), plays);
    var result = this.session.calculate(fix, along);
    return result ? { result: result, shiftLat: b.target.lat - along.lat, shiftLng: b.target.lng - along.lng } : null;
  };
  MapFace.prototype.playsRectNow = function () {
    var w = this.device.width, h = this.device.height;
    var bottom = this.session.locked() ? h - BOTTOM_EDGE - READOUT : h - 24;
    return { x: (w - 92) / 2, y: bottom - 20 - 2, w: 92, h: 20 };
  };
  MapFace.prototype.togglePlays = function () { this.playsMode = !this.playsMode; };
  MapFace.prototype.hitPlays = function (x, y) {
    var r = this.playsRect;
    return !!r && x >= r.x - 10 && x <= r.x + r.w + 10 && y >= r.y - 8 && y <= r.y + r.h + 8;
  };

  MapFace.prototype.layupGuide = function () {
    var hole = this.session.manifestHole(this.session.currentHole()), maxM = this.session.bagMaxTotalM();
    var start = this.state.player, aim = this.currentTarget();
    if (!hole || !hole.skeleton || !(maxM > 0) || !start || !aim) return null;
    var centre = this.state.bubble ? this.state.bubble.centre : aim, green = hole.skeleton.g;
    var raw = Geo.distance(start, green), playable = Geo.distance(start, centre), gap = Geo.distance(centre, green);
    if (!(raw > maxM + 3 && gap > 4 && raw > playable + 4)) return null;
    var line = hole.skeleton.t ? [hole.skeleton.t].concat(hole.skeleton.r) : [];
    line.push(green);
    return { line: line, from: centre, green: green, gapM: gap };
  };

  // ---- interaction: a finger on the glass, the crown, the band

  MapFace.prototype.moved = function () {
    var now = this.state.target;
    return !!(this.origin && now && Geo.distance(this.origin, now) > 3);
  };
  MapFace.prototype.inBottomEdge = function (y) { return this.session.locked() && y >= this.device.height - BOTTOM_EDGE; };
  MapFace.prototype.inTopBand = function (y) { return y < TOP_BAND; };
  MapFace.prototype.aimArea = function () {
    var w = this.device.width, h = this.device.height;
    if (!this.session.locked()) return { x: 0, y: 0, w: w, h: h };
    return { x: 0, y: TOP_BAND, w: w, h: Math.max(h - TOP_BAND - BOTTOM_EDGE - READOUT, 1) };
  };
  MapFace.prototype.inAimArea = function (x, y) {
    var a = this.aimArea();
    return { x: Math.min(Math.max(x, a.x), a.x + a.w), y: Math.min(Math.max(y, a.y + 2), a.y + a.h - 2) };
  };
  MapFace.prototype.coordinateFromView = function (x, y) {
    var size = this.imageSize(), hole = this.session.manifestHole(this.session.currentHole());
    if (!size || !hole) return null;
    var camera = this.camera || this.restingCamera();
    var img = camera.imagePointFromView(x, y, size.w, size.h, this.device.width, this.device.height);
    return img ? hole.spatialReference.coordinate(img.x, img.y) : null;
  };

  /* A touch starts. A tap places the target under the finger and sends it; a press held 0.2 s
     picks the target up for a drag. Which it is, is known on release (tap) or when the hold
     matures (drag). */
  MapFace.prototype.pointerDown = function (x, y, now) {
    this.pressAt = now; this.pressDown = { x: x, y: y }; this.pressMoved = false;
    this.pressBand = this.inBottomEdge(y) || this.inTopBand(y);
  };
  MapFace.prototype.pointerMove = function (x, y, now) {
    if (!this.pressDown) return;
    var travelled = Math.hypot(x - this.pressDown.x, y - this.pressDown.y);
    if (!this.dragging) {
      if (travelled > HOLD_MAX_DISTANCE && now - this.pressAt < HOLD_MS) { this.pressMoved = true; return; }   // a swipe, not a press
      if (now - this.pressAt < HOLD_MS || this.pressBand || this.pressMoved) return;
      if (!this.camera) this.camera = this.restingCamera();
      this.dragging = true; this.aiming = true; this.dragActive = true;
    }
    this.fingerAt = { x: x, y: y }; this.panning = true;
    var held = this.inAimArea(x, y), c = this.coordinateFromView(held.x, held.y);
    if (c) this.moveTarget(c);
  };
  MapFace.prototype.pointerUp = function (x, y, now) {
    var down = this.pressDown; this.pressDown = null;
    if (this.dragging) {
      this.dragging = false; this.aiming = false; this.dragActive = false; this.fingerAt = null; this.edgeSince = null; this.panning = false;
      if (this.state.target) this.session.sendAim(this.state.target);
      /* The framing STAYS. */
      return;
    }
    if (!down || this.pressMoved) return;
    /* A tap. The plays button first, then the band, then the glass. */
    if (this.hitPlays(x, y)) { this.togglePlays(); return; }
    if (this.inBottomEdge(y)) { this.bandAction(x); return; }
    if (this.inTopBand(y)) return;
    var c = this.coordinateFromView(x, y);
    if (!c) return;
    if (!this.camera) this.camera = this.restingCamera();
    this.moveTarget(c);
    if (this.state.target) this.session.sendAim(this.state.target);
  };
  /* The edge pan: dwell, then creep at EDGE_PAN_SPEED pt/s, the target put back under the
     finger on every step. Driven by the page every PAN_TICK_MS while a drag is down. */
  MapFace.prototype.onPanTick = function (now) {
    if (!this.dragging || !this.fingerAt) { this.edgeSince = null; return false; }
    var a = this.aimArea(), dir = Camera.edgeDirection(this.fingerAt.x - a.x, this.fingerAt.y - a.y, a.w, a.h);
    if (dir[0] === 0 && dir[1] === 0) { this.edgeSince = null; return false; }
    if (this.edgeSince == null) { this.edgeSince = now; return false; }
    if (now - this.edgeSince < EDGE_DWELL_MS) return false;
    var size = this.imageSize(), step = EDGE_PAN_SPEED * (PAN_TICK_MS / 1000);
    this.camera = (this.camera || this.restingCamera()).panned(dir[0] * step, dir[1] * step, size.w, size.h);
    var held = this.inAimArea(this.fingerAt.x, this.fingerAt.y), c = this.coordinateFromView(held.x, held.y);
    if (c) this.moveTarget(c);
    return true;
  };
  /* The Digital Crown: .digitalCrownRotation from 0.5 through 3.0 by 0.05 - the scale itself. */
  MapFace.prototype.wheel = function (deltaY) {
    this.crownZoom = Math.min(3, Math.max(0.5, this.crownZoom - deltaY * 0.0025));
    var next = this.camera || this.restingCamera();
    if (!next) return;
    next.scale = Math.min(Math.max(this.crownZoom, 0.5), MAXIMUM_SCALE);
    this.camera = next;
  };
  MapFace.prototype.bandAction = function (x) {
    if (this.moved() && x > this.device.width / 2) this.resetAim();
    else this.session.unlock();
  };
  MapFace.prototype.resetAim = function () {
    if (!this.origin) return;
    this.moveTarget(this.origin);
    this.session.sendAim(this.origin);
    this.camera = this.restingCamera();
  };
  /* The phone locked the shot (or the wrist's LOCK was confirmed): the band comes up and this
     is where Reset goes back to. */
  /* A lock lands the player on this page (ContentView flips to the map; onAppear settles), and
     an unlock takes them back to the numbers, so the map is opened afresh either way: the
     framing is re-fitted to the aim area the band leaves, as settle() does on the wrist. */
  MapFace.prototype.lock = function () { this.origin = this.state.target; this.camera = this.restingCamera(); };
  MapFace.prototype.unlock = function () { this.origin = null; this.camera = this.restingCamera(); };

  return {
    DEVICES: DEVICES,
    PAN_TICK_MS: PAN_TICK_MS,
    TREE_NAMES: TREE_NAMES,
    TOP_BAND: TOP_BAND, BOTTOM_EDGE: BOTTOM_EDGE, READOUT: READOUT,
    PLAYER_HEIGHT_FRACTION: PLAYER_HEIGHT_FRACTION,
    Camera: Camera,
    unpackTree: unpackTree,
    MapFace: MapFace
  };
});
