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
    /* Same reasoning as scripts/gd-course-package-client.js: null stays the answer, because
       the caller only branches on ready/not-ready, but the reason is recorded rather than
       thrown away. A signed-out player and an unmapped course looked identical from here. */
    function note(status, detail) {
      try {
        if (!document || !document.body) return;
        document.body.dataset.gdCoursePackageOutcome = status;
        if (detail) document.body.dataset.gdCoursePackageDetail = String(detail).slice(0, 120);
        else delete document.body.dataset.gdCoursePackageDetail;
      } catch (e) {}
    }
    if (!token) note("no-token");
    try {
      var response = await fetch(ENDPOINT + "?" + params, { headers: headers, signal: controller ? controller.signal : undefined });
      if (!response.ok) {
        note(response.status === 401 || response.status === 403 ? "unauthorized"
          : response.status === 429 ? "rate-limited"
          : response.status >= 500 ? "server-error" : "rejected", "HTTP " + response.status);
        return null;
      }
      var body = await response.json();
      var state = body && body.status ? String(body.status) : "none";
      note(state === "none" && !token ? "none-signed-out" : state,
        body && body.triggerError ? String(body.triggerError) : "");
      return body;
    } catch (e) {
      var aborted = e && (e.name === "AbortError" || String(e).indexOf("abort") >= 0);
      note(aborted ? "timeout" : "network-error", e && e.message ? e.message : "");
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
})();
