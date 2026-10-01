/* Resume Round on the course picker. Sole owner of #gdCourseResumeRound.
 *
 * The panel and its styling survived the /app/ cutover
 * (styles/inline/gd-course-picker-resume-round-v1-styles.css, still linked from
 * index.html); what went with the deleted GPS runtime was the code that filled
 * it in. Three call sites here have been calling gdEnsureResumeRoundPicker()
 * through a typeof guard ever since, silently doing nothing. This is the owner
 * they were asking for.
 *
 * It reads what /app/ wrote (app/js/resume.js). One origin serves the picker
 * and the play surface, so localStorage is the whole handoff — no endpoint, no
 * account round-trip, and it works offline, which is the state a player halfway
 * round a course is most likely to be in.
 *
 * Resuming is a navigation, not a restore: it re-enters /app/ at the course and
 * hole the round reached. The old panel promised to rebuild a shot in flight;
 * /app/ clears aim and position every hole by design, so that promise is not
 * this one's to make.
 */
(function () {
  "use strict";
  if (window.__gdResumeRoundPickerV1) return;
  window.__gdResumeRoundPickerV1 = true;

  var KEY = "clarity:resume-round:v1";
  var LEGACY_KEY = "gd_gps_resume_round_v1";

  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }
  function L(key, vars) { return window.GDI18n.t(key, vars); }

  /* The hole the round actually reached, or null when the course was opened
     and no hole started. Only v2 records (app/js/resume.js) carry one: v1's
     `hole` was the last hole on screen, browsed or played, and resuming it
     made a browsed hole live. */
  function liveHoleOf(saved) {
    if (Number(saved.version) < 2) return null;
    var n = Number(saved.liveHole);
    return Number.isFinite(n) && n >= 1 ? n : null;
  }

  function read() {
    var saved = safe(function () { return window.GDPlayContext ? window.GDPlayContext.readJson("resume-round", KEY) : JSON.parse(localStorage.getItem(KEY) || "null"); }, null);
    if (!saved || !saved.courseId) return null;
    var expires = Number(saved.expiresAt);
    if (Number.isFinite(expires) && Date.now() > expires) return null;
    return saved;
  }

  function clear() {
    safe(function () { if (window.GDPlayContext) window.GDPlayContext.remove("resume-round"); else localStorage.removeItem(KEY); });
    safe(function () { localStorage.removeItem(LEGACY_KEY); });
  }

  /* "just now" for anything inside a couple of minutes: a player who backed out
     to the picker and straight back in should not be told they left 0m ago. */
  function age(saved) {
    var ms = Date.now() - Number(saved.updatedAt || 0);
    if (!Number.isFinite(ms) || ms < 0) return "";
    var mins = Math.round(ms / 60000);
    if (mins < 2) return L("resumeRound.justNow");
    if (mins < 60) return L("resumeRound.minutesAgo", { n: mins });
    var hours = Math.floor(mins / 60);
    var rest = mins % 60;
    return rest ? L("resumeRound.hoursMinutesAgo", { h: hours, m: rest }) : L("resumeRound.hoursAgo", { n: hours });
  }

  function detail(saved) {
    var parts = [saved.courseName || L("resumeRound.round")];
    var hole = liveHoleOf(saved);
    if (hole) parts.push(L("resumeRound.holeShort", { n: hole }));
    var when = age(saved);
    if (when) parts.push(when);
    return parts.join(" · ");
  }

  function playUrl(saved) {
    var parts = ["courseId=" + encodeURIComponent(saved.courseId)];
    if (saved.courseName) parts.push("courseName=" + encodeURIComponent(saved.courseName));
    if (Number.isFinite(Number(saved.courseLat))) parts.push("courseLat=" + encodeURIComponent(saved.courseLat));
    if (Number.isFinite(Number(saved.courseLng))) parts.push("courseLng=" + encodeURIComponent(saved.courseLng));
    /* No live hole, no hole on the URL: /app/ opens the course in Preview
       rather than being told hole 1 was being played. */
    var hole = liveHoleOf(saved);
    if (hole) parts.push("hole=" + encodeURIComponent(hole));
    /* index.html explicitly, not "/app/" — a bare directory path is treated as
       an SPA route by the native shells and re-enters the old app. Same reason
       navigateToAppPlay in the picker spells it out. */
    return "/app/index.html?" + parts.join("&");
  }

  function stop(event) {
    if (!event) return;
    if (event.preventDefault) event.preventDefault();
    if (event.stopPropagation) event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  }

  function ensurePanel() {
    var screen = document.getElementById("courseScreen");
    if (!screen) return null;
    var panel = document.getElementById("gdCourseResumeRound");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "gdCourseResumeRound";
      panel.innerHTML = '<button class="gdCourseResumePrimary" type="button">'
        + '<strong data-i18n="resumeRound.resume">Resume Round</strong><span></span></button>'
        + '<button class="gdCourseResumeNew" type="button" data-i18n="resumeRound.end">End Round</button>';
      window.GDI18n.apply(panel);
      var header = screen.querySelector(".courseHeader");
      if (header && header.parentNode) header.parentNode.insertBefore(panel, header.nextSibling);
      else screen.insertBefore(panel, screen.firstChild);
    }
    var saved = read();
    panel.hidden = !saved;
    panel.classList.toggle("visible", !!saved);
    var detailEl = panel.querySelector(".gdCourseResumePrimary span");
    if (detailEl) detailEl.textContent = saved ? detail(saved) : "";
    var resume = panel.querySelector(".gdCourseResumePrimary");
    if (resume && !resume.__gdResumeBound) {
      resume.__gdResumeBound = true;
      resume.addEventListener("click", resumeRound, true);
    }
    var end = panel.querySelector(".gdCourseResumeNew");
    if (end && !end.__gdEndBound) {
      end.__gdEndBound = true;
      end.addEventListener("click", endRound, true);
    }
    return panel;
  }

  function resumeRound(event) {
    stop(event);
    var saved = read();
    if (!saved) { ensurePanel(); return false; }
    window.location.href = playUrl(saved);
    return false;
  }

  function endRound(event) {
    stop(event);
    clear();
    ensurePanel();
    safe(function () { if (typeof toast === "function") toast(L("resumeRound.ended")); });
    return false;
  }

  /* The detail line is written by code: refresh it in the new words. */
  window.GDI18n.onChange(function () { ensurePanel(); });

  window.gdEnsureResumeRoundPicker = ensurePanel;
  window.gdResumeRoundFromPicker = resumeRound;
  window.gdEndRoundFromPicker = endRound;
  window.gdStartNewRoundFromPicker = endRound;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { ensurePanel(); }, { once: true });
  } else {
    ensurePanel();
  }
})();
