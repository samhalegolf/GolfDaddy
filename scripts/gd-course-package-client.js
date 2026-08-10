/* App-surface client for GET /api/course-package (see functions/course-package.mjs).
   Deliberately tiny and fail-open: any missing script, network failure, timeout, or
   non-ready response resolves to null, never throws past this file. Callers (currently only
   scripts/gd-course-library-pin-lock.js's runCourseMappingAttempt, stage 6 of the
   course-package migration plan) must treat null as "the server has nothing yet" and fall
   through to their existing behavior - this client is an optimization to skip a redundant
   client-side OSM fetch when the server has already resolved the course, not a dependency
   the mapping pipeline can be blocked on.

   Fail-open is right; fail-SILENT was not. Every outcome collapsed to null, so "you are
   signed out", "you are rate limited", "the server is down" and "not mapped yet" were one
   indistinguishable answer - to the player, who just saw nothing happen, and to us, since
   nothing was recorded either. The return value still collapses to null, because callers
   genuinely only branch on ready/not-ready. The REASON now goes on the side, in the same
   body.dataset channel the rest of the picker signals through. */
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

  /* One place to write the outcome, so a caller can ask "why did nothing happen" and a
     screenshot of the DOM answers it. */
  var lastOutcome = { status: "", detail: "", at: 0 };
  function note(status, detail) {
    lastOutcome = { status: status, detail: detail || "", at: Date.now() };
    safe(function () {
      if (!document || !document.body) return;
      document.body.dataset.gdCoursePackageOutcome = status;
      if (detail) document.body.dataset.gdCoursePackageDetail = String(detail).slice(0, 120);
      else delete document.body.dataset.gdCoursePackageDetail;
    });
    return lastOutcome;
  }

  /* opts: {courseId, courseLat, courseLng, courseName, timeoutMs}. Returns the parsed
     response body on any 2xx, or null on anything else. Callers only branch on
     ready/not-ready; read lastOutcome() when you need to say why. */
  async function fetchPackage(opts) {
    opts = opts || {};
    var courseId = String(opts.courseId || "").trim();
    if (!courseId) { note("no-course-id"); return null; }
    if (typeof fetch !== "function") { note("no-fetch"); return null; }
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
    /* Worth its own outcome: the server answers 200 {status:"none"} for a signed-out caller
       rather than 401, so without this an expired session is indistinguishable from an
       unmapped course - which is exactly how a course can look "never mapped" forever. */
    else note("no-token");
    try {
      var response = await fetch(ENDPOINT + "?" + params, { headers: headers, signal: controller ? controller.signal : undefined });
      if (timer) clearTimeout(timer);
      if (!response.ok) {
        var reason = response.status === 401 || response.status === 403 ? "unauthorized"
          : response.status === 429 ? "rate-limited"
          : response.status >= 500 ? "server-error" : "rejected";
        note(reason, "HTTP " + response.status);
        return null;
      }
      var body = await response.json();
      /* A 200 is not the same as an answer. status:"none" with no token in play means the
         server declined to enqueue, which is the case worth being loud about. */
      var state = body && body.status ? String(body.status) : "none";
      note(state === "none" && !token ? "none-signed-out" : state,
        body && body.triggerError ? String(body.triggerError) : "");
      return body;
    } catch (e) {
      if (timer) clearTimeout(timer);
      var aborted = e && (e.name === "AbortError" || String(e).indexOf("abort") >= 0);
      note(aborted ? "timeout" : "network-error", e && e.message ? e.message : "");
      return null;
    }
  }

  window.GDCoursePackageClient = {
    fetchPackage: fetchPackage,
    lastOutcome: function () { return lastOutcome; }
  };
})();
