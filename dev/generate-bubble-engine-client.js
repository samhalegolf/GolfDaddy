/*
 * Generates app/js/bubble-engine.js — the shot bubble engine for the fresh
 * app surface, copied VERBATIM from gd-app-core.js (and the two pure route
 * layup helpers from gd-course-library-pin-lock.js).
 *
 * The bubble engine is one tied-together system: club pattern ratios, the
 * bag (account bag, ghost bag when none), dispersion profiles, payload
 * shaping, the bag-roof clamp, and the target rule (green when the max bag
 * distance reaches it, the fairway layup point when it cannot). None of that
 * is rebuilt here — same policy as dev/generate-visual-engine-client.js: the
 * needed functions are copied byte-for-byte into their own closure, and the
 * fresh-app test asserts every copy is identical to core. Divergence is a CI
 * failure, and gd-app-core stays the single authoritative source.
 *
 * The client closure supplies only what the copies reference from their old
 * home and the fresh app must provide differently (an adapter, listed and
 * justified at the bottom of the template): shot state, dev() over the
 * shipped DEV_DEFAULTS, a map shim whose distance() is the haversine Leaflet
 * itself uses, and a projection seam so the engine's lat/lng bubble rings
 * can be drawn on the playing surface.
 *
 * Run: node dev/generate-bubble-engine-client.js  (after editing core)
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CORE = path.join(ROOT, "scripts", "gd-app-core.js");
const PINLOCK = path.join(ROOT, "scripts", "gd-course-library-pin-lock.js");
const CLIENT = path.join(ROOT, "app", "js", "bubble-engine.js");

/* Single-line consts copied by name. */
const CORE_CONSTS = [
  "GD_DEFAULT_CLUB_CARRY_M", "GD_CLUB_GROUPS", "GD_BAG_FIRMNESS_PRESETS",
  "GD_CLUB_PATTERN_RATIOS", "GD_BAG_FIRMNESS_KEY", "PLACEHOLDER_PLAYER_PROFILE"
];

/* Top-level functions copied by name, brace-matched. */
const CORE_FUNCS = [
  // numbers / helpers
  "gdClamp", "gdRound", "gdFiniteNumber", "gdHandednessSign", "normAng",
  "bearing", "project", "projectOffset",
  // bag
  "gdBagFirmness", "gdBagFirmnessMultiplier", "gdRolloutBasePct",
  "gdBagTotalForCarry", "gdCarryM", "gdTotalM", "gdDefaultStandInBag",
  // gdShotActiveProfile is deliberately NOT copied. Core's version hunts a
  // legacy account API that does not exist in this shell and the adapter
  // replaced it wholesale anyway, so the copy was dead lines that existed
  // only to be overwritten. The adapter declares the real one instead.
  "gdNormaliseBagRow", "gdNormaliseShotBagRows",
  "gdAccountShotBagRows", "gdGhostShotBagRows", "gdPlayableShotBagRows",
  "gdActiveShotBagRows", "gdHasPlayableBag", "gdResolveShotBagClub",
  "gdMaxPlayableCarryM",
  // target rule
  "gdTargetForGreenCentre", "gdStartIsInMappedTeeArea", "gdFairwayLineGrabAllowed",
  // wind (display-target drift only — never touches dispersion shape)
  "gdNormAngle", "gdWindEffectMeters", "gdWindLandingFromAim", "gdSyncWindLandingFromAim",
  // profile / pattern derivation
  "gdGetClubGroup", "gdDefaultCarryForClub", "gdGetClubPatternDefaults",
  "gdBubbleGeometryTuning", "gdResolveFaceAlignmentOffsetDeg", "gdDeriveAimOffset",
  "gdDeriveBasePatternSize", "gdDeriveDistanceTendency", "gdDerivePatternWindow",
  "gdDeriveClusterTilt", "calculateBubbleProfile",
  "gdProfileInputForClub", "gdNearestStandInClub", "gdProfileCentralOffset",
  // payloads
  "getActiveBubbleProfile", "getGDBForClub", "calculateVisualBubbleRender",
  "gdNormalizeGpsBubblePayload", "gdScaleGpsBubblePayloadForDisplay",
  "gdFallbackGpsBubblePayload", "getGpsBubblePayload", "gdGpsBubbleDisplayPayload",
  "gdBubblePayloadForRender",
  // bubble geometry / render model
  "bubbleRadiusFactor", "bubbleTextureFactor", "gdBubbleShotBearing",
  "gdBubbleRoofMaxDistanceM", "gdBubbleForwardDistanceFromStart",
  "gdBubbleDepthForRoof", "gdClampBubbleCenterToBagRoof", "gdShotDisplayTarget",
  "gdBubbleRenderCenter", "gdBubbleAxes", "gdBubbleLocalToLatLng",
  "gdSmoothBubbleLocalRing", "buildBubbleShape", "localPointToLatLng"
];

