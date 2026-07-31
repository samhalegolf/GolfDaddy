/* Published-course list for the picker. GET /api/course-library returns one
   small row per published course (course_id, course_name, course_lat,
   course_lng, hole_count, versions) — no payloads. Fail-open: any failure
   resolves to [], and the picker shows its empty state; the server being
   unreachable is a normal outcome, not an error path. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  app.fetchCourseLibrary = async function () {
    if (typeof fetch !== "function") return [];
    try {
      var response = await fetch("/api/course-library", { headers: { Accept: "application/json" } });
      if (!response.ok) return [];
      var body = await response.json();
      var rows = Array.isArray(body) ? body : Array.isArray(body && body.courses) ? body.courses : [];
      return rows
        .filter(function (row) { return row && row.course_id && row.course_name; })
        .map(function (row) {
          return {
            courseId: app.courseKey(row.course_id),
            courseName: String(row.course_name),
            courseLat: Number(row.course_lat),
            courseLng: Number(row.course_lng),
            holeCount: Number(row.hole_count) || null
          };
        })
        .sort(function (a, b) { return a.courseName.localeCompare(b.courseName); });
    } catch (e) {
      return [];
    }
  };
})();
