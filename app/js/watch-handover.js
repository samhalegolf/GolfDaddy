/* The phone's half of a phone <-> Watch handover.

   Marshal keeps owning the round whichever surface is driving. This module
   draws one card in the top-right slot of the play screen, with three lives
   read straight off the CaddyWatchScene's `surface` and the lite-map errand's
   count: it reports the course going across ("Loading course · 7 of 18"), it
   proves readiness by drawing the hole with "Play on Watch", and once the
   Watch is driving it becomes a small phone offering "Play on phone" while a
   mask dims the map. It reads the answer off the Scene rather than remembering
   one of its own, so a takeover started from the wrist and one started here
   look identical. Inert on web, where no native bridge ever reports a Watch. */
(function (window) {
  "use strict";
  var api = window.GDWatchHandover = window.GDWatchHandover || {};
  var watch = null;
  var lastScene = null;

  function el(id) { return document.getElementById(id); }
  function show(node, on) { if (node) node.classList.toggle("hiddenState", !on); }
  function text(id, value) { var node = el(id); if (node) node.textContent = value; }
  function settings() { return window.ClarityApp && window.ClarityApp.gpsSettings || null; }
  function units(m) {
    if (m === null || m === undefined || !Number.isFinite(Number(m))) return "–";
    var s = settings();
    return s && s.toDisplay ? String(s.toDisplay(m)) : String(Math.round(Number(m)));
  }
  function unitLabel() { var s = settings(); return s && s.unitLabel ? s.unitLabel() : "m"; }

  function phaseFor(scene) {
    var surface = scene && scene.surface;
    if (!scene || !scene.roundId || scene.flow !== "live") return null;
    if (!surface || !surface.watch || !surface.watch.appInstalled) return null;
    if (surface.active === "watch") return "playing";
    if (surface.handover && surface.handover.state === "offered") return "handing";
    var maps = surface.watch.maps || {};
    if (maps.total > 0 && maps.have < maps.total) return "uploading";
    return "ready";
  }

  function thumbnail(img, scene) {
    if (!img) return;
    var delivery = window.GDWatchMapDelivery;
    var key = scene.course && scene.course.key;
    var hole = scene.hole && scene.hole.number;
    var src = delivery && typeof delivery.holeImage === "function" && key && hole ? delivery.holeImage(key, hole) : null;
    if (src) { if (img.getAttribute("src") !== src) img.setAttribute("src", src); img.hidden = false; }
    else { img.hidden = true; img.removeAttribute("src"); }
  }

  function render(scene) {
    lastScene = scene;
    var phase = phaseFor(scene);
    var card = el("watchHandoverCard");
    var mask = el("watchHandoverScreen");
    var driving = phase === "playing";
    show(card, !!phase);
    show(mask, driving);
    document.body.classList.toggle("watchCard", !!phase && !driving);
    document.body.classList.toggle("watchCardTall", driving);
    document.body.classList.toggle("watchDriving", driving);
    if (!phase || !card) return;
    if (card.dataset.phase !== phase) card.dataset.phase = phase;
    card.setAttribute("aria-label",
      phase === "uploading" ? "Loading course onto Apple Watch"
        : phase === "ready" ? "Play on Apple Watch"
          : phase === "handing" ? "Handing over to Apple Watch"
            : "Playing on Apple Watch. Play on phone");

    var maps = scene.surface.watch.maps || { total: 0, have: 0 };
    var pct = maps.total > 0 ? Math.round((maps.have / maps.total) * 100) : 0;
    var bar = el("watchHandoverBar");
    if (bar) bar.style.width = pct + "%";
    text("watchHandoverPct", pct + "%");
    text("watchHandoverHoles", maps.have + " of " + maps.total + " holes");

    var number = scene.hole && scene.hole.number;
    var par = scene.hole && scene.hole.par;
    text("watchHandoverHole", number ? "Hole " + number : "Hole");
    text("watchHandoverPar", par ? "PAR " + par : "");
    Array.prototype.forEach.call(document.querySelectorAll(".watchHandoverUnit"), function (node) { node.textContent = unitLabel(); });
    /* Ready shows the hole's own length; Playing shows the shot in front of
       the player, the same number the Watch is showing. */
    text("watchHandoverThumbDist", units(scene.hole && scene.hole.teeToGreenM));
    text("watchHandoverDist2", units(scene.distance && scene.distance.centre));
    thumbnail(el("watchHandoverThumb"), scene);
    thumbnail(el("watchHandoverThumb2"), scene);
  }

  function onCardTap() {
    var phase = phaseFor(lastScene);
    if (phase === "ready") api.handToWatch();
    else if (phase === "playing") api.takeBack();
  }

  api.attach = function (bridge) {
    if (!bridge || typeof bridge.onScene !== "function" || typeof bridge.handToWatch !== "function") return false;
    watch = bridge;
    var card = el("watchHandoverCard");
    if (card && !card.dataset.wired) {
      card.dataset.wired = "1";
      card.addEventListener("click", onCardTap);
    }
    /* A thumbnail fetched after the Scene that wanted it still needs drawing. */
    var delivery = window.GDWatchMapDelivery;
    if (delivery && typeof delivery.onProgress === "function") {
      delivery.onProgress(function () { if (lastScene) render(lastScene); });
    }
    bridge.onScene(render);
    render(bridge.scene());
    return true;
  };
  api.handToWatch = function () { return !!(watch && watch.handToWatch()); };
  api.takeBack = function () { return !!(watch && watch.takeBack()); };
})(window);