/* Closure-indented pure route helpers from pin-lock (the layup selection). */
const PINLOCK_FUNCS = ["sampleRouteProgress", "fairwayLayupTargetByShotDistance"];

function extractConst(source, name) {
  const startAt = source.indexOf("const " + name + "=");
  if (startAt === -1) throw new Error("const not found in source: " + name);
  /* Brace-match: object consts span lines (PLACEHOLDER_PLAYER_PROFILE). */
  let depth = 0, i = source.indexOf("{", startAt);
  const lineEnd = source.indexOf("\n", startAt);
  if (i === -1 || i > lineEnd) return source.slice(startAt, lineEnd).trimEnd();
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  const tail = source[i + 1] === ";" ? 2 : 1;
  return source.slice(startAt, i + tail);
}

function extractFunction(source, name, indent) {
  const decl = indent + "function " + name + "(";
  const startAt = source.indexOf(decl);
  if (startAt === -1) throw new Error("function not found in source: " + name);
  /* Balance the parameter parens first — default params like opts={} would
     otherwise terminate the brace match before the body. */
  let i = startAt + decl.length - 1, parens = 0;
  for (; i < source.length; i++) {
    if (source[i] === "(") parens++;
    else if (source[i] === ")") { parens--; if (parens === 0) break; }
  }
  let depth = 0;
  i = source.indexOf("{", i);
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(startAt, i + 1);
}

const core = fs.readFileSync(CORE, "utf8");
const pinlock = fs.readFileSync(PINLOCK, "utf8");

const consts = CORE_CONSTS.map((name) => extractConst(core, name));
const funcs = CORE_FUNCS.map((name) => extractFunction(core, name, ""));
const pinlockFuncs = PINLOCK_FUNCS.map((name) => extractFunction(pinlock, name, "  "));

const banner = `/* GENERATED by dev/generate-bubble-engine-client.js — DO NOT HAND-EDIT.
   Every function in the VERBATIM sections below is a byte-for-byte copy from
   gd-app-core.js / gd-course-library-pin-lock.js, asserted identical by
   dev/fresh-app-boot.test.js. Change the engine, then re-run the generator. */`;

