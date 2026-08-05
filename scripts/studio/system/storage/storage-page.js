/* Clarity Studio — System / Storage page. Studio-only, composition-only.
 *
 * Reparents the real #clarityBackupCard node (scripts/clarity-backup.js) out of #developerPanel
 * and into this page via GDStudioDevPanelHost — export/import backup, account/profile/local-key
 * counts. Unmodified code; clarity-backup.js's own 1s refresh interval keeps working wherever
 * the card currently lives, since it reads its stats by id, not by fixed parent. */
(function () {
  "use strict";

  function render(containerEl) {
    var intro = document.createElement("div");
    intro.className = "gdStudioLede";
    intro.style.marginBottom = "14px";
    intro.innerHTML = "<p>Local browser data export/import — the same Data Safety card the legacy Admin Settings panel shows.</p>";

    var hostSlot = document.createElement("div");
    containerEl.appendChild(intro);
    containerEl.appendChild(hostSlot);

    if (!window.GDStudioDevPanelHost) {
      hostSlot.innerHTML = '<p class="gdStudioMuted">Dev panel host module did not load.</p>';
      return null;
    }
    return window.GDStudioDevPanelHost.mount(hostSlot, "#clarityBackupCard");
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["system-storage"] = render;
})();
