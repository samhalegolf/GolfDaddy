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

  function openPinChoice() {
    var el = document.getElementById("pinChoicePopover");
    if (el) el.classList.remove("hiddenState");
  }

  function closePinChoice() {
    var el = document.getElementById("pinChoicePopover");
    if (el) el.classList.add("hiddenState");
  }

  function closePinLock() {
    var panel = document.getElementById("pinLockPanel");
    if (panel) panel.classList.add("hiddenState");
    var status = document.getElementById("pinLockStatus");
    if (status) status.classList.add("hiddenState");
  }

  app.toolRail = { toggle: toggle, close: close, openPinChoice: openPinChoice };

  document.addEventListener("DOMContentLoaded", function () {
    var tab = document.getElementById("toolRailTab");
    if (tab) tab.addEventListener("click", toggle);

    var bagBtn = document.getElementById("railBag");
    if (bagBtn) bagBtn.addEventListener("click", function () {
      close();
      if (app.bag) app.bag.open();
    });

    /* The pin tool's main tap only ever REVEALS its two placement methods —
       the crosshair (calculated Pin Lock) and the flag (drag and place). It
       used to arm placement directly, so the tap that opened the tool could be
       read as the placing tap and drop a pin under the rail.

       The flag is a drag SOURCE wherever it appears: press and drag it onto
       the map/surface and release to drop the pin there, with a ghost flag
       tracking the finger; a plain tap on it arms the next map tap instead.
       Distinguished by movement past a small threshold, exactly like the
       legacy gdBindFlagPointerHandlers. Wired onto both the rail icon and the
       flag in the choice popover so the gesture means the same in both. */
    var pinGhost = document.getElementById("pinGhost");

    function wireFlagSource(btn, onTap) {
      if (!btn || !app.pin) return;
      var down = false, dragged = false, startX = 0, startY = 0;
      btn.addEventListener("pointerdown", function (e) {
        down = true;
        dragged = false;
        startX = e.clientX;
        startY = e.clientY;
        try { btn.setPointerCapture(e.pointerId); } catch (err) {}
      });
      btn.addEventListener("pointermove", function (e) {
        if (!down) return;
        if (!dragged && Math.hypot(e.clientX - startX, e.clientY - startY) > 8) {
          dragged = true;
          if (pinGhost) pinGhost.classList.remove("hiddenState");
        }
        if (dragged && pinGhost) {
          pinGhost.style.left = e.clientX + "px";
          pinGhost.style.top = e.clientY + "px";
        }
      });
      btn.addEventListener("pointerup", function (e) {
        if (!down) return;
        down = false;
        if (pinGhost) pinGhost.classList.add("hiddenState");
        if (dragged) {
          app.pin.disarm();
          var ll = app.painter && app.painter.latLngAt(e.clientX, e.clientY);
          if (ll) app.pin.set(ll);
          close();
          closePinChoice();
          return;
        }
        onTap();
      });
      btn.addEventListener("pointercancel", function () {
        down = false;
        dragged = false;
        if (pinGhost) pinGhost.classList.add("hiddenState");
      });
    }

    wireFlagSource(document.getElementById("railPin"), function () {
      close();
      if (app.pin) app.pin.disarm();
      openPinChoice();
    });

    /* Flag, tapped rather than dragged: arm the next map/surface tap. */
    wireFlagSource(document.getElementById("pinChoiceDrag"), function () {
      closePinChoice();
      if (app.pin) app.pin.arm();
    });

    /* Crosshair: the calculated route. */
    var pinLockBtn = document.getElementById("pinChoiceLock");
    if (pinLockBtn) pinLockBtn.addEventListener("click", function () {
      closePinChoice();
      if (app.pin) app.pin.disarm();
      var panel = document.getElementById("pinLockPanel");
      if (panel) panel.classList.remove("hiddenState");
    });

    /* Quadrant is a single choice, so selecting one clears the rest. */
    var quadrantGrid = document.getElementById("pinQuadrantGrid");
    if (quadrantGrid) quadrantGrid.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest("[data-quadrant]") : null;
      if (!btn || !quadrantGrid.contains(btn)) return;
      Array.prototype.forEach.call(quadrantGrid.querySelectorAll("[data-quadrant]"), function (b) {
        b.classList.toggle("active", b === btn);
      });
    });

    var pinLockCancel = document.getElementById("pinLockCancel");
    if (pinLockCancel) pinLockCancel.addEventListener("click", closePinLock);

    var pinLockPlace = document.getElementById("pinLockPlace");
    if (pinLockPlace) pinLockPlace.addEventListener("click", function () {
      var status = document.getElementById("pinLockStatus");
      function fail(message) {
        if (!status) return;
        status.textContent = message;
        status.classList.remove("hiddenState");
      }
      var chosen = quadrantGrid && quadrantGrid.querySelector("[data-quadrant].active");
      if (!chosen) { fail("Pick the quadrant the flag is in"); return; }
      var input = document.getElementById("pinLockDistance");
      var distance = input ? Number(input.value) : NaN;
      var hole = app.painter && app.painter.holeGeometry ? app.painter.holeGeometry() : null;
      var position = app.marshal && app.marshal.player();
      /* Named failures rather than a pin dropped somewhere plausible: without
         a position or a green there is nothing to calculate FROM. */
      if (!position) { fail("No position yet - place yourself first"); return; }
      if (!hole || !hole.green) { fail("This hole has no mapped green"); return; }
      var placed = app.pin.lockedPin({
        position: position,
        green: hole.green,
        greenShape: hole.greenShape,
        quadrant: chosen.dataset.quadrant,
        distanceM: distance
      });
      if (!placed) { fail("Could not work out the pin from that"); return; }
      app.pin.set(placed);
      closePinLock();
    });

    /* "Put me where I actually am" — a PREVIEW placement, since that is the
       only flow where where-you-are is a question you answer. In Live the dot
       already follows the fix, so the Marshal refuses this and Trace shows it
       as an accepted-but-inert signal rather than it silently doing nothing. */
    var gpsPinBtn = document.getElementById("railGpsPin");
    if (gpsPinBtn) gpsPinBtn.addEventListener("click", function () {
      close();
      var fix = app.gps && app.gps.lastFix();
      if (fix && app.marshal) app.marshal.signal("PLACED", { point: fix });
    });

    var scoreBtn = document.getElementById("railScorecard");
    if (scoreBtn) scoreBtn.addEventListener("click", function () {
      close();
      if (app.scorecard) app.scorecard.open();
    });

    /* Wind: short tap turns wind on (live wind first — the compass only
       appears when live can't answer) then cycles the level (1→2→3→off);
       a long press opens the compass for a manual direction override —
       same long-press as the legacy rail button. */
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
