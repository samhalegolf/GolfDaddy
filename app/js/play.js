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
  var gpsMarker = null;
  var gpsWired = false;
  var transitionToken = 0;
  var current = { courseKey: null, pkg: null, hole: 0, rec: null };
  var store = null;

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

  function ensureMap() {
    if (map || typeof L === "undefined") return map;
    map = L.map("map", { zoomControl: false, attributionControl: false })
      .setView([-36.9, 174.78], 15);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
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
     geometry it leaves the current view — a normal outcome, not an error. */
  function frameHole(rec) {
    if (!ensureMap()) return;
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
    if (pts.length) {
      objectLayer = L.layerGroup(pts.map(function (p) { return L.circleMarker(p, { radius: 4 }); })).addTo(map);
    }
  }

  function renderDistances(fix) {
    var bar = document.getElementById("distanceBar");
    if (!bar) return;
    var rec = current.rec;
    var d = fix && rec && rec.green ? app.distance.greenDistances(fix, rec) : null;
    bar.classList.toggle("hiddenState", !d || d.centre === null);
    if (!d || d.centre === null) return;
    document.getElementById("distFront").textContent = d.front === null ? "–" : d.front;
    document.getElementById("distCentre").textContent = d.centre;
    document.getElementById("distBack").textContent = d.back === null ? "–" : d.back;
  }

  /* One renderer for both presentations: the same fix moves the Leaflet marker
     and, when a surface is up, the projected dot. An off-surface or absent fix
     hides the dot — a normal state, not an error. */
  function renderFix(fix) {
    if (fix && map) {
      if (!gpsMarker) {
        gpsMarker = L.circleMarker([fix.lat, fix.lng], {
          radius: 7, weight: 2, color: "#ffffff", fillColor: "#2f8fef", fillOpacity: 1, className: "gpsMarker"
        }).addTo(map);
      } else {
        gpsMarker.setLatLng([fix.lat, fix.lng]);
      }
    }
    var dot = document.getElementById("gpsDot");
    if (!dot) return;
    var img = document.getElementById("surfaceImage");
    var onSurface = null;
    if (fix && img && document.body.classList.contains("surface-published") && img.dataset.playSurface) {
      try {
        var meta = JSON.parse(img.dataset.playSurface);
        var imagePx = surfaceLib.projectToSurface(meta, fix.lat, fix.lng);
        if (imagePx) {
          onSurface = surfaceLib.fitContain(imagePx, meta.outputDimensions,
            { width: img.clientWidth, height: img.clientHeight });
        }
      } catch (e) { onSurface = null; }
    }
    dot.classList.toggle("hiddenState", !onSurface);
    if (onSurface) {
      dot.style.left = onSurface.left + "px";
      dot.style.top = onSurface.top + "px";
    }
    renderDistances(fix);
  }

  function wireGps() {
    if (gpsWired || !app.gps) return;
    gpsWired = true;
    app.gps.onFix(renderFix);
  }

  function clearSurface() {
    document.body.classList.remove("surface-published");
    var img = document.getElementById("surfaceImage");
    if (img) { img.removeAttribute("src"); img.dataset.playSurface = ""; }
    renderFix(app.gps && app.gps.lastFix());
  }

  function presentSurface(asset) {
    var img = document.getElementById("surfaceImage");
    if (!img) return;
    img.dataset.playSurface = JSON.stringify(asset.playSurface);
    img.onload = function () {
      document.body.classList.add("surface-published");
      renderFix(app.gps && app.gps.lastFix());
    };
    /* Load failure = stay on the live map; the class was never added. */
    img.onerror = clearSurface;
    img.src = asset.url || surfaceLib.assetUrl(asset.path);
  }

  app.play = {
    /* centre: {lat,lng} from the library row — the view when the package has no
       geometry for a hole yet, so an unmapped course still opens on itself. */
    async start(courseKey, pkg, centre) {
      transitionToken += 1;
      current = { courseKey: app.courseKey(courseKey), pkg: pkg || null, hole: 0, rec: null };
      var m = ensureMap();
      if (m && centre && Number.isFinite(Number(centre.lat)) && Number.isFinite(Number(centre.lng))) {
        m.setView([Number(centre.lat), Number(centre.lng)], 15);
      }
      wireGps();
      if (app.gps) app.gps.start();
      await this.goHole(1);
    },
    async goHole(hole) {
      var token = ++transitionToken;
      clearSurface();
      current.hole = Number(hole) || 1;
      current.rec = holeRecord(current.pkg, current.hole);
      var holeEl = document.getElementById("holeNumber");
      if (holeEl) holeEl.textContent = String(current.hole);
      frameHole(current.rec);
      renderDistances(app.gps && app.gps.lastFix());
      /* A full package carries the hole's published surface inline — one
         request, nothing to reconcile. Only a lite package asks the visuals
         endpoint, and that absence answer is cached per hole. */
      if (current.rec && current.rec.visual) {
        presentSurface(current.rec.visual);
        return;
      }
      var answer = await ensureStore().surfaceFor(current.courseKey, current.hole);
      if (token !== transitionToken) return;   // superseded transition: drop silently
      if (answer.state === "published") presentSurface(answer.asset);
      /* answer.state === "none" needs no branch: the live map is already up. */
    },
    stop() {
      transitionToken += 1;
      if (app.gps) app.gps.stop();
      clearSurface();
      if (objectLayer) { objectLayer.remove(); objectLayer = null; }
      if (gpsMarker) { gpsMarker.remove(); gpsMarker = null; }
      current = { courseKey: null, pkg: null, hole: 0, rec: null };
    },
    state: function () { return { courseKey: current.courseKey, hole: current.hole }; }
  };
})();
