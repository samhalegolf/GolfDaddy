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

  function holesToRender() {
    var nines = app.marshal && app.marshal.round().nines;
    if (nines) return nines.holesInPlay;
    var out = [];
    for (var hole = 1; hole <= 18; hole++) out.push(hole);
    return out;
  }

  function render() {
    var totalEl = document.getElementById("scoreTotal");
    var list = document.getElementById("scoreList");
    if (!list) return;
    renderNinePicker();
    var t = total();
    if (totalEl) {
      totalEl.textContent = t
        ? (t.relative ? (t.value > 0 ? "+" + t.value : t.value === 0 ? "E" : String(t.value)) : t.value + " strokes")
        : "–";
    }
    var strokes = courseScores();
    var currentHole = (app.marshal && app.marshal.round().hole) || 0;
    list.textContent = "";
    holesToRender().forEach(function (hole) {
      list.appendChild(renderRow(hole, strokes[hole] || 0, hole === currentHole));
    });
  }

  /* Only courses with more than two nines (e.g. a 27-hole club) get a
     picker — the common two-nine course has nothing to choose and
     marshal.round().nines is null for it. */
  function renderNinePicker() {
    var row = document.getElementById("ninePicker");
    if (!row) return;
    var nines = app.marshal && app.marshal.round().nines;
    if (!nines || nines.available.length <= 2) {
      row.classList.add("hiddenState");
      row.textContent = "";
      return;
    }
    row.classList.remove("hiddenState");
    row.textContent = "";
    nines.available.forEach(function (nine) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nineBtn" + (nines.selected.indexOf(nine.id) !== -1 ? " active" : "");
      btn.textContent = nine.label;
      btn.addEventListener("click", function () {
        var current = nines.selected;
        var next;
        if (current.indexOf(nine.id) !== -1) {
          if (current.length <= 1) return;   // keep at least one selected
          next = current.filter(function (id) { return id !== nine.id; });
        } else {
          next = current.length >= 2 ? [current[1], nine.id] : current.concat([nine.id]);
        }
        if (next.length !== 2) return;
        applyNineSelection(next);
        render();
      });
      row.appendChild(btn);
    });
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

  /* The nine picker hands its new pairing to the Marshal rather than acting on
     it: which holes are in play changes what hole you are on, and that is the
     Marshal's to decide. */
  function applyNineSelection(ids) {
    if (!app.marshal || !app.nines) return null;
    var round = app.marshal.round();
    var updated = app.nines.select(round.courseKey, app.marshal.state().round.pkg, ids);
    if (!updated) return null;
    app.marshal.signal("SET_NINES", { nines: updated });
    return updated;
  }

  app.scorecard = {
    /* Called on round open — resolves the canonical key and goes to fetch its
       cached par card; a hole change or a slow/failed fetch never blocks play,
       it only affects what the (separately opened) panel shows. */
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
    },
    /* Written through by the Logged screen's stepper, which is the one moment
       a hole is definitely finished — the cheapest place in the round to record
       a score, and the reason the panel is now somewhere you go to CHECK the
       card rather than somewhere you have to go to fill it in. */
    setScore: function (hole, strokes) {
      setScore(Number(hole), Math.max(0, Math.round(Number(strokes)) || 0));
      render();
    },
    /* What the Logged screen's stepper opens on, so the common case is one
       glance and no taps. */
    parFor: function (hole) {
      var par = Number(parByHole[Number(hole)]);
      return Number.isFinite(par) && par > 0 ? par : null;
    }
  };

  document.addEventListener("DOMContentLoaded", function () {
    var close = document.getElementById("scoreClose");
    if (close) close.addEventListener("click", function () { app.scorecard.close(); });
  });
})();
