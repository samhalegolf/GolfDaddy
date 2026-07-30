/* TEMPORARY DIAGNOSTIC - remove before shipping to real users.
 *
 * Answers two questions about the Head To Tee -> home bug without needing a Mac
 * or an attached Web Inspector, by reporting through the pipe that already
 * exists (clarity-error-reporter.js -> POST /api/client-errors):
 *
 *   1. Did a route change to home actually happen, and who asked for it?
 *      Every force-home path in the app funnels through GDShell.showHome and
 *      passes a source string, so wrapping that one function names the caller.
 *
 *   2. Or did the webview reload instead? A reload produces no showHome row at
 *      all, but does produce a BOOT row with navigation type "reload". A cold
 *      launch reports "navigate". That distinction is the whole question.
 *
 * Loads last, after gd-shell.js and clarity-error-reporter.js, so both globals
 * are present. Wrapped so it cannot throw into the app it is observing, and
 * gated to native so the public web build reports nothing.
 */
(function () {
  "use strict";

  var TAG = "DEBUG_527";

  function safe(fn, fallback) {
    try { return fn(); } catch (_e) { return fallback; }
  }

  /* Native only. The bug is in the app's GPS play surface, but dist/index.html
     is also the public web build served at site root - left ungated, every web
     visitor would post a BOOT row and bury the rows that matter. GDNative is
     assigned synchronously by gd-native-bootstrap.js, which loads first, so this
     flag is already final by the time this file runs last. */
  if (!safe(function () { return window.GDNative.isNative; }, false)) return;

  /* Send immediately rather than waiting for the 8s batch window: the events
     worth catching here are followed by a route change or a reload, and a
     pending batch would be lost.

     Queue every row FIRST, then flush once. flush() sets the reporter's
     `reporting` recursion guard and only clears it when the fetch settles, and
     record() drops anything that arrives while it is set. So report-then-flush
     per row silently discards every row after the first - which is exactly what
     happened on build 533: the BOOT row landed and the TIMELINE row that
     followed it never existed, on every boot, with no error anywhere. */
  function send() {
    var rows = Array.prototype.slice.call(arguments);
    safe(function () {
      rows.forEach(function (row) {
        if (!row || !row.message) return;
        window.ClarityErrorReporter.report(TAG + " " + row.message, row.detail || "");
      });
      window.ClarityErrorReporter.flush();
    });
  }

  /* ---- 0. The course-play timeline ------------------------------------

     The pipeline already records the last 50 course-play events, but only to
     localStorage - nothing uploads them and no UI shows them, so twice now the
     record of an incident has sat on a phone we could not read. This ships a
     compressed tail through the same pipe as everything else.

     Sent at BOOT and again on HOME_NAV, and those are different questions. The
     timeline survives a reload or a relaunch, so the BOOT copy is the tail from
     BEFORE whatever happened - which is the only way to see a webview reload,
     since nothing runs to report it as it dies. The HOME_NAV copy is the run-up
     to a route change.

     MAX_DETAIL in the reporter is 1200 characters, so this cannot be a dump: 18
     entries at roughly 60 characters each. The reporter fingerprint-dedupes, but
     /api/client-errors PATCHes detail on a repeat, so the row always holds the
     most recent occurrence rather than the first. */

  var TIMELINE_KEY = "gd_course_play_debug_timeline_v1";
  var TIMELINE_ENTRIES = 18;

  function clip(value, n) {
    var s = String(value == null ? "" : value);
    return s.length > n ? s.slice(0, n) : s;
  }

  function timelineTail() {
    return safe(function () {
      var rows = JSON.parse(localStorage.getItem(TIMELINE_KEY) || "[]");
      if (!Array.isArray(rows) || !rows.length) return "";
      return rows.slice(-TIMELINE_ENTRIES).map(function (e) {
        if (!e) return "";
        /* Times only - the date is on the row itself. Strip the gps-play- prefix
           the majority of these share, or it eats a third of the budget. */
        var t = clip(String(e.at || "").replace(/^.*T/, "").replace(/\..*$/, ""), 8);
        var type = clip(String(e.type || "event").replace(/^gps-play-/, ""), 30);
        var hole = e.holeNumber || e.hole;
        var why = clip(e.reason || e.status || e.source || "", 18);
        return t + " " + type + (hole ? " h" + hole : "") + (why ? " " + why : "");
      }).filter(Boolean).join("\n");
    }, "");
  }

  /* Returns a row rather than sending: it must ride in the SAME flush as the row
     it accompanies, or the recursion guard drops it. */
  function timelineRow(label) {
    var tail = timelineTail();
    if (!tail) return null;
    return { message: "TIMELINE " + label, detail: tail };
  }

  /* ---- 1. Who called showHome ---------------------------------------- */

  function installHomeTrap() {
    if (!window.GDShell || typeof window.GDShell.showHome !== "function") return false;
    if (window.GDShell.showHome.__gdDebugTrapped) return true;

    var original = window.GDShell.showHome;

    window.GDShell.showHome = function (opts) {
      var source = safe(function () { return String((opts && opts.source) || "unknown"); }, "unknown");

      /* The body classes at the moment of the call say which surface the app
         thought it was on, which narrows the caller further when the source
         string is shared by several paths. */
      var classes = safe(function () { return String(document.body.className || ""); }, "");
      var stack = safe(function () { return String(new Error("home-nav").stack || ""); }, "");

      /* Two rows, one flush. The stack says who called; the timeline says what
         the app had been doing. Both are needed and neither fits in one
         1200-character detail field. */
      send(
        { message: "HOME_NAV source=" + source, detail: "classes: " + classes + "\n\nstack:\n" + stack },
        timelineRow("at-home-nav source=" + source)
      );

      return original.apply(this, arguments);
    };

    window.GDShell.showHome.__gdDebugTrapped = true;
    return true;
  }

  /* GDShell is created by gd-shell.js, but several later layers reassign the
     nav functions during their own wire() passes. Retrying past those keeps the
     trap on the live reference rather than one that got replaced. */
  function trapWithRetries() {
    if (installHomeTrap()) return;
    [0, 200, 800, 2000, 4000].forEach(function (delay) {
      setTimeout(installHomeTrap, delay);
    });
  }

  /* ---- 2. Was this load a reload or a cold launch? -------------------- */

  function navigationType() {
    return safe(function () {
      var entry = performance.getEntriesByType("navigation")[0];
      return entry && entry.type ? String(entry.type) : "unknown";
    }, "unknown");
  }

  function reportBoot() {
    var type = navigationType();

    /* A round sitting in localStorage while this is a fresh load is the signal
       that the player was mid-round when the load happened - i.e. it was not
       them opening the app. */
    var hadRound = safe(function () {
      return !!localStorage.getItem("gd_gps_resume_round_v1");
    }, false);

    send(
      {
        message: "BOOT nav=" + type + " resumeRoundPresent=" + hadRound,
        detail: "platform: " + safe(function () { return window.GDNative.platform; }, "web") +
          "\nurl: " + safe(function () { return location.href; }, "")
      },
      BOOT_TAIL ? { message: "TIMELINE at-boot nav=" + type, detail: BOOT_TAIL } : null
    );
  }

  /* ---- install --------------------------------------------------------- */

  /* Captured here, at parse time, NOT inside start(): the whole value of the boot
     copy is that it holds the PREVIOUS session's tail. start() runs on
     DOMContentLoaded, by which point this session can already have pushed its own
     events in and evicted the ones that explain what happened. */
  var BOOT_TAIL = timelineTail();

  function start() {
    trapWithRetries();
    reportBoot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
