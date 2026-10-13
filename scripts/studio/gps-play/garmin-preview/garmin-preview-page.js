/* Clarity Studio - Garmin Preview: the shared watch preview page (watch-preview-page.js) with
 * the Garmin's face (garmin-watch-render.js, the port of garmin/source/Maps/GarminMapView.mc).
 *
 * What is the Garmin's here: its drawn package first (every Garmin now receives one), the
 * picture the asset proxy re-encodes to JPEG for it, the five-size tree sprite sets, the
 * 64-colour palette on a MIP face, and its buttons - SELECT enters and confirms Aim Mode,
 * BACK cancels, UP and DOWN nudge for the button watches, the plays button at the foot of the
 * map. */
(function () {
  "use strict";

  function render(containerEl) {
    var R = window.GDGarminWatchRender;
    if (!R) { containerEl.innerHTML = '<p class="gdStudioMuted" style="padding:16px">The Garmin renderer did not load on this surface.</p>'; return null; }
    return window.GDWatchPreviewPage.render(containerEl, {
      key: "garmin",
      render: R,
      deviceId: "fenix847mm",
      lede: "The hole as the Garmin app draws it, beside the aerial it plays over. <strong>Tap the aerial</strong> to put the player there - the face takes it as its GPS fix. " +
        "<strong>Drag on the face</strong> to aim, as a finger does on the glass; SELECT confirms, BACK cancels. Nothing here writes anything: the AIM_AT the watch would send is only reported below the face.",
      packages: "garmin-first",
      pictureFormat: "jpeg",
      modes: [{ value: "drawn", label: "Drawn (Garmin package)" }, { value: "picture", label: "Picture (image package)" }],
      mapPalette: function (hole, device) { return R.mapPalette(device.amoled, hole ? R.cleanPalette(hole.palette) : null); },
      deviceLine: function (d) { return (d.amoled ? "AMOLED palette" : "64-colour MIP palette") + (d.patternFill ? "" : " · no pattern fills") + (d.scaledBitmap ? "" : " · picture 1:1 only"); },
      fontsNote: "fonts approximated from the screen size; the Garmin bitmap fonts are the one thing a browser cannot copy.",
      /* The very PNGs the watch ships (garmin/resources-trees), the AMOLED or the 64-colour set. */
      spriteBitmap: function (onLoad) {
        return function (amoled, type, sizeIndex) {
          var set = amoled ? "amoled" : "mip", size = R.TREE_SIZES[sizeIndex];
          return window.GDWatchPreviewPage.spriteImage("garmin/resources-trees/drawables/trees/" + set + "/" + R.TREE_TYPES[type] + "_" + size + ".png", onLoad);
        };
      },
      buttons: [
        { id: "select", label: "SELECT", title: "SELECT: enter / confirm Aim Mode", act: function (face) { if (face.aiming) face.confirmAim(); else face.enterAimMode(); } },
        { id: "back", label: "BACK", title: "BACK: cancel the aim", act: function (face) { face.cancelAim(); } },
        { id: "up", label: "UP", title: "UP: nudge the aim up the glass while aiming", act: function (face) { face.nudge(0, -R.NUDGE_STEP_IMAGE_PX); } },
        { id: "down", label: "DOWN", title: "DOWN: nudge down", act: function (face) { face.nudge(0, R.NUDGE_STEP_IMAGE_PX); } },
        { id: "plays", label: "PLAYS", title: "The plays button at the foot of the map (tap it on the face too)", act: function (face) { face.togglePlays(); } }
      ]
    });
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["gps-garmin-preview"] = render;
})();
