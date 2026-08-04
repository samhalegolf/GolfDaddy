/* Clarity Studio — Course Mapping page (Mapping Workspace). Studio-only, composition-only.
 *
 * v1 groups Course Mapping's registry subsections (Location Resolution, OSM Scan, Geometry
 * Resolution, Hole Labelling, Manual Mapping, Validation, Mapping Attempts) into one workspace,
 * per the task's explicit allowance — the navigation/registry already recognize them separately
 * (see studio-registry.js), this page just doesn't give each its own screen yet.
 *
 * It hosts the same #gdAdminDatabasePanel node as Course Database (see course-database-page.js
 * for why), defaulted to the Overview tab because that is where the real location edit/remove
 * controls (gdAdminCourseLocationMarkup) already live — that code stays physically inside
 * gd-admin-course-db.js because dev/course-location-behavior.test.js pins its exact location.
 * A jump button surfaces the Debug tab, which is where Mapping Diagnostics + Mapping Attempts
 * evidence (scripts/gd-course-mapping-debug.js) render once a course is selected. */
(function () {
  "use strict";

  function render(containerEl) {
    var intro = document.createElement("div");
    intro.className = "gdStudioLede";
    intro.style.marginBottom = "14px";
    intro.innerHTML =
      "<p>Mapping Workspace — select a course below to review its location, then use " +
      "<strong>Jump to Mapping Diagnostics</strong> once selected to see attempt evidence " +
      "for that course. Location edit/remove and mapping diagnostics are the same live code " +
      "used by the legacy Admin Settings panel, just hosted here.</p>";

    var jumpRow = document.createElement("div");
    jumpRow.style.marginBottom = "14px";
    var jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "gdStudioDiagramBtn";
    jumpBtn.textContent = "Jump to Mapping Diagnostics";
    jumpBtn.addEventListener("click", function () {
      if (typeof window.gdAdminCourseDbSetTab === "function") window.gdAdminCourseDbSetTab("debug");
    });
    jumpRow.appendChild(jumpBtn);

    var hostSlot = document.createElement("div");

    containerEl.appendChild(intro);
    containerEl.appendChild(jumpRow);
    containerEl.appendChild(hostSlot);

    if (!window.GDStudioCourseDbHost) {
      hostSlot.innerHTML = '<p class="gdStudioMuted">Course Database host module did not load.</p>';
      return null;
    }
    return window.GDStudioCourseDbHost.mount(hostSlot, { tab: "overview" });
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["course-mapping"] = render;
})();
