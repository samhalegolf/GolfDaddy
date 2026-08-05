/* Clarity Studio — Players & Coaches page. Studio-only, jump-button only, no reimplementation.
 *
 * The real admin surfaces are coachAdminPanel()/coachPanel() in
 * scripts/inline/gd-auth-account-shell.js, rendered inline as <details> blocks inside the
 * Profile screen (#gdProfileV67, created dynamically — not present in static index.html).
 * coachAdminPanel (role==="admin" only) shows an all-users roster and coach-account management;
 * coachPanel (admin or coach) shows a linked-players roster and a coach-invite QR flow. Both
 * render unconditionally as part of the normal profile view — there is no separate "admin tab"
 * toggle to call, just opening the profile is enough. This page opens that real screen rather
 * than duplicating account/roster management. */
(function () {
  "use strict";

  function render(containerEl) {
    var canOpen = typeof window.gdOpenProfileV67 === "function";
    containerEl.innerHTML =
      '<div class="gdStudioPlaceholder">' +
      "<p>Player and coach account management (all-users roster, coach-account creation, " +
      "linked-player roster, coach-invite QR flow) lives inside the Profile screen's Coaching " +
      "Portal view, not a separate admin screen. Admins see user + coach management; coaches " +
      "see their linked players and an invite flow.</p>" +
      '<p><button type="button" class="gdStudioDiagramBtn" id="gdStudioOpenPlayersCoaches"' +
      (canOpen ? "" : " disabled") + ">Open Profile (Coaching Portal)</button></p>" +
      (canOpen ? "" : '<p class="gdStudioNeedsVerification">gdOpenProfileV67() was not found on this build.</p>') +
      "</div>";

    var btn = containerEl.querySelector("#gdStudioOpenPlayersCoaches");
    if (btn && canOpen) btn.addEventListener("click", function () { window.gdOpenProfileV67(); });
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["players-coaches"] = render;
})();
