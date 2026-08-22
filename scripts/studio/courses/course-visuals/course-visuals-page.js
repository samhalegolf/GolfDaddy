/* Clarity Studio — Course Visuals page. Studio-only, composition-only.
 *
 * Hosts the same #gdAdminDatabasePanel node as Course Database (see course-database-page.js for
 * the reparenting rationale). Real finding from this branch's recon: the full visual-tuning tab
 * (gdAdminCourseVisualMarkup — recipe controls, build/publish/reset/revert actions) is fully
 * implemented and dispatch-ready in gdRenderAdminCourseDatabase, but has NO reachable button in
 * the legacy panel's action rail (only "Visual Engine", which opens the lighter phone-sandbox
 * preview tab). This page is the first place that tab is actually reachable by clicking. */
(function () {
  "use strict";

  function render(containerEl) {
    var intro = document.createElement("div");
    intro.className = "gdStudioLede";
    intro.style.marginBottom = "14px";
    intro.innerHTML =
      "<p>Select a course below, then use the buttons here to open its Visual Engine tuning " +
      "(recipe controls + build/publish actions) or the lighter preview sandbox. Both render " +
      "the same live code the legacy Admin Settings panel uses.</p>" +
      "<p>The <strong>Recipe</strong> tool in the tuning dock is where the active recipe is " +
      "chosen. Whatever is active there is the treatment the worker applies to the next course " +
      "through the pipeline, and <strong>Update this course</strong> re-bakes the selected " +
      "course with it.</p>";

    var jumpRow = document.createElement("div");
    jumpRow.style.marginBottom = "14px";
    jumpRow.style.display = "flex";
    jumpRow.style.gap = "8px";

    function jumpButton(label, tab) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gdStudioDiagramBtn";
      btn.textContent = label;
      btn.addEventListener("click", function () {
        if (typeof window.gdAdminCourseDbSetTab === "function") window.gdAdminCourseDbSetTab(tab);
      });
      return btn;
    }

    jumpRow.appendChild(jumpButton("Open Visual Engine tuning", "visuals"));
    jumpRow.appendChild(jumpButton("Open preview sandbox", "preview"));

    /* The recipe area only exists inside the tuning dock, which only exists on the preview
       screen - so this opens both in one click rather than describing where to find it. */
    var recipeBtn = document.createElement("button");
    recipeBtn.type = "button";
    recipeBtn.className = "gdStudioDiagramBtn";
    recipeBtn.textContent = "Open recipe + update";
    recipeBtn.addEventListener("click", function () {
      if (typeof window.gdAdminCourseDbSetTab === "function") window.gdAdminCourseDbSetTab("preview");
      if (typeof window.gdAdminCourseVisualOpenRecipeTool === "function") window.gdAdminCourseVisualOpenRecipeTool();
    });
    jumpRow.appendChild(recipeBtn);

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
  window.GDStudioPages["course-visuals"] = render;
})();
