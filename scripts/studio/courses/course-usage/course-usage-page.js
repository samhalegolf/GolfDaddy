/* Clarity Studio — Course Usage page. Studio-only, composition-only.
 *
 * The same anonymous download / round counts the Admin Settings "Course usage" card shows
 * (scripts/studio/gd-admin-course-usage.js, reading GET /api/course-usage), given a row of its
 * own under Courses. The card is not reparented: it renders into this page's own body as well
 * as its Admin Settings one (gdMountAdminCourseUsage), so neither surface steals the other's
 * DOM - see the shared-panel note in course-database-page.js for why that matters. */
(function () {
  "use strict";

  function render(containerEl) {
    containerEl.innerHTML =
      '<div class="gdAdminDatabase gdAdminUsage gdStudioCourseUsage">' +
      '<div class="gdAdminDatabaseHead"><div><h3>Course usage</h3>' +
      "<p>Rounds played and maps downloaded per course, by origin (iOS, Android, web, watch). Anonymous daily counts: each device counts a course once a day.</p></div>" +
      '<div class="gdAdminDatabaseActions"><button type="button" data-gd-course-usage="refresh">Refresh</button></div></div>' +
      '<div data-gd-course-usage="body"></div>' +
      "</div>";
    var body = containerEl.querySelector('[data-gd-course-usage="body"]');
    var refresh = containerEl.querySelector('[data-gd-course-usage="refresh"]');
    if (typeof window.gdMountAdminCourseUsage !== "function") {
      body.innerHTML = '<p class="gdAdminUsageNote">The course usage card did not load on this surface.</p>';
      return;
    }
    window.gdMountAdminCourseUsage(body);
    refresh.addEventListener("click", function () { window.gdRefreshAdminCourseUsage(); });
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["course-usage"] = render;
})();
