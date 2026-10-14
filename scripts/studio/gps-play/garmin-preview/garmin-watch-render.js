/* The Garmin map face, drawn in a browser. STUDIO ONLY.

   A line-for-line port of what the watch draws - garmin/source/Maps/GarminMapView.mc with the
   pieces it leans on (GarminMapCamera, GarminMapSpatialReference, GarminTreeSprites,
   LayoutProfile, GarminSessionManager.mapPalette, GarminConditions.windEffect,
   GarminPlayState.clampedToBag, GarminBubbleEngine.defaultTarget) - so a hole can be looked
   at the way a wrist will show it before a .prg is built. The Monkey C is the source of truth:
   when it changes, this changes with it, the same way the .mc files follow the Swift.

   `Dc` below stands in for Toybox.Graphics.Dc over a canvas 2D context, with the same call
   names and the same integer habits (Monkey C truncates a Float with toNumber() and divides
   two Numbers to a Number), so the draw code reads like the watch's own. What cannot be
   copied is said so: the Garmin fonts are approximated from the screen size, and a canvas
   anti-aliases where a MIP panel cannot.

   No DOM beyond the canvas context it is handed, no fetch, no Leaflet. The page
   (garmin-preview-page.js) owns the data and the inputs and hands this a `session` shaped
   like GarminSessionManager - the same seam GarminMapView has on the watch. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("../watch-preview/watch-common.js"));
  else root.GDGarminWatchRender = factory(root.GDWatchCommon);
})(typeof window !== "undefined" ? window : globalThis, function (common) {
  "use strict";

  /* The maths both watches share (watch-common.js), under the names the Monkey C gives them. */
  var Geo = common.Geo, SpatialReference = common.SpatialReference, degToRad = common.degToRad;
  var formatDistance = common.formatDistance, windEffect = common.windEffect;
  var playsLikeM = common.playsLikeM, decodeShapes = common.decodeShapes;

  // ------------------------------------------------------------------ devices

  /* The screens this face is looked at on. Sizes are each product's display resolution;
     `amoled` picks the full-colour palette and the soft tree sprites (the watch asks
     requiresBurnInProtection for the same answer), `patternFill` is Dc.setFill (Connect IQ 4.0+),
     `scaledBitmap` is drawBitmap2 / drawScaledBitmap (3.2+; the Approach S62 has neither and
     draws a picture 1:1). The higher-end AMOLED watches come first; the MIP watches are kept so
     the 64-colour palette and its pattern fills can be checked beside them. */
  var DEVICES = [
    { id: "fenix847mm", name: "fenix 8 47 mm", width: 454, height: 454, shape: "round", amoled: true, touch: true, patternFill: true, scaledBitmap: true },
    { id: "fenix851mm", name: "fenix 8 51 mm", width: 454, height: 454, shape: "round", amoled: true, touch: true, patternFill: true, scaledBitmap: true },
    { id: "fenix843mm", name: "fenix 8 43 mm", width: 416, height: 416, shape: "round", amoled: true, touch: true, patternFill: true, scaledBitmap: true },
    { id: "epix2pro47mm", name: "epix Pro (Gen 2) 47 mm", width: 454, height: 454, shape: "round", amoled: true, touch: true, patternFill: true, scaledBitmap: true },
    { id: "epix2pro51mm", name: "epix Pro (Gen 2) 51 mm", width: 454, height: 454, shape: "round", amoled: true, touch: true, patternFill: true, scaledBitmap: true },
    { id: "epix2pro42mm", name: "epix Pro (Gen 2) 42 mm", width: 416, height: 416, shape: "round", amoled: true, touch: true, patternFill: true, scaledBitmap: true },
    { id: "approachs7047mm", name: "Approach S70 47 mm", width: 454, height: 454, shape: "round", amoled: true, touch: true, patternFill: true, scaledBitmap: true },
    { id: "approachs7042mm", name: "Approach S70 42 mm", width: 390, height: 390, shape: "round", amoled: true, touch: true, patternFill: true, scaledBitmap: true },
    { id: "fr965", name: "Forerunner 965", width: 454, height: 454, shape: "round", amoled: true, touch: true, patternFill: true, scaledBitmap: true },
    { id: "fr970", name: "Forerunner 970", width: 454, height: 454, shape: "round", amoled: true, touch: true, patternFill: true, scaledBitmap: true },
    { id: "venu3", name: "Venu 3", width: 454, height: 454, shape: "round", amoled: true, touch: true, patternFill: true, scaledBitmap: true },
    { id: "venu3s", name: "Venu 3S", width: 390, height: 390, shape: "round", amoled: true, touch: true, patternFill: true, scaledBitmap: true },
    { id: "fr265", name: "Forerunner 265", width: 416, height: 416, shape: "round", amoled: true, touch: true, patternFill: true, scaledBitmap: true },
    { id: "venusq2", name: "Venu Sq 2 (rectangular)", width: 320, height: 360, shape: "rectangle", amoled: true, touch: true, patternFill: true, scaledBitmap: true },
    { id: "fenix7", name: "fenix 7 (MIP, 64 colours)", width: 260, height: 260, shape: "round", amoled: false, touch: true, patternFill: true, scaledBitmap: true },
    { id: "fenix7x", name: "fenix 7X (MIP, 64 colours)", width: 280, height: 280, shape: "round", amoled: false, touch: true, patternFill: true, scaledBitmap: true },
    { id: "fr255", name: "Forerunner 255 (MIP, buttons)", width: 260, height: 260, shape: "round", amoled: false, touch: false, patternFill: true, scaledBitmap: true },
    { id: "approachs62", name: "Approach S62 (MIP, CIQ 3.0, 1:1 picture)", width: 260, height: 260, shape: "round", amoled: false, touch: true, patternFill: false, scaledBitmap: false }
  ];

  /* Garmin's fonts are the one thing a browser cannot copy: FONT_XTINY/SMALL/MEDIUM are device
     bitmaps whose heights the SDK's device profiles hold. These are read off the simulator at
     454 px (22 / 30 / 38 px line heights) and scaled by screen height, which lands within a
     pixel or two on the 260 and 416 px faces. The label clamps and chrome layout use these
     heights exactly as the watch uses dc.getFontHeight. */
  function fontsFor(device) {
    var h = device.height;
    var make = function (fraction) { var px = Math.round(h * fraction); return { px: px, css: "600 " + Math.round(px * 0.78) + "px 'Roboto Condensed','Helvetica Neue',Arial,sans-serif" }; };
    return { xtiny: make(22 / 454), small: make(30 / 454), medium: make(38 / 454) };
  }

  // ------------------------------------------------------------------ constants

  var COLOR_GREEN = 0x00FF00, COLOR_WHITE = 0xFFFFFF, COLOR_BLACK = 0x000000, COLOR_LT_GRAY = 0xAAAAAA;
  var MAP_EDGE_GREEN = 0x294A30, BUBBLE_MINT = 0x3EE6C4, RING_KEYLINE = 0x0E2A1E;
  var WIND_BLUE = 0x55AAFF, SLOPE_ORANGE = 0xFFAA00, PLAYS_MAIN = -2;
  var TEXT_LEFT = "left", TEXT_CENTER = "center", TEXT_RIGHT = "right";
  var MAXIMUM_SCALE = 3.0, BUBBLE_FRACTION = 0.6, NOMINAL_BUBBLE_M = 55.0;
  var EDGE_INSET_FRACTION = 0.09, EDGE_DWELL_MS = 400, PAN_TICK_MS = 100, PAN_PX_PER_TICK = 5;
  var NUDGE_STEP_IMAGE_PX = 10.0;
  var TREE_SIZES = [8, 12, 16, 22, 28];
  var TREE_TYPES = ["round", "broadleaf", "pine", "yellow_green"];

  /* GarminSessionManager.MIP_PALETTE / BASE_PALETTE, verbatim. A pattern is
     [base, mix, n, fallback]: a 2x2 tile with n of its pixels in `mix`. */
  var MIP_PALETTE = {
    r: 0x005500, rd: [0x005500, 0x000000, 2, null], rl: [0x005500, 0x55AA55, 2, null],
    f: 0x55AA55, fd: [0x55AA55, 0x005500, 1, 0x00AA55], fl: [0x55AA55, 0xAAFFAA, 2, null],
    g: 0xAAFFAA, gd: [0xAAFFAA, 0x55AA55, 1, 0x55FF55], gl: 0xAAFFAA,
    b: 0xFFFFAA, w: 0x0055AA,
    k: [0x005500, 0x000000, 3, 0x000000], h: 0x555500, z: [0xAAAA55, 0xAAAAAA, 2, 0xAAAA55]
  };
  var BASE_PALETTE = {
    r: 0x315833, rd: 0x274629, rl: 0x3C6B3E,
    f: 0x4E9A52, fd: 0x3E7B42, fl: 0x5FBC64,
    g: 0x8BD28D, gd: 0x6FA871, gl: 0xAAFFAC,
    b: 0xE9DAAE, w: 0x2D69A2,
    k: 0x18361A, h: 0x756533, z: 0xB8B09D
  };

  /* watch-map-delivery.js cleanPalette: the package's hex colours as the 0xRRGGBB integers the
     watch is sent, with the turf variants (x0.8 / x1.22) - the `pal` the skeleton carries. */
  var PALETTE_ROLES = { background: "r", fairway: "f", green: "g", bunker: "b", water: "w", trees: "k", hazard: "h", waste: "z" };
  function scaleColour(rgb, k) {
    var channel = function (shift) { return Math.max(0, Math.min(255, Math.round(((rgb >> shift) & 255) * k))); };
    return (channel(16) << 16) | (channel(8) << 8) | channel(0);
  }
  function cleanPalette(colors) {
    if (!colors) return null;
    var out = {}, any = false;
    Object.keys(PALETTE_ROLES).forEach(function (role) {
      var m = /^#([0-9a-f]{6})$/i.exec(String(colors[role] || ""));
      if (m) { out[PALETTE_ROLES[role]] = parseInt(m[1], 16); any = true; }
    });
    ["r", "f", "g"].forEach(function (key) {
      if (out[key] == null) return;
      out[key + "d"] = scaleColour(out[key], 0.8);
      out[key + "l"] = scaleColour(out[key], 1.22);
    });
    return any ? out : null;
  }

  /* GarminSessionManager.mapPalette: MIP screens get the 64-colour picks; AMOLED the base
     palette with the package's own colours laid over it. */
  function mapPalette(amoled, skeletonPal) {
    if (!amoled) return MIP_PALETTE;
    var out = {};
    Object.keys(BASE_PALETTE).forEach(function (k) { out[k] = BASE_PALETTE[k]; });
    if (skeletonPal) Object.keys(skeletonPal).forEach(function (k) { if (typeof skeletonPal[k] === "number" && out.hasOwnProperty(k)) out[k] = skeletonPal[k]; });
    return out;
  }

  // ------------------------------------------------------------------ Monkey C habits

  function toNumber(v) { return Math.trunc(v); }          // Float.toNumber()
  function idiv(a, b) { return Math.trunc(a / b); }         // Number / Number
  function hex(c) { return "#" + ("000000" + (c & 0xFFFFFF).toString(16)).slice(-6); }

  // ------------------------------------------------------------------ GarminMapCamera

  /* Two framings, as the watch's. SHOT: the Bubble fitted to the glass with the target in the
     middle, the map turned so the shot runs straight up - the aim line comes up from the bottom
     edge and never runs across the watch; the player is on the glass for a chip and off the
     bottom for a drive. PLAY, for a hole with no target yet: the player low, the bake's own way
     up. Every point is placed through one affine, frame(): [tx, ty, a, b] with
     sx = tx + x*a - y*b, sy = ty + x*b + y*a. */
  function Camera(focusX, focusY, scale) { this.focusX = focusX; this.focusY = focusY; this.scale = scale; this.rotation = 0.0; this.clampsToImage = true; }
  /* bubbleExtent: the Bubble's longest reach across the target, image px (Camera.bubbleExtent). */
  Camera.shot = function (player, target, bubbleExtent, imageWidth, imageHeight, viewWidth, viewHeight) {
    var camera = new Camera(target.x, target.y, MAXIMUM_SCALE);
    camera.clampsToImage = false;
    var shorterView = Math.min(viewWidth, viewHeight);
    if (bubbleExtent != null && bubbleExtent > 0 && shorterView > 0) camera.scale = Math.min(MAXIMUM_SCALE, (shorterView * BUBBLE_FRACTION) / bubbleExtent);
    var dx = target.x - player.x, dy = target.y - player.y;
    if (dx * dx + dy * dy >= 1.0) camera.rotation = -Math.PI / 2.0 - Math.atan2(dy, dx);
    return camera;
  };
  /* Twice the farthest ring point from the target, so a ring sat off to one side of the target
     is still whole whichever way the map is turned; a target with no ring yet gets a Driver's
     worth of ground through the map's metresPerPixel. */
  Camera.bubbleExtent = function (ring, target, reference) {
    var farthest = 0.0;
    (ring || []).forEach(function (geo) {
      var p = reference.imagePoint(geo.lat, geo.lng);
      if (p != null) farthest = Math.max(farthest, Math.hypot(p.x - target.x, p.y - target.y));
    });
    if (farthest > 0.0) return 2.0 * farthest;
    return NOMINAL_BUBBLE_M / (reference.metresPerPixel != null ? reference.metresPerPixel : 0.5);
  };
  Camera.play = function (player, target, imageWidth, imageHeight, viewWidth, viewHeight) {
    if (imageWidth <= 0 || imageHeight <= 0 || viewWidth <= 0 || viewHeight <= 0) return new Camera(imageWidth / 2.0, imageHeight / 2.0, 1.0);
    var fillWidth = viewWidth / imageWidth, centreX = imageWidth / 2.0, centreY = imageHeight / 2.0;
    if (player == null) {
      var focusY = target != null ? target.y : centreY;
      return new Camera(centreX, focusY, Math.min(fillWidth, MAXIMUM_SCALE));
    }
    if (target == null) return Camera.low(player, centreX, Math.min(fillWidth, MAXIMUM_SCALE), viewHeight);
    var spanFraction = 0.72, span = Math.abs(target.y - player.y);
    var spanScale = span > 0 ? (viewHeight * spanFraction) / span : MAXIMUM_SCALE;
    var scale = Math.min(MAXIMUM_SCALE, Math.max(spanScale, fillWidth));
    if (span * scale <= viewHeight * spanFraction) return new Camera(centreX, (player.y + target.y) / 2.0, scale);
    return Camera.low(player, centreX, scale, viewHeight);
  };
  Camera.low = function (player, centreX, scale, viewHeight) {
    var playerHeightFraction = 0.78, visibleImageHeight = viewHeight / scale;
    return new Camera(centreX, player.y - (playerHeightFraction - 0.5) * visibleImageHeight, scale);
  };
  Camera.axisOrigin = function (scaledLength, viewLength, focus) {
    if (scaledLength <= viewLength) return (viewLength - scaledLength) / 2.0;
    var a = 0.0, b = viewLength - scaledLength, c = viewLength / 2.0 - focus;
    var centred = c < a ? c : a;
    return centred > b ? centred : b;
  };
  Camera.prototype.originX = function (imageWidth, viewWidth) {
    if (!this.clampsToImage) return viewWidth / 2.0 - this.focusX * this.scale;
    return Camera.axisOrigin(imageWidth * this.scale, viewWidth, this.focusX * this.scale);
  };
  Camera.prototype.originY = function (imageHeight, viewHeight) {
    if (!this.clampsToImage) return viewHeight / 2.0 - this.focusY * this.scale;
    return Camera.axisOrigin(imageHeight * this.scale, viewHeight, this.focusY * this.scale);
  };
  Camera.prototype.frame = function (imageWidth, imageHeight, viewWidth, viewHeight) {
    if (this.rotation === 0.0) return [this.originX(imageWidth, viewWidth), this.originY(imageHeight, viewHeight), this.scale, 0.0];
    var a = Math.cos(this.rotation) * this.scale, b = Math.sin(this.rotation) * this.scale;
    return [viewWidth / 2.0 - (this.focusX * a - this.focusY * b), viewHeight / 2.0 - (this.focusX * b + this.focusY * a), a, b];
  };
  Camera.prototype.place = function (imageX, imageY, imageWidth, imageHeight, viewWidth, viewHeight) {
    var f = this.frame(imageWidth, imageHeight, viewWidth, viewHeight);
    return [f[0] + imageX * f[2] - imageY * f[3], f[1] + imageX * f[3] + imageY * f[2]];
  };
  Camera.prototype.imagePointFromView = function (viewX, viewY, imageWidth, imageHeight, viewWidth, viewHeight) {
    if (this.scale <= 0) return null;
    var f = this.frame(imageWidth, imageHeight, viewWidth, viewHeight);
    var sx = viewX - f[0], sy = viewY - f[1], det = f[2] * f[2] + f[3] * f[3];
    return { x: (f[2] * sx + f[3] * sy) / det, y: (f[2] * sy - f[3] * sx) / det };
  };
  Camera.prototype.imageDirection = function (screenDx, screenDy) {
    var c = Math.cos(this.rotation), s = Math.sin(this.rotation);
    return [screenDx * c + screenDy * s, screenDy * c - screenDx * s];
  };

  // ------------------------------------------------------------------ LayoutProfile

  var Layout = {
    chordHalfWidthPx: function (shape, top, bottom, viewWidth, viewHeight) {
      if (shape === "rectangle") return viewWidth / 2.0;
      var rx = viewWidth / 2.0, ry = viewHeight / 2.0;
      var dy = Math.max(Math.abs(ry - top), Math.abs(bottom - ry));
      if (dy >= ry) return 0.0;
      return rx * Math.sqrt(1.0 - (dy * dy) / (ry * ry));
    },
    chromeTopY: function (viewHeight) { return toNumber(viewHeight * 0.07); }
  };

  // ------------------------------------------------------------------ Dc: Toybox.Graphics.Dc over a canvas

  function Dc(ctx, width, height, fonts, patternFill) {
    this.ctx = ctx; this.width = width; this.height = height; this.fonts = fonts; this.hasSetFill = !!patternFill;
    this.fg = COLOR_WHITE; this.bg = COLOR_BLACK; this.fill = null; this.pen = 1;
  }
  Dc.prototype.getWidth = function () { return this.width; };
  Dc.prototype.getHeight = function () { return this.height; };
  Dc.prototype.setColor = function (fg, bg) { this.fg = fg; if (bg !== -1) this.bg = bg; this.fill = null; };
  Dc.prototype.setFill = function (fill) { this.fill = fill; };
  Dc.prototype.setPenWidth = function (w) { this.pen = w; };
  Dc.prototype.setAntiAlias = function () {};
  Dc.prototype.fillStyle = function () { return this.fill != null ? (typeof this.fill === "number" ? hex(this.fill) : this.fill) : hex(this.fg); };
  Dc.prototype.clear = function () { this.ctx.fillStyle = hex(this.bg); this.ctx.fillRect(0, 0, this.width, this.height); };
  Dc.prototype.fillPolygon = function (points) {
    if (points.length < 3) return;
    var c = this.ctx; c.beginPath(); c.moveTo(points[0][0], points[0][1]);
    for (var i = 1; i < points.length; i++) c.lineTo(points[i][0], points[i][1]);
    c.closePath(); c.fillStyle = this.fillStyle(); c.fill();
  };
  Dc.prototype.drawLine = function (x1, y1, x2, y2) {
    var c = this.ctx; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.lineWidth = this.pen; c.strokeStyle = hex(this.fg); c.lineCap = "butt"; c.stroke();
  };
  Dc.prototype.drawCircle = function (x, y, r) { var c = this.ctx; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.lineWidth = this.pen; c.strokeStyle = hex(this.fg); c.stroke(); };
  Dc.prototype.fillCircle = function (x, y, r) { var c = this.ctx; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = hex(this.fg); c.fill(); };
  Dc.prototype.drawPoint = function (x, y) { this.ctx.fillStyle = hex(this.fg); this.ctx.fillRect(x, y, 1, 1); };
  Dc.prototype.roundedRect = function (x, y, w, h, r) {
    var c = this.ctx; r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  };
  Dc.prototype.fillRoundedRectangle = function (x, y, w, h, r) { this.roundedRect(x, y, w, h, r); this.ctx.fillStyle = hex(this.fg); this.ctx.fill(); };
  Dc.prototype.drawRoundedRectangle = function (x, y, w, h, r) { this.roundedRect(x, y, w, h, r); this.ctx.lineWidth = this.pen; this.ctx.strokeStyle = hex(this.fg); this.ctx.stroke(); };
  Dc.prototype.getFontHeight = function (font) { return font.px; };
  Dc.prototype.getTextWidthInPixels = function (text, font) { this.ctx.font = font.css; return Math.ceil(this.ctx.measureText(String(text)).width); };
  Dc.prototype.getTextDimensions = function (text, font) { return [this.getTextWidthInPixels(text, font), font.px]; };
  Dc.prototype.drawText = function (x, y, font, text, justify) {
    var c = this.ctx; c.font = font.css; c.textAlign = justify; c.textBaseline = "middle"; c.fillStyle = hex(this.fg);
    c.fillText(String(text), x, y + font.px / 2);
  };
  Dc.prototype.drawBitmap = function (x, y, image) { if (image) this.ctx.drawImage(image, x, y); };
  /* drawBitmap2 with a crop and a transform, as GarminMapView.drawBitmapCropped uses it: the
     crop's origin lands at (x, y), turned by `rotation` and scaled by `scale`. */
  Dc.prototype.drawBitmapTransformed = function (image, sx, sy, sw, sh, x, y, scale, rotation) {
    var c = this.ctx;
    c.save();
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "medium";
    c.translate(x, y); c.rotate(rotation); c.scale(scale, scale);
    c.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    c.restore();
  };

  // ------------------------------------------------------------------ GarminTreeSprites

  /* Sprite bitmaps come from the page (an Image per [set][type][size], loaded from
     garmin/resources-trees/drawables/trees/). `bitmap(amoled, type, sizeIndex)` returns an Image
     or null while it is still loading - the watch never has that case; here a tree is simply
     drawn on the next frame. */
  function TreeSprites(bitmap) { this.bitmap = bitmap; }
  TreeSprites.prototype.draw = function (dc, trees, f, sc, viewWidth, viewHeight, amoled) {
    var sizes = TREE_SIZES, margin = sizes[sizes.length - 1];
    for (var i = 0; i < trees.length; i++) {
      var v = trees[i];
      var x = v % 2048, y = Math.floor(v / 2048) % 2048;
      var cx = f[0] + x * f[2] - y * f[3];
      var cy = f[1] + x * f[3] + y * f[2];
      if (cx < -margin || cy < -margin || cx > viewWidth + margin || cy > viewHeight + margin) continue;
      var s = this.sizeIndex(2.0 * (Math.floor(v / 4194304) % 128) * sc);
      var half = idiv(sizes[s], 2);
      dc.drawBitmap(toNumber(cx - half), toNumber(cy - half), this.bitmap(amoled, Math.floor(v / 536870912) % 4, s));
    }
  };
  TreeSprites.prototype.sizeIndex = function (diameter) {
    var best = 0;
    for (var i = 1; i < TREE_SIZES.length; i++) if (Math.abs(TREE_SIZES[i] - diameter) < Math.abs(TREE_SIZES[best] - diameter)) best = i;
    return best;
  };

  // ------------------------------------------------------------------ GarminMapView

  /* `session` is the GarminSessionManager seam, in the page's hands:
       scene: { hasRound(), shotLocked(), suggestedClub(), courseKey() } or null
       currentHole() -> Number | null
       manifestHole(n) -> { spatialReference: SpatialReference, greenLat, greenLng } | null
       packageVersion() -> any (a change reframes)
       bitmapFor(n) -> Image | null            the picture, when the package has one and it is wanted
       outlinesFor(n) -> decodeShapes(...) | null
       mapPalette() -> palette dictionary
       playerPoint() -> {lat,lng} | null
       localBubble() -> { target, targetDistanceM, club:{club,carryM,totalM}, centre, ring:[{lat,lng}...] } | null
       aimTarget() -> {lat,lng} | null         the Scene's target (the phone's)
       greenDistances() -> { front, centre, back } | null
       holeLine() -> [{lat,lng}...]
       bagMaxTotalM() -> Number | null
       windEffect(player, target, flatM) -> windEffect(...) | null
       playsLikeM(player, target, flatM, effect) -> Number | null
       playsBubble(local, playsM) -> { bubble, shiftLat, shiftLng } | null
       playState: { target, bubble, moveTarget(coordinate) -> bubble | null, clear() }
       canCompute() -> Boolean                  engine agreement + a player snapshot + a fix
       sendAim(target)                          AIM_AT, once
       yards() -> Boolean
     device: an entry of DEVICES. */
  function MapFace(session, device, treeBitmap) {
    this.session = session;
    this.device = device;
    this.fonts = fontsFor(device);
    this.treeSprites = new TreeSprites(treeBitmap);
    this.framedHoleNumber = null; this.framedLocked = false; this.framedPicture = true; this.framedPackageVersion = null;
    this.camera = null;
    this.aiming = false; this.dragActive = false;
    this.fingerX = null; this.fingerY = null; this.edgeSince = null; this.panning = false;
    this.lastReference = null; this.lastImageWidth = null; this.lastImageHeight = null; this.lastViewWidth = null; this.lastViewHeight = null;
    this.playsMode = false; this.playsClub = null; this.playsBox = null;
    this.textures = {};
    this.trace = null;   // the simulator's "map frame:" line, for the page's readout
  }

  MapFace.prototype.onUpdate = function (ctx) {
    var device = this.device, session = this.session;
    var dc = new Dc(ctx, device.width, device.height, this.fonts, device.patternFill);
    dc.setColor(COLOR_WHITE, COLOR_BLACK);
    dc.clear();

    var scene = session.scene;
    if (scene == null || !scene.hasRound()) { this.drawCentredText(dc, "No round", idiv(dc.getHeight(), 2), this.fonts.medium); return; }

    var holeNumber = session.currentHole();
    var hole = holeNumber != null ? session.manifestHole(holeNumber) : null;
    if (hole == null || !hole.spatialReference.isUsable()) { this.drawUnavailable(dc, "Map not available"); return; }

    var bitmap = session.bitmapFor(holeNumber);
    var shapes = bitmap == null ? session.outlinesFor(holeNumber) : null;
    if (bitmap == null && shapes == null) { this.drawUnavailable(dc, "Loading map..."); return; }
    var drawn = bitmap != null;

    var reference = hole.spatialReference;
    var imageWidth = reference.imageWidth, imageHeight = reference.imageHeight;
    var viewWidth = dc.getWidth(), viewHeight = dc.getHeight();

    var playerGeo = session.playerPoint();
    var greenGeo = hole.greenLat != null ? { lat: hole.greenLat, lng: hole.greenLng } : null;
    var local = session.localBubble();
    var targetGeo = local != null ? local.target : session.aimTarget();

    var playerImg = this.imagePoint(playerGeo, reference), greenImg = this.imagePoint(greenGeo, reference), targetImg = this.imagePoint(targetGeo, reference);

    var packageVersion = session.packageVersion();
    var lockedNow = scene.shotLocked();
    if (this.framedHoleNumber !== holeNumber || this.camera == null || this.framedPackageVersion !== packageVersion || this.framedLocked !== lockedNow || this.framedPicture !== drawn) {
      this.framedLocked = lockedNow; this.framedPicture = drawn; this.framedPackageVersion = packageVersion;
      this.camera = this.restingCamera(local, playerImg, targetImg, greenImg, reference, imageWidth, imageHeight, viewWidth, viewHeight);
      /* The S62 can neither scale nor turn a picture; a drawn map turns everywhere. */
      if (drawn && !device.scaledBitmap) { this.camera.scale = 1.0; this.camera.rotation = 0.0; }
      if (drawn && this.camera.rotation === 0.0 && this.camera.scale > 0.9 && this.camera.scale < 1.1) this.camera.scale = 1.0;
      this.framedHoleNumber = holeNumber;
    }
    var camera = this.camera;
    this.trace = "map frame: hole " + holeNumber + " image " + imageWidth + "x" + imageHeight + " view " + viewWidth + "x" + viewHeight
      + " focus " + camera.focusX.toFixed(1) + "," + camera.focusY.toFixed(1) + " scale " + camera.scale.toFixed(3)
      + " rotation " + (camera.rotation * 180 / Math.PI).toFixed(1) + "deg"
      + (drawn ? " picture" : " drawn outlines");

    this.lastReference = reference; this.lastImageWidth = imageWidth; this.lastImageHeight = imageHeight; this.lastViewWidth = viewWidth; this.lastViewHeight = viewHeight;

    if (drawn) {
      dc.setColor(MAP_EDGE_GREEN, MAP_EDGE_GREEN);
      dc.clear();
      this.drawBitmapCropped(dc, bitmap, camera, imageWidth, imageHeight, viewWidth, viewHeight);
    } else {
      this.drawOutlines(dc, shapes, session.mapPalette(), imageWidth, imageHeight, viewWidth, viewHeight);
    }
    this.drawTrees(dc, shapes != null ? shapes : session.outlinesFor(holeNumber), imageWidth, imageHeight, viewWidth, viewHeight);

    this.drawLayupGuide(dc, local, playerGeo, targetGeo, greenGeo);

    var aimImg = targetImg != null ? targetImg : greenImg;
    if (playerImg != null && aimImg != null) {
      var pOn = camera.place(playerImg.x, playerImg.y, imageWidth, imageHeight, viewWidth, viewHeight);
      var aOn = camera.place(aimImg.x, aimImg.y, imageWidth, imageHeight, viewWidth, viewHeight);
      this.drawDashedLine(dc, pOn[0], pOn[1], aOn[0], aOn[1]);
    }

    if (local != null && local.ring != null && local.ring.length >= 3) {
      var target = local.target;
      var effect = session.windEffect(playerGeo, target, local.targetDistanceM);
      var windGhost = effect != null ? effect.ghost : null;
      if (windGhost != null) {
        this.drawRing(dc, local.ring, camera, reference, imageWidth, imageHeight, viewWidth, [viewHeight, windGhost.lat - target.lat, windGhost.lng - target.lng, WIND_BLUE]);
        var fromImg = this.imagePoint(target, reference), toImg = this.imagePoint(windGhost, reference);
        if (fromImg != null && toImg != null) {
          var fromOn = camera.place(fromImg.x, fromImg.y, imageWidth, imageHeight, viewWidth, viewHeight);
          var toOn = camera.place(toImg.x, toImg.y, imageWidth, imageHeight, viewWidth, viewHeight);
          this.drawWindStreaks(dc, toOn[0] - fromOn[0], toOn[1] - fromOn[1], fromOn[0], fromOn[1], viewWidth);
        }
      }
      var plays = this.playsMode ? this.playsNumber(playerGeo, local) : null;
      var playsShot = plays != null ? session.playsBubble(local, plays) : null;
      if (playsShot != null && playsShot.bubble.ring != null && playsShot.bubble.ring.length >= 3) {
        this.drawRing(dc, playsShot.bubble.ring, camera, reference, imageWidth, imageHeight, viewWidth, [viewHeight, playsShot.shiftLat, playsShot.shiftLng, PLAYS_MAIN]);
        this.playsClub = playsShot.bubble.club.club;
      } else {
        this.drawRing(dc, local.ring, camera, reference, imageWidth, imageHeight, viewWidth, viewHeight);
        this.playsClub = null;
      }
      this.drawPlaysLike(dc, playerGeo, local, viewWidth, viewHeight);
    } else {
      this.playsBox = null;
    }

    if (greenImg != null) { var gOn = camera.place(greenImg.x, greenImg.y, imageWidth, imageHeight, viewWidth, viewHeight); this.drawRingMarker(dc, gOn[0], gOn[1], 6, COLOR_GREEN); }

    if (targetImg != null) {
      var tOn = camera.place(targetImg.x, targetImg.y, imageWidth, imageHeight, viewWidth, viewHeight);
      var tx = tOn[0], ty = tOn[1];
      this.drawDot(dc, tx, ty, this.dragActive ? 6 : 4, COLOR_GREEN);
      var club = this.playsClub != null ? this.playsClub : (local != null ? local.club.club : scene.suggestedClub());
      if (club != null) this.drawLabel(dc, club, tx, ty - 14);
    }

    if (playerImg != null) { var plOn = camera.place(playerImg.x, playerImg.y, imageWidth, imageHeight, viewWidth, viewHeight); this.drawDot(dc, plOn[0], plOn[1], 4, COLOR_WHITE); }

    this.drawChrome(dc, viewWidth, viewHeight);
  };

  /* The shot in hand framed Bubble-to-the-glass, target in the middle, shot straight up; a hole
     with no shot to frame yet is shown PLAY-wise in the bake's own orientation. */
  MapFace.prototype.restingCamera = function (local, playerImg, targetImg, greenImg, reference, imageWidth, imageHeight, viewWidth, viewHeight) {
    if (playerImg != null && targetImg != null) {
      return Camera.shot(playerImg, targetImg, Camera.bubbleExtent(local != null ? local.ring : null, targetImg, reference), imageWidth, imageHeight, viewWidth, viewHeight);
    }
    return Camera.play(playerImg, targetImg != null ? targetImg : greenImg, imageWidth, imageHeight, viewWidth, viewHeight);
  };

  MapFace.prototype.imagePoint = function (geo, reference) { return geo == null ? null : reference.imagePoint(geo.lat, geo.lng); };

  // ------------------------------------------------------------------ draw

  /* The picture, as drawBitmap2 draws it on the watch: the view's corners taken back into the
     bake give the crop, which lands at its own screen point turned and scaled. The S62 (no
     transform) has had its camera pinned to 1:1 unturned in onUpdate. */
  MapFace.prototype.drawBitmapCropped = function (dc, bitmap, camera, imageWidth, imageHeight, viewWidth, viewHeight) {
    if (!this.device.scaledBitmap) { dc.drawBitmap(camera.originX(imageWidth, viewWidth), camera.originY(imageHeight, viewHeight), bitmap); return; }
    var bw = bitmap.naturalWidth || bitmap.width, bh = bitmap.naturalHeight || bitmap.height;
    var minX = bw, minY = bh, maxX = 0, maxY = 0;
    [[0, 0], [viewWidth, 0], [0, viewHeight], [viewWidth, viewHeight]].forEach(function (corner) {
      var c = camera.imagePointFromView(corner[0], corner[1], imageWidth, imageHeight, viewWidth, viewHeight);
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
    });
    var sx = Math.max(0, toNumber(minX) - 1), sy = Math.max(0, toNumber(minY) - 1);
    var sw = Math.min(bw - sx, toNumber(maxX) + 2 - sx), sh = Math.min(bh - sy, toNumber(maxY) + 2 - sy);
    if (sw <= 0 || sh <= 0) return;
    var at = camera.place(sx, sy, imageWidth, imageHeight, viewWidth, viewHeight);
    dc.drawBitmapTransformed(bitmap, sx, sy, sw, sh, at[0], at[1], camera.scale, camera.rotation);
  };

  MapFace.prototype.drawLayupGuide = function (dc, local, playerGeo, targetGeo, greenGeo) {
    var reference = this.lastReference, imageWidth = this.lastImageWidth, imageHeight = this.lastImageHeight, viewWidth = this.lastViewWidth, viewHeight = this.lastViewHeight;
    var camera = this.camera, session = this.session;
    if (playerGeo == null || greenGeo == null || targetGeo == null) return;
    var maxM = session.bagMaxTotalM();
    if (maxM == null || maxM <= 0) return;
    var centre = local != null && local.centre != null ? local.centre : targetGeo;
    var raw = Geo.distance(playerGeo, greenGeo), playable = Geo.distance(playerGeo, centre), gap = Geo.distance(centre, greenGeo);
    if (!(raw > maxM + 3 && gap > 4 && raw > playable + 4)) return;

    var line = session.holeLine();
    dc.setColor(COLOR_LT_GRAY, -1);
    var havePrev = false, px = 0.0, py = 0.0;
    for (var i = 0; i < line.length; i++) {
      var p = reference.imagePoint(line[i].lat, line[i].lng);
      if (p == null) continue;
      var on = camera.place(p.x, p.y, imageWidth, imageHeight, viewWidth, viewHeight), x = on[0], y = on[1];
      if (havePrev) this.drawDottedLine(dc, px, py, x, y, 1, 9);
      px = x; py = y; havePrev = true;
    }

    var fromImg = reference.imagePoint(centre.lat, centre.lng), toImg = reference.imagePoint(greenGeo.lat, greenGeo.lng);
    if (fromImg == null || toImg == null) return;
    var fromOn = camera.place(fromImg.x, fromImg.y, imageWidth, imageHeight, viewWidth, viewHeight), fx = fromOn[0], fy = fromOn[1];
    var toOn = camera.place(toImg.x, toImg.y, imageWidth, imageHeight, viewWidth, viewHeight), gx = toOn[0], gy = toOn[1];
    dc.setColor(COLOR_WHITE, -1);
    this.drawDottedLine(dc, fx, fy, gx, gy, 2, 8);
    var dx = gx - fx, dy = gy - fy, length = Math.sqrt(dx * dx + dy * dy);
    if (length < 1) return;
    var reach = Math.max(Math.min(length * 0.52, 46), this.fonts.xtiny.px + 18);
    this.drawLabel(dc, "Green " + formatDistance(gap, session.yards()), fx + dx / length * reach, fy + dy / length * reach - 8);
  };

  /* Liang-Barsky, as GarminMapView.clipToView. */
  function clipToView(x1, y1, x2, y2, w, h) {
    var t0 = 0.0, t1 = 1.0, dx = x2 - x1, dy = y2 - y1;
    var p = [-dx, dx, -dy, dy], q = [x1, w - x1, y1, h - y1];
    for (var i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return null; }
      else {
        var r = q[i] / p[i];
        if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
        else { if (r < t0) return null; if (r < t1) t1 = r; }
      }
    }
    return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
  }

  MapFace.prototype.drawDottedLine = function (dc, x1, y1, x2, y2, dash, gap) {
    var c = clipToView(x1, y1, x2, y2, dc.getWidth(), dc.getHeight());
    if (c == null) return;
    x1 = c[0]; y1 = c[1]; x2 = c[2]; y2 = c[3];
    dc.setPenWidth(1);
    var dx = x2 - x1, dy = y2 - y1, length = Math.sqrt(dx * dx + dy * dy);
    if (length < 1) return;
    var ux = dx / length, uy = dy / length, step = dash + gap;
    for (var t = 0.0; t < length; t += step) {
      var e = Math.min(t + dash, length);
      dc.drawLine(x1 + ux * t, y1 + uy * t, x1 + ux * e, y1 + uy * e);
    }
  };

  MapFace.prototype.drawDashedLine = function (dc, x1, y1, x2, y2) {
    var c = clipToView(x1, y1, x2, y2, dc.getWidth(), dc.getHeight());
    if (c == null) return;
    x1 = c[0]; y1 = c[1]; x2 = c[2]; y2 = c[3];
    dc.setColor(COLOR_GREEN, -1);
    dc.setPenWidth(1);
    var dx = x2 - x1, dy = y2 - y1, length = Math.sqrt(dx * dx + dy * dy);
    if (length < 1) return;
    var dashLen = 4.0, gapLen = 3.0, step = dashLen + gapLen, steps = toNumber(length / step);
    var ux = dx / length, uy = dy / length, travelled = 0.0;
    for (var i = 0; i <= steps; i++) {
      var endTravel = Math.min(travelled + dashLen, length);
      dc.drawLine(x1 + ux * travelled, y1 + uy * travelled, x1 + ux * endTravel, y1 + uy * endTravel);
      travelled += step;
    }
  };

  /* `view` is the view height, or for a ghost [viewHeight, shiftLat, shiftLng, style]. */
  MapFace.prototype.drawRing = function (dc, ring, camera, reference, imageWidth, imageHeight, viewWidth, view) {
    var ghost = Array.isArray(view);
    var viewHeight = ghost ? view[0] : view, shiftLat = ghost ? view[1] : 0.0, shiftLng = ghost ? view[2] : 0.0;
    var ghostColour = ghost && view.length > 3 ? view[3] : WIND_BLUE;
    var points = [];
    var lat0 = ring[0].lat + shiftLat, lng0 = ring[0].lng + shiftLng, step = 0.0005;
    var p0 = reference.imagePoint(lat0, lng0), pLat = reference.imagePoint(lat0 + step, lng0), pLng = reference.imagePoint(lat0, lng0 + step);
    if (p0 == null || pLat == null || pLng == null) return;
    var ax = (pLat.x - p0.x) / step, ay = (pLat.y - p0.y) / step, bx = (pLng.x - p0.x) / step, by = (pLng.y - p0.y) / step;
    var f = camera.frame(imageWidth, imageHeight, viewWidth, viewHeight);
    for (var i = 0; i < ring.length; i += 3) {
      var dLat = ring[i].lat + shiftLat - lat0, dLng = ring[i].lng + shiftLng - lng0;
      var ix = p0.x + ax * dLat + bx * dLng, iy = p0.y + ay * dLat + by * dLng;
      points.push([f[0] + ix * f[2] - iy * f[3], f[1] + ix * f[3] + iy * f[2]]);
    }
    if (points.length < 3) return;
    var k;
    if (ghost && ghostColour !== PLAYS_MAIN) {
      dc.setColor(ghostColour, -1);
      dc.setPenWidth(1);
      for (k = 0; k < points.length; k++) { var oa = points[k], ob = points[(k + 1) % points.length]; dc.drawLine(oa[0], oa[1], ob[0], ob[1]); }
      return;
    }
    var ringColour = ghost && ghostColour === PLAYS_MAIN ? SLOPE_ORANGE : BUBBLE_MINT;
    dc.setColor(RING_KEYLINE, -1);
    dc.setPenWidth(4);
    for (k = 0; k < points.length; k++) { var a0 = points[k], b0 = points[(k + 1) % points.length]; dc.drawLine(a0[0], a0[1], b0[0], b0[1]); }
    dc.setColor(ringColour, -1);
    dc.setPenWidth(2);
    for (k = 0; k < points.length; k++) { var a = points[k], b = points[(k + 1) % points.length]; dc.drawLine(a[0], a[1], b[0], b[1]); }
  };

  MapFace.prototype.playsNumber = function (playerGeo, local) {
    var effect = this.session.windEffect(playerGeo, local.target, local.targetDistanceM);
    return this.session.playsLikeM(playerGeo, local.target, local.targetDistanceM, effect);
  };

  MapFace.prototype.hitPlays = function (x, y) {
    var b = this.playsBox;
    return b != null && x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
  };

  MapFace.prototype.togglePlays = function () { this.playsMode = !this.playsMode; };

  MapFace.prototype.drawPlaysLike = function (dc, playerGeo, local, viewWidth, viewHeight) {
    var plays = this.playsNumber(playerGeo, local);
    if (plays == null) { this.playsBox = null; return; }
    var font = this.fonts.xtiny, text = "plays " + formatDistance(plays, this.session.yards());
    var th = dc.getFontHeight(font), tw = dc.getTextDimensions(text, font)[0];
    var cx = idiv(viewWidth, 2), y = viewHeight - Layout.chromeTopY(viewHeight) - th;
    var padX = th * 0.6, x0 = cx - tw / 2 - padX, x1 = cx + tw / 2 + padX;
    dc.setColor(this.playsMode ? SLOPE_ORANGE : 0x1A1A1A, -1);
    dc.fillRoundedRectangle(x0, y - 1, x1 - x0, th + 2, idiv(th + 2, 2));
    dc.setColor(SLOPE_ORANGE, -1);
    dc.setPenWidth(1);
    dc.drawRoundedRectangle(x0, y - 1, x1 - x0, th + 2, idiv(th + 2, 2));
    dc.setColor(this.playsMode ? COLOR_BLACK : SLOPE_ORANGE, -1);
    dc.drawText(cx, y, font, text, TEXT_CENTER);
    this.playsBox = [x0 - 8, y - 10, x1 + 8, y + th + 10];
  };

  MapFace.prototype.drawWindStreaks = function (dc, dx, dy, cx, cy, viewWidth) {
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.5) return;
    var ux = dx / len, uy = dy / len, px = -uy, py = ux;
    var reach = viewWidth * 0.22, length = viewWidth * 0.17, gap = viewWidth * 0.06, amp = length * 0.09;
    var thin = viewWidth * 0.003, thick = viewWidth * (viewWidth >= 300 ? 0.0075 : 0.01);
    var headLen = length * 0.26, headHalf = headLen * 0.42, steps = 10;
    dc.setColor(WIND_BLUE, WIND_BLUE);
    for (var i = 0; i < 4; i++) {
      var side = (i - 1.5) * gap;
      var back = reach + (i % 2 === 0 ? 0.0 : length * 0.35);
      var tx = cx - ux * back + px * side, ty = cy - uy * back + py * side;
      var bodyEnd = length - headLen * 0.55;
      var left = new Array(steps + 1), right = new Array(steps + 1);
      for (var k = 0; k <= steps; k++) {
        var f = k / steps, along = -length + bodyEnd * f, wave = amp * Math.sin(f * Math.PI * 2.0), half = thin + (thick - thin) * f;
        var x = tx + ux * along + px * wave, y = ty + uy * along + py * wave;
        left[k] = [x + px * half, y + py * half];
        right[steps - k] = [x - px * half, y - py * half];
      }
      dc.fillPolygon(left.concat(right));
      var hbx = tx - ux * headLen, hby = ty - uy * headLen, nx = tx - ux * headLen * 0.72, ny = ty - uy * headLen * 0.72;
      dc.fillPolygon([[tx, ty], [hbx + px * headHalf, hby + py * headHalf], [nx, ny], [hbx - px * headHalf, hby - py * headHalf]]);
    }
    dc.setPenWidth(1);
  };

  MapFace.prototype.drawRingMarker = function (dc, x, y, radius, color) { dc.setColor(color, -1); dc.setPenWidth(2); dc.drawCircle(x, y, radius); };
  MapFace.prototype.drawDot = function (dc, x, y, radius, fillColor) {
    dc.setColor(fillColor, -1); dc.fillCircle(x, y, radius);
    dc.setColor(COLOR_BLACK, -1); dc.drawCircle(x, y, radius);
  };

  MapFace.prototype.drawLabel = function (dc, text, x, y) {
    var font = this.fonts.xtiny, up = String(text).toUpperCase();
    var viewWidth = dc.getWidth(), viewHeight = dc.getHeight(), lineHeight = dc.getFontHeight(font);
    var ty = Math.max(0, Math.min(viewHeight - lineHeight, y));
    var halfText = dc.getTextWidthInPixels(up, font) / 2 + 2;
    var half = Layout.chordHalfWidthPx(this.device.shape, ty, ty + lineHeight, viewWidth, viewHeight);
    var centreX = idiv(viewWidth, 2), minX = centreX - half + halfText, maxX = centreX + half - halfText;
    var tx = x;
    if (minX > maxX) tx = centreX; else if (tx < minX) tx = minX; else if (tx > maxX) tx = maxX;
    dc.setColor(COLOR_BLACK, -1); dc.drawText(tx + 1, ty + 1, font, up, TEXT_CENTER);
    dc.setColor(COLOR_WHITE, -1); dc.drawText(tx, ty, font, up, TEXT_CENTER);
  };

  MapFace.prototype.drawCentredText = function (dc, text, y, font) { dc.drawText(idiv(dc.getWidth(), 2), y, font, text, TEXT_CENTER); };
  MapFace.prototype.drawUnavailable = function (dc, message) {
    dc.drawText(idiv(dc.getWidth(), 2), dc.getHeight() * 0.42, this.fonts.small, message, TEXT_CENTER);
    dc.drawText(idiv(dc.getWidth(), 2), dc.getHeight() * 0.58, this.fonts.xtiny, "BACK for numbers", TEXT_CENTER);
  };

  MapFace.prototype.drawChrome = function (dc, viewWidth, viewHeight) {
    var font = this.fonts.xtiny, top = Layout.chromeTopY(viewHeight);
    var half = Layout.chordHalfWidthPx(this.device.shape, top, top + dc.getFontHeight(font), viewWidth, viewHeight);
    var centreX = idiv(viewWidth, 2), pad = 2;
    var holeNumber = this.session.currentHole();
    this.shadowedText(dc, centreX - half + pad, top, font, "H" + (holeNumber != null ? holeNumber : "-"), TEXT_LEFT, COLOR_WHITE);
    var green = this.session.greenDistances();
    var centreM = green != null ? green.centre : null;
    if (centreM != null) this.shadowedText(dc, centreX + half - pad, top, font, formatDistance(centreM, this.session.yards()), TEXT_RIGHT, COLOR_WHITE);
    if (this.aiming) this.shadowedText(dc, centreX, top, font, "AIMING", TEXT_CENTER, COLOR_GREEN);
  };

  MapFace.prototype.shadowedText = function (dc, x, y, font, text, justify, color) {
    dc.setColor(COLOR_BLACK, -1); dc.drawText(x + 1, y + 1, font, text, justify);
    dc.setColor(color, -1); dc.drawText(x, y, font, text, justify);
  };

  // ------------------------------------------------------------------ interaction

  /* The page's hooks (watch-preview-page.js), shared with the Apple face. A tap on the aerial
     is a fresh fix handed to a freshly opened map: CaddyAppView.showMap drops the camera, so
     the first draw frames on where the player now is. A new hole is a new shot
     (GarminPlayState.enter): everything about the old one goes. */
  MapFace.prototype.onFix = function () { this.camera = null; };
  MapFace.prototype.onEngineReady = function () { this.camera = null; };
  MapFace.prototype.onHole = function () {
    this.session.playState.clear();
    this.aiming = false; this.dragActive = false; this.playsMode = false; this.camera = null;
  };
  MapFace.prototype.currentBubble = function () { return this.session.localBubble(); };
  MapFace.prototype.currentTarget = function () { var b = this.currentBubble(); return b ? b.target : this.session.aimTarget(); };
  /* A finger on the glass, as the page reports it in screen points. */
  MapFace.prototype.pointerDown = function (x, y) { if (this.hitPlays(x, y)) { this.togglePlays(); return; } if (this.device.touch) this.dragStart(x, y); };
  MapFace.prototype.pointerMove = function (x, y) { this.dragTo(x, y); };
  MapFace.prototype.pointerUp = function () { this.dragEnd(); };

  MapFace.prototype.canAimNow = function () { return this.session.canCompute(); };

  MapFace.prototype.enterAimMode = function () {
    if (!this.canAimNow()) return;
    if (this.session.playState.target == null) {
      var seed = this.session.aimTarget();
      if (seed == null) return;
      this.session.playState.moveTarget(seed);
    }
    this.aiming = true;
  };
  MapFace.prototype.confirmAim = function () {
    if (this.session.playState.target != null) this.session.sendAim(this.session.playState.target);
    this.aiming = false;
  };
  MapFace.prototype.cancelAim = function () {
    this.stopPan();
    this.session.playState.clear();
    this.aiming = false; this.dragActive = false;
  };
  /* Screen-space: up the glass is up the glass whichever way the framing has turned the bake. */
  MapFace.prototype.nudge = function (dxScreen, dyScreen) {
    if (!this.aiming || !this.canAimNow() || this.lastReference == null || this.camera == null) return;
    var current = this.session.playState.target;
    if (current == null) return;
    var img = this.lastReference.imagePoint(current.lat, current.lng);
    if (img == null) return;
    var d = this.camera.imageDirection(dxScreen, dyScreen);
    this.applyImagePoint(img.x + d[0], img.y + d[1]);
  };
  MapFace.prototype.dragStart = function (viewX, viewY) {
    if (!this.canAimNow()) return;
    this.enterAimMode();
    this.dragActive = true;
    this.dragTo(viewX, viewY);
  };
  MapFace.prototype.dragTo = function (viewX, viewY) {
    if (!this.dragActive || !this.canAimNow() || this.camera == null || this.lastReference == null) return;
    this.fingerX = viewX; this.fingerY = viewY; this.panning = true;
    var held = this.insideEdge(viewX, viewY);
    var img = this.camera.imagePointFromView(held[0], held[1], this.lastImageWidth, this.lastImageHeight, this.lastViewWidth, this.lastViewHeight);
    if (img == null) return;
    this.applyImagePoint(img.x, img.y);
  };
  MapFace.prototype.dragEnd = function () {
    this.stopPan();
    if (!this.dragActive) return;
    this.dragActive = false;
    this.confirmAim();
  };
  MapFace.prototype.stopPan = function () { this.panning = false; this.edgeSince = null; this.fingerX = null; this.fingerY = null; };

  MapFace.prototype.edgeDirection = function (x, y) {
    var w = this.lastViewWidth, h = this.lastViewHeight;
    if (w == null || h == null) return null;
    var inset = Math.min(w, h) * EDGE_INSET_FRACTION;
    if (this.device.shape === "round") {
      var cx = w / 2.0, cy = h / 2.0, dx = x - cx, dy = y - cy, r = Math.sqrt(dx * dx + dy * dy);
      if (r < 1 || r < cx - inset) return null;
      return [dx / r, dy / r];
    }
    var ex = x <= inset ? -1 : (x >= w - inset ? 1 : 0), ey = y <= inset ? -1 : (y >= h - inset ? 1 : 0);
    return ex === 0 && ey === 0 ? null : [ex, ey];
  };
  MapFace.prototype.insideEdge = function (x, y) {
    var w = this.lastViewWidth, h = this.lastViewHeight;
    if (w == null || h == null) return [x, y];
    var inset = Math.min(w, h) * EDGE_INSET_FRACTION;
    if (this.device.shape === "round") {
      var cx = w / 2.0, cy = h / 2.0, dx = x - cx, dy = y - cy, r = Math.sqrt(dx * dx + dy * dy), limit = cx - inset;
      if (r <= limit || r < 1) return [x, y];
      return [cx + dx / r * limit, cy + dy / r * limit];
    }
    return [Math.max(inset, Math.min(w - inset, x)), Math.max(inset, Math.min(h - inset, y))];
  };
  /* GarminMapView.onPanTick, driven by the page every PAN_TICK_MS while a drag is down.
     Returns true when the camera moved (a redraw is wanted). */
  MapFace.prototype.onPanTick = function (now) {
    if (!this.dragActive || this.camera == null || this.fingerX == null || this.lastReference == null) { this.stopPan(); return false; }
    var dir = this.edgeDirection(this.fingerX, this.fingerY);
    if (dir == null) { this.edgeSince = null; return false; }
    if (this.edgeSince == null) { this.edgeSince = now; return false; }
    if (now - this.edgeSince < EDGE_DWELL_MS) return false;
    var camera = this.camera;
    var d = camera.imageDirection(dir[0], dir[1]);
    var fx = camera.focusX + d[0] * PAN_PX_PER_TICK / camera.scale, fy = camera.focusY + d[1] * PAN_PX_PER_TICK / camera.scale;
    camera.focusX = fx < 0 ? 0.0 : (fx > this.lastImageWidth ? this.lastImageWidth : fx);
    camera.focusY = fy < 0 ? 0.0 : (fy > this.lastImageHeight ? this.lastImageHeight : fy);
    var held = this.insideEdge(this.fingerX, this.fingerY);
    var img = camera.imagePointFromView(held[0], held[1], this.lastImageWidth, this.lastImageHeight, this.lastViewWidth, this.lastViewHeight);
    if (img != null) this.applyImagePoint(img.x, img.y);
    return true;
  };
  MapFace.prototype.applyImagePoint = function (imageX, imageY) {
    var cx = Math.max(0, Math.min(this.lastImageWidth, imageX)), cy = Math.max(0, Math.min(this.lastImageHeight, imageY));
    var coordinate = this.lastReference.coordinate(cx, cy);
    if (coordinate == null) return;
    this.session.playState.moveTarget(coordinate);
  };

  // ------------------------------------------------------------------ the drawn map

  var SURFACE_KEYS = ["r", "f", "g"];
  MapFace.prototype.drawOutlines = function (dc, shapes, palette, imageWidth, imageHeight, viewWidth, viewHeight) {
    dc.setColor(palette.r, palette.r);
    dc.clear();
    var f = this.camera.frame(imageWidth, imageHeight, viewWidth, viewHeight), view = [viewWidth, viewHeight];
    this.drawPieces(dc, shapes.t, 0, palette, f, view);
    if (!hasTrees(shapes)) this.fillRings(dc, shapes.k, palette.k, f, view);
    this.fillRings(dc, shapes.h, palette.h, f, view);
    this.fillRings(dc, shapes.f, palette.f, f, view);
    this.drawPieces(dc, shapes.t, 1, palette, f, view);
    this.fillRings(dc, shapes.z, palette.z, f, view);
    if (shapes.g != null) this.fillRings(dc, [shapes.g], palette.g, f, view);
    this.drawPieces(dc, shapes.t, 2, palette, f, view);
    this.fillRings(dc, shapes.w, palette.w, f, view);
    this.fillRings(dc, shapes.b, palette.b, f, view);
  };
  function hasTrees(shapes) { return shapes != null && shapes.c != null && shapes.c.length > 0; }

  MapFace.prototype.drawTrees = function (dc, shapes, imageWidth, imageHeight, viewWidth, viewHeight) {
    if (!hasTrees(shapes)) return;
    this.treeSprites.draw(dc, shapes.c, this.camera.frame(imageWidth, imageHeight, viewWidth, viewHeight), this.camera.scale, viewWidth, viewHeight, this.device.amoled);
  };

  MapFace.prototype.drawPieces = function (dc, pieces, surface, palette, f, view) {
    var key = SURFACE_KEYS[surface];
    if (palette[key + "d"] === palette[key] && palette[key + "l"] === palette[key]) return;
    for (var i = 0; i < pieces.length; i++) {
      var label = pieces[i].label;
      if (idiv(label, 3) !== surface) continue;
      var shade = label % 3;
      this.fillRings(dc, [pieces[i]], palette[shade === 0 ? key + "d" : (shade === 2 ? key + "l" : key)], f, view);
    }
  };

  MapFace.prototype.fillRings = function (dc, rings, colour, f, view) {
    if (Array.isArray(colour) && !dc.hasSetFill) {
      if (colour[3] == null) return;
      colour = colour[3];
    }
    if (Array.isArray(colour)) dc.setFill(this.patternTexture(dc, colour));
    else { dc.setColor(colour, -1); if (dc.hasSetFill) dc.setFill(colour); }
    var sc = Math.sqrt(f[2] * f[2] + f[3] * f[3]);
    for (var i = 0; i < rings.length; i++) {
      var box = rings[i].box, mx = (box[0] + box[2]) / 2.0, my = (box[1] + box[3]) / 2.0;
      var r = Math.sqrt((box[2] - box[0]) * (box[2] - box[0]) + (box[3] - box[1]) * (box[3] - box[1])) * sc / 2.0;
      var cx = f[0] + mx * f[2] - my * f[3], cy = f[1] + mx * f[3] + my * f[2];
      if (cx + r < 0 || cy + r < 0 || cx - r > view[0] || cy - r > view[1]) continue;
      var ring = rings[i].p, n = idiv(ring.length, 2), points = new Array(n);
      for (var k = 0; k < n; k++) { var x = ring[2 * k], y = ring[2 * k + 1]; points[k] = [toNumber(f[0] + x * f[2] - y * f[3]), toNumber(f[1] + x * f[3] + y * f[2])]; }
      dc.fillPolygon(points);
    }
  };

  /* The 2x2 tile GarminMapView.patternTexture makes, as a canvas pattern. */
  MapFace.prototype.patternTexture = function (dc, spec) {
    var key = spec[0] + "/" + spec[1] + "/" + spec[2];
    if (this.textures[key]) return this.textures[key];
    var tile = (typeof document !== "undefined") ? document.createElement("canvas") : null;
    if (!tile) return hex(spec[0]);
    tile.width = 2; tile.height = 2;
    var t = tile.getContext("2d");
    t.fillStyle = hex(spec[0]); t.fillRect(0, 0, 2, 2);
    t.fillStyle = hex(spec[1]);
    var n = spec[2];
    if (n >= 1) t.fillRect(0, 0, 1, 1);
    if (n >= 2) t.fillRect(1, 1, 1, 1);
    if (n >= 3) t.fillRect(1, 0, 1, 1);
    var texture = dc.ctx.createPattern(tile, "repeat");
    this.textures[key] = texture;
    return texture;
  };

  return {
    DEVICES: DEVICES,
    TREE_SIZES: TREE_SIZES,
    TREE_TYPES: TREE_TYPES,
    PAN_TICK_MS: PAN_TICK_MS,
    NUDGE_STEP_IMAGE_PX: NUDGE_STEP_IMAGE_PX,
    BASE_PALETTE: BASE_PALETTE,
    MIP_PALETTE: MIP_PALETTE,
    fontsFor: fontsFor,
    cleanPalette: cleanPalette,
    mapPalette: mapPalette,
    Camera: Camera,
    Layout: Layout,
    clipToView: clipToView,
    /* The shared maths, for callers and the test that reach it through this module. */
    Geo: common.Geo,
    SpatialReference: common.SpatialReference,
    formatDistance: common.formatDistance,
    windEffect: common.windEffect,
    windLevel: common.windLevel,
    playsLikeM: common.playsLikeM,
    clampedToBag: common.clampedToBag,
    defaultTarget: common.defaultTarget,
    decodeShapes: common.decodeShapes,
    skeletonHole: common.skeletonHole,
    skeletonDistances: common.skeletonDistances,
    skeletonLine: common.skeletonLine,
    Dc: Dc,
    MapFace: MapFace
  };
});
