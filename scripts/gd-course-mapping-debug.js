/*
 * gd-course-mapping-debug.js
 * --------------------------
 * Observational diagnostics for course mapping attempts. This module records
 * what fired and why; it never chooses the next mapping tool.
 */
(function () {
  "use strict";

  if (window.GDCourseMappingDebug && window.GDCourseMappingDebug.__version) return;

  var VERSION = "course-mapping-debug-v1";
  var STORE_KEY = "gd_course_mapping_debug_runs_v1";
  var RECENT_LIMIT = 10;
  var EVENT_LIMIT = 180;
  var CHECKPOINT_STAGES = [
    ["initial-snapshot", "Initial Snapshot"],
    ["fairway-lines", "Fairway Lines"],
    ["number-allocation", "Number Allocation"]
  ];
  var VALID_SOURCES = {
    "course-loader": 1,
    "saved-map": 1,
    automapper: 1,
    "native-resolver": 1,
    "manual-fallback": 1,
    persistence: 1,
    unknown: 1
  };
  var VALID_PHASES = {
    requested: 1,
    started: 1,
    progress: 1,
    checkpoint: 1,
    completed: 1,
    skipped: 1,
    failed: 1,
    cancelled: 1,
    superseded: 1,
    fallback: 1
  };
  var SECRET_KEY_RE = /api[_-]?key|auth|bearer|cookie|password|secret|session|token/i;
  var POINT_ARRAY_KEYS = /coordinates|geometry|path|paths|polygon|polygons|shape|shapes|elements|raw/i;
  var state = {
    activeRunId: "",
    selectedRunId: "",
    runs: []
  };

  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function uid(prefix) {
    return String(prefix || "id") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }

  function prettyLabel(value) {
    return String(value || "unknown").replace(/-/g, " ").replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  }

  function seconds(ms) {
    var n = Number(ms);
    if (!Number.isFinite(n)) return "";
    if (n < 1000) return Math.round(n) + " ms";
    return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "") + " s";
  }

  function percent(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return "";
    return Math.round(n * 100) + "%";
  }

  function cleanSource(source) {
    var value = String(source || "unknown").toLowerCase();
    if (value === "resolver" || value === "native" || value.indexOf("course-geometry") >= 0) value = "native-resolver";
    if (value === "osm" || value === "osm-automapper" || value === "auto-mapper") value = "automapper";
    if (value === "manual" || value === "green-fallback" || value === "interactive-green-fallback") value = "manual-fallback";
    return VALID_SOURCES[value] ? value : "unknown";
  }

  function cleanPhase(phase) {
    var value = String(phase || "progress").toLowerCase();
    return VALID_PHASES[value] ? value : "progress";
  }

  function courseIdFrom(input) {
    input = input || {};
    var course = input.course || input;
    return String(course.courseId || course.id || input.courseId || course.canonicalKey || course.name || course.courseName || "course").trim() || "course";
  }

  function courseNameFrom(input) {
    input = input || {};
    var course = input.course || input;
    return String(course.courseName || course.name || input.courseName || input.courseId || course.id || "Course").trim() || "Course";
  }

  function makeRunId(input) {
    var stem = courseIdFrom(input).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "course";
    return "map-run-" + stem + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  function clone(value) {
    return sanitize(value, { rawJson: true, maxDepth: 10 });
  }

  function looksLikePointArray(value) {
    if (!Array.isArray(value) || !value.length) return false;
    var sample = value.slice(0, Math.min(value.length, 8));
    return sample.every(function (item) {
      return item && typeof item === "object" &&
        (Number.isFinite(Number(item.lat)) || Number.isFinite(Number(item.latitude)) || Number.isFinite(Number(item[0])));
    });
  }

  function sanitize(value, opts, key, depth) {
    opts = opts || {};
    depth = depth || 0;
    if (value == null) return value;
    if (typeof value === "string") {
      if (/^data:image\//i.test(value)) return "[image-data-url omitted]";
      if (/^data:/i.test(value) && value.length > 180) return "[data-url omitted]";
      return value.length > (opts.longStringLimit || 1800) ? value.slice(0, opts.longStringLimit || 1800) + "... [truncated]" : value;
    }
    if (typeof value !== "object") return value;
    if (depth > (opts.maxDepth || 6)) return "[nested data omitted]";
    if (Array.isArray(value)) {
      if (looksLikePointArray(value) || (key && POINT_ARRAY_KEYS.test(String(key)) && value.length > 12)) {
        return "[" + value.length + " geometry items omitted]";
      }
      var limit = opts.arrayLimit || 32;
      var rows = value.slice(0, limit).map(function (item) { return sanitize(item, opts, key, depth + 1); });
      if (value.length > limit) rows.push("[" + (value.length - limit) + " more items omitted]");
      return rows;
    }
    var out = {};
    Object.keys(value).forEach(function (childKey) {
      if (SECRET_KEY_RE.test(childKey)) {
        out[childKey] = "[redacted]";
        return;
      }
      if (/imageDataUrl|dataUrl|base64|rawImage/i.test(childKey)) {
        out[childKey] = "[image payload omitted]";
        return;
      }
      out[childKey] = sanitize(value[childKey], opts, childKey, depth + 1);
    });
    return out;
  }

  function lightweightRun(run) {
    var copy = {
      runId: run.runId,
      courseId: run.courseId,
      courseName: run.courseName,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      status: run.status,
      outcome: run.outcome,
      eventSequence: run.eventSequence || 0,
      events: sanitize(run.events || [], { arrayLimit: EVENT_LIMIT, maxDepth: 7 }),
      checkpoints: (run.checkpoints || []).map(function (checkpoint) {
        return sanitize(Object.assign({}, checkpoint, { imageDataUrl: undefined }), { maxDepth: 5 });
      })
    };
    return copy;
  }

  function persist() {
    safe(function () {
      var rows = state.runs.slice(0, RECENT_LIMIT).map(lightweightRun);
      sessionStorage.setItem(STORE_KEY, JSON.stringify(rows));
    });
    mirror();
  }

  function restore() {
    var rows = safe(function () { return JSON.parse(sessionStorage.getItem(STORE_KEY) || "[]"); }, []);
    if (!Array.isArray(rows)) return;
    state.runs = rows.slice(0, RECENT_LIMIT).map(function (run) {
      run.events = Array.isArray(run.events) ? run.events.slice(-EVENT_LIMIT) : [];
      run.checkpoints = Array.isArray(run.checkpoints) ? run.checkpoints : [];
      run.eventSequence = Number(run.eventSequence) || run.events.reduce(function (max, event) { return Math.max(max, Number(event.sequence) || 0); }, 0);
      return run;
    });
    var active = state.runs.find(function (run) { return run.status === "active"; });
    state.activeRunId = active && active.runId || "";
  }

  function mirror() {
    window.__gdCourseMappingDebug = api;
  }

  function sortEvents(events) {
    return (events || []).slice().sort(function (a, b) {
      var at = Date.parse(a.timestamp || "") - Date.parse(b.timestamp || "");
      return at || (Number(a.sequence) || 0) - (Number(b.sequence) || 0) || String(a.id || "").localeCompare(String(b.id || ""));
    });
  }

  function findRun(runId) {
    return state.runs.find(function (run) { return run.runId === runId; }) || null;
  }

  function touchRun(run) {
    run.updatedAt = nowIso();
    state.runs = [run].concat(state.runs.filter(function (item) { return item.runId !== run.runId; })).slice(0, RECENT_LIMIT);
    if (!state.selectedRunId) state.selectedRunId = run.runId;
    persist();
    notify();
    return run;
  }

  function ensureRun(input) {
    input = input || {};
    var runId = String(input.runId || "").trim();
    var existing = runId && findRun(runId);
    if (existing) return existing;
    var run = {
      runId: runId || makeRunId(input),
      courseId: courseIdFrom(input),
      courseName: courseNameFrom(input),
      startedAt: input.startedAt || nowIso(),
      updatedAt: nowIso(),
      status: "active",
      outcome: "active",
      eventSequence: 0,
      events: [],
      checkpoints: []
    };
    state.runs.unshift(run);
    state.runs = state.runs.slice(0, RECENT_LIMIT);
    if (!input.doNotActivate) state.activeRunId = run.runId;
    if (!state.selectedRunId) state.selectedRunId = run.runId;
    persist();
    return run;
  }

  function startRun(input) {
    var run = ensureRun(Object.assign({}, input || {}, { runId: "" }));
    state.activeRunId = run.runId;
    touchRun(run);
    return run.runId;
  }

  function getOrStartRun(input) {
    input = input || {};
    if (input.runId && findRun(input.runId)) return input.runId;
    if (state.activeRunId) {
      var active = findRun(state.activeRunId);
      if (active && active.status === "active") return active.runId;
    }
    return startRun(input);
  }

  function eventUpdatesStatus(phase, event) {
    var source = cleanSource(event && event.source);
    if (event && event.details && event.details.runFinal) return true;
    if (phase === "fallback") return true;
    if (source === "course-loader" && (phase === "completed" || phase === "failed" || phase === "cancelled" || phase === "superseded")) return true;
    if (source === "manual-fallback" && (phase === "completed" || phase === "cancelled" || phase === "failed")) return true;
    return false;
  }

  function statusForPhase(phase) {
    if (phase === "completed") return "completed";
    if (phase === "failed") return "failed";
    if (phase === "cancelled") return "cancelled";
    if (phase === "superseded") return "superseded";
    if (phase === "fallback") return "fallback";
    return "active";
  }

  function recordEvent(runId, event) {
    event = event || {};
    var explicitRunId = String(runId || event.runId || "").trim();
    var run = explicitRunId ? ensureRun({ runId: explicitRunId, courseId: event.courseId, courseName: event.courseName, doNotActivate: true }) : ensureRun(event);
    var phase = cleanPhase(event.phase);
    var row = {
      id: String(event.id || uid("map-event")),
      runId: run.runId,
      sequence: (Number(run.eventSequence) || 0) + 1,
      courseId: event.courseId || run.courseId,
      courseName: event.courseName || run.courseName,
      timestamp: event.timestamp || nowIso(),
      source: cleanSource(event.source),
      phase: phase,
      event: String(event.event || phase),
      summary: String(event.summary || event.event || prettyLabel(phase)),
      details: sanitize(event.details || {}, { maxDepth: 7 }),
      durationMs: Number.isFinite(Number(event.durationMs)) ? Number(event.durationMs) : undefined,
      confidence: Number.isFinite(Number(event.confidence)) ? Number(event.confidence) : undefined,
      error: event.error ? sanitize(event.error, { maxDepth: 3 }) : undefined
    };
    run.eventSequence = row.sequence;
    run.events.push(row);
    run.events = sortEvents(run.events).slice(-EVENT_LIMIT);
    if (eventUpdatesStatus(phase, row)) {
      run.status = statusForPhase(phase);
      run.outcome = event.outcome || row.summary || run.status;
      if (state.activeRunId === run.runId && phase !== "fallback") state.activeRunId = "";
    }
    touchRun(run);
    return row;
  }

  function attachCheckpoint(runId, checkpoint) {
    var run = ensureRun({ runId: runId || state.activeRunId || "", courseId: checkpoint && checkpoint.courseId, courseName: checkpoint && checkpoint.courseName, doNotActivate: !!runId });
    var stage = String(checkpoint && checkpoint.stage || "checkpoint");
    var entry = Object.assign({}, checkpoint || {}, {
      id: checkpoint && checkpoint.id || uid("map-checkpoint"),
      runId: run.runId,
      stage: stage,
      createdAt: checkpoint && checkpoint.createdAt || nowIso(),
      metadata: sanitize(checkpoint && checkpoint.metadata || {}, { maxDepth: 5 })
    });
    run.checkpoints = [entry].concat((run.checkpoints || []).filter(function (item) { return item.stage !== stage; })).slice(0, CHECKPOINT_STAGES.length);
    recordEvent(run.runId, {
      source: "native-resolver",
      phase: "checkpoint",
      event: stage,
      summary: (checkpoint && checkpoint.title) || prettyLabel(stage) + " produced",
      details: Object.assign({ stage: stage }, entry.metadata || {})
    });
    touchRun(run);
    return entry;
  }

  function finishRun(runId, result) {
    var run = findRun(runId);
    if (!run) return null;
    result = result || {};
    run.status = cleanPhase(result.phase || result.status || "completed") === "failed" ? "failed" : String(result.status || result.outcome || "completed");
    run.outcome = String(result.outcome || result.summary || run.status);
    if (state.activeRunId === run.runId) state.activeRunId = "";
    touchRun(run);
    return run;
  }

  function notify() {
    safe(function () { window.dispatchEvent(new CustomEvent("gd-course-mapping-debug-updated", { detail: { activeRunId: state.activeRunId } })); });
  }

  function getRecentRuns() {
    return state.runs.slice(0, RECENT_LIMIT).map(function (run) { return clone(run); });
  }

  function getRun(runId) {
    var run = findRun(runId || state.selectedRunId || state.activeRunId || (state.runs[0] && state.runs[0].runId));
    return run ? clone(run) : null;
  }

  function getActiveRun() {
    return getRun(state.activeRunId);
  }

  function selectedRunId() {
    return state.selectedRunId || state.activeRunId || (state.runs[0] && state.runs[0].runId) || "";
  }

  function setSelectedRun(runId) {
    if (findRun(runId)) state.selectedRunId = runId;
    renderAdminPanel();
    return false;
  }

  function timeText(timestamp) {
    var date = new Date(timestamp || "");
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function sourceLabel(source) {
    var labels = {
      "course-loader": "Course loader",
      "saved-map": "Saved map",
      automapper: "AutoMapper",
      "native-resolver": "Native resolver",
      "manual-fallback": "Manual fallback",
      persistence: "Persistence",
      unknown: "Unknown"
    };
    return labels[source] || prettyLabel(source);
  }

  function eventPlainLine(event, index) {
    var suffix = [];
    if (Number.isFinite(Number(event.durationMs))) suffix.push(seconds(event.durationMs));
    if (Number.isFinite(Number(event.confidence))) suffix.push(percent(event.confidence));
    return (index + 1) + ". [" + timeText(event.timestamp) + "] " + sourceLabel(event.source) + " - " + String(event.summary || event.event || event.phase) + (suffix.length ? " (" + suffix.join(", ") + ")" : "");
  }

  function detailsLines(details, indent) {
    details = sanitize(details || {}, { maxDepth: 5, arrayLimit: 12 });
    indent = indent || "   ";
    return Object.keys(details).map(function (key) {
      var value = details[key];
      if (value == null || value === "") return "";
      if (typeof value === "object") value = JSON.stringify(value);
      return indent + prettyLabel(key) + ": " + String(value);
    }).filter(Boolean);
  }

  function runHeader(title, run) {
    return [
      title,
      "Course: " + (run.courseName || run.courseId || "Course"),
      "Run ID: " + run.runId,
      "Started: " + (run.startedAt ? new Date(run.startedAt).toLocaleString() : "unknown"),
      "Outcome: " + (run.outcome || run.status || "active")
    ];
  }

  function runForReport(runId) {
    return findRun(runId || selectedRunId()) || state.runs[0] || null;
  }

  function copyFiringList(runId) {
    var run = runForReport(runId);
    if (!run) return "CLARITY CADDY COURSE MAPPING - FIRING LIST\nNo course mapping runs recorded.";
    var lines = runHeader("CLARITY CADDY COURSE MAPPING - FIRING LIST", run);
    sortEvents(run.events).forEach(function (event, index) {
      lines.push(eventPlainLine(event, index));
      detailsLines(event.details).slice(0, 8).forEach(function (line) { lines.push(line); });
    });
    return lines.join("\n");
  }

  function lastEvent(run, source) {
    return sortEvents(run.events).filter(function (event) { return event.source === source; }).pop() || null;
  }

  function copySourceFeedback(runId, source, title) {
    var run = runForReport(runId);
    if (!run) return title + "\nNo run recorded.";
    var events = sortEvents(run.events).filter(function (event) { return event.source === source; });
    var last = events[events.length - 1] || {};
    var lines = runHeader(title, run);
    lines.push("Status: " + (last.summary || last.phase || "Not started"));
    if (Number.isFinite(Number(last.durationMs))) lines.push("Duration: " + seconds(last.durationMs));
    if (Number.isFinite(Number(last.confidence))) lines.push("Confidence: " + percent(last.confidence));
    events.forEach(function (event) {
      lines.push("");
      lines.push("[" + timeText(event.timestamp) + "] " + prettyLabel(event.phase) + " - " + event.summary);
      detailsLines(event.details).forEach(function (line) { lines.push(line); });
      if (event.error && event.error.message) lines.push("   Error: " + event.error.message);
    });
    if (!events.length) lines.push("No " + sourceLabel(source) + " events were recorded for this run.");
    return lines.join("\n");
  }

  function checkpointSummary(run) {
    var lines = ["CHECKPOINTS"];
    CHECKPOINT_STAGES.forEach(function (stage) {
      var checkpoint = (run.checkpoints || []).find(function (item) { return item.stage === stage[0]; });
      if (!checkpoint) {
        lines.push(stage[1] + ": Not produced");
        return;
      }
      lines.push(stage[1] + ": produced at " + (checkpoint.createdAt || "unknown"));
      detailsLines(checkpoint.metadata || {}).forEach(function (line) { lines.push(line); });
    });
    return lines.join("\n");
  }

  function handoffAnalysis(run) {
    var events = sortEvents(run.events);
    var warnings = [];
    var rows = [];
    events.forEach(function (event, index) {
      var nextTool = event.details && event.details.requestedNextTool;
      if (!nextTool) return;
      var requested = cleanSource(nextTool);
      var later = events.slice(index + 1).find(function (candidate) { return candidate.source === requested && candidate.phase === "started"; });
      var label = sourceLabel(event.source) + " -> " + sourceLabel(requested);
      rows.push({ label: label, status: later ? "Observed" : "Missing" });
      if (!later) warnings.push(sourceLabel(event.source) + " requested " + sourceLabel(requested) + ", but no " + sourceLabel(requested) + " start event was recorded within this run.");
    });
    var observed = [];
    events.forEach(function (event) {
      if (observed[observed.length - 1] !== event.source) observed.push(event.source);
    });
    return {
      observed: observed.map(sourceLabel).join(" -> ") || "No mapping events recorded",
      rows: rows,
      warnings: warnings
    };
  }

  function copyFullReport(runId) {
    var run = runForReport(runId);
    if (!run) return "CLARITY CADDY COURSE MAPPING - FULL REPORT\nNo run recorded.";
    var handoffs = handoffAnalysis(run);
    return [
      runHeader("CLARITY CADDY COURSE MAPPING - FULL REPORT", run).join("\n"),
      "",
      "HANDOFFS",
      "Observed: " + handoffs.observed,
      handoffs.rows.length ? handoffs.rows.map(function (row) { return row.label + ": " + row.status; }).join("\n") : "No requested handoffs recorded.",
      handoffs.warnings.length ? "\nHandoff warning:\n" + handoffs.warnings.join("\n") : "",
      "",
      copyFiringList(run.runId),
      "",
      copyAutoMapperFeedback(run.runId),
      "",
      copyResolverFeedback(run.runId),
      "",
      checkpointSummary(run)
    ].filter(Boolean).join("\n");
  }

  function copyAutoMapperFeedback(runId) {
    return copySourceFeedback(runId, "automapper", "CLARITY CADDY - AUTOMAPPER FEEDBACK");
  }

  function copyResolverFeedback(runId) {
    return copySourceFeedback(runId, "native-resolver", "CLARITY CADDY - NATIVE RESOLVER FEEDBACK");
  }

  function copyRawJson(runId) {
    var run = runForReport(runId);
    return JSON.stringify(sanitize(run || {}, { rawJson: true, maxDepth: 9, arrayLimit: 24 }), null, 2);
  }

  function copyCheckpointMetadata(runId, stage) {
    var run = runForReport(runId);
    var checkpoint = run && (run.checkpoints || []).find(function (item) { return item.stage === stage; });
    if (!checkpoint) return "Checkpoint not produced: " + prettyLabel(stage);
    return JSON.stringify(sanitize(Object.assign({}, checkpoint, { imageDataUrl: undefined }), { maxDepth: 6 }), null, 2);
  }

  function copyDebugText(text) {
    text = String(text == null ? "" : text);
    return new Promise(function (resolve) {
      var clipboard = safe(function () { return navigator && navigator.clipboard; }, null);
      if (clipboard && typeof clipboard.writeText === "function") {
        Promise.resolve(clipboard.writeText(text)).then(function () { resolve(true); }).catch(function () {
          resolve(fallbackCopy(text));
        });
        return;
      }
      resolve(fallbackCopy(text));
    });
  }

  function fallbackCopy(text) {
    return safe(function () {
      if (!document || !document.body) return false;
      var textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "readonly");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      textarea.style.top = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      var ok = document.execCommand && document.execCommand("copy");
      document.body.removeChild(textarea);
      return !!ok;
    }, false);
  }

  function roleFromEnvironment() {
    var role = safe(function () { return typeof gdGetAccountPermission === "function" ? gdGetAccountPermission() : ""; }, "") ||
      safe(function () { return document.body && document.body.dataset && (document.body.dataset.gdPermission || document.body.dataset.accountRole || document.body.dataset.clarityAccountRole); }, "") ||
      safe(function () { return window.GolfDaddyAccounts && typeof window.GolfDaddyAccounts.current === "function" && (window.GolfDaddyAccounts.current() || {}).role; }, "");
    return String(role || "").toLowerCase();
  }

  function canViewDebug() {
    var role = roleFromEnvironment();
    return role === "admin" || role === "developer";
  }

  var activeTab = "firing";

  function setAdminTab(tab) {
    activeTab = String(tab || "firing");
    renderAdminPanel();
    return false;
  }

  function latestSourceStatus(run, source) {
    var event = lastEvent(run, source);
    if (!event) return "not recorded";
    return event.summary || event.phase || "recorded";
  }

  function adminSummaryHtml(run) {
    if (!run) return '<div class="gdCoursePlayDebugEmpty">No mapping attempts recorded yet.</div>';
    return [
      metricHtml("Latest run", run.courseName || run.courseId),
      metricHtml("AutoMapper", latestSourceStatus(run, "automapper")),
      metricHtml("Resolver", latestSourceStatus(run, "native-resolver")),
      metricHtml("Outcome", run.outcome || run.status || "active"),
      metricHtml("Events", (run.events || []).length)
    ].join("");
  }

  function metricHtml(label, value) {
    return '<div class="gdCoursePlayDebugMetric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value == null ? "" : value) + '</strong></div>';
  }

  function tabButtonHtml(key, label) {
    return '<button type="button" class="' + (activeTab === key ? "active" : "") + '" onclick="return gdSetCourseMappingDebugTab(\'' + key + '\')">' + escapeHtml(label) + '</button>';
  }

  function runSelectorHtml(runs, current) {
    if (!runs.length) return "";
    return '<select id="gdCourseMappingRunSelect" onchange="return gdSelectCourseMappingDebugRun(this.value)">' +
      runs.map(function (run) {
        var label = (run.status === "active" ? "Active - " : "") + (run.courseName || run.courseId || "Course") + " - " + (run.outcome || run.status || "run");
        return '<option value="' + escapeHtml(run.runId) + '"' + (run.runId === current ? " selected" : "") + '>' + escapeHtml(label) + '</option>';
      }).join("") +
      '</select>';
  }

  function copyButtonsHtml() {
    return [
      '<button type="button" onclick="return gdCopyCourseMappingDebug(\'firing\')">Copy Firing List</button>',
      '<button type="button" onclick="return gdCopyCourseMappingDebug(\'automapper\')">Copy AutoMapper Feedback</button>',
      '<button type="button" onclick="return gdCopyCourseMappingDebug(\'resolver\')">Copy Resolver Feedback</button>',
      '<button type="button" onclick="return gdCopyCourseMappingDebug(\'full\')">Copy Full Mapping Report</button>',
      '<button type="button" onclick="return gdCopyCourseMappingDebug(\'raw\')">Copy Raw JSON</button>'
    ].join("");
  }

  function detailsHtml(value) {
    var text = JSON.stringify(sanitize(value || {}, { maxDepth: 6, arrayLimit: 18 }), null, 2);
    if (text === "{}") return "";
    return '<details><summary>Details</summary><pre>' + escapeHtml(text) + '</pre></details>';
  }

  function firingHtml(run) {
    if (!run) return '<div class="gdCoursePlayDebugEmpty">No firing list yet.</div>';
    var events = sortEvents(run.events || []);
    if (!events.length) return '<div class="gdCoursePlayDebugEmpty">This run has no mapping events yet.</div>';
    return '<div class="gdCourseMappingObserved">Observed: ' + escapeHtml(handoffAnalysis(run).observed) + '</div>' +
      '<div class="gdCoursePlayDebugScroll"><table class="gdCoursePlayDebugTable gdCourseMappingTable"><thead><tr><th>Time</th><th>Source</th><th>Status</th><th>Summary</th><th>Duration</th><th>Confidence</th></tr></thead><tbody>' +
      events.map(function (event) {
        return '<tr><td>' + escapeHtml(timeText(event.timestamp)) + '</td><td>' + escapeHtml(sourceLabel(event.source)) + '</td><td>' + escapeHtml(prettyLabel(event.phase)) + '</td><td>' + escapeHtml(event.summary || event.event || "") + detailsHtml(event.details) + '</td><td>' + escapeHtml(seconds(event.durationMs)) + '</td><td>' + escapeHtml(percent(event.confidence)) + '</td></tr>';
      }).join("") +
      '</tbody></table></div>' + handoffHtml(run);
  }

  function handoffHtml(run) {
    var analysis = handoffAnalysis(run);
    var rows = analysis.rows.length ? analysis.rows.map(function (row) {
      return '<div class="gdCourseMappingHandoffRow"><span>' + escapeHtml(row.label) + '</span><strong class="' + (row.status === "Observed" ? "ok" : "warn") + '">' + escapeHtml(row.status) + '</strong></div>';
    }).join("") : '<div class="gdCoursePlayDebugEmpty">No requested handoffs recorded.</div>';
    var warnings = analysis.warnings.length ? '<div class="gdCourseMappingWarnings">' + analysis.warnings.map(function (warning) { return '<p>Handoff warning: ' + escapeHtml(warning) + '</p>'; }).join("") + '</div>' : "";
    return '<div class="gdCourseMappingSection"><h4>Handoffs</h4>' + rows + warnings + '</div>';
  }

  function sourceEventsHtml(run, source) {
    if (!run) return '<div class="gdCoursePlayDebugEmpty">No run selected.</div>';
    var events = sortEvents(run.events || []).filter(function (event) { return event.source === source; });
    if (!events.length) return '<div class="gdCoursePlayDebugEmpty">No ' + escapeHtml(sourceLabel(source)) + ' events recorded for this run.</div>';
    return '<div class="gdCourseMappingEventList">' + events.map(function (event) {
      return '<div class="gdCourseMappingEvent"><strong>' + escapeHtml(timeText(event.timestamp) + " - " + event.summary) + '</strong><span>' + escapeHtml(prettyLabel(event.phase)) + (Number.isFinite(Number(event.confidence)) ? " - " + escapeHtml(percent(event.confidence)) : "") + '</span>' + detailsHtml(event.details) + '</div>';
    }).join("") + '</div>';
  }

  function checkpointsHtml(run) {
    if (!run) return '<div class="gdCoursePlayDebugEmpty">No run selected.</div>';
    return '<div class="gdCourseMappingCheckpoints">' + CHECKPOINT_STAGES.map(function (stage) {
      var checkpoint = (run.checkpoints || []).find(function (item) { return item.stage === stage[0]; });
      if (!checkpoint) return '<div class="gdCourseMappingCheckpoint missing"><strong>' + escapeHtml(stage[1]) + '</strong><span>Not produced</span></div>';
      var image = checkpoint.imageDataUrl ? '<details><summary>Open</summary><img alt="' + escapeHtml(stage[1]) + ' checkpoint" src="' + escapeHtml(checkpoint.imageDataUrl) + '"></details>' : '<div class="gdCoursePlayDebugEmpty">Image not retained after refresh.</div>';
      return '<div class="gdCourseMappingCheckpoint"><div><strong>' + escapeHtml(stage[1]) + '</strong><span>' + escapeHtml(timeText(checkpoint.createdAt)) + ' - ' + escapeHtml(checkpoint.runId || run.runId) + '</span></div>' + image + '<button type="button" onclick="return gdCopyCourseMappingDebug(\'checkpoint:' + escapeHtml(stage[0]) + '\')">Copy Metadata</button></div>';
    }).join("") + '</div>';
  }

  function rawEvidenceHtml(run) {
    if (!run) return '<div class="gdCoursePlayDebugEmpty">No run selected.</div>';
    return '<pre class="gdCourseMappingRaw">' + escapeHtml(copyRawJson(run.runId)) + '</pre>';
  }

  function panelBodyHtml(run) {
    if (activeTab === "automapper") return sourceEventsHtml(run, "automapper");
    if (activeTab === "resolver") return sourceEventsHtml(run, "native-resolver");
    if (activeTab === "checkpoints") return checkpointsHtml(run);
    if (activeTab === "raw") return rawEvidenceHtml(run);
    return firingHtml(run);
  }

  function renderAdminPanel() {
    var root = safe(function () { return document.getElementById("gdCourseMappingDebugPanel"); }, null);
    if (!root) return false;
    var allowed = canViewDebug();
    root.hidden = !allowed;
    safe(function () { document.body.classList.toggle("gdCourseMappingDebugOn", allowed); });
    if (!allowed) {
      root.innerHTML = "";
      return false;
    }
    var runs = getRecentRuns();
    var currentRunId = selectedRunId();
    var run = getRun(currentRunId) || runs[0] || null;
    if (run) currentRunId = run.runId;
    root.innerHTML = [
      '<div class="gdCoursePlayDebugHead"><div><h3>Course Mapping Debug</h3><p>Actual mapping-attempt events from saved maps, AutoMapper, native resolver, and manual fallback.</p></div><div class="gdCoursePlayDebugActions"><button type="button" onclick="return gdRenderCourseMappingDebug()">Refresh</button></div></div>',
      '<div class="gdCoursePlayDebugSummary">' + adminSummaryHtml(run) + '</div>',
      '<div class="gdCourseMappingToolbar">' + runSelectorHtml(runs, currentRunId) + '<div class="gdCoursePlayDebugActions">' + copyButtonsHtml() + '</div><span id="gdCourseMappingCopyStatus"></span></div>',
      '<div class="gdCourseMappingTabs">' + [
        tabButtonHtml("firing", "Firing List"),
        tabButtonHtml("automapper", "AutoMapper"),
        tabButtonHtml("resolver", "Native Resolver"),
        tabButtonHtml("checkpoints", "Checkpoints"),
        tabButtonHtml("raw", "Raw Evidence")
      ].join("") + '</div>',
      '<div id="gdCourseMappingDebugBody">' + panelBodyHtml(run) + '</div>'
    ].join("");
    return false;
  }

  function statusText(ok) {
    var el = safe(function () { return document.getElementById("gdCourseMappingCopyStatus"); }, null);
    if (el) {
      el.textContent = ok ? "Copied" : "Copy failed";
      el.classList.toggle("ok", !!ok);
      el.classList.toggle("bad", !ok);
      setTimeout(function () {
        if (el) {
          el.textContent = "";
          el.classList.remove("ok", "bad");
        }
      }, 1800);
    }
    return false;
  }

  function copyFromPanel(kind) {
    var runId = selectedRunId();
    var text = "";
    kind = String(kind || "firing");
    if (kind === "automapper") text = copyAutoMapperFeedback(runId);
    else if (kind === "resolver") text = copyResolverFeedback(runId);
    else if (kind === "full") text = copyFullReport(runId);
    else if (kind === "raw") text = copyRawJson(runId);
    else if (kind.indexOf("checkpoint:") === 0) text = copyCheckpointMetadata(runId, kind.split(":")[1]);
    else text = copyFiringList(runId);
    copyDebugText(text).then(statusText);
    return false;
  }

  function openCheckpoint(runId, stage) {
    var run = findRun(runId || selectedRunId());
    var checkpoint = run && (run.checkpoints || []).find(function (item) { return item.stage === stage; });
    if (!checkpoint || !checkpoint.imageDataUrl) return false;
    var win = safe(function () { return window.open("", "_blank", "noopener,noreferrer"); }, null);
    if (win && win.document) {
      win.document.write('<!doctype html><title>' + escapeHtml(stage) + '</title><img alt="' + escapeHtml(stage) + '" src="' + escapeHtml(checkpoint.imageDataUrl) + '" style="max-width:100%;height:auto;background:#07110c">');
      win.document.close();
    }
    return false;
  }

  function resetForTests() {
    state.activeRunId = "";
    state.selectedRunId = "";
    state.runs = [];
    safe(function () { sessionStorage.removeItem(STORE_KEY); });
    mirror();
  }

  var api = {
    __version: VERSION,
    startRun: startRun,
    getOrStartRun: getOrStartRun,
    recordEvent: recordEvent,
    attachCheckpoint: attachCheckpoint,
    finishRun: finishRun,
    getActiveRun: getActiveRun,
    getRecentRuns: getRecentRuns,
    getRun: getRun,
    setSelectedRun: setSelectedRun,
    copyFiringList: copyFiringList,
    copyAutoMapperFeedback: copyAutoMapperFeedback,
    copyResolverFeedback: copyResolverFeedback,
    copyFullReport: copyFullReport,
    copyRawJson: copyRawJson,
    copyDebugText: copyDebugText,
    renderAdminPanel: renderAdminPanel,
    canViewDebug: canViewDebug,
    _test: {
      reset: resetForTests,
      sanitize: sanitize,
      handoffAnalysis: handoffAnalysis,
      fallbackCopy: fallbackCopy,
      canViewDebug: canViewDebug
    }
  };

  window.GDCourseMappingDebug = api;
  window.gdRenderCourseMappingDebug = renderAdminPanel;
  window.gdSetCourseMappingDebugTab = setAdminTab;
  window.gdSelectCourseMappingDebugRun = setSelectedRun;
  window.gdCopyCourseMappingDebug = copyFromPanel;
  window.gdOpenCourseMappingCheckpoint = openCheckpoint;
  restore();
  mirror();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderAdminPanel);
  } else {
    setTimeout(renderAdminPanel, 0);
  }
  window.addEventListener("gd-course-mapping-debug-updated", function () {
    if (safe(function () { return document.getElementById("developerPanel").classList.contains("open"); }, false)) renderAdminPanel();
  });
})();
