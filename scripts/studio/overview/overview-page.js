/* Clarity Studio — Overview page. Studio-only. */
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function render(containerEl) {
    var registry = window.GDStudioRegistry;
    var topLevel = registry.navTree.map(function (entry) { return registry.get(entry.id); }).filter(Boolean);

    containerEl.innerHTML =
      '<div class="gdStudioGroupIndex">' +
      "<p class=\"gdStudioLede\">Clarity Studio is organized by what each system does, not by how the old Admin Settings panel evolved. Pick a system on the left. Sections without a dedicated Studio surface yet show a restrained placeholder and the ownership this branch was able to confirm from source.</p>" +
      '<div class="gdStudioCardGrid">' +
      topLevel.map(function (r) {
        return '<button type="button" class="gdStudioCard" data-gd-studio-nav="' + esc(r.id) + '">' +
          '<div class="gdStudioCardLabel">' + esc(r.label) + "</div>" +
          '<div class="gdStudioCardHint">' + esc(r.function || "") + "</div>" +
          "</button>";
      }).join("") +
      "</div></div>";

    containerEl.querySelectorAll("[data-gd-studio-nav]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        window.GDStudioRouter.go(btn.getAttribute("data-gd-studio-nav"));
      });
    });
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages.overview = render;
})();
