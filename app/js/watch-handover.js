/* The phone's half of a phone <-> Watch handover.

   Marshal keeps owning the round whichever surface is driving. This module
   only draws what the CaddyWatchScene already says about `surface`: a Send to
   Watch control while the phone is driving and a Watch is there to take it,
   and a full-screen "on Apple Watch" state once it has. It reads the answer
   off the Scene rather than remembering one of its own, so a takeover started
   from the wrist and one started here look identical. Inert on web, where no
   native bridge ever reports a Watch. */
(function (window) {
  "use strict";
  var api = window.GDWatchHandover = window.GDWatchHandover || {};
  var watch = null;
  var offeredSince = null;
  var reminder = null;
  var OFFER_PATIENCE_MS = 15000;

  function el(id) { return document.getElementById(id); }
  function show(node, on) { if (node) node.classList.toggle("hiddenState", !on); }
  function units(m) {
    if (m === null || m === undefined || !Number.isFinite(Number(m))) return "–";
    var app = window.ClarityApp;
    var settings = app && app.gpsSettings;
    return settings && settings.toDisplay ? settings.toDisplay(m) : String(Math.round(Number(m)));
  }

  function statusFor(surface, reachable) {
    var handover = surface.handover || {};
    if (handover.state === "confirmed") return "Your Watch is driving this round. Lock and log from your wrist.";
    if (!reachable) return "Open Clarity Caddy on your Watch to pick this up.";
    if (offeredSince && Date.now() - offeredSince > OFFER_PATIENCE_MS) return "Your Watch hasn't answered yet. Open Clarity Caddy on your wrist.";
    return "Sending to your Watch…";
  }

  function render(scene) {
    var surface = scene && scene.surface;
    /* Live play only: the Watch has no Play button, so there is nothing to
       hand it before the round is under way (the bridge refuses it anyway). */
    var hasRound = !!(scene && scene.roundId && scene.flow === "live");
    var present = !!(surface && surface.watch && surface.watch.appInstalled);
    var reachable = !!(surface && surface.watch && surface.watch.reachable);
    var driving = !!(surface && surface.active === "watch");

    var button = el("watchHandoverBtn");
    show(button, hasRound && present && !driving);
    if (button) {
      button.classList.toggle("unreachable", !reachable);
      button.title = reachable ? "Send this round to your Apple Watch" : "Watch not reachable right now";
    }

    var screen = el("watchHandoverScreen");
    show(screen, driving);
    if (!driving) { offeredSince = null; if (reminder) { clearTimeout(reminder); reminder = null; } return; }

    var handover = surface.handover || {};
    if (handover.state === "offered") {
      if (!offeredSince) {
        offeredSince = Date.now();
        /* The wait has a shape: after a while, silence from the wrist is
           itself worth saying. One timer, cleared the moment the answer lands. */
        reminder = setTimeout(function () { reminder = null; if (watch) render(watch.scene()); }, OFFER_PATIENCE_MS + 50);
      }
    } else {
      offeredSince = null;
      if (reminder) { clearTimeout(reminder); reminder = null; }
    }

    var hole = el("watchHandoverHole");
    if (hole) {
      var number = scene.hole && scene.hole.number;
      var par = scene.hole && scene.hole.par;
      hole.textContent = number ? ("Hole " + number + (par ? " · Par " + par : "")) : "";
    }
    var distance = el("watchHandoverDistance");
    if (distance) distance.textContent = units(scene.distance && scene.distance.centre);
    var unit = el("watchHandoverUnit");
    if (unit) {
      var settings = window.ClarityApp && window.ClarityApp.gpsSettings;
      unit.textContent = settings && settings.unitLabel ? settings.unitLabel() : "m";
    }
    var status = el("watchHandoverStatus");
    if (status) status.textContent = statusFor(surface, reachable);
    if (screen) screen.classList.toggle("confirmed", handover.state === "confirmed");
  }

  api.attach = function (bridge) {
    if (!bridge || typeof bridge.onScene !== "function" || typeof bridge.handToWatch !== "function") return false;
    watch = bridge;
    var button = el("watchHandoverBtn");
    if (button && !button.dataset.wired) {
      button.dataset.wired = "1";
      button.addEventListener("click", function () { api.handToWatch(); });
    }
    var back = el("watchHandoverBack");
    if (back && !back.dataset.wired) {
      back.dataset.wired = "1";
      back.addEventListener("click", function () { api.takeBack(); });
    }
    bridge.onScene(render);
    render(bridge.scene());
    return true;
  };
  api.handToWatch = function () { return !!(watch && watch.handToWatch()); };
  api.takeBack = function () { return !!(watch && watch.takeBack()); };
})(window);
