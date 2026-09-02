/* Clarity Studio - Watch Map generation + viewer. STUDIO ONLY (data-gd-surface="studio"),
   loaded after scripts/studio/gd-admin-course-db.js and scripts/gd-watch-map-core.js.

   Owns exactly the two actions the task asks for on the course action rail/maintenance menu -
   "Generate Watch Maps" (POST /api/course-watch-maps, dispatched from
   gdAdminCourseMaintenance("generate_watch_maps",...) in gd-admin-course-db.js) and "View Watch
   Maps" (the "Watch Maps" rail button, which opens the watchmaps tab this file renders) - plus
   the inspection viewer itself: hole navigation, pan/zoom, and a spatial-debug overlay that
   projects the course's own tee/green coordinates onto the baked image using the exact same
   transform (window.GDWatchMapCore) the generator used, so a flipped axis or a bad scale shows
   up as a dot in the wrong place.

   This is a READ+GENERATE surface only. It never touches course_maps, course_visuals, or the
   native visual recipe - generating or viewing a Watch package cannot change what GPS Play or
   the native Course Visual Engine shows. */
(function () {
  "use strict";

  var reports = {};      // courseId -> report object | "loading" | "error"
  var holeByCourse = {}; // courseId -> selected hole number
  var viewByKey = {};    // "<courseId>:<hole>" -> {scale, tx, ty}
  var debugByCourse = {};// courseId -> boolean
  var generatingByCourse = {}; // courseId -> true while a generate() POST is in flight
  var progressByCourse = {};   // courseId -> the bake's own {stage,...} block, while it runs
  var progressTimer = null;
  var dragState = null;

  function core() { return window.GDWatchMapCore || null; }
  function progressCore() { return window.GDProgressCore || null; }
  function esc(v) { return typeof gdEscapeHTML === "function" ? gdEscapeHTML(v) : String(v == null ? "" : v); }
  function toast(text) { if (typeof gdAdminCourseVisualToast === "function") gdAdminCourseVisualToast(text); }
  function rerender() { if (typeof gdRenderAdminCourseDatabase === "function") gdRenderAdminCourseDatabase(); }
  function accessToken() { return typeof gdAdminCourseDbAccessToken === "function" ? gdAdminCourseDbAccessToken() : Promise.resolve(null); }

  function fetchReport(courseId, opts) {
    opts = opts || {};
    if (!opts.force && reports[courseId] && reports[courseId] !== "error") return;
    reports[courseId] = "loading";
    fetch("/api/course-watch-maps?courseId=" + encodeURIComponent(courseId), { headers: { Accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error("status " + res.status)); })
      .then(function (data) {
        reports[courseId] = data;
        if (!holeByCourse[courseId] && Array.isArray(data.holes) && data.holes.length) holeByCourse[courseId] = data.holes[0].holeNumber;
        rerender();
      })
      .catch(function () { reports[courseId] = "error"; rerender(); });
  }

  /* The bake is one blocking POST, so the browser that started it cannot learn anything from
     its own request until it returns. It CAN ask the server, though: the generator writes its
     stage into course_watch_maps.progress as it goes (see writeProgress in
     functions/course-watch-maps.mjs), and that is a normal row any GET can read. So the
     percentage here is the real one - the hole the server is actually on - not an estimate
     made from elapsed time.

     Deliberately a separate, lighter request than fetchReport: that one replaces the whole
     report and would swap the viewer's image out from under a pan/zoom mid-bake. This reads
     the same endpoint and keeps only the progress block. */
  function pollProgress(courseId) {
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    if (!generatingByCourse[courseId]) { delete progressByCourse[courseId]; return; }
    fetch("/api/course-watch-maps?courseId=" + encodeURIComponent(courseId), { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!generatingByCourse[courseId]) return;
        if (data && data.progress) { progressByCourse[courseId] = data.progress; rerender(); }
      })
      .catch(function () { /* A missed poll is a stale bar for two seconds, not an error. */ })
      .then(function () {
        if (generatingByCourse[courseId]) progressTimer = setTimeout(function () { pollProgress(courseId); }, 2000);
      });
  }

  async function generate(courseId) {
    courseId = String(courseId || "");
    if (!courseId) return false;
    var existing = reports[courseId];
    if (existing && existing.status === "ready" && !window.confirm("Regenerate Watch maps for " + courseId + "?\n\nBakes fresh hole images from the course's current geometry with the Watch Map recipe and replaces the existing Watch package. Native visuals, geometry and GPS Play imagery are not touched.")) return false;
    /* Set BEFORE the first await, so the button disables and the progress bar appears the
       instant the click handler runs - not after accessToken()'s own round trip, which was the
       gap that made a click look like nothing happened. The bake itself is one blocking POST
       with no incremental status to poll (see functions/course-watch-maps.mjs's own header on
       why this is synchronous, not a job queue), so the bar is deliberately indeterminate -
       it says "working", not a percentage this code has no way to know. */
    generatingByCourse[courseId] = true;
    delete progressByCourse[courseId];
    var pcore = progressCore();
    if (pcore) pcore.clearFloor(courseId + ":watch");
    rerender();
    pollProgress(courseId);
    try {
      var token = await accessToken();
      if (!token) { toast("Sign in again to generate Watch maps"); return false; }
      var res = await fetch("/api/course-watch-maps", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ courseId: courseId })
      });
      var data = await res.json().catch(function () { return null; });
      if (res.status === 403) { toast("Admin only"); return false; }
      if (res.status === 404) { toast((data && data.error) || "Course has no geometry to generate from"); return false; }
      if (!res.ok) {
        if (data && data.holes) reports[courseId] = data;
        var stage = data && data.failure && data.failure.stage;
        toast((data && data.error) || (stage ? "Watch Maps failed during " + stage : "Generate Watch Maps failed (" + res.status + ")"));
        return false;
      }
      reports[courseId] = data;
      holeByCourse[courseId] = data.holes && data.holes[0] ? data.holes[0].holeNumber : null;
      var word = data.status === "ready" ? "ready" : data.status === "partial" ? "partial (" + data.readyHoleCount + "/" + data.holeCount + " holes)" : "failed";
      toast("Watch maps " + word + " — " + Math.round((data.totalBytes || 0) / 1024) + " KB");
    } catch (error) {
      toast("Generate Watch Maps failed to send");
    } finally {
      generatingByCourse[courseId] = false;
      delete progressByCourse[courseId];
      if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
      if (pcore) pcore.clearFloor(courseId + ":watch");
      if (typeof gdAdminCourseDbShowWatchMaps === "function") gdAdminCourseDbShowWatchMaps(courseId);
      else rerender();
      /* The POST result is rendered immediately, then re-read from the normal source of truth
         so the gallery never waits for a reload and subsequent visits see the saved package. */
      fetchReport(courseId, { force: true });
    }
    return false;
  }

  function selectHole(courseId, holeNumber) {
    holeByCourse[String(courseId)] = Number(holeNumber);
    rerender();
    return false;
  }
  function stepHole(courseId, delta) {
    var report = reports[courseId];
    if (!report || !Array.isArray(report.holes) || !report.holes.length) return false;
    var numbers = report.holes.map(function (h) { return h.holeNumber; });
    var current = holeByCourse[courseId];
    var idx = numbers.indexOf(current);
    if (idx < 0) idx = 0;
    idx = (idx + delta + numbers.length) % numbers.length;
    holeByCourse[courseId] = numbers[idx];
    rerender();
    return false;
  }
  function toggleDebug(courseId) {
    debugByCourse[courseId] = !debugByCourse[courseId];
    rerender();
    return false;
  }

  // ---------------------------------------------------------------- pan/zoom

  function viewKey(courseId, hole) { return courseId + ":" + hole; }
  function viewFor(courseId, hole, holeRecord, viewportW, viewportH) {
    var key = viewKey(courseId, hole);
    if (!viewByKey[key]) {
      var fit = Math.min(viewportW / holeRecord.width, viewportH / holeRecord.height);
      viewByKey[key] = { scale: fit, tx: (viewportW - holeRecord.width * fit) / 2, ty: (viewportH - holeRecord.height * fit) / 2, fit: fit };
    }
    return viewByKey[key];
  }
  function resetView(courseId, hole) {
    delete viewByKey[viewKey(courseId, hole)];
    rerender();
    return false;
  }
  function zoomBy(courseId, hole, factor) {
    var v = viewByKey[viewKey(courseId, hole)];
    if (!v) return false;
    var next = Math.max(v.fit * 0.6, Math.min(v.fit * 8, v.scale * factor));
    var cx = 180, cy = 240; // viewport is 360x480 (see viewerMarkup) - button zoom centres on it
    v.tx = cx - ((cx - v.tx) / v.scale) * next;
    v.ty = cy - ((cy - v.ty) / v.scale) * next;
    v.scale = next;
    rerender();
    return false;
  }

  function onStageMouseDown(e, courseId, hole) {
    var key = viewKey(courseId, hole);
    dragState = { key: key, startX: e.clientX, startY: e.clientY, origin: Object.assign({}, viewByKey[key]) };
    e.preventDefault();
  }
  function onStageMouseMove(e) {
    if (!dragState) return;
    var v = viewByKey[dragState.key];
    if (!v) return;
    v.tx = dragState.origin.tx + (e.clientX - dragState.startX);
    v.ty = dragState.origin.ty + (e.clientY - dragState.startY);
    var img = document.getElementById("gdWatchMapImg");
    if (img) img.style.transform = "translate(" + v.tx + "px," + v.ty + "px) scale(" + v.scale + ")";
  }
  function onStageMouseUp() {
    if (dragState) rerender();
    dragState = null;
  }
  function onStageWheel(e, courseId, hole) {
    var key = viewKey(courseId, hole);
    var v = viewByKey[key];
    if (!v) return;
    e.preventDefault();
    var rect = e.currentTarget.getBoundingClientRect();
    var cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    var next = Math.max(v.fit * 0.6, Math.min(v.fit * 8, v.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    v.tx = cx - ((cx - v.tx) / v.scale) * next;
    v.ty = cy - ((cy - v.ty) / v.scale) * next;
    v.scale = next;
    rerender();
  }

  function wireStage(courseId, hole) {
    var stage = document.getElementById("gdWatchMapStage");
    if (!stage) return;
    stage.addEventListener("mousedown", function (e) { onStageMouseDown(e, courseId, hole); });
    window.addEventListener("mousemove", onStageMouseMove);
    window.addEventListener("mouseup", onStageMouseUp);
    stage.addEventListener("wheel", function (e) { onStageWheel(e, courseId, hole); }, { passive: false });
  }

  // ---------------------------------------------------------------- markup

  function statusLabel(report) {
    if (!report || report.status === "none") return { label: "Not generated", tone: "" };
    if (report.status === "ready") return { label: "Ready · " + report.readyHoleCount + "/" + report.holeCount + " holes · " + Math.round(report.totalBytes / 1024) + " KB · Recipe v" + report.recipeVersion, tone: "ok" };
    if (report.status === "recovery") return { label: "Recovery needed · " + report.readyHoleCount + " generated assets found · Package metadata missing", tone: "warn" };
    if (report.status === "partial") return { label: "Partial · " + report.readyHoleCount + "/" + report.holeCount + " holes · " + Math.round(report.totalBytes / 1024) + " KB", tone: "warn" };
    if (report.status === "failed" && report.failure) return { label: "Generation failed · " + (report.failure.stage || "unknown stage"), tone: "bad" };
    return { label: "Failed", tone: "bad" };
  }

  function statusHead(courseId, report) {
    var status = statusLabel(report);
    var generating = !!generatingByCourse[courseId];
    var busy = report === "loading" || generating;
    var buttonLabel = generating ? "Baking…" : (report && report.status === "ready" ? "Regenerate Watch Maps" : "Generate Watch Maps");
    /* The same bar, from the same module, that the Course Database draws for every mapping and
       building run - see scripts/gd-progress-core.js. Real percentages: the generator reports
       the hole it is on and pollProgress reads it back.

       Indeterminate only for the gap before the first stage lands (and on an older deployment
       where the progress column is not there yet), which is what an indeterminate bar is
       actually for - "running, cannot say how far" - rather than the whole bake. */
    var pcore = progressCore();
    var bar = "";
    if (generating) {
      var model = pcore && progressByCourse[courseId]
        ? pcore.watchProgress({ progress: progressByCourse[courseId] }, { key: courseId + ":watch" })
        : { live: true, pct: null, label: "Baking hole images", detail: "", stalled: false, stage: "" };
      bar = pcore ? pcore.barMarkup(model) : "";
    }
    return '<div class="gdAdminCourseStageLine gdAdminWatchMapStatusLine">' +
      '<span class="gdAdminCourseStatusDot ' + status.tone + '">Watch Maps: ' + esc(status.label) + '</span>' +
      '</div>' +
      '<div class="gdAdminCourseVisualActions">' +
      '<button type="button" class="primary" ' + (busy ? "disabled" : "") + ' onclick="return gdAdminCourseWatchMapsGenerate(\'' + esc(courseId) + '\')">' + buttonLabel + '</button>' +
      '</div>' +
      bar;
  }

  function errorsMarkup(report) {
    if (!report) return "";
    var errors = Array.isArray(report.errors) ? report.errors : [];
    if (!errors.length && !report.failure) return "";
    var items = errors.map(function (e) { return "<li>" + (e.holeNumber ? "Hole " + esc(e.holeNumber) + ": " : "") + esc(e.reason) + "</li>"; }).join("");
    if (report.failure) items += "<li><b>Stage:</b> " + esc(report.failure.stage || "unknown") + " · " + esc(report.failure.generatedHoleCount || 0) + " images generated · " + esc(report.failure.uploadedHoleCount || 0) + " uploaded" + (report.failure.reason ? "<br>" + esc(report.failure.reason) : "") + "</li>";
    return '<details class="gdAdminCourseSettings" open><summary>' + (errors.length + (report.failure ? 1 : 0)) + ' issue(s)</summary><ul class="gdAdminWatchMapErrorList">' + items + '</ul></details>';
  }

  function holeSelector(courseId, report, current) {
    var options = report.holes.map(function (h) {
      return '<option value="' + h.holeNumber + '" ' + (h.holeNumber === current ? "selected" : "") + '>Hole ' + h.holeNumber + '</option>';
    }).join("");
    return '<select onchange="return gdAdminCourseWatchMapsSelectHole(\'' + esc(courseId) + '\',this.value)">' + options + '</select>';
  }

  function debugPointMarkup(label, latLng, holeRecord, view) {
    var engine = core();
    if (!engine || !latLng) return "";
    var imgPx = engine.projectLatLngToImage(holeRecord.spatialReference, latLng.lat, latLng.lng);
    var left = view.tx + imgPx.x * view.scale;
    var top = view.ty + imgPx.y * view.scale;
    return '<div class="gdAdminWatchMapDot" style="left:' + left + 'px;top:' + top + 'px" title="' + esc(label) + ' (' + latLng.lat.toFixed(6) + ', ' + latLng.lng.toFixed(6) + ')"><i></i><span>' + esc(label) + '</span></div>';
  }

  function debugPanel(courseId, holeRecord) {
    var sr = holeRecord.spatialReference || {};
    var rows = [
      ["image", holeRecord.width + "×" + holeRecord.height + " " + holeRecord.format],
      ["bytes", holeRecord.bytes + " B"],
      ["metres/px", Number(sr.metresPerPixel || 0).toFixed(3)],
      ["rotation", Number(sr.rotationDegrees || 0).toFixed(1) + "°"],
      ["origin", (Number(sr.originLat || 0)).toFixed(6) + ", " + (Number(sr.originLon || 0)).toFixed(6)],
      ["recipe", (sr.recipeId || "") + " v" + sr.recipeVersion],
      ["course/hole", courseId + " / h" + holeRecord.holeNumber],
      ["layers", holeRecord.layers ? "fairways " + holeRecord.layers.fairways + "/" + holeRecord.layers.fairwaysMapped + " · bunkers " + holeRecord.layers.bunkers + "/" + holeRecord.layers.bunkersMapped + " · water " + holeRecord.layers.water + "/" + holeRecord.layers.waterMapped : "not available without package metadata"],
      ["validation", holeRecord.validation && holeRecord.validation.ok ? "ok" : "ISSUES: " + ((holeRecord.validation && holeRecord.validation.issues) || []).join("; ")]
    ];
    return '<div class="gdAdminWatchMapDebugPanel">' + rows.map(function (r) { return '<div><b>' + esc(r[0]) + '</b><span>' + esc(r[1]) + '</span></div>'; }).join("") + '</div>';
  }

  function galleryMarkup(courseId, report, current) {
    return '<div class="gdAdminWatchMapGallery" aria-label="Generated Watch Map gallery">' + report.holes.map(function (hole) {
      var src = "/api/course-watch-map-assets?path=" + encodeURIComponent(hole.path);
      var selected = hole.holeNumber === current;
      return '<article class="gdAdminWatchMapCard ' + (selected ? "selected" : "") + '">' +
        '<button type="button" onclick="return gdAdminCourseWatchMapsSelectHole(\'' + esc(courseId) + '\',' + hole.holeNumber + ')" aria-label="Inspect Hole ' + hole.holeNumber + '">' +
        '<img src="' + esc(src) + '" alt="Watch map thumbnail, hole ' + hole.holeNumber + '" loading="lazy"></button>' +
        '<div><b>Hole ' + hole.holeNumber + '</b><a href="' + esc(src) + '" target="_blank" rel="noopener">Open full size</a></div>' +
        '</article>';
    }).join("") + '</div>';
  }

  function viewerMarkup(courseId, report, current) {
    var holeRecord = report.holes.find(function (h) { return h.holeNumber === current; }) || report.holes[0];
    if (!holeRecord) return '<div class="gdCoursePlayDebugEmpty">No Watch map holes generated yet.</div>';
    current = holeRecord.holeNumber;
    holeByCourse[courseId] = current;
    var viewportW = 360, viewportH = 480;
    var view = viewFor(courseId, current, holeRecord, viewportW, viewportH);
    var src = "/api/course-watch-map-assets?path=" + encodeURIComponent(holeRecord.path);
    var debugOn = !!debugByCourse[courseId];
    var checkpoints = holeRecord.checkpoints || {};
    var dots = debugOn && holeRecord.spatialReference ? ["tee", "green", "greenFront", "greenBack"].map(function (k) {
      return debugPointMarkup(k, checkpoints[k], holeRecord, view);
    }).join("") : "";
    return '<div class="gdAdminWatchMapViewer">' +
      '<div class="gdAdminWatchMapToolbar">' +
      '<button type="button" onclick="return gdAdminCourseWatchMapsStep(\'' + esc(courseId) + '\',-1)">← Previous Hole</button>' +
      '<span>Hole ' + current + ' of ' + report.holeCount + '</span>' + holeSelector(courseId, report, current) +
      '<button type="button" onclick="return gdAdminCourseWatchMapsStep(\'' + esc(courseId) + '\',1)">Next Hole →</button>' +
      '</div>' +
      '<div class="gdAdminWatchMapToolbar">' +
      '<button type="button" onclick="return gdAdminCourseWatchMapsZoom(\'' + esc(courseId) + '\',' + current + ',1.25)">Zoom +</button>' +
      '<button type="button" onclick="return gdAdminCourseWatchMapsZoom(\'' + esc(courseId) + '\',' + current + ',0.8)">Zoom −</button>' +
      '<button type="button" onclick="return gdAdminCourseWatchMapsResetView(\'' + esc(courseId) + '\',' + current + ')">Reset</button>' +
      (holeRecord.spatialReference ? '<button type="button" class="' + (debugOn ? "active" : "") + '" onclick="return gdAdminCourseWatchMapsToggleDebug(\'' + esc(courseId) + '\')">Spatial debug</button>' : '') +
      '</div>' +
      '<div class="gdAdminWatchMapStage" id="gdWatchMapStage" style="width:' + viewportW + 'px;height:' + viewportH + 'px">' +
      '<img id="gdWatchMapImg" src="' + esc(src) + '" alt="Watch map, hole ' + current + '" draggable="false" style="transform:translate(' + view.tx + 'px,' + view.ty + 'px) scale(' + view.scale + ')">' +
      dots +
      '</div>' +
      (debugOn ? debugPanel(courseId, holeRecord) : "") +
      '</div>';
  }

  function markup(selected) {
    var courseId = (selected && selected.id) || "";
    if (!courseId) return '<div class="gdCoursePlayDebugEmpty">No course selected.</div>';
    fetchReport(courseId);
    var report = reports[courseId];
    var head = statusHead(courseId, report === "loading" || report === "error" ? null : report);
    if (report === "loading" || report === undefined) return '<div class="gdAdminCourseWorkspace">' + head + '<div class="gdCoursePlayDebugEmpty">Loading Watch Map status…</div></div>';
    if (report === "error") return '<div class="gdAdminCourseWorkspace">' + head + '<div class="gdCoursePlayDebugEmpty">Could not load Watch Map status.</div></div>';
    if (!report.holes || !report.holes.length) return '<div class="gdAdminCourseWorkspace">' + head + errorsMarkup(report) + '<div class="gdCoursePlayDebugEmpty">No Watch maps generated yet for this course.</div></div>';
    var current = holeByCourse[courseId] || report.holes[0].holeNumber;
    return '<div class="gdAdminCourseWorkspace">' + head + errorsMarkup(report) + galleryMarkup(courseId, report, current) + viewerMarkup(courseId, report, current) + '</div>';
  }

  function afterRender(selected) {
    var courseId = (selected && selected.id) || "";
    var report = reports[courseId];
    if (!courseId || !report || report === "loading" || report === "error" || !report.holes || !report.holes.length) return;
    var current = holeByCourse[courseId] || report.holes[0].holeNumber;
    wireStage(courseId, current);
  }

  window.gdAdminCourseWatchMapsGenerate = generate;
  window.gdAdminCourseWatchMapsMarkup = markup;
  window.gdAdminCourseWatchMapsAfterRender = afterRender;
  window.gdAdminCourseWatchMapsSelectHole = selectHole;
  window.gdAdminCourseWatchMapsStep = stepHole;
  window.gdAdminCourseWatchMapsToggleDebug = toggleDebug;
  window.gdAdminCourseWatchMapsZoom = function (courseId, hole, factor) { return zoomBy(courseId, Number(hole), factor); };
  window.gdAdminCourseWatchMapsResetView = function (courseId, hole) { return resetView(courseId, Number(hole)); };
})();
