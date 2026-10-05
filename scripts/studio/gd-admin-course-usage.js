/* Clarity Studio - Course usage: which course maps get downloaded and played, and from where.
   STUDIO ONLY (data-gd-surface="studio"), loaded after scripts/studio/gd-admin-course-db.js
   for its gdAdminCourseDbAccessToken.

   Reads GET /api/course-usage (functions/course-usage.mjs, admin-verified), which returns
   course_map_usage_summary: one row per course per origin (web / ios / android / watch).
   The counts are anonymous daily tallies - nothing here can say who played. Read-only. */
(function () {
  "use strict";

  var API = "/api/course-usage";
  var ORIGINS = [["ios", "iOS"], ["android", "Android"], ["web", "Web"], ["watch", "Watch"]];
  var state = { status: "idle", rows: [], error: "", range: "30d", checkedAt: "" };
  /* Bodies besides the Admin Settings card's own: the Studio Course Usage page mounts one. */
  var extraRoots = [];

  function esc(v) { return typeof gdEscapeHTML === "function" ? gdEscapeHTML(v) : String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }
  function token() { return typeof gdAdminCourseDbAccessToken === "function" ? gdAdminCourseDbAccessToken() : Promise.resolve(""); }
  function plural(count, word) { return count + " " + word + (count === 1 ? "" : "s"); }
  function n(v) { var x = Number(v); return Number.isFinite(x) ? x : 0; }

  function load() {
    state.status = "loading";
    render();
    return token().then(function (t) {
      if (!t) throw new Error("Sign in again - no session token");
      return fetch(API, { headers: { Accept: "application/json", Authorization: "Bearer " + t }, cache: "no-store" });
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) throw new Error((data && (data.detail || data.error)) || ("HTTP " + res.status));
        return data;
      });
    }).then(function (data) {
      state.status = "ready";
      state.rows = data && Array.isArray(data.rows) ? data.rows : [];
      state.checkedAt = data && data.checkedAt || "";
    }, function (error) {
      state.status = "error";
      state.error = String(error && error.message || error);
    }).then(render);
  }

  /* Summary rows are per course per origin; fold them into one entry per course. */
  function byCourse(rows, range) {
    var plays = range === "30d" ? "plays_30d" : "plays";
    var downloads = range === "30d" ? "downloads_30d" : "downloads";
    var map = {};
    rows.forEach(function (row) {
      var id = String(row.course_id || "");
      if (!id) return;
      var entry = map[id] || (map[id] = { id: id, name: row.course_name || id, plays: 0, downloads: 0, origins: {}, countries: {}, lastSeen: "" });
      var p = n(row[plays]), d = n(row[downloads]);
      entry.plays += p;
      entry.downloads += d;
      var o = entry.origins[row.origin] || (entry.origins[row.origin] = { plays: 0, downloads: 0 });
      o.plays += p;
      o.downloads += d;
      String(row.countries || "").split(",").forEach(function (c) { c = c.trim(); if (c) entry.countries[c] = true; });
      if (String(row.last_seen || "") > entry.lastSeen) entry.lastSeen = String(row.last_seen || "");
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .filter(function (e) { return e.plays || e.downloads; })
      .sort(function (a, b) { return b.plays - a.plays || b.downloads - a.downloads || a.name.localeCompare(b.name); });
  }

  function metric(label, value) {
    return '<div class="gdAdminDatabaseMetric"><span>' + esc(label) + "</span><strong>" + esc(value) + "</strong></div>";
  }

  function originLine(origins, field) {
    return ORIGINS.map(function (pair) {
      var v = origins[pair[0]] ? origins[pair[0]][field] : 0;
      return v ? pair[1] + " " + v : "";
    }).filter(Boolean).join(" · ") || "-";
  }

  function render() {
    extraRoots = extraRoots.filter(function (el) { return el.isConnected; });
    var roots = [document.getElementById("gdAdminCourseUsageBody")].concat(extraRoots).filter(Boolean);
    roots.forEach(renderInto);
  }

  function renderInto(root) {
    var rangeBtns = '<div class="gdAdminUsageRange">' + [["30d", "Last 30 days"], ["all", "All time"]].map(function (r) {
      return '<button type="button" aria-pressed="' + (state.range === r[0]) + '" onclick="return gdAdminCourseUsageRange(\'' + r[0] + '\')">' + r[1] + "</button>";
    }).join("") + "</div>";
    if (state.status === "idle" || state.status === "loading") { root.innerHTML = rangeBtns + '<p class="gdAdminUsageNote">Loading…</p>'; return; }
    if (state.status === "error") { root.innerHTML = rangeBtns + '<p class="gdAdminUsageNote">Could not load usage: ' + esc(state.error) + "</p>"; return; }

    var courses = byCourse(state.rows, state.range);
    var totals = { plays: 0, downloads: 0, origins: {} };
    courses.forEach(function (c) {
      totals.plays += c.plays;
      totals.downloads += c.downloads;
      Object.keys(c.origins).forEach(function (o) {
        var t = totals.origins[o] || (totals.origins[o] = { plays: 0, downloads: 0 });
        t.plays += c.origins[o].plays;
        t.downloads += c.origins[o].downloads;
      });
    });
    var summary = '<div class="gdAdminDatabaseSummary">' + [
      metric("Courses used", courses.length),
      metric("Rounds", totals.plays),
      metric("Downloads", totals.downloads)
    ].concat(ORIGINS.map(function (pair) {
      var t = totals.origins[pair[0]] || { plays: 0, downloads: 0 };
      return metric(pair[1], plural(t.plays, "round") + " · " + t.downloads + " dl");
    })).join("") + "</div>";

    var list = courses.length ? courses.map(function (c) {
      return '<div class="gdAdminUsageRow"><div class="gdAdminUsageName"><strong>' + esc(c.name) + "</strong><span>" +
        esc(Object.keys(c.countries).sort().join(", ") || "Country unknown") + (c.lastSeen ? " · last " + esc(c.lastSeen) : "") + "</span></div>" +
        '<div class="gdAdminUsageNums"><b>' + plural(c.plays, "round") + "</b><span>" + esc(originLine(c.origins, "plays")) + "</span></div>" +
        '<div class="gdAdminUsageNums"><b>' + plural(c.downloads, "download") + "</b><span>" + esc(originLine(c.origins, "downloads")) + "</span></div></div>";
    }).join("") : '<p class="gdAdminUsageNote">No course usage recorded ' + (state.range === "30d" ? "in the last 30 days" : "yet") + ".</p>";

    root.innerHTML = rangeBtns + summary + '<div class="gdAdminUsageList">' + list + "</div>";
  }

  window.gdAdminCourseUsageRange = function (range) {
    state.range = range === "all" ? "all" : "30d";
    render();
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
