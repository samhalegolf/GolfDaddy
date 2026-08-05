/* Clarity Studio — Publishing page. Studio-only, documentation + redirect (no fake release system).
 *
 * Real finding from this branch's recon: publish/build/reset/revert/recapture actions are
 * buttons embedded inside the SAME visual-tuning tab that Course Visuals hosts
 * (gdAdminCourseVisualControls' action field, scripts/studio/gd-admin-course-db.js:1913-1927) —
 * there is no separate legacy "publishing" tab to reparent independently. Rather than fabricate
 * a second live copy of that DOM (which would collide with Course Visuals' copy — see
 * course-database-page.js's reparenting note), this page names the real actions and links to
 * where they actually live. There is no release-history system in this codebase yet, so
 * Readiness/Current Release/Draft Changes/History are not presented as if they exist. */
(function () {
  "use strict";

  var ACTIONS = [
    { name: "gdAdminCourseVisualBuildBasic", purpose: "Build the basic (untuned) visual." },
    { name: "gdAdminCourseVisualBuildPreview", purpose: "Build a tuned preview from the current recipe." },
    { name: "gdAdminCourseVisualRecapture", purpose: "Re-run capture for the current course." },
    { name: "gdAdminCourseVisualPublish", purpose: "Publish the current build to production." },
    { name: "gdAdminCourseVisualResetPublished", purpose: "Reset the published state." },
    { name: "gdAdminCourseVisualRevert", purpose: "Revert to the previously published asset." }
  ];

  function render(containerEl) {
    var goBtn = '<button type="button" class="gdStudioDiagramBtn" id="gdStudioPublishingGoVisuals">Open Course Visuals</button>';
    containerEl.innerHTML =
      '<div class="gdStudioPlaceholder">' +
      "<p>Publish, reset, and revert actions are real and already exist — they are buttons " +
      "inside the Course Visuals tuning tab, not a separate screen in the legacy code. This " +
      "branch does not invent a release-history system (no Readiness/Current Release/Draft " +
      "Changes/History tabs) since none exists yet; a future branch that adds one should wire " +
      "it here.</p>" +
      "<div><strong>Real actions, and where they live</strong><ul>" +
      ACTIONS.map(function (a) {
        return "<li><code>" + a.name + "</code> — " + a.purpose + "</li>";
      }).join("") +
      "</ul></div>" +
      "<p>" + goBtn + "</p>" +
      "</div>";

    var go = containerEl.querySelector("#gdStudioPublishingGoVisuals");
    if (go) go.addEventListener("click", function () {
      if (window.GDStudioRouter) window.GDStudioRouter.go("course-visuals");
    });
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["publishing"] = render;
})();
