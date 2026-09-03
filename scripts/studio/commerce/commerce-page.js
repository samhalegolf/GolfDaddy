/* Clarity Studio — Commerce page. Studio-only, jump-button only, no reimplementation.
 *
 * The real admin surface is renderAdminSettings() in scripts/clarity-payments.js (product
 * list/edit, webhook + membership diagnostics, free-pass issuance, entitlement viewer, manual
 * grant, permission-resolver tester) — gated role==="admin" only (not coach), rendered at the
 * bottom of the Payments section of Player Settings. It has no independent DOM to reparent (it's
 * appended inline inside #playerSettingsPanel's sheet by clarity-payments.js's own render()), so
 * this page opens the real screen the same way the app's own "Open Membership" button does,
 * rather than duplicating ~1200 lines of billing UI.
 *
 * ---- why this steps aside instead of out-stacking the panel ----
 *
 * This page used to raise #playerSettingsPanel above the Studio shell with an inline
 * z-index, which is what it was reported for. That style is permanent for the session, so
 * from then on EVERY later open of the app's ORDINARY Settings - its own Settings button,
 * gdPanelBack returning to it, the payments card's own "‹ Settings" back link - painted the
 * general settings menu on top of Studio with Studio's nav sealed underneath and unclickable.
 * And because gd67OpenMembershipSettings() opens the panel on the MENU first and only jumps to
 * Access & Membership on a setTimeout(…, 0), "general app settings, nothing responds" is also
 * what a raised panel looks like for any tick that jump has not landed. Meanwhile a panel
 * opened by any route that did NOT run the bump sat at 3900, below the shell: open, invisible,
 * with every click going to Studio.
 *
 * The shell now outranks the app outright, and the jump goes through GDStudioHandoff: Studio
 * steps aside, the real screen owns the whole viewport at its own natural z-index, and Studio
 * comes back when it closes. One outcome instead of three. */
(function () {
  "use strict";

  function render(containerEl) {
    var canOpen = typeof window.gd67OpenMembershipSettings === "function";
    containerEl.innerHTML =
      '<div class="gdStudioPlaceholder">' +
      "<p>Commerce admin (Stripe/webhook status, product list + edit, membership diagnostics, " +
      "free-pass issuance, entitlement viewer, manual grants, permission-resolver test) lives " +
      "inside Player Settings → Access &amp; Membership. It only renders for role===\"admin\" " +
      "(coach does not qualify here, unlike most other admin surfaces in this app).</p>" +
      '<p><button type="button" class="gdStudioDiagramBtn" id="gdStudioOpenCommerceAdmin"' +
      (canOpen ? "" : " disabled") + ">Open Commerce Admin (Payments)</button></p>" +
      (canOpen ? "" : '<p class="gdStudioNeedsVerification">gd67OpenMembershipSettings() was not found on this build.</p>') +
      '<p class="gdStudioMuted" id="gdStudioCommerceHandoffNote" hidden>Studio is out of the way while the ' +
      "Payments screen is open. Close that screen and Studio comes back here.</p>" +
      "</div>";

    var handoff = null;

    var btn = containerEl.querySelector("#gdStudioOpenCommerceAdmin");
    if (btn && canOpen) btn.addEventListener("click", function () {
      var note = containerEl.querySelector("#gdStudioCommerceHandoffNote");
      if (note) note.hidden = false;
      if (handoff) handoff();
      handoff = window.GDStudioHandoff.to({
        open: function () { window.gd67OpenMembershipSettings(); },
        onReturn: function () { if (note) note.hidden = true; }
      });
    });

    return function () { if (handoff) handoff(); };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["commerce"] = render;
})();
