/* One definition of "the downloaded copy of this course is out of date".

   Its own file because BOTH shells need it and they share no other code: the
   /app/ player loads it beside course-store.js, and the old shell's Player
   Profile > Course Library panel (scripts/gd-course-library-pin-lock.js) loads
   it beside its own store. Restating the rule in each place is what broke it -
   the two ends drifted onto different fields and the badge stopped meaning
   anything. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  /* Timestamp check, not a truthiness check. A stored objectsVersion only means
     something if it is the same KIND of value the server reports - an ISO
     timestamp. Records written before that was true hold the mapper algorithm
     version ("v1") or null, and comparing either against a timestamp gives an
     answer that looks confident and is meaningless. */
  function comparableVersion(value) {
    var s = value == null ? "" : String(value);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s : "";
  }

  /* A bake counter, or null when there is not one to compare. */
  function bakeNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    var n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  }

  /* Has the published PICTURE moved on?

     Answered from bake_number when the server reports one, and only from mapVersion
     when it does not. They are not the same number and mapVersion is not trustworthy:
     it carries course_visuals.published_version, which was never a counter but the
     digits scraped out of the export content hash ("r1alw6nz" -> 1). Because the test
     is "greater than", a re-bake that happened to scrape a SMALLER number read as no
     update at all, and the prompt silently never appeared. See
     supabase/migrations/20260918_add_course_visual_bake_number.sql.

     A local copy saved before bake numbers existed cannot be compared against one, so
     it reads as stale ONCE: the re-download is what gives it a number, and after that
     the comparison is honest. Guessing "probably current" would leave those copies
     permanently unable to notice a new bake, which is the bug being fixed rather than
     a smaller version of it. */
  function frameMoved(local, remote) {
    var remoteBake = bakeNumber(remote.bakeNumber);
    if (remoteBake !== null) {
      var localBake = bakeNumber(local.bakeNumber);
      if (localBake === null) return true;
      return remoteBake > localBake;
    }
    return Number.isFinite(Number(remote.mapVersion))
      && Number(remote.mapVersion) > Number(local.mapVersion || 0);
  }

  app.courseVersions = {
    comparableVersion: comparableVersion,
    frameMoved: frameMoved,
    /* The one definition of "the downloaded copy is out of date", shared by
       app/js/course-store.js and the old shell's Course Library panel so the
       two cannot disagree about what the badge means.

       local:  a saved record {objectsVersion, mapVersion, bakeNumber, savedAt}
       remote: the manifest row {objectsVersion, mapVersion, bakeNumber} */
    isStale: function (local, remote) {
      return app.courseVersions.updateKind(local, remote) !== "none";
    },
    /* WHICH part of the downloaded copy is out of date - the answer decides
       whether the player is asked. Same inputs as isStale.

         "frame"    - the published picture moved (mapVersion). The ground under
                      the player would change, so the app asks first.
         "geometry" - only the objects moved (objectsVersion): greens, tees,
                      routes, bunkers, water. Marshal swaps those under a live
                      round without disturbing it (PACKAGE_UPDATED), so this
                      one is safe to take unasked - and is exactly the update
                      that used to sit behind a prompt nobody saw.
         "none"     - up to date. */
    updateKind: function (local, remote) {
      if (!local || !remote) return "none";
      if (frameMoved(local, remote)) return "frame";
      var remoteObjects = comparableVersion(remote.objectsVersion);
      var localObjects = comparableVersion(local.objectsVersion);
      var newerObjects = false;
      if (remoteObjects) {
        if (localObjects) {
          newerObjects = remoteObjects > localObjects;
        } else if (local.savedAt) {
          /* Legacy record with no usable version. It still knows WHEN it was
             downloaded, and the server version is a timestamp, so "published
             after we downloaded it" answers the same question honestly.
             Treating a missing version as stale - which is what this used to
             do - flagged every one of them forever. */
          var published = Date.parse(remoteObjects);
          newerObjects = Number.isFinite(published) && published > Number(local.savedAt);
        }
      }
      return newerObjects ? "geometry" : "none";
    }
  };
})();
