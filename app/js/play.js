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
  var current = { courseKey: null, pkg: null, hole: 0, rec: null };
  var store = null;

  var GPS_ADOPT_RADIUS_M = 1500;

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
    /* Tap where you are standing — same contract as a real fix. */
    map.on("click", function (e) {
      if (e && e.latlng) app.position.set({ lat: e.latlng.lat, lng: e.latlng.lng }, "tap");
    });
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
    else if (current.centre) map.setView([current.centre.lat, current.centre.lng], 15);
    if (pts.length) {
      objectLayer = L.layerGroup(pts.map(function (p) { return L.circleMarker(p, { radius: 4 }); })).addTo(map);
    }
    var pos = app.position.current();
    if (pos) renderPosition(pos);
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
    var dot = document.getElementById("gpsDot");
    if (!dot) return;
    var img = document.getElementById("surfaceImage");
    var onSurface = null;
    if (pos && img && document.body.classList.contains("surface-published") && img.dataset.playSurface) {
      try {
        var meta = JSON.parse(img.dataset.playSurface);
        var imagePx = surfaceLib.projectToSurface(meta, pos.lat, pos.lng);
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
    renderDistances(pos);
  }

  /* A real fix only becomes the position when it is plausibly ON this hole —
     within 1.5km of its geometry. Off-course (testing from the couch), the fix
     is simply ignored and head-to-tee / tap-to-stand keep driving. With no
     geometry to judge against, a fix is adopted only if nothing has placed the
     player yet, so it never clobbers a deliberate tap. */
  function maybeAdoptGpsFix(fix) {
    if (!fix) return;
    var rec = current.rec;
    var anchor = rec && (rec.green || rec.tee);
    if (anchor) {
      var away = app.distance.haversineMeters(fix, anchor);
      if (Number.isFinite(away) && away <= GPS_ADOPT_RADIUS_M) app.position.set(fix, "gps");
      return;
    }
    if (!app.position.current()) app.position.set(fix, "gps");
  }

  function wirePosition() {
    if (positionWired) return;
    positionWired = true;
    app.position.onChange(renderPosition);
    if (app.gps) app.gps.onFix(maybeAdoptGpsFix);
    /* The provenance chip toggles the full metadata panel. */
    var chip = document.getElementById("surfaceSource");
    var panel = document.getElementById("surfaceMetaPanel");
    if (chip && panel) chip.addEventListener("click", function () {
      panel.classList.toggle("hiddenState");
      if (!panel.classList.contains("hiddenState")) panel.textContent = JSON.stringify(provenance, null, 2);
    });
    /* Tap where you are standing, on the published surface. */
    var img = document.getElementById("surfaceImage");
    if (img) img.addEventListener("click", function (e) {
      if (!img.dataset.playSurface) return;
      try {
        var meta = JSON.parse(img.dataset.playSurface);
        var rect = img.getBoundingClientRect();
        var tapped = surfaceLib.surfaceScreenToLatLng(meta,
          { left: e.clientX - rect.left, top: e.clientY - rect.top },
          { width: rect.width, height: rect.height });
        if (tapped) app.position.set(tapped, "tap");
      } catch (err) {}
    });
  }

  var provenance = null;   // what is on screen and where it came from

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
    if (img) { img.removeAttribute("src"); img.dataset.playSurface = ""; }
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
      var lat = Number(centre && centre.lat), lng = Number(centre && centre.lng);
      current = {
        courseKey: app.courseKey(courseKey), pkg: pkg || null, hole: 0, rec: null,
        centre: Number.isFinite(lat) && Number.isFinite(lng) ? { lat: lat, lng: lng } : null
      };
      wirePosition();
      if (app.gps) app.gps.start();
      await this.goHole(1);
    },
    async goHole(hole) {
      var token = ++transitionToken;
      current.hole = Number(hole) || 1;
      current.rec = holeRecord(current.pkg, current.hole);
      var holeEl = document.getElementById("holeNumber");
      if (holeEl) holeEl.textContent = String(current.hole);
      /* Head to the tee: entering a hole places the player on its tee. A later
         tap moves them; and if the last real fix is standing on this hole, it
         outranks the tee immediately — on-course, you are where you are. */
      if (current.rec && current.rec.tee) {
        app.position.set(current.rec.tee, "tee");
        if (app.gps) maybeAdoptGpsFix(app.gps.lastFix());
      } else {
        renderDistances(app.position.current());
      }
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
      if (app.gps) app.gps.stop();
      app.position.clear();
      clearSurface();
      if (objectLayer) { objectLayer.remove(); objectLayer = null; }
      if (positionMarker) { positionMarker.remove(); positionMarker = null; }
      current = { courseKey: null, pkg: null, hole: 0, rec: null, centre: null };
    },
    state: function () { return { courseKey: current.courseKey, hole: current.hole }; }
  };
})();
