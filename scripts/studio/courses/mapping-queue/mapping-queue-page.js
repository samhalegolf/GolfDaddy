/* Studio > Courses > Mapping Queue.
 *
 * One place to see what the mapper is doing. Reads GET /api/course-mapper-jobs?queue=1
 * (admin only, functions/lib/gd-mapper-queue.mjs) every 10 seconds while the page is open:
 *   - Running now: claimed jobs, with a Nudge button on any the worker has gone quiet on
 *     (POST kind "nudge" - the same operator action as everywhere else);
 *   - Up next: waiting jobs in the order the worker will take them - player jobs first, then
 *     background work (nearby sweep, trees, scorecards) in idle moments;
 *   - Last 24 hours: finished and failed runs, newest first, with the error;
 *   - Waiting for a map: courses people asked to be emailed about, and how many addresses.
 * Read-only apart from Nudge. Per-course history stays on Mapping Diagnostics. */
(function () {
  "use strict";

  var API = "/api/course-mapper-jobs";
  var RELOAD_MS = 10000;

  var KIND_TEXT = {
    automap: "Map course",
    remap: "Remap",
    nearby_automap: "Background map",
    find_trees: "Find trees",
    resolve_scorecards: "Scorecards",
    collect_extra_objects: "Extra objects",
    refine_surface_shapes: "Refine shapes"
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function call(method, query, body) {
    var token = typeof window.gdAdminCourseDbAccessToken === "function" ? window.gdAdminCourseDbAccessToken() : Promise.resolve("");
    return token.then(function (t) {
      if (!t) throw new Error("Sign in again - no session token");
      return fetch(API + (query || ""), {
        method: method,
        cache: "no-store",
        headers: Object.assign({ Accept: "application/json", Authorization: "Bearer " + t }, body ? { "Content-Type": "application/json" } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
        return data || {};
      });
    });
  }

  function ago(iso) {
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return "—";
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }

  function course(job) {
    return "<strong>" + esc(job.courseName || job.courseId) + "</strong>" +
      (job.courseName ? '<br><span class="gdStudioMuted">' + esc(job.courseId) + "</span>" : "");
  }
  function kind(job) { return esc(KIND_TEXT[job.kind] || job.kind); }

  function table(heads, rows, empty) {
    if (!rows.length) return '<p class="gdStudioMuted">' + esc(empty) + "</p>";
    return '<div class="gdStudioJobTableWrap"><table class="gdStudioJobTable"><thead><tr>' +
      heads.map(function (h) { return "<th>" + esc(h) + "</th>"; }).join("") +
      "</tr></thead><tbody>" + rows.join("") + "</tbody></table></div>";
  }

  function section(title, body) {
    return '<h3 class="gdStudioJobHistoryHeading">' + esc(title) + "</h3>" + body;
  }

  function renderQueue(data) {
    var c = data.counts || {};
    var summary = '<div class="gdAdminCourseStageLine">' +
      '<span class="' + (c.running ? "warn" : "") + '">running: ' + (c.running || 0) + "</span>" +
      (c.stalled ? '<span class="bad">stalled: ' + c.stalled + "</span>" : "") +
      "<span>queued: " + (c.queued || 0) + " (" + (c.playerQueued || 0) + " from players)</span>" +
      '<span class="ok">done today: ' + (c.doneToday || 0) + "</span>" +
      '<span class="' + (c.failedToday ? "bad" : "") + '">failed today: ' + (c.failedToday || 0) + "</span>" +
      "<span>waiting for a map: " + (c.waitingCourses || 0) + "</span></div>";

    var running = table(["Course", "Job", "Asked by", "Started", "Last heard", ""], (data.running || []).map(function (job) {
      return "<tr><td>" + course(job) + "</td><td>" + kind(job) + "</td><td>" + esc(job.requestedBy) + "</td>" +
        "<td>" + esc(ago(job.createdAt)) + "</td>" +
        '<td><span class="gdAdminCourseStatusDot ' + (job.stalled ? "bad" : "warn") + '">' + esc(ago(job.updatedAt)) + (job.stalled ? " - stalled" : "") + "</span></td>" +
        "<td>" + (job.stalled ? '<button type="button" class="gdStudioDiagramBtn" data-gd-queue-nudge="' + esc(job.courseId) + '">Nudge</button>' : "") + "</td></tr>";
    }), "Nothing is being mapped right now.");

    var queued = table(["#", "Course", "Job", "Lane", "Asked by", "Queued"], (data.queued || []).map(function (job) {
      return "<tr><td>" + job.position + "</td><td>" + course(job) + "</td><td>" + kind(job) + "</td>" +
        "<td>" + (job.lane === "player" ? "Player" : '<span class="gdStudioMuted">Background</span>') + "</td>" +
        "<td>" + esc(job.requestedBy) + "</td><td>" + esc(ago(job.createdAt)) + "</td></tr>";
    }), "The queue is empty.");

    var recent = table(["Course", "Job", "Result", "Asked by", "Finished", "Error"], (data.recent || []).map(function (job) {
      return "<tr><td>" + course(job) + "</td><td>" + kind(job) + "</td>" +
        '<td><span class="gdAdminCourseStatusDot ' + (job.status === "done" ? "ok" : "bad") + '">' + esc(job.status) + "</span></td>" +
        "<td>" + esc(job.requestedBy) + "</td><td>" + esc(ago(job.updatedAt)) + "</td>" +
        "<td>" + (job.error ? '<code class="gdStudioJobError">' + esc(job.error) + "</code>" : "—") + "</td></tr>";
    }), "No runs finished in the last 24 hours.");

    var waiting = table(["Course", "Addresses waiting", "Waiting since"], (data.waiting || []).map(function (item) {
      return "<tr><td>" + course(item) + "</td><td>" + item.addresses + "</td><td>" + esc(ago(item.since)) + "</td></tr>";
    }), "Nobody is waiting on a course map.");

    return summary +
      section("Running now", running) +
      section("Up next (in the order the worker takes them)", queued) +
      section("Last 24 hours", recent) +
      section("Waiting for a map (emailed when it's ready)", waiting);
  }

  function render(containerEl) {
    var intro = document.createElement("div");
    intro.className = "gdStudioLede";
    intro.style.marginBottom = "14px";
    intro.innerHTML =
      "<p>What the mapper is doing now, what it will take next, and what finished or failed " +
      "today. Player jobs always go first; background work only runs when nothing else is " +
      "waiting. Refreshes every 10 seconds.</p>";

    var body = document.createElement("div");
    body.innerHTML = '<p class="gdStudioMuted">Loading the mapping queue…</p>';
    containerEl.appendChild(intro);
    containerEl.appendChild(body);

    var destroyed = false;
    function refresh() {
      call("GET", "?queue=1").then(function (data) {
        if (!destroyed) body.innerHTML = renderQueue(data);
      }, function (error) {
        if (!destroyed) body.innerHTML = '<p class="gdStudioNeedsVerification">Could not load the mapping queue: ' + esc(error && error.message || error) + "</p>";
      });
    }

    body.addEventListener("click", function (event) {
      var button = event.target && event.target.closest && event.target.closest("[data-gd-queue-nudge]");
      if (!button) return;
      button.disabled = true;
      call("POST", "", { kind: "nudge", courseId: button.getAttribute("data-gd-queue-nudge") }).then(refresh, function (error) {
        button.disabled = false;
        window.alert("Could not nudge: " + (error && error.message || error));
      });
    });

    refresh();
    var interval = setInterval(refresh, RELOAD_MS);
    return function cleanup() {
      destroyed = true;
      clearInterval(interval);
    };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["mapping-queue"] = render;
})();
