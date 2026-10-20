/* Clarity Studio - Apple Watch Preview: the shared watch preview page (watch-preview-page.js)
 * with the Apple Watch's face (apple-watch-render.js, the port of
 * ios/App/ClarityCaddyWatch/AimableHoleMap.swift).
 *
 * What is the Apple Watch's here: the image package (the phone pushes it the picture, never a
 * drawn map), the one 96 px tree sprite per type scaled at draw time, points on a 2x panel,
 * and its gestures - a tap places the target and sends it, a press held 0.2 s then dragged
 * carries it, the Digital Crown (the mouse wheel here) zooms, and a locked shot brings up the
 * UNLOCK band, split Unlock | Reset once the Bubble has moved. LOCK stands in for the phone
 * locking the shot. */
(function () {
  "use strict";

  function options() {
    var R = window.GDAppleWatchRender;
    if (!R) return null;
    return {
      key: "apple",
      label: "Apple Watch",
      render: R,
      Face: R.AppleAppView,
      deviceId: "s10-46",
      lede: "The Apple Watch app's driving face, beside the aerial it plays over. It opens on the <strong>numbers</strong>; <strong>AIM</strong> (or LOCK below) locks the shot and flips to the map, a swipe left looks at the map without locking, a quick swipe right goes back - which is the unlock. " +
        "<strong>Tap the aerial</strong> to put the player there - the face takes it as its GPS fix. On the map, <strong>tap</strong> to aim there, or <strong>press, hold and drag</strong> to carry the aim; the <strong>wheel</strong> is the Digital Crown. " +
        "Nothing here writes anything: the AIM_AT the watch would send is only reported below the face.",
      packages: "image",
      pictureFormat: "",
      modes: null,
      deviceLine: function () { return "points on a 2x panel"; },
      fontsNote: "SF Rounded approximated by the browser's rounded sans; the band is drawn where SwiftUI lays it out.",
      /* The one sprite per type the watch ships (ios/App/ClarityCaddyWatch/Assets.xcassets). */
      spriteBitmap: function (onLoad) {
        return function (type) {
          var name = R.TREE_NAMES[type];
          return window.GDWatchPreviewPage.spriteImage("/ios/App/ClarityCaddyWatch/Assets.xcassets/" + name + ".imageset/" + name + ".png", onLoad);
        };
      },
      /* The hub's linked drag: another device's aim, held in WatchPlayState as the wrist holds
         its own. No finger is on this glass, so the camera follows the shot (settle's framing)
         rather than staying put. */
      mirrorAim: function (face, coordinate, phase) {
        face.moveTarget(coordinate);
        face.camera = face.restingCamera();
        face.aiming = face.dragActive = phase !== "end";
      },
      /* A lock lands on the map; the unlock (WatchSessionManager.unlock -> face.unlock) has
         already put the numbers back up. */
      onLockChange: function (face, locked) { if (locked) face.lock(); },
      buttons: [
        { id: "lock", label: function (face, session) { return session.locked ? "UNLOCK" : "LOCK"; }, title: "The phone locks the shot (the band comes up) / the watch's UNLOCK",
          act: function (face, session, watchSession) { if (session.locked) watchSession.unlock(); else if (watchSession.scene.canLock()) { watchSession.lock(); face.lock(); } } },
        { id: "page", label: function (face) { return face && face.showingMap ? "NUMBERS" : "MAP"; }, title: "Swipe between the numbers and the map (swiping back to the numbers is the unlock)",
          act: function (face) { if (face.showingMap) face.backToNumbers(); else face.showMap(); } },
        { id: "plays", label: "PLAYS", title: "The plays button low on the map (tap it on the face too)", act: function (face) { face.togglePlays(); } }
      ]
    };
  }

  function render(containerEl) {
    var opts = options();
    if (!opts) { containerEl.innerHTML = '<p class="gdStudioMuted" style="padding:16px">The Apple Watch renderer did not load on this surface.</p>'; return null; }
    return window.GDWatchPreviewPage.render(containerEl, opts);
  }

  window.GDWatchPreviewPage.define("apple", options);
  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["gps-apple-preview"] = render;
})();
