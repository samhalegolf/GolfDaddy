/* Tool rail: a single tab in the top-right corner that drops down a panel of
   play-time tools. Owns the tab/rail toggle and wires each rail button to its
   tool module's entry point; each tool module wires its own panel/popover
   internals (bagPanel, scorePanel, windPopover) itself. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  var WIND_LONG_PRESS_MS = 450;

  function toggle() {
    var tab = document.getElementById("toolRailTab");
    var rail = document.getElementById("toolRail");
    if (!tab || !rail) return;
    var open = rail.classList.contains("hiddenState");
    rail.classList.toggle("hiddenState", !open);
    tab.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function close() {
    var tab = document.getElementById("toolRailTab");
    var rail = document.getElementById("toolRail");
    if (rail) rail.classList.add("hiddenState");
    if (tab) tab.setAttribute("aria-expanded", "false");
  }

  app.toolRail = { toggle: toggle, close: close };

  document.addEventListener("DOMContentLoaded", function () {
    var tab = document.getElementById("toolRailTab");
    if (tab) tab.addEventListener("click", toggle);

    var bagBtn = document.getElementById("railBag");
    if (bagBtn) bagBtn.addEventListener("click", function () {
      close();
      if (app.bag) app.bag.open();
    });

    var pinBtn = document.getElementById("railPin");
    if (pinBtn) pinBtn.addEventListener("click", function () {
      close();
      if (app.pin) app.pin.togglePlacement();
    });

    var gpsPinBtn = document.getElementById("railGpsPin");
    if (gpsPinBtn) gpsPinBtn.addEventListener("click", function () {
      close();
      var fix = app.gps && app.gps.lastFix();
      if (fix && app.position) app.position.set(fix, "gps");
    });

    var scoreBtn = document.getElementById("railScorecard");
    if (scoreBtn) scoreBtn.addEventListener("click", function () {
      close();
      if (app.scorecard) app.scorecard.open();
    });

    /* Wind: short tap cycles level (calm→1→2→3→off); a long press opens the
       compass to set/change direction — same split as the legacy rail button. */
    var windBtn = document.getElementById("railWind");
    if (windBtn && app.wind) {
      var pressTimer = null, longPressed = false;
      windBtn.addEventListener("pointerdown", function () {
        longPressed = false;
        pressTimer = setTimeout(function () {
          longPressed = true;
          app.wind.openPicker();
        }, WIND_LONG_PRESS_MS);
      });
      windBtn.addEventListener("pointerup", function () {
        clearTimeout(pressTimer);
        if (!longPressed) app.wind.press();
      });
      windBtn.addEventListener("pointercancel", function () { clearTimeout(pressTimer); });
    }
  });
})();
