/* Clarity Studio — Mapping Overlay. Studio-only.
 *
 * What it is for: placing the fairways, greens and tees that OSM does not have, so the mapper
 * can resolve a course whose OSM data is greens and nothing else. Royal Belfast is the case:
 * eleven greens in OSM, no fairways, no hole lines, and the resolver has nothing to build a
 * centre-line from.
 *
 * How it is used: by eye, not by tracing. A fairway is a line laid down its middle, which
 * becomes a fairway-width polygon with corners to drag into shape, plus a tee box just behind
 * the start of the line. A green is a pin, which the green wand (/api/course-map-wand) turns
 * into an outline. A tee is a click. Every shape can be dragged, reshaped by its corners, and
 * deleted by dropping it on the bin. Every change saves on its own. Shapes carry no hole
 * number - the mapper numbers holes from the scorecard.
 *
 * What it writes: one thing, the course's overlay row (course_map_overlays) through
 * /api/course-map-overlay. The mapper worker merges that overlay into the Overpass payload as
 * ordinary golf=fairway / golf=green / golf=tee ways (functions/lib/gd-map-overlay-core.mjs),
 * so nothing downstream knows the difference. It does NOT write objects, holes, a pin or a
 * package - the overlay changes nothing on the course until a mapper run is requested, which
 * the button at the bottom does through the same /api/course-mapper-jobs path Course Database
 * uses.
 *
 * Borrowed, not owned: the course list (the real picker, through gd-studio-course-pick.js),
 * the provider list (window.GDMapSources from gd-app-core.js), the shape builders
 * (window.GDOverlayShapes, map-overlay-shapes.js), and what OSM has here (asked of the server,
 * which runs the mapper's own query, so the greens drawn under your cursor are the greens the
 * resolver will link your fairway to). */
