/* The public watch preview (watch-preview.html): the Garmin and the Apple Watch faces on a
   real course, for a visitor who has no account yet.
 *
 * What it is made of: the Studio's own watch preview parts, unchanged - the two faces
 * (garmin-watch-render.js / apple-watch-render.js, each a port of its watch's draw code), the
 * mount that puts a face on a canvas with its buttons (watch-preview-page.js mountWatch), and
 * the same course packages the watches receive (GET /api/course-watch-maps). This file is
 * only the page round them: the sign-up request gate, a course search, a hole, and three
 * places to stand.
 *
 * The three positions, on the hole's play line (tee, mapped route, green):
 *   Tee shot        the tee
 *   Long approach   LONG_APPROACH_M short of the green, walked back along the line
 *   Short approach  SHORT_APPROACH_M short of the green
 * A hole shorter than the walk puts the player on the tee, as the app's demo does
 * (app/js/demo-approach.js pointShortOfGreen).
 *
 * The gate: one request (name, email, which watch) to POST /api/watch-preview-request. Once
 * it is accepted the page remembers that in localStorage and shows the preview from then on.
 * It guards a demo, not an account - nothing else reads the flag. */
(function (root) {
  "use strict";

  var ACCESS_KEY = "clarityWatchPreviewAccess";
  var LONG_APPROACH_M = 180;
  var SHORT_APPROACH_M = 90;
  var PRESETS = {
    tee: { label: "Tee shot" },
    long: { label: "Long approach", backM: LONG_APPROACH_M },
    short: { label: "Short approach", backM: SHORT_APPROACH_M }
  };

  function finite(n) { return Number.isFinite(Number(n)); }
  function point(p) { return p && finite(p.lat) && finite(p.lng) ? { lat: Number(p.lat), lng: Number(p.lng) } : null; }
  function metres(a, b) {
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad, dLng = (b.lng - a.lng) * toRad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  /* Walk back from the green along the line, interpolating each segment, as the app's demo
     does. A line shorter than the walk answers its first point (the tee). */
  function pointShortOfGreen(line, back) {
    line = (line || []).map(point).filter(Boolean);
    if (line.length < 2) return null;
    var left = back;
    for (var i = line.length - 1; i > 0; i--) {
      var a = line[i], b = line[i - 1];
      var seg = metres(a, b);
      if (!(seg > 0)) continue;
      if (seg >= left) {
        var t = left / seg;
        return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
      }
      left -= seg;
    }
    return line[0];
  }

  /* Where a preset stands on a hole record (watch-preview-page.js holeRecord: skeleton {t, r, g}).
     null when the hole has no mapped tee and route yet. */
  function positionFor(preset, hole) {
    var sk = hole && hole.skeleton;
    if (!sk || !sk.t || !sk.g) return null;
    var line = [sk.t].concat(sk.r || [], [sk.g]);
    if (preset === "tee") return point(sk.t);
    var p = PRESETS[preset];
    return p && p.backM ? pointShortOfGreen(line, p.backM) : null;
  }

  var api = { pointShortOfGreen: pointShortOfGreen, positionFor: positionFor, PRESETS: PRESETS, LONG_APPROACH_M: LONG_APPROACH_M, SHORT_APPROACH_M: SHORT_APPROACH_M };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!root || !root.document) return;

  // ---------------------------------------------------------------- the page

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function readAccess() { try { var raw = localStorage.getItem(ACCESS_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
  function writeAccess(record) { try { localStorage.setItem(ACCESS_KEY, JSON.stringify(record)); } catch (e) {} }

  var state = { watch: "garmin", course: null, preset: "tee", mount: null, session: null, options: null, searching: null };
  var el = {};

  function boot() {
    ["gate", "gateForm", "gateName", "gateEmail", "gateNote", "gateStatus", "preview", "watchTabs", "device", "units",
      "searchForm", "searchInput", "searchStatus", "results", "courseLine", "holePrev", "hole", "holeNext", "presets",
      "bezel", "canvas", "buttons", "readout"].forEach(function (id) { el[id] = $(id); });
    if (!el.gate || !el.preview) return;
    var P = root.GDWatchPreviewPage;
    if (!P || !P.watchOptions("garmin") || !P.watchOptions("apple")) {
      el.readout.textContent = "The watch faces did not load on this page.";
    }
    el.gateForm.addEventListener("submit", submitGate);
    el.searchForm.addEventListener("submit", function (e) { e.preventDefault(); search(el.searchInput.value); });
    el.watchTabs.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-watch]");
      if (btn) useWatch(btn.getAttribute("data-watch"));
    });
    el.device.addEventListener("change", function () {
      if (!state.mount) return;
      state.session.deviceId = el.device.value;
      state.mount.newFace();
      placePlayer();
    });
    el.units.addEventListener("change", function () { if (state.session) { state.session.units = el.units.value; state.mount.requestUpdate(); } });
    el.hole.addEventListener("change", function () { setHole(Number(el.hole.value)); });
    el.holePrev.addEventListener("click", function () { stepHole(-1); });
    el.holeNext.addEventListener("click", function () { stepHole(1); });
    el.presets.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-preset]");
      if (btn) { state.preset = btn.getAttribute("data-preset"); placePlayer(); }
    });
    if (readAccess()) openPreview(); else el.gate.hidden = false;
  }

  // ---- the gate

  function submitGate(e) {
    e.preventDefault();
    var watch = (el.gateForm.querySelector('input[name="watch"]:checked') || {}).value || "";
    var body = { name: el.gateName.value, email: el.gateEmail.value, watch: watch, note: el.gateNote ? el.gateNote.value : "", locale: navigator.language || "" };
    var button = el.gateForm.querySelector('button[type="submit"]');
    button.disabled = true;
    el.gateStatus.textContent = "Sending your request…";
    fetch("/api/watch-preview-request", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        if (!result.ok) { el.gateStatus.textContent = result.data && result.data.error || "Your request could not be sent. Please try again."; button.disabled = false; return; }
        writeAccess({ name: body.name, email: body.email, watch: watch, at: new Date().toISOString() });
        if (watch === "apple" || watch === "garmin") state.watch = watch;
        openPreview();
      })
      .catch(function () { el.gateStatus.textContent = "Your request could not be sent. Check your connection and try again."; button.disabled = false; });
  }

  function openPreview() {
    el.gate.hidden = true;
    el.preview.hidden = false;
    var access = readAccess();
    if (access && (access.watch === "apple" || access.watch === "garmin")) state.watch = access.watch;
    useWatch(state.watch);
    el.searchInput.focus();
  }

  // ---- the watch

  function useWatch(key) {
    var P = root.GDWatchPreviewPage;
    var options = P && P.watchOptions(key);
    if (!options) return;
    if (state.mount) { state.mount.destroy(); state.mount = null; }
    state.watch = key;
    state.options = options;
    el.watchTabs.querySelectorAll("[data-watch]").forEach(function (b) { b.classList.toggle("isActive", b.getAttribute("data-watch") === key); });
    state.session = P.store("public-" + key, { deviceId: options.deviceId, mode: options.modes ? options.modes[0].value : "", units: el.units.value });
    state.session.zoom = 1;
    el.device.innerHTML = options.render.DEVICES.map(function (d) { return '<option value="' + esc(d.id) + '">' + esc(d.name) + "</option>"; }).join("");
    el.device.value = state.session.deviceId;
    state.mount = P.mountWatch(options, { canvas: el.canvas, bezel: el.bezel, buttons: el.buttons }, state.session, {
      onDraw: readout,
      onStepHole: function (n) { state.mount.setHole(n); el.hole.value = String(n); placePlayer(); }
    });
    if (state.course) loadCourse(state.course); else readout();
  }

  // ---- the course

  function search(query) {
    query = String(query || "").trim();
    if (query.length < 2) { el.searchStatus.textContent = "Type at least two letters of the course name."; return; }
    el.searchStatus.textContent = "Searching…";
    el.results.innerHTML = "";
    var token = state.searching = {};
    fetch("/api/course-search?q=" + encodeURIComponent(query), { headers: { Accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status)); })
      .then(function (data) {
        if (token !== state.searching) return;
        var results = (data && data.results) || [];
        var mapped = results.filter(function (r) { return r.courseId && r.hasMap; });
        var others = results.filter(function (r) { return !(r.courseId && r.hasMap); });
        if (!results.length) { el.searchStatus.textContent = "No course found for “" + query + "”."; return; }
        el.searchStatus.textContent = mapped.length ? "Pick a course:" : "No mapped course matches yet - the ones below are not on the watches.";
        el.results.innerHTML = mapped.concat(others).map(function (r) {
          var where = [r.region, r.country].filter(Boolean).join(", ");
          var ok = !!(r.courseId && r.hasMap);
          return '<button type="button" class="wpResult' + (ok ? "" : " isUnmapped") + '"' + (ok ? ' data-course="' + esc(r.courseId) + '" data-name="' + esc(r.name) + '"' : " disabled") + ">" +
            "<strong>" + esc(r.name) + "</strong>" + (where ? "<span>" + esc(where) + "</span>" : "") + (ok ? "" : "<em>Not mapped yet</em>") + "</button>";
        }).join("");
        el.results.querySelectorAll("[data-course]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            loadCourse({ key: btn.getAttribute("data-course"), name: btn.getAttribute("data-name") });
          });
        });
      })
      .catch(function (error) { if (token === state.searching) el.searchStatus.textContent = "Search failed - " + (error && error.message || error); });
  }

  function loadCourse(course) {
    var P = root.GDWatchPreviewPage;
    state.course = course;
    el.courseLine.textContent = "Loading " + course.name + "…";
    el.hole.innerHTML = "";
    var mount = state.mount, session = state.session;
    P.loadWatchPackage(course.key, state.options.packages).then(function (loaded) {
      if (mount !== state.mount) return;
      mount.useCourse(course.key, course.name, loaded);
      if (!loaded.holes.length) {
        el.courseLine.textContent = course.name + " has no " + (state.watch === "apple" ? "Apple Watch" : "Garmin") + " map yet.";
        readout();
        return;
      }
      el.courseLine.textContent = course.name + " · " + loaded.holes.length + " holes";
      el.hole.innerHTML = loaded.holes.map(function (h) { return '<option value="' + h.holeNumber + '">Hole ' + h.holeNumber + "</option>"; }).join("");
      el.hole.value = String(session.holeNumber);
      placePlayer();
    }).catch(function (error) {
      if (mount === state.mount) el.courseLine.textContent = "Could not load " + course.name + " - " + (error && error.message || error);
    });
  }

  function setHole(n) {
    if (!state.mount || !finite(n)) return;
    state.mount.setHole(n);
    el.hole.value = String(n);
    placePlayer();
  }
  function stepHole(delta) {
    var holes = state.session ? state.session.holes : [];
    var i = holes.findIndex(function (h) { return h.holeNumber === state.session.holeNumber; });
    var next = holes[i + delta];
    if (next) setHole(next.holeNumber);
  }

  // ---- where the player stands

  function placePlayer() {
    if (!state.mount) return;
    el.presets.querySelectorAll("[data-preset]").forEach(function (b) { b.classList.toggle("isActive", b.getAttribute("data-preset") === state.preset); });
    var hole = state.mount.currentHole();
    var p = positionFor(state.preset, hole);
    state.mount.setPlayer(p);
    readout();
  }

  function readout() {
    if (!el.readout || !state.mount) return;
    var session = state.session, hole = state.mount.currentHole(), face = state.mount.face();
    var lines = [];
    if (!state.course) lines.push("Search for a course to see it on the watch.");
    else if (!hole) lines.push("No hole to show yet.");
    else {
      var preset = PRESETS[state.preset];
      if (!session.player) lines.push("Hole " + hole.holeNumber + " has no tee and route mapped yet, so there is nowhere to stand. Try another hole.");
      else {
        var green = hole.skeleton && hole.skeleton.g ? Math.round(metres(session.player, hole.skeleton.g)) : null;
        var yards = session.units === "y";
        var show = function (m) { return yards ? Math.round(m * 1.09361) + " yd" : Math.round(m) + " m"; };
        var bubble = face && face.currentBubble ? face.currentBubble() : null;
        lines.push("Hole " + hole.holeNumber + " · " + preset.label + (green != null ? " · " + show(green) + " to the green" : ""));
        if (bubble && bubble.club) lines.push("Club: " + bubble.club.club + " · " + show(bubble.targetDistanceM) + " to the aim point");
      }
    }
    el.readout.textContent = lines.join("\n");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})(typeof window !== "undefined" ? window : null);
