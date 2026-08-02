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

    /* Pin has two placement methods, same split as the legacy flag tool:
       a short tap arms placement (the next map/surface tap places it, wired
       in play.js), or press-and-drag the icon itself straight onto the map/
       surface and release to drop it there immediately — a ghost flag tracks
       the finger for the drag. Distinguished by movement past a small
       threshold, exactly like the legacy gdBindFlagPointerHandlers. */
    var pinBtn = document.getElementById("railPin");
    var pinGhost = document.getElementById("pinGhost");
    if (pinBtn && app.pin) {
      var pinDown = false, pinDragged = false, pinStartX = 0, pinStartY = 0;
      pinBtn.addEventListener("pointerdown", function (e) {
        pinDown = true;
        pinDragged = false;
        pinStartX = e.clientX;
        pinStartY = e.clientY;
        try { pinBtn.setPointerCapture(e.pointerId); } catch (err) {}
      });
      pinBtn.addEventListener("pointermove", function (e) {
        if (!pinDown) return;
        if (!pinDragged && Math.hypot(e.clientX - pinStartX, e.clientY - pinStartY) > 8) {
          pinDragged = true;
          if (pinGhost) pinGhost.classList.remove("hiddenState");
        }
        if (pinDragged && pinGhost) {
          pinGhost.style.left = e.clientX + "px";
          pinGhost.style.top = e.clientY + "px";
        }
      });
      pinBtn.addEventListener("pointerup", function (e) {
        if (!pinDown) return;
        pinDown = false;
        if (pinGhost) pinGhost.classList.add("hiddenState");
        if (pinDragged) {
          app.pin.disarm();
          var ll = app.play && app.play.latLngAt(e.clientX, e.clientY);
          if (ll) app.pin.set(ll);
          close();
        } else {
          close();
          app.pin.togglePlacement();
        }
      });
      pinBtn.addEventListener("pointercancel", function () {
        pinDown = false;
        pinDragged = false;
        if (pinGhost) pinGhost.classList.add("hiddenState");
      });
    }

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
