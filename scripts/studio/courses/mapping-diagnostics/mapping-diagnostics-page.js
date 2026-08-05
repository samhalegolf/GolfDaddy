/* Clarity Studio — Mapping Diagnostics page. Studio-only, composition-only.
 *
 * Hosts the same #gdAdminDatabasePanel node (see course-database-page.js), with a persistent
 * "View diagnostics" button that sets the Debug tab — that is where scripts/gd-course-mapping-
 * debug.js's admin panel and scripts/studio/gd-course-play-debug.js's pipeline table already
 * render once a course is selected, both unmodified, both still targeting their original fixed
 * ids, which now simply live wherever the reparented node currently is.
 *
 * The button is persistent rather than one-shot because the legacy course-table row markup
 * hardcodes onclick="...gdAdminCourseDbOpen(id,'overview')" — selecting ANY course always resets
 * the tab to Overview, clobbering a tab set before a course was picked. Real finding, not a
 * hypothetical: confirmed by reading gdAdminCourseDbOpen's row markup in gd-admin-course-db.js.
 *
 * Known limitation carried over from the legacy code (not introduced by this branch): live
 * refresh for the embedded mapping-debug/pipeline-debug panels is driven by 2 CustomEvent
 * listeners + a 2200ms interval in gd-course-play-debug.js and gd-course-mapping-debug.js, all
 * gated on `#developerPanel.open`. Since this page is not `#developerPanel`, those do not fire;
 * this page's own poll (via GDStudioCourseDbHost) covers the Course Database summary/list, but
 * the embedded debug sub-panels only refresh on that poll's full gdRenderAdminCourseDatabase()
 * call, not on their own event-driven schedule. See CLARITY_STUDIO_WIRING_COMPARISON.md.
 *
 * Added 2026-08-05: a "Server Job History" section reading GET /api/course-mapper-jobs — the
 * SAME public, pre-existing endpoint (functions/course-mapper-jobs.mjs) that already returns
 * job rows/error/state for a course, which nothing in the app or Studio actually displayed
 * anywhere. That blind spot is why a schema type-mismatch bug (course_maps.geometry_version
 * declared integer, every consumer writes/compares it as a string) silently failed 100% of
 * server-side geometry saves for 5 days before being found by querying the database directly —
 * see supabase/migrations/20260805_fix_course_map_geometry_version_type.sql. This section would
 * have surfaced that immediately. No new server code — this only adds visibility. */
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function selectedCourseId() {
    try { return typeof gdAdminCourseDatabaseSelected !== "undefined" ? String(gdAdminCourseDatabaseSelected || "") : ""; }
    catch (e) { return ""; }
  }

  function stateTone(state) {
    if (state === "geometry-ready") return "ok";
    if (state === "failed") return "bad";
    if (state === "running" || state === "queued") return "warn";
    return "";
  }

  function renderJobRows(jobs) {
    if (!jobs || !jobs.length) return '<p class="gdStudioMuted">No mapping jobs recorded for this course.</p>';
    return '<div class="gdStudioJobTableWrap"><table class="gdStudioJobTable"><thead><tr>' +
      "<th>Status</th><th>Kind</th><th>Mapper</th><th>Error</th><th>Created</th><th>Updated</th>" +
      "</tr></thead><tbody>" +
      jobs.map(function (j) {
        return "<tr><td><span class=\"gdAdminCourseStatusDot " + stateTone(j.status === "done" ? "geometry-ready" : j.status) + "\">" + esc(j.status) + "</span></td>" +
          "<td>" + esc(j.kind) + "</td><td>" + esc(j.mapper_version) + "</td>" +
          "<td>" + (j.error ? '<code class="gdStudioJobError">' + esc(j.error) + "</code>" : "—") + "</td>" +
          "<td>" + esc(j.created_at) + "</td><td>" + esc(j.updated_at) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  function renderJobHistory(el, courseId) {
    if (!courseId) {
      el.innerHTML = '<p class="gdStudioMuted">Select a course above to see its server job history.</p>';
      return;
    }
    fetch("/api/course-mapper-jobs?courseId=" + encodeURIComponent(courseId))
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); })
      .then(function (data) {
        var summary = '<div class="gdAdminCourseStageLine">' +
          '<span class="' + stateTone(data.state) + '">state: ' + esc(data.state) + "</span>" +
          '<span>geometry: ' + (data.hasGeometry ? "yes (" + esc(data.geometryVersion) + ")" : "no") + "</span>" +
          (data.stalled ? '<span class="warn">stalled ' + esc(data.stalledSeconds) + "s</span>" : "") +
          (data.lastError ? '<span class="bad">last error: ' + esc(data.lastError) + "</span>" : "") +
          "</div>";
        el.innerHTML = summary + renderJobRows(data.jobs);
      })
      .catch(function (e) {
        el.innerHTML = '<p class="gdStudioNeedsVerification">Could not load job history: ' + esc(e && e.message || e) + "</p>";
      });
  }

  function render(containerEl) {
    var intro = document.createElement("div");
    intro.className = "gdStudioLede";
    intro.style.marginBottom = "14px";
    intro.innerHTML =
      "<p>Select a course below, then use the button to view its mapping-attempt evidence and " +
      "course-play pipeline debug timeline. Observational only — nothing here chooses the next " +
      "mapping tool.</p>";

    var jumpRow = document.createElement("div");
    jumpRow.style.marginBottom = "14px";
    var jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "gdStudioDiagramBtn";
    jumpBtn.textContent = "View diagnostics for selected course";
    jumpBtn.addEventListener("click", function () {
      if (typeof window.gdAdminCourseDbSetTab === "function") window.gdAdminCourseDbSetTab("debug");
    });
    jumpRow.appendChild(jumpBtn);

    var jobHistorySection = document.createElement("div");
    jobHistorySection.innerHTML = '<h3 class="gdStudioJobHistoryHeading">Server Job History (live, from course_mapper_jobs)</h3>';
    var jobHistoryBody = document.createElement("div");
    jobHistorySection.appendChild(jobHistoryBody);
    jobHistorySection.style.margin = "18px 0";

    var hostSlot = document.createElement("div");
    containerEl.appendChild(intro);
    containerEl.appendChild(jumpRow);
    containerEl.appendChild(jobHistorySection);
    containerEl.appendChild(hostSlot);

    renderJobHistory(jobHistoryBody, selectedCourseId());
    var jobInterval = setInterval(function () {
      renderJobHistory(jobHistoryBody, selectedCourseId());
    }, 4000);

    var hostCleanup = null;
    if (window.GDStudioCourseDbHost) {
      hostCleanup = window.GDStudioCourseDbHost.mount(hostSlot, { tab: "overview" });
    } else {
      hostSlot.innerHTML = '<p class="gdStudioMuted">Course Database host module did not load.</p>';
    }

    return function cleanup() {
      clearInterval(jobInterval);
      if (typeof hostCleanup === "function") hostCleanup();
    };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["mapping-diagnostics"] = render;
})();
