/* 3D view: the hole on screen as a 3D model you can walk round, opened from the cube on the
   tool rail. View only - nothing is played from here; closing it is straight back to Play.

   The scene, camera and touch input are gd-course-3d.js (the same viewer Clarity Studio's
   3D Course Viewer uses). This owns the screen around it: opening on the hole the painter has
   up, the Photo / Illustrated switch, the preset views and the way back.

   It opens in the player's GPS Settings map style and switching here does not change that
   setting: the 2D picture they play on is theirs to choose in Settings. Relief follows the
   Terrain relief setting; with relief off it stands at true scale, since a flat model is just
   a worse copy of the picture they already have.

   Only a hole with a picture under it (published, or a live terrain frame) can stand up. On
   the live map there is nothing to drape, and the screen says so rather than not opening. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  var viewer = null;
  var canvas = null;
  var hole = null;      // what the painter handed over on opening
  var style = "photo";

  function el(id) { return document.getElementById(id); }
  function t(key) { return window.GDI18n ? window.GDI18n.t(key) : key; }

  /* One line under the top bar: loading, a note about this hole, or how to drive it. */
  function status(key) {
    var node = el("view3dStatus");
    if (!node) return;
    if (window.GDI18n) window.GDI18n.set(node, key || "");
    else node.textContent = key || "";
    node.classList.toggle("hiddenState", !key);
  }
  function hint() {
    status(viewer && viewer.mode() === "walk" ? "threeD.walkHint" : "threeD.hint");
  }

  function showControls(on) {
    ["view3dStyle", "view3dViews"].forEach(function (id) {
      var node = el(id);
      if (node) node.classList.toggle("hiddenState", !on);
    });
  }

  function markStyle() {
    var group = el("view3dStyle");
    if (!group) return;
    Array.prototype.forEach.call(group.querySelectorAll("[data-style]"), function (b) {
      b.setAttribute("aria-pressed", b.dataset.style === style ? "true" : "false");
    });
  }

  function markMode(mode) {
    var btn = el("view3dMode");
    if (btn && window.GDI18n) window.GDI18n.set(btn, mode === "walk" ? "threeD.orbit" : "threeD.walk");
  }

  /* "From here" only means something with a position on this hole. */
  function markHere() {
    var btn = el("view3dHere");
    if (btn) btn.classList.toggle("hiddenState", !(app.marshal && app.marshal.player()));
  }

  function relief() {
    var s = app.gpsSettings;
    var factor = s && s.reliefExaggeration ? s.reliefExaggeration() : 2.5;
    return factor > 0 ? factor : 1;
  }

  function load(keepView) {
    if (!viewer || !hole) return;
    status("threeD.loading");
    markStyle();
    viewer.load({
      holeNumber: hole.holeNumber,
      meta: hole.meta,
      frameUrl: hole.frameUrl,
      elevationUrl: hole.elevationUrl,
      tee: hole.tee,
      green: hole.green,
      style: style,
      course: function () { return { pkg: hole.pkg, surfaces: hole.surfaces }; }
    }, keepView).then(function (built) {
      if (!built) return;
      if (built.illustratedUnavailable) status("threeD.illustratedUnavailable");
      else hint();
    }).catch(function (error) {
      status("threeD.failed");
      report(error);
    });
  }

  /* A device that will not build the scene is worth hearing about from the field. */
  function report(error) {
    try {
      if (window.ClarityErrorReporter && window.ClarityErrorReporter.report) {
        window.ClarityErrorReporter.report(error, { source: "view-3d", hole: hole ? hole.holeNumber : null });
      }
    } catch (e) {}
  }

  function open() {
    if (app.toolRail) app.toolRail.close();
    var screen = el("view3dScreen"), stage = el("view3dStage");
    if (!screen || !stage) return;
    close();
    screen.classList.remove("hiddenState");
    hole = app.painter && app.painter.view3d ? app.painter.view3d() : null;
    if (!hole || !window.GDCourse3D) {
      showControls(false);
      status("threeD.unavailable");
      return;
    }
    style = app.gpsSettings && app.gpsSettings.mapStyle ? app.gpsSettings.mapStyle() : "photo";
    canvas = document.createElement("canvas");
    canvas.className = "view3dCanvas";
    stage.appendChild(canvas);
    try {
      viewer = window.GDCourse3D.createViewer(stage, canvas, { exaggeration: relief(), onMode: markMode });
    } catch (error) {
      close();
      screen.classList.remove("hiddenState");
      showControls(false);
      status("threeD.failed");
      report(error);
      return;
    }
    showControls(true);
    markMode("orbit");
    markHere();
    load(false);
  }

  /* Gives the GPU back: the scene holds the hole's textures and every tree model built. */
  function close() {
    if (viewer) viewer.dispose();
    viewer = null;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    canvas = null;
    hole = null;
    var screen = el("view3dScreen");
    if (screen) screen.classList.add("hiddenState");
  }

  function isOpen() {
    var screen = el("view3dScreen");
    return !!(screen && !screen.classList.contains("hiddenState"));
  }

  /* A preset that has nothing to stand on goes overhead and says why. */
  function preset(ok, failKey) {
    if (ok) hint();
    else status(failKey);
  }

  app.view3d = { open: open, close: close, isOpen: isOpen };

  document.addEventListener("DOMContentLoaded", function () {
    var railBtn = el("railView3d");
    if (railBtn) railBtn.addEventListener("click", open);
    var closeBtn = el("view3dClose");
    if (closeBtn) closeBtn.addEventListener("click", close);

    var group = el("view3dStyle");
    if (group) group.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest("[data-style]") : null;
      if (!btn || !viewer || btn.dataset.style === style) return;
      style = btn.dataset.style;
      load(true);
    });

    function wire(id, fn) {
      var btn = el(id);
      if (btn) btn.addEventListener("click", function () { if (viewer) fn(); });
    }
    wire("view3dOverhead", function () { viewer.viewOverhead(); hint(); });
    wire("view3dTee", function () { preset(viewer.viewTee(), "threeD.noTee"); });
    wire("view3dGreen", function () { preset(viewer.viewGreen(), "threeD.noGreen"); });
    wire("view3dHere", function () {
      var pin = app.pin && app.pin.current();
      preset(viewer.viewFrom(app.marshal && app.marshal.player(), pin), "threeD.notHere");
    });
    wire("view3dMode", function () { viewer.toggleMode(); hint(); });
  });
})();
