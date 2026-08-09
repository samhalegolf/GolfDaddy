/* The Painter — makes the Scene real.

   Design: PLAY_OWNER_CONCEPT.md §10. Replaces play.js, which decided things as
   well as drawing them; deciding is the Marshal's job now and none of it lives
   here.

   The contract, and the only rule that matters in this file:

     THE PAINTER DECIDES NOTHING.

   It receives a Scene, applies it, and turns gestures into Signals. It holds no
   play state — no mode flag, no "is a shot locked", no green-focus stickiness.
   It does hold PRESENTATION state (the Leaflet map, which surface is loaded,
   the solved camera transform), because those are facts about drawing rather
   than facts about the round, and nothing outside this file reads them.

   It also never reads state back off the DOM. `classList.contains(...)` as a
   branch is what turned the screen into a state store, and it is the habit this
   rewrite exists to retire. The one exception is gesture flags (dragging), which
   are genuinely facts about the DOM.

   Every write goes inside trace.paint(), so anything that changes a watched
   element WITHOUT coming through here shows up as a Leak (§11). */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var surfaceLib = app.playSurface;

  var marshal = null;
  var map = null;
  var objectLayer = null;
  var baseKind = null, baseLayer = null;
  var store = null;

  /* Presentation state. Not play state — the Marshal owns that. */
  var activeFrame = null;      // published surface transform, null → contain fit
  var liveFrame = { a: 1, b: 0, tx: 0, ty: 0 };
  var mapSide = null;          // over-provisioned container side, null → plain map
  var published = false;       // is a published surface currently up
  var provenance = null;
  var transitionToken = 0;
  var loadedHole = null;       // which hole's surface is presented
  var lastCameraKey = null;    // so a solved camera is not re-solved every pass
  var currentScene = null;

  var REF_ZOOM = 20;
  var refPx = surfaceLib.worldPxProjector(REF_ZOOM);
  var LIVE_GREEN_RADIUS_PX = 25 * Math.pow(2, REF_ZOOM - 18);
  var EDGE_MARGIN_PX = 26;     // how far in from the bezel a clamped dot sits
  var GESTURE_HANDLERS = ["dragging", "touchZoom", "doubleClickZoom", "scrollWheelZoom", "boxZoom", "keyboard"];

  function el(id) { return document.getElementById(id); }
  function show(node, on) { if (node) node.classList.toggle("hiddenState", !on); }
  function trace() { return app.trace || null; }

  function settings() { return app.gpsSettings || null; }
  function units(m) {
    if (m === null || !Number.isFinite(Number(m))) return "–";
    return settings() ? settings().toDisplay(m) : Math.round(Number(m));
  }

  // ---------------------------------------------------------------- the map

  function ensureMap(centre) {
    if (typeof L === "undefined") return map;
    if (!map) {
      /* zoomSnap:0 is load-bearing: the camera solves a continuous scale and
         hands log2 of it to setView. Snapping would put the anchors off their
         guide boxes. */
      map = L.map("map", { zoomControl: false, attributionControl: false, zoomSnap: 0 })
        .setView([-36.9, 174.78], 15);
      map.on("click", function (e) {
        var native = e && e.originalEvent;
        if (!native) return;
        onSurfaceTap(native.clientX, native.clientY);
      });
    }
    setBaseFor(centre);
    return map;
  }

  function setBaseFor(centre) {
    if (!map || !centre) return;
    var base = app.basemap.baseFor(centre);
    if (base.kind === baseKind) return;
    if (baseLayer) baseLayer.remove();
    baseKind = base.kind;
    baseLayer = base.layer.addTo(map);
    var credit = el("mapAttribution");
    if (credit) {
      credit.textContent = base.attribution || "";
      show(credit, !!base.attribution);
    }
  }

  function applyGestureState() {
    if (!map) return;
    var frozen = mapSide !== null;
    GESTURE_HANDLERS.forEach(function (name) {
      var handler = map[name];
      if (handler) { frozen ? handler.disable() : handler.enable(); }
    });
  }

  // --------------------------------------------------------- the projection

  /* The one projection seam. Published: image pixels through the surface frame.
     Live: Leaflet container pixels through the live frame. Every overlay goes
     through this and therefore draws on both presentations without knowing
     which is up. Null means "nothing can be placed right now", which every
     caller treats as "don't draw". */
  function projector() {
    var img = el("surfaceImage");
    if (published && img && img.dataset.playSurface && activeFrame) {
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

  /* Undo the lock stage's CSS tilt so the 2D frame inverse stays exact. The
     tilt is perspective(d) rotateX(θ) scale(s) about (50%, originY); a 2D
     inverse is simply wrong under it, which is what used to flatten the view
     on drag and spring back on release. Identity when the tilt is off. */
  function unTilt(clientX, clientY) {
    var flat = { left: clientX, top: clientY };
    var vp = el("surfaceViewport");
    if (!vp || !published) return flat;
    if (!currentScene || currentScene.camera.stage !== "shot") return flat;
    var css = getComputedStyle(document.documentElement);
    var deg = parseFloat(css.getPropertyValue("--tiltDeg"));
    var d = parseFloat(css.getPropertyValue("--tiltPerspective"));
    var s = parseFloat(css.getPropertyValue("--tiltScale"));
    var originY = parseFloat(css.getPropertyValue("--tiltOriginY"));
    if (!(Number.isFinite(deg) && Number.isFinite(d) && d > 0 && Number.isFinite(s) && s > 0
      && Number.isFinite(originY))) return flat;
    var w = vp.offsetWidth, h = vp.offsetHeight;
    if (!(w > 0 && h > 0)) return flat;
    var ox = w / 2, oy = h * originY;
    var sx = clientX - ox, sy = clientY - oy;
    var t = Math.tan((deg * Math.PI) / 180), c = Math.cos((deg * Math.PI) / 180);
    var denom = d + sy * t;
    if (!(Math.abs(denom) > 1e-6) || !(Math.abs(c) > 1e-6)) return flat;
    var y1 = (sy * d) / denom;
    return { left: (sx * (d - y1 * t)) / d / s + w / 2, top: y1 / c / s + h * originY };
  }

  // ------------------------------------------------------------- the camera

  /* Map the Scene's camera stage onto the guide contract's stage names. The
     Marshal says what the camera is looking at; solving it is this file's job.

     Note what is NOT passed for the hole stage: the player. stageFrame("hole")
     anchors tee and green only, so a fix 600m away cannot widen the frame —
     it is edge-clamped instead (§6). */
  var STAGE = { hole: "hole", shot: "lock", green: "zoom" };

  function cameraKey(scene) {
    var cam = scene.camera;
    var r = cam.hole || {};
    return [cam.stage, scene.hole.number, published ? "p" : "l",
      cam.shot && cam.shot.target ? cam.shot.target.lat.toFixed(6) + "," + cam.shot.target.lng.toFixed(6) : "-",
      cam.shot && cam.shot.start ? cam.shot.start.lat.toFixed(6) + "," + cam.shot.start.lng.toFixed(6) : "-",
      r.holeNumber, window.innerWidth, window.innerHeight,
      settings() ? (settings().shotUp() ? 1 : 0) + ":" + settings().lockTightness() : ""
    ].join("|");
  }

  function framePoints(scene, pins) {
    var r = scene.camera.hole || {};
    var shot = scene.camera.shot;
    return {
      tee: (pins && pins.tee) || r.tee || null,
      green: (pins && pins.green) || r.green || null,
      greenShape: (pins && Array.isArray(pins.greenShape) && pins.greenShape.length ? pins.greenShape : r.greenShape) || [],
      position: shot ? shot.start : (r.tee || null),
      target: shot ? shot.target : null
    };
  }

  function applyCamera(scene) {
    var key = cameraKey(scene);
    if (key === lastCameraKey) return;
    lastCameraKey = key;
    var stage = STAGE[scene.camera.stage] || "hole";
    document.body.dataset.frameStage = stage;
    document.body.classList.toggle("tilt-lock", stage === "lock");
    if (published) applySurfaceCamera(stage, scene);
    else applyLiveCamera(stage, scene);
  }

  function applySurfaceCamera(stage, scene) {
    var img = el("surfaceImage");
    if (!img || !img.dataset.playSurface) return;
    var meta;
    try { meta = JSON.parse(img.dataset.playSurface); } catch (e) { return; }
    var view = { width: window.innerWidth, height: window.innerHeight };
    activeFrame = surfaceLib.stageFrameTransform(meta, stage,
      framePoints(scene, meta.anchorPins || {}), view,
      { lockTightness: settings() ? settings().lockTightness() : 1 });
    if (activeFrame && settings() && !settings().shotUp()) {
      activeFrame = surfaceLib.flattenFrame(activeFrame, view);
    }
    if (activeFrame) {
      img.style.width = Number(meta.outputDimensions.width) + "px";
      img.style.height = Number(meta.outputDimensions.height) + "px";
      img.style.transformOrigin = "0 0";
      img.style.transform = "matrix(" + activeFrame.a + "," + activeFrame.b + ","
        + (-activeFrame.b) + "," + activeFrame.a + "," + activeFrame.tx + "," + activeFrame.ty + ")";
    } else {
      img.style.width = ""; img.style.height = "";
      img.style.transform = ""; img.style.transformOrigin = "";
    }
  }

  /* The live map's camera. The solved similarity is split: its SCALE becomes
     Leaflet's own zoom so tiles stay native-resolution, and only the ROTATION
     rides in a CSS matrix on an over-provisioned square element. */
  function applyLiveCamera(stage, scene) {
    if (!ensureMap((scene.camera.hole && (scene.camera.hole.green || scene.camera.hole.tee)) || null)) return;
    var view = { width: window.innerWidth, height: window.innerHeight };
    if (!(view.width > 0 && view.height > 0)) return;
    var solved = surfaceLib.stageFrame(refPx, stage, framePoints(scene, null), view, {
      defaultGreenRadiusPx: LIVE_GREEN_RADIUS_PX,
      lockTightness: settings() ? settings().lockTightness() : 1
    });
    if (!solved) { plainMap(scene); return; }
    var scale = Math.hypot(solved.a, solved.b);
    if (!(scale > 0)) { plainMap(scene); return; }
    var angle = (settings() && !settings().shotUp()) ? 0 : Math.atan2(solved.b, solved.a);
    var wanted = REF_ZOOM + Math.log2(scale);
    var zoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), wanted));
    var residual = Math.pow(2, wanted - zoom);

    var centreWorld = surfaceLib.transformInvert(solved, { left: view.width / 2, top: view.height / 2 });
    if (!centreWorld) { plainMap(scene); return; }
    var centre = surfaceLib.latLngFromWorldPx(centreWorld, REF_ZOOM);
    if (!Number.isFinite(centre.lat) || !Number.isFinite(centre.lng)) { plainMap(scene); return; }

    /* The viewport diagonal: the smallest square that still covers the viewport
       after an arbitrary rotation about its own centre. */
    var side = Math.ceil(Math.hypot(view.width, view.height));
    var node = el("map");
    if (!node) return;
    /* Leaflet caches its container size and only re-measures on invalidateSize.
       Re-measure whenever the cache disagrees with the element, which also
       self-heals the case where the frame is first solved while the screen is
       still hidden and Leaflet cached 0x0. */
    var measured = map.getSize();
    if (measured.x !== side || measured.y !== side) {
      document.body.classList.add("map-framed");
      node.style.width = side + "px";
      node.style.height = side + "px";
      map.invalidateSize({ animate: false });
      applyGestureState();
    }
    if (!(map.getSize().x > 0)) { mapSide = null; lastCameraKey = null; return; }
    map.setView([centre.lat, centre.lng], zoom, { animate: false });
    /* Read the container point back rather than assuming side/2: Leaflet rounds
       its own pixel origin, and half a pixel here shows up as the dot sitting
       beside the player. */
    var c = map.latLngToContainerPoint([centre.lat, centre.lng]);
    liveFrame = surfaceLib.anchoredTransform({ x: c.x, y: c.y },
      { left: view.width / 2, top: view.height / 2 }, angle, residual);
    node.style.transform = "matrix(" + liveFrame.a + "," + liveFrame.b + "," + (-liveFrame.b) + ","
      + liveFrame.a + "," + liveFrame.tx + "," + liveFrame.ty + ")";
    mapSide = side;
  }

  /* A plain north-up map: the element fills the viewport again and the identity
     frame still projects (container px ARE viewport px at inset:0), so overlays
     keep drawing on holes that cannot be staged. */
  function plainMap(scene) {
    liveFrame = { a: 1, b: 0, tx: 0, ty: 0 };
    if (!ensureMap(null)) return;
    var r = scene && scene.camera.hole;
    var pts = [];
    if (r) [r.tee, r.green].concat(r.route || [], r.greenShape || []).forEach(function (p) {
      if (p) pts.push([p.lat, p.lng]);
    });
    if (pts.length >= 2) map.fitBounds(L.latLngBounds(pts).pad(0.15), { animate: false });
    else if (pts.length === 1) map.setView(pts[0], 17, { animate: false });
    if (mapSide === null) return;
    mapSide = null;
    var node = el("map");
    if (node) { node.style.width = ""; node.style.height = ""; node.style.transform = ""; }
    document.body.classList.remove("map-framed");
    applyGestureState();
    map.invalidateSize({ animate: false });
  }

  // ------------------------------------------------------------ hole layers

  function drawHoleLayers(scene) {
    if (!map) return;
    if (objectLayer) { objectLayer.remove(); objectLayer = null; }
    var r = scene.hole.rec;
    if (!r) return;
    var layers = [];
    var shape = (r.greenShape || []).map(function (p) { return [p.lat, p.lng]; });
    if (shape.length >= 3) {
      layers.push(L.polygon(shape, { color: "#ffffff", weight: 2, fillColor: "#2f8f4e", fillOpacity: 0.25, className: "holeGreen" }));
    } else if (r.green) {
      layers.push(L.circleMarker([r.green.lat, r.green.lng], { radius: 6, color: "#ffffff", weight: 2, fillColor: "#2f8f4e", fillOpacity: 0.9, className: "holeGreen" }));
    }
    var line = [r.tee].concat(r.route || [], [r.green]).filter(Boolean)
      .map(function (p) { return [p.lat, p.lng]; });
    if (line.length >= 2) layers.push(L.polyline(line, { color: "#ffffff", weight: 2, dashArray: "6 8", opacity: 0.7, className: "holeRoute" }));
    if (r.tee) layers.push(L.circleMarker([r.tee.lat, r.tee.lng], { radius: 5, color: "#ffffff", weight: 2, fillColor: "#0d1b12", fillOpacity: 0.9, className: "holeTee" }));
    if (layers.length) objectLayer = L.layerGroup(layers).addTo(map);
  }

  // -------------------------------------------------------------- overlays

  /* The dot is where you ACTUALLY are — scene.locator, not scene.player — so it
     means the same thing in both flows. In Preview your placement is drawn by
     the aim line and cluster instead; conflating the two is what would make the
     dot lie about your position while you plan a shot from somewhere else.

     If it projects off-screen it is CLAMPED to the edge on the line from the
     viewport centre toward where it really is, and labelled with how far that
     way it is — the camera frames the hole and never widens to fit someone who
     is not on it (§6). No threshold: "does it fit on screen" is already
     answered by the projection. */
  function drawPlayer(scene, proj) {
    var dot = el("gpsDot");
    var label = el("edgeDistance");
    var who = scene.locator;
    if (!dot) return;
    if (!who || !proj || scene.finish.show) {
      show(dot, false); show(label, false);
      return;
    }
    var at = proj.toScreen(who);
    var vw = window.innerWidth, vh = window.innerHeight;
    var inside = at && at.left >= 0 && at.top >= 0 && at.left <= vw && at.top <= vh;
    show(dot, true);
    dot.classList.toggle("stale", !!who.stale);
    if (inside) {
      dot.classList.remove("edged");
      dot.style.left = at.left + "px";
      dot.style.top = at.top + "px";
      show(label, false);
      return;
    }
    var cx = vw / 2, cy = vh / 2;
    var target = at || { left: cx, top: cy - vh };
    var dx = target.left - cx, dy = target.top - cy;
    var len = Math.hypot(dx, dy) || 1;
    var scale = Math.min((vw / 2 - EDGE_MARGIN_PX) / Math.abs(dx || 1e-6),
      (vh / 2 - EDGE_MARGIN_PX) / Math.abs(dy || 1e-6));
    var ex = cx + dx * scale, ey = cy + dy * scale;
    dot.classList.add("edged");
    dot.style.left = ex + "px";
    dot.style.top = ey + "px";
    /* Measured from the centre of what is on screen, so the arrow and the
       number describe the same line. */
    var centreLL = proj.toLatLng({ left: cx, top: cy });
    var away = centreLL ? app.distance.haversineMeters(centreLL, who) : null;
    show(label, Number.isFinite(away));
    if (Number.isFinite(away)) {
      label.textContent = settings() ? settings().format(away) : Math.round(away) + "m";
      label.style.left = ex + "px";
      label.style.top = ey + "px";
      label.style.transform = "translate(-50%,-50%) rotate(" + (Math.atan2(dy, dx) * 180 / Math.PI) + "deg)";
    }
  }

  /* The engine's cluster, the aim line, the wind drift line and the layup
     guides — all of them gated on scene.bubble.show, which is the Marshal
     saying you asked for a shot view. Nothing here decides. */
  function drawShot(scene, proj) {
    var svg = el("bubbleSvg");
    var bubble = el("aimBubble");
    if (!svg) return;
    if (!scene.bubble.show || !proj) {
      show(svg, false);
      if (svg.innerHTML) svg.innerHTML = "";
      show(bubble, false);
      return;
    }
    function project(pt) { return pt ? proj.toScreen(pt) : null; }
    var model = window.GDBubbleEngine ? window.GDBubbleEngine.renderModel() : null;
    var parts = [];
    var engine = window.GDBubbleEngine;
    var windLanding = engine && typeof engine.windLanding === "function" ? engine.windLanding() : null;
    if (windLanding && scene.bubble.target) {
      var wt = project(scene.bubble.target), wl = project(windLanding);
      if (wt && wl) {
        parts.push('<path class="windLine" d="M' + wt.left.toFixed(1) + "," + wt.top.toFixed(1)
          + "L" + wl.left.toFixed(1) + "," + wl.top.toFixed(1) + '"/>');
      }
    }
    var centerScreen = model ? project(model.center) : null;
    var r = scene.hole.rec || {};
    if (model && centerScreen) {
      var rings = ["outer", "main", "inner"].map(function (name) {
        var pts = model.rings[name].map(project).filter(Boolean);
        if (pts.length < model.rings[name].length * 0.6) return null;
        return { name: name, d: "M" + pts.map(function (p) { return p.left.toFixed(1) + "," + p.top.toFixed(1); }).join("L") + "Z" };
      }).filter(Boolean);
      if (rings.length === 3) {
        var startScreen = project(scene.bubble.start);
        var targetScreen = project(scene.bubble.target);
        if ((!settings() || settings().aimLine()) && startScreen && targetScreen) {
          var dx = targetScreen.left - startScreen.left, dy = targetScreen.top - startScreen.top;
          var len = Math.hypot(dx, dy);
          if (len > 12) {
            parts.push('<path class="aimLine" d="M' + startScreen.left.toFixed(1) + "," + startScreen.top.toFixed(1)
              + "L" + (startScreen.left + dx / len * (len - 6)).toFixed(1) + ","
              + (startScreen.top + dy / len * (len - 6)).toFixed(1) + '"/>');
          }
        }
        var greenScreen = r.green ? project(r.green) : null;
        var maxCarry = engine ? engine.maxPlayableCarryM() : null;
        if (greenScreen && Number.isFinite(maxCarry) && scene.bubble.start) {
          var raw = app.distance.haversineMeters(scene.bubble.start, r.green);
          var playable = app.distance.haversineMeters(scene.bubble.start, model.center);
          var gap = app.distance.haversineMeters(model.center, r.green);
          if (raw > maxCarry + 3 && gap > 4 && raw > playable + 4) {
            var route = [r.tee].concat(r.route || [], [r.green]).filter(Boolean).map(project).filter(Boolean);
            if (route.length >= 2) {
              parts.unshift('<path class="fairwayLine" d="M' + route.map(function (p) {
                return p.left.toFixed(1) + "," + p.top.toFixed(1);
              }).join("L") + '"/>');
            }
            var gx = greenScreen.left - centerScreen.left, gy = greenScreen.top - centerScreen.top;
            var glen = Math.hypot(gx, gy) || 1;
            var trim = Math.min(10, glen * 0.05);
            parts.push('<path class="middleGuide" d="M' + (centerScreen.left + gx / glen * trim).toFixed(1) + ","
              + (centerScreen.top + gy / glen * trim).toFixed(1)
              + "L" + (greenScreen.left - gx / glen * trim).toFixed(1) + ","
              + (greenScreen.top - gy / glen * trim).toFixed(1) + '"/>');
            parts.push('<text class="middleGuideLabel" x="' + (centerScreen.left + gx * 0.52 + (-gy / glen) * 18).toFixed(1)
              + '" y="' + (centerScreen.top + gy * 0.52 + (gx / glen) * 18).toFixed(1) + '">Green '
              + (settings() ? settings().format(gap) : Math.round(gap) + "m") + "</text>");
          }
        }
        rings.forEach(function (p) {
          parts.push('<path class="ring' + p.name.charAt(0).toUpperCase() + p.name.slice(1) + '" d="' + p.d + '"/>');
        });
      }
    }
    show(svg, parts.length > 0);
    if (parts.length) {
      svg.setAttribute("viewBox", "0 0 " + window.innerWidth + " " + window.innerHeight);
      svg.innerHTML = parts.join("");
    } else if (svg.innerHTML) {
      svg.innerHTML = "";
    }
    /* The drag hit covers the cluster: grab the bubble anywhere to move the aim.
       Sized to the projected main ring, 44px minimum for fingers. */
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
      show(bubble, !!hit);
      if (hit) {
        bubble.style.left = centerScreen.left + "px";
        bubble.style.top = centerScreen.top + "px";
        bubble.style.width = hit.w + "px";
        bubble.style.height = hit.h + "px";
      }
    }
  }

  function drawPin(scene, proj) {
    var pin = app.pin && app.pin.current();
    var marker = el("pinMarker"), label = el("pinDistance");
    if (!marker || !label) return;
    var at = pin && proj ? proj.toScreen(pin) : null;
    show(marker, !!at);
    if (at) { marker.style.left = at.left + "px"; marker.style.top = at.top + "px"; }
    var from = scene.finish.show ? (scene.finish.ball || scene.player) : scene.player;
    var d = at && from ? app.distance.haversineMeters(from, pin) : null;
    show(label, Number.isFinite(d));
    if (Number.isFinite(d)) {
      label.textContent = settings() ? settings().format(d) : Math.round(d) + "m";
      label.style.left = at.left + "px";
      label.style.top = at.top + "px";
    }
  }

  /* The Finish ball and its prompt. Parked when it has no anchor worth drawing —
     never placed and off the green, or simply not projectable — which is the
     "pick it up and put it where the shot finished" gesture. */
  function drawFinish(scene, proj) {
    var ball = el("greenFocusBall"), hint = el("greenFocusHint"), ring = el("greenRing");
    var origin = el("finishOrigin");
    if (!ball) return;
    if (!scene.finish.show) {
      show(ball, false); show(hint, false); show(origin, false);
      ball.classList.remove("parked");
      show(ring, scene.camera.stage === "green" && !!(scene.hole.rec && scene.hole.rec.green) && !!proj);
      if (ring && scene.hole.rec && scene.hole.rec.green && proj) {
        var g = proj.toScreen(scene.hole.rec.green);
        show(ring, !!g);
        if (g) { ring.style.left = g.left + "px"; ring.style.top = g.top + "px"; }
      }
      return;
    }
    show(ring, false);
    var at = scene.finish.ball && proj ? proj.toScreen(scene.finish.ball) : null;
    var parked = !at;
    show(ball, true);
    ball.classList.toggle("parked", parked);
    if (!parked) { ball.style.left = at.left + "px"; ball.style.top = at.top + "px"; }
    else { ball.style.left = ""; ball.style.top = ""; }
    show(hint, parked || !scene.finish.placed);
    /* The shot's origin, so you can see the shot you are reconstructing rather
       than guessing from a bare green — the whole point of being able to log a
       hole later. */
    var originAt = scene.finish.origin && proj ? proj.toScreen(scene.finish.origin) : null;
    show(origin, !!originAt);
    if (originAt && origin) { origin.style.left = originAt.left + "px"; origin.style.top = originAt.top + "px"; }
  }

  // ---------------------------------------------------------------- chrome

  function drawChrome(scene) {
    var banner = el("playBanner");
    if (banner) {
      var live = scene.banner.flow === "live";
      banner.classList.toggle("livePlay", live);
      banner.classList.toggle("previewPlay", !live);
      var text = el("playBannerLabel");
      if (text) text.textContent = (live ? "LIVE · Hole " : "PREVIEW · Hole ") + scene.banner.hole;
      var back = el("playBannerReturn");
      show(back, scene.banner.returnTo !== null);
      if (back && scene.banner.returnTo !== null) back.textContent = "Return to " + scene.banner.returnTo;
      show(banner, true);
    }

    var play = el("playButton");
    show(play, scene.playButton.show);
    if (play && scene.playButton.show) {
      play.textContent = scene.playButton.hole ? "Play hole " + scene.playButton.hole : "Play";
    }

    var bar = el("distanceBar");
    show(bar, scene.distances.show);
    if (scene.distances.show) {
      el("distFront").textContent = units(scene.distances.front);
      el("distBack").textContent = units(scene.distances.back);
      var shotRow = el("shotRow");
      var model = scene.bubble.show && window.GDBubbleEngine ? window.GDBubbleEngine.renderModel() : null;
      var payload = model && model.payload;
      show(shotRow, !!payload);
      if (payload) {
        var landing = model.center || scene.bubble.target;
        var toTarget = app.distance.haversineMeters(scene.bubble.start, landing);
        el("shotClub").textContent = compactClub(payload.club);
        el("shotDist").textContent = units(toTarget);
        el("shotCarry").textContent = Number.isFinite(Number(payload.baseCarry)) ? units(Number(payload.baseCarry)) : "–";
        drawPlaysLike(scene.bubble.start, landing, toTarget);
      } else {
        drawPlaysLike(null, null, null);
      }
    } else {
      show(el("shotRow"), false);
      drawPlaysLike(null, null, null);
    }

    show(el("startPill"), scene.startPill.show);

    var dock = el("shotActionBtn");
    show(dock, scene.dock.show);
    if (dock && scene.dock.show) setDockFace(dock, scene);
    show(el("shotEndBtn"), scene.dock.canShotEnd);

    show(el("finishControl"), scene.finishControl.show);

    drawLogged(scene);

    var holeEl = el("holeNumber");
    if (holeEl) holeEl.textContent = String(scene.hole.number);
  }

  var DOCK = {
    lock: { label: "Lock", aria: "Lock in the shot", icon: "../assets/home/clarity-caddy-lock-shot-icon.png?v=e9a3e4ea" },
    unlock: { label: "Unlock Shot", aria: "Unlock Shot", icon: "../assets/home/clarity-caddy-unlock-shot-icon.png?v=d410cc7f" },
    shotEnd: { label: "Shot End", aria: "Shot End", icon: "../assets/home/clarity-caddy-shot-end-icon.png?v=0b094e11" }
  };

  function setDockFace(dock, scene) {
    var face = DOCK[scene.dock.face] || DOCK.lock;
    if (dock.dataset.action === scene.dock.face) return;
    dock.dataset.action = scene.dock.face;
    dock.setAttribute("aria-label", face.aria);
    var label = el("shotActionLabel");
    if (label) label.textContent = face.label;
    var icon = el("shotActionIcon");
    if (!icon) return;
    dock.classList.remove("noIcon");
    icon.onerror = function () { dock.classList.add("noIcon"); };
    icon.src = face.icon;
  }

  function compactClub(label) {
    var raw = String(label || "").trim();
    if (!raw) return "GPS";
    if (/^driver$/i.test(raw)) return "DR";
    return raw.length <= 3 ? raw.toUpperCase() : raw.slice(0, 3).toUpperCase();
  }

  function drawPlaysLike(fix, landing, flatM) {
    var pop = el("playsPop");
    if (!pop) return;
    var data = (fix && landing && app.playsLike) ? app.playsLike.forShot(fix, landing, flatM) : null;
    var on = !!data && data.plays !== "level";
    show(pop, on);
    if (!on) return;
    var value = el("playsValue"), delta = el("playsDelta");
    if (value) value.textContent = units(data.adjustedM);
    if (delta) delta.textContent = data.label;
    pop.classList.toggle("playsOver", data.plays === "uphill");
    pop.classList.toggle("playsUnder", data.plays === "downhill");
  }

  function drawLogged(scene) {
    var screen = el("loggedScreen");
    if (!screen) return;
    show(screen, scene.logged.show);
    if (!scene.logged.show) return;
    var record = scene.logged.record || {};
    var flat = app.distance.haversineMeters(record.start, record.end);
    var detail = el("loggedDetail");
    if (detail) {
      var model = window.GDBubbleEngine ? window.GDBubbleEngine.renderModel() : null;
      var club = model && model.payload ? compactClub(model.payload.club) : null;
      detail.textContent = [
        "Hole " + scene.logged.hole,
        Number.isFinite(flat) ? units(flat) + (settings() && settings().unitLabel ? "" : "m") : null,
        club
      ].filter(Boolean).join(" · ");
    }
    var score = el("loggedScore");
    if (score) score.textContent = String(scene.logged.score || parFor(scene.logged.hole) || 4);
    var next = el("loggedNext");
    if (next && scene.logged.next) {
      next.textContent = scene.logged.next.label;
      next.dataset.signal = scene.logged.next.signal;
      next.dataset.payload = JSON.stringify(scene.logged.next.payload || null);
    }
  }

  function parFor(hole) {
    try { return app.scorecard && app.scorecard.parFor ? app.scorecard.parFor(hole) : null; }
    catch (e) { return null; }
  }

  function drawPicker(scene) {
    var grid = el("holePickerGrid");
    if (!grid || grid.dataset.built === "1" && grid.dataset.hole === String(scene.hole.number)
      && grid.dataset.flagged === scene.picker.flagged.join(",")) return;
    grid.dataset.built = "1";
    grid.dataset.hole = String(scene.hole.number);
    grid.dataset.flagged = scene.picker.flagged.join(",");
    grid.innerHTML = scene.picker.holes.map(function (hole) {
      var classes = ["holeTile"];
      if (hole === scene.picker.current) classes.push("active");
      if (scene.picker.flagged.indexOf(hole) !== -1) classes.push("pending");
      return '<button type="button" class="' + classes.join(" ") + '" data-hole="' + hole + '">' + hole + "</button>";
    }).join("");
  }

  // ------------------------------------------------------------- the surface

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

  function clearSurface() {
    published = false;
    document.body.classList.remove("surface-published");
    var img = el("surfaceImage");
    if (img) {
      img.removeAttribute("src");
      img.dataset.playSurface = "";
      img.style.width = ""; img.style.height = "";
      img.style.transform = ""; img.style.transformOrigin = "";
    }
    activeFrame = null;
    provenance = null;
    renderProvenance();
  }

  function renderProvenance() {
    var chip = el("surfaceSource"), panel = el("surfaceMetaPanel");
    show(chip, !!provenance && published);
    if (!provenance || !published) { if (panel) show(panel, false); return; }
    chip.textContent = surfaceLib.provenanceLabel(provenance);
    if (panel && !panel.classList.contains("hiddenState")) panel.textContent = JSON.stringify(provenance, null, 2);
  }

  /* The image is preloaded off-DOM and swapped only once decodable, so the
     previous hole's surface holds until the new one paints. The token pins the
     load to the transition that asked for it; the bounded stall timer exists so
     a hung request cannot leave the player with no presentation at all. */
  function presentSurface(asset, origin, hole, courseKey) {
    var img = el("surfaceImage");
    if (!img) return;
    var token = transitionToken;
    var url = asset.url || surfaceLib.assetUrl(asset.path);
    var startedAt = Date.now();
    var settled = false;
    var stall = setTimeout(function () {
      if (settled || token !== transitionToken) return;
      settled = true;
      surfaceFallback();
    }, 8000);
    var pre = new Image();
    pre.onload = function () {
      if (settled) return;
      settled = true;
      clearTimeout(stall);
      if (token !== transitionToken) return;
      repaint("SURFACE_READY", function () {
        img.dataset.playSurface = JSON.stringify(asset.playSurface);
        img.src = url;
        published = true;
        document.body.classList.add("surface-published");
        provenance = {
          origin: origin, url: url, courseKey: courseKey, holeNumber: hole,
          loadMs: Date.now() - startedAt,
          naturalSize: pre.naturalWidth + "×" + pre.naturalHeight,
          loadedAt: new Date().toISOString(),
          playSurface: asset.playSurface
        };
        renderProvenance();
        lastCameraKey = null;
      });
    };
    pre.onerror = function () {
      if (settled) return;
      settled = true;
      clearTimeout(stall);
      if (token === transitionToken) surfaceFallback();
    };
    pre.src = url;
  }

  function surfaceFallback() {
    repaint("SURFACE_FAILED", function () {
      clearSurface();
      lastCameraKey = null;
    });
  }

  async function loadSurfaceFor(scene) {
    var hole = scene.hole.number;
    var courseKey = marshal.state().round.courseKey;
    var token = ++transitionToken;
    loadedHole = hole;
    clearSurface();
    lastCameraKey = null;
    var r = scene.hole.rec;
    if (r && r.visual) { presentSurface(r.visual, "package", hole, courseKey); return; }
    if (!courseKey) return;
    var answer = await ensureStore().surfaceFor(courseKey, hole);
    if (token !== transitionToken) return;
    if (answer.state === "published") presentSurface(answer.asset, "visuals", hole, courseKey);
  }

  // ---------------------------------------------------------------- render

  /* Everything is drawn every pass rather than diffed. Trace suppresses writes
     that change nothing, so the log still shows exactly the fields that moved —
     and a full pass has no diff bookkeeping to get wrong. The camera is the one
     exception: it is expensive, so it is keyed and re-solved only when the key
     changes. */
  function render(scene) {
    currentScene = scene;
    if (scene.hole.number !== loadedHole) loadSurfaceFor(scene);
    applyCamera(scene);
    if (!published) drawHoleLayers(scene);
    document.body.classList.toggle("flow-preview", scene.flow === "preview");
    document.body.classList.toggle("green-focus", scene.finish.show);
    document.body.classList.toggle("shot-active", scene.bubble.show);
    var proj = projector();
    drawPlayer(scene, proj);
    drawShot(scene, proj);
    drawFinish(scene, proj);
    drawPin(scene, proj);
    drawChrome(scene);
    drawPicker(scene);
  }

  function repaint(cause, fn) {
    var t = trace();
    var mode = currentScene ? currentScene.mode : "";
    if (t) t.paint(cause, mode, fn);
    else fn();
  }

  // ---------------------------------------------------------------- input

  function send(name, payload) { if (marshal) marshal.signal(name, payload); }

  function onSurfaceTap(clientX, clientY) {
    var proj = projector();
    var at = unTilt(clientX, clientY);
    var ll = proj ? proj.toLatLng({ left: at.left, top: at.top }) : null;
    if (!ll && published && !activeFrame) {
      var img = el("surfaceImage");
      if (img && img.dataset.playSurface) {
        try {
          var meta = JSON.parse(img.dataset.playSurface);
          var rect = img.getBoundingClientRect();
          ll = surfaceLib.surfaceScreenToLatLng(meta,
            { left: clientX - rect.left, top: clientY - rect.top },
            { width: rect.width, height: rect.height });
        } catch (e) { ll = null; }
      }
    }
    if (!ll) return;
    if (app.pin && app.pin.armed()) { app.pin.set(ll); app.pin.disarm(); return; }
    /* A tap places you in Preview and nowhere else. In Live your position is
       the trusted fix, so a tap has nothing to say. */
    send("PLACED", { point: ll });
  }

  function dragHandler(node, opts) {
    if (!node) return;
    var offset = null;
    function end() {
      offset = null;
      if (!document.body.classList.contains(opts.busyClass)) return;
      document.body.classList.remove(opts.busyClass);
      if (opts.onEnd) opts.onEnd();
    }
    node.addEventListener("pointerdown", function (e) {
      var proj = projector();
      var anchor = opts.anchor();
      if (!proj) return;
      var at = anchor ? proj.toScreen(anchor) : null;
      var grab = unTilt(e.clientX, e.clientY);
      /* Delta dragging: the thing you grabbed may sit offset from the point it
         represents (the cluster centre is not the aim), so remember the grab
         offset and move by the delta. A parked ball has no anchor, so it drops
         straight under the finger — that IS the pick-it-up gesture. */
      offset = at ? { x: at.left - grab.left, y: at.top - grab.top } : { x: 0, y: 0 };
      try { node.setPointerCapture(e.pointerId); } catch (err) {}
      document.body.classList.add(opts.busyClass);
      e.preventDefault();
      if (opts.stop) e.stopPropagation();
    });
    node.addEventListener("pointermove", function (e) {
      if (!offset || !document.body.classList.contains(opts.busyClass)) return;
      var proj = projector();
      if (!proj) return;
      var at = unTilt(e.clientX, e.clientY);
      var ll = proj.toLatLng({ left: at.left + offset.x, top: at.top + offset.y });
      if (ll) opts.onMove(ll);
    });
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
  }

  function wireInput() {
    dragHandler(el("aimBubble"), {
      busyClass: "bubble-dragging",
      anchor: function () { return currentScene && currentScene.bubble.target; },
      onMove: function (ll) { send("AIM_DRAGGED", { point: ll }); }
    });
    dragHandler(el("pinMarker"), {
      busyClass: "pin-dragging",
      anchor: function () { return app.pin && app.pin.current(); },
      onMove: function (ll) { if (app.pin) app.pin.set(ll); },
      onEnd: function () { if (marshal) render(marshal.scene()); }
    });
    dragHandler(el("greenFocusBall"), {
      busyClass: "ball-dragging", stop: true,
      anchor: function () { return currentScene && currentScene.finish.ball; },
      onMove: function (ll) { send("BALL_MOVED", { point: ll }); }
    });

    var img = el("surfaceImage");
    if (img) img.addEventListener("click", function (e) { onSurfaceTap(e.clientX, e.clientY); });

    var dock = el("shotActionBtn");
    if (dock) dock.addEventListener("click", function () {
      send(dock.dataset.action === "unlock" ? "UNLOCK" : "LOCK");
    });

    var play = el("playButton");
    if (play) play.addEventListener("click", function () { send("PLAY_PRESSED"); });

    var tee = el("headToTeeBtn");
    if (tee) tee.addEventListener("click", function () {
      var r = currentScene && currentScene.hole.rec;
      if (r && r.tee) send("PLACED", { point: r.tee });
    });

    var back = el("playBannerReturn");
    if (back) back.addEventListener("click", function () {
      if (currentScene && currentScene.banner.returnTo !== null) {
        send("VIEW_HOLE_CHANGED", { hole: currentScene.banner.returnTo });
      }
    });

    var finish = el("finishControl");
    if (finish) finish.addEventListener("click", function () {
      send("FINISH_OPENED", { hole: currentScene ? currentScene.hole.number : null });
    });

    var finishDone = el("finishDone");
    if (finishDone) finishDone.addEventListener("click", function () { send("FINISH_LOGGED"); });

    var shotEnd = el("shotEndBtn");
    if (shotEnd) shotEnd.addEventListener("click", function () { send("SHOT_END"); });

    var next = el("loggedNext");
    if (next) next.addEventListener("click", function () {
      var payload = null;
      try { payload = JSON.parse(next.dataset.payload || "null"); } catch (e) {}
      send(next.dataset.signal || "NEXT_HOLE", payload);
    });
    var loggedBack = el("loggedBack");
    if (loggedBack) loggedBack.addEventListener("click", function () { send("BACK"); });

    ["loggedScoreDown", "loggedScoreUp"].forEach(function (id, index) {
      var btn = el(id);
      if (!btn) return;
      btn.addEventListener("click", function () {
        var scene = currentScene;
        if (!scene || !scene.logged.show) return;
        var current = Number(el("loggedScore").textContent) || 4;
        send("SCORE_SET", { hole: scene.logged.hole, strokes: Math.max(1, current + (index ? 1 : -1)) });
      });
    });

    var grid = el("holePickerGrid");
    if (grid) grid.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest("[data-hole]") : null;
      if (!btn) return;
      send("VIEW_HOLE_CHANGED", { hole: Number(btn.dataset.hole) });
      var panel = el("holePickerPanel");
      if (panel) show(panel, false);
    });

    var prev = el("prevHole"), nextHole = el("nextHole");
    if (prev) prev.addEventListener("click", function () { send("PREV_HOLE"); });
    if (nextHole) nextHole.addEventListener("click", function () { send("NEXT_HOLE"); });

    window.addEventListener("resize", function () {
      lastCameraKey = null;
      if (marshal) repaint("VIEWPORT_CHANGED", function () { render(marshal.scene()); });
    });

    if (app.gpsSettings) app.gpsSettings.onChange(function () {
      lastCameraKey = null;
      if (marshal) repaint("SETTINGS_CHANGED", function () { render(marshal.scene()); });
    });
    if (app.pin) app.pin.onChange(function () {
      if (marshal) repaint("PIN_CHANGED", function () { render(marshal.scene()); });
    });
    if (app.playsLike) app.playsLike.onChange(function () {
      if (marshal) repaint("ELEVATION_READY", function () { render(marshal.scene()); });
    });
  }

  // ------------------------------------------------------------------- api

  app.painter = {
    attach: function (owner) {
      marshal = owner;
      wireInput();
      /* The engine's pixel caps see the real on-screen scale through the same
         seam, so the bubble is clamped identically on both presentations. */
      if (window.GDBubbleEngine) window.GDBubbleEngine.setProjection({
        toScreen: function (ll) {
          var proj = projector();
          var at = proj ? proj.toScreen(ll) : null;
          return at ? { x: at.left, y: at.top } : null;
        },
        viewSize: function () { return { x: window.innerWidth, y: window.innerHeight }; }
      });
      marshal.onScene(function (scene, cause) {
        repaint(cause, function () { render(scene); });
      });
      return true;
    },
    /* Viewport client coords → a course lat/lng, for the pin drag that starts
       on a tool-rail button outside this closure. */
    latLngAt: function (clientX, clientY) {
      var proj = projector();
      var at = unTilt(clientX, clientY);
      var ll = proj ? proj.toLatLng({ left: at.left, top: at.top }) : null;
      if (ll) return ll;
      if (published && !activeFrame) {
        var img = el("surfaceImage");
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
    },
    /* The current hole's green, for tools that compute against it (Pin Lock). */
    holeGeometry: function () {
      var r = currentScene && currentScene.hole.rec;
      if (!r) return null;
      return {
        green: r.green ? { lat: r.green.lat, lng: r.green.lng } : null,
        greenShape: (r.greenShape || []).map(function (p) { return { lat: p.lat, lng: p.lng }; })
      };
    },
    /* Read-only, for tests and for diagnosing a frame that does not match what
       is on screen. */
    mapState: function () {
      if (!map) return null;
      try {
        var c = map.getCenter(), s = map.getSize();
        return { lat: c.lat, lng: c.lng, zoom: map.getZoom(), width: s.x, height: s.y,
          minZoom: map.getMinZoom(), maxZoom: map.getMaxZoom(), published: published };
      } catch (e) { return null; }
    }
  };
})();
