/* Resume Round — which course and hole the round had reached, so the course
   picker can offer to drop the player back into it.

   Deliberately NOT a snapshot of a shot in flight. The version that was deleted
   with the old GPS runtime stored start/target/green/pin and rebuilt that
   runtime's camera from them. That runtime is gone, and /app/ clears position,
   aim and pin on every hole change on purpose (goHole). Offering to restore a
   half-played shot would be a promise this app cannot keep, so what is recorded
   is the thing that is actually true a round later: where you were up to.

   Strokes already survive on their own — scorecard.js persists them per course
   under clarity:scorecard:v1 — so resuming the hole resumes the card with it.

   Written here, read by the picker on the main site. One origin serves both
   surfaces, so a single localStorage key is the entire handoff; nothing new
   crosses the network for this.

   Absence is a state (rule 4): no saved round is the normal case, and the
   picker simply shows nothing. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  var KEY = "clarity:resume-round:v1";
  /* The deleted runtime's key. Cleared alongside ours so a device that played a
     round before the cutover cannot resurrect a v4 payload nothing reads. */
  var LEGACY_KEY = "gd_gps_resume_round_v1";

  /* Three hours since the live hole last changed, not since the round began —
     a round takes longer than that, and every hole started refreshes it. What
     this expires is an abandoned round, which is exactly the one you do not
     want offered back. */
  var TTL_MS = 3 * 60 * 60 * 1000;

  /* v2 names the field for what it is. v1 stored `hole`, written on every hole
     the screen showed - arrows, picker, Preview - so it was the last VIEWED
     hole, and reopening the course resumed it as the live one. */
  var VERSION = 2;

  var course = null;
  /* null is a state: the course is open and no hole has been started. */
  var liveHole = null;

  function num(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function holeOrNull(value) {
    var n = Number(value);
    return Number.isFinite(n) && n >= 1 ? n : null;
  }

  function write() {
    if (!course || !course.courseId) return null;
    var now = Date.now();
    var payload = {
      version: VERSION,
      courseId: String(course.courseId),
      courseName: String(course.courseName || ""),
      courseLat: num(course.courseLat),
      courseLng: num(course.courseLng),
      liveHole: liveHole,
      updatedAt: now,
      expiresAt: now + TTL_MS
    };
    try { if (window.GDPlayContext) window.GDPlayContext.writeJson("resume-round", payload); else localStorage.setItem(KEY, JSON.stringify(payload)); } catch (e) {}
    return payload;
  }

  /* A v1 record keeps its course, so the picker still offers the way back in,
     but not its hole: v1's `hole` was whatever was last on screen, and there
     is no telling a played hole from a browsed one. The player lands in
     Preview and Play / the tee zone starts the hole, as on any first open. */
  function normalise(saved) {
    return {
      version: VERSION,
      courseId: String(saved.courseId),
      courseName: String(saved.courseName || ""),
      courseLat: num(saved.courseLat),
      courseLng: num(saved.courseLng),
      liveHole: Number(saved.version) >= VERSION ? holeOrNull(saved.liveHole) : null,
      updatedAt: num(saved.updatedAt),
      expiresAt: num(saved.expiresAt)
    };
  }

  function read() {
    var saved = null;
    try { saved = window.GDPlayContext ? window.GDPlayContext.readJson("resume-round", KEY) : JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { return null; }
    if (!saved || !saved.courseId) return null;
    var expires = Number(saved.expiresAt);
    if (Number.isFinite(expires) && Date.now() > expires) return null;
    return normalise(saved);
  }

  app.resume = {
    /* A course is open. No hole is live yet - opening a course is not
       starting one, and hole 1 is not assumed. */
    setCourse: function (next) {
      course = next && next.courseId ? next : null;
      liveHole = null;
      return write();
    },
    /* The canonical live hole changed (Marshal's liveHoleChanged effect, fired
       only from startHole). Never a viewed hole. */
    setLiveHole: function (n) {
      var next = holeOrNull(n);
      if (!course || !next || next === liveHole) return null;
      liveHole = next;
      return write();
    },
    read: read,
    /* Ending the round is the player saying they are done with it. */
    clear: function () {
      course = null;
      liveHole = null;
      try { if (window.GDPlayContext) window.GDPlayContext.remove("resume-round"); else localStorage.removeItem(KEY); } catch (e) {}
      try { localStorage.removeItem(LEGACY_KEY); } catch (e) {}
      return true;
    }
  };
})();
