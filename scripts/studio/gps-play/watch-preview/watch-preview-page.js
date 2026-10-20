/* Clarity Studio - the watch preview page, shared by the Garmin and the Apple Watch. STUDIO
 * ONLY, view-only.
 *
 * A hole drawn the way a watch draws it (garmin-watch-render.js / apple-watch-render.js, each
 * a port of its watch's own draw code) beside the live aerial the course plays over, so the map
 * can be checked on a wrist-sized face before anything is built. Tap the aerial to put the
 * player there: the face takes it as its GPS fix, the Bubble Engine answers for it (the same
 * engine both wrists' parity fixtures are pinned to, forward bias off as the wrist engines have
 * none) and the camera, ring, layup guide, club label and chrome follow. Touch the face to aim,
 * as a finger does on the glass.
 *
 * What it reads: the course's packages (GET /api/course-watch-maps: the Garmin's drawn package
 * with watch=garmin, the image package every Apple Watch receives). Nothing here writes a
 * package, a pin, a round or an aim: the AIM_AT a watch would send to the phone is only
 * reported in the readout.
 *
 * Each watch supplies, through `options`: its renderer (DEVICES + MapFace), which package it
 * takes, its buttons, its sprite loader. Everything else - the course picker hand-off, the
 * engine bootstrap, the side map (the app's own provider list, as the Map Viewport page draws
 * it), wind, slope and the readout - is this file, once.
 *
 * The face itself - the session seam, the canvas, a finger on the glass, the buttons - is
 * mountWatch(), which the Record Hub (record-hub-page.js) mounts twice beside the phone. */
