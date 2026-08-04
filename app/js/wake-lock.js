/* Keep the screen on while a round is in play.

   A round is four hours of glancing at the phone between shots, and the default
   auto-lock is a minute or two - so the display was sleeping constantly, and
   every wake meant waiting for the map to come back. On iOS a slept WebView can
   also be purged under memory pressure, which loses more than the screen.

   Screen Wake Lock is the whole implementation: no plugin, no native code. It
   is absent on iOS below 16.4 (deployment target here is 15), so the request is
   guarded and a missing API is simply "the screen sleeps as before" - never an
   error, never a reason play cannot start.

   The re-acquire on visibilitychange is not optional. The browser releases the
   lock whenever the page is hidden - a notification pulled down, a glance at
   another app - and it does NOT come back on its own. Without the listener the
   lock silently stops working the first time the player checks a message, which
   looks exactly like it never worked. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  var sentinel = null;
  var wanted = false;

  function supported() {
    return !!(navigator.wakeLock && typeof navigator.wakeLock.request === "function");
  }

  function acquire() {
    if (!wanted || sentinel || !supported() || document.visibilityState !== "visible") return;
    /* Fire and forget: a refused lock (low battery, OS policy) must not reject
       into the play path that asked for it. */
    navigator.wakeLock.request("screen").then(function (lock) {
      if (!wanted) { try { lock.release(); } catch (e) {} return; }
      sentinel = lock;
      lock.addEventListener("release", function () { sentinel = null; });
    }, function () { sentinel = null; });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") acquire();
  });

  app.wakeLock = {
    supported: supported,
    held: function () { return !!sentinel; },
    start: function () { wanted = true; acquire(); },
    stop: function () {
      wanted = false;
      var lock = sentinel;
      sentinel = null;
      if (lock) { try { lock.release(); } catch (e) {} }
    }
  };
})();
