/* Clarity Studio — GPS Play / Shot Planning page. Studio-only, composition-only.
 *
 * Documents the flag/pin placement tool (scripts/gd-flag-pin.js, do not move) and provides a
 * direct jump into the Bubble Geometry tuning group — the real adjustment surface for the GPS
 * shot-pattern bubble (see the gps-bubble-projection registry record for the engine itself).
 *
 * Reuses GDStudioDevPanelHost to reparent the same #devTuningControls node System > Feature
 * Controls uses (only one page can host it at a time, same tradeoff already accepted for the
 * Courses pages sharing #gdAdminDatabasePanel), but pre-selects activeDevGroup="bubbleGeometry"
 * (a top-level `let` in gd-app-core.js, plain global scope, settable by name from here) before
 * calling renderDevPanel(), so this lands directly on the bubble sliders instead of whatever
 * group was last selected. */
(function () {
  "use strict";

  function render(containerEl) {
    var intro = document.createElement("div");
    intro.className = "gdStudioLede";
    intro.style.marginBottom = "14px";
    intro.innerHTML =
      "<p>Flag/pin placement (on-course, do not confuse with a feature-flag system) lives in " +
      "gd-flag-pin.js. The GPS shot-pattern bubble's tunable geometry — width/depth scale, " +
      "tilt scale/max, display clamps — is below.</p>";

    var hostSlot = document.createElement("div");
    containerEl.appendChild(intro);
    containerEl.appendChild(hostSlot);

    if (!window.GDStudioDevPanelHost) {
      hostSlot.innerHTML = '<p class="gdStudioMuted">Dev panel host module did not load.</p>';
      return null;
    }
    try { activeDevGroup = "bubbleGeometry"; } catch (e) {}
    var cleanup = window.GDStudioDevPanelHost.mount(hostSlot, "#devTuningControls");
    if (typeof window.renderDevPanel === "function") window.renderDevPanel();
    return cleanup;
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["gps-shot-planning"] = render;
})();
