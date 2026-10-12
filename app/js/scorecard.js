/* Scorecard: the course's card, score entry and a running total. The card comes from the
   shared store (GET /api/scorecard-store) - the one stored under the course's name, which
   is the card an admin edits or attaches in Studio. The app only reads it (the app authors
   nothing). It shows what the card has: par always, the stroke index when the card printed
   one, and a distance for the tee picked when it has distances - with a tee picker only when
   there is more than one tee. Fail-open: no card is a normal state, holes render with a
   blank, editable par, same as an unmapped hole falls back to the live map. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var ENDPOINT = "/api/scorecard-store";
  var TIMEOUT_MS = 4000;
  var STORE_KEY = "clarity:scorecard:v1";
  var TEE_KEY = "clarity:scorecard:tee:v1";

  var parByHole = {};   // {1: 4, 2: 3, ...} — from the cache, or blank/editable
  /* The rest of the card: {holes: {n: {index, metres, tees: {name: metres}}}, tees: [name]}. */
  var card = { holes: {}, tees: [] };
  var teeName = "";
  var courseKey = null;
  var loadToken = 0;

  /* course_scorecards.course_key is the DISPLAY NAME, lowercased and whitespace-
     collapsed — NOT the dash-slug `courseKey` above is (that one keys the
     localStorage score bucket and must not change format, or existing saved
     scores go missing). Must stay byte-identical to scorecardCourseKey() in
     functions/course-mapper-worker-background.mjs and
     functions/lib/gd-scorecard-resolve.mjs. */
  function scorecardCourseKey(name) {
    return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

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

  /* The stored holes as {par: {n: par}, card: {holes, tees}}: tees in the order the card
     lists them, each hole's distance by tee, its plain distance (metres) and its index. */
  function readCard(holes) {
    var par = {}, out = { holes: {}, tees: [] };
    (holes || []).forEach(function (h) {
      var n = Number(h && h.hole);
      if (!(n > 0)) return;
      if (Number(h.par) > 0) par[n] = Number(h.par);
      var tees = {};
      if (h.tees && typeof h.tees === "object") {
        Object.keys(h.tees).forEach(function (name) {
          var m = Number(h.tees[name] && h.tees[name].metres);
          if (m > 0) { tees[name] = m; if (out.tees.indexOf(name) < 0) out.tees.push(name); }
        });
      }
      out.holes[n] = { index: Number(h.index) > 0 ? Number(h.index) : null, metres: Number(h.metres) > 0 ? Number(h.metres) : null, tees: tees };
    });
    return { par: par, card: out };
  }

  function savedTee() { try { return localStorage.getItem(TEE_KEY) || ""; } catch (e) { return ""; } }
  function chooseTee(name) {
    teeName = name || "";
    try { localStorage.setItem(TEE_KEY, teeName); } catch (e) {}
    render();
  }
  /* A hole's distance for the tee picked, else its plain distance. */
  function distanceFor(hole) {
    var h = card.holes[hole];
    if (!h) return null;
    if (teeName && h.tees[teeName] > 0) return h.tees[teeName];
    return h.metres;
  }

  async function fetchCard(key) {
    if (typeof fetch !== "function") return readCard([]);
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, TIMEOUT_MS) : null;
    try {
      var res = await fetch(ENDPOINT + "?courseKey=" + encodeURIComponent(key),
        { headers: { Accept: "application/json" }, signal: controller ? controller.signal : undefined });
      if (!res.ok) return readCard([]);
      var body = await res.json();
      return readCard(body && body.found && body.scorecard && Array.isArray(body.scorecard.holes) ? body.scorecard.holes : []);
    } catch (e) {
      return readCard([]);
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

  /* Every hole the round has, which for a 27-hole club is 27 rows. The Marshal
     owns that list; 18 here is only the no-package fallback. */
  function holesToRender() {
    var round = app.marshal && app.marshal.round();
    if (round && Array.isArray(round.holesInPlay) && round.holesInPlay.length) return round.holesInPlay;
    var out = [];
    for (var hole = 1; hole <= 18; hole++) out.push(hole);
    return out;
  }

  function render() {
    var totalEl = document.getElementById("scoreTotal");
    var list = document.getElementById("scoreList");
    if (!list) return;
    var t = total();
    var i18n = window.GDI18n;
    if (totalEl) {
      if (!t) i18n.plain(totalEl, "–");
      else if (!t.relative) i18n.setPlural(totalEl, "scorecard.strokes", t.value);
      else if (t.value === 0) i18n.set(totalEl, "scorecard.even");
      else i18n.plain(totalEl, t.value > 0 ? "+" + t.value : String(t.value));
    }
    var strokes = courseScores();
    var currentHole = (app.marshal && app.marshal.round().hole) || 0;
    var holes = holesToRender();
    var cols = columns(holes);
    renderTeePicker(list);
    list.textContent = "";
    list.appendChild(renderHeader(cols));
    holes.forEach(function (hole) {
      list.appendChild(renderRow(hole, strokes[hole] || 0, hole === currentHole, cols));
    });
    renderSums(list, holes, strokes, cols);
  }

  /* Only what the card has: SI when it printed a stroke index, a distance when it has one. */
  function columns(holes) {
    return {
      index: holes.some(function (h) { return card.holes[h] && card.holes[h].index; }),
      distance: holes.some(function (h) { return distanceFor(h) > 0; })
    };
  }

  function unitLabel() { return app.gpsSettings && app.gpsSettings.unitLabel ? app.gpsSettings.unitLabel() : "m"; }
  function showDistance(metres) {
    if (!(metres > 0)) return "";
    var v = app.gpsSettings && app.gpsSettings.toDisplay ? app.gpsSettings.toDisplay(metres) : Math.round(metres);
    return v == null ? "" : String(v);
  }

  function cellText(className, text, key) {
    var el = document.createElement("span");
    el.className = className;
    if (key) window.GDI18n.set(el, key); else el.textContent = text;
    return el;
  }

  function renderHeader(cols) {
    var row = document.createElement("div");
    row.className = "scoreRow scoreHead";
    row.appendChild(cellText("scoreHole", "#"));
    row.appendChild(cellText("scorePar", "", "common.parWord"));
    if (cols.index) row.appendChild(cellText("scoreIndex", "", "scorecard.indexShort"));
    if (cols.distance) row.appendChild(cellText("scoreDistance", unitLabel()));
    row.appendChild(cellText("scoreStrokes", "", "logged.score"));
    return row;
  }

  /* A tee picker above the card, only when the card has more than one tee. */
  function renderTeePicker(list) {
    var picker = document.getElementById("scoreTee");
    if (card.tees.length < 2) { if (picker) picker.parentNode.removeChild(picker); return; }
    if (!picker) {
      picker = document.createElement("label");
      picker.id = "scoreTee";
      picker.className = "scoreTee";
      var label = document.createElement("span");
      window.GDI18n.set(label, "scorePage.teeMarker");
      picker.appendChild(label);
      var select = document.createElement("select");
      select.addEventListener("change", function () { chooseTee(select.value); });
      picker.appendChild(select);
      list.parentNode.insertBefore(picker, list);
    }
    var sel = picker.querySelector("select");
    sel.textContent = "";
    card.tees.forEach(function (name) {
      var option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      sel.appendChild(option);
    });
    sel.value = teeName;
  }

  /* Out, In and Total for an 18 (just Total otherwise): par, the distance from the tee
     picked and the strokes so far. */
  function renderSums(list, holes, strokes, cols) {
    var groups = holes.length === 18
      ? [["scorecard.out", holes.slice(0, 9)], ["scorecard.in", holes.slice(9)], ["bagPage.total", holes]]
      : [["bagPage.total", holes]];
    groups.forEach(function (group) {
      var par = 0, metres = 0, played = 0;
      group[1].forEach(function (h) {
        par += Number(parByHole[h]) || 0;
        metres += Number(distanceFor(h)) || 0;
        played += Number(strokes[h]) || 0;
      });
      var row = document.createElement("div");
      row.className = "scoreRow scoreSum";
      row.appendChild(cellText("scoreHole", "", group[0]));
      row.appendChild(cellText("scorePar", par ? String(par) : ""));
      if (cols.index) row.appendChild(cellText("scoreIndex", ""));
      if (cols.distance) row.appendChild(cellText("scoreDistance", showDistance(metres)));
      row.appendChild(cellText("scoreStrokes", played ? String(played) : "–"));
      list.appendChild(row);
    });
  }

  function renderRow(hole, strokes, isCurrent, cols) {
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
    window.GDI18n.setAttr(parInput, "aria-label", "scorecard.parForHole", { n: hole });
    parInput.value = parByHole[hole] > 0 ? String(parByHole[hole]) : "";
    window.GDI18n.setAttr(parInput, "placeholder", "common.parWord");
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
    window.GDI18n.setAttr(minus, "aria-label", "scorecard.decrease", { n: hole });
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
    window.GDI18n.setAttr(plus, "aria-label", "scorecard.increase", { n: hole });
    plus.addEventListener("click", function () {
      setScore(hole, strokes + 1);
      render();
    });
    strokesEl.appendChild(minus);
    strokesEl.appendChild(value);
    strokesEl.appendChild(plus);

    row.appendChild(holeEl);
    row.appendChild(parEl);
    if (cols.index) row.appendChild(cellText("scoreIndex", card.holes[hole] && card.holes[hole].index ? String(card.holes[hole].index) : ""));
    if (cols.distance) row.appendChild(cellText("scoreDistance", showDistance(distanceFor(hole))));
    row.appendChild(strokesEl);
    return row;
  }

  app.scorecard = {
    /* Called on round open — resolves the canonical key and goes to fetch its
       cached par card; a hole change or a slow/failed fetch never blocks play,
       it only affects what the (separately opened) panel shows. */
    setCourse: async function (key, name) {
      var token = ++loadToken;
      courseKey = app.courseKey(key);
      parByHole = {};
      card = { holes: {}, tees: [] };
      var found = await fetchCard(scorecardCourseKey(name || key));
      if (token !== loadToken) return;   // superseded: drop silently
      parByHole = found.par;
      card = found.card;
      var saved = savedTee();
      teeName = card.tees.indexOf(saved) >= 0 ? saved : (card.tees[0] || "");
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
