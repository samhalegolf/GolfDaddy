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
  var positionMarker = null;
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

  /* Freezes the live map's own pan/zoom/rotate handlers so it can't be bumped
     off-frame mid-shot; taps to set position still work (only gesture
     handlers are toggled, not the click listener). The surface's frame hold
     lives in applySurfaceFrame's holdFrame check, driven by the same class. */
  function setViewLocked(on) {
    viewLocked = !!on;
    document.body.classList.toggle("view-locked", viewLocked);
    if (map) {
      GESTURE_HANDLERS.forEach(function (name) {
        var handler = map[name];
        if (handler) { viewLocked ? handler.disable() : handler.enable(); }
      });
    }
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
  }

  function ensureMap(centre) {
    if (typeof L === "undefined") return map;
    if (!map) {
      map = L.map("map", { zoomControl: false, attributionControl: true })
        .setView([-36.9, 174.78], 15);
      map.attributionControl.setPrefix(false);
      /* Tap where you are standing — same contract as a real fix. A pin
         placement armed via the tool rail intercepts the next tap instead. */
      map.on("click", function (e) {
        if (!e || !e.latlng) return;
        var tapped = { lat: e.latlng.lat, lng: e.latlng.lng };
        if (app.pin && app.pin.armed()) { app.pin.set(tapped); app.pin.disarm(); return; }
        app.position.set(tapped, "tap");
      });
    }
    setBaseFor(centre);
    return map;
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
    if (pts.length >= 2) map.fitBounds(L.latLngBounds(pts).pad(0.15));
    else if (pts.length === 1) map.setView(pts[0], 17);
    else if (current.centre) map.setView([current.centre.lat, current.centre.lng], 15);
    if (pts.length) {
      var layers = [];
      var shape = rec.greenShape.filter(function (p) { return p && Number.isFinite(Number(p.lat)); })
        .map(function (p) { return [Number(p.lat), Number(p.lng)]; });
      if (shape.length >= 3) {
        layers.push(L.polygon(shape, { color: "#ffffff", weight: 2, fillColor: "#2f8f4e", fillOpacity: 0.25 }));
      } else if (rec.green) {
        layers.push(L.circleMarker([rec.green.lat, rec.green.lng], { radius: 6, color: "#ffffff", weight: 2, fillColor: "#2f8f4e", fillOpacity: 0.9 }));
      }
      var line = [rec.tee].concat(rec.route, [rec.green])
        .filter(function (p) { return p && Number.isFinite(Number(p.lat)); })
        .map(function (p) { return [Number(p.lat), Number(p.lng)]; });
      if (line.length >= 2) layers.push(L.polyline(line, { color: "#ffffff", weight: 2, dashArray: "6 8", opacity: 0.7 }));
      if (rec.tee) layers.push(L.circleMarker([rec.tee.lat, rec.tee.lng], { radius: 5, color: "#ffffff", weight: 2, fillColor: "#0d1b12", fillOpacity: 0.9 }));
      objectLayer = L.layerGroup(layers).addTo(map);
    }
    var pos = app.position.current();
    if (pos) renderPosition(pos);
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
    document.getElementById("distFront").textContent = d.front === null ? "–" : d.front;
    document.getElementById("distBack").textContent = d.back === null ? "–" : d.back;
    /* Aimed off the green: club/total/carry for this shot — total is the
       distance to where it actually lands (the engine's render centre, not
       the raw aim point — aim-offset and bag-roof already moved it). Green
       centre is dropped (front/back already frame the green); what remains
       to the green renders on the middle guide line itself (renderShotOverlays'
       "Green Xm" label), not repeated here. Aimed at the green, F/B already
       IS the shot. */
    var shotRow = document.getElementById("shotRow");
    if (!shotRow) return;
    var act = app.shot && app.shot.active();
    var show = false;
    if (act && act.target) {
      var landing = (model && model.center) || act.target;
      var toTarget = app.distance.haversineMeters(fix, landing);
      var remaining = app.distance.haversineMeters(landing, rec.green);
      if (Number.isFinite(toTarget) && Number.isFinite(remaining) && remaining > 3) {
        var payload = model && model.payload;
        document.getElementById("shotClub").textContent = payload ? compactClub(payload.club) : "–";
        document.getElementById("shotDist").textContent = Math.round(toTarget);
        document.getElementById("shotCarry").textContent = payload && Number.isFinite(Number(payload.baseCarry))
          ? Math.round(Number(payload.baseCarry)) : "–";
        show = true;
      }
    }
    shotRow.classList.toggle("hiddenState", !show);
  }

  /* One renderer for both presentations: the player's position moves the
     Leaflet marker and, when a surface is up, the projected dot. An off-surface
     or absent position hides the dot — a normal state, not an error. */
  function renderPosition(pos) {
    if (pos && map) {
      if (!positionMarker) {
        positionMarker = L.circleMarker([pos.lat, pos.lng], {
          radius: 7, weight: 2, color: "#ffffff", fillColor: "#2f8fef", fillOpacity: 1, className: "gpsMarker"
        }).addTo(map);
      } else {
        positionMarker.setLatLng([pos.lat, pos.lng]);
      }
    }
    /* The start pill owns the pre-frame state: hole framed, no position yet.
       Any placement — pill, tap, adopted fix — retires it for the hole. */
    var pill = document.getElementById("startPill");
    if (pill) pill.classList.toggle("hiddenState", !!pos || startPillDismissed || !(current.rec && current.rec.tee));
    var dot = document.getElementById("gpsDot");
    if (!dot) return;
    var img = document.getElementById("surfaceImage");
    var onSurface = null;
    if (img && document.body.classList.contains("surface-published") && img.dataset.playSurface) {
      try {
        var meta = JSON.parse(img.dataset.playSurface);
        applySurfaceFrame(meta, pos);   // stage follows the position, event-driven
        if (pos) {
          var imagePx = surfaceLib.projectToSurface(meta, pos.lat, pos.lng);
          if (imagePx) {
            onSurface = activeFrame
              ? surfaceLib.transformApply(activeFrame, imagePx)
              : surfaceLib.fitContain(imagePx, meta.outputDimensions,
                  { width: img.clientWidth, height: img.clientHeight });
          }
        }
      } catch (e) { onSurface = null; }
    }
    dot.classList.toggle("hiddenState", !onSurface);
    if (onSurface) {
      dot.style.left = onSurface.left + "px";
      dot.style.top = onSurface.top + "px";
    }
    /* Computed once here, independent of the surface projection, so the shot
       card's club/total/carry work on the live-map fallback too (rule 2) —
       only the ring/aim-line drawing below needs a published surface. */
    var act = app.shot && app.shot.active();
    var model = act && window.GDBubbleEngine ? window.GDBubbleEngine.renderModel() : null;
    renderShotOverlays(pos, model);
    renderDistances(pos, model);
    renderPin(pos);
    /* Shot End is available whenever a shot is in flight — any stage, not
       just green focus (a chip that comes up short still needs logging). */
    var shotEndBtn = document.getElementById("shotEndBtn");
    if (shotEndBtn) shotEndBtn.classList.toggle("hiddenState", !act);
  }

  var pinMapMarker = null;

  function pinIcon() {
    return L.icon({ iconUrl: "../assets/icons/flag.svg", iconSize: [22, 22], iconAnchor: [4, 20] });
  }

  /* The pin marker draws on whichever presentation is up: the live map (a
     Leaflet marker, same as tee/green) and, when a surface is published, a
     projected DOM marker + a "how far from here" label — the same projection
     seam renderShotOverlays uses for the rings. */
  function renderPin(fix) {
    var pin = app.pin && app.pin.current();
    if (map) {
      if (pin) {
        if (!pinMapMarker) {
          pinMapMarker = L.marker([pin.lat, pin.lng], { icon: pinIcon(), draggable: true }).addTo(map);
          /* Grab the placed pin on the live map and drag it to reposition —
             Leaflet's own drag handles the pointer math here. */
          pinMapMarker.on("dragend", function () {
            var ll = pinMapMarker.getLatLng();
            app.pin.set({ lat: ll.lat, lng: ll.lng });
          });
        } else if (!pinMapMarker.dragging || !pinMapMarker.dragging.moving()) {
          pinMapMarker.setLatLng([pin.lat, pin.lng]);
        }
      } else if (pinMapMarker) {
        pinMapMarker.remove();
        pinMapMarker = null;
      }
    }
    var marker = document.getElementById("pinMarker");
    var label = document.getElementById("pinDistance");
    if (!marker || !label) return;
    var published = document.body.classList.contains("surface-published");
    var img = document.getElementById("surfaceImage");
    var screen = null;
    if (pin && published && img && img.dataset.playSurface && activeFrame) {
      try {
        var meta = JSON.parse(img.dataset.playSurface);
        var px = surfaceLib.projectToSurface(meta, pin.lat, pin.lng);
        screen = px ? surfaceLib.transformApply(activeFrame, px) : null;
      } catch (e) { screen = null; }
    }
    marker.classList.toggle("hiddenState", !screen);
    if (screen) { marker.style.left = screen.left + "px"; marker.style.top = screen.top + "px"; }
    var dist = screen && fix ? app.distance.haversineMeters(fix, pin) : null;
    label.classList.toggle("hiddenState", !Number.isFinite(dist));
    if (Number.isFinite(dist)) {
      label.textContent = Math.round(dist) + "m";
      label.style.left = screen.left + "px";
      label.style.top = screen.top + "px";
    }
  }

  /* The aim bubble at the active shot's target, and the green ring in green
     focus — both live in the tilt viewport, positioned with the same frame
     transform as the dot, so all three project together. */
  function renderShotOverlays(pos, model) {
    var img = document.getElementById("surfaceImage");
    var published = document.body.classList.contains("surface-published");
    var meta = null;
    if (published && img && img.dataset.playSurface && activeFrame) {
      try { meta = JSON.parse(img.dataset.playSurface); } catch (e) { meta = null; }
    }
    function project(pt) {
      if (!meta || !pt) return null;
      var px = surfaceLib.projectToSurface(meta, pt.lat, pt.lng);
      return px ? surfaceLib.transformApply(activeFrame, px) : null;
    }
    var act = app.shot && app.shot.active();
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
          if (playerScreen && targetScreen) {
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
              var shapePts = (rec.greenShape || []).map(project).filter(Boolean);
              if (shapePts.length >= 3) {
                parts.unshift('<path class="greenReference" d="M' + shapePts.map(function (p) {
                  return p.left.toFixed(1) + "," + p.top.toFixed(1);
                }).join("L") + 'Z"/>');
              }
              var gx = greenScreen.left - centerScreen.left, gy = greenScreen.top - centerScreen.top;
              var glen = Math.hypot(gx, gy) || 1;
              var trim = Math.min(10, glen * 0.05);
              var gux = gx / glen, guy = gy / glen;
              parts.push('<path class="middleGuide" d="M' + (centerScreen.left + gux * trim).toFixed(1) + "," + (centerScreen.top + guy * trim).toFixed(1)
                + "L" + (greenScreen.left - gux * trim).toFixed(1) + "," + (greenScreen.top - guy * trim).toFixed(1) + '"/>');
              var lx = centerScreen.left + gx * 0.52 + (-gy / glen) * 18;
              var ly = centerScreen.top + gy * 0.52 + (gx / glen) * 18;
              parts.push('<text class="middleGuideLabel" x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '">Green ' + Math.round(gap) + "m</text>");
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
      if (pos && (pos.source === "tap" || pos.source === "tee" || pos.source === "shotend")) {
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
    /* Aim changes sync the engine, then re-render (re-frame unless mid-drag). */
    app.shot.onChange(function () {
      var act = app.shot.active();
      if (window.GDBubbleEngine) window.GDBubbleEngine.setShot(act && act.start, act && act.target);
      renderPosition(app.position.current());
    });
    /* The engine's pixel caps see the real on-surface scale through this seam. */
    if (window.GDBubbleEngine) window.GDBubbleEngine.setProjection({
      toScreen: function (ll) {
        try {
          var img = document.getElementById("surfaceImage");
          if (!img || !img.dataset.playSurface || !activeFrame) return null;
          var meta = JSON.parse(img.dataset.playSurface);
          var px = surfaceLib.projectToSurface(meta, ll.lat, ll.lng);
          if (!px) return null;
          var screen = surfaceLib.transformApply(activeFrame, px);
          return { x: screen.left, y: screen.top };
        } catch (e) { return null; }
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
        if (!act || !act.target || !activeFrame) return;
        /* DELTA dragging: the cluster centre sits offset from the aim (aim
           offset, forward bias, bag roof), so grabbing it must not snap the
           aim to the finger — remember the grab offset and move the aim by
           the drag delta. */
        var img = document.getElementById("surfaceImage");
        try {
          var meta = JSON.parse(img.dataset.playSurface);
          var px = surfaceLib.projectToSurface(meta, act.target.lat, act.target.lng);
          if (!px) return;
          var targetScreen = surfaceLib.transformApply(activeFrame, px);
          bubbleDragOffset = { x: targetScreen.left - e.clientX, y: targetScreen.top - e.clientY };
        } catch (err) { return; }
        /* Capture keeps the drag alive when the finger outruns the hit; if it
           is unavailable the hit re-centres under the finger every render, so
           dragging still works — a capture failure must not kill the drag. */
        try { bubble.setPointerCapture(e.pointerId); } catch (err) {}
        document.body.classList.add("bubble-dragging");
        e.preventDefault();
      });
      bubble.addEventListener("pointermove", function (e) {
        if (!document.body.classList.contains("bubble-dragging") || !activeFrame || !bubbleDragOffset) return;
        var img = document.getElementById("surfaceImage");
        if (!img || !img.dataset.playSurface) return;
        try {
          var meta = JSON.parse(img.dataset.playSurface);
          var px = surfaceLib.transformInvert(activeFrame,
            { left: e.clientX + bubbleDragOffset.x, top: e.clientY + bubbleDragOffset.y });
          var w = Number(meta.outputDimensions.width), h = Number(meta.outputDimensions.height);
          if (px && px.x >= 0 && px.y >= 0 && px.x <= w && px.y <= h) {
            app.shot.aim(surfaceLib.latLngFromWorldPx(
              { x: Number(meta.originPx.x) + px.x, y: Number(meta.originPx.y) + px.y },
              Number(meta.captureZoom)));
          }
        } catch (err) {}
      });
      bubble.addEventListener("pointerup", endBubbleDrag);
      bubble.addEventListener("pointercancel", endBubbleDrag);
    }

    /* Dragging the placed pin on a published surface — same delta-based
       technique as the aim bubble, so it works under the lock tilt too. The
       live-map pin (pinMapMarker in renderPin) drags through Leaflet's own
       marker dragging instead; this block only covers the projected DOM
       marker shown while a surface is up. */
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
        if (!pin || !activeFrame) return;
        var img = document.getElementById("surfaceImage");
        try {
          var meta = JSON.parse(img.dataset.playSurface);
          var px = surfaceLib.projectToSurface(meta, pin.lat, pin.lng);
          if (!px) return;
          var pinScreen = surfaceLib.transformApply(activeFrame, px);
          pinDragOffset = { x: pinScreen.left - e.clientX, y: pinScreen.top - e.clientY };
        } catch (err) { return; }
        try { pinMarkerEl.setPointerCapture(e.pointerId); } catch (err) {}
        document.body.classList.add("pin-dragging");
        e.preventDefault();
      });
      pinMarkerEl.addEventListener("pointermove", function (e) {
        if (!document.body.classList.contains("pin-dragging") || !activeFrame || !pinDragOffset) return;
        var img = document.getElementById("surfaceImage");
        if (!img || !img.dataset.playSurface) return;
        try {
          var meta = JSON.parse(img.dataset.playSurface);
          var px = surfaceLib.transformInvert(activeFrame,
            { left: e.clientX + pinDragOffset.x, top: e.clientY + pinDragOffset.y });
          var w = Number(meta.outputDimensions.width), h = Number(meta.outputDimensions.height);
          if (px && px.x >= 0 && px.y >= 0 && px.x <= w && px.y <= h) {
            app.pin.set(surfaceLib.latLngFromWorldPx(
              { x: Number(meta.originPx.x) + px.x, y: Number(meta.originPx.y) + px.y },
              Number(meta.captureZoom)));
          }
        } catch (err) {}
      });
      pinMarkerEl.addEventListener("pointerup", endPinDrag);
      pinMarkerEl.addEventListener("pointercancel", endPinDrag);
    }

    /* Hole Out: the final shot ends where the player stands; next hole opens
       at its pre-frame state. */
    var holeOut = document.getElementById("holeOutBtn");
    if (holeOut) holeOut.addEventListener("click", function () {
      app.shot.holeOut(app.position.current());
      app.play.nextHole();
    });
    /* Shot End: "this is where that shot finished" using the freshest fix
       available — the freshest device GPS fix if there is one, else the
       player's current position (the map-tap fallback, off-course testing
       included). Promoting it with source "shotend" is what makes it a
       deliberate placement; app.position.set does the rest through the
       onChange wiring above, same as a tap.

       In green focus, ending a shot there IS holing out - same as pressing
       Hole Out. Uses the position dot itself (not a raw GPS fix, which can
       differ slightly from what's actually on screen), matching how
       holeOutBtn below reads it. */
    var shotEnd = document.getElementById("shotEndBtn");
    if (shotEnd) shotEnd.addEventListener("click", function () {
      if (frameStage === "zoom") {
        app.shot.holeOut(app.position.current());
        app.play.nextHole();
        return;
      }
      var fix = (app.gps && app.gps.lastFix()) || app.position.current();
      if (fix) app.position.set(fix, "shotend");
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
      if (current.rec && current.rec.tee) app.position.set(current.rec.tee, "tee");
    });
    var standingHere = document.getElementById("standingHereBtn");
    if (standingHere) standingHere.addEventListener("click", function () {
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
          app.position.set(tapped, "tap");
        }
      } catch (err) {}
    });
    /* Re-frame on viewport changes — event-driven, no polling. Dropping the
       held frame forces a recompute at the new dimensions. */
    window.addEventListener("resize", function () {
      if (!document.body.classList.contains("surface-published")) return;
      activeFrame = null;
      renderPosition(app.position.current());
    });
  }

  var provenance = null;   // what is on screen and where it came from
  var activeFrame = null;  // the current stage's frame transform, null → contain fit
  var frameStage = "hole"; // hole | lock | zoom
  var startPillDismissed = false;   // "Standing Here" chosen: tap places the player

  var ZOOM_GREEN_M = 45;   // inside this of the green centre → green zoom

  /* Which stage the current position asks for. Placing the player IS the
     lock-in — head-to-tee or a tap starts the shot, so any position locks the
     shot view. The pre-locked hole frame exists only while the start pill is
     up (no position yet); the green zoom takes over inside 45m. */
  function desiredStage(pos) {
    var rec = current.rec;
    if (!pos || !rec || !rec.green) return "hole";
    var toGreen = app.distance.haversineMeters(pos, rec.green);
    if (Number.isFinite(toGreen) && toGreen <= ZOOM_GREEN_M) return "zoom";
    return "lock";
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
      && (document.body.classList.contains("bubble-dragging") || viewLocked || (pos && pos.source === "gps"));
    frameStage = stage;
    document.body.dataset.frameStage = frameStage;
    document.body.classList.toggle("tilt-lock", frameStage === "lock");
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
    activeFrame = surfaceLib.stageFrameTransform(meta, frameStage, pts, view);
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
    frameStage = "hole";
    delete document.body.dataset.frameStage;
    document.body.classList.remove("tilt-lock");
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
      setViewLocked(false);
      if (app.undo) app.undo.clear();
      if (app.gps) app.gps.stop();
      app.position.clear();
      clearSurface();
      if (objectLayer) { objectLayer.remove(); objectLayer = null; }
      if (positionMarker) { positionMarker.remove(); positionMarker = null; }
      if (pinMapMarker) { pinMapMarker.remove(); pinMapMarker = null; }
      current = { courseKey: null, pkg: null, hole: 0, rec: null, nines: null, centre: null };
    },
    state: function () { return { courseKey: current.courseKey, hole: current.hole, nines: current.nines }; },
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
      var published = document.body.classList.contains("surface-published");
      var img = document.getElementById("surfaceImage");
      if (published && img && img.dataset.playSurface) {
        try {
          var meta = JSON.parse(img.dataset.playSurface);
          if (activeFrame) {
            var px = surfaceLib.transformInvert(activeFrame, { left: clientX, top: clientY });
            var w = Number(meta.outputDimensions.width), h = Number(meta.outputDimensions.height);
            if (px && px.x >= 0 && px.y >= 0 && px.x <= w && px.y <= h) {
              return surfaceLib.latLngFromWorldPx(
                { x: Number(meta.originPx.x) + px.x, y: Number(meta.originPx.y) + px.y },
                Number(meta.captureZoom));
            }
            return null;
          }
          var rect = img.getBoundingClientRect();
          return surfaceLib.surfaceScreenToLatLng(meta,
            { left: clientX - rect.left, top: clientY - rect.top },
            { width: rect.width, height: rect.height });
        } catch (e) { return null; }
      }
      if (map) {
        try {
          var ll = map.mouseEventToLatLng({ clientX: clientX, clientY: clientY });
          return ll ? { lat: ll.lat, lng: ll.lng } : null;
        } catch (e) { return null; }
      }
      return null;
    }
  };
})();
