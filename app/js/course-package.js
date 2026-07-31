/* GET /api/course-package consumer. Fail-open: any network failure, timeout, or
   non-2xx resolves to null — "the server has nothing yet" is a normal answer,
   the caller stays on the live map. Mirrors the proven client in
   scripts/gd-course-package-client.js; kept separate so app/ has no load-order
   dependency on the old tree. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var ENDPOINT = "/api/course-package";
  var DEFAULT_TIMEOUT_MS = 4000;

  async function accessToken() {
    try {
      var auth = window.ClaritySupabaseAuth;
      return auth && typeof auth.freshAccessToken === "function"
        ? (await auth.freshAccessToken()) || "" : "";
    } catch (e) { return ""; }
  }

  /* opts: {courseId, courseLat, courseLng, courseName, timeoutMs} → parsed body or null. */
  app.fetchCoursePackage = async function (opts) {
    opts = opts || {};
    var courseId = app.courseKey(opts.courseId);
    if (courseId === "course" || typeof fetch !== "function") return null;
    var params = "courseId=" + encodeURIComponent(courseId);
    var lat = Number(opts.courseLat), lng = Number(opts.courseLng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      params += "&courseLat=" + encodeURIComponent(lat) + "&courseLng=" + encodeURIComponent(lng);
    }
    if (opts.courseName) params += "&courseName=" + encodeURIComponent(String(opts.courseName).slice(0, 200));
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, opts.timeoutMs || DEFAULT_TIMEOUT_MS) : null;
    var headers = { Accept: "application/json" };
    var token = await accessToken();
    if (token) headers.Authorization = "Bearer " + token;
    try {
      var response = await fetch(ENDPOINT + "?" + params, { headers: headers, signal: controller ? controller.signal : undefined });
      if (!response.ok) return null;
      return await response.json();
    } catch (e) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
})();
