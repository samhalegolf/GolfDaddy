/* Studio > Courses > Regional Bulk Scan.
 *
 * Map a whole area in one go. The centre comes from the REAL course picker (pick-only mode,
 * through gd-studio-course-pick.js), the same way Map Viewport and Mapping Overlay establish a
 * course - pick any course in the area and the region is drawn around it. The distance sets
 * how far out to look.
 *
 * The list is two steps. This page asks Overpass for the golf courses in the region itself,
 * from the operator's browser: a 25-50 km query is slow, and asked from a Netlify function it
 * shares Overpass's per-IP allowance with every other function and timed out every time. The
 * answer then goes to POST /api/course-mapper-jobs kind "region_list" (admin only), which
 * merges it with the courses we already hold exactly as the picker's nearby list is. Courses we hold are counted and listed but cannot be ticked - this page only adds,
 * it never remaps. Everything else starts ticked; untick what you do not want.
 *
 * "Scan" posts the ticked courses as kind "region_scan", in batches the server accepts. They
 * are queued as background mapping jobs - the nearby-prefetch kind - so the worker maps them
 * one at a time in idle moments and never puts a player behind them. Progress per course is
 * on Course Database and Mapping Diagnostics like any other scan. */
(function () {
  "use strict";

  var API = "/api/course-mapper-jobs";
  var OVERPASS_URL = "https://overpass-api.de/api/interpreter";
  var OVERPASS_TIMEOUT_S = 90;
  var BATCH = 25;
  var DISTANCES_KM = [5, 10, 25, 50];

  /* Survives leaving and coming back to the page, like Map Viewport's course. */
  var session = { centre: null, radiusKm: 25 };

  var SKIP_TEXT = {
    "already-mapped": "already mapped nearby",
    "already-held": "name already in the database",
    "already-queued": "already being scanned",
    "no-location": "no location",
    "insert-failed": "could not queue"
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

  /* A box rather than Overpass's around(): far cheaper for it to answer over tens of km. The
     server trims the corners back to the radius. Same two tags as the picker's nearby query. */
  function overpassQuery(centre, radiusKm) {
    var dLat = radiusKm * 1000 / 111320;
    var dLng = radiusKm * 1000 / (111320 * Math.max(0.05, Math.cos(centre.lat * Math.PI / 180)));
    var box = "(" + [centre.lat - dLat, centre.lng - dLng, centre.lat + dLat, centre.lng + dLng].map(function (n) { return n.toFixed(5); }).join(",") + ")";
    var parts = [["way", "leisure", "golf_course"], ["relation", "leisure", "golf_course"], ["way", "golf", "course"], ["relation", "golf", "course"]]
      .map(function (p) { return p[0] + '["' + p[1] + '"="' + p[2] + '"]' + box + ";"; });
    return "[out:json][timeout:" + OVERPASS_TIMEOUT_S + "];(" + parts.join("") + ");out tags center;";
  }

  /* Only what the server reads, so a 50 km answer stays small on its way back up. */
  function fetchRegionElements(centre, radiusKm) {
    var abort = new AbortController();
    var timer = setTimeout(function () { abort.abort(); }, (OVERPASS_TIMEOUT_S + 10) * 1000);
    return fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(overpassQuery(centre, radiusKm)),
      signal: abort.signal
    }).then(function (res) {
      if (!res.ok) throw new Error("OpenStreetMap answered " + res.status + (res.status === 429 ? " (too many requests - wait a minute)" : ""));
      return res.json();
    }).then(function (data) {
      var remark = String(data && data.remark || "");
      if (/runtime error|timed out|out of memory/i.test(remark)) throw new Error("OpenStreetMap ran out of time - try a smaller distance");
      return (data && data.elements || []).map(function (e) {
        return { type: e.type, id: e.id, center: e.center, lat: e.lat, lon: e.lon, tags: { name: e.tags && e.tags.name } };
      });
    }, function (error) {
      throw error && error.name === "AbortError" ? new Error("OpenStreetMap did not answer in time - try again or a smaller distance") : error;
    }).finally(function () { clearTimeout(timer); });
  }

  function km(metres) {
    var n = Number(metres);
    return Number.isFinite(n) ? (n / 1000).toFixed(n < 10000 ? 1 : 0) + " km" : "";
  }

  function render(containerEl) {
    var destroyed = false;
    var courses = [];
    var ticked = {};
    var outcome = {};
    var loadRun = 0;
    var scanning = false;

    containerEl.innerHTML =
      '<div class="gdStudioLede" style="margin-bottom:14px"><p>Scan every course in an area. Pick any ' +
      "course with the course picker to centre the region on it, set how far out to look, then untick " +
      "anything you do not want. Courses we already hold are shown but never rescanned. Scans run in the " +
      "background one at a time, behind anything a player asks for.</p></div>" +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">' +
        '<button type="button" class="gdStudioDiagramBtn" data-role="pick">Pick centre course…</button>' +
        '<label class="gdStudioMuted">Distance <select data-role="radius"></select></label>' +
        '<span data-role="centre"></span>' +
      "</div>" +
      '<p class="gdStudioMuted" data-role="summary"></p>' +
      '<div data-role="list"></div>' +
      '<div data-role="actions" style="display:none;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px">' +
        '<button type="button" class="gdStudioDiagramBtn" data-role="scan"></button>' +
        '<span class="gdStudioMuted" data-role="status"></span>' +
      "</div>";

    function el(role) { return containerEl.querySelector('[data-role="' + role + '"]'); }
    var radius = el("radius");
    radius.innerHTML = DISTANCES_KM.map(function (d) {
      return '<option value="' + d + '"' + (d === session.radiusKm ? " selected" : "") + ">" + d + " km</option>";
    }).join("");

    function scannable() { return courses.filter(function (c) { return !c.hasMap && !outcome[c.name]; }); }
    function selected() { return scannable().filter(function (c) { return ticked[c.name]; }); }

    function updateActions() {
      var pickable = scannable();
      var count = selected().length;
      var all = el("all");
      if (all) {
        all.checked = pickable.length > 0 && count === pickable.length;
        all.indeterminate = count > 0 && count < pickable.length;
        all.disabled = scanning || !pickable.length;
      }
      el("actions").style.display = courses.length ? "flex" : "none";
      el("scan").textContent = "Scan " + count + " selected course" + (count === 1 ? "" : "s");
      el("scan").disabled = scanning || !count;
    }

    function rowHtml(course) {
      var done = outcome[course.name];
      var box = course.hasMap || done
        ? '<input type="checkbox" disabled' + (done && done.queued ? " checked" : "") + ">"
        : '<input type="checkbox" data-name="' + esc(course.name) + '"' + (ticked[course.name] ? " checked" : "") + (scanning ? " disabled" : "") + ">";
      var note = course.hasMap ? "already mapped"
        : done ? (done.queued ? "queued" : (SKIP_TEXT[done.reason] || done.reason))
        : "";
      return '<label style="display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid rgba(0,0,0,.06)' + (course.hasMap ? ";opacity:.55" : "") + '">' +
        box + '<span style="flex:1">' + esc(course.name) + "</span>" +
        '<span class="gdStudioMuted">' + esc(note) + "</span>" +
        '<span class="gdStudioMuted" style="min-width:56px;text-align:right">' + esc(km(course.distanceM)) + "</span></label>";
    }

    function renderList() {
      var mapped = courses.filter(function (c) { return c.hasMap; }).length;
      el("summary").className = "gdStudioMuted";
      el("summary").textContent = courses.length
        ? courses.length + " course" + (courses.length === 1 ? "" : "s") + " within " + session.radiusKm + " km - " +
          mapped + " already mapped, " + (courses.length - mapped) + " to scan."
        : "No golf courses found within " + session.radiusKm + " km.";
      var unmapped = courses.filter(function (c) { return !c.hasMap; });
      el("list").innerHTML = courses.length
        ? (unmapped.length ? '<label style="display:flex;gap:10px;align-items:center;padding:6px 0;font-weight:600;border-bottom:1px solid rgba(0,0,0,.12)">' +
            '<input type="checkbox" data-role="all"> Select all</label>' : "") +
          unmapped.map(rowHtml).join("") +
          courses.filter(function (c) { return c.hasMap; }).map(rowHtml).join("")
        : "";
      updateActions();
    }

    function load() {
      var centre = session.centre;
      el("centre").innerHTML = centre ? "Centred on <strong>" + esc(centre.name) + "</strong>" : '<span class="gdStudioMuted">No centre picked yet.</span>';
      courses = [];
      outcome = {};
      el("list").innerHTML = "";
      if (!centre) { el("summary").textContent = ""; updateActions(); return; }
      var run = ++loadRun;
      el("summary").className = "gdStudioMuted";
      el("summary").textContent = "Asking OpenStreetMap for courses within " + session.radiusKm + " km…";
      updateActions();
      fetchRegionElements(centre, session.radiusKm)
        .then(function (elements) {
          if (destroyed || run !== loadRun) return null;
          el("summary").textContent = "Checking which ones we already have…";
          return call("POST", "", { kind: "region_list", lat: centre.lat, lng: centre.lng, radiusKm: session.radiusKm, elements: elements });
        })
        .then(function (data) {
          if (!data) return;
          if (destroyed || run !== loadRun) return;
          courses = data.courses || [];
          ticked = {};
          courses.forEach(function (c) { if (!c.hasMap) ticked[c.name] = true; });
          renderList();
        }, function (error) {
          if (destroyed || run !== loadRun) return;
          el("summary").className = "gdStudioNeedsVerification";
          el("summary").textContent = "Could not load courses: " + (error && error.message || error);
        });
    }

    function scan() {
      var batch = selected();
      if (!batch.length || scanning) return;
      scanning = true;
      renderList();
      var queued = 0, skipped = 0, sent = 0;
      var status = el("status");
      function next() {
        if (destroyed) return;
        if (sent >= batch.length) {
          scanning = false;
          status.textContent = "Queued " + queued + (skipped ? ", skipped " + skipped : "") + ". They map in the background - watch Course Database for progress.";
          renderList();
          return;
        }
        var part = batch.slice(sent, sent + BATCH);
        status.textContent = "Queuing " + (sent + 1) + "–" + (sent + part.length) + " of " + batch.length + "…";
        call("POST", "", {
          kind: "region_scan",
          courses: part.map(function (c) { return { name: c.name, lat: c.lat, lng: c.lng }; })
        }).then(function (data) {
          /* The server reports by course id (a slug of the name); match each back to its row. */
          var byId = {};
          (data.queued || []).forEach(function (id) { byId[id] = { queued: true }; });
          (data.skipped || []).forEach(function (s) { byId[s.courseId] = { reason: s.reason }; });
          part.forEach(function (c) {
            var slug = String(c.name || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
            outcome[c.name] = byId[slug] || { reason: "insert-failed" };
            if (outcome[c.name].queued) queued += 1; else skipped += 1;
          });
          sent += part.length;
          renderList();
          next();
        }, function (error) {
          scanning = false;
          status.textContent = "Stopped after " + queued + " queued: " + (error && error.message || error);
          renderList();
        });
      }
      next();
    }

    el("list").addEventListener("change", function (event) {
      var box = event.target;
      if (box.getAttribute("data-role") === "all") {
        scannable().forEach(function (c) { ticked[c.name] = box.checked; });
        renderList();
        return;
      }
      var name = box.getAttribute("data-name");
      if (name == null) return;
      ticked[name] = box.checked;
      updateActions();
    });
    radius.addEventListener("change", function () {
      session.radiusKm = Number(radius.value) || 25;
      load();
    });
    el("scan").addEventListener("click", scan);
    el("pick").addEventListener("click", function () {
      var pick = window.GDStudioCoursePick;
      var opened = pick && typeof pick.open === "function" && pick.open({
        source: "studio-region-scan",
        onPick: function (course) {
          if (destroyed) return;
          var lat = Number(course && course.lat), lng = Number(course && course.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            el("summary").className = "gdStudioNeedsVerification";
            el("summary").textContent = "That course has no location to centre on - pick another.";
            return;
          }
          session.centre = { name: course.name || "Picked course", lat: lat, lng: lng };
          load();
        }
      });
      if (!opened) el("summary").textContent = "The course picker is not loaded on this surface.";
    });

    load();

    return function cleanup() {
      destroyed = true;
      if (window.GDStudioCoursePick) window.GDStudioCoursePick.cancel();
      if (window.GDStudioShell) window.GDStudioShell.show();
    };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["region-scan"] = render;
})();
