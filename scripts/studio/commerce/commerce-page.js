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
 * #playerSettingsPanel uses the bare `.panel` class (z-index 3900, styles/inline/gd-app-
 * base.css:149) with no higher override — unlike the other Studio jump targets (#dataHubPanel's
 * .gdShotDataPanel.open hits 100200, #gdProfileV67 is 7600), it would render BELOW the Studio
 * shell (#gdStudioShellRoot, z-index 4000) and be invisible. Confirmed by testing, not assumed.
 * Fixed here with a scoped inline z-index bump on the one element, rather than touching the
 * shared production CSS rule that every `.panel`-classed screen in the app depends on. */
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
      "</div>";

    var btn = containerEl.querySelector("#gdStudioOpenCommerceAdmin");
    if (btn && canOpen) btn.addEventListener("click", function () {
      window.gd67OpenMembershipSettings();
      var panel = document.getElementById("playerSettingsPanel");
      if (panel) panel.style.zIndex = "4500";
    });
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["commerce"] = render;
})();
