/* Clarity Studio — System / Feature Controls page. Studio-only, composition-only.
 *
 * Reparents the real #devTuningControls node (scripts/gd-app-core.js's renderDevPanel(), driven
 * by DEV_DEFS/DEV_FIELDS) out of #developerPanel — numeric tuning across Shot Engine, Shot
 * Visuals, GPS Behaviour, Live Wind, Wand Integration, Bubble Geometry, and more. Several fields
 * are literal 0/1 toggles that function as feature flags even though this isn't a formal flag
 * registry — it's the closest real thing to "Feature Controls" in this codebase, not a
 * fabricated screen. Unmodified code.
 *
 * #devTuningControls starts EMPTY — it's only filled by renderDevPanel() (normally triggered
 * when #developerPanel opens), not self-populating like #clarityBackupCard. Confirmed by
 * testing: without this, the reparented container renders but stays blank. renderDevPanel()
 * also happens to refresh several other reparent-safe panels (Course Database, mapping debug,
 * launch monitor) as a side effect — harmless, idempotent, same pattern used elsewhere. */
(function () {
  "use strict";

  function render(containerEl) {
    var intro = document.createElement("div");
    intro.className = "gdStudioLede";
    intro.style.marginBottom = "14px";
    intro.innerHTML =
      "<p>Developer tuning fields — the same controls the legacy Admin Settings panel shows. " +
      "Not a formal feature-flag system; several fields are 0/1 values that act like toggles " +
      "(GPS behaviour, live wind, wand debug overlay, auto-next-shot, and more).</p>";

    var hostSlot = document.createElement("div");
    containerEl.appendChild(intro);
    containerEl.appendChild(hostSlot);

    if (!window.GDStudioDevPanelHost) {
      hostSlot.innerHTML = '<p class="gdStudioMuted">Dev panel host module did not load.</p>';
      return null;
    }
    var cleanup = window.GDStudioDevPanelHost.mount(hostSlot, "#devTuningControls");
    if (typeof window.renderDevPanel === "function") window.renderDevPanel();
    return cleanup;
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["system-feature-controls"] = render;
})();
