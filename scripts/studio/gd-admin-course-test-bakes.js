/* Clarity Studio - Test Bakes: the normal capture + bake, run from a test-only imagery source
   (Mapbox), shown here and nowhere else. STUDIO ONLY (data-gd-surface="studio"), loaded after
   scripts/studio/gd-admin-course-db.js, same delegation as Snapshots and Watch Maps.

   Started from the course's Rebuild menu ("Test bake with Mapbox"). The bake uses the course's
   current published geometry and writes to a private test bucket: nothing a player sees
   changes, and the frames are deleted after the retention window (functions/course-test-bakes.mjs,
   functions/lib/gd-test-bake-core.mjs). Images arrive as signed links that expire in an hour,
   which is why this view re-reads rather than caching them. */
(function () {
  "use strict";

  var API = "/api/course-test-bakes";
  var POLL_MS = 8000;
  var state = {};   // courseId -> {status:"loading"|"ready"|"error", data, error}
  var polls = {};   // courseId -> timer

  function esc(v) { return typeof gdEscapeHTML === "function" ? gdEscapeHTML(v) : String(v == null ? "" : v); }
  function rerender() { if (typeof gdRenderAdminCourseDatabase === "function") gdRenderAdminCourseDatabase(); }
  function toast(text) { if (typeof gdAdminCourseVisualToast === "function") gdAdminCourseVisualToast(text); else console.log(text); }
  function token() { return typeof gdAdminCourseDbAccessToken === "function" ? gdAdminCourseDbAccessToken() : Promise.resolve(""); }

  function call(method, query, body) {
    return token().then(function (t) {
      if (!t) throw new Error("Sign in again - no session token");
      return fetch(API + (query || ""), {
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

  function running(data) {
    return !!(data && (data.runs || []).some(function (r) { return r.status === "queued" || r.status === "running"; }));
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
      if (entry && entry.status === "ready" && running(entry.data)) {
        polls[courseId] = setTimeout(function () { polls[courseId] = null; if (isShowing(courseId)) load(courseId); }, POLL_MS);
      }
    });
  }

  function isShowing(courseId) {
    return typeof gdAdminCourseDatabaseTab !== "undefined" && gdAdminCourseDatabaseTab === "testbakes"
      && typeof gdAdminCourseDatabaseSelected !== "undefined" && String(gdAdminCourseDatabaseSelected) === String(courseId);
  }

  /* From the Rebuild menu. Confirmed because it costs a full course of tile fetches. */
  function start(courseId) {
    var id = String(courseId || "");
    if (!id) return false;
    if (!window.confirm("Test bake " + id + " with Mapbox?\n\nRuns the normal capture and bake from Mapbox Satellite, using this course's current geometry and its terrain asset.\n\nTest only: shown in Studio → Test Bakes, never published to players, deleted after 7 days.")) return false;
    call("POST", "", { courseId: id, source: "mapbox" }).then(function (data) {
      toast(data && data.deduped ? "A test bake is already running for this course" : "Mapbox test bake queued");
      if (typeof gdAdminCourseDbOpen === "function") gdAdminCourseDbOpen(id, "testbakes");
      load(id);
    }).catch(function (error) {
      toast("Test bake not started: " + (error && error.message || error));
    });
    return false;
  }

  function when(iso) {
    var t = Date.parse(iso || "");
    return t ? new Date(t).toLocaleString() : "";
  }

  function runLine(run) {
    var p = (run.export && run.export.progress) || (run.snapshot && run.snapshot.progress) || null;
    var progress = p ? (p.holesTotal ? p.holesDone + "/" + p.holesTotal + " holes" : p.capturesTotal ? p.capturesDone + "/" + p.capturesTotal + " captures" : "") : "";
    var label = run.status === "done" ? "done" : run.status === "failed" ? "failed at " + run.stage : run.stage + " " + run.status;
    return "<tr><td>" + esc(when(run.requestedAt)) + "</td><td>" + esc(run.source) + "</td><td class=\"" + (run.status === "failed" ? "gdStudioWarnText" : "") + "\">" + esc(label) + (progress ? " · " + esc(progress) : "") + "</td><td>" + esc(run.error || "") + "</td></tr>";
  }

  function tile(label, url, w, h, extra) {
    if (!url) return "";
    return '<figure class="gdAdminSnapTile"><a href="' + esc(url) + '" target="_blank" rel="noopener"><img loading="lazy" decoding="async" src="' + esc(url) + '" alt="' + esc(label) + '"></a>'
      + "<figcaption><b>" + esc(label) + "</b><span>" + esc((w || "?") + "×" + (h || "?")) + (extra ? " · " + esc(extra) : "") + "</span></figcaption></figure>";
  }

  function markup(selected) {
    var courseId = String(selected && selected.id || "");
    if (!courseId) return '<div class="gdCoursePlayDebugEmpty">No course selected.</div>';
    var id = typeof gdAdminJsArg === "function" ? gdAdminJsArg(courseId) : JSON.stringify(courseId);
    var entry = state[courseId] || { status: "loading" };
    var head = '<div class="gdAdminCourseActionHead"><div><h4>Test Bakes</h4>'
      + "<span>The normal capture and bake, from Mapbox Satellite over the course's own terrain asset. Test only: never published to players, deleted after "
      + esc(entry.data && entry.data.retentionDays || 7) + " days.</span></div>"
      + '<div class="gdAdminCourseVisualActions"><button type="button" onclick="return gdAdminCourseTestBakeStart(' + id + ')">Test bake with Mapbox</button>'
      + '<button type="button" onclick="return gdAdminCourseTestBakesRefresh(' + id + ')">Refresh</button></div></div>';
    if (entry.status === "loading") return '<div class="gdAdminSnapPanel">' + head + '<div class="gdCoursePlayDebugEmpty">Reading test bakes…</div></div>';
    if (entry.status === "error") return '<div class="gdAdminSnapPanel">' + head + '<div class="gdCoursePlayDebugEmpty">Could not read test bakes: ' + esc(entry.error) + "</div></div>";
    var data = entry.data || {};
    var runs = data.runs || [];
    var notice = data.mapboxConfigured === false ? '<div class="gdCoursePlayDebugEmpty gdStudioWarnText">MAPBOX_PUBLIC_TOKEN is not set on this site - a test bake cannot start.</div>' : "";
    var table = runs.length
      ? '<table class="gdAdminCourseHoleTable"><thead><tr><th>Requested</th><th>Source</th><th>State</th><th>Error</th></tr></thead><tbody>' + runs.map(runLine).join("") + "</tbody></table>"
      : '<div class="gdCoursePlayDebugEmpty">No test bakes for this course yet. Rebuild → Test bake with Mapbox.</div>';
    var latest = data.latest;
    var frames = "";
    if (latest) {
      var src = latest.source || {};
      frames = '<div class="gdAdminCourseStageLine"><span>Latest finished bake · ' + esc(when(latest.requestedAt)) + "</span><span>Imagery: " + esc(src.label || src.key || "?") + "</span><span>" + esc(src.attribution && src.attribution.text || "") + "</span><span>links expire in an hour - Refresh for new ones</span></div>"
        + '<div class="gdAdminSnapGrid">'
        + (latest.overview ? tile("Course overview", latest.overview.url, latest.overview.width, latest.overview.height) : "")
        + (latest.holes || []).map(function (h) {
          var elev = h.elevation && h.elevation.min != null ? Number(h.elevation.min).toFixed(1) + "–" + Number(h.elevation.max).toFixed(1) + " m" : "";
          return tile("Hole " + h.holeNumber, h.url, h.width, h.height, elev) + (h.greenUrl ? tile("Hole " + h.holeNumber + " green", h.greenUrl, "", "") : "");
        }).join("")
        + "</div>";
    }
    return '<div class="gdAdminSnapPanel">' + head + notice + table + frames + "</div>";
  }

  function afterRender(selected) {
    var courseId = String(selected && selected.id || "");
    if (courseId && !state[courseId]) load(courseId);
  }

  window.gdAdminCourseTestBakesMarkup = markup;
  window.gdAdminCourseTestBakesAfterRender = afterRender;
  window.gdAdminCourseTestBakeStart = start;
  window.gdAdminCourseTestBakesRefresh = function (courseId) { load(String(courseId || "")); return false; };
})();
