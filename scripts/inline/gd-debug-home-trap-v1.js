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
     pending batch would be lost. */
  function send(message, detail) {
    safe(function () {
      window.ClarityErrorReporter.report(TAG + " " + message, detail || "");
      window.ClarityErrorReporter.flush();
    });
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

      send("HOME_NAV source=" + source, "classes: " + classes + "\n\nstack:\n" + stack);

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
      "BOOT nav=" + type + " resumeRoundPresent=" + hadRound,
      "platform: " + safe(function () { return window.GDNative.platform; }, "web") +
      "\nurl: " + safe(function () { return location.href; }, "")
    );
  }

  /* ---- install --------------------------------------------------------- */

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
