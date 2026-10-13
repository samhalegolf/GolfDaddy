/* Clarity Studio - Garmin Preview. STUDIO ONLY, view-only.
 *
 * A hole drawn the way the Garmin app draws it (garmin-watch-render.js, the port of
 * garmin/source/Maps/GarminMapView.mc) beside the live aerial the course plays over, so the
 * map can be checked on a wrist-sized round face before a .prg is built. Tap the aerial to put
 * the player there: the watch face takes it as its GPS fix, the Bubble Engine answers for it
 * (the same engine the watch's parity fixtures are pinned to, forward bias off as the wrist
 * engines have none) and the camera, ring, layup guide, club label and chrome follow. Drag on
 * the face to aim, as a finger does on the glass.
 *
 * What it reads: the course's Garmin package (GET /api/course-watch-maps?watch=garmin - the
 * drawn map every Garmin now receives), falling back to the image package when a course has no
 * Garmin package yet. Nothing here writes a package, a pin, a round or an aim: the AIM_AT the
 * watch would send to the phone is only reported in the readout.
 *
 * The side map is the app's own provider list (window.GDMapSources), as the Map Viewport page
 * draws it, and the course comes from the real course picker through GDStudioCoursePick. */
(function () {
  "use strict";

  var render = function () { return window.GDGarminWatchRender || null; };

  /* Survives leaving and re-entering the page, like the Map Viewport's. */
  var session = {
    courseKey: "", courseName: "", report: null, holes: [], packageVersion: null, packageKind: "",
    holeNumber: null, player: null, deviceId: "fenix847mm", mode: "drawn", units: "m",
    wind: null, windApplied: false, autoHole: true, view: null, sourceKey: "", zoom: 1
  };

  var engine = null, enginePromise = null;
  var sprites = {};            // "set/type/size" -> Image
  var pictures = {};           // path -> Image
  var elevations = {};         // GarminConditions.elevations: point key -> metres
  var elevationPending = false, elevationFailedKey = null, elevationFailedAt = 0;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : null; }
  function slug(course) {
    return String(course && (course.courseId || course.id || course.canonicalKey || course.courseKey) || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
  }

  // ---------------------------------------------------------------- the Bubble Engine, on its own

  /* app/js/bubble-engine.js is the fresh app's engine - the verbatim copies of gd-app-core's
     functions that the Watch engines' parity fixtures are recorded against. It is run here
     inside its own `window`, because loading it as a plain script would put its
     gdMappedFairwayLayupTarget seam over the one the Studio's own app surface already provides.
     The real Leaflet, localStorage (the bag firmness preset) and document are handed through. */
  function loadEngine() {
    if (enginePromise) return enginePromise;
    enginePromise = Promise.all([fetch("app/js/distance.js"), fetch("app/js/bubble-engine.js")])
      .then(function (responses) {
        if (!responses.every(function (r) { return r.ok; })) throw new Error("engine source unavailable");
        return Promise.all(responses.map(function (r) { return r.text(); }));
      })
      .then(function (sources) {
        var fake = { ClarityApp: {}, GDBubbleSignalsCore: window.GDBubbleSignalsCore || null };
        fake.window = fake;
        sources.forEach(function (src, i) {
          /* eslint-disable-next-line no-new-func */
          new Function("window", "L", "localStorage", "document", src + "\n//# sourceURL=garmin-preview-engine-" + i + ".js")(fake, window.L, window.localStorage, document);
        });
        engine = fake.GDBubbleEngine;
        if (!engine) throw new Error("engine did not initialise");
        engine.clearWind();
        engine.setMicroGeometry(null);
        /* The wrist engines carry no forward bias - dev/bubble-engine-parity.test.js records the
           maths all three share with it off, and this face shows the Garmin's answer. */
        engine.setForwardBias(false);
        return engine;
      });
    return enginePromise;
  }

  /* The bag and My Bubble the phone would put on the wire (watch-player-delivery.js): the
     signed-in player's playable bag, the ghost stand-in otherwise; the saved aim only when it
     is a real one, never the placeholder's 1.4 degrees. */
  function configurePlayer() {
    if (!engine) return;
    var rows = [];
    try { rows = typeof gdPlayableShotBagRows === "function" ? gdPlayableShotBagRows() : []; } catch (e) { rows = []; }
    engine.setBag(rows);
    var bubble = null;
    try {
      var p = typeof gdShotActiveProfile === "function" ? gdShotActiveProfile() : null;
      if (p && !p.placeholderProfile) {
        var deg = Number(p.faceOffsetDeg != null ? p.faceOffsetDeg : p.centralFaceOffsetDeg);
        if (Number.isFinite(deg)) bubble = { offsetDeg: deg, handedness: p.handedness === "left" ? "left" : "right" };
      }
    } catch (e) { bubble = null; }
    engine.setBubble(bubble);
  }

  function bagMaxTotalM() {
    if (!engine) return null;
    var best = null;
    engine.playableBag().forEach(function (row) { var t = Number(row.totalM); if (t > 0 && (best == null || t > best)) best = t; });
    return best;
  }

  // ---------------------------------------------------------------- the package

  function holeRecord(hole) {
    var R = render();
    var sr = new R.SpatialReference(hole.spatialReference);
    var ref = hole.reference || {};
    return {
      holeNumber: Number(hole.holeNumber),
      spatialReference: sr,
      greenLat: ref.green ? Number(ref.green.lat) : null,
      greenLng: ref.green ? Number(ref.green.lng) : null,
      shapes: R.decodeShapes(hole),
      skeleton: R.skeletonHole(hole),
      path: hole.path || "",
      palette: R.cleanPalette(hole.palette)
    };
  }

  function loadPackage(courseKey) {
    var garmin = "/api/course-watch-maps?courseId=" + encodeURIComponent(courseKey);
    return fetch(garmin + "&watch=garmin", { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (report) {
        if (report && Array.isArray(report.holes) && report.holes.length) return { kind: "garmin", report: report };
        return fetch(garmin, { headers: { Accept: "application/json" }, cache: "no-store" })
          .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status)); })
          .then(function (image) { return { kind: "image", report: image, garminStatus: report && report.status }; });
      });
  }

  function spriteBitmap(onLoad) {
    var R = render();
    return function (amoled, type, sizeIndex) {
      var set = amoled ? "amoled" : "mip", size = R.TREE_SIZES[sizeIndex], key = set + "/" + type + "/" + size;
      var img = sprites[key];
      if (!img) {
        img = new Image();
        img.onload = onLoad;
        img.src = "garmin/resources-trees/drawables/trees/" + set + "/" + R.TREE_TYPES[type] + "_" + size + ".png";
        sprites[key] = img;
      }
      return img.complete && img.naturalWidth > 0 ? img : null;
    };
  }

  /* The hole picture, as the Garmin fetches it: the asset proxy's JPEG re-encode. */
  function picture(path, onLoad) {
    if (!path) return null;
    var img = pictures[path];
    if (!img) {
      img = new Image();
      img.onload = onLoad;
      img.src = "/api/course-watch-map-assets?path=" + encodeURIComponent(path) + "&format=jpeg";
      pictures[path] = img;
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  // ---------------------------------------------------------------- slope (GarminConditions)

  function elevationKey(p) { return p.lat.toFixed(4) + "," + p.lng.toFixed(4); }
  function slopeM(player, target, onArrive) {
    if (!player || !target) return null;
    var kp = elevationKey(player), kt = elevationKey(target);
    if (elevations[kp] != null && elevations[kt] != null) return elevations[kt] - elevations[kp];
    var pairKey = kp + "|" + kt, now = Date.now();
    if (elevationPending || (pairKey === elevationFailedKey && now - elevationFailedAt < 30000)) return null;
    if (Object.keys(elevations).length > 48) elevations = {};
    elevationPending = true;
    fetch("https://api.open-meteo.com/v1/elevation?latitude=" + player.lat.toFixed(6) + "," + target.lat.toFixed(6) + "&longitude=" + player.lng.toFixed(6) + "," + target.lng.toFixed(6))
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        elevationPending = false;
        var list = data && data.elevation;
        if (!Array.isArray(list) || list.length < 2) { elevationFailedKey = pairKey; elevationFailedAt = Date.now(); return; }
        elevations[kp] = Number(list[0]); elevations[kt] = Number(list[1]);
        onArrive();
      })
      .catch(function () { elevationPending = false; elevationFailedKey = pairKey; elevationFailedAt = Date.now(); });
    return null;
  }

  // ---------------------------------------------------------------- the page

  function render_(containerEl) {
    var R = render();
    var destroyed = false, mapObj = null, layer = null, face = null, panTimer = null;
    var overlays = L.layerGroup();
    var aimLog = "";

    if (!R || typeof window.L === "undefined" || !window.GDMapSources) {
      containerEl.innerHTML = '<p class="gdStudioMuted" style="padding:16px">The Garmin renderer, Leaflet or the map source list did not load on this surface.</p>';
      return null;
    }

    var deviceOptions = R.DEVICES.map(function (d) { return '<option value="' + esc(d.id) + '"' + (d.id === session.deviceId ? " selected" : "") + ">" + esc(d.name) + " · " + d.width + "×" + d.height + "</option>"; }).join("");

    containerEl.innerHTML =
      '<div class="gdStudioLede" style="margin-bottom:12px"><p>The hole as the Garmin app draws it, beside the aerial it plays over. ' +
      "<strong>Tap the aerial</strong> to put the player there - the face takes it as its GPS fix. <strong>Drag on the face</strong> to aim, as a finger does on the glass; " +
      "SELECT confirms, BACK cancels. Nothing here writes anything: the AIM_AT the watch would send is only reported below the face.</p></div>" +
      '<div class="gdStudioViewportBar">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-garmin="pick">Pick course</button>' +
      '<label class="gdStudioViewportField">or key <input type="text" data-gd-garmin="key" placeholder="course-key" style="width:160px"></label>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-garmin="load">Load</button>' +
      '<span class="gdStudioViewportCourse" data-gd-garmin="course">No course loaded</span>' +
      "</div>" +
      '<div class="gdStudioGarmin">' +
      '<section class="gdStudioGarminWatchPane">' +
      '<div class="gdStudioViewportBar">' +
      '<label class="gdStudioViewportField">Watch <select data-gd-garmin="device">' + deviceOptions + "</select></label>" +
      '<label class="gdStudioViewportField">Map <select data-gd-garmin="mode"><option value="drawn">Drawn (Garmin package)</option><option value="picture">Picture (image package)</option></select></label>' +
      '<label class="gdStudioViewportField">Units <select data-gd-garmin="units"><option value="m">metres</option><option value="y">yards</option></select></label>' +
      '<label class="gdStudioViewportField">Size <select data-gd-garmin="zoom"><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label>' +
      "</div>" +
      '<div class="gdStudioGarminBezel" data-gd-garmin="bezel"><canvas data-gd-garmin="canvas"></canvas></div>' +
      '<div class="gdStudioViewportBar gdStudioGarminButtons">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-garmin="select" title="SELECT: enter / confirm Aim Mode">SELECT</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-garmin="back" title="BACK: cancel the aim">BACK</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-garmin="up" title="UP: nudge the aim up the screen while aiming">UP</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-garmin="down" title="DOWN: nudge down">DOWN</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-garmin="plays" title="The plays button at the foot of the map (tap it on the face too)">PLAYS</button>' +
      "</div>" +
      '<div class="gdStudioViewportBar">' +
      '<label class="gdStudioViewportField">Wind from <input type="number" data-gd-garmin="windFrom" min="0" max="359" step="1" placeholder="deg" style="width:64px">°</label>' +
      '<label class="gdStudioViewportField"><input type="number" data-gd-garmin="windKmh" min="0" max="80" step="1" placeholder="km/h" style="width:64px"> km/h</label>' +
      '<label class="gdStudioViewportField"><input type="checkbox" data-gd-garmin="windApplied"> wind in plays</label>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-garmin="calm">Calm</button>' +
      "</div>" +
      '<pre class="gdStudioGarminReadout" data-gd-garmin="readout"></pre>' +
      "</section>" +
      '<section class="gdStudioGarminMapPane">' +
      '<div class="gdStudioViewportBar">' +
      '<label class="gdStudioViewportField">Provider <select data-gd-garmin="provider"></select></label>' +
      '<label class="gdStudioViewportField">Hole <select data-gd-garmin="hole"></select></label>' +
      '<label class="gdStudioViewportField"><input type="checkbox" data-gd-garmin="autoHole"' + (session.autoHole ? " checked" : "") + "> nearest hole to the tap</label>" +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-garmin="fit">Whole course</button>' +
      "</div>" +
      '<div class="gdStudioViewportMap gdStudioGarminMap" data-gd-garmin="map"></div>' +
      '<div class="gdStudioViewportReadout" data-gd-garmin="mapReadout"></div>' +
      '<div class="gdStudioViewportCredit" data-gd-garmin="credit"></div>' +
      "</section></div>";

    var el = {};
    containerEl.querySelectorAll("[data-gd-garmin]").forEach(function (node) { el[node.getAttribute("data-gd-garmin")] = node; });
    el.mode.value = session.mode; el.units.value = session.units; el.zoom.value = String(session.zoom);
    if (session.wind) { el.windFrom.value = session.wind.fromDeg; el.windKmh.value = session.wind.kmh; }
    el.windApplied.checked = session.windApplied;

    /* ---- the watch ---- */

    function device() { return R.DEVICES.filter(function (d) { return d.id === session.deviceId; })[0] || R.DEVICES[0]; }
    function currentHole() { return session.holes.filter(function (h) { return h.holeNumber === session.holeNumber; })[0] || null; }

    function requestUpdate() { if (!destroyed) window.requestAnimationFrame(draw); }

    /* GarminSessionManager, as far as the map face reads it. */
    var bubbleCache = null, bubbleCacheKey = "";
    var playState = {
      target: null, bubble: null,
      moveTarget: function (coordinate) {
        if (!session.player) return null;
        var t = R.clampedToBag(coordinate, session.player, bagMaxTotalM());
        playState.target = t;
        playState.bubble = calculate(session.player, t);
        return playState.bubble;
      },
      clear: function () { playState.target = null; playState.bubble = null; }
    };
    function calculate(player, target) {
      var hole = currentHole();
      if (!engine || !hole || !player || !target) return null;
      var sk = hole.skeleton;
      engine.setHoleContext({ hole: hole.holeNumber, tee: sk && sk.t, green: sk ? sk.g : { lat: hole.greenLat, lng: hole.greenLng }, route: sk ? R.skeletonLine(sk) : [] });
      engine.setShot(player, target);
      var model = engine.renderModel();
      if (!model) return null;
      var payload = model.payload;
      return { target: target, targetDistanceM: model.distanceM, club: { club: payload.club, carryM: payload.baseCarry, totalM: payload.totalM },
        centre: { lat: model.center.lat, lng: model.center.lng }, ring: model.rings.main.map(function (p) { return { lat: p.lat, lng: p.lng }; }) };
    }
    var garminSession = {
      scene: {
        hasRound: function () { return !!currentHole(); },
        shotLocked: function () { return false; },
        suggestedClub: function () { return null; },
        courseKey: function () { return session.courseKey; }
      },
      currentHole: function () { return session.holeNumber; },
      manifestHole: function (n) { return session.holes.filter(function (h) { return h.holeNumber === n; })[0] || null; },
      packageVersion: function () { return session.packageVersion; },
      bitmapFor: function (n) {
        if (session.mode !== "picture") return null;
        var hole = garminSession.manifestHole(n);
        return hole ? picture(hole.path, requestUpdate) : null;
      },
      outlinesFor: function (n) { var hole = garminSession.manifestHole(n); return hole ? hole.shapes : null; },
      mapPalette: function () { var hole = currentHole(); return R.mapPalette(device().amoled, hole ? hole.palette : null); },
      playerPoint: function () { return session.player; },
      localBubble: function () {
        if (!garminSession.canCompute()) return null;
        if (playState.target != null && playState.bubble != null) return playState.bubble;
        var aim = garminSession.aimTarget();
        if (aim == null) return null;
        var key = session.player.lat + "," + session.player.lng + "|" + aim.lat + "," + aim.lng + "|" + session.holeNumber;
        if (key === bubbleCacheKey) return bubbleCache;
        bubbleCache = calculate(session.player, aim);
        bubbleCacheKey = key;
        return bubbleCache;
      },
      /* The Scene's target - what the phone would aim at by default: the engine's own rule,
         asked before a target is placed, exactly as the parity fixtures ask it. */
      aimTarget: function () {
        var hole = currentHole();
        if (!engine || !hole || !session.player) return null;
        var sk = hole.skeleton, green = sk ? sk.g : (hole.greenLat != null ? { lat: hole.greenLat, lng: hole.greenLng } : null);
        if (!green) return null;
        engine.setHoleContext({ hole: hole.holeNumber, tee: sk && sk.t, green: green, route: sk ? R.skeletonLine(sk) : [] });
        engine.setShot(session.player, null);
        var t = engine.targetForGreenCentre(green, { hole: hole.holeNumber });
        return t ? { lat: t.lat, lng: t.lng } : null;
      },
      greenDistances: function () { var hole = currentHole(); return hole ? R.skeletonDistances(hole.skeleton, session.player) : null; },
      holeLine: function () { var hole = currentHole(); return hole ? R.skeletonLine(hole.skeleton) : []; },
      bagMaxTotalM: bagMaxTotalM,
      windEffect: function (player, target, flatM) { return R.windEffect(session.wind, player, target, flatM); },
      playsLikeM: function (player, target, flatM, effect) { return R.playsLikeM(flatM, slopeM(player, target, requestUpdate), effect, session.windApplied); },
      playsBubble: function (local, playsM) {
        if (!local || playsM == null || !session.player) return null;
        var along = R.Geo.project(session.player, R.Geo.trueBearing(session.player, local.target), playsM);
        var result = calculate(session.player, along);
        return result ? { bubble: result, shiftLat: local.target.lat - along.lat, shiftLng: local.target.lng - along.lng } : null;
      },
      playState: playState,
      canCompute: function () { return !!(engine && session.player && currentHole()); },
      sendAim: function (target) { aimLog = "AIM_AT sent to the phone: " + target.lat.toFixed(6) + ", " + target.lng.toFixed(6); },
      yards: function () { return session.units === "y"; }
    };

    function newFace() {
      face = new R.MapFace(garminSession, device(), spriteBitmap(requestUpdate));
      var d = device();
      el.canvas.width = d.width; el.canvas.height = d.height;
      el.canvas.style.width = d.width * session.zoom + "px"; el.canvas.style.height = d.height * session.zoom + "px";
      el.bezel.classList.toggle("isRound", d.shape === "round");
      el.bezel.classList.toggle("isMip", !d.amoled);
    }

    function draw() {
      if (destroyed || !face) return;
      var d = device(), ctx = el.canvas.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, d.width, d.height);
      ctx.save();
      if (d.shape === "round") { ctx.beginPath(); ctx.ellipse(d.width / 2, d.height / 2, d.width / 2, d.height / 2, 0, 0, Math.PI * 2); ctx.clip(); }
      try { face.onUpdate(ctx); } catch (e) { ctx.restore(); el.readout.textContent = "draw error: " + (e && e.message || e); return; }
      ctx.restore();
      renderReadout();
      drawOverlays();
    }

    function renderReadout() {
      var lines = [];
      var hole = currentHole();
      if (!hole) { lines.push(session.courseKey ? "No hole in the package yet." : "Pick a course to load its Garmin package."); }
      else {
        var d = device();
        lines.push(d.name + " · " + d.width + "×" + d.height + " · " + (d.amoled ? "AMOLED palette" : "64-colour MIP palette") + (d.patternFill ? "" : " · no pattern fills") + (d.scaledBitmap ? "" : " · picture 1:1 only"));
        lines.push("package: " + session.packageKind + " v" + session.packageVersion + (session.mode === "picture" && !hole.path ? " · no picture in a Garmin package - drawing the outlines" : ""));
        if (face && face.trace) lines.push(face.trace);
        if (!session.player) lines.push("no GPS fix - tap the aerial to place the player");
        else {
          var local = garminSession.localBubble();
          var green = garminSession.greenDistances();
          lines.push("player " + session.player.lat.toFixed(6) + ", " + session.player.lng.toFixed(6) + (green ? " · green F/C/B " + Math.round(green.front) + "/" + Math.round(green.centre) + "/" + Math.round(green.back) + " m" : ""));
          if (local) lines.push("bubble: " + local.club.club + " · " + Math.round(local.targetDistanceM) + " m to aim · carry " + Math.round(local.club.carryM) + " total " + Math.round(local.club.totalM) + (playState.target ? " · local aim" : " · phone's default aim"));
          else lines.push("no local Bubble (engine still loading, or the hole has no green)");
          var effect = local ? garminSession.windEffect(session.player, local.target, local.targetDistanceM) : null;
          if (effect) lines.push("wind: level " + effect.level + " · " + (effect.alongM >= 0 ? "+" : "") + effect.alongM.toFixed(1) + " m along the shot");
        }
        lines.push("aiming " + (face && face.aiming ? "ON" : "off") + (face && face.playsMode ? " · plays mode ON" : ""));
        if (aimLog) lines.push(aimLog);
        lines.push("fonts approximated from the screen size; the Garmin bitmap fonts are the one thing a browser cannot copy.");
      }
      el.readout.textContent = lines.join("\n");
    }

    /* ---- face input: a finger on the glass, or the buttons ---- */

    function canvasPoint(e) {
      var rect = el.canvas.getBoundingClientRect(), d = device();
      var p = e.touches && e.touches[0] ? e.touches[0] : e;
      return [(p.clientX - rect.left) * d.width / rect.width, (p.clientY - rect.top) * d.height / rect.height];
    }
    var pointerDown = false, pointerMoved = false, downAt = null;
    function onDown(e) {
      if (!face) return;
      var xy = canvasPoint(e);
      pointerDown = true; pointerMoved = false; downAt = xy;
      if (face.hitPlays(xy[0], xy[1])) { face.togglePlays(); pointerDown = false; requestUpdate(); e.preventDefault(); return; }
      if (!device().touch) return;
      face.dragStart(xy[0], xy[1]);
      if (!panTimer) panTimer = setInterval(function () { if (face && face.onPanTick(Date.now())) requestUpdate(); }, R.PAN_TICK_MS);
      requestUpdate();
      e.preventDefault();
    }
    function onMove(e) {
      if (!pointerDown || !face) return;
      var xy = canvasPoint(e);
      if (Math.abs(xy[0] - downAt[0]) + Math.abs(xy[1] - downAt[1]) > 2) pointerMoved = true;
      face.dragTo(xy[0], xy[1]);
      requestUpdate();
      e.preventDefault();
    }
    function onUp() {
      if (!pointerDown || !face) return;
      pointerDown = false;
      if (panTimer) { clearInterval(panTimer); panTimer = null; }
      face.dragEnd();
      requestUpdate();
    }
    el.canvas.addEventListener("mousedown", onDown);
    el.canvas.addEventListener("touchstart", onDown, { passive: false });
    window.addEventListener("mousemove", onMove);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);

    el.select.addEventListener("click", function () { if (!face) return; if (face.aiming) face.confirmAim(); else face.enterAimMode(); requestUpdate(); });
    el.back.addEventListener("click", function () { if (face) { face.cancelAim(); requestUpdate(); } });
    el.up.addEventListener("click", function () { if (face) { face.nudge(0, -R.NUDGE_STEP_IMAGE_PX); requestUpdate(); } });
    el.down.addEventListener("click", function () { if (face) { face.nudge(0, R.NUDGE_STEP_IMAGE_PX); requestUpdate(); } });
    el.plays.addEventListener("click", function () { if (face) { face.togglePlays(); requestUpdate(); } });

    el.device.addEventListener("change", function () { session.deviceId = el.device.value; newFace(); requestUpdate(); });
    el.mode.addEventListener("change", function () { session.mode = el.mode.value; requestUpdate(); });
    el.units.addEventListener("change", function () { session.units = el.units.value; requestUpdate(); });
    el.zoom.addEventListener("change", function () { session.zoom = Number(el.zoom.value) || 1; newFace(); requestUpdate(); });
    function readWind() {
      var from = num(el.windFrom.value), kmh = num(el.windKmh.value);
      session.wind = from != null && kmh != null ? { fromDeg: ((from % 360) + 360) % 360, kmh: Math.max(0, kmh) } : null;
      session.windApplied = el.windApplied.checked;
      requestUpdate();
    }
    el.windFrom.addEventListener("input", readWind);
    el.windKmh.addEventListener("input", readWind);
    el.windApplied.addEventListener("change", readWind);
    el.calm.addEventListener("click", function () { el.windFrom.value = ""; el.windKmh.value = ""; readWind(); });

    /* ---- the side map ---- */

    var sourcesApi = window.GDMapSources;
    function liveSources() { return Array.isArray(sourcesApi.list) ? sourcesApi.list : []; }
    function centre() { try { return mapObj ? mapObj.getCenter() : null; } catch (e) { return null; } }
    function sourceByKey(key) { return liveSources().filter(function (s) { return s.key === key; })[0] || null; }
    function availability(source, here) {
      if (source.requiresKey && !sourcesApi.keyValue(source.requiresKey)) return "no key";
      if (!sourcesApi.covers(source, here)) return "no coverage here";
      return "";
    }
    var providerSignature = "";
    function buildProviderOptions() {
      var here = centre();
      var rows = liveSources().map(function (s) { var why = availability(s, here); return { key: s.key, text: s.name + (why ? " — " + why : "") }; });
      var signature = rows.map(function (r) { return r.key + "|" + r.text; }).join("\n");
      if (signature === providerSignature) return;
      providerSignature = signature;
      var current = el.provider.value || session.sourceKey;
      el.provider.innerHTML = rows.map(function (r) { return '<option value="' + esc(r.key) + '">' + esc(r.text) + "</option>"; }).join("");
      if (current) el.provider.value = current;
    }
    function bestSourceKey() {
      var here = centre();
      var found = liveSources().filter(function (s) { return sourcesApi.ready(s, here); })[0];
      return found ? found.key : (liveSources()[0] || {}).key || "";
    }
    function useSource(key) {
      var source = sourceByKey(key) || liveSources()[0];
      if (!source) return;
      session.sourceKey = source.key;
      el.provider.value = source.key;
      if (layer) { try { mapObj.removeLayer(layer); } catch (e) {} }
      layer = sourcesApi.buildLayer(source).addTo(mapObj);
      try { mapObj.setMaxZoom(num(source.options && source.options.maxZoom) || 21); } catch (e) {}
      el.credit.innerHTML = esc(source.label) + (source.attribution ? " — " + esc(source.attribution) : "");
    }

    /* The package's holes on the aerial: play lines and green outlines, the current hole
       bright, so the tap lands where it is meant to. Player, target and ring are drawn here too
       - the very points the face is showing, on the ground they belong to. */
    var holeLayers = L.layerGroup();
    function drawHoles() {
      holeLayers.clearLayers();
      session.holes.forEach(function (hole) {
        var sk = hole.skeleton;
        if (!sk) return;
        var current = hole.holeNumber === session.holeNumber;
        var style = { color: current ? "#3cff8d" : "#ffffff", weight: current ? 2 : 1, opacity: current ? 0.9 : 0.35, interactive: false };
        var line = R.skeletonLine(sk);
        if (line.length >= 2) L.polyline(line.map(function (p) { return [p.lat, p.lng]; }), Object.assign({ dashArray: "4 6" }, style)).addTo(holeLayers);
        if (sk.s.length >= 3) L.polygon(sk.s.map(function (p) { return [p.lat, p.lng]; }), Object.assign({ fill: false }, style)).addTo(holeLayers);
        L.marker([sk.g.lat, sk.g.lng], { icon: L.divIcon({ className: "gdStudioGarminHoleLabel" + (current ? " isCurrent" : ""), html: String(hole.holeNumber), iconSize: [22, 22] }), interactive: true })
          .on("click", function () { setHole(hole.holeNumber); }).addTo(holeLayers);
      });
    }
    function drawOverlays() {
      if (!mapObj) return;
      overlays.clearLayers();
      if (session.player) {
        L.circleMarker([session.player.lat, session.player.lng], { radius: 6, color: "#000", weight: 1, fillColor: "#fff", fillOpacity: 1, interactive: false }).addTo(overlays);
        var local = garminSession.localBubble();
        var target = local ? local.target : garminSession.aimTarget();
        if (target) {
          L.polyline([[session.player.lat, session.player.lng], [target.lat, target.lng]], { color: "#00ff00", weight: 1, dashArray: "4 3", interactive: false }).addTo(overlays);
          L.circleMarker([target.lat, target.lng], { radius: 5, color: "#000", weight: 1, fillColor: "#00ff00", fillOpacity: 1, interactive: false }).addTo(overlays);
        }
        if (local && local.ring && local.ring.length >= 3) {
          L.polygon(local.ring.map(function (p) { return [p.lat, p.lng]; }), { color: "#3ee6c4", weight: 2, fill: false, interactive: false }).addTo(overlays);
        }
      }
    }

    function nearestHole(point) {
      var best = null, bestD = Infinity;
      session.holes.forEach(function (hole) {
        var sk = hole.skeleton;
        if (!sk) return;
        var line = R.skeletonLine(sk);
        if (line.length < 2) line = [sk.g];
        var d = Infinity;
        for (var i = 0; i < line.length; i++) {
          if (i + 1 < line.length) d = Math.min(d, segmentDistance(point, line[i], line[i + 1]));
          else d = Math.min(d, R.Geo.distance(point, line[i]));
        }
        if (d < bestD) { bestD = d; best = hole.holeNumber; }
      });
      return best;
    }
    function segmentDistance(p, a, b) {
      var k = Math.cos(a.lat * Math.PI / 180);
      var ax = a.lng * k, ay = a.lat, bx = b.lng * k, by = b.lat, px = p.lng * k, py = p.lat;
      var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      var t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      return R.Geo.distance(p, { lat: ay + dy * t, lng: (ax + dx * t) / k });
    }

    function setPlayer(latlng) {
      session.player = { lat: latlng.lat, lng: latlng.lng };
      if (session.autoHole) {
        var n = nearestHole(session.player);
        if (n != null && n !== session.holeNumber) { setHole(n); return; }
      }
      requestUpdate();
      updateMapReadout();
    }
    function setHole(n) {
      if (n === session.holeNumber) return;
      session.holeNumber = n;
      el.hole.value = String(n);
      /* GarminPlayState.enter: a new hole is a new shot; the old aim goes with it. */
      playState.clear();
      if (face) { face.aiming = false; face.dragActive = false; face.playsMode = false; }
      bubbleCacheKey = "";
      drawHoles();
      requestUpdate();
      updateMapReadout();
    }
    function updateMapReadout() {
      var here = centre();
      var bits = [];
      if (here) bits.push("centre " + here.lat.toFixed(6) + ", " + here.lng.toFixed(6));
      if (mapObj) bits.push("z" + mapObj.getZoom());
      bits.push(session.player ? "player placed - tap again to move" : "tap to place the player");
      el.mapReadout.textContent = bits.join(" · ");
      if (here) session.view = { lat: here.lat, lng: here.lng, zoom: mapObj.getZoom() };
    }

    function fitCourse() {
      var points = [];
      session.holes.forEach(function (h) { if (h.skeleton) { points.push([h.skeleton.g.lat, h.skeleton.g.lng]); if (h.skeleton.t) points.push([h.skeleton.t.lat, h.skeleton.t.lng]); } });
      if (points.length) { try { mapObj.fitBounds(L.latLngBounds(points), { padding: [20, 20] }); } catch (e) {} }
    }

    /* ---- loading a course ---- */

    function showPackage() {
      el.hole.innerHTML = session.holes.map(function (h) { return '<option value="' + h.holeNumber + '"' + (h.holeNumber === session.holeNumber ? " selected" : "") + ">Hole " + h.holeNumber + "</option>"; }).join("");
      el.course.textContent = (session.courseName || session.courseKey) + " · " + session.packageKind + " package v" + session.packageVersion + " · " + session.holes.length + " holes";
      el.mode.disabled = session.packageKind === "garmin";
      if (session.packageKind === "garmin" && session.mode === "picture") { session.mode = "drawn"; el.mode.value = "drawn"; }
      drawHoles();
      requestUpdate();
    }

    function loadCourse(courseKey, courseName) {
      courseKey = String(courseKey || "").trim();
      if (!courseKey) return;
      el.course.textContent = "Loading " + courseKey + "…";
      loadPackage(courseKey).then(function (result) {
        if (destroyed) return;
        var report = result.report;
        var holes = (report && Array.isArray(report.holes) ? report.holes : []).map(holeRecord).filter(function (h) { return h.spatialReference.isUsable(); });
        session.courseKey = courseKey; session.courseName = courseName || courseKey; session.report = report;
        session.holes = holes; session.packageKind = result.kind; session.packageVersion = report.watchPackageVersion;
        session.player = null; playState.clear(); bubbleCacheKey = ""; aimLog = "";
        session.holeNumber = holes.length ? holes[0].holeNumber : null;
        if (!holes.length) {
          el.course.textContent = courseKey + " · no watch package (" + (report && report.status || "none") + (result.garminStatus ? ", garmin " + result.garminStatus : "") + ")";
          drawHoles(); requestUpdate(); return;
        }
        showPackage();
        fitCourse();
        useSource(bestSourceKey());
        updateMapReadout();
      }).catch(function (error) {
        if (!destroyed) el.course.textContent = "Could not load " + courseKey + " — " + (error && error.message || error);
      });
    }

    function remeasure() { setTimeout(function () { if (!destroyed && mapObj) { try { mapObj.invalidateSize(); } catch (e) {} } }, 60); }
    function pickCourse() {
      var pick = window.GDStudioCoursePick;
      var opened = pick && typeof pick.open === "function" && pick.open({
        source: "studio-garmin-preview",
        onReturn: remeasure,
        onPick: function (course) { if (!destroyed) loadCourse(slug(course), course && (course.name || course.courseName)); }
      });
      if (!opened) el.course.textContent = "The course picker is not loaded on this surface - type a course key instead.";
    }

    /* ---- boot ---- */

    mapObj = L.map(el.map, { zoomControl: true, attributionControl: false, doubleClickZoom: false, scrollWheelZoom: true, maxZoom: 22 }).setView([0, 0], 2);
    holeLayers.addTo(mapObj);
    overlays.addTo(mapObj);
    buildProviderOptions();
    useSource(session.sourceKey || bestSourceKey());
    mapObj.on("moveend zoomend", function () { buildProviderOptions(); updateMapReadout(); });
    mapObj.on("click", function (e) { if (session.holes.length) setPlayer(e.latlng); });

    el.pick.addEventListener("click", pickCourse);
    el.load.addEventListener("click", function () { loadCourse(el.key.value); });
    el.key.addEventListener("keydown", function (e) { if (e.key === "Enter") loadCourse(el.key.value); });
    el.provider.addEventListener("change", function () { useSource(el.provider.value); });
    el.hole.addEventListener("change", function () { setHole(Number(el.hole.value)); });
    el.autoHole.addEventListener("change", function () { session.autoHole = el.autoHole.checked; });
    el.fit.addEventListener("click", fitCourse);

    newFace();
    loadEngine().then(function () { if (destroyed) return; configurePlayer(); bubbleCacheKey = ""; requestUpdate(); })
      .catch(function (error) { if (!destroyed) el.readout.textContent = "Bubble Engine failed to load - " + (error && error.message || error); });

    if (session.holes.length) {
      showPackage();
      if (session.view) { try { mapObj.setView([session.view.lat, session.view.lng], session.view.zoom); } catch (e) {} } else fitCourse();
      updateMapReadout();
    } else {
      requestUpdate();
      updateMapReadout();
    }
    remeasure();

    return function cleanup() {
      destroyed = true;
      if (panTimer) { clearInterval(panTimer); panTimer = null; }
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchend", onUp);
      if (window.GDStudioCoursePick) window.GDStudioCoursePick.cancel();
      if (window.GDStudioShell) window.GDStudioShell.show();
      if (mapObj) { try { mapObj.remove(); } catch (e) {} }
      mapObj = null; layer = null; face = null;
    };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["gps-garmin-preview"] = render_;
})();
