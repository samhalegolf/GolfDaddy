/* Clarity Studio - Garmin Preview: the shared watch preview page (watch-preview-page.js) with
 * the Garmin's face (garmin-watch-render.js, the port of garmin/source/UI/NumbersView.mc and
 * garmin/source/Maps/GarminMapView.mc, switched as CaddyAppView switches them).
 *
 * What is the Garmin's here: the numbers screen a round opens on, the map behind it, its drawn
 * package first (every Garmin now receives one), the picture the asset proxy re-encodes to JPEG
 * for it, the five-size tree sprite sets, the 64-colour palette on a MIP face, and its buttons
 * as CaddyInputDelegate reads them - SELECT is AIM on the numbers and enters / confirms Aim Mode
 * on the map, BACK cancels or returns to the numbers, MENU swaps the two, UP and DOWN change
 * hole (or nudge while aiming), LAP unlocks a locked shot or locks from the map, the plays
 * button at the foot of the map. */
(function () {
  "use strict";

  /* The numbers are drawn in vector Roboto Condensed Bold, the face the watch asks for first
     (NumbersView.FACES). Loaded once; the face redraws when it arrives. */
  var FONT_HREF = "https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@700&display=swap";
  function loadFont(onReady) {
    if (!document.querySelector('link[href="' + FONT_HREF + '"]')) {
      var link = document.createElement("link");
      link.rel = "stylesheet"; link.href = FONT_HREF;
      document.head.appendChild(link);
    }
    if (document.fonts && document.fonts.load) document.fonts.load("700 40px 'Roboto Condensed'").then(onReady, function () {});
  }

  function options() {
    var R = window.GDGarminWatchRender;
    if (!R) return null;
    return {
      key: "garmin",
      label: "Garmin",
      render: R,
      Face: R.CaddyAppView,
      deviceId: "fenix847mm",
      lede: "The Garmin app's playing face, beside the aerial it plays over. It opens on the <strong>numbers</strong>, as a round does on the wrist; <strong>MENU</strong> (or a swipe left) swaps to the map. " +
        "<strong>Tap the aerial</strong> to put the player there - the face takes it as its GPS fix. On the numbers a tap is AIM, a tap on the wind hub opens the compass and a double-tap or long press folds the wind into the number. " +
        "On the map, <strong>drag on the face</strong> to aim; SELECT confirms, BACK cancels. Nothing here writes anything: what the watch would send is only reported below the face.",
      packages: "garmin-first",
      pictureFormat: "jpeg",
      modes: [{ value: "drawn", label: "Drawn (Garmin package)" }, { value: "picture", label: "Picture (image package)" }],
      mapPalette: function (hole, device) { return R.mapPalette(device.amoled, hole ? R.cleanPalette(hole.palette) : null); },
      deviceLine: function (d) { return (d.amoled ? "AMOLED palette" : "64-colour MIP palette") + (d.patternFill ? "" : " · no pattern fills") + (d.scaledBitmap ? "" : " · picture 1:1 only") + (d.vectorFont ? "" : " · no vector type"); },
      fontsNote: "the numbers use the watch's own vector Roboto Condensed; the map's small bitmap fonts (and the numbers on a watch without vector type) are approximated from the screen size.",
      /* The very PNGs the watch ships (garmin/resources-trees), the AMOLED or the 64-colour set. */
      spriteBitmap: function (onLoad) {
        return function (amoled, type, sizeIndex) {
          var set = amoled ? "amoled" : "mip", size = R.TREE_SIZES[sizeIndex];
          return window.GDWatchPreviewPage.spriteImage("/garmin/resources-trees/drawables/trees/" + set + "/" + R.TREE_TYPES[type] + "_" + size + ".png", onLoad);
        };
      },
      /* The hub's linked drag: another device's aim, held as the Garmin holds its own - in
         GarminPlayState, with AIMING up on the map while the other finger is down. No finger is
         on this face, so the camera reframes onto the shot on the next frame. */
      mirrorAim: function (face, coordinate, phase, watchSession) {
        watchSession.playState.moveTarget(coordinate);
        face.mapView.aiming = phase !== "end";
        face.mapView.camera = null;
      },
      /* Locked, the shot is looked at on the map; unlocked, the numbers - as a round opens. */
      onLockChange: function (face, locked) { if (locked) face.showMap(); else { if (face.mapView.aiming) face.mapView.confirmAim(); face.showNumbers(); } },
      buttons: [
        { id: "select", label: "SELECT", title: "SELECT: AIM on the numbers; enter / confirm Aim Mode on the map", act: function (face) { face.select(); } },
        { id: "back", label: "BACK", title: "BACK: cancel the aim, or back to the numbers", act: function (face) { face.back(); } },
        { id: "menu", label: function (face) { return face && face.showingMap ? "MENU · numbers" : "MENU · map"; }, title: "MENU: swap between the numbers and the map", act: function (face) { face.menu(); } },
        { id: "up", label: "UP", title: "UP: next hole, or nudge the aim up the glass while aiming", act: function (face) { face.up(); } },
        { id: "down", label: "DOWN", title: "DOWN: previous hole, or nudge down while aiming", act: function (face) { face.down(); } },
        { id: "plays", label: "PLAYS", title: "The plays button at the foot of the map (tap it on the face too)", act: function (face) { face.togglePlays(); } },
        { id: "lap", label: "LAP", title: "LAP: UNLOCK a locked shot (or tap the pill's UNLOCK half), or LOCK from the map", act: function (face) { face.lap(); } }
      ],
      onMount: function (redraw) { loadFont(redraw); }
    };
  }

  function render(containerEl) {
    var opts = options();
    if (!opts) { containerEl.innerHTML = '<p class="gdStudioMuted" style="padding:16px">The Garmin renderer did not load on this surface.</p>'; return null; }
    return window.GDWatchPreviewPage.render(containerEl, opts);
  }

  window.GDWatchPreviewPage.define("garmin", options);
  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["gps-garmin-preview"] = render;
})();
