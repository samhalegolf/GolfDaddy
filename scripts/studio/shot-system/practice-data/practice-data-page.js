/* Clarity Studio — Practice Data page. Studio-only, composition-only.
 *
 * Does NOT reimplement the Practice Data screen. The real screen (#practiceDataPanel, embedded
 * in #dataHubPanel) already ships to the Studio build unmarked (it's not data-gd-surface="app" —
 * ships everywhere), and already hides its Admin tab button for player/subscribedPlayer
 * permission via CSS (styles/inline/gd-app-base.css's .gdPracticeAdminExpander rule) — so the
 * "customer route has no admin exposed" behavior the user asked for already exists in the app,
 * it just wasn't documented here before.
 *
 * This page's only job is to open that real screen, in admin mode, from Studio: it calls the
 * existing gdOpenPracticeAdminTab(), which force-opens #dataHubPanel with the Admin tab expanded
 * regardless of current state (scripts/gd-route-audit.js). That panel's effective z-index
 * (.gdShotDataPanel.open, 100200) is well above the Studio shell root (#gdStudioShellRoot,
 * 4000), so it correctly overlays on top when opened from here. */
(function () {
  "use strict";

  function render(containerEl) {
    var canOpen = typeof window.gdOpenPracticeAdminTab === "function";
    containerEl.innerHTML =
      '<div class="gdStudioPlaceholder">' +
      "<p>Practice Data is a real, live app screen (camera/email/OCR import, CSV/text paste), " +
      "not something owned by Studio. It has its own Admin tab — tolerance and gate-tuning " +
      "controls — which the app already hides from regular players and only exposes to admin " +
      "or coach permission. Nested inside that Admin tab is a Studio-only live scan/import " +
      "debug feed, stripped from the phone app entirely and gated to admin permission " +
      "specifically.</p>" +
      "<p>This page does not duplicate any of that — it opens the real screen, in admin mode, " +
      "using the same function the app's own admin chrome uses.</p>" +
      '<p><button type="button" class="gdStudioDiagramBtn" id="gdStudioOpenPracticeAdmin"' +
      (canOpen ? "" : " disabled") + ">Open Practice Data (admin view)</button></p>" +
      (canOpen ? "" : '<p class="gdStudioNeedsVerification">gdOpenPracticeAdminTab() was not found on this build.</p>') +
      "</div>";

    var btn = containerEl.querySelector("#gdStudioOpenPracticeAdmin");
    if (btn && canOpen) btn.addEventListener("click", function () { window.gdOpenPracticeAdminTab(); });
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["practice-data"] = render;
})();
