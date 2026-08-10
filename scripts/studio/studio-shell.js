/* Clarity Studio shell — left nav, header, breadcrumb, workspace mount. Studio-only.
 * Activates only when document.documentElement.dataset.gdTarget === "studio" (the first runtime
 * reader of that build-time stamp — see docs/APP_STUDIO_SPLIT.md). */
(function () {
  "use strict";

  function activationTarget() {
    return document.documentElement && document.documentElement.dataset
      ? document.documentElement.dataset.gdTarget
      : null;
  }

  var root = null;
  var navEl = null;
  var breadcrumbEl = null;
  var tabStripEl = null;
  var contentEl = null;
  var envStatusEl = null;
  var activeTab = "workspace";
  var activeCleanup = null;

  function runCleanup() {
    if (typeof activeCleanup === "function") {
      try { activeCleanup(); } catch (e) {}
    }
    activeCleanup = null;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function buildNav() {
    var registry = window.GDStudioRegistry;
    var tree = registry.navTree;
    var html = tree.map(function (entry) {
      var record = registry.get(entry.id);
      if (!record) return "";
      var childrenHtml = "";
      if (entry.children && entry.children.length) {
        childrenHtml = '<ul class="gdStudioNavChildren">' + entry.children.map(function (childId) {
          var child = registry.get(childId);
          if (!child) return "";
          return '<li><button type="button" class="gdStudioNavItem" data-gd-studio-nav="' + esc(childId) + '">' + esc(child.label) + "</button></li>";
        }).join("") + "</ul>";
      }
      return '<li class="gdStudioNavGroup">' +
        '<button type="button" class="gdStudioNavItem gdStudioNavGroupBtn" data-gd-studio-nav="' + esc(entry.id) + '">' + esc(record.label) + "</button>" +
        childrenHtml +
        "</li>";
    }).join("");
    navEl.innerHTML = html;
  }

  function markActiveNav(id) {
    var buttons = navEl.querySelectorAll("[data-gd-studio-nav]");
    buttons.forEach(function (btn) {
      btn.classList.toggle("isActive", btn.getAttribute("data-gd-studio-nav") === id);
    });
  }

  function renderBreadcrumb() {
    var trail = window.GDStudioRouter.breadcrumb();
    breadcrumbEl.innerHTML = trail.map(function (record, i) {
      var isLast = i === trail.length - 1;
      if (isLast) return '<span class="gdStudioCrumbCurrent">' + esc(record.label) + "</span>";
      return '<button type="button" class="gdStudioCrumbLink" data-gd-studio-nav="' + esc(record.id) + '">' + esc(record.label) + "</button>";
    }).join('<span class="gdStudioCrumbSep">›</span>');
  }

  function renderTabStrip(record) {
    var showInfo = record && record.status !== "group";
    tabStripEl.innerHTML =
      '<button type="button" class="gdStudioTab' + (activeTab === "workspace" ? " isActive" : "") + '" data-gd-studio-tab="workspace">Workspace</button>' +
      (showInfo ? '<button type="button" class="gdStudioTab' + (activeTab === "info" ? " isActive" : "") + '" data-gd-studio-tab="info">Info</button>' : "");
  }

  function renderGroupWorkspace(record) {
    var registry = window.GDStudioRegistry;
    var children = registry.childrenOf(record.id);
    return '<div class="gdStudioGroupIndex"><p class="gdStudioLede">' + esc(record.function) + '</p><div class="gdStudioCardGrid">' +
      children.map(function (child) {
        return '<button type="button" class="gdStudioCard" data-gd-studio-nav="' + esc(child.id) + '">' +
          '<div class="gdStudioCardLabel">' + esc(child.label) + "</div>" +
          '<div class="gdStudioCardHint">' + esc(child.function || "") + "</div>" +
          "</button>";
      }).join("") + "</div></div>";
  }

  function renderPlaceholderWorkspace(record) {
    var codeRows = (record.code || []).map(function (c) {
      return "<li><code>" + esc(c.path) + "</code> — " + esc(c.role) + "</li>";
    }).join("");
    return '<div class="gdStudioPlaceholder">' +
      '<div class="gdStudioPlaceholderBadge">Not yet moved into Studio</div>' +
      "<p>" + esc(record.function) + "</p>" +
      (record.needsVerification ? '<p class="gdStudioNeedsVerification">Ownership needs verification — do not treat the pointers below as confirmed.</p>' : "") +
      (codeRows ? "<div><strong>Known code pointers</strong><ul>" + codeRows + "</ul></div>" : "") +
      "</div>";
  }

  function renderWorkspace(record) {
    runCleanup();
    if (!record) { contentEl.innerHTML = ""; return; }
    if (record.status === "group") {
      contentEl.innerHTML = renderGroupWorkspace(record);
      return;
    }
    var pageRenderer = window.GDStudioPages && window.GDStudioPages[record.id];
    if (typeof pageRenderer === "function") {
      contentEl.innerHTML = "";
      try {
        /* A page renderer may return a cleanup function (e.g. to clear a refresh
           interval) — the shell calls it before the next render or tab/section switch. */
        activeCleanup = pageRenderer(contentEl, record);
      } catch (e) {
        contentEl.innerHTML = '<div class="gdStudioPlaceholder"><div class="gdStudioPlaceholderBadge">Page error</div><p>' + esc(e && e.message || e) + "</p></div>";
      }
      return;
    }
    contentEl.innerHTML = renderPlaceholderWorkspace(record);
  }

  function renderContent() {
    var id = window.GDStudioRouter.current();
    var record = window.GDStudioRegistry.get(id);
    renderTabStrip(record);
    if (activeTab === "info" && record && window.GDStudioInfoView) {
      runCleanup();
      window.GDStudioInfoView.render(contentEl, record.id);
    } else {
      renderWorkspace(record);
    }
  }

  /* Read the loader's own state, not a global nothing assigns.

     This used to test window.GD_ADMIN_COURSE_DB_CLOUD, which is set nowhere in the codebase,
     so the banner read "local fallback" permanently - including while Studio was showing live
     Supabase rows. A status line that is wrong in exactly one direction is worse than none:
     it sent a real investigation after a connection problem that did not exist. */
  function renderEnvStatus() {
    var state = typeof gdAdminCourseDbCloudState === "string" ? gdAdminCourseDbCloudState : "";
    var count = safeCourseCount();
    var source = state === "ready" ? "Supabase · " + count + " course" + (count === 1 ? "" : "s")
      : state === "loading" ? "loading from Supabase…"
      : state === "error" ? "Supabase unreachable — " + (typeof gdAdminCourseDbCloudError === "string" && gdAdminCourseDbCloudError ? gdAdminCourseDbCloudError : "unknown error")
      : "not loaded yet";
    envStatusEl.textContent = "Studio · database source: " + source;
  }
  function safeCourseCount() {
    try {
      /* let-declared at the top of gd-admin-course-db.js: a global lexical binding, reachable
         by name from here, but never a property of window - which is why the old check
         against window.GD_ADMIN_COURSE_DB_CLOUD could not have worked. */
      var store = typeof gdAdminCourseDbCloud !== "undefined" ? gdAdminCourseDbCloud : null;
      return store && store.courses ? Object.keys(store.courses).length : 0;
    } catch (e) { return 0; }
  }

  function onRouteChange() {
    var id = window.GDStudioRouter.current();
    markActiveNav(id);
    renderBreadcrumb();
    activeTab = "workspace";
    renderContent();
  }

  function wireEvents() {
    root.addEventListener("click", function (e) {
      var navBtn = e.target.closest("[data-gd-studio-nav]");
      if (navBtn) {
        window.GDStudioRouter.go(navBtn.getAttribute("data-gd-studio-nav"));
        return;
      }
      var tabBtn = e.target.closest("[data-gd-studio-tab]");
      if (tabBtn) {
        activeTab = tabBtn.getAttribute("data-gd-studio-tab");
        renderContent();
      }
    });
  }

  function mount() {
    root = document.getElementById("gdStudioShellRoot");
    if (!root) return;
    root.hidden = false;
    root.innerHTML =
      '<div class="gdStudioShell">' +
      '<aside class="gdStudioNavRail"><div class="gdStudioBrand">Clarity Studio</div><nav><ul class="gdStudioNavList" id="gdStudioNavList"></ul></nav></aside>' +
      '<div class="gdStudioMain">' +
      '<header class="gdStudioHeader"><div class="gdStudioBreadcrumb" id="gdStudioBreadcrumb"></div><div class="gdStudioEnvStatus" id="gdStudioEnvStatus"></div></header>' +
      '<div class="gdStudioTabStrip" id="gdStudioTabStrip"></div>' +
      '<main class="gdStudioWorkspace" id="gdStudioWorkspace"></main>' +
      "</div></div>";

    navEl = document.getElementById("gdStudioNavList");
    breadcrumbEl = document.getElementById("gdStudioBreadcrumb");
    tabStripEl = document.getElementById("gdStudioTabStrip");
    contentEl = document.getElementById("gdStudioWorkspace");
    envStatusEl = document.getElementById("gdStudioEnvStatus");

    buildNav();
    renderEnvStatus();
    wireEvents();
    window.GDStudioRouter.subscribe(onRouteChange);
    window.GDStudioRouter.reset("overview");
  }

  if (activationTarget() === "studio") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mount);
    } else {
      mount();
    }
  }
})();
