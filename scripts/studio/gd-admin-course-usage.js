/* Clarity Studio - Course usage: which course maps get downloaded, updated and played, how
   each open went, and from where.
   STUDIO ONLY (data-gd-surface="studio"), loaded after scripts/studio/gd-admin-course-db.js
   for its gdAdminCourseDbAccessToken.

   Reads GET /api/course-usage?days=N (functions/course-usage.mjs, admin-verified), which
   returns course_map_usage_report: rows per course x event x origin x map type x outcome x
   version, daily totals for the trend, and per-course names and current version labels.
   The counts are anonymous daily tallies - nothing here can say who played. Read-only. */
(function () {
  "use strict";

  var API = "/api/course-usage";
  var PHONE_ORIGINS = [["ios", "iOS"], ["android", "Android"], ["web", "Web"]];
  /* "watch" is what app builds from before the Apple / Garmin split still send. */
  var WATCH_ORIGINS = [["apple-watch", "Apple Watch"], ["garmin", "Garmin"], ["watch", "Watch (older app)"]];
  var RANGES = [["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["0", "All time"]];
  var OUTCOMES = {
    cached: "From the device",
    ready: "Ready straight away",
    prepared: "Prepared while waiting",
    "not-mapped": "No map",
    failed: "Mapping failed",
    timeout: "Timed out waiting",
    unreachable: "Couldn't reach server",
    "signup-required": "Guest asked to sign up",
    "server-busy": "Server busy",
    "account-error": "Account check failed",
    "": "Not recorded (older app)"
  };
  var BAD_OUTCOMES = { "not-mapped": true, failed: true, timeout: true, unreachable: true, "signup-required": true, "server-busy": true, "account-error": true };
  var WATCH_FAILURES = { "no-package": "No watch map", "report-unavailable": "Watch map unavailable", "assets-failed": "Hole images failed", error: "Delivery error" };
  var MAP_TYPES = [["full", "Full map"], ["lite", "Lite map"], ["live", "Live map only"], ["", "Not recorded"]];
  var SLOW_WAIT_MS = 45000;

  var state = { status: "idle", data: null, error: "", range: "30", query: "", checkedAt: "" };
  /* Bodies besides the Admin Settings card's own: the Studio Course Usage page mounts one. */
  var extraRoots = [];

  function esc(v) { return typeof gdEscapeHTML === "function" ? gdEscapeHTML(v) : String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }
  function token() { return typeof gdAdminCourseDbAccessToken === "function" ? gdAdminCourseDbAccessToken() : Promise.resolve(""); }
  function plural(count, word) { return count + " " + word + (count === 1 ? "" : "s"); }
  function n(v) { var x = Number(v); return Number.isFinite(x) ? x : 0; }
  function seconds(ms) { return ms >= 60000 ? Math.round(ms / 6000) / 10 + " min" : Math.round(ms / 1000) + "s"; }
  function percent(part, whole) { return whole ? Math.round(100 * part / whole) + "%" : "-"; }
  function isWatch(origin) { return origin === "apple-watch" || origin === "garmin" || origin === "watch"; }

  function load() {
    state.status = "loading";
    render();
    return token().then(function (t) {
      if (!t) throw new Error("Sign in again - no session token");
      return fetch(API + "?days=" + encodeURIComponent(state.range), { headers: { Accept: "application/json", Authorization: "Bearer " + t }, cache: "no-store" });
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) throw new Error((data && (data.detail || data.error)) || ("HTTP " + res.status));
        return data;
      });
    }).then(function (data) {
      state.status = "ready";
      state.data = data || {};
      state.checkedAt = data && data.checkedAt || "";
    }, function (error) {
      state.status = "error";
      state.error = String(error && error.message || error);
    }).then(render);
  }

  function tally(map, key, count) { map[key] = (map[key] || 0) + count; }

  /* Report rows are per course x event x origin x map type x outcome x version; fold them
     into one entry per course, plus the same totals across every course. */
  function summarise(data) {
    var meta = {};
    (data.courses || []).forEach(function (c) { meta[c.courseId] = c; });
    var courses = {};
    var totals = blank("", "", null);
    function blank(id, name, info) {
      return {
        id: id, name: name, inDatabase: info ? info.inDatabase : true, currentVersion: info ? info.currentVersion : null,
        plays: 0, downloads: 0, updates: 0, watchDeliveries: 0, watchFailures: 0,
        playsBy: {}, downloadsBy: {}, watchBy: {}, watchFailuresBy: {}, mapTypes: {}, outcomes: {},
        waitMs: 0, waitedPlays: 0, versionedPlays: 0, latestPlays: 0, versions: {}, countries: {}, lastSeen: ""
      };
    }
    (data.rows || []).forEach(function (row) {
      var id = String(row.course_id || "");
      if (!id) return;
      var info = meta[id];
      var c = courses[id] || (courses[id] = blank(id, info && info.courseName || id, info));
      [c, totals].forEach(function (e) {
        var count = n(row.count);
        if (row.event === "play") {
          e.plays += count;
          tally(e.playsBy, row.origin, count);
          tally(e.mapTypes, row.map_type || "", count);
          tally(e.outcomes, row.outcome || "", count);
          if (n(row.wait_ms) > 0) { e.waitMs += n(row.wait_ms); e.waitedPlays += count; }
          if (row.version) {
            e.versionedPlays += count;
            tally(e.versions, row.version, count);
            if (info && info.currentVersion && row.version === info.currentVersion) e.latestPlays += count;
          }
        } else if (row.event === "download" && isWatch(row.origin)) {
          e.watchDeliveries += count;
          tally(e.watchBy, row.origin, count);
        } else if (row.event === "download") {
          e.downloads += count;
          tally(e.downloadsBy, row.origin, count);
        } else if (row.event === "update") {
          e.updates += count;
        } else if (row.event === "delivery-failed") {
          e.watchFailures += count;
          tally(e.watchFailuresBy, row.outcome || "error", count);
        }
        String(row.countries || "").split(",").forEach(function (code) { code = code.trim(); if (code) e.countries[code] = true; });
        if (String(row.last_seen || "") > e.lastSeen) e.lastSeen = String(row.last_seen || "");
      });
    });
    var list = Object.keys(courses).map(function (k) { return courses[k]; })
      .sort(function (a, b) { return b.plays - a.plays || b.downloads - a.downloads || a.name.localeCompare(b.name); });
    return { courses: list, totals: totals };
  }

  /* Why a course belongs on the problem list, worst first. Empty means it is fine. */
  function problemsOf(c) {
    var out = [];
    if (!c.inDatabase && c.plays) out.push({ weight: c.plays, text: "Not in the Course Database" });
    Object.keys(c.outcomes).forEach(function (o) {
      if (BAD_OUTCOMES[o]) out.push({ weight: c.outcomes[o], text: OUTCOMES[o] + " ×" + c.outcomes[o] });
    });
    if (c.mapTypes.live) out.push({ weight: c.mapTypes.live, text: plural(c.mapTypes.live, "round") + " on the live map only" });
    if (c.waitedPlays && c.waitMs / c.waitedPlays > SLOW_WAIT_MS) out.push({ weight: c.waitedPlays, text: "Slow to open (avg " + seconds(c.waitMs / c.waitedPlays) + ")" });
    Object.keys(c.watchFailuresBy).forEach(function (o) {
      out.push({ weight: c.watchFailuresBy[o], text: (WATCH_FAILURES[o] || o) + " ×" + c.watchFailuresBy[o] });
    });
    return out.sort(function (a, b) { return b.weight - a.weight; });
  }

  function metric(label, value, hint) {
    return '<div class="gdAdminDatabaseMetric"' + (hint ? ' title="' + esc(hint) + '"' : "") + "><span>" + esc(label) + "</span><strong>" + esc(value) + "</strong></div>";
  }

  function breakdown(pairs, counts) {
    return pairs.map(function (pair) {
      var v = counts[pair[0]] || 0;
      return v ? pair[1] + " " + v : "";
    }).filter(Boolean).join(" · ") || "-";
  }

  /* One stacked bar: each part's share of the whole, labelled underneath. */
  function shareBar(title, parts, total) {
    if (!total) return "";
    var segs = parts.filter(function (p) { return p.count; });
    return '<div class="gdAdminUsageShare"><div class="gdAdminUsageShareHead"><b>' + esc(title) + "</b><span>" + esc(plural(total, "round")) + "</span></div>" +
      '<div class="gdAdminUsageShareBar">' + segs.map(function (p) {
        return '<i class="' + p.tone + '" style="width:' + (100 * p.count / total).toFixed(2) + '%" title="' + esc(p.label + ": " + p.count) + '"></i>';
      }).join("") + "</div>" +
      '<div class="gdAdminUsageShareKey">' + segs.map(function (p) {
        return '<span><i class="' + p.tone + '"></i>' + esc(p.label) + " " + p.count + " (" + percent(p.count, total) + ")</span>";
      }).join("") + "</div></div>";
  }

  function outcomeTone(o) {
    if (o === "cached") return "good";
    if (o === "ready") return "fine";
    if (o === "prepared") return "ok";
    if (o === "") return "muted";
    return "bad";
  }

  /* Rounds and phone downloads per day, as two lines. Days with nothing are zeros, not
     gaps, so a quiet week reads as quiet rather than missing. */
  function trend(daily) {
    var byDay = {};
    daily.forEach(function (d) {
      var day = String(d.day || "").slice(0, 10);
      if (!day) return;
      var e = byDay[day] || (byDay[day] = { plays: 0, downloads: 0 });
      if (d.event === "play") e.plays += n(d.count);
      else if (d.event === "download" && !isWatch(d.origin)) e.downloads += n(d.count);
    });
    var known = Object.keys(byDay).sort();
    var today = new Date();
    var span = state.range === "0" ? 0 : Number(state.range);
    var start = span ? new Date(today.getTime() - (span - 1) * 86400000) : (known.length ? new Date(known[0] + "T00:00:00Z") : today);
    var days = [];
    for (var t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()); t <= today.getTime(); t += 86400000) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    if (days.length < 2) return "";
    var max = 1;
    days.forEach(function (day) { var e = byDay[day]; if (e) max = Math.max(max, e.plays, e.downloads); });
    var W = 600, H = 110, pad = 6;
    function line(field) {
      return days.map(function (day, i) {
        var v = byDay[day] ? byDay[day][field] : 0;
        var x = pad + (W - 2 * pad) * i / (days.length - 1);
        var y = H - pad - (H - 2 * pad) * v / max;
        return x.toFixed(1) + "," + y.toFixed(1);
      }).join(" ");
    }
    return '<div class="gdAdminUsageTrend"><div class="gdAdminUsageShareHead"><b>Per day</b><span>' +
      '<i class="plays"></i>Rounds <i class="downloads"></i>Downloads · peak ' + max + "</span></div>" +
      '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="Rounds and downloads per day">' +
      '<polyline class="downloads" points="' + line("downloads") + '"/><polyline class="plays" points="' + line("plays") + '"/></svg>' +
      '<div class="gdAdminUsageTrendAxis"><span>' + esc(days[0]) + "</span><span>" + esc(days[days.length - 1]) + "</span></div></div>";
  }

  function courseRow(c) {
    var countries = Object.keys(c.countries).sort().join(", ") || "Country unknown";
    var latest = c.currentVersion
      ? (c.versionedPlays ? c.latestPlays + " of " + c.versionedPlays + " on latest (" + c.currentVersion + ")" : "Latest " + c.currentVersion)
      : "No version yet";
    var others = Object.keys(c.versions).filter(function (v) { return v !== c.currentVersion; }).sort();
    var open = c.inDatabase
      ? '<button type="button" class="gdAdminUsageLink" onclick="return gdAdminCourseUsageOpenCourse(\'' + esc(c.id) + '\')">Open in Course Database</button>'
      : '<span class="gdAdminUsageTag">Not in Course Database</span>';
    var watch = c.watchDeliveries || c.watchFailures
      ? "Watch " + breakdown(WATCH_ORIGINS, c.watchBy) + (c.watchFailures ? " · " + c.watchFailures + " failed" : "")
      : "";
    return '<div class="gdAdminUsageRow">' +
      '<div class="gdAdminUsageName"><strong>' + esc(c.name) + "</strong><span>" + esc(countries) + (c.lastSeen ? " · last " + esc(c.lastSeen) : "") + "</span>" + open + "</div>" +
      '<div class="gdAdminUsageNums"><b>' + plural(c.plays, "round") + "</b><span>" + esc(breakdown(PHONE_ORIGINS, c.playsBy)) + "</span><span>" + esc(breakdown(MAP_TYPES, c.mapTypes)) + "</span></div>" +
      '<div class="gdAdminUsageNums"><b>' + plural(c.downloads, "download") + (c.updates ? " · " + plural(c.updates, "update") : "") + "</b><span>" + esc(breakdown(PHONE_ORIGINS, c.downloadsBy)) + "</span>" + (watch ? "<span>" + esc(watch) + "</span>" : "") + "</div>" +
      '<div class="gdAdminUsageNums"><b>' + esc(latest) + "</b><span>" + esc(others.length ? "Also played: " + others.join(", ") : (c.waitedPlays ? "Avg wait " + seconds(c.waitMs / c.waitedPlays) : "")) + "</span></div>" +
      "</div>";
  }

  function matches(c) {
    var q = state.query.trim().toLowerCase();
    return !q || c.name.toLowerCase().indexOf(q) >= 0 || c.id.indexOf(q) >= 0;
  }

  function listMarkup(summary) {
    var courses = summary.courses.filter(matches);
    if (!summary.courses.length) return '<p class="gdAdminUsageNote">No course usage recorded ' + (state.range === "0" ? "yet" : "in the last " + state.range + " days") + ".</p>";
    if (!courses.length) return '<p class="gdAdminUsageNote">No courses match "' + esc(state.query) + '".</p>';
    return courses.map(courseRow).join("");
  }

  function problemMarkup(summary) {
    var flagged = summary.courses.filter(matches).map(function (c) { return { course: c, problems: problemsOf(c) }; })
      .filter(function (e) { return e.problems.length; })
      .sort(function (a, b) { return b.problems[0].weight - a.problems[0].weight; });
    if (!flagged.length) return '<p class="gdAdminUsageNote">Nothing went wrong opening a course in this range.</p>';
    return flagged.map(function (e) {
      return '<div class="gdAdminUsageProblem"><strong>' + esc(e.course.name) + "</strong><span>" +
        e.problems.map(function (p) { return esc(p.text); }).join(" · ") + "</span></div>";
    }).join("");
  }

  function render() {
    extraRoots = extraRoots.filter(function (el) { return el.isConnected; });
    var roots = [document.getElementById("gdAdminCourseUsageBody")].concat(extraRoots).filter(Boolean);
    roots.forEach(renderInto);
  }

  function renderInto(root) {
    var rangeBtns = '<div class="gdAdminUsageRange">' + RANGES.map(function (r) {
      return '<button type="button" aria-pressed="' + (state.range === r[0]) + '" onclick="return gdAdminCourseUsageRange(\'' + r[0] + '\')">' + r[1] + "</button>";
    }).join("") + "</div>";
    if (state.status === "idle" || state.status === "loading") { root.innerHTML = rangeBtns + '<p class="gdAdminUsageNote">Loading…</p>'; return; }
    if (state.status === "error") { root.innerHTML = rangeBtns + '<p class="gdAdminUsageNote">Could not load usage: ' + esc(state.error) + "</p>"; return; }

    var summary = summarise(state.data);
    var t = summary.totals;
    var failedOpens = Object.keys(t.outcomes).reduce(function (sum, o) { return sum + (BAD_OUTCOMES[o] ? t.outcomes[o] : 0); }, 0);
    var metrics = '<div class="gdAdminDatabaseSummary">' + [
      metric("Courses used", summary.courses.length),
      metric("Rounds", t.plays),
      metric("Downloads", t.downloads),
      metric("Updates", t.updates, "A newer map version replaced a device's copy"),
      metric("Watch deliveries", t.watchDeliveries + (t.watchFailures ? " · " + t.watchFailures + " failed" : "")),
      metric("Opens that went wrong", failedOpens + " (" + percent(failedOpens, t.plays) + ")"),
      metric("Avg wait for a map", t.waitedPlays ? seconds(t.waitMs / t.waitedPlays) : "-", "Rounds that had to fetch the map from the server"),
      metric("Rounds on latest version", t.versionedPlays ? percent(t.latestPlays, t.versionedPlays) : "-", "Of rounds whose version was recorded")
    ].join("") + "</div>" +
      '<p class="gdAdminUsageNote">Rounds: ' + esc(breakdown(PHONE_ORIGINS, t.playsBy)) + " · Downloads: " + esc(breakdown(PHONE_ORIGINS, t.downloadsBy)) +
      (t.watchDeliveries ? " · Watch: " + esc(breakdown(WATCH_ORIGINS, t.watchBy)) : "") + "</p>";

    var outcomeParts = Object.keys(OUTCOMES).map(function (o) { return { label: OUTCOMES[o], count: t.outcomes[o] || 0, tone: outcomeTone(o) }; });
    var mapParts = MAP_TYPES.map(function (p) { return { label: p[1], count: t.mapTypes[p[0]] || 0, tone: p[0] === "full" ? "good" : p[0] === "lite" ? "ok" : p[0] === "live" ? "bad" : "muted" }; });

    root.innerHTML = rangeBtns + metrics +
      '<div class="gdAdminUsageCharts">' + trend(state.data.daily || []) +
      shareBar("How rounds opened", outcomeParts, t.plays) +
      shareBar("Map played on", mapParts, t.plays) + "</div>" +
      '<input class="gdAdminUsageSearch" type="search" placeholder="Search courses" value="' + esc(state.query) + '" oninput="gdAdminCourseUsageSearch(this.value)">' +
      '<h4 class="gdAdminUsageHeading">Problem courses</h4><div class="gdAdminUsageList" data-gd-usage="problems">' + problemMarkup(summary) + "</div>" +
      '<h4 class="gdAdminUsageHeading">All courses</h4><div class="gdAdminUsageList" data-gd-usage="list">' + listMarkup(summary) + "</div>";
  }

  /* Typing only redraws the two lists, so the search box keeps its focus. */
  window.gdAdminCourseUsageSearch = function (value) {
    state.query = String(value || "");
    if (state.status !== "ready") return;
    var summary = summarise(state.data);
    extraRoots.concat([document.getElementById("gdAdminCourseUsageBody")]).filter(Boolean).forEach(function (root) {
      var list = root.querySelector('[data-gd-usage="list"]');
      var problems = root.querySelector('[data-gd-usage="problems"]');
      if (list) list.innerHTML = listMarkup(summary);
      if (problems) problems.innerHTML = problemMarkup(summary);
    });
  };
  window.gdAdminCourseUsageOpenCourse = function (courseId) {
    if (window.GDStudioRouter && typeof window.GDStudioRouter.go === "function") window.GDStudioRouter.go("course-database");
    if (typeof gdAdminCourseDbOpen === "function") gdAdminCourseDbOpen(courseId, "overview");
    return false;
  };
  window.gdAdminCourseUsageRange = function (range) {
    var next = RANGES.some(function (r) { return r[0] === String(range); }) ? String(range) : "30";
    if (next === state.range && state.status === "ready") return false;
    state.range = next;
    load();
    return false;
  };
  window.gdRefreshAdminCourseUsage = function () { load(); return false; };
  /* Render into another body too (the Studio Course Usage page), fetching on first use. */
  window.gdMountAdminCourseUsage = function (el) {
    if (el && extraRoots.indexOf(el) < 0) extraRoots.push(el);
    if (state.status === "idle") load(); else render();
  };
  /* Called when Admin Settings opens: fetch once, then only on Refresh. */
  window.gdRenderAdminCourseUsage = function () {
    if (state.status === "idle") load(); else render();
  };
})();
