/* Round usage: did a round that was opened actually get played?

   The anonymous usage counter (scripts/gd-course-usage-report.js) already says a round was
   OPENED. That is all it says - an open from the sofa the night before and eighteen holes on
   the course look the same. This module keeps a small running summary of the round on this
   device and, once the round is over, counts ONE anonymous outcome for it:

     played         on the course for 9+ holes, or 90+ minutes
     part-round     on the course for 60-90 minutes and fewer than 9 holes
     stopped-early  on the course, but gave up inside the hour and before hole 9 - the case
                    worth looking at: somebody stood on the course and tried to use the app
     off-course     never on the course: looking at it from somewhere else
     on-watch       a watch took the round over, so the phone cannot see how far it went

   "On the course" means a GPS fix good to 100 m that is within 450 m of the tee or green of
   the hole in play - near enough to be walking that hole, far enough for the middle of a
   long par 5. Time on the course runs from the first such fix to the last thing that showed
   the round moving on (a hole change, or another fix on the course).

   This is the same signal the course-package request logs show (one request per hole), read
   at the source instead: it survives a dead signal mid-round and is not lost after the logs'
   seven days. Only the outcome is sent - never a position, a time or an id - plus one word
   about the bag: "own" when the player had set their own bag by the end of the round
   (scripts/gd-bag-status.js, read off the distances), "not-set" otherwise.

   A round rarely ends cleanly - phones go in pockets and apps get killed - so the summary is
   kept in localStorage as it goes and finalised by whichever comes first: the round's own
   end, a different course being opened, or the app starting again after the round has been
   quiet for three hours (or on another day). Pure apart from the storage and clock it is
   given; node-requirable for dev/round-usage.test.js. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else {
    root.ClarityApp = root.ClarityApp || {};
    root.ClarityApp.createRoundUsage = factory();
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var STORAGE_KEY = "gd-round-usage:v1";
  var ON_COURSE_M = 450;
  var GOOD_FIX_M = 100;
  var PLAYED_HOLES = 9;
  var PLAYED_MS = 90 * 60 * 1000;
  var STOPPED_EARLY_MS = 60 * 60 * 1000;
  var STALE_MS = 3 * 60 * 60 * 1000;
  /* A fix arrives every second or two; the stored summary only needs the minute. */
  var SAVE_EVERY_MS = 60 * 1000;

  function point(p) {
    if (!p) return null;
    if (Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))) return p;
    return p.green ? point(p.green) : null;
  }

  function classify(s) {
    var holes = (s.holes || []).length;
    if (holes >= PLAYED_HOLES && s.onCourseAt) return "played";
    if (s.watch) return "on-watch";
    if (!s.onCourseAt) return "off-course";
    var onCourseMs = Math.max(0, (s.lastAt || s.onCourseAt) - s.onCourseAt);
    if (onCourseMs >= PLAYED_MS) return "played";
    if (onCourseMs < STOPPED_EARLY_MS) return "stopped-early";
    return "part-round";
  }

  function sameDay(a, b) {
    return new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
  }

  function createRoundUsage(options) {
    options = options || {};
    var storage = options.storage || null;
    var now = options.now || function () { return Date.now(); };
    var report = options.report || function () {};
    var distance = options.distance;
    /* True / false for "has the player set their own bag", or null when it cannot be told. */
    var bagSet = options.bagSet || function () { return null; };
    var current = load();
    var currentHole = null;
    var savedAt = 0;

    function load() {
      try { return storage ? JSON.parse(storage.getItem(STORAGE_KEY) || "null") : null; } catch (e) { return null; }
    }
    function save(force) {
      if (!storage) return;
      var t = now();
      if (!force && t - savedAt < SAVE_EVERY_MS) return;
      savedAt = t;
      try {
        if (current) storage.setItem(STORAGE_KEY, JSON.stringify(current));
        else storage.removeItem(STORAGE_KEY);
      } catch (e) {}
    }

    function finish() {
      if (!current) return null;
      var done = current;
      var outcome = classify(done);
      current = null;
      currentHole = null;
      save(true);
      /* Asked as the round is counted: a bag set mid-round counts as set for that round. */
      var own = null;
      try { own = bagSet(); } catch (e) { own = null; }
      try {
        report({ courseId: done.courseId, courseName: done.courseName, event: "round", outcome: outcome, mapType: done.mapType, version: done.version,
          bag: own === true ? "own" : own === false ? "not-set" : "" });
      } catch (e) {}
      return outcome;
    }

    function stale(s, t) {
      return !s || t - (s.lastAt || s.startedAt || 0) >= STALE_MS || !sameDay(s.startedAt || 0, t);
    }

    return {
      /* A round opened on a course. Reopening the same course the same day carries on the
         round already being counted; anything else finishes it first. */
      start: function (course) {
        var t = now();
        var courseId = String(course && course.courseId || "");
        if (!courseId) return;
        if (current && (current.courseId !== courseId || stale(current, t))) finish();
        if (!current) {
          current = { courseId: courseId, courseName: String(course.courseName || ""), startedAt: t, lastAt: t, holes: [], onCourseAt: 0, watch: false };
        }
        if (course.mapType) current.mapType = course.mapType;
        if (course.version) current.version = course.version;
        save(true);
      },
      hole: function (holeNumber, rec) {
        currentHole = rec || null;
        if (!current) return;
        var n = Number(holeNumber);
        if (Number.isFinite(n) && current.holes.indexOf(n) < 0) current.holes.push(n);
        current.lastAt = now();
        save(true);
      },
      fix: function (fix) {
        if (!current || !fix || !currentHole || !distance) return;
        if (!(Number(fix.accuracy) <= GOOD_FIX_M)) return;
        var near = [point(currentHole.tee), point(currentHole.green)].some(function (p) {
          var d = p ? distance.haversineMeters(fix, p) : null;
          return d != null && d <= ON_COURSE_M;
        });
        if (!near) return;
        var t = now();
        if (!current.onCourseAt) { current.onCourseAt = t; current.lastAt = t; save(true); return; }
        current.lastAt = t;
        save(false);
      },
      /* A watch is driving the round: from here the phone may sleep through it. */
      watchDriving: function () {
        if (!current || current.watch) return;
        current.watch = true;
        save(true);
      },
      end: finish,
      /* On start-up: a round left behind by a killed or pocketed app is counted now. */
      flushStale: function () {
        if (current && stale(current, now())) return finish();
        return null;
      },
      current: function () { return current; }
    };
  }

  createRoundUsage.classify = classify;
  createRoundUsage.STORAGE_KEY = STORAGE_KEY;
  return createRoundUsage;
});
