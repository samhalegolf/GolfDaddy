/* Clarity Studio — Course Mapping page: the player-requested course list. Studio-only,
 * composition-only.
 *
 * Course Database, Course Visuals and Mapping Diagnostics each show the whole database. This
 * page shows only the courses players asked the app to map - a player opening a course with no
 * map starts an automap job, and GET /api/course-mapper-jobs?playerRequests=1 groups those jobs
 * per course (functions/lib/gd-player-requests.mjs: guests and non-admin accounts, never the
 * admin's own scans, admin runs or the nearby sweep). Newest request first, with how often and
 * by how many players each course was asked for.
 *
 * It hosts the same #gdAdminDatabasePanel node as Course Database (see course-database-page.js
 * for why), narrowed through the host's `scope` so every row is still the live course table:
 * status, holes, Draw, location edit/remove and the Debug tab all work as they do elsewhere.
 * Requests are re-read every minute while the page is open. */
(function () {
  "use strict";

  var API = "/api/course-mapper-jobs?playerRequests=1";
  var RELOAD_MS = 60000;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function accessToken() {
    if (typeof window.gdAdminCourseDbAccessToken === "function") return window.gdAdminCourseDbAccessToken();
    return Promise.resolve("");
  }

  function loadRequests() {
    return accessToken().then(function (token) {
      if (!token) throw new Error("Sign in again - no session token");
      return fetch(API, { headers: { Accept: "application/json", Authorization: "Bearer " + token }, cache: "no-store" });
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
        return (data && data.items) || [];
      });
    });
  }

  function scopeOf(items) {
    var courses = {};
    items.forEach(function (item) { courses[item.courseId] = item; });
    return { courses: courses, emptyText: "No player has asked the app to map a course yet." };
  }

  function render(containerEl) {
    var intro = document.createElement("div");
    intro.className = "gdStudioLede";
    intro.style.marginBottom = "14px";
    intro.innerHTML =
      "<p>Courses players asked the app to map, newest request first - nothing an admin " +
      "started. Select one to review its location, then use " +
      "<strong>Jump to Mapping Diagnostics</strong> to see attempt evidence for it.</p>";

    var jumpRow = document.createElement("div");
    jumpRow.style.marginBottom = "14px";
    var jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "gdStudioDiagramBtn";
    jumpBtn.textContent = "Jump to Mapping Diagnostics";
    jumpBtn.addEventListener("click", function () {
      if (typeof window.gdAdminCourseDbSetTab === "function") window.gdAdminCourseDbSetTab("debug");
    });
    jumpRow.appendChild(jumpBtn);

    var note = document.createElement("p");
    note.className = "gdStudioMuted";
    note.textContent = "Loading player requests…";

    var hostSlot = document.createElement("div");

    containerEl.appendChild(intro);
    containerEl.appendChild(jumpRow);
    containerEl.appendChild(note);
    containerEl.appendChild(hostSlot);

    if (!window.GDStudioCourseDbHost) {
      hostSlot.innerHTML = '<p class="gdStudioMuted">Course Database host module did not load.</p>';
      return null;
    }

    var destroyed = false;
    var hostCleanup = null;

    function refresh() {
      loadRequests().then(function (items) {
        if (destroyed) return;
        note.className = "gdStudioMuted";
        note.textContent = items.length + " course" + (items.length === 1 ? "" : "s") + " requested by players.";
        if (hostCleanup) {
          if (typeof window.gdAdminCourseDbSetScope === "function") window.gdAdminCourseDbSetScope(scopeOf(items));
        } else {
          hostCleanup = window.GDStudioCourseDbHost.mount(hostSlot, { tab: "overview", scope: scopeOf(items) });
        }
      }, function (error) {
        if (destroyed) return;
        note.className = "gdStudioNeedsVerification";
        note.innerHTML = "Could not load player requests: " + esc(error && error.message || error);
      });
    }

    refresh();
    var interval = setInterval(refresh, RELOAD_MS);

    return function cleanup() {
      destroyed = true;
      clearInterval(interval);
      if (typeof hostCleanup === "function") hostCleanup();
    };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["course-mapping"] = render;
})();
