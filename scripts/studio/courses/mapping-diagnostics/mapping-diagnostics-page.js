/* Clarity Studio — Mapping Diagnostics page. Studio-only, composition-only.
 *
 * Hosts the same #gdAdminDatabasePanel node (see course-database-page.js), with a persistent
 * "View diagnostics" button that sets the Debug tab — that is where scripts/gd-course-mapping-
 * debug.js's admin panel and scripts/studio/gd-course-play-debug.js's pipeline table already
 * render once a course is selected, both unmodified, both still targeting their original fixed
 * ids, which now simply live wherever the reparented node currently is.
 *
 * The button is persistent rather than one-shot because the legacy course-table row markup
 * hardcodes onclick="...gdAdminCourseDbOpen(id,'overview')" — selecting ANY course always resets
 * the tab to Overview, clobbering a tab set before a course was picked. Real finding, not a
 * hypothetical: confirmed by reading gdAdminCourseDbOpen's row markup in gd-admin-course-db.js.
 *
 * Known limitation carried over from the legacy code (not introduced by this branch): live
 * refresh for the embedded mapping-debug/pipeline-debug panels is driven by 2 CustomEvent
 * listeners + a 2200ms interval in gd-course-play-debug.js and gd-course-mapping-debug.js, all
 * gated on `#developerPanel.open`. Since this page is not `#developerPanel`, those do not fire;
 * this page's own poll (via GDStudioCourseDbHost) covers the Course Database summary/list, but
 * the embedded debug sub-panels only refresh on that poll's full gdRenderAdminCourseDatabase()
 * call, not on their own event-driven schedule. See CLARITY_STUDIO_WIRING_COMPARISON.md. */
(function () {
  "use strict";

  function render(containerEl) {
    var intro = document.createElement("div");
    intro.className = "gdStudioLede";
    intro.style.marginBottom = "14px";
    intro.innerHTML =
      "<p>Select a course below, then use the button to view its mapping-attempt evidence and " +
      "course-play pipeline debug timeline. Observational only — nothing here chooses the next " +
      "mapping tool.</p>";

    var jumpRow = document.createElement("div");
    jumpRow.style.marginBottom = "14px";
    var jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "gdStudioDiagramBtn";
    jumpBtn.textContent = "View diagnostics for selected course";
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
  window.GDStudioPages["mapping-diagnostics"] = render;
})();
