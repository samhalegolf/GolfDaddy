/* Clarity Studio — Course Database page + shared host mount helper. Studio-only.
 *
 * Does NOT duplicate scripts/studio/gd-admin-course-db.js's markup or re-implement any of its
 * ~40 course-database functions. Instead it REPARENTS the existing #gdAdminDatabasePanel node
 * (which already contains #gdAdminCourseDbSearch/Summary/List/Detail, and — once a course's
 * Debug tab is opened — the embedded mapping-diagnostics and course-play-debug panels too) out
 * of the legacy #developerPanel and into whichever Studio page currently wants it, then calls
 * the existing, unmodified gdRenderAdminCourseDatabase() to populate it. On unmount the node is
 * moved back to #developerPanel so the legacy Admin Settings panel keeps working if it's ever
 * opened.
 *
 * Why reparent instead of parameterizing the renderer with a second target container: the
 * renderer's own generated markup (visual-tuning control ids, the embedded mapping-diagnostics
 * panel, the embedded course-play debug table) reads many MORE fixed ids via plain
 * document.getElementById, not just the three top-level containers. Parameterizing only the
 * outer function would leave those inner ids duplicated the moment both the legacy panel and a
 * Studio page tried to show the same tab in the same session — a real, session-triggered bug
 * (see docs/reports/CLARITY_STUDIO_WIRING_COMPARISON.md). Moving the one real DOM subtree
 * sidesteps the whole class of problem: there is still only ever one of each id in the document.
 *
 * Course Database, Course Mapping, Course Visuals, and Mapping Diagnostics all host this same
 * node (with different default tabs) via window.GDStudioCourseDbHost.mount — only one page can
 * hold it at a time, which is an accurate reflection of the legacy code: it is one panel with
 * one detail tab, not four independently-owned surfaces yet. See course-mapping-page.js. */
(function () {
  "use strict";

  function mount(containerEl, opts) {
    opts = opts || {};
    var host = document.getElementById("gdAdminDatabasePanel");
    if (!host) return null;

    var originalParent = host.parentNode;
    var originalNextSibling = host.nextSibling;

    var wrap = document.createElement("div");
    wrap.className = "gdStudioCourseDbHost";
    wrap.appendChild(host);
    containerEl.appendChild(wrap);

    function refresh() {
      if (typeof window.gdRenderAdminCourseDatabase === "function") window.gdRenderAdminCourseDatabase();
    }

    if (opts.tab && typeof window.gdAdminCourseDbSetTab === "function") window.gdAdminCourseDbSetTab(opts.tab);
    else refresh();

    var interval = setInterval(refresh, 3000);

    return function cleanup() {
      clearInterval(interval);
      if (originalParent) originalParent.insertBefore(host, originalNextSibling);
    };
  }

  window.GDStudioCourseDbHost = { mount: mount };

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["course-database"] = function (containerEl) {
    return mount(containerEl, { tab: "overview" });
  };
})();
