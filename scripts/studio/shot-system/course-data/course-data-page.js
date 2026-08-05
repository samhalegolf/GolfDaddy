/* Clarity Studio — Course Data page. Studio-only, jump-button only, no reimplementation.
 *
 * The real admin surface is the .gdCourseAdminExpander button + #gdCourseDataAdminPanel inside
 * #statsPanel ("Shot Data"), gated gdCourseDataCanManage() (admin or coach) — raw upload block,
 * tuning fields, and a sandbox data generator (scripts/gd-route-audit.js's local
 * gdRenderCourseDataAdminPanel, which wins over the simpler one in gd-app-core.js since
 * gd-route-audit.js's window export runs later — see the branch's research notes if this
 * needs re-deriving). window.gdOpenCourseData({adminTab:true}) is the exact function the
 * app's own "Open Course Data" flow uses to reach it, reparenting #statsPanel into the Data
 * Hub's course accordion section the same way Practice Data reparents #practiceDataPanel. */
(function () {
  "use strict";

  function render(containerEl) {
    var canOpen = typeof window.gdOpenCourseData === "function";
    containerEl.innerHTML =
      '<div class="gdStudioPlaceholder">' +
      "<p>Course Data's admin tools (raw upload, tuning fields, sandbox data generator — this " +
      "one injects fake course/practice shots into live storage, careful) live inside the Shot " +
      "Data screen's Admin expander, gated to admin or coach permission.</p>" +
      '<p><button type="button" class="gdStudioDiagramBtn" id="gdStudioOpenCourseDataAdmin"' +
      (canOpen ? "" : " disabled") + ">Open Course Data (admin view)</button></p>" +
      (canOpen ? "" : '<p class="gdStudioNeedsVerification">gdOpenCourseData() was not found on this build.</p>') +
      "</div>";

    var btn = containerEl.querySelector("#gdStudioOpenCourseDataAdmin");
    if (btn && canOpen) btn.addEventListener("click", function () { window.gdOpenCourseData({ adminTab: true }); });
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["shot-system-course-data"] = render;
})();
