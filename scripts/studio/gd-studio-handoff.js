/* Clarity Studio — handing a real app screen to the operator, and taking it back. Studio-only.
 *
 * Several Studio pages are jump buttons: rather than reimplement an admin screen that already
 * exists in the app, they open the real one. Studio is a fixed full-screen layer OVER that app,
 * so "open the real one" is only half the job — the shell has to step aside, and come back when
 * the operator is done.
 *
 * This used to be done per page, by whatever happened to work against the z-index of that one
 * target: map-viewport hides the shell properly, commerce raised #playerSettingsPanel above the
 * shell with an inline style, and players-coaches relied on #gdProfileV67 (7600) simply
 * out-stacking the old shell z-index (4000) by accident. Three answers to one question, and the
 * two shortcuts both failed in their own way — the inline bump was permanent, so the app's
 * ORDINARY settings screen then floated over Studio for the rest of the session with Studio's
 * nav sealed underneath it, and any panel opened without the bump was open-but-invisible with
 * every click landing on the shell. The shell now outranks the app outright, and every jump
 * goes through here.
 *
 * "Done" is watched on the DOM rather than through a callback, because the exits are not ours:
 * a panel's own back chevron, the app's Home button, and gdPanelBack all just close the surface.
 * So the shell comes back when nothing app-side is open any more. */
(function () {
  "use strict";

  /* The app surfaces a jump can land on. A `.panel.open` covers the settings/course-data/stats
     family; body.gdProfileOpen covers #gdProfileV67, which is created dynamically and has no
     stable panel class of its own. */
  function appSurfaceOpen(extra) {
    if (document.querySelector(".panel.open")) return true;
    if (document.body.classList.contains("gdProfileOpen")) return true;
    if (typeof extra === "function") { try { return !!extra(); } catch (e) { return false; } }
    if (typeof extra === "string" && extra) return !!document.querySelector(extra);
    return false;
  }

  /* opts:
       open      required. Opens the real app screen. Called after the shell steps aside, so the
                 app is looking at a normal viewport rather than laying out under an overlay.
       isOpen    optional extra "still open" test - a selector or a predicate - for a surface the
                 two built-in checks do not recognise.
       onReturn  optional. Called once, after the shell is back.
       timeoutMs optional. If the surface never opened at all, come back rather than leaving the
                 operator in the app with no route to Studio. Default 4s.

     Returns a cleanup function. Call it when the page is torn down: it stops watching AND
     restores the shell, so navigating away mid-hand-off can never leave Studio hidden. */
  function to(opts) {
    opts = opts || {};
    if (typeof opts.open !== "function") return function () {};

    var observer = null;
    var timer = null;
    var seenOpen = false;
    var finished = false;

    function stop() {
      if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
      if (timer) { clearTimeout(timer); timer = null; }
    }

    function restore() {
      if (finished) return;
      finished = true;
      stop();
      if (window.GDStudioShell) window.GDStudioShell.show();
      if (typeof opts.onReturn === "function") { try { opts.onReturn(); } catch (e) {} }
    }

    function check() {
      if (finished) return;
      if (appSurfaceOpen(opts.isOpen)) { seenOpen = true; return; }
      if (!seenOpen) return;
      restore();
    }

    /* Attributes only, across the document: every close in this app is a class change on a
       panel or on <body>. Watching childList as well would fire on every render inside the
       screen the operator is actually using. */
    observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "hidden"],
      subtree: true
    });
    timer = setTimeout(function () { if (!seenOpen) restore(); }, opts.timeoutMs || 4000);

    if (window.GDStudioShell) window.GDStudioShell.hide();
    try { opts.open(); } catch (e) { restore(); }

    return function () { restore(); };
  }

  window.GDStudioHandoff = { to: to, appSurfaceOpen: appSurfaceOpen };
})();
