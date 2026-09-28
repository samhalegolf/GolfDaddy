/* Clarity Studio — picking a course with the REAL course picker, from inside Studio.
 *
 * Studio pages that need "which course" go through scripts/inline/gd-course-picker-search-v2.js
 * in its pick-only mode, so search, nearby and the database list behave exactly as they do for
 * a player. A private "admin course search" would be a second list to keep true, and the first
 * time it disagreed with the real one it would send someone chasing a bug in the wrong place.
 *
 * Handing over to the picker means stepping aside for it: Studio is a fixed layer over the
 * whole app, so the shell hides (GDStudioShell.hide) and comes back when the picker is done.
 * "Done" has two shapes: a selection, which arrives on onPick, and a cancel, which does not -
 * the picker's Back and Home buttons live in gd-app-core.js and simply hide #courseScreen. So
 * the close is watched on the DOM rather than through a callback that only one of the two
 * exits would ever fire.
 *
 * Shared by Map Viewport and Mapping Overlay. One copy of the hand-off, one place it can be
 * wrong. */
(function () {
  "use strict";

  var pickerWatch = null;
  var pickerTimer = null;

  function stopWatch() {
    if (pickerWatch) { try { pickerWatch.disconnect(); } catch (e) {} pickerWatch = null; }
    if (pickerTimer) { clearTimeout(pickerTimer); pickerTimer = null; }
  }

  function restoreStudio(onRestore) {
    if (window.GDStudioShell) window.GDStudioShell.show();
    if (typeof onRestore === "function") onRestore();
  }

  function watchPicker(onRestore) {
    stopWatch();
    var screen = document.getElementById("courseScreen");
    if (!screen) return;
    var seenOpen = false;
    pickerWatch = new MutationObserver(function () {
      var hidden = screen.classList.contains("hidden");
      if (!hidden) { seenOpen = true; return; }
      if (!seenOpen) return;
      stopWatch();
      restoreStudio(onRestore);
    });
    pickerWatch.observe(screen, { attributes: true, attributeFilter: ["class"] });
    /* If the picker never actually opened, do not leave the operator staring at the app with
       no way back to Studio. */
    pickerTimer = setTimeout(function () {
      if (!seenOpen) { stopWatch(); restoreStudio(onRestore); }
    }, 4000);
  }

  /* opts.source   - the picker's source label (which Studio page asked)
     opts.onPick   - called with the resolved course after Studio is back on screen
     opts.onReturn - called whenever Studio comes back, picked or cancelled (re-measure a map)
     Returns false, with no hand-off, when the picker is not on this surface. */
  function open(opts) {
    opts = opts || {};
    if (!window.GDCoursePicker || typeof window.GDCoursePicker.open !== "function") return false;
    watchPicker(opts.onReturn);
    if (window.GDStudioShell) window.GDStudioShell.hide();
    window.GDCoursePicker.open({
      source: opts.source || "studio",
      returnTarget: "home",
      onPick: function (course) {
        stopWatch();
        restoreStudio(opts.onReturn);
        if (typeof opts.onPick === "function") opts.onPick(course);
      }
    });
    return true;
  }

  window.GDStudioCoursePick = { open: open, cancel: stopWatch };
})();
