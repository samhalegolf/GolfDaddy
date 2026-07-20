/* Client error reporting.
 *
 * clarity-support.js already captures errors, but only ever transmits them if a
 * user files a support ticket - so a failure nobody reports is invisible. Four
 * bugs found in a single day (a CORS block that silently fell back to local
 * accounts, a blank screen, a swallowed ReferenceError in password reset, and a
 * pull path that was never called) all failed silently and none would have
 * produced a ticket.
 *
 * Rules this module follows, in order of importance:
 *
 *   1. Never make things worse. Reporting is wrapped so it cannot throw, cannot
 *      block, and cannot recurse - an error inside the reporter must not become
 *      an error it then tries to report.
 *   2. Deduplicate before sending. The password reset bug fired on every auth
 *      gate pass; one POST per occurrence would have flooded the endpoint and
 *      told us nothing more than a count would.
 *   3. Bounded. Caps on batch size, queue size and per-session sends, so a tight
 *      error loop cannot turn a broken session into a broken backend.
 */
(function () {
  "use strict";

  var ENDPOINT = "/api/client-errors";
  var FLUSH_DELAY_MS = 8000;      /* batch window - long enough to collapse a burst */
  var MAX_QUEUE = 20;             /* distinct fingerprints held before forcing a flush */
  var MAX_SENDS_PER_SESSION = 20; /* a broken session must not become a broken backend */
  var MAX_MESSAGE = 600;
  var MAX_DETAIL = 1200;

  var queue = {};       /* fingerprint -> event */
  var queued = 0;
  var sends = 0;
  var timer = null;
  var reporting = false; /* recursion guard */

  function safe(fn, fallback) {
    try { return fn(); } catch (_e) { return fallback; }
  }

  function truncate(value, limit) {
    var s = String(value == null ? "" : value);
    return s.length > limit ? s.slice(0, limit - 1) + "…" : s;
  }

  /* Must match normaliseForFingerprint in functions/client-errors.mjs closely
     enough that the client's dedupe and the server's dedupe agree. They do not
     have to be identical - the server is authoritative - but if they diverge
     wildly the client sends more rows than it needs to. */
  function fingerprint(source, message) {
    return source + "|" + String(message || "")
      .toLowerCase()
      .replace(/https?:\/\/[^\s)]+/g, "<url>")
      .replace(/\b[0-9a-f]{8,}\b/g, "<hex>")
      .replace(/\b\d+\b/g, "<n>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
  }

  function platform() {
    return safe(function () {
      return (window.GDNative && window.GDNative.isNative) ? window.GDNative.platform : "web";
    }, "web");
  }

  function appVersion() {
    return safe(function () {
      return (window.ClarityBuild && window.ClarityBuild.version)
        || document.documentElement.getAttribute("data-gd-build")
        || "";
    }, "");
  }

  /* Route matters more than URL here: this app is DOM-class routed, so the URL
     barely changes and would say nothing about where the failure happened. */
  function route() {
    return safe(function () {
      var state = window.GDShell && typeof window.GDShell.getState === "function" ? window.GDShell.getState() : null;
      if (state && state.route) return state.module ? state.route + ":" + state.module : state.route;
      return "";
    }, "");
  }

  function accountId() {
    return safe(function () {
      var accounts = window.GolfDaddyAccounts;
      var account = accounts && typeof accounts.current === "function" ? accounts.current() : null;
      return account && (account.accountId || account.id) || "";
    }, "");
  }

  function record(source, level, message, detail) {
    if (reporting) return;              /* never report our own failures */
    if (sends >= MAX_SENDS_PER_SESSION) return;
    var clean = truncate(message, MAX_MESSAGE);
    if (!clean) return;
    var key = fingerprint(source, clean);
    var existing = queue[key];
    if (existing) {
      existing.count += 1;
      return;                            /* a repeat costs nothing but a counter */
    }
    if (queued >= MAX_QUEUE) { flush("queue-full"); }
    queue[key] = {
      source: source,
      level: level,
      message: clean,
      detail: truncate(detail, MAX_DETAIL),
      route: route(),
      count: 1
    };
    queued += 1;
    schedule();
  }

  function schedule() {
    if (timer) return;
    timer = safe(function () {
      return setTimeout(function () { timer = null; flush("timer"); }, FLUSH_DELAY_MS);
    }, null);
  }

  function drain() {
    var events = [];
    Object.keys(queue).forEach(function (key) { events.push(queue[key]); });
    queue = {};
    queued = 0;
    return events;
  }

  function flush(reason) {
    if (sends >= MAX_SENDS_PER_SESSION) { drain(); return; }
    var events = drain();
    if (!events.length) return;
    sends += 1;

    var body = safe(function () {
      return JSON.stringify({
        platform: platform(),
        appVersion: appVersion(),
        accountId: accountId(),
        reason: reason || "",
        events: events
      });
    }, null);
    if (!body) return;

    reporting = true;
    safe(function () {
      /* keepalive so a flush triggered by the page going away still leaves.
         Failure is ignored on purpose - a reporting failure must not produce a
         visible error, and retrying risks a loop. */
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
        keepalive: true
      }).catch(function () {}).then(function () { reporting = false; }, function () { reporting = false; });
    }, null);
    /* Clear the guard even if fetch threw synchronously. */
    setTimeout(function () { reporting = false; }, 0);
  }

  function install() {
    safe(function () {
      window.addEventListener("error", function (event) {
        var where = event && event.filename ? event.filename + ":" + event.lineno : "";
        record("window.error", "error", event && (event.message || "Script error"), where);
      });
    });

    safe(function () {
      window.addEventListener("unhandledrejection", function (event) {
        var reason = event && event.reason;
        var message = reason && (reason.message || reason) || "Unhandled promise rejection";
        var stack = reason && reason.stack ? String(reason.stack).split("\n").slice(0, 4).join(" | ") : "";
        record("unhandledrejection", "error", message, stack);
      });
    });

    /* console.error is captured too, not just uncaught errors. The password
       reset bug was swallowed by a try/catch and only ever surfaced as a console
       message - exactly the silent-failure class this exists to catch. The level
       is recorded so the noisier source can be filtered server side. */
    safe(function () {
      var original = console.error;
      if (typeof original !== "function" || original.__gdErrorReporter) return;
      var wrapped = function () {
        /* Copy arguments out before entering the closure: `arguments` inside the
           inner function is that function's own, which safe() calls with none.
           Reading it there silently produced an empty message every time, so the
           reporter looked installed and captured nothing. */
        var args = Array.prototype.slice.call(arguments);
        safe(function () {
          var parts = args.map(function (item) {
            if (typeof item === "string") return item;
            if (item instanceof Error) return item.message;
            return safe(function () { return JSON.stringify(item); }, String(item));
          });
          record("console.error", "warn", parts.join(" "), "");
        });
        return original.apply(console, args);
      };
      wrapped.__gdErrorReporter = true;
      console.error = wrapped;
    });

    /* Send what is queued before the app goes away, rather than losing the last
       and often most interesting errors of a session. */
    safe(function () {
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") flush("hidden");
      });
      window.addEventListener("pagehide", function () { flush("pagehide"); });
    });
  }

  window.ClarityErrorReporter = {
    /* Exposed so a caller can report a handled failure it decided to swallow -
       the case that produced today's silent bugs. */
    report: function (message, detail) { record("manual", "error", message, detail); },
    flush: function () { flush("manual"); },
    pending: function () { return queued; },
    __state: function () { return { queued: queued, sends: sends, maxSends: MAX_SENDS_PER_SESSION }; }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
