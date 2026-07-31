/* App-surface client for GET /api/course-package (see functions/course-package.mjs).
   Deliberately tiny and fail-open: any missing script, network failure, timeout, or
   non-ready response resolves to null, never throws past this file. Callers (currently only
   scripts/gd-course-library-pin-lock.js's runCourseMappingAttempt, stage 6 of the
   course-package migration plan) must treat null as "the server has nothing yet" and fall
   through to their existing behavior - this client is an optimization to skip a redundant
   client-side OSM fetch when the server has already resolved the course, not a dependency
   the mapping pipeline can be blocked on. */
(function () {
  if (window.GDCoursePackageClient) return;

  var ENDPOINT = "/api/course-package";
  var DEFAULT_TIMEOUT_MS = 4000;

  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

  async function accessToken() {
    return safe(function () {
      var auth = window.ClaritySupabaseAuth;
      return auth && typeof auth.freshAccessToken === "function" ? auth.freshAccessToken() : "";
    }, "") || "";
  }

  /* opts: {courseId, courseLat, courseLng, courseName, timeoutMs}. Returns the parsed
     response body on any 2xx, or null on anything else (including a well-formed error body -
     callers only care about ready/not-ready, not why). */
  async function fetchPackage(opts) {
    opts = opts || {};
    var courseId = String(opts.courseId || "").trim();
    if (!courseId || typeof fetch !== "function") return null;
    var params = "courseId=" + encodeURIComponent(courseId);
    var lat = Number(opts.courseLat), lng = Number(opts.courseLng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      params += "&courseLat=" + encodeURIComponent(lat) + "&courseLng=" + encodeURIComponent(lng);
    }
    if (opts.courseName) params += "&courseName=" + encodeURIComponent(String(opts.courseName).slice(0, 200));
    var controller = null;
    try { if (typeof AbortController !== "undefined") controller = new AbortController(); } catch (e) {}
    var timer = controller ? setTimeout(function () { controller.abort(); }, opts.timeoutMs || DEFAULT_TIMEOUT_MS) : null;
    var headers = { Accept: "application/json" };
    var token = await accessToken();
    if (token) headers.Authorization = "Bearer " + token;
    try {
      var response = await fetch(ENDPOINT + "?" + params, { headers: headers, signal: controller ? controller.signal : undefined });
      if (timer) clearTimeout(timer);
      if (!response.ok) return null;
      return await response.json();
    } catch (e) {
      if (timer) clearTimeout(timer);
      return null;
    }
  }

  window.GDCoursePackageClient = { fetchPackage: fetchPackage };
})();