(function () {
  "use strict";

  var API = "/api/course-map-overlay";
  var AI_API = "/api/course-map-ai-scan";
  var WAND_API = "/api/course-map-wand";
  var JOBS_API = "/api/course-mapper-jobs";
  /* The model reads an image at ~1568px on its long side and answers in the pixels it saw,
     so the capture is scaled to that here and georeferenced AFTER scaling - the picture we
     describe is the picture it gets, to the pixel. */
  var AI_MAX_EDGE_PX = 1568;
  /* The API also rescales anything over ~1.15 megapixels, silently, and the model then answers
     in pixels of a picture we never saw. The first live scan was 1536x768 = 1.18MP. Stay under. */
  var AI_MAX_PIXELS = 1100000;
  var AI_MAX_TILES = 110;
  /* A labelled coordinate grid burned into the picture the model reads. A vision model asked
     for pixel coordinates estimates them; given gridlines with numbers on the margins it reads
     them, and the shapes land where the ground is. 128px is coarse enough to leave a 20-40px
     green legible under it. */
  var AI_GRID_PX = 128;
  var AI_POLL_MS = 4000;
  var AI_TIMEOUT_MS = 8 * 60 * 1000;
  /* The wand reads a green best at roughly 0.3m a pixel - a typical green ~45px across its
     radius, the scale its bubble sizes were tuned at. The picture is sized to hold the largest
     green the server will accept (gd-surface-refine-core WAND_GREEN_AREA_M2.max) with room. */
  var WAND_TARGET_MPP = 0.3;
  var WAND_MAX_GREEN_M2 = 2500;
  /* Autosave waits for a pause, so a burst of drags is one save. */
  var SAVE_DELAY_MS = 700;
  var SAVE_RETRY_MS = 6000;
  var MAX_POINTS = 64;
  var MAX_FEATURES = 80;

  /* Survives leaving and re-entering the page - the shell tears the DOM down on every route
     change. The save state lives here too, so a save still in flight when the page is left
     lands on the same state the next render reads. */
  var session = {
    course: null, features: [], loadedFor: "", osm: null, courseMap: null, view: null, sourceKey: "", showOsm: true,
    dirty: false, rev: 0, saving: false, saveError: "", fairwayWidth: 0
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : null; }
  function sourcesApi() { return window.GDMapSources || null; }
  function shapesApi() { return window.GDOverlayShapes || null; }
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
  function kindLabel(kind) { return kind === "hole" ? "Hole line" : kind === "green" ? "Green" : kind === "tee" ? "Tee" : "Fairway"; }
  function isPolygon(kind) { return kind === "fairway" || kind === "green" || kind === "tee"; }
  function minPoints(kind) { return isPolygon(kind) ? 3 : 2; }
  function toLatLngs(points) { return points.map(function (p) { return [p.lat, p.lng]; }); }
  /* A course map is a small schematic; 1200px on the long side is plenty for the model to
     read hole numbers off, and keeps the row it is stored on light. */
  var COURSE_MAP_MAX_EDGE_PX = 1200;

  var STYLE = {
    fairway: { color: "#3cff8d", weight: 2, fillColor: "#3cff8d", fillOpacity: 0.22 },
    fairwaySelected: { color: "#ffffff", weight: 3, fillColor: "#3cff8d", fillOpacity: 0.35 },
    hole: { color: "#3cff8d", weight: 3, dashArray: "8 6" },
    holeSelected: { color: "#ffffff", weight: 4, dashArray: "8 6" },
    green: { color: "#b7ff5c", weight: 2, fillColor: "#b7ff5c", fillOpacity: 0.4 },
    greenSelected: { color: "#ffffff", weight: 3, fillColor: "#b7ff5c", fillOpacity: 0.5 },
    tee: { color: "#6cc7ff", weight: 2, fillColor: "#6cc7ff", fillOpacity: 0.4 },
    teeSelected: { color: "#ffffff", weight: 3, fillColor: "#6cc7ff", fillOpacity: 0.5 },
    draft: { color: "#ffb54c", weight: 3, dashArray: "6 6", interactive: false },
    draftPreview: { color: "#ffb54c", weight: 1, fillColor: "#3cff8d", fillOpacity: 0.12, interactive: false },
    draftPoint: { radius: 4, color: "#ffb54c", weight: 2, fillColor: "#1a1a1a", fillOpacity: 1, interactive: false },
    vertex: { radius: 6, color: "#ffffff", weight: 2, fillColor: "#ffb54c", fillOpacity: 1, className: "gdStudioOverlayHandle" },
    midpoint: { radius: 4, color: "#ffffff", weight: 1, opacity: 0.8, fillColor: "#ffffff", fillOpacity: 0.35, className: "gdStudioOverlayHandle" },
    pin: { radius: 7, color: "#ffffff", weight: 2, fillColor: "#b7ff5c", fillOpacity: 1, interactive: false },
    osmGreen: { color: "#b7ff5c", weight: 2, fillColor: "#b7ff5c", fillOpacity: 0.28 },
    osmFairway: { color: "#8fa79c", weight: 1, dashArray: "3 5", fillOpacity: 0 },
    osmTee: { color: "#6cc7ff", weight: 2, fillColor: "#6cc7ff", fillOpacity: 0.3 },
    osmHole: { color: "#ffffff", weight: 1, dashArray: "2 6", opacity: 0.7 }
  };

  var BIN_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

  function render(containerEl) {
    var mapObj = null;
    var layer = null;
    var destroyed = false;
    var tool = "move";
    var draft = [];
    var draftLayers = [];
    var cursorLatLng = null;
    var featureLayers = {};
    var osmLayers = [];
    var selectedId = "";
    var busy = false;
    var scanning = false;
    var scanFrame = null;
    var scanTimer = null;
    var saveTimer = null;
    var drag = null;
    var dragEndedAt = 0;
    var wandsRunning = 0;

    containerEl.innerHTML =
      '<div class="gdStudioLede" style="margin-bottom:12px">' +
      "<p>Place what OSM is missing, by eye. Pick a course, then: <strong>Fairway</strong> - click along the middle of the fairway " +
      "and double-click to finish; you get a fairway with corners to drag into shape, and a tee 20m behind the start. " +
      "<strong>Green</strong> - click the middle of a green and the wand draws its outline. <strong>Tee</strong> - click to drop one. " +
      "Drag any shape to move it, drag its corners to reshape it (the faint dots between corners add a new one), and drop a shape " +
      "or a corner on the <strong>bin</strong> to delete it. Everything saves as you go. When the course looks right, run the mapper. " +
      "The bright green outlines are the greens OSM already has - there is no need to place those again.</p></div>" +
      '<div class="gdStudioViewportBar">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="pick">Pick course</button>' +
      '<span class="gdStudioViewportCourse" data-gd-overlay="course">No course picked</span>' +
      '<label class="gdStudioViewportField">Provider <select data-gd-overlay="provider"></select></label>' +
      '<label class="gdStudioViewportField"><input type="checkbox" data-gd-overlay="osm" checked> Show OSM greens</label>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="ai" disabled>Scan this view with AI</button>' +
      '<label class="gdStudioViewportField"><input type="checkbox" data-gd-overlay="ai-replace"> replace saved shapes</label>' +
      '<label class="gdStudioViewportField gdStudioDiagramBtn">Course map… <input type="file" accept="image/*" data-gd-overlay="course-map" hidden></label>' +
      '<span class="gdStudioViewportField" data-gd-overlay="course-map-state"></span>' +
      "</div>" +
      '<div class="gdStudioViewportBar">' +
      '<span class="gdStudioViewportField">Place</span>' +
      '<button type="button" class="gdStudioDiagramBtn isActive" data-gd-overlay="tool-move" title="Select, move and reshape (V)">Move</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="tool-fairway" title="Lay a line down the fairway (F)">Fairway line</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="tool-green" title="Pin a green (G)">Green pin</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="tool-tee" title="Drop a tee (T)">Tee</button>' +
      '<label class="gdStudioViewportField">Fairway width <input type="number" min="10" max="90" step="1" data-gd-overlay="width" class="gdStudioOverlayWidth"> m</label>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="finish" hidden>Finish fairway</button>' +
      "</div>" +
      '<div class="gdStudioOverlayStage isTool-move" data-gd-overlay="stage">' +
      '<div class="gdStudioViewportMap gdStudioOverlayMap" data-gd-overlay="map"></div>' +
      '<div class="gdStudioOverlayHint" data-gd-overlay="hint"></div>' +
      '<button type="button" class="gdStudioOverlayBin" data-gd-overlay="bin" title="Drag a shape or corner here to delete it, or click to delete the selected shape">' +
      BIN_ICON + "<span>Bin</span></button>" +
      "</div>" +
      '<div class="gdStudioViewportReadout" data-gd-overlay="readout"></div>' +
      '<div class="gdStudioViewportCredit" data-gd-overlay="credit"></div>' +
      '<div class="gdStudioViewportBar" style="margin-top:12px">' +
      '<span class="gdStudioViewportField" data-gd-overlay="saved"></span>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="clear" disabled>Delete all shapes</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="run" disabled>Run mapper with overlay</button>' +
      '<span class="gdStudioViewportScan" data-gd-overlay="status"></span>' +
      "</div>";

    var el = {};
    ["pick", "course", "provider", "osm", "ai", "ai-replace", "course-map", "course-map-state", "tool-move", "tool-fairway", "tool-green", "tool-tee", "width", "finish", "stage", "map", "hint", "bin", "readout", "credit", "saved", "clear", "run", "status"].forEach(function (name) {
      el[name] = containerEl.querySelector('[data-gd-overlay="' + name + '"]');
    });

    if (typeof window.L === "undefined" || !sourcesApi() || !shapesApi()) {
      el.map.innerHTML = '<p class="gdStudioMuted" style="padding:16px">Leaflet, the map source list or the overlay shape builders did not load on this surface.</p>';
      return null;
    }
    var shapes = shapesApi();
    if (!session.fairwayWidth) session.fairwayWidth = shapes.FAIRWAY_WIDTH_M;
    el.width.value = session.fairwayWidth;

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
    /* Imagery first: shapes are placed by eye off the ground, and the OSM line guide has no
       ground to look at. First covering source in list order is the app's own preference, which
       puts regional aerial before the global fallback; the line guide is what is left when
       nothing aerial covers the view. */
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

    /* ---- tools ---- */

    /* Shapes can only change once the course's saved overlay is on screen and no AI scan is
       about to replace it - an edit made under a scan would be overwritten by its result. */
    function canEdit() {
      return !!session.course && session.loadedFor === courseIdOf(session.course) && !scanning && !busy;
    }

    function setTool(next) {
      tool = next === "fairway" || next === "green" || next === "tee" ? next : "move";
      ["move", "fairway", "green", "tee"].forEach(function (name) {
        el["tool-" + name].classList.toggle("isActive", tool === name);
        el.stage.classList.toggle("isTool-" + name, tool === name);
      });
      if (draft.length && tool !== "fairway") cancelDraft();
      if (tool !== "move" && selectedId) select("");
      updateHint();
    }

    function allGreens() {
      var list = [];
      if (session.osm && !session.osm.error) (session.osm.greens || []).forEach(function (g) { if (g.points && g.points.length >= 3) list.push(g.points); });
      session.features.forEach(function (f) { if (f.kind === "green") list.push(f.points); });
      return list;
    }

    function nearestGreen(latlng, withinM) {
      var best = null, bestD = withinM;
      allGreens().forEach(function (ring) {
        var c = shapes.centroid(ring);
        var d = shapes.distanceM({ lat: latlng.lat, lng: latlng.lng }, c);
        if (d < bestD) { bestD = d; best = c; }
      });
      return best;
    }

    function handleMapClick(latlng) {
      if (Date.now() - dragEndedAt < 300) return;
      if (!session.course) { setStatus("Pick a course first."); return; }
      if (tool === "move") { if (selectedId) select(""); return; }
      if (!canEdit()) { setStatus(scanning ? "Wait for the AI scan to finish." : "Still loading this course's overlay…"); return; }
      if (session.features.length >= MAX_FEATURES) { setStatus("That is the most shapes one course can hold (" + MAX_FEATURES + "). Bin some first.", true); return; }
      var point = { lat: latlng.lat, lng: latlng.lng };
      if (tool === "fairway") addDraftPoint(point);
      else if (tool === "green") { placeGreen(point); setTool("move"); }
      else if (tool === "tee") {
        var towards = nearestGreen(point, 600);
        setTool("move");
        addFeature({ kind: "tee", points: shapes.teeAt(point, towards) });
      }
    }

    /* ---- fairway line ---- */

    function clearDraftLayers() {
      draftLayers.forEach(function (l) { try { mapObj.removeLayer(l); } catch (e) {} });
      draftLayers = [];
    }

    /* The line so far, the rubber band to the cursor, and the fairway it would make - so the
       width is visible before the line is finished. */
    function drawDraft() {
      clearDraftLayers();
      if (!draft.length) return;
      var line = cursorLatLng ? draft.concat([cursorLatLng]) : draft;
      if (line.length >= 2) {
        var preview = shapes.fairwayFromLine(line, session.fairwayWidth);
        if (preview) draftLayers.push(L.polygon(toLatLngs(preview), STYLE.draftPreview).addTo(mapObj));
        draftLayers.push(L.polyline(toLatLngs(line), STYLE.draft).addTo(mapObj));
      }
      draft.forEach(function (p) { draftLayers.push(L.circleMarker([p.lat, p.lng], STYLE.draftPoint).addTo(mapObj)); });
    }

    function addDraftPoint(point) {
      var last = draft[draft.length - 1];
      /* A double-click delivers two clicks first; the second lands on the first's point and
         would leave a zero-length segment behind the finish. */
      if (last && Math.abs(last.lat - point.lat) < 1e-7 && Math.abs(last.lng - point.lng) < 1e-7) return;
      draft.push(point);
      drawDraft();
      updateDraftUi();
    }

    function undoDraftPoint() {
      draft.pop();
      drawDraft();
      updateDraftUi();
    }

    function cancelDraft() {
      draft = [];
      cursorLatLng = null;
      clearDraftLayers();
      updateDraftUi();
    }

    function updateDraftUi() {
      el.finish.hidden = !draft.length;
      el.finish.disabled = draft.length < 2;
      updateActions();
      updateHint();
    }

    function finishFairway() {
      if (draft.length < 2) return;
      var line = draft.slice();
      var ring = shapes.fairwayFromLine(line, session.fairwayWidth);
      cancelDraft();
      if (!ring) { setStatus("That line is too short to be a fairway.", true); return; }
      var fairway = addFeature({ kind: "fairway", points: ring }, true);
      if (session.features.length < MAX_FEATURES) {
        var tee = shapes.teeBeyondLine(line, allGreens());
        if (tee) addFeature({ kind: "tee", points: tee }, true);
      }
      setTool("move");
      select(fairway.id);
      changed();
      setStatus("Fairway placed with a tee behind it. Drag the corners to fit, or drag the tee where it belongs.");
    }

    /* ---- green pin ---- */

    function placeGreen(point) {
      var id = session.loadedFor;
      var pin = L.circleMarker([point.lat, point.lng], STYLE.pin).addTo(mapObj);
      pin.bindTooltip("Finding the green's edge…", { permanent: true, direction: "top", className: "gdStudioOverlayLabel" });
      wandsRunning++;
      updateHint();
      captureAround(point).then(function (capture) {
        return api("POST", "", { image: { data: capture.data, mediaType: capture.mediaType }, georef: capture.georef, seed: point }, WAND_API);
      }).then(function (data) {
        return data && data.ok && Array.isArray(data.shape) && data.shape.length >= 3
          ? { shape: data.shape, note: data.stable === false ? "The wand was unsure of this edge - check it." : "" }
          : { shape: null, note: "The wand could not find an edge here (" + ((data && data.reason) || "no answer") + ")." };
      }, function (error) {
        return { shape: null, note: "The wand could not run: " + (error && error.message || error) + "." };
      }).then(function (result) {
        try { mapObj && mapObj.removeLayer(pin); } catch (e) {}
        wandsRunning--;
        if (destroyed) return;
        updateHint();
        if (session.loadedFor !== id) return;
        if (session.features.length >= MAX_FEATURES) { setStatus("That is the most shapes one course can hold.", true); return; }
        var f = addFeature({ kind: "green", points: result.shape || shapes.circle(point, shapes.GREEN_RADIUS_M), source: result.shape ? "wand" : "" });
        if (tool === "move" && !drag) select(f.id);
        setStatus(result.shape ? "Green placed. " + result.note + " Drag its corners to fit." : result.note + " Placed a round green - drag its corners to fit.", !result.shape);
      });
    }

    /* ---- shapes ---- */

    function findFeature(id) { return session.features.filter(function (f) { return f.id === id; })[0] || null; }

    function addFeature(raw, quiet) {
      var f = { id: nextFeatureId(session.features), kind: raw.kind, hole: null, points: raw.points.slice(0, MAX_POINTS) };
      if (raw.source) f.source = raw.source;
      session.features.push(f);
      if (!quiet) { selectedId = tool === "move" ? f.id : selectedId; drawFeatures(); changed(); }
      return f;
    }

    function removeFeature(id) {
      session.features = session.features.filter(function (f) { return f.id !== id; });
      if (selectedId === id) selectedId = "";
      drawFeatures();
      changed();
    }

    function removeVertex(f, index) {
      if (f.points.length <= minPoints(f.kind)) { setStatus("A " + kindLabel(f.kind).toLowerCase() + " needs at least " + minPoints(f.kind) + " corners - bin the whole shape instead.", true); return false; }
      f.points.splice(index, 1);
      drawFeatures();
      changed();
      return true;
    }

    function clearFeatureLayers() {
      Object.keys(featureLayers).forEach(function (id) {
        var entry = featureLayers[id];
        [entry.shape].concat(entry.vertices, entry.mids).forEach(function (l) { try { mapObj.removeLayer(l); } catch (e) {} });
      });
      featureLayers = {};
    }

    function midpoints(f) {
      var out = [];
      var n = f.points.length;
      var last = isPolygon(f.kind) ? n : n - 1;
      for (var i = 0; i < last; i++) {
        var a = f.points[i], b = f.points[(i + 1) % n];
        out.push({ after: i, lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 });
      }
      return out;
    }

    function drawFeatures() {
      clearFeatureLayers();
      session.features.forEach(function (f) {
        var selected = f.id === selectedId;
        var style = Object.assign({ className: "gdStudioOverlayShape" }, STYLE[f.kind + (selected ? "Selected" : "")] || STYLE.fairway);
        var latlngs = toLatLngs(f.points);
        var shape = isPolygon(f.kind) ? L.polygon(latlngs, style) : L.polyline(latlngs, style);
        shape.addTo(mapObj);
        shape.on("click", function (e) {
          /* Selecting a shape must not also count as a click on the map under it. */
          if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent);
          if (tool !== "move") { handleMapClick(e.latlng); return; }
          if (Date.now() - dragEndedAt < 300) return;
          select(f.id);
        });
        shape.on("mousedown", function (e) {
          if (tool !== "move" || !canEdit()) return;
          if (selectedId !== f.id) select(f.id);
          beginDrag(f.id, "body", -1, e);
        });
        if (f.hole) shape.bindTooltip(String(f.hole), { permanent: true, direction: "center", className: "gdStudioOverlayLabel" });
        var entry = { shape: shape, vertices: [], mids: [] };
        if (selected && canEdit() && bigEnoughForHandles(f)) {
          f.points.forEach(function (p, i) {
            var v = L.circleMarker([p.lat, p.lng], STYLE.vertex).addTo(mapObj);
            v.on("mousedown", function (e) { beginDrag(f.id, "vertex", i, e); });
            v.on("click", function (e) { if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent); });
            v.on("contextmenu", function (e) {
              if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent);
              removeVertex(f, i);
            });
            entry.vertices.push(v);
          });
          if (f.points.length < MAX_POINTS) {
            midpoints(f).forEach(function (m) {
              var h = L.circleMarker([m.lat, m.lng], STYLE.midpoint).addTo(mapObj);
              h.on("mousedown", function (e) {
                if (tool !== "move" || !canEdit()) return;
                f.points.splice(m.after + 1, 0, { lat: m.lat, lng: m.lng });
                drawFeatures();
                beginDrag(f.id, "vertex", m.after + 1, e, true);
              });
              h.on("click", function (e) { if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent); });
              entry.mids.push(h);
            });
          }
        }
        featureLayers[f.id] = entry;
      });
      updateBin();
      updateReadout();
    }

    /* Corner handles on a shape only a few pixels across would cover it entirely and make it
       impossible to grab by its body; zoomed out, a small shape is moved whole, and zooming in
       brings its corners back. */
    function bigEnoughForHandles(f) {
      try {
        var b = L.latLngBounds(toLatLngs(f.points));
        var a = mapObj.latLngToLayerPoint(b.getNorthWest()), c = mapObj.latLngToLayerPoint(b.getSouthEast());
        return Math.max(Math.abs(c.x - a.x), Math.abs(c.y - a.y)) >= 36;
      } catch (e) { return true; }
    }

    /* Mid-drag, only the dragged shape moves: its outline and handles follow the points
       without rebuilding every layer on the map. */
    function refreshFeature(f) {
      var entry = featureLayers[f.id];
      if (!entry) return;
      entry.shape.setLatLngs(toLatLngs(f.points));
      entry.vertices.forEach(function (v, i) { if (f.points[i]) v.setLatLng([f.points[i].lat, f.points[i].lng]); });
      midpoints(f).forEach(function (m, i) { if (entry.mids[i]) entry.mids[i].setLatLng([m.lat, m.lng]); });
    }

    function select(id) {
      selectedId = id || "";
      drawFeatures();
      updateHint();
    }

    /* ---- dragging and the bin ---- */

    function overBin(event) {
      var r = el.bin.getBoundingClientRect();
      var pad = 10;
      return event.clientX >= r.left - pad && event.clientX <= r.right + pad && event.clientY >= r.top - pad && event.clientY <= r.bottom + pad;
    }

    function beginDrag(id, mode, index, e, inserted) {
      var f = findFeature(id);
      if (!f || tool !== "move" || !canEdit() || !e || !e.originalEvent) return;
      L.DomEvent.stop(e.originalEvent);
      mapObj.dragging.disable();
      drag = {
        id: id, mode: mode, index: index, inserted: !!inserted, moved: false,
        start: e.latlng, x: e.originalEvent.clientX, y: e.originalEvent.clientY,
        orig: f.points.map(function (p) { return { lat: p.lat, lng: p.lng }; })
      };
      document.addEventListener("mousemove", onDragMove);
      document.addEventListener("mouseup", onDragEnd);
    }

    function onDragMove(event) {
      if (!drag || destroyed) return;
      if (!drag.moved) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3) return;
        drag.moved = true;
        el.bin.classList.add("isArmed");
      }
      var f = findFeature(drag.id);
      if (!f) return;
      var ll = mapObj.mouseEventToLatLng(event);
      if (drag.mode === "body") {
        var dLat = ll.lat - drag.start.lat, dLng = ll.lng - drag.start.lng;
        f.points = drag.orig.map(function (p) { return { lat: p.lat + dLat, lng: p.lng + dLng }; });
      } else {
        f.points[drag.index] = { lat: ll.lat, lng: ll.lng };
      }
      refreshFeature(f);
      el.bin.classList.toggle("isHot", overBin(event));
    }

    function onDragEnd(event) {
      document.removeEventListener("mousemove", onDragMove);
      document.removeEventListener("mouseup", onDragEnd);
      var d = drag;
      drag = null;
      if (destroyed) return;
      try { mapObj.dragging.enable(); } catch (e) {}
      el.bin.classList.remove("isArmed", "isHot");
      if (!d) return;
      var f = findFeature(d.id);
      /* Also on a plain click: the mousedown may have re-drawn the shape under the pointer, and
         the click that follows would land on the map and undo the selection it just made. */
      dragEndedAt = Date.now();
      if (!d.moved) {
        if (d.inserted) changed();
        return;
      }
      if (!f) return;
      if (overBin(event)) {
        if (d.mode === "body") { removeFeature(f.id); setStatus(kindLabel(f.kind) + " deleted."); return; }
        f.points = d.orig;
        if (d.inserted) { f.points.splice(d.index, 1); drawFeatures(); return; }
        if (removeVertex(f, d.index)) setStatus("Corner deleted.");
        else drawFeatures();
        return;
      }
      drawFeatures();
      changed();
    }

    function updateBin() {
      el.bin.classList.toggle("hasSelection", !!selectedId);
      el.bin.hidden = !session.course;
    }

    /* ---- autosave ---- */

    function changed() {
      session.dirty = true;
      session.rev++;
      scheduleSave(SAVE_DELAY_MS);
      updateActions();
      updateReadout();
    }

    function scheduleSave(delay) {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { saveTimer = null; saveOverlay(); }, delay);
    }

    function renderSaveState() {
      if (destroyed) return;
      var text = !session.course ? ""
        : session.saving ? "Saving…"
        : session.saveError ? "Not saved - " + session.saveError + " (retrying)"
        : session.dirty ? "Unsaved changes…"
        : session.loadedFor ? "All changes saved" : "";
      el.saved.innerHTML = session.saveError ? '<span class="gdStudioWarnText">' + esc(text) + "</span>" : esc(text);
    }

    /* Saves what is on screen. If anything changed while the save was in flight, the local
       shapes win and another save follows; only a save of the current revision adopts the
       server's normalised copy. Finishes even if the page is left mid-save. */
    function saveOverlay() {
      var id = session.loadedFor;
      if (!id || !session.dirty) { renderSaveState(); return Promise.resolve(); }
      if (session.saving) { session.saveAgain = true; return session.savePromise; }
      var sentRev = session.rev;
      session.saving = true;
      renderSaveState();
      session.savePromise = api("POST", "", { courseId: id, features: session.features }).then(function (data) {
        session.saveError = "";
        if (session.loadedFor !== id) return;
        if (session.rev === sentRev) {
          session.dirty = false;
          if (!drag) session.features = (data && data.overlay && data.overlay.features) || [];
          if (!destroyed && !drag) { if (selectedId && !findFeature(selectedId)) selectedId = ""; drawFeatures(); }
        }
        if (!destroyed && data && data.dropped) setStatus(data.dropped + " shape" + (data.dropped === 1 ? " was" : "s were") + " too small to keep and dropped.", true);
      }).catch(function (error) {
        session.saveError = String(error && error.message || error);
        if (!destroyed) scheduleSave(SAVE_RETRY_MS);
      }).then(function () {
        session.saving = false;
        var again = session.saveAgain || (session.dirty && session.rev !== sentRev);
        session.saveAgain = false;
        if (!destroyed) { renderSaveState(); updateActions(); }
        /* The promise settles once the follow-up save has too, so a caller waiting on it (the
           AI scan, leaving the page) sees the last change saved, not the one before it. */
        if (again && session.loadedFor === id) return saveOverlay();
      });
      return session.savePromise;
    }

    function flushSave() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      return session.dirty ? saveOverlay() : Promise.resolve();
    }

    function deleteOverlay() {
      if (!canEdit()) return;
      if (!window.confirm("Delete every overlay shape for this course? The mapper will go back to reading OSM alone.")) return;
      session.features = [];
      selectedId = "";
      cancelDraft();
      drawFeatures();
      changed();
      flushSave();
    }

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
      /* OSM sits under the overlay, so a placed shape is never hidden behind what OSM has. */
      osmLayers.forEach(function (l) { try { l.bringToBack(); } catch (e) {} });
    }

    /* ---- readouts ---- */

    function setStatus(text, warn) {
      el.status.innerHTML = warn ? '<span class="gdStudioWarnText">' + esc(text) + "</span>" : esc(text);
    }

    function updateHint() {
      if (destroyed) return;
      var text = "";
      if (!session.course) text = "Pick a course to start";
      else if (scanning) text = "AI scan running - shapes are locked until it finishes";
      else if (tool === "fairway") text = draft.length ? (draft.length >= 2 ? "Keep clicking along the fairway · double-click or Enter to finish · Backspace undoes · Esc cancels" : "Click the next point along the fairway") : "Click at the tee end of the fairway, then along its middle";
      else if (tool === "green") text = "Click the middle of a green";
      else if (tool === "tee") text = "Click where the tee is";
      else if (selectedId && !bigEnoughForHandles(findFeature(selectedId) || { points: [] })) text = "Drag to move · zoom in to reshape its corners · Delete or the bin removes it";
      else if (selectedId) text = "Drag to move · drag corners to reshape · faint dots add a corner · right-click a corner to remove it · Delete or the bin removes the shape";
      else text = "Choose Fairway line, Green pin or Tee to place · click a shape to adjust it";
      if (wandsRunning) text = "Finding the green's edge… · " + text;
      el.hint.textContent = text;
    }

    function updateReadout() {
      if (destroyed || !mapObj) return;
      var bits = [];
      var here = centre();
      if (here) bits.push("centre " + here.lat.toFixed(6) + ", " + here.lng.toFixed(6));
      bits.push("z" + mapObj.getZoom());
      if (session.course) {
        var count = function (kind) { return session.features.filter(function (f) { return f.kind === kind; }).length; };
        var holes = count("hole");
        bits.push("placed: " + count("fairway") + " fairways, " + count("green") + " greens, " + count("tee") + " tees" + (holes ? ", " + holes + " hole lines" : ""));
      }
      var osm = session.osm;
      if (osm && !osm.error) bits.push("OSM here: " + (osm.greens || []).length + " greens, " + (osm.fairways || []).length + " fairways, " + (osm.holes || []).length + " hole lines");
      else if (osm && osm.error) bits.push("OSM: " + osm.error);
      el.readout.textContent = bits.join(" · ");
      session.view = here ? { lat: here.lat, lng: here.lng, zoom: mapObj.getZoom() } : session.view;
    }

    function updateActions() {
      var has = !!session.course && !busy;
      el.ai.disabled = !has || scanning || !!draft.length;
      el.ai.title = draft.length ? "Finish or cancel the fairway you are placing first" : scanning ? "A scan is running" : "";
      el.clear.disabled = !canEdit() || !session.features.length;
      el.run.disabled = !has || session.dirty;
      el.run.title = session.dirty ? "Wait for the overlay to save - the mapper reads what is saved" : "";
      ["tool-fairway", "tool-green", "tool-tee"].forEach(function (name) { el[name].disabled = !canEdit(); });
      renderSaveState();
    }

    /* ---- course map: the club's schematic, stored on the course and sent to the AI as image 2 ---- */

    function renderCourseMapState() {
      var m = session.courseMap;
      el["course-map-state"].innerHTML = m
        ? esc((m.name || "course map") + " · " + (m.width || "?") + "×" + (m.height || "?") + " · sent to the AI as image 2 ") +
          '<button type="button" class="gdStudioDiagramBtn" data-gd-overlay="course-map-clear">remove</button>'
        : "no course map";
      var clear = el["course-map-state"].querySelector('[data-gd-overlay="course-map-clear"]');
      if (clear) clear.addEventListener("click", function () {
        if (!window.confirm("Remove the course map from this course?")) return;
        saveCourseMap(null);
      });
    }

    function uploadCourseMap(file) {
      if (!session.course) { setStatus("Pick a course first.", true); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var scale = Math.min(1, COURSE_MAP_MAX_EDGE_PX / Math.max(img.width, img.height));
          var c = document.createElement("canvas");
          c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          var dataUrl = c.toDataURL("image/jpeg", 0.85);
          saveCourseMap({ data: dataUrl.replace(/^data:[^,]+,/, ""), mediaType: "image/jpeg", name: String(file.name || "").slice(0, 80), width: c.width, height: c.height });
        };
        img.onerror = function () { setStatus("That file is not an image the browser can read.", true); };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    }

    function saveCourseMap(courseMap) {
      var id = courseIdOf(session.course);
      if (!id) return;
      setStatus(courseMap ? "Saving course map…" : "Removing course map…");
      api("POST", "", { courseId: id, courseMap: courseMap }).then(function (data) {
        if (destroyed) return;
        session.courseMap = (data && data.courseMap) || null;
        renderCourseMapState();
        setStatus(session.courseMap ? "Course map saved - the next AI scan will see it." : "Course map removed.");
      }).catch(function (error) {
        if (destroyed) return;
        setStatus("Course map not saved: " + (error && error.message || error), true);
      });
    }

    /* ---- server ---- */

    function api(method, query, body, endpoint) {
      return accessToken().then(function (token) {
        if (!token) throw new Error("Sign in again - no session token");
        return fetch((endpoint || API) + (query || ""), {
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
        session.courseMap = (data && data.courseMap) || null;
        renderCourseMapState();
        session.loadedFor = id;
        session.dirty = false;
        session.saveError = "";
        selectedId = "";
        busy = false;
        drawOsm();
        drawFeatures();
        /* A scan started before the page was left (or from another tab) is picked back up. */
        var scan = data && data.aiScan;
        if (scan && (scan.status === "queued" || scan.status === "running") && !scanning) {
          var since = Date.parse(scan.requestedAt || "") || Date.now();
          if (Date.now() - since < AI_TIMEOUT_MS) { scanning = true; pollScan(id, since); }
        }
        var when = data && data.overlay && data.overlay.updatedAt ? " · saved " + new Date(data.overlay.updatedAt).toLocaleString() : "";
        setStatus(session.features.length ? session.features.length + " saved shape" + (session.features.length === 1 ? "" : "s") + when : "Nothing placed on this course yet.");
      }).catch(function (error) {
        if (destroyed) return;
        setStatus("Could not load: " + (error && error.message || error), true);
      }).then(function () {
        busy = false;
        if (!destroyed) { updateActions(); updateReadout(); updateHint(); updateBin(); }
      });
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
      }).then(function () { busy = false; if (!destroyed) { updateActions(); drawFeatures(); } });
    }

    /* ---- imagery capture ----
       Pictures are built from the mounted provider's own tiles, re-fetched with CORS so a
       canvas can read them (every source in GDMapSources sets crossOrigin for this reason).
       Tiles at one zoom, nothing resampled; the tile grid's top-left mercator pixel and that
       zoom ARE the georeference - the same playSurface shape a published frame carries, exact
       to the pixel. */
    function stitchTiles(z, x0, y0, x1, y1) {
      var full = document.createElement("canvas");
      full.width = (x1 - x0 + 1) * 256; full.height = (y1 - y0 + 1) * 256;
      var ctx = full.getContext("2d");
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, full.width, full.height);
      var loads = [];
      var failed = 0;
      for (var ty = y0; ty <= y1; ty++) {
        for (var tx = x0; tx <= x1; tx++) {
          loads.push(new Promise(function (done) {
            var img = new Image();
            var cx = tx, cy = ty;
            img.crossOrigin = "anonymous";
            img.onload = function () { try { ctx.drawImage(img, (cx - x0) * 256, (cy - y0) * 256, 256, 256); } catch (e) { failed++; } done(); };
            img.onerror = function () { failed++; done(); };
            try { img.src = layer.getTileUrl({ x: cx, y: cy, z: z }); } catch (e) { failed++; done(); }
          }));
        }
      }
      return Promise.all(loads).then(function () { return { canvas: full, tiles: loads.length, failed: failed }; });
    }

    /* The picture the wand reads: a few tiles around a pin at the zoom nearest WAND_TARGET_MPP
       the provider really has, unscaled. */
    function captureAround(point) {
      return new Promise(function (resolve, reject) {
        if (!mapObj || !layer || typeof layer.getTileUrl !== "function") return reject(new Error("this provider cannot be captured - switch provider"));
        var native = num(layer.options && layer.options.maxNativeZoom) || num(layer.options && layer.options.maxZoom) || 19;
        var mppZ0 = 156543.03392 * Math.cos(point.lat * Math.PI / 180);
        var z = Math.max(14, Math.min(native, Math.round(Math.log2(mppZ0 / WAND_TARGET_MPP))));
        var mpp = mppZ0 / Math.pow(2, z);
        var half = Math.ceil(Math.sqrt(WAND_MAX_GREEN_M2 / Math.PI) / mpp * 1.6 + 24);
        var p = mapObj.project(L.latLng(point.lat, point.lng), z);
        var x0 = Math.floor((p.x - half) / 256), y0 = Math.floor((p.y - half) / 256);
        var x1 = Math.floor((p.x + half) / 256), y1 = Math.floor((p.y + half) / 256);
        stitchTiles(z, x0, y0, x1, y1).then(function (out) {
          if (out.failed === out.tiles) return reject(new Error("no imagery loaded here"));
          var dataUrl;
          try { dataUrl = out.canvas.toDataURL("image/jpeg", 0.92); }
          catch (e) { return reject(new Error("this provider's tiles cannot be read back (no CORS) - switch provider")); }
          resolve({
            data: dataUrl.replace(/^data:[^,]+,/, ""),
            mediaType: "image/jpeg",
            georef: { playSurface: { originPx: { x: x0 * 256, y: y0 * 256 }, captureZoom: z, outputDimensions: { width: out.canvas.width, height: out.canvas.height } } }
          });
        });
      });
    }

    /* ---- AI scan: the current view, as the model will see it ----
       Tiles at the layer's effective zoom, then one downscale to the model's edge limit,
       folded into the zoom as a fraction, so the georef still describes the picture that is
       actually sent. */
    function captureView() {
      return new Promise(function (resolve, reject) {
        if (!mapObj || !layer || typeof layer.getTileUrl !== "function") return reject(new Error("no tile layer to capture"));
        var native = num(layer.options && layer.options.maxNativeZoom);
        var z = num(layer._tileZoom);
        if (z == null) z = Math.round(mapObj.getZoom());
        if (native && z > native) z = native;
        var bounds = mapObj.getBounds();
        var nw = mapObj.project(bounds.getNorthWest(), z), se = mapObj.project(bounds.getSouthEast(), z);
        var x0 = Math.floor(nw.x / 256), y0 = Math.floor(nw.y / 256);
        var x1 = Math.floor((se.x - 1) / 256), y1 = Math.floor((se.y - 1) / 256);
        var cols = x1 - x0 + 1, rows = y1 - y0 + 1;
        if (cols < 1 || rows < 1) return reject(new Error("nothing in view"));
        if (cols * rows > AI_MAX_TILES) return reject(new Error("too much ground in view (" + cols * rows + " tiles) - zoom in"));
        stitchTiles(z, x0, y0, x1, y1).then(function (stitched) {
          var full = stitched.canvas;
          if (stitched.failed === stitched.tiles) return reject(new Error("no tiles loaded for this view"));
          var scale = Math.min(1, AI_MAX_EDGE_PX / Math.max(full.width, full.height), Math.sqrt(AI_MAX_PIXELS / (full.width * full.height)));
          var out = full;
          if (scale < 1) {
            out = document.createElement("canvas");
            out.width = Math.round(full.width * scale); out.height = Math.round(full.height * scale);
            out.getContext("2d").drawImage(full, 0, 0, out.width, out.height);
            scale = out.width / full.width;
          }
          /* Pixel position in the SENT picture of a ground point: tile-grid origin, then scale. */
          function toPx(latlng) {
            var p = mapObj.project(latlng, z);
            return { x: (p.x - x0 * 256) * scale, y: (p.y - y0 * 256) * scale };
          }
          var anchors = drawAnchors(out, toPx);
          drawGrid(out, AI_GRID_PX);
          var dataUrl;
          try { dataUrl = out.toDataURL("image/jpeg", 0.88); }
          catch (e) { return reject(new Error("this provider's tiles cannot be read back (no CORS) - switch provider")); }
          resolve({
            data: dataUrl.replace(/^data:[^,]+,/, ""),
            mediaType: "image/jpeg",
            width: out.width, height: out.height, tiles: stitched.tiles, failed: stitched.failed,
            anchors: anchors, grid: AI_GRID_PX,
            bounds: L.latLngBounds(mapObj.unproject(L.point(x0 * 256, y0 * 256), z), mapObj.unproject(L.point((x1 + 1) * 256, (y1 + 1) * 256), z)),
            georef: {
              playSurface: {
                originPx: { x: x0 * 256 * scale, y: y0 * 256 * scale },
                captureZoom: z + Math.log2(scale),
                outputDimensions: { width: out.width, height: out.height }
              }
            }
          });
        });
      });
    }

    /* What the model is shown that is not ground: the greens OSM already has (bright outline)
       and the shapes already saved (white outline), so it traces fairways TO known greens and
       adds only the greens nobody has yet. Returns the anchors as pixel centres for the prompt.
       Only shapes inside the picture are drawn or listed. */
    function drawAnchors(canvas, toPx) {
      var ctx = canvas.getContext("2d");
      var anchors = [];
      function outline(points, style, label) {
        var px = points.map(toPx);
        if (px.length < 2) return null;
        var inside = px.some(function (p) { return p.x >= 0 && p.y >= 0 && p.x <= canvas.width && p.y <= canvas.height; });
        if (!inside) return null;
        ctx.save();
        ctx.strokeStyle = style; ctx.lineWidth = 3; ctx.setLineDash([]);
        ctx.beginPath();
        px.forEach(function (p, i) { if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
        ctx.closePath(); ctx.stroke();
        var cx = Math.round(px.reduce(function (a, p) { return a + p.x; }, 0) / px.length);
        var cy = Math.round(px.reduce(function (a, p) { return a + p.y; }, 0) / px.length);
        if (label) {
          ctx.font = "bold 14px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillStyle = "rgba(0,0,0,0.65)"; ctx.fillRect(cx - 12, cy - 9, 24, 18);
          ctx.fillStyle = style; ctx.fillText(label, cx, cy);
        }
        ctx.restore();
        return { x: cx, y: cy };
      }
      var osm = session.osm && !session.osm.error ? session.osm : null;
      ((osm && osm.greens) || []).forEach(function (g, i) {
        var c = outline(g.points.map(function (p) { return L.latLng(p.lat, p.lng); }), "#39ff14", "G" + (i + 1));
        if (c) anchors.push({ kind: "green", label: "G" + (i + 1), x: c.x, y: c.y, ref: g.ref || "" });
      });
      session.features.forEach(function (f) {
        var c = outline(f.points.map(function (p) { return L.latLng(p.lat, p.lng); }), "#ffffff", "");
        if (c) anchors.push({ kind: f.kind, label: "saved", x: c.x, y: c.y, saved: true });
      });
      return anchors;
    }

    function drawGrid(canvas, step) {
      var ctx = canvas.getContext("2d");
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1;
      ctx.font = "bold 13px monospace"; ctx.textBaseline = "top";
      for (var x = 0; x < canvas.width; x += step) {
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, canvas.height); ctx.stroke();
        ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(x + 2, 1, 42, 15);
        ctx.fillStyle = "#ffe14d"; ctx.textAlign = "left"; ctx.fillText(String(x), x + 4, 2);
      }
      for (var y = 0; y < canvas.height; y += step) {
        ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(canvas.width, y + 0.5); ctx.stroke();
        ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(1, y + 2, 42, 15);
        ctx.fillStyle = "#ffe14d"; ctx.textAlign = "left"; ctx.fillText(String(y), 3, y + 3);
      }
      ctx.restore();
    }

    function stopScanPoll() {
      if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
      if (scanFrame) { try { mapObj.removeLayer(scanFrame); } catch (e) {} scanFrame = null; }
      scanning = false;
      if (!destroyed) { updateActions(); updateHint(); drawFeatures(); }
    }

    function describeScan(scan) {
      var s = scan.summary || {};
      var bits = ["AI found " + (scan.found || 0) + " shape" + (scan.found === 1 ? "" : "s") + ", saved " + (scan.saved || 0) +
        " (" + (s.fairways || 0) + " fairways, " + (s.greens || 0) + " greens, " + (s.tees || 0) + " tees) · overlay now " + (scan.overlayTotal || 0)];
      if (scan.dropped && scan.dropped.length) bits.push(scan.dropped.length + " dropped: " + scan.dropped.map(function (d) { return d.reason; }).join("; "));
      if (scan.usage) bits.push((scan.usage.inputTokens || 0) + " in / " + (scan.usage.outputTokens || 0) + " out tokens");
      if (scan.notes) bits.push("model notes: " + scan.notes);
      return bits.join(" · ");
    }

    function pollScan(id, startedAt) {
      updateHint();
      scanTimer = setTimeout(function () {
        if (destroyed || courseIdOf(session.course) !== id) return stopScanPoll();
        api("GET", "?courseId=" + encodeURIComponent(id)).then(function (data) {
          if (destroyed || courseIdOf(session.course) !== id) return stopScanPoll();
          var scan = data && data.aiScan;
          var state = scan && scan.status;
          if (state === "done" || state === "failed") {
            if (state === "failed") { stopScanPoll(); setStatus("AI scan failed: " + (scan.error || "unknown"), true); return; }
            session.features = (data.overlay && data.overlay.features) || [];
            session.dirty = false;
            selectedId = "";
            stopScanPoll();
            setStatus(describeScan(scan), !!(scan.dropped && scan.dropped.length));
            return;
          }
          if (Date.now() - startedAt > AI_TIMEOUT_MS) { stopScanPoll(); setStatus("AI scan is taking too long - pick the course again to check on it", true); return; }
          setStatus("AI scan " + (state || "queued") + "… " + Math.round((Date.now() - startedAt) / 1000) + "s");
          pollScan(id, startedAt);
        }).catch(function (error) {
          stopScanPoll();
          setStatus("Lost track of the scan: " + (error && error.message || error), true);
        });
      }, AI_POLL_MS);
    }

    function scanWithAi() {
      var id = courseIdOf(session.course);
      if (!id || scanning || draft.length) return;
      var replace = !!el["ai-replace"].checked;
      if (replace && session.features.length && !window.confirm("Replace the " + session.features.length + " saved shape(s) with whatever the AI finds in this view?")) return;
      scanning = true;
      selectedId = "";
      setTool("move");
      drawFeatures();
      updateActions();
      /* The scan appends to what is SAVED, so anything still waiting to save goes first. */
      setStatus("Saving, then capturing the view…");
      flushSave().then(function () {
        if (session.dirty) throw new Error("the overlay did not save (" + (session.saveError || "unknown") + ")");
        return captureView();
      }).then(function (capture) {
        setStatus("Sending " + capture.width + "×" + capture.height + " px (" + capture.tiles + " tiles" + (capture.failed ? ", " + capture.failed + " missing" : "") + ", " + capture.anchors.length + " known shapes drawn on)…");
        scanFrame = L.rectangle(capture.bounds, { color: "#ffb54c", weight: 1, dashArray: "6 6", fill: false, interactive: false }).addTo(mapObj);
        return api("POST", "", { courseId: id, image: { data: capture.data, mediaType: capture.mediaType }, georef: capture.georef, append: !replace, anchors: capture.anchors, grid: capture.grid }, AI_API);
      }).then(function (data) {
        if (destroyed) return;
        setStatus("AI scan queued (" + Math.round(((data && data.georef && data.georef.metresPerPixel) || 0) * 100) / 100 + " m/px). Waiting for the model…");
        pollScan(id, Date.now());
      }).catch(function (error) {
        stopScanPoll();
        setStatus("AI scan not started: " + (error && error.message || error), true);
      });
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
        updateActions();
        updateHint();
        if (session.dirty && !session.saving) scheduleSave(SAVE_DELAY_MS);
        return;
      }
      if (session.loadedFor !== id) {
        session.features = [];
        session.osm = null;
        session.courseMap = null;
        session.loadedFor = "";
        session.dirty = false;
        selectedId = "";
        clearOsmLayers();
        clearFeatureLayers();
      }
      loadOverlay(course);
    }

    function remeasure() {
      setTimeout(function () { if (!destroyed && mapObj) { try { mapObj.invalidateSize(); } catch (e) {} } }, 60);
    }

    function pickCourse() {
      if (session.saveError && session.dirty && !window.confirm("The last change has not saved (" + session.saveError + "). Pick another course and lose it?")) return;
      flushSave();
      var pick = window.GDStudioCoursePick;
      var opened = pick && typeof pick.open === "function" && pick.open({
        source: "studio-map-overlay",
        onReturn: remeasure,
        onPick: function (course) { if (!destroyed) { cancelDraft(); setTool("move"); showCourse(course); } }
      });
      if (!opened) setStatus("The course picker is not loaded on this surface.", true);
    }

    /* ---- boot ---- */

    mapObj = L.map(el.map, {
      zoomControl: true,
      attributionControl: false,
      /* Double-click finishes a fairway line; zooming on it would move the ground under the
         last point. Zoom stays on the wheel and the control. */
      doubleClickZoom: false,
      scrollWheelZoom: true,
      maxZoom: 22
    }).setView([0, 0], 2);

    buildProviderOptions();
    useSource(session.sourceKey || bestSourceKey());

    mapObj.on("click", function (e) { handleMapClick(e.latlng); });
    mapObj.on("dblclick", function (e) {
      if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent);
      if (tool === "fairway") finishFairway();
    });
    mapObj.on("mousemove", function (e) {
      if (tool !== "fairway" || !draft.length) return;
      cursorLatLng = { lat: e.latlng.lat, lng: e.latlng.lng };
      drawDraft();
    });
    mapObj.on("mouseout", function () { if (cursorLatLng) { cursorLatLng = null; drawDraft(); } });
    mapObj.on("moveend zoomend", function () { buildProviderOptions(); updateReadout(); });
    mapObj.on("zoomend", function () { if (selectedId && !drag) { drawFeatures(); updateHint(); } });

    function onKey(event) {
      var target = event.target;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (draft.length) {
        if (event.key === "Enter") { event.preventDefault(); finishFairway(); }
        else if (event.key === "Escape") { event.preventDefault(); cancelDraft(); }
        else if (event.key === "Backspace") { event.preventDefault(); undoDraftPoint(); }
        return;
      }
      if (!session.course || !containerEl.isConnected) return;
      if ((event.key === "Delete" || event.key === "Backspace") && selectedId && canEdit() && !drag) {
        event.preventDefault();
        var f = findFeature(selectedId);
        removeFeature(selectedId);
        if (f) setStatus(kindLabel(f.kind) + " deleted.");
        return;
      }
      if (event.key === "Escape") { setTool("move"); if (selectedId) select(""); return; }
      var shortcut = { v: "move", f: "fairway", g: "green", t: "tee" }[String(event.key || "").toLowerCase()];
      if (shortcut && (shortcut === "move" || canEdit())) setTool(shortcut);
    }
    document.addEventListener("keydown", onKey);

    el.pick.addEventListener("click", pickCourse);
    el.provider.addEventListener("change", function () { useSource(el.provider.value); });
    el.osm.checked = session.showOsm;
    el.osm.addEventListener("change", function () { session.showOsm = el.osm.checked; drawOsm(); });
    el.ai.addEventListener("click", scanWithAi);
    el["tool-move"].addEventListener("click", function () { setTool("move"); });
    el["tool-fairway"].addEventListener("click", function () { setTool("fairway"); });
    el["tool-green"].addEventListener("click", function () { setTool("green"); });
    el["tool-tee"].addEventListener("click", function () { setTool("tee"); });
    el.width.addEventListener("change", function () {
      var w = num(el.width.value);
      session.fairwayWidth = w && w >= 10 && w <= 90 ? w : shapes.FAIRWAY_WIDTH_M;
      el.width.value = session.fairwayWidth;
      drawDraft();
    });
    el.finish.addEventListener("click", finishFairway);
    el.bin.addEventListener("click", function () {
      if (!selectedId || !canEdit()) { setStatus("Drag a shape or a corner onto the bin to delete it."); return; }
      var f = findFeature(selectedId);
      removeFeature(selectedId);
      if (f) setStatus(kindLabel(f.kind) + " deleted.");
    });
    el["course-map"].addEventListener("change", function () {
      var file = el["course-map"].files && el["course-map"].files[0];
      el["course-map"].value = "";
      if (file) uploadCourseMap(file);
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
    updateHint();
    updateBin();
    remeasure();

    return function cleanup() {
      /* Whatever is waiting to save goes now - leaving the page must not lose the last drag. */
      flushSave();
      destroyed = true;
      if (scanTimer) clearTimeout(scanTimer);
      if (saveTimer) clearTimeout(saveTimer);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousemove", onDragMove);
      document.removeEventListener("mouseup", onDragEnd);
      if (window.GDStudioCoursePick) window.GDStudioCoursePick.cancel();
      if (window.GDStudioShell) window.GDStudioShell.show();
      if (mapObj) { try { mapObj.remove(); } catch (e) {} }
      mapObj = null;
      layer = null;
      draftLayers = [];
      featureLayers = {};
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
