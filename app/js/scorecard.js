/* Scorecard: score entry + running total. Par comes from the existing
   read-only cache (GET /api/scorecard-store) the legacy scraper already built
   and keeps warm — the fresh app only reads it, exactly like
   course-library.js/course-package.js already do for other data, never
   reviving the scraper itself (the app authors nothing). Fail-open: no cached
   card for this course is a normal state, holes just render with blank/
   editable par, same as an unmapped hole falls back to the live map. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var ENDPOINT = "/api/scorecard-store";
  var TIMEOUT_MS = 4000;
  var STORE_KEY = "clarity:scorecard:v1";
  var HOLE_COUNT = 18;

  var parByHole = {};   // {1: 4, 2: 3, ...} — from the cache, or blank/editable
  var courseKey = null;
  var loadToken = 0;

  function scores() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null") || {}; } catch (e) { return {}; }
  }

  function saveScores(byCourse) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(byCourse)); } catch (e) {}
  }

  function courseScores() {
    var all = scores();
    return (courseKey && all[courseKey]) || {};
  }

  function setScore(hole, strokes) {
    if (!courseKey) return;
    var all = scores();
    all[courseKey] = all[courseKey] || {};
    if (strokes > 0) all[courseKey][hole] = strokes;
    else delete all[courseKey][hole];
    saveScores(all);
  }

  function setPar(hole, par) {
    parByHole[hole] = par > 0 ? par : null;
  }

  async function fetchPar(key) {
    if (typeof fetch !== "function") return {};
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, TIMEOUT_MS) : null;
    try {
      var res = await fetch(ENDPOINT + "?courseKey=" + encodeURIComponent(key),
        { headers: { Accept: "application/json" }, signal: controller ? controller.signal : undefined });
      if (!res.ok) return {};
      var body = await res.json();
      var holes = body && body.found && body.scorecard && Array.isArray(body.scorecard.holes) ? body.scorecard.holes : [];
      var out = {};
      holes.forEach(function (h) { if (h && Number(h.hole) > 0 && Number(h.par) > 0) out[h.hole] = Number(h.par); });
      return out;
    } catch (e) {
      return {};
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function total() {
    var strokes = courseScores();
    var sum = 0, any = false, relative = true;
    Object.keys(strokes).forEach(function (hole) {
      var s = Number(strokes[hole]);
      if (!(s > 0)) return;
      any = true;
      var par = parByHole[hole];
      if (par > 0) sum += (s - par);
      else { relative = false; sum += s; }
    });
    if (!any) return null;
    return { value: sum, relative: relative };
  }

  function render() {
    var totalEl = document.getElementById("scoreTotal");
    var list = document.getElementById("scoreList");
    if (!list) return;
    var t = total();
    if (totalEl) {
      totalEl.textContent = t
        ? (t.relative ? (t.value > 0 ? "+" + t.value : t.value === 0 ? "E" : String(t.value)) : t.value + " strokes")
        : "–";
    }
    var strokes = courseScores();
    var currentHole = (app.play && app.play.state().hole) || 0;
    list.textContent = "";
    for (var hole = 1; hole <= HOLE_COUNT; hole++) {
      list.appendChild(renderRow(hole, strokes[hole] || 0, hole === currentHole));
    }
  }

  function renderRow(hole, strokes, isCurrent) {
    var row = document.createElement("div");
    row.className = "scoreRow" + (isCurrent ? " currentHole" : "");

    var holeEl = document.createElement("span");
    holeEl.className = "scoreHole";
    holeEl.textContent = String(hole);

    var parEl = document.createElement("span");
    parEl.className = "scorePar";
    var parInput = document.createElement("input");
    parInput.type = "number";
    parInput.inputMode = "numeric";
    parInput.min = "3";
    parInput.max = "6";
    parInput.setAttribute("aria-label", "Par for hole " + hole);
    parInput.value = parByHole[hole] > 0 ? String(parByHole[hole]) : "";
    parInput.placeholder = "Par";
    parInput.addEventListener("change", function () {
      setPar(hole, Math.round(Number(parInput.value)));
      render();
    });
    parEl.appendChild(parInput);

    var strokesEl = document.createElement("div");
    strokesEl.className = "scoreStrokes";
    var minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "–";
    minus.setAttribute("aria-label", "Decrease score for hole " + hole);
    minus.addEventListener("click", function () {
      setScore(hole, Math.max(0, strokes - 1));
      render();
    });
    var value = document.createElement("span");
    value.className = "scoreStrokesValue";
    value.textContent = strokes > 0 ? String(strokes) : "–";
    var plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    plus.setAttribute("aria-label", "Increase score for hole " + hole);
    plus.addEventListener("click", function () {
      setScore(hole, strokes + 1);
      render();
    });
    strokesEl.appendChild(minus);
    strokesEl.appendChild(value);
    strokesEl.appendChild(plus);

    row.appendChild(holeEl);
    row.appendChild(parEl);
    row.appendChild(strokesEl);
    return row;
  }

  app.scorecard = {
    /* Called by play.js on course open — resolves the canonical key and goes
       to fetch its cached par card; a hole change or a slow/failed fetch never
       blocks play, it only affects what the (separately opened) panel shows. */
    setCourse: async function (key) {
      var token = ++loadToken;
      courseKey = app.courseKey(key);
      parByHole = {};
      var found = await fetchPar(courseKey);
      if (token !== loadToken) return;   // superseded: drop silently
      parByHole = found;
      render();
    },
    open: function () {
      var panel = document.getElementById("scorePanel");
      if (panel) panel.classList.remove("hiddenState");
      render();
    },
    close: function () {
      var panel = document.getElementById("scorePanel");
      if (panel) panel.classList.add("hiddenState");
    }
  };

  document.addEventListener("DOMContentLoaded", function () {
    var close = document.getElementById("scoreClose");
    if (close) close.addEventListener("click", function () { app.scorecard.close(); });
  });
})();