(function () {
  "use strict";

  /* Per-watch page state that survives leaving and re-entering the page. */
  var stores = {};
  function store(key, defaults) {
    if (!stores[key]) stores[key] = Object.assign({
      courseKey: "", courseName: "", holes: [], packageVersion: null, packageKind: "",
      holeNumber: null, player: null, deviceId: "", mode: "", units: "m",
      wind: null, windApplied: false, view: null, sourceKey: "", zoom: 1, locked: false
    }, defaults);
    return stores[key];
  }

  var engine = null, enginePromise = null;
  var sprites = {};            // url -> Image
  var pictures = {};           // path|format -> Image
  var elevations = {};         // the watches' elevation cache: point key -> metres
  var elevationPending = false, elevationFailedKey = null, elevationFailedAt = 0;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function num(v) { if (v === "" || v == null) return null; var n = Number(v); return Number.isFinite(n) ? n : null; }
  function slug(course) {
    return String(course && (course.courseId || course.id || course.canonicalKey || course.courseKey) || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
  }
  function common() { return window.GDWatchCommon || null; }

  // ---------------------------------------------------------------- the Bubble Engine, on its own

  /* app/js/bubble-engine.js is the fresh app's engine - the verbatim copies of gd-app-core's
     functions that the Watch engines' parity fixtures are recorded against. It is run here
     inside its own `window`, because loading it as a plain script would put its
     gdMappedFairwayLayupTarget seam over the one the Studio's own app surface already provides.
     The real Leaflet, localStorage (the bag firmness preset) and document are handed through. */
  /* Root-absolute, like the sprites: this page runs at /, at /studio/ and on a public course
     page at /courses/<id>, where a relative "app/js/..." would resolve under /courses/ and 404 -
     and without the engine AIM silently locks the shot instead of opening the map. */
  function loadEngine() {
    if (enginePromise) return enginePromise;
    enginePromise = Promise.all([fetch("/app/js/distance.js"), fetch("/app/js/bubble-engine.js")])
      .then(function (responses) {
        if (!responses.every(function (r) { return r.ok; })) throw new Error("engine source unavailable");
        return Promise.all(responses.map(function (r) { return r.text(); }));
      })
      .then(function (sources) {
        var fake = { ClarityApp: {}, GDBubbleSignalsCore: window.GDBubbleSignalsCore || null };
        fake.window = fake;
        sources.forEach(function (src, i) {
          /* eslint-disable-next-line no-new-func */
          new Function("window", "L", "localStorage", "document", src + "\n//# sourceURL=watch-preview-engine-" + i + ".js")(fake, window.L, window.localStorage, document);
        });
        engine = fake.GDBubbleEngine;
        if (!engine) throw new Error("engine did not initialise");
        engine.clearWind();
        engine.setMicroGeometry(null);
        /* The wrist engines carry no forward bias - dev/bubble-engine-parity.test.js records the
           maths all three share with it off, and these faces show a wrist's answer. */
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
    var C = common();
    var sr = new C.SpatialReference(hole.spatialReference);
    var ref = hole.reference || {};
    return {
      holeNumber: Number(hole.holeNumber),
      spatialReference: sr,
      greenLat: ref.green ? Number(ref.green.lat) : null,
      greenLng: ref.green ? Number(ref.green.lng) : null,
      shapes: C.decodeShapes(hole),
      skeleton: C.skeletonHole(hole),
      path: hole.path || "",
      palette: hole.palette || null
    };
  }

  /* "garmin-first": the drawn package every Garmin now receives, the image package when a
     course has none yet. "image": the image package, which is what every Apple Watch gets. */
  function loadPackage(courseKey, preference) {
    var base = "/api/course-watch-maps?courseId=" + encodeURIComponent(courseKey);
    var image = function (garminStatus) {
      return fetch(base, { headers: { Accept: "application/json" }, cache: "no-store" })
        .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status)); })
        .then(function (report) { return { kind: "image", report: report, garminStatus: garminStatus }; });
    };
    if (preference !== "garmin-first") return image(null);
    return fetch(base + "&watch=garmin", { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (report) {
        if (report && Array.isArray(report.holes) && report.holes.length) return { kind: "garmin", report: report };
        return image(report && report.status);
      });
  }

  function spriteImage(url, onLoad) {
    var img = sprites[url];
    if (!img) { img = new Image(); img.onload = onLoad; img.src = url; sprites[url] = img; }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  /* The hole picture as the watch receives it: the Garmin fetches the asset proxy's JPEG
     re-encode; the Apple Watch is sent the stored bytes. */
  function picture(path, format, onLoad) {
    if (!path) return null;
    var key = path + "|" + format;
    var img = pictures[key];
    if (!img) {
      img = new Image();
      img.onload = onLoad;
      img.src = "/api/course-watch-map-assets?path=" + encodeURIComponent(path) + (format ? "&format=" + format : "");
      pictures[key] = img;
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  // ---------------------------------------------------------------- slope (GarminConditions / WatchConditions)

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

  // ---------------------------------------------------------------- the watches

  /* Each watch's page file defines its options once (garmin-preview-page.js,
     apple-preview-page.js); its own preview page and the Record Hub both mount it from here. */
  var definitions = {};
  function define(key, optionsFn) { definitions[key] = optionsFn; }
  function watchOptions(key) { return definitions[key] ? definitions[key]() : null; }

  /* A course's package for one watch, decoded into the holes a face reads. */
  function loadWatchPackage(courseKey, preference) {
    return loadPackage(courseKey, preference).then(function (result) {
      var report = result.report;
      result.holes = (report && Array.isArray(report.holes) ? report.holes : []).map(holeRecord).filter(function (h) { return h.spatialReference.isUsable(); });
      result.version = report && report.watchPackageVersion;
      result.status = report && report.status || "none";
      return result;
    });
  }

  /* One watch on the glass: its face, the session seam the face reads, a finger on the canvas,
     its buttons. Shared by the preview page (one watch beside the aerial) and the Record Hub
     (both watches beside the phone).

       options   the watch's options (see render below)
       host      { canvas, bezel, buttons } - the buttons container may be null
       session   a store() - the state that survives leaving the page
       hooks     onDraw()             after every frame
                 onInput(phase)       a finger or a button on this watch: "move" while it aims,
                                      "end" when the finger lifts or a button was pressed
                 onStepHole(n)        the watch asked for the next / previous hole
                 onWindApplied()      the watch folded the wind in or out */
  function mountWatch(options, host, session, hooks) {
    var R = options.render, C = common();
    hooks = hooks || {};
    var destroyed = false, face = null, panTimer = null, aimLog = "", drawError = "";
    var canvas = host.canvas, bezel = host.bezel;

    function device() { return R.DEVICES.filter(function (d) { return d.id === session.deviceId; })[0] || R.DEVICES[0]; }
    function currentHole() { return session.holes.filter(function (h) { return h.holeNumber === session.holeNumber; })[0] || null; }
    function requestUpdate() { if (!destroyed) window.requestAnimationFrame(draw); }

    /* The watch's session manager, as far as its map face reads it: the Garmin face asks for
       the Scene's target and a local Bubble (GarminSessionManager); the Apple face owns a
       WatchPlayState and asks only to calculate. Both get both. */
    var bubbleCache = null, bubbleCacheKey = "";
    var playState = {
      target: null, bubble: null,
      moveTarget: function (coordinate) {
        if (!session.player) return null;
        var t = C.clampedToBag(coordinate, session.player, bagMaxTotalM());
        playState.target = t;
        playState.bubble = calculate(session.player, t);
        return playState.bubble;
      },
      clear: function () { playState.target = null; playState.bubble = null; }
    };
    function holeContext(hole) {
      var sk = hole.skeleton;
      return { hole: hole.holeNumber, tee: sk && sk.t, green: sk ? sk.g : { lat: hole.greenLat, lng: hole.greenLng }, route: sk ? C.skeletonLine(sk) : [] };
    }
    function calculate(player, target) {
      var hole = currentHole();
      if (!engine || !hole || !player || !target) return null;
      engine.setHoleContext(holeContext(hole));
      engine.setShot(player, target);
      var model = engine.renderModel();
      if (!model) return null;
      var payload = model.payload;
      return { target: target, targetDistanceM: model.distanceM, club: { club: payload.club, carryM: payload.baseCarry, totalM: payload.totalM },
        centre: { lat: model.center.lat, lng: model.center.lng }, ring: model.rings.main.map(function (p) { return { lat: p.lat, lng: p.lng }; }) };
    }
    var watchSession = {
      scene: {
        hasRound: function () { return !!currentHole(); },
        shotLocked: function () { return session.locked; },
        suggestedClub: function () { return null; },
        courseKey: function () { return session.courseKey; },
        /* No phone here: no demo, no Scene distance of its own, and a LOCK is allowed once
           the player stands somewhere. */
        isDemo: function () { return false; },
        distanceTargetM: function () { return null; },
        canLock: function () { return !!(session.player && currentHole()) && !session.locked; },
        /* Marshal's dock offers UNLOCK whenever the shot is locked (caddy-watch.js controls). */
        canUnlock: function () { return !!session.locked; }
      },
      currentHole: function () { return session.holeNumber; },
      holeNumbers: function () { return session.holes.map(function (h) { return h.holeNumber; }); },
      manifestHole: function (n) { return session.holes.filter(function (h) { return h.holeNumber === n; })[0] || null; },
      packageVersion: function () { return session.packageVersion; },
      bitmapFor: function (n) {
        if (options.modes && session.mode !== "picture") return null;
        var hole = watchSession.manifestHole(n);
        return hole ? picture(hole.path, options.pictureFormat, requestUpdate) : null;
      },
      outlinesFor: function (n) { var hole = watchSession.manifestHole(n); return hole ? hole.shapes : null; },
      mapPalette: function () { return options.mapPalette ? options.mapPalette(currentHole(), device()) : null; },
      playerPoint: function () { return session.player; },
      calculate: calculate,
      localBubble: function () {
        if (!watchSession.canCompute()) return null;
        if (playState.target != null && playState.bubble != null) return playState.bubble;
        var aim = watchSession.aimTarget();
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
        var ctx = holeContext(hole);
        if (!ctx.green) return null;
        engine.setHoleContext(ctx);
        engine.setShot(session.player, null);
        var t = engine.targetForGreenCentre(ctx.green, { hole: hole.holeNumber });
        return t ? { lat: t.lat, lng: t.lng } : null;
      },
      greenDistances: function () { var hole = currentHole(); return hole ? C.skeletonDistances(hole.skeleton, session.player) : null; },
      greenPoint: function () { var hole = currentHole(); return hole && hole.greenLat != null ? { lat: hole.greenLat, lng: hole.greenLng } : null; },
      holeLine: function () { var hole = currentHole(); return hole ? C.skeletonLine(hole.skeleton) : []; },
      bagMaxTotalM: bagMaxTotalM,
      windEffect: function (player, target, flatM) { return C.windEffect(session.wind, player, target, flatM); },
      playsLikeM: function (player, target, flatM, effect) { return C.playsLikeM(flatM, slopeM(player, target, requestUpdate), effect, session.windApplied); },
      playsBubble: function (local, playsM) {
        if (!local || playsM == null || !session.player) return null;
        var along = C.Geo.project(session.player, C.Geo.trueBearing(session.player, local.target), playsM);
        var result = calculate(session.player, along);
        return result ? { bubble: result, shiftLat: local.target.lat - along.lat, shiftLng: local.target.lng - along.lng } : null;
      },
      playState: playState,
      canCompute: function () { return !!(engine && session.player && currentHole()); },
      sendAim: function (target) { aimLog = "AIM_AT sent to the phone: " + target.lat.toFixed(6) + ", " + target.lng.toFixed(6); },
      yards: function () { return session.units === "y"; },
      locked: function () { return session.locked; },
      lockedShot: function () { return session.locked; },
      lockPending: function () { return false; },
      lock: function () { session.locked = true; aimLog = "LOCK sent to the phone"; },
      windApplied: function () { return session.windApplied; },
      toggleWindApplied: function () {
        session.windApplied = !session.windApplied;
        aimLog = "wind " + (session.windApplied ? "folded into" : "taken out of") + " the numbers";
        if (hooks.onWindApplied) hooks.onWindApplied();
      },
      /* NEXT_HOLE / PREVIOUS_HOLE: the phone would move the round on; here the page does. */
      stepHole: function (delta) {
        var i = session.holes.findIndex(function (h) { return h.holeNumber === session.holeNumber; }), next = session.holes[i + delta];
        if (i < 0 || !next) return;
        aimLog = (delta > 0 ? "NEXT_HOLE" : "PREVIOUS_HOLE") + " sent to the phone";
        if (hooks.onStepHole) hooks.onStepHole(next.holeNumber); else setHole(next.holeNumber);
      },
      requestUpdate: function () { renderButtons(); requestUpdate(); },
      unlock: function () { session.locked = false; if (face && face.unlock) face.unlock(); aimLog = "UNLOCK sent to the phone"; renderButtons(); }
    };

    function newFace() {
      face = new (options.Face || R.MapFace)(watchSession, device(), options.spriteBitmap(requestUpdate));
      var d = device(), ps = d.pixelScale || 1;
      canvas.width = d.width * ps; canvas.height = d.height * ps;
      canvas.style.width = d.width * ps * session.zoom + "px"; canvas.style.height = d.height * ps * session.zoom + "px";
      bezel.classList.toggle("isRound", d.shape === "round");
      bezel.classList.toggle("isRect", d.shape === "roundedRect");
      bezel.classList.toggle("isMip", d.amoled === false);
      bezel.style.setProperty("--gdWatchCorner", d.shape === "roundedRect" ? Math.round(d.corner * d.width * ps * session.zoom) + "px" : "");
      if (session.holes.length && session.player && face.onFix) face.onFix();
      renderButtons();
    }

    /* The glass: a canvas clipped to the face's shape, the bezel round it in CSS. */
    function draw() {
      if (destroyed || !face) return;
      var d = device(), ps = d.pixelScale || 1, ctx = canvas.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(ps, ps);
      ctx.beginPath();
      if (d.shape === "round") ctx.ellipse(d.width / 2, d.height / 2, d.width / 2, d.height / 2, 0, 0, Math.PI * 2);
      else if (d.shape === "roundedRect") { var r = d.corner * d.width; ctx.moveTo(r, 0); ctx.arcTo(d.width, 0, d.width, d.height, r); ctx.arcTo(d.width, d.height, 0, d.height, r); ctx.arcTo(0, d.height, 0, 0, r); ctx.arcTo(0, 0, d.width, 0, r); ctx.closePath(); }
      else ctx.rect(0, 0, d.width, d.height);
      ctx.clip();
      drawError = "";
      try { face.onUpdate(ctx); } catch (e) { drawError = "draw error: " + (e && e.message || e); }
      ctx.restore();
      if (hooks.onDraw) hooks.onDraw();
    }

    function readoutLines() {
      if (drawError) return [drawError];
      var lines = [];
      var hole = currentHole();
      if (!hole) { lines.push(session.courseKey ? "No hole in the package yet." : "Pick a course to load its package."); return lines; }
      var d = device();
      lines.push(d.name + " · " + d.width + "×" + d.height + (d.pixelScale > 1 ? " pt @" + d.pixelScale + "x" : "") + (options.deviceLine ? " · " + options.deviceLine(d) : ""));
      lines.push("package: " + session.packageKind + " v" + session.packageVersion + (options.modes && session.mode === "picture" && !hole.path ? " · no picture in a Garmin package - drawing the outlines" : ""));
      if (face && face.trace) lines.push(face.trace);
      if (!session.player) lines.push("no GPS fix - place the player first");
      else {
        var local = face.currentBubble();
        var green = watchSession.greenDistances();
        lines.push("player " + session.player.lat.toFixed(6) + ", " + session.player.lng.toFixed(6) + (green ? " · green F/C/B " + Math.round(green.front) + "/" + Math.round(green.centre) + "/" + Math.round(green.back) + " m" : ""));
        if (local) lines.push("bubble: " + local.club.club + " · " + Math.round(local.targetDistanceM) + " m to aim · carry " + Math.round(local.club.carryM) + " total " + Math.round(local.club.totalM) + (playState.target || (face.state && face.state.target) ? " · wrist's aim" : " · phone's default aim"));
        else lines.push("no local Bubble (engine still loading, or the hole has no green)");
        /* Always said, so "nothing happened" is never a mystery: the watches' own rule is calm
           under 5 km/h (no ghost, no streaks), and a direction with no speed is no wind. */
        var effect = local ? watchSession.windEffect(session.player, local.target, local.targetDistanceM) : null;
        if (!session.wind) lines.push("wind: none set (enter a direction AND a speed; the watch reads both from its weather source)");
        else if (!effect || effect.level === 0) lines.push("wind: " + session.wind.kmh + " km/h is calm on the watch's rule (under 5 km/h): no ghost, no streaks");
        else lines.push("wind: from " + session.wind.fromDeg + "° at " + session.wind.kmh + " km/h · level " + effect.level + " · " + (effect.alongM >= 0 ? "+" : "") + effect.alongM.toFixed(1) + " m along the shot · ghost ring " + Math.round(C.Geo.distance(local.target, effect.ghost)) + " m downwind" + (session.windApplied ? " · in the plays number" : ""));
      }
      lines.push((typeof face.showingMap === "boolean" ? "screen: " + (face.showingMap ? "map" : "numbers") + " · " : "") + (face.aiming ? "aiming ON" : "aiming off") + (face.playsMode ? " · plays mode ON" : "") + (session.locked ? " · shot LOCKED" : ""));
      if (aimLog) lines.push(aimLog);
      if (options.fontsNote) lines.push(options.fontsNote);
      return lines;
    }

    /* ---- the buttons ---- */

    var buttonNodes = {};
    if (host.buttons) {
      host.buttons.innerHTML = (options.buttons || []).map(function (b) {
        return '<button type="button" class="gdStudioDiagramBtn" data-gd-watch-button="' + esc(b.id) + '" title="' + esc(b.title || "") + '"></button>';
      }).join("");
      (options.buttons || []).forEach(function (b) {
        var node = host.buttons.querySelector('[data-gd-watch-button="' + b.id + '"]');
        buttonNodes[b.id] = node;
        node.addEventListener("click", function () {
          if (!face) return;
          b.act(face, session, watchSession);
          renderButtons();
          requestUpdate();
          if (hooks.onInput) hooks.onInput("end");
        });
      });
    }
    function renderButtons() {
      (options.buttons || []).forEach(function (b) {
        var node = buttonNodes[b.id];
        if (node) node.textContent = typeof b.label === "function" ? b.label(face, session) : b.label;
      });
    }

    /* ---- a finger on the glass, in the face's own points ---- */

    function canvasPoint(e) {
      var rect = canvas.getBoundingClientRect(), d = device();
      var p = e.touches && e.touches[0] ? e.touches[0] : (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : e);
      return [(p.clientX - rect.left) * d.width / rect.width, (p.clientY - rect.top) * d.height / rect.height];
    }
    var pointerDown = false;
    function onDown(e) {
      if (!face) return;
      var xy = canvasPoint(e);
      pointerDown = true;
      face.pointerDown(xy[0], xy[1], Date.now());
      if (!panTimer) panTimer = setInterval(function () {
        if (face && face.onPanTick(Date.now())) { requestUpdate(); if (hooks.onInput) hooks.onInput("move"); }
      }, R.PAN_TICK_MS);
      requestUpdate();
      if (hooks.onInput) hooks.onInput("move");
      e.preventDefault();
    }
    function onMove(e) {
      if (!pointerDown || !face) return;
      var xy = canvasPoint(e);
      face.pointerMove(xy[0], xy[1], Date.now());
      requestUpdate();
      if (hooks.onInput) hooks.onInput("move");
      e.preventDefault();
    }
    function onUp(e) {
      if (!pointerDown || !face) return;
      pointerDown = false;
      if (panTimer) { clearInterval(panTimer); panTimer = null; }
      var xy = e && e.clientX != null || (e && e.changedTouches) ? canvasPoint(e) : [0, 0];
      face.pointerUp(xy[0], xy[1], Date.now());
      renderButtons();
      requestUpdate();
      if (hooks.onInput) hooks.onInput("end");
    }
    function onWheel(e) {
      if (!face || typeof face.wheel !== "function") return;
      face.wheel(e.deltaY);
      requestUpdate();
      e.preventDefault();
    }
    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("touchstart", onDown, { passive: false });
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("mousemove", onMove);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);

    /* ---- the round, as the page moves it ---- */

    /* A fix: a held aim stays where it was and is re-measured from the new spot, as
       onLocationFix re-runs moveTarget, and the face reframes the shot from there. */
    function setPlayer(point) {
      session.player = point ? { lat: point.lat, lng: point.lng } : null;
      bubbleCacheKey = "";
      if (playState.target) playState.moveTarget(playState.target);
      if (face) face.onFix();
      requestUpdate();
    }
    function setHole(n) {
      if (n === session.holeNumber) return;
      session.holeNumber = n;
      session.locked = false;
      bubbleCacheKey = "";
      if (face) face.onHole();
      renderButtons();
      requestUpdate();
    }
    function useCourse(courseKey, courseName, loaded) {
      session.courseKey = courseKey; session.courseName = courseName || courseKey;
      session.holes = loaded.holes; session.packageKind = loaded.kind; session.packageVersion = loaded.version;
      session.player = null; session.locked = false; playState.clear(); bubbleCacheKey = ""; aimLog = "";
      session.holeNumber = loaded.holes.length ? loaded.holes[0].holeNumber : null;
      if (options.modes && loaded.kind === "garmin" && session.mode === "picture") session.mode = options.modes[0].value;
      if (face) face.onHole();
      renderButtons();
      requestUpdate();
    }

    /* The shot locked or unlocked from outside this watch (the Record Hub's switch): the same
       LOCK / UNLOCK the phone would send, and options.onLockChange moves the face to the page
       the watch shows for it. */
    function setLocked(locked) {
      if (!face || !!session.locked === !!locked) return;
      if (locked) {
        if (!watchSession.scene.canLock()) return;
        watchSession.lock();
      } else watchSession.unlock();
      if (options.onLockChange) options.onLockChange(face, !!locked);
      renderButtons();
      requestUpdate();
    }

    /* Another device aimed: the same ground point, carried onto this face as its own aim
       (options.mirrorAim knows how this watch holds one). "end" is the finger lifting. */
    function mirrorAim(coordinate, phase) {
      if (!face || !coordinate || !watchSession.canCompute() || !options.mirrorAim) return;
      options.mirrorAim(face, coordinate, phase, watchSession);
      if (phase === "end") watchSession.sendAim(face.currentTarget() || coordinate);
      requestUpdate();
    }

    newFace();
    if (options.onMount) options.onMount(requestUpdate);
    loadEngine().then(function () {
      if (destroyed) return;
      configurePlayer();
      bubbleCacheKey = "";
      /* The first frame may have been drawn before the engine answered; frame again now that
         there is a Bubble to centre on. */
      if (face) face.onEngineReady();
      requestUpdate();
    }).catch(function (error) { if (!destroyed) { drawError = "Bubble Engine failed to load - " + (error && error.message || error); if (hooks.onDraw) hooks.onDraw(); } });
    requestUpdate();

    return {
      face: function () { return face; },
      /* What stops the face drawing (the engine failed to load, the last frame threw), or "". */
      problem: function () { return drawError; },
      device: device,
      currentHole: currentHole,
      requestUpdate: requestUpdate,
      newFace: newFace,
      readoutLines: readoutLines,
      setPlayer: setPlayer,
      setHole: setHole,
      useCourse: useCourse,
      mirrorAim: mirrorAim,
      setLocked: setLocked,
      currentTarget: function () { return face ? face.currentTarget() : null; },
      destroy: function () {
        destroyed = true;
        if (panTimer) { clearInterval(panTimer); panTimer = null; }
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("touchmove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("touchend", onUp);
        face = null;
      }
    };
  }

  // ---------------------------------------------------------------- the page

  /* options:
       key            "garmin" | "apple" - the page state's own store
       render         the watch's renderer module (DEVICES, PAN_TICK_MS, MapFace)
       Face           the face to draw, when it is more than the map (the Garmin's CaddyAppView:
                      its numbers screen with the map behind it); R.MapFace otherwise
       label          the watch's name, for the Record Hub
       lede           the opening paragraph, HTML
       packages       "garmin-first" | "image"
       pictureFormat  the asset proxy format the watch fetches ("jpeg"), or "" for the stored bytes
       modes          [{ value, label }] for a watch that can draw as well as show a picture, or null
       buttons        [{ id, label(face) | label, title, act(face, session, watchSession) }]
       spriteBitmap   function (onLoad) -> the bitmap function the MapFace takes
       deviceId       the default watch
       mapPalette     function (hole, device) -> palette, for a watch that draws (null otherwise)
       mirrorAim      function (face, coordinate, phase, watchSession) - another device's aim
                      held on this face (the Record Hub's linked drag)
       onLockChange   function (face, locked) - the page the watch turns to when the shot is
                      locked or unlocked from outside it (the Record Hub's switch)
       onMount        function (redraw), once the face is up - for a face waiting on a web font */
  function render(containerEl, options) {
    var R = options.render, C = common();
    var session = store(options.key, { deviceId: options.deviceId, mode: options.modes ? options.modes[0].value : "" });
    var destroyed = false, mapObj = null, layer = null, watch = null;
    var overlays = L.layerGroup(), holeLayers = L.layerGroup();

    if (!R || !C || typeof window.L === "undefined" || !window.GDMapSources) {
      containerEl.innerHTML = '<p class="gdStudioMuted" style="padding:16px">The watch renderer, Leaflet or the map source list did not load on this surface.</p>';
      return null;
    }

    var deviceOptions = R.DEVICES.map(function (d) {
      var size = d.pixelScale > 1 ? d.width + "×" + d.height + " pt" : d.width + "×" + d.height;
      return '<option value="' + esc(d.id) + '"' + (d.id === session.deviceId ? " selected" : "") + ">" + esc(d.name) + " · " + size + "</option>";
    }).join("");
    var modeOptions = options.modes ? options.modes.map(function (m) { return '<option value="' + esc(m.value) + '">' + esc(m.label) + "</option>"; }).join("") : "";

    containerEl.innerHTML =
      '<div class="gdStudioLede" style="margin-bottom:12px"><p>' + options.lede + "</p></div>" +
      '<div class="gdStudioViewportBar">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-watch="pick">Pick course</button>' +
      '<label class="gdStudioViewportField">or key <input type="text" data-gd-watch="key" placeholder="course-key" style="width:160px"></label>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-watch="load">Load</button>' +
      '<span class="gdStudioViewportCourse" data-gd-watch="course">No course loaded</span>' +
      "</div>" +
      '<div class="gdStudioWatch">' +
      '<section class="gdStudioWatchPane">' +
      '<div class="gdStudioViewportBar">' +
      '<label class="gdStudioViewportField">Watch <select data-gd-watch="device">' + deviceOptions + "</select></label>" +
      (options.modes ? '<label class="gdStudioViewportField">Map <select data-gd-watch="mode">' + modeOptions + "</select></label>" : "") +
      '<label class="gdStudioViewportField">Units <select data-gd-watch="units"><option value="m">metres</option><option value="y">yards</option></select></label>' +
      '<label class="gdStudioViewportField">Size <select data-gd-watch="zoom"><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label>' +
      "</div>" +
      '<div class="gdStudioWatchBezel" data-gd-watch="bezel"><canvas data-gd-watch="canvas"></canvas></div>' +
      '<div class="gdStudioViewportBar gdStudioWatchButtons" data-gd-watch="buttons"></div>' +
      '<div class="gdStudioViewportBar">' +
      '<label class="gdStudioViewportField">Wind from <input type="number" data-gd-watch="windFrom" min="0" max="359" step="1" placeholder="deg" style="width:64px">°</label>' +
      '<label class="gdStudioViewportField"><input type="number" data-gd-watch="windKmh" min="0" max="80" step="1" placeholder="km/h" style="width:64px"> km/h</label>' +
      '<label class="gdStudioViewportField"><input type="checkbox" data-gd-watch="windApplied"> wind in plays</label>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-watch="calm">Calm</button>' +
      "</div>" +
      '<pre class="gdStudioWatchReadout" data-gd-watch="readout"></pre>' +
      "</section>" +
      '<section class="gdStudioWatchMapPane">' +
      '<div class="gdStudioViewportBar">' +
      '<label class="gdStudioViewportField">Provider <select data-gd-watch="provider"></select></label>' +
      '<label class="gdStudioViewportField">Hole <select data-gd-watch="hole"></select></label>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-watch="fit">Whole course</button>' +
      "</div>" +
      '<div class="gdStudioViewportMap gdStudioWatchMap" data-gd-watch="map"></div>' +
      '<div class="gdStudioViewportReadout" data-gd-watch="mapReadout"></div>' +
      '<div class="gdStudioViewportCredit" data-gd-watch="credit"></div>' +
      "</section></div>";

    var el = {};
    containerEl.querySelectorAll("[data-gd-watch]").forEach(function (node) { el[node.getAttribute("data-gd-watch")] = node; });
    if (el.mode) el.mode.value = session.mode;
    el.units.value = session.units; el.zoom.value = String(session.zoom);
    if (session.wind) { el.windFrom.value = session.wind.fromDeg; el.windKmh.value = session.wind.kmh; }
    el.windApplied.checked = session.windApplied;

    /* ---- the watch ---- */

    watch = mountWatch(options, { canvas: el.canvas, bezel: el.bezel, buttons: el.buttons }, session, {
      onDraw: function () { el.readout.textContent = watch ? watch.readoutLines().join("\n") : ""; drawOverlays(); },
      onStepHole: function (n) { setHole(n); },
      onWindApplied: function () { el.windApplied.checked = session.windApplied; }
    });

    el.device.addEventListener("change", function () { session.deviceId = el.device.value; watch.newFace(); watch.requestUpdate(); });
    if (el.mode) el.mode.addEventListener("change", function () { session.mode = el.mode.value; watch.requestUpdate(); });
    el.units.addEventListener("change", function () { session.units = el.units.value; watch.requestUpdate(); });
    el.zoom.addEventListener("change", function () { session.zoom = Number(el.zoom.value) || 1; watch.newFace(); watch.requestUpdate(); });
    function readWind() {
      var from = num(el.windFrom.value), kmh = num(el.windKmh.value);
      session.wind = from != null && kmh != null ? { fromDeg: ((from % 360) + 360) % 360, kmh: Math.max(0, kmh) } : null;
      session.windApplied = el.windApplied.checked;
      watch.requestUpdate();
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
    function drawHoles() {
      holeLayers.clearLayers();
      session.holes.forEach(function (hole) {
        var sk = hole.skeleton;
        if (!sk) return;
        var current = hole.holeNumber === session.holeNumber;
        var style = { color: current ? "#3cff8d" : "#ffffff", weight: current ? 2 : 1, opacity: current ? 0.9 : 0.35, interactive: false };
        var line = C.skeletonLine(sk);
        if (line.length >= 2) L.polyline(line.map(function (p) { return [p.lat, p.lng]; }), Object.assign({ dashArray: "4 6" }, style)).addTo(holeLayers);
        if (sk.s.length >= 3) L.polygon(sk.s.map(function (p) { return [p.lat, p.lng]; }), Object.assign({ fill: false }, style)).addTo(holeLayers);
        L.marker([sk.g.lat, sk.g.lng], { icon: L.divIcon({ className: "gdStudioWatchHoleLabel" + (current ? " isCurrent" : ""), html: String(hole.holeNumber), iconSize: [22, 22] }), interactive: true })
          .on("click", function () { setHole(hole.holeNumber); }).addTo(holeLayers);
      });
    }
    function drawOverlays() {
      if (!mapObj) return;
      overlays.clearLayers();
      var face = watch && watch.face();
      if (session.player) {
        L.circleMarker([session.player.lat, session.player.lng], { radius: 6, color: "#000", weight: 1, fillColor: "#fff", fillOpacity: 1, interactive: false }).addTo(overlays);
        var local = face ? face.currentBubble() : null;
        var target = face ? face.currentTarget() : null;
        if (target) {
          L.polyline([[session.player.lat, session.player.lng], [target.lat, target.lng]], { color: "#00ff00", weight: 1, dashArray: "4 3", interactive: false }).addTo(overlays);
          L.circleMarker([target.lat, target.lng], { radius: 5, color: "#000", weight: 1, fillColor: "#00ff00", fillOpacity: 1, interactive: false }).addTo(overlays);
        }
        if (local && local.ring && local.ring.length >= 3) {
          L.polygon(local.ring.map(function (p) { return [p.lat, p.lng]; }), { color: "#3ee6c4", weight: 2, fill: false, interactive: false }).addTo(overlays);
        }
      }
    }

    /* A tap on the aerial is the watch's next GPS fix, on the hole that is selected - the hole
       never follows the tap, as it never follows a fix on the wrist (the phone's Scene names the
       hole; alone, the wrist only moves on when it reaches the next tee). */
    function setPlayer(latlng) {
      watch.setPlayer({ lat: latlng.lat, lng: latlng.lng });
      updateMapReadout();
    }
    function setHole(n) {
      if (n === session.holeNumber) return;
      watch.setHole(n);
      el.hole.value = String(n);
      drawHoles();
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
      if (el.mode) {
        el.mode.disabled = session.packageKind === "garmin";
        el.mode.value = session.mode;
      }
      drawHoles();
      watch.requestUpdate();
    }

    function loadCourse(courseKey, courseName) {
      courseKey = String(courseKey || "").trim();
      if (!courseKey) return;
      el.course.textContent = "Loading " + courseKey + "…";
      loadWatchPackage(courseKey, options.packages).then(function (loaded) {
        if (destroyed) return;
        watch.useCourse(courseKey, courseName, loaded);
        if (!loaded.holes.length) {
          el.course.textContent = courseKey + " · no watch package (" + loaded.status + (loaded.garminStatus ? ", garmin " + loaded.garminStatus : "") + ")";
          drawHoles(); return;
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
        source: "studio-" + options.key + "-preview",
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
    el.fit.addEventListener("click", fitCourse);

    if (session.holes.length) {
      showPackage();
      if (session.view) { try { mapObj.setView([session.view.lat, session.view.lng], session.view.zoom); } catch (e) {} } else fitCourse();
    }
    updateMapReadout();
    remeasure();

    return function cleanup() {
      destroyed = true;
      watch.destroy();
      if (window.GDStudioCoursePick) window.GDStudioCoursePick.cancel();
      if (window.GDStudioShell) window.GDStudioShell.show();
      if (mapObj) { try { mapObj.remove(); } catch (e) {} }
      mapObj = null; layer = null; watch = null;
    };
  }

  window.GDWatchPreviewPage = {
    render: render, spriteImage: spriteImage,
    define: define, watchOptions: watchOptions,
    store: store, mountWatch: mountWatch, loadWatchPackage: loadWatchPackage, loadEngine: loadEngine, slug: slug
  };
})();
