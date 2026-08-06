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

  /* Three hours since the last hole change, not since the round began — a round
     takes longer than that, and every hole refreshes it. What this expires is an
     abandoned round, which is exactly the one you do not want offered back. */
  var TTL_MS = 3 * 60 * 60 * 1000;

  var course = null;
  var hole = 0;

  function num(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function write() {
    if (!course || !course.courseId) return null;
    var now = Date.now();
    var payload = {
      version: 1,
      courseId: String(course.courseId),
      courseName: String(course.courseName || ""),
      courseLat: num(course.courseLat),
      courseLng: num(course.courseLng),
      hole: Number(hole) || 1,
      updatedAt: now,
      expiresAt: now + TTL_MS
    };
    try { localStorage.setItem(KEY, JSON.stringify(payload)); } catch (e) {}
    return payload;
  }

  function read() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { return null; }
    if (!saved || !saved.courseId) return null;
    var expires = Number(saved.expiresAt);
    if (Number.isFinite(expires) && Date.now() > expires) return null;
    return saved;
  }

  app.resume = {
    /* The round is genuinely up: a course was resolved and play started. */
    setCourse: function (next) {
      course = next && next.courseId ? next : null;
      hole = 0;
      return write();
    },
    /* Every hole change, which is also what keeps the round from expiring. */
    setHole: function (n) {
      var next = Number(n) || 0;
      if (!course || !next || next === hole) return null;
      hole = next;
      return write();
    },
    read: read,
    /* Ending the round is the player saying they are done with it. */
    clear: function () {
      course = null;
      hole = 0;
      try { localStorage.removeItem(KEY); } catch (e) {}
      try { localStorage.removeItem(LEGACY_KEY); } catch (e) {}
      return true;
    }
  };
})();