const adapter = `
  /* ==== adapter (fresh-app supplied, NOT copied) ====
     Only what the verbatim copies referenced from their old home:
     - start/target/greenCentre: shot state, fed by app.shot via the api.
     - dev(): reads the engine's own shipped DEV_DEFAULTS (no admin store in
       the fresh shell yet). Values copied from gd-app-core DEV_DEFAULTS.
     - map: distance() is the same haversine Leaflet's map.distance computes;
       getSize/latLngToLayerPoint route through the projection seam so the
       display payload's pixel cap sees the real on-surface scale.
     - wind, tournament, engine-payload globals the fresh shell does not run
       yet resolve to their engine-defined absence behaviour (declared, so
       verbatim copies take their intended branch rather than throwing).
     - window.gdMappedFairwayLayupTarget: in the old app pin-lock provides
       this seam; here the client provides it from the SAME verbatim layup
       helpers, fed the hole route the package already carries.
     - gdShotActiveProfile: core's version looks for a legacy account API
       (window.GolfDaddyAccounts / ClarityCaddieAccounts) that does not exist
       here, so it is not copied at all — the fresh app declares its own,
       backed by the two things this shell really owns: the bag (bag.js, via
       setBag) and the saved My Bubble (my-bubble.js, via setBubble).

       This used to return { bag } and nothing else, so gdProfileCentralOffset
       never found a faceOffsetDeg and every GPS bubble on the course aimed at
       the placeholder 1.4 deg right — whatever the player had adopted and
       saved, and for left-handers too. A degree value and a bag is the whole
       of the GPS bubble (Bubble Bible s2); half of it was missing. */
  var start = null, target = null, greenCentre = null;
  var appBagRows = [];
  var appBubble = null;   // { offsetDeg, handedness } — my-bubble.js owns it
  function gdShotActiveProfile() {
    if (!appBagRows.length && !appBubble) return null;
    return {
      bag: appBagRows,
      faceOffsetDeg: appBubble ? appBubble.offsetDeg : undefined,
      centralFaceOffsetDeg: appBubble ? appBubble.offsetDeg : undefined,
      handedness: appBubble ? appBubble.handedness : undefined
    };
  }
  var targetDragging = false, bubbleOrganic = true, bubbleBiasMode = "neutral";
  var currentHoleNumber = 0, currentTee = null, currentRoute = [];
  var projection = null;   // {toScreen(latlng)->{x,y}, viewSize()->{x,y}}

  var DEV_DEFAULTS = {
    shotEngine: { bubbleRadiusPct: .082, minimumBubbleRadiusM: 7, distanceTendencyCapPct: 5, dispersionMultiplierCap: 1.6 },
    bubbleVisuals: { outerScale: 1.18, mainScale: 1.02, innerScale: .84, mainOutlineOpacity: .44, mainFillOpacity: .046, dragFillOpacity: .034, lockedShadeOpacity: .085, dragShadowOpacity: .18, classicOutlineOpacity: .78, classicFillOpacity: .065 },
    bubbleGeometry: {}
  };
  function dev(path) { return path.split(".").reduce(function (o, k) { return o && o[k]; }, DEV_DEFAULTS); }

  var map = {
    distance: function (a, b) { return window.ClarityApp.distance.haversineMeters(a, b); },
    getSize: function () {
      var size = projection && projection.viewSize && projection.viewSize();
      return size ? { x: size.x, y: size.y } : null;
    },
    latLngToLayerPoint: function (ll) {
      var pt = projection && projection.toScreen && projection.toScreen(ll);
      if (!pt) throw new Error("no projection");
      return L.point(pt.x, pt.y);
    }
  };

  /* Real wind state (wind.js drives it through setWind/clearWind below). The
     verbatim gdShotDisplayTarget/gdWindLandingFromAim/gdSyncWindLandingFromAim
     copies above already read exactly these three bindings by name. */
  var gdWindActive = false, gdWindOriginAngle = null, gdWindLevel = 1;
  var gdWindLandingTarget = null;
  function gdHasWindVector() { return !!gdWindActive && Number.isFinite(gdWindOriginAngle); }
  function gdMappedStartHoleNumber() { return currentHoleNumber; }
  function toLatLng(value) {
    var lat = Number(value && value.lat), lng = Number(value && value.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat: lat, lng: lng } : null;
  }
  function distance(a, b) { return map.distance(a, b); }
  function projectFramePoint(origin, brg, meters) { return project(origin, brg, meters); }
  function gdMappedTeeAreaPoint() { return currentTee; }

  window.gdMappedFairwayLayupTarget = function (startLike, greenLike, carryM) {
    try {
      var startLL = toLatLng(startLike), greenLL = toLatLng(greenLike);
      var maxCarry = Number(carryM);
      if (!startLL || !greenLL || !(maxCarry > 0)) return null;
      if (distance(startLL, greenLL) <= maxCarry + 3) return greenLL;
      var route = (currentRoute || []).map(toLatLng).filter(Boolean);
      return fairwayLayupTargetByShotDistance(route, startLL, maxCarry) || null;
    } catch (e) { return null; }
  };

  window.GDBubbleEngine = {
    setHoleContext: function (ctx) {
      ctx = ctx || {};
      currentHoleNumber = Number(ctx.hole) || 0;
      currentTee = toLatLng(ctx.tee);
      currentRoute = Array.isArray(ctx.route) ? ctx.route : [];
      greenCentre = toLatLng(ctx.green);
    },
    setProjection: function (p) { projection = p || null; },
    setShot: function (startLL, targetLL) {
      start = toLatLng(startLL);
      target = toLatLng(targetLL);
      gdSyncWindLandingFromAim();
    },
    setDragging: function (on) { targetDragging = !!on; },
    setBag: function (rows) { appBagRows = Array.isArray(rows) ? rows : []; },
    /* The saved My Bubble: a degree value and a handedness, nothing else —
       the bubble's SHAPE is never taken from it (Bubble Bible s2). Pass a
       non-finite offset to clear it. my-bubble.js reads the value from the
       profile store that the studio's Adopt -> Save writes to. */
    setBubble: function (bubble) {
      /* Guard null/undefined/"" BEFORE the finite check — Number(null) is 0 and
         Number.isFinite(0) is true, so a bare finite test turns "no bubble" into
         a fabricated 0.0 deg aim (Bubble Bible s8, same trap as the practice
         bridge). setBubble(null) must clear, not zero. */
      var raw = bubble == null ? null : bubble.offsetDeg;
      var deg = (raw === null || raw === undefined || raw === "") ? NaN : Number(raw);
      appBubble = Number.isFinite(deg)
        ? { offsetDeg: deg, handedness: (bubble && bubble.handedness) === "left" ? "left" : "right" }
        : null;
    },
    defaultBagRows: gdDefaultStandInBag,
    setWind: function (originAngleRad, level) {
      gdWindActive = true;
      gdWindOriginAngle = gdNormAngle(Number(originAngleRad));
      gdWindLevel = Math.max(1, Math.min(3, Number(level) || 1));
      gdSyncWindLandingFromAim();
    },
    clearWind: function () {
      gdWindActive = false;
      gdWindLandingTarget = null;
    },
    windState: function () {
      return gdHasWindVector() ? { originAngle: gdWindOriginAngle, level: gdWindLevel } : null;
    },
    windLanding: function () { return gdWindLandingTarget; },
    maxPlayableCarryM: gdMaxPlayableCarryM,
    playableBag: gdPlayableShotBagRows,
    targetForGreenCentre: function (green, opts) { return gdTargetForGreenCentre(toLatLng(green), opts || {}); },
    /* The old renderShot pipeline, minus the Leaflet layers: distance →
       payload → render centre → display payload → the three shell rings as
       lat/lng arrays for the surface to project. */
    renderModel: function () {
      var displayTarget = gdShotDisplayTarget();
      if (!start || !displayTarget) return null;
      var d = map.distance(start, displayTarget);
      if (!Number.isFinite(d) || d <= 0) return null;
      var raw = getGpsBubblePayload(d);
      var center = gdBubbleRenderCenter(raw) || displayTarget || target;
      var gdb = gdGpsBubbleDisplayPayload(raw, d, center);
      return {
        distanceM: d,
        payload: gdb,
        center: center,
        rings: {
          outer: buildBubbleShape(center, gdb, dev("bubbleVisuals.outerScale")),
          main: buildBubbleShape(center, gdb, dev("bubbleVisuals.mainScale")),
          inner: buildBubbleShape(center, gdb, dev("bubbleVisuals.innerScale"))
        }
      };
    }
  };
`;

const out = [
  banner,
  "(function () {",
  '  "use strict";',
  "",
  "/* ==== VERBATIM consts (gd-app-core.js) ==== */",
  consts.join("\n"),
  "",
  "/* ==== VERBATIM functions (gd-app-core.js) ==== */",
  funcs.join("\n"),
  "",
  "/* ==== VERBATIM functions (gd-course-library-pin-lock.js) ==== */",
  pinlockFuncs.join("\n"),
  adapter,
  "})();",
  ""
].join("\n");

fs.writeFileSync(CLIENT, out);
const kb = (out.length / 1024).toFixed(1);
console.log("Generated " + path.relative(ROOT, CLIENT) + " (" + kb + "KB, "
  + CORE_CONSTS.length + " consts, " + (CORE_FUNCS.length + PINLOCK_FUNCS.length) + " functions verbatim)");
