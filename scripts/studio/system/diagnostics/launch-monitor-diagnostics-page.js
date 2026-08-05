/* Clarity Studio — System / Diagnostics page. Studio-only, composition-only.
 *
 * Reparents the real .gdLmAdmin card (Launch Monitor Intake Test) out of #developerPanel.
 * gdRenderLaunchMonitorAdmin() (scripts/gd-app-core.js) is normally only triggered by
 * renderDevPanel() when #developerPanel opens — since this page may be the first thing to
 * reparent the card without #developerPanel ever having been opened, it also calls that
 * render function once directly (same unmodified function, just invoked explicitly) so the
 * result area isn't blank on first visit. */
(function () {
  "use strict";

  function render(containerEl) {
    var intro = document.createElement("div");
    intro.className = "gdStudioLede";
    intro.style.marginBottom = "14px";
    intro.innerHTML = "<p>Admin-only test lane for captured practice data — the same card the legacy Admin Settings panel shows.</p>";

    var hostSlot = document.createElement("div");
    containerEl.appendChild(intro);
    containerEl.appendChild(hostSlot);

    if (!window.GDStudioDevPanelHost) {
      hostSlot.innerHTML = '<p class="gdStudioMuted">Dev panel host module did not load.</p>';
      return null;
    }
    var cleanup = window.GDStudioDevPanelHost.mount(hostSlot, ".gdLmAdmin");
    if (typeof window.gdRenderLaunchMonitorAdmin === "function") window.gdRenderLaunchMonitorAdmin();
    return cleanup;
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["system-diagnostics"] = render;
})();
