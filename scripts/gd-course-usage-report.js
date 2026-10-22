/* Anonymous course map usage counter: the client half of functions/course-usage.mjs.
   Which courses get downloaded, updated and played, how each open went, and from
   which origin. Sends the course, the event and what the map was - never an
   account or guest id. Fire-and-forget; a failed count is never worth a visible
   error.

   Loaded by both shells (index.html and app/index.html) because both put maps on
   the device: /app/ when a round opens, the main site's Course Library when its
   Update button re-downloads one.

   Each event is counted at most once per course per origin per device per day, so
   a WebView rebuild or a re-open mid-round isn't a second round (and a free
   player, whose map is fetched fresh on every open, isn't a stream of downloads).
   An update also keys on its version, so two genuine updates in a day both count.

   report({courseId, event, origin?, mapType?, outcome?, version?, waitMs?, courseName?})
     event    download | update | play | delivery-failed
     origin   defaults to this device's platform (web / ios / android); the watch
              delivery passes apple-watch or garmin
     mapType  full | lite | live
     outcome  how the open went (see the migration 20261022_course_map_usage_detail.sql) */
(function (root) {
  "use strict";
  var ENDPOINT = "/api/course-usage";
  var COUNTED_KEY = "gd-course-usage-counted";

  function courseKey(value) {
    return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
  }

  function deviceOrigin() {
    var native = root.GDNative;
    return native && native.isNative ? String(native.platform) : "web";
  }

  function countedToday(key) {
    var today = new Date().toISOString().slice(0, 10);
    try {
      var seen = JSON.parse(localStorage.getItem(COUNTED_KEY) || "{}");
      if (seen.day !== today) seen = { day: today, ids: [] };
      if (seen.ids.indexOf(key) >= 0) return true;
      seen.ids.push(key);
      localStorage.setItem(COUNTED_KEY, JSON.stringify(seen));
    } catch (e) {}
    return false;
  }

  /* "full" / "lite" from either name a package's map type goes by. */
  function mapTypeName(value) {
    if (value === "published" || value === "full" || value === "full-map-ready") return "full";
    if (value === "object" || value === "lite" || value === "lite-geo-ready") return "lite";
    return value === "live" ? "live" : "";
  }

  function report(opts) {
    opts = opts || {};
    var id = courseKey(opts.courseId);
    if (!id || id === "course" || typeof fetch !== "function") return;
    var event = String(opts.event || "");
    var origin = opts.origin || deviceOrigin();
    var version = typeof opts.version === "string" && /^(W-)?v\d+\.\d+$/.test(opts.version) ? opts.version : "";
    if (countedToday(event + ":" + origin + ":" + id + (event === "update" ? ":" + version : ""))) return;
    var body = { courseId: id, event: event, origin: origin };
    var mapType = mapTypeName(opts.mapType);
    if (mapType) body.mapType = mapType;
    if (opts.outcome) body.outcome = String(opts.outcome);
    if (version) body.version = version;
    if (Number(opts.waitMs) > 0) body.waitMs = Math.round(Number(opts.waitMs));
    if (opts.courseName) body.courseName = String(opts.courseName).slice(0, 120);
    try {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  root.GDCourseUsage = { report: report, mapTypeName: mapTypeName };
})(typeof window !== "undefined" ? window : globalThis);
