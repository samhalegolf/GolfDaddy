/* Clarity Studio - Terrain: what the terrain system decided for a course and why.
   STUDIO ONLY (data-gd-surface="studio"), loaded after scripts/studio/gd-admin-course-db.js,
   same delegation as Snapshots and Test Bakes.

   Reads /api/course-terrain (functions/course-terrain.mjs): the resolver's pick and its log,
   the course's current terrain asset (source, resolution, grid, green detail, version, when
   fetched, coverage, any provider failures), whether an upgrade is available, and the recent
   terrain jobs. "Rebuild terrain" queues a terrain job - imagery is not re-shot; a course with
   published frames is re-exported against the new terrain when the job finishes. */
(function () {
  "use strict";

  var API = "/api/course-terrain";
  /* GSPro / OPCD export (functions/course-opcd-export.mjs) - a section of this tab, since the
     export is the terrain asset (plus surfaces and trees) written out for a Unity build. */
  var OPCD_API = "/api/course-opcd-export";
  var opcd = {};   // courseId -> {status, data, error}
  var opcdPolls = {};
  var POLL_MS = 6000;
  var state = {};   // courseId -> {status, data, error}
  var polls = {};

  function esc(v) { return typeof gdEscapeHTML === "function" ? gdEscapeHTML(v) : String(v == null ? "" : v); }
  function rerender() { if (typeof gdRenderAdminCourseDatabase === "function") gdRenderAdminCourseDatabase(); }
  function toast(text) { if (typeof gdAdminCourseVisualToast === "function") gdAdminCourseVisualToast(text); else console.log(text); }
  function token() { return typeof gdAdminCourseDbAccessToken === "function" ? gdAdminCourseDbAccessToken() : Promise.resolve(""); }

  function call(method, query, body) { return request(API + (query || ""), method, body); }

  function request(url, method, body) {
    return token().then(function (t) {
      if (!t) throw new Error("Sign in again - no session token");
      return fetch(url, {
        method: method,
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: "Bearer " + t },
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

  function isShowing(courseId) {
    return typeof gdAdminCourseDatabaseTab !== "undefined" && gdAdminCourseDatabaseTab === "terrain"
      && typeof gdAdminCourseDatabaseSelected !== "undefined" && String(gdAdminCourseDatabaseSelected) === String(courseId);
  }

  function jobLive(data) {
    return !!(data && (data.jobs || []).some(function (j) { return j.status === "queued" || j.status === "running"; }));
  }

  function load(courseId) {
    if (polls[courseId]) { clearTimeout(polls[courseId]); polls[courseId] = null; }
    return call("GET", "?courseId=" + encodeURIComponent(courseId)).then(function (data) {
      state[courseId] = { status: "ready", data: data };
    }, function (error) {
      state[courseId] = { status: "error", error: String(error && error.message || error) };
    }).then(function () {
      rerender();
      var entry = state[courseId];
      if (entry && entry.status === "ready" && jobLive(entry.data)) {
        polls[courseId] = setTimeout(function () { polls[courseId] = null; if (isShowing(courseId)) load(courseId); }, POLL_MS);
      }
    });
  }

  function rebuild(courseId, force) {
    var id = String(courseId || "");
    if (!id) return false;
    call("POST", "", { action: "rebuild", courseId: id, force: !!force }).then(function (data) {
      toast(data && data.existing ? "A terrain job is already running for this course" : "Terrain rebuild queued");
      load(id);
    }).catch(function (error) { toast("Terrain rebuild not started: " + (error && error.message || error)); });
    return false;
  }

  function opcdLive(data) {
    return !!(data && (data.jobs || []).some(function (j) { return j.status === "queued" || j.status === "running"; }));
  }

  function loadOpcd(courseId) {
    if (opcdPolls[courseId]) { clearTimeout(opcdPolls[courseId]); opcdPolls[courseId] = null; }
    return request(OPCD_API + "?courseId=" + encodeURIComponent(courseId), "GET").then(function (data) {
      opcd[courseId] = { status: "ready", data: data };
    }, function (error) {
      opcd[courseId] = { status: "error", error: String(error && error.message || error) };
    }).then(function () {
      rerender();
      var entry = opcd[courseId];
      if (entry && entry.status === "ready" && opcdLive(entry.data)) {
        opcdPolls[courseId] = setTimeout(function () { opcdPolls[courseId] = null; if (isShowing(courseId)) loadOpcd(courseId); }, POLL_MS);
      }
    });
  }

  function exportOpcd(courseId) {
    var id = String(courseId || "");
    if (!id) return false;
    request(OPCD_API, "POST", { courseId: id }).then(function (data) {
      toast(data && data.existing ? "A GSPro export is already running for this course" : "GSPro export queued");
      return loadOpcd(id);
    }).catch(function (error) { toast("GSPro export not started: " + (error && error.message || error)); });
    return false;
  }

  function bytes(n) {
    n = Number(n) || 0;
    return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : n > 1024 ? Math.round(n / 1024) + " KB" : n + " B";
  }

  function opcdMarkup(courseId, id) {
    var entry = opcd[courseId] || { status: "loading" };
    var head = '<div class="gdAdminCourseActionHead"><div><h5>GSPro / OPCD export</h5>'
      + "<span>The course as the inputs to an OPCD Unity build: a 1 m UTM heightmap (16-bit RAW + GeoTIFF), surfaces as GeoJSON, trees and holes as CSV, with a README of the Unity import settings. Reads the terrain asset above; a course without one gets it baked first.</span></div>"
      + '<div class="gdAdminCourseVisualActions"><button type="button" onclick="return gdAdminCourseOpcdExport(' + id + ')">Export for GSPro</button>'
      + '<button type="button" onclick="return gdAdminCourseOpcdRefresh(' + id + ')">Refresh</button></div></div>';
    if (entry.status === "loading") return head + '<div class="gdCoursePlayDebugEmpty">Reading exports…</div>';
    if (entry.status === "error") return head + '<div class="gdCoursePlayDebugEmpty">Could not read exports: ' + esc(entry.error) + "</div>";
    var d = entry.data || {}, latest = d.latest, body = "";
    var live = (d.jobs || []).filter(function (j) { return j.status === "queued" || j.status === "running"; })[0];
    if (live) body += '<div class="gdCoursePlayDebugEmpty">Export ' + esc(live.status) + (live.progress && live.progress.stage ? " · " + esc(live.progress.stage) : "") + "…</div>";
    if (latest) {
      var f = latest.frame || {}, h = latest.heightmap || {};
      var files = (latest.files || []).map(function (x) {
        return '<li><a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.name) + "</a> · " + esc(bytes(x.bytes)) + "</li>";
      }).join("");
      body += '<table class="gdAdminCourseHoleTable"><tbody>'
        + row("Exported", esc(when(latest.finishedAt)) + " · " + esc(latest.version || ""))
        + row("Frame", esc(f.sideM + " m square, " + f.samples + " × " + f.samples + " at " + f.sampleM + " m, " + f.crs + ", origin E " + f.originEasting + " N " + f.originNorthing + (f.clipped ? " - COURSE WIDER THAN FRAME" : "")), !!f.clipped)
        + row("Heights", esc("base " + h.baseElevationM + " m, range " + h.heightRangeM + " m, ground " + h.groundMinM + "–" + h.groundMaxM + " m · Unity Import Raw: 16-bit, Windows byte order, flip vertically"))
        + row("Terrain", esc((latest.qualityClass || "—") + " · v" + (latest.terrainVersion || "?")), !!latest.qualityClass && latest.qualityClass !== "lidar")
        + row("Trees", latest.trees ? esc(latest.trees.count + " (" + latest.trees.inside + " in frame, " + latest.trees.measured + " with a measured height)") : "—")
        + row("Holes", latest.holes ? esc(latest.holes.count + " (par known for " + latest.holes.parKnown + ")") : "—")
        + "</tbody></table><ul class=\"gdAdminTerrainLog\">" + files + "</ul>"
        + ((latest.warnings || []).length ? "<ul>" + latest.warnings.map(function (w) { return '<li class="gdStudioWarnText">' + esc(w) + "</li>"; }).join("") + "</ul>" : "");
    } else if (!live) {
      body += '<div class="gdCoursePlayDebugEmpty">No export yet.</div>';
    }
    var failed = (d.jobs || []).filter(function (j) { return j.status === "failed"; })[0];
    if (failed && (!latest || String(failed.createdAt) > String(latest.finishedAt))) body += '<div class="gdStudioWarnText">Last export failed: ' + esc(failed.error || "") + "</div>";
    return head + body;
  }

  function when(iso) {
    var t = Date.parse(iso || "");
    return t ? new Date(t).toLocaleString() : "—";
  }

  var GREEN_LABELS = {
    allowed: "Slope lines allowed",
    conditional: "Slope lines where the fit passes (mixed-resolution source)",
    coarse: "Coarse - green shape only, no slope lines",
    none: "Unavailable - broad terrain only"
  };

  function row(label, value, warn) {
    return "<tr><th>" + esc(label) + "</th><td" + (warn ? ' class="gdStudioWarnText"' : "") + ">" + value + "</td></tr>";
  }

  function markup(selected) {
    var courseId = String(selected && selected.id || "");
    if (!courseId) return '<div class="gdCoursePlayDebugEmpty">No course selected.</div>';
    var id = typeof gdAdminJsArg === "function" ? gdAdminJsArg(courseId) : JSON.stringify(courseId);
    var entry = state[courseId] || { status: "loading" };
    var head = '<div class="gdAdminCourseActionHead"><div><h4>Terrain</h4>'
      + "<span>Where this course's elevation comes from, how good it is, and what it is allowed to drive. Baked once, stored as a versioned asset; play never contacts an elevation provider.</span></div>"
      + '<div class="gdAdminCourseVisualActions"><button type="button" onclick="return gdAdminCourseTerrainRebuild(' + id + ', false)">Rebuild terrain</button>'
      + '<button type="button" onclick="return gdAdminCourseTerrainRebuild(' + id + ', true)">Force rebake</button>'
      + '<button type="button" onclick="return gdAdminCourseTerrainRefresh(' + id + ')">Refresh</button></div></div>';
    if (entry.status === "loading") return '<div class="gdAdminSnapPanel">' + head + '<div class="gdCoursePlayDebugEmpty">Reading terrain…</div></div>';
    if (entry.status === "error") return '<div class="gdAdminSnapPanel">' + head + '<div class="gdCoursePlayDebugEmpty">Could not read terrain: ' + esc(entry.error) + "</div></div>";

    var d = entry.data || {};
    var s = d.summary || {};
    var res = d.resolution || {};
    var up = s.upgrade || res.upgrade || {};
    var rb = s.rebuild || {};
    var cov = s.coverage || {};
    var rows = [
      row("Resolver result", esc(s.resolverResult || "nothing usable")),
      row("Baked from", esc(s.bakedFrom || "— (no asset yet)"), s.bakedFrom && s.resolverResult && s.bakedFrom !== s.resolverResult),
      row("Source resolution", s.sourceResolutionM ? esc(s.sourceResolutionM + " m") : "—"),
      row("Final Clarity grid", s.finalGridM ? esc(s.finalGridM + " m") : "—"),
      row("Fallback", esc(s.fallback || "—")),
      row("Quality", s.qualityClass ? esc(s.qualityClass + " · confidence " + s.confidence) : "—"),
      row("Green detail", s.greenDetail ? esc(GREEN_LABELS[s.greenDetail] || s.greenDetail) : "—", s.greenDetail === "coarse" || s.greenDetail === "none"),
      row("Coverage", cov.core != null ? esc("course " + Math.round(cov.core * 100) + "% · frame " + Math.round(cov.frame * 100) + "% · filled " + (cov.filledFraction * 100).toFixed(1) + "%") : "—", cov.filledFraction > 0.02),
      row("Vertical datum", esc(s.verticalDatum || "—")),
      row("Terrain asset", esc(s.asset || "none")),
      row("Fetched", esc(when(s.fetched))),
      row("Region", esc(up.region || d.region || "—")),
      row("Regional terrain", up.regionalConfigured === false ? "Not configured" : "Configured", up.regionalConfigured === false),
      row("Terrain upgrade opportunity", up.opportunity ? "Yes - " + esc(up.reason || "") : "No", !!up.opportunity),
      row("Rebuild due", rb.rebuild ? "Yes - " + esc(rb.reason || "") : "No", !!rb.rebuild)
    ];
    if (d.lastError) rows.push(row("Last failure", esc(d.lastError) + " · " + esc(when(d.lastAttemptAt)), true));
    var failures = (s.failures || []).map(function (f) { return "<li>" + esc(f.sourceId + " — " + f.code + ": " + f.message) + "</li>"; }).join("");
    var log = (res.log || s.log || []).map(function (line) { return "<li>" + esc(line) + "</li>"; }).join("");
    var jobs = (d.jobs || []).map(function (j) {
      var r = j.result || {};
      return "<tr><td>" + esc(when(j.created_at)) + "</td><td class=\"" + (j.status === "failed" ? "gdStudioWarnText" : "") + "\">" + esc(j.status) + "</td><td>"
        + esc(j.error || (r.terrain ? r.terrain + (r.terrainVersion ? " v" + r.terrainVersion : "") + (r.reexport ? " · re-exporting frames" : "") : "")) + "</td></tr>";
    }).join("");
    return '<div class="gdAdminSnapPanel">' + head
      + '<table class="gdAdminCourseHoleTable"><tbody>' + rows.join("") + "</tbody></table>"
      + (failures ? "<h5>Provider failures at the last bake</h5><ul>" + failures + "</ul>" : "")
      + opcdMarkup(courseId, id)
      + "<h5>Resolver log</h5><ul class=\"gdAdminTerrainLog\">" + log + "</ul>"
      + (jobs ? '<h5>Terrain jobs</h5><table class="gdAdminCourseHoleTable"><thead><tr><th>Queued</th><th>State</th><th>Result</th></tr></thead><tbody>' + jobs + "</tbody></table>" : "")
      + "</div>";
  }

  function afterRender(selected) {
    var courseId = String(selected && selected.id || "");
    if (courseId && !state[courseId]) load(courseId);
    if (courseId && !opcd[courseId]) loadOpcd(courseId);
  }

  window.gdAdminCourseTerrainMarkup = markup;
  window.gdAdminCourseTerrainAfterRender = afterRender;
  window.gdAdminCourseTerrainRebuild = rebuild;
  window.gdAdminCourseTerrainRefresh = function (courseId) { load(String(courseId || "")); return false; };
  window.gdAdminCourseOpcdExport = exportOpcd;
  window.gdAdminCourseOpcdRefresh = function (courseId) { loadOpcd(String(courseId || "")); return false; };
})();
