/* Clarity Studio — Mapping Overlay. Studio-only.
 *
 * What it is for: drawing the fairway polygons (and, when quicker, tee-to-green hole lines)
 * that OSM does not have, so the mapper can resolve a course whose OSM data is greens and
 * nothing else. Royal Belfast is the case: eleven greens in OSM, no fairways, no hole lines,
 * and the resolver has nothing to build a centre-line from.
 *
 * What it writes: one thing, the course's overlay row (course_map_overlays) through
 * /api/course-map-overlay. The mapper worker merges that overlay into the Overpass payload as
 * ordinary golf=fairway / golf=hole ways (functions/lib/gd-map-overlay-core.mjs), so nothing
 * downstream knows the difference. It does NOT write objects, holes, a pin or a package - the
 * overlay changes nothing on the course until a mapper run is requested, which the button at
 * the bottom does through the same /api/course-mapper-jobs path Course Database uses.
 *
 * Borrowed, not owned: the course list (the real picker, through gd-studio-course-pick.js),
 * the provider list (window.GDMapSources from gd-app-core.js), and what OSM has here (asked
 * of the server, which runs the mapper's own query, so the greens drawn under your cursor are
 * the greens the resolver will link your fairway to). */
(function () {
  "use strict";

  var API = "/api/course-map-overlay";
  var JOBS_API = "/api/course-mapper-jobs";

  /* Survives leaving and re-entering the page - the shell tears the DOM down on every route
     change, and losing half-drawn fairways to a mis-click on the nav is not acceptable. */
  var session = { course: null, features: [], loadedFor: "", osm: null, dirty: false, view: null, sourceKey: "", showOsm: true };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : null; }
  function sourcesApi() { return window.GDMapSources || null; }
  function liveSources() { var api = sourcesApi(); return api && Array.isArray(api.list) ? api.list : []; }
  function courseIdOf(course) {
    return String(course && (course.courseId || course.id || course.canonicalKey) || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
  }
  function courseLatLng(course) {
    var lat = num(course && (course.lat != null ? course.lat : course.latitude));
    var lng = num(course && (course.lng != null ? course.lng : course.longitude));
    return lat != null && lng != null ? [lat, lng] : null;
  }
  function accessToken() {
    if (typeof window.gdAdminCourseDbAccessToken === "function") return window.gdAdminCourseDbAccessToken();
    try {
      var auth = window.ClaritySupabaseAuth;
      var s = auth && typeof auth.session === "function" ? auth.session() : null;
      return Promise.resolve(String(s && (s.access_token || s.accessToken) || ""));
    } catch (e) { return Promise.resolve(""); }
  }
  function nextFeatureId(features) {
    var n = 0;
    features.forEach(function (f) { var m = /^f-(\d+)$/.exec(f.id || ""); if (m) n = Math.max(n, Number(m[1])); });
    return "f-" + (n + 1);
  }
  function kindLabel(kind) { return kind === "hole" ? "Hole line" : kind === "green" ? "Green" : "Fairway"; }
  function isPolygon(kind) { return kind === "fairway" || kind === "green"; }
  function minPoints(kind) { return isPolygon(kind) ? 3 : 2; }

  var STYLE = {
    fairway: { color: "#3cff8d", weight: 2, fillColor: "#3cff8d", fillOpacity: 0.22 },
    fairwaySelected: { color: "#ffffff", weight: 3, fillColor: "#3cff8d", fillOpacity: 0.35 },
    hole: { color: "#3cff8d", weight: 3, dashArray: "8 6" },
    holeSelected: { color: "#ffffff", weight: 4, dashArray: "8 6" },
    green: { color: "#b7ff5c", weight: 2, fillColor: "#b7ff5c", fillOpacity: 0.4 },
    greenSelected: { color: "#ffffff", weight: 3, fillColor: "#b7ff5c", fillOpacity: 0.5 },
    draft: { color: "#ffb54c", weight: 2, dashArray: "4 4", fillColor: "#ffb54c", fillOpacity: 0.12 },
    vertex: { radius: 4, color: "#ffb54c", weight: 2, fillColor: "#1a1a1a", fillOpacity: 1 },
    osmGreen: { color: "#b7ff5c", weight: 2, fillColor: "#b7ff5c", fillOpacity: 0.28 },
    osmFairway: { color: "#8fa79c", weight: 1, dashArray: "3 5", fillOpacity: 0 },
    osmTee: { color: "#6cc7ff", weight: 2, fillColor: "#6cc7ff", fillOpacity: 0.3 },
    osmHole: { color: "#ffffff", weight: 1, dashArray: "2 6", opacity: 0.7 }
  };

  function render(containerEl) {
    var mapObj = null;
    var layer = null;
    var destroyed = false;
    var tool = "fairway";
    var draft = [];
    var draftLayers = [];
    var featureLayers = [];
    var osmLayers = [];
    var selectedId = "";
    var busy = false;

    containerEl.innerHTML =
      '<div class="gdStudioLede" style="margin-bottom:12px">' +
      "<p>Draw what OSM is missing. Pick a course, then click around each fairway to trace it and " +
      "<strong>finish</strong> the shape (double-click, Enter, or the button). The bright green outlines " +
      "are the greens OSM already has - the mapper links each fairway to the nearest one, so draw the " +
      "fairway to within about 200m of its green. A numbered <strong>hole line</strong> from tee to green is " +
      "quicker and is the strongest evidence the resolver gets. Where OSM has no green at all, draw the " +
      "<strong>green</strong> too - a fairway with no green to link to is not a hole. Save, then run the mapper. " +
      "The overlay is temporary: delete it once OSM carries the real shapes.</p></div>" +
      '<div class="gdStudioViewportBar">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="pick">Pick course</button>' +
      '<span class="gdStudioViewportCourse" data-gd-overlay="course">No course picked</span>' +
      '<label class="gdStudioViewportField">Provider <select data-gd-overlay="provider"></select></label>' +
      '<label class="gdStudioViewportField"><input type="checkbox" data-gd-overlay="osm" checked> Show OSM greens</label>' +
      "</div>" +
      '<div class="gdStudioViewportBar">' +
      '<span class="gdStudioViewportField">Draw</span>' +
      '<button type="button" class="gdStudioDiagramBtn isActive" data-gd-overlay="tool-fairway">Fairway polygon</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="tool-hole">Hole line</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="tool-green">Green polygon</button>' +
      '<label class="gdStudioViewportField">Hole # <input type="number" min="1" max="36" data-gd-overlay="hole" class="gdStudioOverlayHole"></label>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="finish" disabled>Finish shape</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="undo" disabled>Undo point</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="cancel" disabled>Cancel</button>' +
      "</div>" +
      '<div class="gdStudioViewportMap gdStudioOverlayMap" data-gd-overlay="map"></div>' +
      '<div class="gdStudioViewportReadout" data-gd-overlay="readout"></div>' +
      '<div class="gdStudioViewportCredit" data-gd-overlay="credit"></div>' +
      '<div class="gdStudioViewportBar" style="margin-top:12px">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="save" disabled>Save overlay</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="reload" disabled>Reload saved</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="clear" disabled>Delete overlay</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="run" disabled>Run mapper with overlay</button>' +
      '<span class="gdStudioViewportScan" data-gd-overlay="status"></span>' +
      "</div>" +
      '<div class="gdStudioOverlayList" data-gd-overlay="list"></div>';

    var el = {};
    ["pick", "course", "provider", "osm", "tool-fairway", "tool-hole", "tool-green", "hole", "finish", "undo", "cancel", "map", "readout", "credit", "save", "reload", "clear", "run", "status", "list"].forEach(function (name) {
      el[name] = containerEl.querySelector('[data-gd-overlay="' + name + '"]');
    });

    if (typeof window.L === "undefined" || !sourcesApi()) {
      el.map.innerHTML = '<p class="gdStudioMuted" style="padding:16px">Leaflet or the map source list did not load on this surface.</p>';
      return null;
    }

    /* ---- providers (borrowed from gd-app-core, same list the app plays over) ---- */

    function centre() { try { return mapObj ? mapObj.getCenter() : null; } catch (e) { return null; } }
    function sourceByKey(key) { return liveSources().filter(function (s) { return s.key === key; })[0] || null; }
    function availability(source, here) {
      var api = sourcesApi();
      if (source.requiresKey && !api.keyValue(source.requiresKey)) return "no key";
      if (here && !api.covers(source, here)) return "no coverage here";
      return "";
    }
    var providerSignature = "";
    function buildProviderOptions() {
      var here = centre();
      var rows = liveSources().map(function (s) {
        var why = availability(s, here);
        return { key: s.key, text: s.name + (why ? " — " + why : "") };
      });
      var signature = rows.map(function (r) { return r.key + "|" + r.text; }).join("\n");
      if (signature === providerSignature) return;
      providerSignature = signature;
      var current = el.provider.value || session.sourceKey;
      el.provider.innerHTML = rows.map(function (r) { return '<option value="' + esc(r.key) + '">' + esc(r.text) + "</option>"; }).join("");
      if (current) el.provider.value = current;
    }
    /* Imagery first: a fairway is traced off the ground, and the OSM line guide has no ground
       to trace. First covering source in list order is the app's own preference, which puts
       regional aerial before the global fallback; the line guide is what is left when nothing
       aerial covers the view. */
    function bestSourceKey() {
      var here = centre();
      var api = sourcesApi();
      var covering = liveSources().filter(function (s) { return api.ready(s, here); });
      var aerial = covering.filter(function (s) { return !/osm|line|guide|street/i.test(String(s.key) + " " + String(s.name)); })[0];
      var found = aerial || covering[0];
      return found ? found.key : (liveSources()[0] || {}).key || "";
    }
    function useSource(key) {
      var source = sourceByKey(key) || liveSources()[0];
      if (!source) return;
      session.sourceKey = source.key;
      el.provider.value = source.key;
      if (layer) { try { mapObj.removeLayer(layer); } catch (e) {} }
      layer = sourcesApi().buildLayer(source);
      layer.addTo(mapObj);
      try { mapObj.setMaxZoom(num(source.options && source.options.maxZoom) || 21); } catch (e) {}
      el.credit.innerHTML = esc(source.label) + (source.attribution ? " — " + esc(source.attribution) : "");
    }

    /* ---- drawing ---- */

    function setTool(next) {
      tool = next === "hole" || next === "green" ? next : "fairway";
      el["tool-fairway"].classList.toggle("isActive", tool === "fairway");
      el["tool-hole"].classList.toggle("isActive", tool === "hole");
      el["tool-green"].classList.toggle("isActive", tool === "green");
      if (draft.length) cancelDraft();
      updateReadout();
    }

    function clearDraftLayers() {
      draftLayers.forEach(function (l) { try { mapObj.removeLayer(l); } catch (e) {} });
      draftLayers = [];
    }

    function drawDraft() {
      clearDraftLayers();
      if (!draft.length) return;
      var latlngs = draft.map(function (p) { return [p.lat, p.lng]; });
      var shape = isPolygon(tool) && draft.length >= 3 ? L.polygon(latlngs, STYLE.draft) : L.polyline(latlngs, STYLE.draft);
      shape.addTo(mapObj);
      draftLayers.push(shape);
      draft.forEach(function (p) {
        var v = L.circleMarker([p.lat, p.lng], STYLE.vertex).addTo(mapObj);
        draftLayers.push(v);
      });
    }

    function draftButtons() {
      el.finish.disabled = draft.length < minPoints(tool);
      el.undo.disabled = !draft.length;
      el.cancel.disabled = !draft.length;
    }

    function addVertex(latlng) {
      if (!session.course) { setStatus("Pick a course first."); return; }
      var last = draft[draft.length - 1];
      /* A double-click delivers two clicks first; the second lands on the first's point and
         would leave a zero-length edge behind the finish. */
      if (last && Math.abs(last.lat - latlng.lat) < 1e-7 && Math.abs(last.lng - latlng.lng) < 1e-7) return;
      draft.push({ lat: latlng.lat, lng: latlng.lng });
      drawDraft();
      draftButtons();
      updateReadout();
    }

    function undoVertex() {
      draft.pop();
      drawDraft();
      draftButtons();
      updateReadout();
    }

    function cancelDraft() {
      draft = [];
      clearDraftLayers();
      draftButtons();
      updateReadout();
    }

    function finishDraft() {
      if (draft.length < minPoints(tool)) return;
      var hole = num(el.hole.value);
      hole = hole && hole >= 1 && hole <= 36 ? Math.round(hole) : null;
      session.features.push({ id: nextFeatureId(session.features), kind: tool, hole: hole, points: draft.slice() });
      session.dirty = true;
      /* Hole numbers usually run in sequence; stepping the box saves retyping it 18 times
         and a wrong guess is one keystroke to fix. */
      if (hole) el.hole.value = hole < 36 ? hole + 1 : "";
      draft = [];
      clearDraftLayers();
      draftButtons();
      drawFeatures();
      renderList();
      updateActions();
      updateReadout();
    }

    /* ---- saved features ---- */

    function clearFeatureLayers() {
      featureLayers.forEach(function (l) { try { mapObj.removeLayer(l); } catch (e) {} });
      featureLayers = [];
    }

    function drawFeatures() {
      clearFeatureLayers();
      session.features.forEach(function (f) {
        var latlngs = f.points.map(function (p) { return [p.lat, p.lng]; });
        var selected = f.id === selectedId;
        var shape = f.kind === "fairway" ? L.polygon(latlngs, selected ? STYLE.fairwaySelected : STYLE.fairway)
          : f.kind === "green" ? L.polygon(latlngs, selected ? STYLE.greenSelected : STYLE.green)
          : L.polyline(latlngs, selected ? STYLE.holeSelected : STYLE.hole);
        shape.addTo(mapObj);
        shape.on("click", function (e) {
          /* Selecting a saved shape must not also drop a vertex under it. */
          if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent);
          select(f.id);
        });
        if (f.hole) {
          shape.bindTooltip(String(f.hole), { permanent: true, direction: "center", className: "gdStudioOverlayLabel" });
        }
        featureLayers.push(shape);
      });
    }

    function select(id) {
      selectedId = selectedId === id ? "" : id;
      drawFeatures();
      renderList();
    }

    function removeFeature(id) {
      session.features = session.features.filter(function (f) { return f.id !== id; });
      session.dirty = true;
      if (selectedId === id) selectedId = "";
      drawFeatures();
      renderList();
      updateActions();
    }

    function renumber(id, value) {
      var f = session.features.filter(function (x) { return x.id === id; })[0];
      if (!f) return;
      var hole = num(value);
      f.hole = hole && hole >= 1 && hole <= 36 ? Math.round(hole) : null;
      session.dirty = true;
      drawFeatures();
      updateActions();
    }

    function renderList() {
      if (!session.features.length) {
        el.list.innerHTML = session.course ? '<p class="gdStudioMuted">No overlay shapes yet.</p>' : "";
        return;
      }
      el.list.innerHTML = '<table class="gdStudioOverlayTable"><thead><tr><th>#</th><th>Kind</th><th>Hole</th><th>Points</th><th></th></tr></thead><tbody>' +
        session.features.map(function (f, i) {
          return '<tr data-gd-overlay-row="' + esc(f.id) + '"' + (f.id === selectedId ? ' class="isSelected"' : "") + ">" +
            "<td>" + (i + 1) + "</td><td>" + esc(kindLabel(f.kind)) + (f.source ? ' <span class="gdStudioMuted">· ' + esc(f.source) + "</span>" : "") + "</td>" +
            '<td><input type="number" min="1" max="36" class="gdStudioOverlayHole" data-gd-overlay-hole="' + esc(f.id) + '" value="' + (f.hole || "") + '"></td>' +
            "<td>" + f.points.length + "</td>" +
            '<td><button type="button" class="gdStudioDiagramBtn" data-gd-overlay-remove="' + esc(f.id) + '">Remove</button></td></tr>';
        }).join("") + "</tbody></table>";
    }

    el.list.addEventListener("click", function (event) {
      var remove = event.target.closest("[data-gd-overlay-remove]");
      if (remove) { removeFeature(remove.getAttribute("data-gd-overlay-remove")); return; }
      if (event.target.closest("input")) return;
      var row = event.target.closest("[data-gd-overlay-row]");
      if (row) {
        var id = row.getAttribute("data-gd-overlay-row");
        select(id);
        var f = session.features.filter(function (x) { return x.id === id; })[0];
        if (f && mapObj) { try { mapObj.fitBounds(L.latLngBounds(f.points.map(function (p) { return [p.lat, p.lng]; })).pad(0.6)); } catch (e) {} }
      }
    });
    el.list.addEventListener("change", function (event) {
      var input = event.target.closest("[data-gd-overlay-hole]");
      if (input) renumber(input.getAttribute("data-gd-overlay-hole"), input.value);
    });

    /* ---- what OSM has here ---- */

    function clearOsmLayers() {
      osmLayers.forEach(function (l) { try { mapObj.removeLayer(l); } catch (e) {} });
      osmLayers = [];
    }

    function drawOsm() {
      clearOsmLayers();
      var osm = session.osm;
      if (!osm || !session.showOsm) return;
      function add(list, style, closed) {
        (list || []).forEach(function (item) {
          var latlngs = (item.points || []).map(function (p) { return [p.lat, p.lng]; });
          if (latlngs.length < 2) return;
          var shape = closed && latlngs.length >= 3 ? L.polygon(latlngs, Object.assign({ interactive: false }, style)) : L.polyline(latlngs, Object.assign({ interactive: false }, style));
          shape.addTo(mapObj);
          if (item.ref) shape.bindTooltip(String(item.ref), { permanent: true, direction: "center", className: "gdStudioOverlayLabel isOsm" });
          osmLayers.push(shape);
        });
      }
      add(osm.fairways, STYLE.osmFairway, true);
      add(osm.greens, STYLE.osmGreen, true);
      add(osm.tees, STYLE.osmTee, true);
      add(osm.holes, STYLE.osmHole, false);
    }

    /* ---- readouts ---- */

    function setStatus(text, warn) {
      el.status.innerHTML = warn ? '<span class="gdStudioWarnText">' + esc(text) + "</span>" : esc(text);
    }

    function updateReadout() {
      if (destroyed || !mapObj) return;
      var bits = [];
      var here = centre();
      if (here) bits.push("centre " + here.lat.toFixed(6) + ", " + here.lng.toFixed(6));
      bits.push("z" + mapObj.getZoom());
      if (draft.length) {
        bits.push("drawing " + kindLabel(tool).toLowerCase() + " — " + draft.length + " point" + (draft.length === 1 ? "" : "s") +
          (draft.length >= minPoints(tool) ? " · double-click or Enter to finish" : ""));
      } else if (session.course) {
        bits.push("click the map to start a " + kindLabel(tool).toLowerCase());
      } else {
        bits.push("pick a course to start");
      }
      var osm = session.osm;
      if (osm && !osm.error) bits.push("OSM here: " + (osm.greens || []).length + " greens, " + (osm.fairways || []).length + " fairways, " + (osm.holes || []).length + " hole lines");
      else if (osm && osm.error) bits.push("OSM: " + osm.error);
      el.readout.textContent = bits.join(" · ");
      session.view = here ? { lat: here.lat, lng: here.lng, zoom: mapObj.getZoom() } : session.view;
    }

    function updateActions() {
      var has = !!session.course && !busy;
      el.save.disabled = !has || !session.dirty;
      el.reload.disabled = !has;
      el.clear.disabled = !has || (!session.features.length && !session.dirty);
      el.run.disabled = !has || session.dirty;
      el.run.title = session.dirty ? "Save the overlay first - the mapper reads what is saved" : "";
    }

    /* ---- server ---- */

    function api(method, query, body) {
      return accessToken().then(function (token) {
        if (!token) throw new Error("Sign in again - no session token");
        return fetch(API + (query || ""), {
          method: method,
          headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: "Bearer " + token },
          cache: "no-store",
          body: body ? JSON.stringify(body) : undefined
        });
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!res.ok) throw new Error((data && (data.detail || data.error)) || ("HTTP " + res.status));
          return data;
        });
      });
    }

    function loadOverlay(course) {
      var id = courseIdOf(course);
      if (!id) { setStatus("This course has no id to store an overlay under.", true); return; }
      busy = true; updateActions();
      setStatus("Loading overlay and OSM features…");
      api("GET", "?courseId=" + encodeURIComponent(id) + "&osm=1").then(function (data) {
        if (destroyed || courseIdOf(session.course) !== id) return;
        session.features = (data && data.overlay && data.overlay.features) || [];
        session.osm = (data && data.osm) || null;
        session.loadedFor = id;
        session.dirty = false;
        selectedId = "";
        drawOsm();
        drawFeatures();
        renderList();
        var when = data && data.overlay && data.overlay.updatedAt ? " · saved " + new Date(data.overlay.updatedAt).toLocaleString() : "";
        setStatus(session.features.length ? session.features.length + " saved shape" + (session.features.length === 1 ? "" : "s") + when : "No overlay saved for this course yet.");
      }).catch(function (error) {
        if (destroyed) return;
        setStatus("Could not load: " + (error && error.message || error), true);
      }).then(function () {
        busy = false;
        if (!destroyed) { updateActions(); updateReadout(); }
      });
    }

    function saveOverlay() {
      var id = courseIdOf(session.course);
      if (!id || busy) return;
      busy = true; updateActions();
      setStatus("Saving…");
      api("POST", "", { courseId: id, features: session.features }).then(function (data) {
        if (destroyed) return;
        session.features = (data && data.overlay && data.overlay.features) || [];
        session.dirty = false;
        drawFeatures();
        renderList();
        var s = (data && data.summary) || {};
        setStatus("Saved: " + (s.fairways || 0) + " fairways, " + (s.holeLines || 0) + " hole lines, " + (s.greens || 0) + " greens" +
          (data && data.dropped ? " · " + data.dropped + " shape" + (data.dropped === 1 ? "" : "s") + " dropped as too small" : "") +
          ". Now run the mapper.", !!(data && data.dropped));
      }).catch(function (error) {
        if (destroyed) return;
        setStatus("Save failed: " + (error && error.message || error), true);
      }).then(function () { busy = false; if (!destroyed) updateActions(); });
    }

    function deleteOverlay() {
      var id = courseIdOf(session.course);
      if (!id || busy) return;
      if (!window.confirm("Delete every overlay shape for this course? The mapper will go back to reading OSM alone.")) return;
      session.features = [];
      session.dirty = true;
      drawFeatures();
      renderList();
      saveOverlay();
    }

    function runMapper() {
      var id = courseIdOf(session.course);
      if (!id || busy || session.dirty) return;
      if (!window.confirm("Run the mapper on " + (session.course.name || session.course.courseName || id) + " with this overlay?\n\nThis clears the course's existing geometry and resolves it again from OSM plus the overlay. Visuals are not touched.")) return;
      busy = true; updateActions();
      setStatus("Queueing mapper run…");
      accessToken().then(function (token) {
        return fetch(JOBS_API, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ courseId: id, kind: "remap" })
        });
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          if (res.status === 403) throw new Error("Admin only");
          if (!res.ok) throw new Error((data && (data.detail || data.error)) || ("HTTP " + res.status));
          setStatus(data && data.deduped ? "A mapper run is already in progress - it will pick up the saved overlay." : "Mapper run queued. Watch it in Course Database → this course → Debug (Mapping Diagnostics).");
        });
      }).catch(function (error) {
        if (destroyed) return;
        setStatus("Could not queue the mapper: " + (error && error.message || error), true);
      }).then(function () { busy = false; if (!destroyed) updateActions(); });
    }

    /* ---- course ---- */

    function showCourse(course, opts) {
      var restoring = !!(opts && opts.restoring);
      session.course = course;
      var point = courseLatLng(course);
      el.course.textContent = String(course && (course.name || course.courseName) || "Course") +
        (point ? " · " + point[0].toFixed(5) + ", " + point[1].toFixed(5) : " · no coordinates");
      if (!point) { setStatus("This course has no coordinates - set its location first.", true); return; }
      if (!restoring) {
        mapObj.setView(point, 16);
        useSource(bestSourceKey());
      }
      var id = courseIdOf(course);
      if (restoring && session.loadedFor === id) {
        drawOsm();
        drawFeatures();
        renderList();
        updateActions();
        return;
      }
      if (session.loadedFor !== id) {
        session.features = [];
        session.osm = null;
        session.dirty = false;
        clearOsmLayers();
        clearFeatureLayers();
        renderList();
      }
      loadOverlay(course);
    }

    function remeasure() {
      setTimeout(function () { if (!destroyed && mapObj) { try { mapObj.invalidateSize(); } catch (e) {} } }, 60);
    }

    function pickCourse() {
      if (session.dirty && !window.confirm("You have unsaved overlay shapes. Pick another course and lose them?")) return;
      var pick = window.GDStudioCoursePick;
      var opened = pick && typeof pick.open === "function" && pick.open({
        source: "studio-map-overlay",
        onReturn: remeasure,
        onPick: function (course) { if (!destroyed) { cancelDraft(); showCourse(course); } }
      });
      if (!opened) setStatus("The course picker is not loaded on this surface.", true);
    }

    /* ---- boot ---- */

    mapObj = L.map(el.map, {
      zoomControl: true,
      attributionControl: false,
      /* Double-click finishes a shape; zooming on it would move the ground under the last
         point. Zoom stays on the wheel and the control. */
      doubleClickZoom: false,
      scrollWheelZoom: true,
      maxZoom: 22
    }).setView([0, 0], 2);

    buildProviderOptions();
    useSource(session.sourceKey || bestSourceKey());

    mapObj.on("click", function (e) { addVertex(e.latlng); });
    mapObj.on("dblclick", function (e) {
      if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent);
      finishDraft();
    });
    mapObj.on("moveend zoomend", function () { buildProviderOptions(); updateReadout(); });

    function onKey(event) {
      if (!draft.length) return;
      var target = event.target;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      if (event.key === "Enter") { event.preventDefault(); finishDraft(); }
      else if (event.key === "Escape") { event.preventDefault(); cancelDraft(); }
      else if (event.key === "Backspace") { event.preventDefault(); undoVertex(); }
    }
    document.addEventListener("keydown", onKey);

    el.pick.addEventListener("click", pickCourse);
    el.provider.addEventListener("change", function () { useSource(el.provider.value); });
    el.osm.checked = session.showOsm;
    el.osm.addEventListener("change", function () { session.showOsm = el.osm.checked; drawOsm(); });
    el["tool-fairway"].addEventListener("click", function () { setTool("fairway"); });
    el["tool-hole"].addEventListener("click", function () { setTool("hole"); });
    el["tool-green"].addEventListener("click", function () { setTool("green"); });
    el.finish.addEventListener("click", finishDraft);
    el.undo.addEventListener("click", undoVertex);
    el.cancel.addEventListener("click", cancelDraft);
    el.save.addEventListener("click", saveOverlay);
    el.reload.addEventListener("click", function () {
      if (session.dirty && !window.confirm("Reload the saved overlay and lose unsaved shapes?")) return;
      session.loadedFor = "";
      loadOverlay(session.course);
    });
    el.clear.addEventListener("click", deleteOverlay);
    el.run.addEventListener("click", runMapper);

    if (session.course) {
      var restoring = !!session.view;
      showCourse(session.course, { restoring: restoring });
      if (session.view) { try { mapObj.setView([session.view.lat, session.view.lng], session.view.zoom); } catch (e) {} }
      if (restoring) useSource(session.sourceKey || bestSourceKey());
    }
    updateActions();
    updateReadout();
    remeasure();

    return function cleanup() {
      destroyed = true;
      document.removeEventListener("keydown", onKey);
      if (window.GDStudioCoursePick) window.GDStudioCoursePick.cancel();
      if (window.GDStudioShell) window.GDStudioShell.show();
      if (mapObj) { try { mapObj.remove(); } catch (e) {} }
      mapObj = null;
      layer = null;
      draftLayers = [];
      featureLayers = [];
      osmLayers = [];
    };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["map-overlay"] = render;

  /* The way in from Course Database's "Draw overlay" button. Seeds the course and routes; the
     page's own render loads the overlay. Takes any object carrying a courseId, lat/lng and a
     name. */
  window.GDStudioMapOverlay = {
    open: function (course) {
      if (course && courseIdOf(course) !== courseIdOf(session.course)) {
        session.features = [];
        session.osm = null;
        session.loadedFor = "";
        session.dirty = false;
      }
      session.course = course || null;
      session.view = null;
      if (window.GDStudioRouter && typeof window.GDStudioRouter.go === "function") {
        return window.GDStudioRouter.go("map-overlay");
      }
      return false;
    }
  };
})();
