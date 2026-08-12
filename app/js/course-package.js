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

  /* Same fetch, but held open while the server answers "processing" - which is the
     normal first answer for a course nobody has opened before, because the request
     itself enqueues the mapping job (functions/course-package.mjs). Mirrors
     awaitServerCoursePackage in scripts/gd-course-library-pin-lock.js: "none" and
     "manual-required" are terminal, anything else short of ready is a transient miss
     tolerated a few times in a row, and the ~4-minute budget covers the mapper
     sweeper's 3-minute worst case. Resolves to the last body seen (or null), so the
     caller's ready/not-ready branch is unchanged - a timeout here just means the
     round starts on the live map exactly as it would have before.

     opts.onProgress({waitedMs, budgetMs, polls, status}) fires between polls so the
     loading screen can keep talking while the player waits. */
  var WAIT_BUDGET_MS = 240000;
  var WAIT_POLL_MS = 3000;
  var WAIT_MAX_CONSECUTIVE_MISSES = 4;
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  app.awaitCoursePackage = async function (opts) {
    opts = opts || {};
    var onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
    var deadline = Date.now() + WAIT_BUDGET_MS;
    var misses = 0;
    var polls = 0;
    var pkg = null;
    for (;;) {
      pkg = await app.fetchCoursePackage(opts);
      polls++;
      var status = pkg && pkg.status ? String(pkg.status) : "unreachable";
      if (status === "full-map-ready" || status === "lite-geo-ready") return pkg;
      if (status === "none" || status === "manual-required") return pkg;
      if (status === "processing") misses = 0;
      else if (++misses >= WAIT_MAX_CONSECUTIVE_MISSES) return pkg;
      var remaining = deadline - Date.now();
      if (remaining <= 0) return pkg;
      var waitedMs = WAIT_BUDGET_MS - remaining;
      if (onProgress) onProgress({ waitedMs: waitedMs, budgetMs: WAIT_BUDGET_MS, polls: polls, status: status });
      await sleep(Math.min(waitedMs > 30000 ? WAIT_POLL_MS * 2 : WAIT_POLL_MS, remaining));
    }
  };
})();
