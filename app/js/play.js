/* Play state machine. Owns the Leaflet map and the surface overlay.

   States: idle → playing(hole). The live map is created once, visible by
   default (rule 2), and never hidden by anything except a fully presented
   published surface. Every transition does its own cleanup synchronously —
   there are no intervals and no watchdogs in this file or anywhere in app/.

   A token guards async work across transitions: changing hole or leaving play
   bumps it, so a surface fetch resolving late is a no-op, not a poller's job
   to mop up. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var surfaceLib = app.playSurface;

  var map = null;
  var objectLayer = null;
  var positionWired = false;
  var transitionToken = 0;
  var current = { courseKey: null, pkg: null, hole: 0, rec: null, nines: null };
  var store = null;
  var viewLocked = false;   // Lock/Unlock: freezes map gestures + holds the surface frame

  /* A rough course-footprint radius from the course centre, not from any one
     hole's geometry - see maybeAdoptGpsFix. The question this answers is "is
     this person actually at the golf course" (vs. checking the app from home),
     not "are they on this specific hole" - a live fix anywhere on the grounds
     should count, including while walking between holes. */
  var GPS_ADOPT_RADIUS_M = 800;

  var GESTURE_HANDLERS = ["dragging", "touchZoom", "doubleClickZoom", "scrollWheelZoom", "boxZoom", "keyboard"];

  /* Leaflet's own gestures are off whenever the stage camera owns the view:
     while the frame is locked by hand, and whenever a live frame is applied.
     Under a live frame the map element is rotated, so a drag would pan along
     a rotated axis and a pinch would fight the stage's own zoom — and the
     published surface has no pan/zoom at all, so switching them off is what
     makes the two presentations behave the same. Taps still work: only the
     gesture handlers are toggled, never the click listener. */
  function applyGestureState() {
    if (!map) return;
    var frozen = viewLocked || document.body.classList.contains("map-framed");
    GESTURE_HANDLERS.forEach(function (name) {
      var handler = map[name];
      if (handler) { frozen ? handler.disable() : handler.enable(); }
    });
  }

  /* Freezes the camera so it can't be bumped off-frame mid-shot. The frame
     hold itself lives in applySurfaceFrame/applyLiveFrame's holdFrame check,
     driven by the same flag. */
  function setViewLocked(on) {
    viewLocked = !!on;
    document.body.classList.toggle("view-locked", viewLocked);
    applyGestureState();
    var btn = document.getElementById("lockToggleBtn");
    if (btn) {
      btn.textContent = viewLocked ? "Unlock" : "Lock";
      btn.setAttribute("aria-pressed", viewLocked ? "true" : "false");
    }
  }

  function ensureStore() {
    if (!store) {
      store = surfaceLib.createStore({
        fetchRecord: function (courseKey) {
          return fetch("/api/course-visuals?courseId=" + encodeURIComponent(courseKey), {
            headers: { Accept: "application/json" }, cache: "no-store"
          }).then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) { return data && (data.record || data) || null; })
            .catch(function () { return null; });
        }
      });
    }
    return store;
  }

  var baseKind = null;
  var baseLayer = null;

  /* Satellite where licensed (LINZ aerial inside NZ), OSM elsewhere. Chosen
     per course centre and swapped only when the answer changes. */
  function setBaseFor(centre) {
    if (!map) return;
    var base = app.basemap.baseFor(centre);
    if (base.kind === baseKind) return;
    if (baseLayer) baseLayer.remove();
    baseKind = base.kind;
    baseLayer = base.layer.addTo(map);
    /* Attribution as fixed chrome, not a Leaflet control: the control lives
       inside the map element, which the stage camera rotates and oversizes,
       so it would end up askew or off-screen entirely. Every source in
       basemap.js is licensed on the condition this stays visible. */
    var credit = document.getElementById("mapAttribution");
    if (credit) {
      credit.textContent = base.attribution || "";
      credit.classList.toggle("hiddenState", !base.attribution);
    }
  }

  function ensureMap(centre) {
    if (typeof L === "undefined") return map;
    if (!map) {
      /* zoomSnap:0 is load-bearing: the stage camera solves a continuous
         scale and hands the log2 of it to setView. Snapping that to whole
         zooms would put the tee and the aim target off their guide boxes. */
      map = L.map("map", { zoomControl: false, attributionControl: false, zoomSnap: 0 })
        .setView([-36.9, 174.78], 15);
      /* Tap where you are standing — same contract as a real fix. A pin
         placement armed via the tool rail intercepts the next tap instead.
         The tap is resolved through the shared seam rather than e.latlng:
         Leaflet derives that from the container's bounding box, which is the
         axis-aligned box of a ROTATED element under a live frame and so
         answers the wrong point. latLngAt inverts the frame properly. */
      map.on("click", function (e) {
        var native = e && e.originalEvent;
        if (!native) return;
        var tapped = app.play.latLngAt(native.clientX, native.clientY);
        if (!tapped) return;
        if (app.pin && app.pin.armed()) { app.pin.set(tapped); app.pin.disarm(); return; }
        if (!tapCanPlacePlayer()) return;
        app.position.set(tapped, "tap");
      });
    }
    setBaseFor(centre);
    return map;
  }

  /* Reference zoom for solving the live frame. Integer for the same reason
     captureZoom is (rule 6) — worldPx rejects anything else — and high
     enough that a green-focus stage still has pixel granularity to spare. */
  var REF_ZOOM = 20;
  var refPx = surfaceLib.worldPxProjector(REF_ZOOM);
  /* The published surface's 25px "green with no shape" default is quoted at
     z18; carry the same real-world size to the reference zoom. */
  var LIVE_GREEN_RADIUS_PX = 25 * Math.pow(2, REF_ZOOM - 18);

  var IDENTITY_FRAME = { a: 1, b: 0, tx: 0, ty: 0 };
  var liveFrame = IDENTITY_FRAME;   // Leaflet container px → viewport px
  var mapSide = null;               // current over-provisioned container side

  /* The one projection seam. Published: image pixels through the surface
     frame. Live: Leaflet container pixels through the live frame. Every
     overlay — dot, rings, aim line, pin, green ring — goes through this and
     therefore draws on both presentations without knowing which is up.
     Null means "nothing can be placed right now", which every caller already
     treats as "don't draw" rather than as an error. */
  function projector() {
    var img = document.getElementById("surfaceImage");
    if (document.body.classList.contains("surface-published") && img && img.dataset.playSurface && activeFrame) {
      var meta;
      try { meta = JSON.parse(img.dataset.playSurface); } catch (e) { return null; }
      var frame = activeFrame;
      return {
        toScreen: function (ll) {
          if (!ll) return null;
          var px = surfaceLib.projectToSurface(meta, ll.lat, ll.lng);
          return px ? surfaceLib.transformApply(frame, px) : null;
        },
        toLatLng: function (screenPt) {
          var px = surfaceLib.transformInvert(frame, screenPt);
          var w = Number(meta.outputDimensions.width), h = Number(meta.outputDimensions.height);
          if (!px || !(px.x >= 0 && px.y >= 0 && px.x <= w && px.y <= h)) return null;
          return surfaceLib.latLngFromWorldPx(
            { x: Number(meta.originPx.x) + px.x, y: Number(meta.originPx.y) + px.y },
            Number(meta.captureZoom));
        }
      };
    }
    if (map && liveFrame) {
      var live = liveFrame;
      return {
        toScreen: function (ll) {
          if (!ll) return null;
          try {
            var c = map.latLngToContainerPoint([ll.lat, ll.lng]);
            return surfaceLib.transformApply(live, { x: c.x, y: c.y });
          } catch (e) { return null; }
        },
        toLatLng: function (screenPt) {
          var c = surfaceLib.transformInvert(live, screenPt);
          if (!c) return null;
          try {
            var ll = map.containerPointToLatLng([c.x, c.y]);
            return { lat: ll.lat, lng: ll.lng };
          } catch (e) { return null; }
        }
      };
    }
    return null;
  }

  /* The package endpoint ships holes two ways (functions/lib/
     gd-course-package-shape.mjs): lite = {holeNumber, tee, green, greenShape,
     route}, full = {holeNumber, geometry:{…same fields}, visual:{url,
     playSurface}}. Normalise both to one record; null when the hole has no
     geometry — a normal outcome. */
  function holeRecord(pkg, hole) {
    var holes = pkg && Array.isArray(pkg.holes) ? pkg.holes : [];
    var found = holes.find(function (h) { return Number(h && h.holeNumber) === Number(hole); });
    if (!found) return null;
    var geometry = found.geometry || found;
    return {
      tee: geometry.tee || null,
      green: geometry.green || null,
      greenShape: Array.isArray(geometry.greenShape) ? geometry.greenShape : [],
      route: Array.isArray(geometry.route) ? geometry.route : [],
      visual: found.visual && found.visual.playSurface ? found.visual : null
    };
  }

  /* Frame the live map on the hole from package objects. Tolerant: with no
     geometry it falls back to the course centre, then to the current view —
     normal outcomes, not errors. Creates the map: only the absence/failure
     paths call this, so OSM never renders under a declared surface. */
  function frameHole(rec) {
    var centre = (rec && (rec.green || rec.tee)) || current.centre;
    if (!ensureMap(centre)) return;
    if (objectLayer) { objectLayer.remove(); objectLayer = null; }
    var pts = [];
    function push(p) { if (p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))) pts.push([Number(p.lat), Number(p.lng)]); }
    if (rec) {
      push(rec.tee); push(rec.green);
      rec.route.forEach(push);
      rec.greenShape.forEach(push);
    }
    /* A coarse opening view only. When the hole has enough geometry to solve
       a stage frame, applyLiveFrame replaces this on the very next render —
       this is the fallback for holes that do not (no green, no tee), where
       the plain north-up fit is the honest presentation.

       animate:false is load-bearing. Leaflet animates a fitBounds/setView by
       default and reports the target zoom immediately, so the stage frame
       solved and applied straight afterwards looks like it won — then the
       animation lands and silently clobbers it. The map ends up at a zoom no
       frame ever chose, and every projection answers against it. */
    if (pts.length >= 2) map.fitBounds(L.latLngBounds(pts).pad(0.15), { animate: false });
    else if (pts.length === 1) map.setView(pts[0], 17, { animate: false });
    else if (current.centre) map.setView([current.centre.lat, current.centre.lng], 15, { animate: false });
    if (pts.length) {
      var layers = [];
      var shape = rec.greenShape.filter(function (p) { return p && Number.isFinite(Number(p.lat)); })
        .map(function (p) { return [Number(p.lat), Number(p.lng)]; });
      /* The green's own geometry — its outline, or a centre dot when the
         package has no shape. Green focus only: playing down the fairway you
         can already see the green in the imagery, so drawing a white pentagon
         and a centre pip over it is clutter standing in front of the picture.
         Zoomed in on the green it is the useful reference again. Kept in the
         layer and hidden by CSS on the frame stage, not rebuilt per stage —
         the geometry still drives distances and framing regardless. */
      if (shape.length >= 3) {
        layers.push(L.polygon(shape, { color: "#ffffff", weight: 2, fillColor: "#2f8f4e", fillOpacity: 0.25, className: "holeGreen" }));
      } else if (rec.green) {
        layers.push(L.circleMarker([rec.green.lat, rec.green.lng], { radius: 6, color: "#ffffff", weight: 2, fillColor: "#2f8f4e", fillOpacity: 0.9, className: "holeGreen" }));
      }
      var line = [rec.tee].concat(rec.route, [rec.green])
        .filter(function (p) { return p && Number.isFinite(Number(p.lat)); })
        .map(function (p) { return [Number(p.lat), Number(p.lng)]; });
      /* The mapped hole corridor. Only the pre-shot presentation: once a shot
         is live the SVG instruments draw the aim line and the layup middle
         guide over the same ground, and three dashed lines down one fairway
         reads as a rendering fault. Hidden by CSS on body.shot-active rather
         than rebuilt, so it comes straight back between shots. */
      if (line.length >= 2) layers.push(L.polyline(line, { color: "#ffffff", weight: 2, dashArray: "6 8", opacity: 0.7, className: "holeRoute" }));
      if (rec.tee) layers.push(L.circleMarker([rec.tee.lat, rec.tee.lng], { radius: 5, color: "#ffffff", weight: 2, fillColor: "#0d1b12", fillOpacity: 0.9 }));
      objectLayer = L.layerGroup(layers).addTo(map);
    }
    /* The coarse view above has just moved the camera out from under whatever
       frame was last applied, so the held frame no longer describes what is on
       screen. Drop it: without this, a hole entered with a GPS fix already
       adopted holds the stale frame (a gps fix is a hold condition), leaving
       fitBounds' opening view in place and every projection answering against
       a camera the frame never chose. */
    mapSide = null;
    /* Unconditional: with no position yet this is what applies the pre-locked
       hole frame (tee low, green high) to the map we just created. */
    renderPosition(app.position.current());
  }

  /* Back to a plain north-up Leaflet map: the element fills the viewport
     again, the matrix goes away, and the identity frame means the seam still
     projects (container px ARE viewport px at inset:0), so the dot and the
     overlays keep drawing on holes that cannot be staged. */
  function clearLiveFrame() {
    liveFrame = IDENTITY_FRAME;
    if (mapSide === null) return;   // already plain — invalidateSize would be busywork
    mapSide = null;
    var el = document.getElementById("map");
    if (el) { el.style.width = ""; el.style.height = ""; el.style.transform = ""; }
    document.body.classList.remove("map-framed");
    applyGestureState();
    if (map) map.invalidateSize({ animate: false });
  }

  /* The live map's stage camera — the same guide-box contract the published
     surface frames against (play-surface.js stageFrame), solved in
     world-mercator pixels instead of image pixels.

     The solved similarity is split rather than applied whole: its SCALE
     becomes Leaflet's own zoom, so tiles render at native resolution instead
     of being upscaled by a CSS matrix, and only the ROTATION stays in the
     matrix. Whatever scale the layer's zoom range cannot absorb comes back as
     `residual` and rides in the matrix too, so a clamped zoom softens the
     imagery without ever moving the tee or the target off their boxes.

     Tilt is deliberately not carried over — Leaflet has no 3D camera. */
  function applyLiveFrame(pos) {
    if (!map) return;
    var stage = desiredStage(pos);
    var holdFrame = mapSide !== null && stage === frameStage
      && (document.body.classList.contains("bubble-dragging") || document.body.classList.contains("ball-dragging")
        || viewLocked || (pos && pos.source === "gps"));
    setStage(stage);
    if (holdFrame) return;
    var view = { width: window.innerWidth, height: window.innerHeight };
    if (!(view.width > 0 && view.height > 0)) return;
    var rec = current.rec || {};
    var act = app.shot && app.shot.active();
    var solved = surfaceLib.stageFrame(refPx, stage, {
      tee: rec.tee || null,
      green: rec.green || null,
      greenShape: rec.greenShape || [],
      position: pos || null,
      target: (act && act.target) || null
    }, view, {
      defaultGreenRadiusPx: LIVE_GREEN_RADIUS_PX,
      lockTightness: app.gpsSettings ? app.gpsSettings.lockTightness() : 1
    });
    if (!solved) { clearLiveFrame(); return; }

    var scale = Math.hypot(solved.a, solved.b);
    /* "Shot-up frame: Off" keeps the stage's zoom and centring but drops the
       rotation, leaving a plain north-up map. */
    var angle = (app.gpsSettings && !app.gpsSettings.shotUp()) ? 0 : Math.atan2(solved.b, solved.a);
    if (!(scale > 0)) { clearLiveFrame(); return; }
    var wanted = REF_ZOOM + Math.log2(scale);
    var zoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), wanted));
    var residual = Math.pow(2, wanted - zoom);

    /* The geographic point that must land on the viewport centre. Anchoring
       there (rather than on a guide box) is what keeps the over-provisioned
       square covering the viewport through any rotation: the element's centre
       and the rotation's fixed point are the same point. */
    var centreWorld = surfaceLib.transformInvert(solved, { left: view.width / 2, top: view.height / 2 });
    if (!centreWorld) { clearLiveFrame(); return; }
    var centre = surfaceLib.latLngFromWorldPx(centreWorld, REF_ZOOM);
    if (!Number.isFinite(centre.lat) || !Number.isFinite(centre.lng)) { clearLiveFrame(); return; }

    /* The viewport diagonal: the smallest square that still covers the
       viewport after an arbitrary rotation about its own centre. */
    var side = Math.ceil(Math.hypot(view.width, view.height));
    var el = document.getElementById("map");
    if (!el) return;
    /* Leaflet caches its container size and only re-measures on
       invalidateSize. Sizing alone is not enough to know the cache is good:
       if the frame is first solved while the play screen is still hidden,
       Leaflet caches 0x0 and — because the side has not changed since — would
       never re-measure, leaving setView clamped to zoom 0 and every
       projection wrong for the rest of the round. Re-measure whenever the
       cache disagrees with the element, which also self-heals that case the
       moment the screen becomes visible. */
    var measured = map.getSize();
    if (measured.x !== side || measured.y !== side) {
      document.body.classList.add("map-framed");
      el.style.width = side + "px";
      el.style.height = side + "px";
      map.invalidateSize({ animate: false });
      applyGestureState();
    }
    /* Still no size: the screen is not on yet. Claim NOTHING — mapSide is the
       record that a frame is actually applied, and holdFrame trusts it. Set
       it early and a skipped solve reads as "already framed", so the next GPS
       fix holds a frame that was never applied and the camera stays wherever
       the previous hole left it. */
    if (!(map.getSize().x > 0)) { mapSide = null; return; }
    map.setView([centre.lat, centre.lng], zoom, { animate: false });

    /* Read the container point back rather than assuming side/2: Leaflet
       rounds its own pixel origin, and half a pixel of drift here would show
       up as the dot sitting beside the player. */
    var c = map.latLngToContainerPoint([centre.lat, centre.lng]);
    liveFrame = surfaceLib.anchoredTransform({ x: c.x, y: c.y },
      { left: view.width / 2, top: view.height / 2 }, angle, residual);
    el.style.transform = "matrix(" + liveFrame.a + "," + liveFrame.b + "," + (-liveFrame.b) + ","
      + liveFrame.a + "," + liveFrame.tx + "," + liveFrame.ty + ")";
    mapSide = side;   // only now is a frame genuinely applied
  }

  /* Club codes read tight in the shot row (the same 2-3 char shorthand the
     legacy shot card used) — everything in the bag's club list is already
     short except "Driver". */
  function compactClub(label) {
    var raw = String(label || "").trim();
    if (!raw) return "GPS";
    if (/^driver$/i.test(raw)) return "DR";
    return raw.length <= 3 ? raw.toUpperCase() : raw.slice(0, 3).toUpperCase();
  }

  function renderDistances(fix, model) {
    var bar = document.getElementById("distanceBar");
    if (!bar) return;
    var rec = current.rec;
    var d = fix && rec && rec.green ? app.distance.greenDistances(fix, rec) : null;
    bar.classList.toggle("hiddenState", !d || d.centre === null);
    if (!d || d.centre === null) return;
    /* Everything upstream is metres; the units setting only changes what the
       card shows. Bare numbers by design — the F/B labels carry the meaning. */
    var showDist = function (m) {
      if (m === null || !Number.isFinite(Number(m))) return "–";
      return app.gpsSettings ? app.gpsSettings.toDisplay(m) : Math.round(Number(m));
    };
    document.getElementById("distFront").textContent = showDist(d.front);
    document.getElementById("distBack").textContent = showDist(d.back);
    /* Aimed off the green: club/total/carry for this shot — total is the
       distance to where it actually lands (the engine's render centre, not
       the raw aim point — aim-offset and bag-roof already moved it). Green
       centre is dropped (front/back already frame the green); what remains
       to the green renders on the middle guide line itself (renderShotOverlays'
       "Green Xm" label), not repeated here. Aimed at the green, F/B already
       IS the shot. */
    var shotRow = document.getElementById("shotRow");
    if (!shotRow) return;
    var act = aimingShot();
    var show = false;
    if (act && act.target) {
      var landing = (model && model.center) || act.target;
      var toTarget = app.distance.haversineMeters(fix, landing);
      var remaining = app.distance.haversineMeters(landing, rec.green);
      if (Number.isFinite(toTarget) && Number.isFinite(remaining) && remaining > 3) {
        var payload = model && model.payload;
        document.getElementById("shotClub").textContent = payload ? compactClub(payload.club) : "–";
        document.getElementById("shotDist").textContent = showDist(toTarget);
        document.getElementById("shotCarry").textContent = payload && Number.isFinite(Number(payload.baseCarry))
          ? showDist(Number(payload.baseCarry)) : "–";
        show = true;
      }
    }
    shotRow.classList.toggle("hiddenState", !show);
  }

  /* One renderer for both presentations. The stage camera runs first — every
     overlay below projects through the frame it establishes, so the frame has
     to be current before anything draws. A position that cannot be projected
     hides the dot: a normal state, not an error. */
  function renderPosition(pos) {
    /* Before the camera: entering green focus changes the stage, and the
       stage is what applySurfaceFrame/applyLiveFrame frame against. */
    updateGreenFocus(pos);
    var img = document.getElementById("surfaceImage");
    var published = document.body.classList.contains("surface-published");
    if (published && img && img.dataset.playSurface) {
      try { applySurfaceFrame(JSON.parse(img.dataset.playSurface), pos); } catch (e) {}
    } else if (map) {
      applyLiveFrame(pos);
    }
    var proj = projector();
    /* The start pill owns the pre-frame state: hole framed, no position yet.
       Any placement — pill, tap, adopted fix — retires it for the hole. */
    var pill = document.getElementById("startPill");
    if (pill) pill.classList.toggle("hiddenState", !!pos || startPillDismissed || !(current.rec && current.rec.tee));
    var dot = document.getElementById("gpsDot");
    if (!dot) return;
    var onScreen = pos && proj ? proj.toScreen(pos) : null;
    /* Letterbox fallback: a published surface that could not solve a frame
       still shows the whole image contained, and the dot has to follow it. */
    if (!onScreen && pos && published && !activeFrame && img && img.dataset.playSurface) {
      try {
        var meta = JSON.parse(img.dataset.playSurface);
        var imagePx = surfaceLib.projectToSurface(meta, pos.lat, pos.lng);
        if (imagePx) {
          onScreen = surfaceLib.fitContain(imagePx, meta.outputDimensions,
            { width: img.clientWidth, height: img.clientHeight });
        }
      } catch (e) { onScreen = null; }
    }
    /* In green focus the ball IS the marker — showing both would say the
       player is in two places at once. */
    var ballShown = renderGreenFocusBall(pos, proj);
    dot.classList.toggle("hiddenState", !onScreen || ballShown);
    if (onScreen) {
      dot.style.left = onScreen.left + "px";
      dot.style.top = onScreen.top + "px";
    }
    var act = app.shot && app.shot.active();
    document.body.classList.toggle("shot-active", !!act);
    /* Aiming only — green focus has a shot but nothing to aim (aimingShot). */
    var model = aimingShot() && window.GDBubbleEngine ? window.GDBubbleEngine.renderModel() : null;
    renderShotOverlays(pos, model, proj);
    renderDistances(pos, model);
    renderPin(pos, proj);
    renderShotAction();
  }

  /* The pin marker draws on whichever presentation is up — one projected DOM
     marker plus a "how far from here" label, through the same seam
     renderShotOverlays uses for the rings. It used to be a Leaflet marker on
     the live map and a DOM marker on the surface; one upright marker over
     both is simpler AND survives the live frame's rotation, which a marker
     living inside the rotated map pane would not. */
  function renderPin(fix, proj) {
    var pin = app.pin && app.pin.current();
    var marker = document.getElementById("pinMarker");
    var label = document.getElementById("pinDistance");
    if (!marker || !label) return;
    var screen = pin && proj ? proj.toScreen(pin) : null;
    marker.classList.toggle("hiddenState", !screen);
    if (screen) { marker.style.left = screen.left + "px"; marker.style.top = screen.top + "px"; }
    var dist = screen && fix ? app.distance.haversineMeters(fix, pin) : null;
    label.classList.toggle("hiddenState", !Number.isFinite(dist));
    if (Number.isFinite(dist)) {
      label.textContent = app.gpsSettings ? app.gpsSettings.format(dist) : Math.round(dist) + "m";
      label.style.left = screen.left + "px";
      label.style.top = screen.top + "px";
    }
  }

  /* The aim bubble at the active shot's target, and the green ring in green
     focus — both live in the overlay viewport, positioned with the same
     projection as the dot, so all three move together on whichever
     presentation is up. */
  function renderShotOverlays(pos, model, proj) {
    function project(pt) { return pt && proj ? proj.toScreen(pt) : null; }
    var act = aimingShot();
    /* The engine's cluster rings, computed in lat/lng, projected here (the
       model itself came from renderPosition; project() no-ops without a
       published surface, so rings only draw when one exists). The drag
       handle sits on the engine's render centre (aim offset and bag roof
       included), falling back to the raw target off-surface. */
    var svg = document.getElementById("bubbleSvg");
    if (svg) {
      var parts = [];
      /* Wind drift: aim → the wind-drifted landing point, exactly the legacy
         dashed line. Independent of the bubble rings — draws whenever wind is
         active, even before a bag exists to render a bubble at all. */
      var eng = window.GDBubbleEngine;
      var windLanding = eng && typeof eng.windLanding === "function" ? eng.windLanding() : null;
      if (windLanding && act && act.target) {
        var windTargetScreen = project(act.target), windLandingScreen = project(windLanding);
        if (windTargetScreen && windLandingScreen) {
          parts.push('<path class="windLine" d="M' + windTargetScreen.left.toFixed(1) + "," + windTargetScreen.top.toFixed(1)
            + "L" + windLandingScreen.left.toFixed(1) + "," + windLandingScreen.top.toFixed(1) + '"/>');
        }
      }
      var centerScreen = model ? project(model.center) : null;
      if (model && centerScreen) {
        var ringPaths = ["outer", "main", "inner"].map(function (ringName) {
          var pts = model.rings[ringName].map(project).filter(Boolean);
          if (pts.length < model.rings[ringName].length * 0.6) return null;
          return { name: ringName, d: "M" + pts.map(function (p) { return p.left.toFixed(1) + "," + p.top.toFixed(1); }).join("L") + "Z" };
        }).filter(Boolean);
        if (ringPaths.length === 3) {
          var vw = window.innerWidth, vh = window.innerHeight;
          /* The aim line: player to the AIM TARGET. The bubble is NOT on this
             line — the engine offsets the cluster centre off the aim by the
             payload's aimOffsetM (face-alignment tendency), forward bias and
             bag roof, so the line ends at the aim point and the cluster
             hangs beside it. Computed fresh in screen space every pass so it
             moves exactly as smoothly as the rings do. */
          var playerScreen = pos ? project(pos) : null;
          var targetScreen = act && act.target ? project(act.target) : null;
          /* "Show aim line: Off" drops only this ray — the cluster, the
             middle guide and the layup context all still draw. */
          var wantAimLine = !app.gpsSettings || app.gpsSettings.aimLine();
          if (wantAimLine && playerScreen && targetScreen) {
            var dx = targetScreen.left - playerScreen.left, dy = targetScreen.top - playerScreen.top;
            var len = Math.hypot(dx, dy);
            if (len > 12) {
              var ux = dx / len, uy = dy / len;
              parts.push('<path class="aimLine" d="M' + playerScreen.left.toFixed(1) + "," + playerScreen.top.toFixed(1)
                + "L" + (playerScreen.left + ux * (len - 6)).toFixed(1) + "," + (playerScreen.top + uy * (len - 6)).toFixed(1) + '"/>');
            }
          }
          /* The middle guide: bubble → green, laying up only (the green sits
             beyond the bag and beyond the bubble). Same rule as the old
             gdShouldShowMiddleDistanceGuide, same trims and label offset. */
          var rec = current.rec || {};
          var greenScreen = rec.green ? project(rec.green) : null;
          var maxCarry = window.GDBubbleEngine ? window.GDBubbleEngine.maxPlayableCarryM() : null;
          if (pos && greenScreen && Number.isFinite(maxCarry)) {
            var raw = app.distance.haversineMeters(pos, rec.green);
            var playable = app.distance.haversineMeters(pos, model.center);
            var gap = app.distance.haversineMeters(model.center, rec.green);
            if (raw > maxCarry + 3 && gap > 4 && raw > playable + 4) {
              /* The fairway line: the hole's route geometry — the line the
                 layup target grabs onto — plus the green outline reference.
                 Layup context specs from gdAddMappedReferenceGeometry. */
              var routePts = [rec.tee].concat(rec.route || [], [rec.green])
                .filter(Boolean).map(project).filter(Boolean);
              if (routePts.length >= 2) {
                parts.unshift('<path class="fairwayLine" d="M' + routePts.map(function (p) {
                  return p.left.toFixed(1) + "," + p.top.toFixed(1);
                }).join("L") + '"/>');
              }
              /* The layup context used to trace the green outline here too
                 (gdAddMappedReferenceGeometry's green reference). Dropped for
                 the same reason as the Leaflet outline: laying up, the green
                 is a long way up the screen and already visible in the
                 imagery, so an extra ring around it is clutter. The middle
                 guide's "Green Xm" label is what actually answers the layup
                 question, and it stays. */
              var gx = greenScreen.left - centerScreen.left, gy = greenScreen.top - centerScreen.top;
              var glen = Math.hypot(gx, gy) || 1;
              var trim = Math.min(10, glen * 0.05);
              var gux = gx / glen, guy = gy / glen;
              parts.push('<path class="middleGuide" d="M' + (centerScreen.left + gux * trim).toFixed(1) + "," + (centerScreen.top + guy * trim).toFixed(1)
                + "L" + (greenScreen.left - gux * trim).toFixed(1) + "," + (greenScreen.top - guy * trim).toFixed(1) + '"/>');
              var lx = centerScreen.left + gx * 0.52 + (-gy / glen) * 18;
              var ly = centerScreen.top + gy * 0.52 + (gx / glen) * 18;
              parts.push('<text class="middleGuideLabel" x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '">Green '
                + (app.gpsSettings ? app.gpsSettings.format(gap) : Math.round(gap) + "m") + "</text>");
            }
          }
          ringPaths.forEach(function (p) {
            var cls = "ring" + p.name.charAt(0).toUpperCase() + p.name.slice(1);
            parts.push('<path class="' + cls + '" d="' + p.d + '"/>');
          });
        }
      }
      svg.classList.toggle("hiddenState", !parts.length);
      if (parts.length) {
        svg.setAttribute("viewBox", "0 0 " + window.innerWidth + " " + window.innerHeight);
        svg.innerHTML = parts.join("");
      } else if (svg.innerHTML) {
        /* Hiding the <svg> used to be the whole cleanup, which left the last
           frame's paths sitting in the DOM — invisible, but ready to flash
           back the moment anything un-hid it, and misleading to anyone
           inspecting the overlay. Nothing to draw means nothing there. */
        svg.innerHTML = "";
      }
    }
    /* The drag hit covers the CLUSTER: grab the bubble anywhere to drag the
       aim. Sized to the projected main ring's bounding box (44px minimum for
       fingers), centred on the cluster centre. */
    var bubble = document.getElementById("aimBubble");
    if (bubble) {
      var hit = null;
      if (model && centerScreen) {
        var mainPts = model.rings.main.map(project).filter(Boolean);
        if (mainPts.length > 8) {
          var minL = Infinity, maxL = -Infinity, minT = Infinity, maxT = -Infinity;
          mainPts.forEach(function (p) {
            if (p.left < minL) minL = p.left; if (p.left > maxL) maxL = p.left;
            if (p.top < minT) minT = p.top; if (p.top > maxT) maxT = p.top;
          });
          hit = { w: Math.max(44, maxL - minL), h: Math.max(44, maxT - minT) };
        }
      }
      bubble.classList.toggle("hiddenState", !hit);
      if (hit) {
        bubble.style.left = centerScreen.left + "px";
        bubble.style.top = centerScreen.top + "px";
        bubble.style.width = hit.w + "px";
        bubble.style.height = hit.h + "px";
      }
    }
    var ring = document.getElementById("greenRing");
    if (ring) {
      var rec = current.rec || {};
      var greenAt = frameStage === "zoom" ? project(rec.green) : null;
      ring.classList.toggle("hiddenState", !greenAt);
      if (greenAt) { ring.style.left = greenAt.left + "px"; ring.style.top = greenAt.top + "px"; }
    }
  }

  /* A live fix only starts driving position once it's confirmed to be
     actually at the golf course — checked once per round against the course
     centre, not per hole (so it isn't re-litigated, and wrongly rejected,
     while walking between holes). Off-course (testing from the couch, or the
     centre being unknown because the hand-off didn't carry one), the fix is
     simply ignored and head-to-tee / tap-to-stand keep driving — an
     unverified fix is never trusted as a fallback position. Once confirmed,
     every subsequent fix this round is trusted without re-checking distance:
     the player is expected to move around the course. */
  var liveAtCourse = false;
  function maybeAdoptGpsFix(fix) {
    if (!fix) return;
    /* Pinned to the tee: the player told us where they are, and a live fix
       does not get to argue with that. */
    if (placement === "tee") return;
    if (liveAtCourse) { app.position.set(fix, "gps"); return; }
    var centre = current.centre;
    if (!centre) return;
    var away = app.distance.haversineMeters(fix, centre);
    if (!Number.isFinite(away) || away > GPS_ADOPT_RADIUS_M) return;
    liveAtCourse = true;
    app.position.set(fix, "gps");
  }

  function wirePosition() {
    if (positionWired) return;
    positionWired = true;
    /* Shot advance runs BEFORE the render listener so the frame and overlays
       see the updated shot. Deliberate placements only — a passive GPS fix
       moves the dot, never the shot; "shotend" is the Shot End button
       promoting the current fix into a deliberate one. The default aim is the
       ENGINE's target rule: the green when the max bag distance reaches it,
       the fairway layup point when it cannot. */
    app.position.onChange(function (pos) {
      /* Every deliberate placement is a lock-in: it closes the previous shot
         at this point and starts the next one from here. "lock" is the dock
         button; tap and tee are the pill and the map, which lock in by the
         act of placing you. */
      if (pos && (pos.source === "tap" || pos.source === "tee"
        || pos.source === "shotend" || pos.source === "lock")) {
        shotLocked = true;
        var green = current.rec && current.rec.green;
        var target = green || null;
        if (green && window.GDBubbleEngine) {
          window.GDBubbleEngine.setShot(pos, null);
          target = window.GDBubbleEngine.targetForGreenCentre(green, { hole: current.hole }) || green;
        }
        app.shot.place(pos, target);
      }
    });
    app.position.onChange(renderPosition);
    if (app.gps) app.gps.onFix(maybeAdoptGpsFix);
    /* A pin placement/clear re-renders immediately — same render path as a
       position change, just without one. */
    if (app.pin) app.pin.onChange(function () { renderPosition(app.position.current()); });
    /* A GPS setting change re-renders the same way. Units and the aim line
       only need a repaint; shot-up and tightness change the frame itself, so
       the held frame is dropped first to force a re-solve. */
    if (app.gpsSettings) app.gpsSettings.onChange(function () {
      activeFrame = null;
      mapSide = null;
      renderPosition(app.position.current());
    });
    /* Aim changes sync the engine, then re-render (re-frame unless mid-drag). */
    app.shot.onChange(function () {
      var act = app.shot.active();
      if (window.GDBubbleEngine) window.GDBubbleEngine.setShot(act && act.start, act && act.target);
      renderPosition(app.position.current());
    });
    /* The engine's pixel caps see the real on-screen scale through this seam —
       on either presentation, so the bubble is clamped the same way on the
       live map as on a published surface. */
    if (window.GDBubbleEngine) window.GDBubbleEngine.setProjection({
      toScreen: function (ll) {
        var proj = projector();
        var screen = proj ? proj.toScreen(ll) : null;
        return screen ? { x: screen.left, y: screen.top } : null;
      },
      viewSize: function () { return { x: window.innerWidth, y: window.innerHeight }; }
    });

    /* Dragging the aim bubble. The tilt flattens while dragging (CSS on
       body.bubble-dragging) so the 2D frame inverse stays exact; the camera
       holds until release, then re-frames start→target. */
    var bubble = document.getElementById("aimBubble");
    var bubbleDragOffset = null;   // grab offset: aim screen point − finger, held for the drag
    function endBubbleDrag() {
      bubbleDragOffset = null;
      if (!document.body.classList.contains("bubble-dragging")) return;
      document.body.classList.remove("bubble-dragging");
      renderPosition(app.position.current());
    }
    if (bubble) {
      bubble.addEventListener("pointerdown", function (e) {
        var act = app.shot.active();
        var proj = projector();
        if (!act || !act.target || !proj) return;
        /* DELTA dragging: the cluster centre sits offset from the aim (aim
           offset, forward bias, bag roof), so grabbing it must not snap the
           aim to the finger — remember the grab offset and move the aim by
           the drag delta. */
        var targetScreen = proj.toScreen(act.target);
        if (!targetScreen) return;
        bubbleDragOffset = { x: targetScreen.left - e.clientX, y: targetScreen.top - e.clientY };
        /* Capture keeps the drag alive when the finger outruns the hit; if it
           is unavailable the hit re-centres under the finger every render, so
           dragging still works — a capture failure must not kill the drag. */
        try { bubble.setPointerCapture(e.pointerId); } catch (err) {}
        document.body.classList.add("bubble-dragging");
        e.preventDefault();
      });
      bubble.addEventListener("pointermove", function (e) {
        if (!document.body.classList.contains("bubble-dragging") || !bubbleDragOffset) return;
        var proj = projector();
        if (!proj) return;
        var ll = proj.toLatLng({ left: e.clientX + bubbleDragOffset.x, top: e.clientY + bubbleDragOffset.y });
        if (ll) app.shot.aim(ll);
      });
      bubble.addEventListener("pointerup", endBubbleDrag);
      bubble.addEventListener("pointercancel", endBubbleDrag);
    }

    /* Dragging the placed pin — same delta-based technique as the aim bubble,
       so it works under the published surface's lock tilt and under the live
       map's frame rotation alike. Both presentations use this one path now;
       the live map's old Leaflet draggable marker is gone. */
    var pinMarkerEl = document.getElementById("pinMarker");
    var pinDragOffset = null;
    function endPinDrag() {
      pinDragOffset = null;
      if (!document.body.classList.contains("pin-dragging")) return;
      document.body.classList.remove("pin-dragging");
      renderPosition(app.position.current());
    }
    if (pinMarkerEl) {
      pinMarkerEl.addEventListener("pointerdown", function (e) {
        var pin = app.pin && app.pin.current();
        var proj = projector();
        if (!pin || !proj) return;
        var pinScreen = proj.toScreen(pin);
        if (!pinScreen) return;
        pinDragOffset = { x: pinScreen.left - e.clientX, y: pinScreen.top - e.clientY };
        try { pinMarkerEl.setPointerCapture(e.pointerId); } catch (err) {}
        document.body.classList.add("pin-dragging");
        e.preventDefault();
      });
      pinMarkerEl.addEventListener("pointermove", function (e) {
        if (!document.body.classList.contains("pin-dragging") || !pinDragOffset) return;
        var proj = projector();
        if (!proj) return;
        var ll = proj.toLatLng({ left: e.clientX + pinDragOffset.x, top: e.clientY + pinDragOffset.y });
        if (ll) app.pin.set(ll);
      });
      pinMarkerEl.addEventListener("pointerup", endPinDrag);
      pinMarkerEl.addEventListener("pointercancel", endPinDrag);
    }

    /* Dragging the green-focus ball. Same delta technique as the pin and the
       aim bubble, with one difference: a PARKED ball has no map anchor to
       take a delta from, so the first drag drops it straight under the finger
       — that is the whole "pick it up and put it where the shot finished"
       gesture. Once it is on the map it drags by delta like everything else. */
    var ballEl = document.getElementById("greenFocusBall");
    var ballDragOffset = null;
    function endBallDrag() {
      ballDragOffset = null;
      if (!document.body.classList.contains("ball-dragging")) return;
      document.body.classList.remove("ball-dragging");
      if (ballEl) ballEl.classList.remove("dragging");
      renderPosition(app.position.current());
    }
    if (ballEl) {
      ballEl.addEventListener("pointerdown", function (e) {
        if (!greenFocus) return;
        var proj = projector();
        if (!proj) return;
        var at = greenFocus.ball ? proj.toScreen(greenFocus.ball) : null;
        var parked = ballEl.classList.contains("parked");
        ballDragOffset = (!parked && at)
          ? { x: at.left - e.clientX, y: at.top - e.clientY }
          : { x: 0, y: 0 };
        try { ballEl.setPointerCapture(e.pointerId); } catch (err) {}
        document.body.classList.add("ball-dragging");
        ballEl.classList.add("dragging");
        e.preventDefault();
        e.stopPropagation();
      });
      ballEl.addEventListener("pointermove", function (e) {
        if (!document.body.classList.contains("ball-dragging") || !greenFocus || !ballDragOffset) return;
        var proj = projector();
        if (!proj) return;
        var ll = proj.toLatLng({ left: e.clientX + ballDragOffset.x, top: e.clientY + ballDragOffset.y });
        if (!ll) return;
        greenFocus.ball = ll;
        greenFocus.placed = true;   // yours now: it stops following the fix
        renderPosition(app.position.current());
      });
      ballEl.addEventListener("pointerup", endBallDrag);
      ballEl.addEventListener("pointercancel", endBallDrag);
    }

    /* Shot End: "this is where that shot finished" using the freshest fix
       available — the freshest device GPS fix if there is one, else the
       player's current position (the map-tap fallback, off-course testing
       included). Promoting it with source "shotend" is what makes it a
       deliberate placement; app.position.set does the rest through the
       onChange wiring above, same as a tap.

       This is the ONLY confirm button now. Hole Out used to sit beside it in
       green focus, but once the ball became the thing being confirmed the two
       were the same action on the same point — so Shot End carries both
       meanings: end this shot, and in green focus that ends the hole. */
    var shotAction = document.getElementById("shotActionBtn");
    if (shotAction) shotAction.addEventListener("click", function () {
      var action = currentShotAction();

      /* Green focus: the BALL is where the shot finished, not the raw fix —
         that is the entire point of letting it be dragged. Confirming holes
         out and moves on, so green focus never outlives the hole. */
      if (action.key === "end") {
        app.shot.holeOut(shotEndPoint());
        app.play.nextHole();
        return;
      }

      /* Unlock: give the view back without giving the shot back. The position
         is cleared so pre-frame is genuinely pre-frame — off-course that
         brings the tee/tap pill up again, and when actually playing the next
         GPS fix lands straight away and the dot simply moves along the map.
         The in-flight shot is untouched: its start is still the last lock-in,
         and the next lock closes it. The pill choice is reopened too, since
         being back at the pill and unable to change your mind would be a
         dead end. */
      if (action.key === "unlock") {
        shotLocked = false;
        placement = null;
        startPillDismissed = false;
        app.position.clear();
        renderPosition(null);
        return;
      }

      /* Lock in here. Pinned to the tee, the freshest fix is exactly what the
         player told us to ignore, so lock the dot where it actually is. */
      var fix = placement === "tee"
        ? app.position.current()
        : (app.gps && app.gps.lastFix()) || app.position.current();
      if (!fix) return;
      shotLocked = true;
      app.position.set(fix, "lock");
    });
    /* Lock/Unlock: freeze the camera so it can't be bumped mid-shot. */
    var lockToggle = document.getElementById("lockToggleBtn");
    if (lockToggle) lockToggle.addEventListener("click", function () {
      setViewLocked(!viewLocked);
    });
    /* The start pill: Head To the Tee places the player on the tee; Standing
       Here dismisses the pill so a surface tap places them. */
    var headToTee = document.getElementById("headToTeeBtn");
    if (headToTee) headToTee.addEventListener("click", function () {
      if (!(current.rec && current.rec.tee)) return;
      placement = "tee";
      app.position.set(current.rec.tee, "tee");
    });
    var standingHere = document.getElementById("standingHereBtn");
    if (standingHere) standingHere.addEventListener("click", function () {
      placement = "standing";
      startPillDismissed = true;
      renderPosition(app.position.current());
    });
    /* The provenance chip toggles the full metadata panel. */
    var chip = document.getElementById("surfaceSource");
    var panel = document.getElementById("surfaceMetaPanel");
    if (chip && panel) chip.addEventListener("click", function () {
      panel.classList.toggle("hiddenState");
      if (!panel.classList.contains("hiddenState")) panel.textContent = JSON.stringify(provenance, null, 2);
    });
    /* Tap where you are standing, on the published surface. Framed mode
       inverts the frame transform (viewport coords — the play screen fills
       it); contain mode inverts the letterbox fit. */
    var img = document.getElementById("surfaceImage");
    if (img) img.addEventListener("click", function (e) {
      if (!img.dataset.playSurface) return;
      try {
        var meta = JSON.parse(img.dataset.playSurface);
        var tapped = null;
        if (activeFrame) {
          /* offsetX/Y are the browser's own inverse projection into the
             element's local space — image pixels directly, and correct even
             under the lock tilt where a 2D matrix inverse would not be. */
          var px = { x: e.offsetX, y: e.offsetY };
          var w = Number(meta.outputDimensions.width), h = Number(meta.outputDimensions.height);
          if (px.x >= 0 && px.y >= 0 && px.x <= w && px.y <= h) {
            tapped = surfaceLib.latLngFromWorldPx(
              { x: Number(meta.originPx.x) + px.x, y: Number(meta.originPx.y) + px.y },
              Number(meta.captureZoom));
          }
        } else {
          var rect = img.getBoundingClientRect();
          tapped = surfaceLib.surfaceScreenToLatLng(meta,
            { left: e.clientX - rect.left, top: e.clientY - rect.top },
            { width: rect.width, height: rect.height });
        }
        if (tapped) {
          if (app.pin && app.pin.armed()) { app.pin.set(tapped); app.pin.disarm(); return; }
          if (!tapCanPlacePlayer()) return;
          app.position.set(tapped, "tap");
        }
      } catch (err) {}
    });
    /* Re-frame on viewport changes — event-driven, no polling. Dropping the
       held frame forces a recompute at the new dimensions; the live map's
       over-provisioned square is re-solved from the new diagonal by the same
       pass, so both presentations re-frame off this one listener. */
    window.addEventListener("resize", function () {
      activeFrame = null;
      mapSide = null;
      renderPosition(app.position.current());
    });
  }

  var provenance = null;   // what is on screen and where it came from
  var activeFrame = null;  // the current stage's frame transform, null → contain fit
  var frameStage = "hole"; // hole | lock | zoom
  var startPillDismissed = false;   // "Standing Here" chosen: tap places the player

  /* How the player's position is being decided on this hole — the start
     pill's choice, and it STICKS. null (nothing chosen yet) keeps the old
     behaviour: an on-course fix is adopted and a tap places you.

     "tee" is a pin, not a starting nudge: the player said they are on the
     tee, so the position holds that coordinate and neither a passing GPS fix
     nor a stray tap moves it. Pinning the coordinate rather than a screen
     point is what keeps it smooth — the dot lands on the tee guide box
     because the frame anchors it there, so it stays put through every
     re-frame, rotation and stage change instead of being re-pinned each pass.
     Changing your mind means leaving the hole and picking the other option;
     goHole clears this. */
  var placement = null;   // null | "tee" | "standing"

  /* Tapping to say "I am standing here" is MANUAL play — the fallback the
     legacy app announced as "Tap twice: ball then green" (gd-app-core's
     gdMappedStartHint) on a hole with no mapped geometry, where tapping the
     green is the only way to tell it where the green is. On a geo-mapped
     hole the tee and green come from the course package and the player comes
     from GPS, so a tap — on the green especially — has nothing left to say,
     and silently teleporting the player is worse than ignoring it.

     It stays reachable exactly where it is still the right answer: on a hole
     with no mapped green, where manual play is all there is, and after an
     explicit "Standing Here", which IS the player choosing to place
     themselves. Placing the pin is unaffected; that is a real per-day fact
     no package can carry. */
  function tapCanPlacePlayer() {
    if (placement === "standing") return true;
    if (placement === "tee") return false;
    return !(current.rec && current.rec.green);
  }

  var ZOOM_GREEN_M = 40;   // inside this of the green centre → green focus

  /* Green focus, ported from the legacy gdEnterActiveGreenFocus /
     gdEnsureGreenFocusBall pair. Inside 40m of the green the position dot
     becomes a golf ball you can drag to where the shot actually finished —
     the fix is rarely exact once you are standing over it — and Shot End
     confirms that spot.

     It is STICKY. Walking back out of 40m does not close it, because the
     whole point is being able to do the placement later, from the next tee:
     the camera keeps holding the green you are logging (you cannot drag a
     ball onto a green that is not on screen). Only Shot End or leaving the
     hole ends it.

     ball    — where the shot finished, once known. Follows the live fix while
               you are still on the green and have not touched it; the moment
               you drag, it is yours and stops following.
     placed  — the drag happened, so stop tracking the fix.
     The legacy screen-point fallback (gdGreenFocusScreenPoint) becomes the
     "parked" state: no meaningful map anchor, so the ball waits at a fixed
     pickup point to be dragged onto the green. */
  var greenFocus = null;   // null | { ball: {lat,lng}|null, placed: bool }

  /* Is a shot locked in? Locking is what starts a shot and what closes the
     previous one — the course data only ever needs the last lock-in joined to
     the next lock-in, so every lock-in is a shot boundary and the walking in
     between is not recorded.

     Unlocking does NOT undo the lock-in. It releases the view back to
     pre-frame — the start pill off-course, a freely moving GPS dot when
     actually playing — while the shot stays in flight with its start where
     you locked it. The next lock closes it. That is why unlock is safe to
     press: it costs you the camera, never the shot. */
  var shotLocked = false;

  /* Which stage the current position asks for. Placing the player IS the
     lock-in — head-to-tee or a tap starts the shot, so any position locks the
     shot view. The pre-locked hole frame exists only while the start pill is
     up (no position yet); the green zoom takes over inside 45m. */
  function desiredStage(pos) {
    var rec = current.rec;
    /* Sticky: once green focus is open it owns the camera until Shot End or
       a hole change, even after the player has walked away. */
    if (greenFocus) return "zoom";
    if (!pos || !rec || !rec.green) return "hole";
    var toGreen = app.distance.haversineMeters(pos, rec.green);
    if (Number.isFinite(toGreen) && toGreen <= ZOOM_GREEN_M) return "zoom";
    /* Unlocked is the pre-frame view: the hole framed, the dot free to move
       along it. Only a lock-in earns the locked shot view. */
    if (!shotLocked) return "hole";
    return "lock";
  }

  /* Distance from the green centre, or null when either end is unknown. */
  function metresFromGreen(pos) {
    var green = current.rec && current.rec.green;
    if (!pos || !green) return null;
    var d = app.distance.haversineMeters(pos, green);
    return Number.isFinite(d) ? d : null;
  }

  /* Open green focus on arrival, and keep the ball under the live fix until
     the player takes hold of it. Called from the render pass, so it follows
     position the same event-driven way everything else here does. */
  function updateGreenFocus(pos) {
    var away = metresFromGreen(pos);
    if (!greenFocus) {
      if (away === null || away > ZOOM_GREEN_M) return;
      greenFocus = { ball: pos ? { lat: pos.lat, lng: pos.lng } : null, placed: false };
      return;
    }
    /* Not placed yet: the ball is still just "where you are", so it tracks
       the fix while that still means something. Off the green it stops
       tracking and parks (renderGreenFocusBall decides that from `away`). */
    if (!greenFocus.placed && pos && away !== null && away <= ZOOM_GREEN_M) {
      greenFocus.ball = { lat: pos.lat, lng: pos.lng };
    }
  }

  /* Where the ball says the shot finished — the placed/tracked point, or the
     player's own position if green focus never opened. */
  function shotEndPoint() {
    if (greenFocus && greenFocus.ball) return greenFocus.ball;
    return app.position.current();
  }

  /* The dock button's three faces. One control in the same place, because at
     any moment there is exactly one thing to do with the shot:

       green focus  → Shot End: the ball is where it finished, confirm it
       locked in    → Unlock Shot: release the view, keep the shot
       otherwise    → Lock: lock in here, closing the previous shot

     Coin art is per face; a face whose asset is missing falls back to its
     label (the .noIcon class) rather than rendering a broken image. */
  var SHOT_ACTIONS = {
    zoom:     { key: "end",    label: "Shot End",    aria: "Shot End",
                icon: "../assets/home/clarity-caddy-shot-end-icon.png?v=0b094e11" },
    unlock:   { key: "unlock", label: "Unlock Shot", aria: "Unlock Shot",
                icon: "../assets/home/clarity-caddy-unlock-shot-icon.png" },
    lock:     { key: "lock",   label: "Lock",        aria: "Lock in the shot",
                icon: "../assets/home/clarity-caddy-lock-shot-icon.png" }
  };

  function currentShotAction() {
    if (greenFocus) return SHOT_ACTIONS.zoom;
    if (shotLocked) return SHOT_ACTIONS.unlock;
    return SHOT_ACTIONS.lock;
  }

  function renderShotAction() {
    var btn = document.getElementById("shotActionBtn");
    if (!btn) return;
    /* Lock needs somewhere to lock in FROM, so it waits for a position.
       Unlock and Shot End always have one by definition. */
    var action = currentShotAction();
    var usable = action.key !== "lock" || !!app.position.current();
    btn.classList.toggle("hiddenState", !usable);
    /* The face is kept current even while hidden, so the button never comes
       back wearing the previous coin for a frame. */
    if (btn.dataset.action === action.key) return;
    btn.dataset.action = action.key;
    btn.setAttribute("aria-label", action.aria);
    var label = document.getElementById("shotActionLabel");
    if (label) label.textContent = action.label;
    var icon = document.getElementById("shotActionIcon");
    if (!icon) return;
    btn.classList.remove("noIcon");
    icon.onerror = function () { btn.classList.add("noIcon"); };
    icon.src = action.icon;
  }

  /* The active shot ONLY while it is still being aimed. A shot stays active
     through green focus — it is the one being confirmed — but by then there
     is nothing left to aim: you are standing on the green. Asking the engine
     to model a shot from there produces nonsense, because it answers the
     question it was asked: shortest club in the bag, and a bag-roof clamp
     that throws the cluster centre tens of metres past the green. What
     reached the screen was a bubble anchored near the green and a "LW 11m /
     carry 66" row for a shot nobody is playing.

     So every aiming instrument — rings, aim line, wind drift, middle guide,
     layup context, the drag hit and the shot row — hangs off this rather
     than off app.shot.active(). The green ring, the ball, the pin and the
     front/back distances are not aiming instruments and stay. */
  function aimingShot() {
    if (greenFocus) return null;
    return (app.shot && app.shot.active()) || null;
  }

  var PARK_AT_M = ZOOM_GREEN_M;   // beyond this with the ball unplaced → park it

  /* The ball, and the prompt that goes with it when parked. Hidden entirely
     outside green focus, where the plain position dot is the right marker. */
  function renderGreenFocusBall(pos, proj) {
    var ball = document.getElementById("greenFocusBall");
    var hint = document.getElementById("greenFocusHint");
    if (!ball) return false;
    if (!greenFocus) {
      ball.classList.add("hiddenState");
      ball.classList.remove("parked");
      if (hint) hint.classList.add("hiddenState");
      return false;
    }
    var away = metresFromGreen(pos);
    /* Park when the ball has no anchor worth drawing: never placed and the
       player has left the green (the next-tee case), or it simply cannot be
       projected into the current frame. */
    var screen = greenFocus.ball && proj ? proj.toScreen(greenFocus.ball) : null;
    var parked = !screen || (!greenFocus.placed && (away === null || away > PARK_AT_M));
    ball.classList.remove("hiddenState");
    ball.classList.toggle("parked", parked);
    if (!parked) {
      ball.style.left = screen.left + "px";
      ball.style.top = screen.top + "px";
    } else {
      ball.style.left = "";
      ball.style.top = "";
    }
    if (hint) hint.classList.toggle("hiddenState", !parked);
    return true;
  }

  /* Publishing the stage is what drives the stage-gated chrome — Hole Out
     lives on body[data-frame-stage="zoom"], and Shot End reads frameStage to
     decide that ending a shot in green focus IS holing out. Both camera paths
     go through here, which is what gives the live map those behaviours: it
     used to be set only while a surface was published, so on the live map the
     stage was permanently "hole" and Hole Out never appeared. */
  function setStage(stage) {
    frameStage = stage;
    document.body.dataset.frameStage = frameStage;
    document.body.classList.toggle("tilt-lock", frameStage === "lock");
  }

  /* Frame the surface for the stage the position asks for. Anchors prefer the
     surface's own anchorPins, then the hole geometry; with neither the
     contain fit still shows the whole image. The lock tilt is a viewport
     class — the matrix stays 2D so dot and tap projections remain exact.

     "Lock" means the frame LOCKS: it is captured on hole entry, on a
     deliberate placement (tap / head-to-tee), on a stage boundary crossing,
     and on resize. A GPS fix that stays inside the current stage moves the
     dot only — the camera does not re-anchor under a walking player. */
  function applySurfaceFrame(meta, pos) {
    var img = document.getElementById("surfaceImage");
    if (!img || !meta) return;
    var stage = desiredStage(pos);
    var holdFrame = activeFrame && stage === frameStage
      && (document.body.classList.contains("bubble-dragging") || document.body.classList.contains("ball-dragging")
        || viewLocked || (pos && pos.source === "gps"));
    setStage(stage);
    if (holdFrame) return;
    var view = { width: window.innerWidth, height: window.innerHeight };
    var pins = meta.anchorPins || {};
    var rec = current.rec || {};
    var act = app.shot && app.shot.active();
    var pts = {
      tee: pins.tee || rec.tee || null,
      green: pins.green || rec.green || null,
      greenShape: (Array.isArray(pins.greenShape) && pins.greenShape.length ? pins.greenShape : rec.greenShape) || [],
      position: pos || null,
      target: (act && act.target) || null
    };
    activeFrame = surfaceLib.stageFrameTransform(meta, frameStage, pts, view, {
      lockTightness: app.gpsSettings ? app.gpsSettings.lockTightness() : 1
    });
    /* "Shot-up frame: Off" — same setting, same meaning on the surface: keep
       the stage's scale and centring, drop the rotation. */
    if (activeFrame && app.gpsSettings && !app.gpsSettings.shotUp()) {
      activeFrame = surfaceLib.flattenFrame(activeFrame, view);
    }
    if (activeFrame) {
      img.style.width = Number(meta.outputDimensions.width) + "px";
      img.style.height = Number(meta.outputDimensions.height) + "px";
      img.style.transformOrigin = "0 0";
      /* CSS matrix(a,b,c,d,e,f): x'=a·x+c·y+e, y'=b·x+d·y+f — our similarity
         with c=-b, d=a. */
      img.style.transform = "matrix(" + activeFrame.a + "," + activeFrame.b + "," + (-activeFrame.b) + "," + activeFrame.a + "," + activeFrame.tx + "," + activeFrame.ty + ")";
    } else {
      img.style.width = ""; img.style.height = "";
      img.style.transform = ""; img.style.transformOrigin = "";
    }
  }

  function renderProvenance() {
    var chip = document.getElementById("surfaceSource");
    var panel = document.getElementById("surfaceMetaPanel");
    if (!chip) return;
    var shown = !!provenance && document.body.classList.contains("surface-published");
    chip.classList.toggle("hiddenState", !shown);
    if (!shown) { if (panel) panel.classList.add("hiddenState"); return; }
    chip.textContent = surfaceLib.provenanceLabel(provenance);
    if (panel && !panel.classList.contains("hiddenState")) {
      panel.textContent = JSON.stringify(provenance, null, 2);
    }
  }

  function clearSurface() {
    document.body.classList.remove("surface-published");
    var img = document.getElementById("surfaceImage");
    if (img) {
      img.removeAttribute("src");
      img.dataset.playSurface = "";
      img.style.width = ""; img.style.height = "";
      img.style.transform = ""; img.style.transformOrigin = "";
    }
    activeFrame = null;
    /* Not reset to "hole" here: renderPosition below immediately re-solves the
       stage for the live map from the same position, and blanking it first
       would flicker Hole Out off and back on mid-round. */
    provenance = null;
    renderProvenance();
    renderPosition(app.position.current());
  }

  /* The live map is the fallback presentation: created (frameHole) the moment
     absence or failure is the answer for this hole — never earlier, so OSM no
     longer flashes under a surface that was always going to present. */
  function surfaceFallback() {
    clearSurface();
    frameHole(current.rec);
  }

  /* origin: "package" (inline in the course package) or "visuals" (the
     course-visuals endpoint fallback). The image is preloaded off-DOM and the
     visible img swaps only when it is decodable, so the previous hole's
     surface holds until the new one paints — no map in between. The token pins
     the load to the hole transition that asked for it: a slow older image
     resolving after the player moved on must not flash in over the current
     hole. The stall timer is bounded, transition-scoped, and cancelled by
     settle or supersession — it exists so a hung request cannot leave the
     player without any presentation (that would be the old blackout bug). */
  function presentSurface(asset, origin) {
    var img = document.getElementById("surfaceImage");
    if (!img) return;
    var token = transitionToken;
    var url = asset.url || surfaceLib.assetUrl(asset.path);
    var startedAt = Date.now();
    var settled = false;
    var stallTimer = setTimeout(function () {
      if (settled || token !== transitionToken) return;
      settled = true;
      surfaceFallback();
    }, 8000);
    var pre = new Image();
    pre.onload = function () {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      if (token !== transitionToken) return;   // superseded: drop silently
      img.dataset.playSurface = JSON.stringify(asset.playSurface);
      img.src = url;   // decoded already — paints without a blank frame
      provenance = {
        origin: origin,
        url: url,
        courseKey: current.courseKey,
        holeNumber: current.hole,
        loadMs: Date.now() - startedAt,
        naturalSize: pre.naturalWidth + "×" + pre.naturalHeight,
        loadedAt: new Date().toISOString(),
        playSurface: asset.playSurface
      };
      document.body.classList.add("surface-published");
      renderProvenance();
      renderPosition(app.position.current());
    };
    pre.onerror = function () {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      if (token === transitionToken) surfaceFallback();
    };
    pre.src = url;
  }

  app.play = {
    /* centre: {lat,lng} from the library row — the view when the package has no
       geometry for a hole yet, so an unmapped course still opens on itself. */
    /* centre: {lat,lng} from the library row — the view when the package has no
       geometry for a hole yet, so an unmapped course still opens on itself.
       No map is created here: the hole decides its own presentation. */
    async start(courseKey, pkg, centre) {
      transitionToken += 1;
      liveAtCourse = false;
      var lat = Number(centre && centre.lat), lng = Number(centre && centre.lng);
      current = {
        courseKey: app.courseKey(courseKey), pkg: pkg || null, hole: 0, rec: null,
        centre: Number.isFinite(lat) && Number.isFinite(lng) ? { lat: lat, lng: lng } : null,
        nines: app.nines ? app.nines.forPackage(app.courseKey(courseKey), pkg) : null
      };
      wirePosition();
      app.shot.startRound();
      if (app.pin) app.pin.startRound();
      if (app.scorecard) app.scorecard.setCourse(current.courseKey);
      if (app.gps) app.gps.start();
      await this.goHole(current.nines ? current.nines.holesInPlay[0] : 1);
    },
    async goHole(hole) {
      var token = ++transitionToken;
      setViewLocked(false);   // a new hole always opens unlocked
      if (app.undo) app.undo.clear();   // undoing into a different hole's state would be more confusing than nothing left to undo
      current.hole = Number(hole) || 1;
      current.rec = holeRecord(current.pkg, current.hole);
      var holeEl = document.getElementById("holeNumber");
      if (holeEl) holeEl.textContent = String(current.hole);
      /* Undo any focus scroll-jump from the previous hole's interactions. */
      var screen = document.getElementById("playScreen");
      if (screen) { screen.scrollTop = 0; screen.scrollLeft = 0; }
      /* Pre-frame state: the hole is framed but the player has no position —
         no pin, no distances — until the pill (Head To the Tee), a tap, or an
         on-hole GPS fix places them. Auto-head-to-tee belongs to the future
         Actually Playing mode. */
      app.position.clear();
      if (window.GDBubbleEngine && current.rec) {
        window.GDBubbleEngine.setHoleContext({
          hole: current.hole, tee: current.rec.tee, green: current.rec.green, route: current.rec.route
        });
      }
      app.shot.startHole(current.hole);
      if (app.pin) app.pin.startHole(current.hole);
      startPillDismissed = false;
      /* Leaving the hole and coming back is how you change your mind about
         the pill's choice — so the choice dies with the hole. Green focus
         goes with it: Next Hole is the other way out of it, alongside the
         Shot End that confirms the ball. */
      placement = null;
      greenFocus = null;
      shotLocked = false;   // a new hole always opens unlocked, at pre-frame
      /* Drop the held frame so the new hole solves its own. Without this a
         solve that gets skipped — the frame held under a GPS fix, or the map
         not measurable yet — leaves the PREVIOUS hole's camera in place while
         every projection quietly answers against it. */
      activeFrame = null;
      mapSide = null;
      liveFrame = IDENTITY_FRAME;
      renderPosition(null);
      if (app.gps) maybeAdoptGpsFix(app.gps.lastFix());
      /* A full package carries the hole's published surface inline — one
         request, nothing to reconcile, and no OSM underneath: the previous
         surface holds until the new one paints. The stale meta is cleared so
         the position dot waits for the new projection. */
      if (current.rec && current.rec.visual) {
        var img = document.getElementById("surfaceImage");
        if (img) img.dataset.playSurface = "";
        renderPosition(app.position.current());
        presentSurface(current.rec.visual, "package");
        return;
      }
      /* Absence path: the live map IS the presentation for this hole. */
      surfaceFallback();
      var answer = await ensureStore().surfaceFor(current.courseKey, current.hole);
      if (token !== transitionToken) return;   // superseded transition: drop silently
      if (answer.state === "published") presentSurface(answer.asset, "visuals");
      /* answer.state === "none" needs no branch: the live map is already up. */
    },
    stop() {
      transitionToken += 1;
      liveAtCourse = false;
      placement = null;
      greenFocus = null;
      shotLocked = false;
      setViewLocked(false);
      if (app.undo) app.undo.clear();
      if (app.gps) app.gps.stop();
      app.position.clear();
      clearSurface();
      clearLiveFrame();
      frameStage = "hole";
      delete document.body.dataset.frameStage;
      document.body.classList.remove("tilt-lock");
      if (objectLayer) { objectLayer.remove(); objectLayer = null; }
      current = { courseKey: null, pkg: null, hole: 0, rec: null, nines: null, centre: null };
    },
    state: function () { return { courseKey: current.courseKey, hole: current.hole, nines: current.nines }; },
    /* The live map's actual camera, for tests and for diagnosing a frame that
       does not match what is on screen. Read-only. */
    mapState: function () {
      if (!map) return null;
      try {
        var c = map.getCenter(), s = map.getSize();
        return { lat: c.lat, lng: c.lng, zoom: map.getZoom(), width: s.x, height: s.y,
          minZoom: map.getMinZoom(), maxZoom: map.getMaxZoom() };
      } catch (e) { return null; }
    },
    /* Every hole the player can jump straight to, in play order - the
       selected nines' holes when the course has more than two, otherwise
       every hole the package actually has geometry for (falling back to 18,
       the plain sequence every course used to have, if the package hasn't
       loaded yet). */
    availableHoles: function () {
      if (current.nines) return current.nines.holesInPlay;
      var holes = current.pkg && Array.isArray(current.pkg.holes) ? current.pkg.holes : [];
      var max = holes.reduce(function (m, h) { return Math.max(m, Number(h && h.holeNumber) || 0); }, 0);
      var out = [];
      for (var h = 1; h <= (max || 18); h++) out.push(h);
      return out;
    },
    /* Steps through the selected nines' holes in order when the course has
       more than two; otherwise the plain 1..18 sequence every course used
       to have. */
    nextHole: function () {
      var list = current.nines && current.nines.holesInPlay;
      if (list) {
        var idx = list.indexOf(current.hole);
        return this.goHole(idx >= 0 && idx < list.length - 1 ? list[idx + 1] : current.hole);
      }
      return this.goHole(Math.min(18, current.hole + 1));
    },
    prevHole: function () {
      var list = current.nines && current.nines.holesInPlay;
      if (list) {
        var idx = list.indexOf(current.hole);
        return this.goHole(idx > 0 ? list[idx - 1] : current.hole);
      }
      return this.goHole(Math.max(1, current.hole - 1));
    },
    /* Called from the scorecard's nine picker. Jumps to the new pairing's
       first hole only if the current hole fell outside it. */
    setNineSelection: function (ids) {
      if (!current.pkg || !app.nines) return null;
      var updated = app.nines.select(current.courseKey, current.pkg, ids);
      if (!updated) return null;
      current.nines = updated;
      if (updated.holesInPlay.indexOf(current.hole) === -1) this.goHole(updated.holesInPlay[0]);
      return updated;
    },
    /* A published map arrived after the round started (course-store's
       background freshness check). Re-frames the current hole under the new
       package so the live-map presentation switches to the downloaded
       surface without restarting the round - shot.startHole keeps a hole's
       already-recorded shots, it only clears the in-flight aim, so nothing
       already played is lost. */
    updatePackage: function (pkg) {
      if (!pkg) return;
      current.pkg = pkg;
      if (app.nines) current.nines = app.nines.forPackage(current.courseKey, pkg);
      return this.goHole(current.hole);
    },
    /* Viewport client coords → a course lat/lng, on whichever presentation is
       up — the second pin-placement method (drag the rail icon straight onto
       the map/surface and drop) needs this from outside play.js's own closure,
       since the drag gesture starts on a rail button tool-rail.js owns. Mirrors
       the surface tap handler's own projection exactly; null off either
       presentation, same "no answer" contract as everything else here. */
    latLngAt: function (clientX, clientY) {
      var proj = projector();
      if (proj) {
        var ll = proj.toLatLng({ left: clientX, top: clientY });
        if (ll) return ll;
      }
      /* Letterbox fallback: a published surface with no solved frame is shown
         contained, which the seam does not model. */
      if (document.body.classList.contains("surface-published") && !activeFrame) {
        var img = document.getElementById("surfaceImage");
        if (!img || !img.dataset.playSurface) return null;
        try {
          var meta = JSON.parse(img.dataset.playSurface);
          var rect = img.getBoundingClientRect();
          return surfaceLib.surfaceScreenToLatLng(meta,
            { left: clientX - rect.left, top: clientY - rect.top },
            { width: rect.width, height: rect.height });
        } catch (e) { return null; }
      }
      return null;
    }
  };
})();
