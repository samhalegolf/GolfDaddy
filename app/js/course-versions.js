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

  app.courseVersions = {
    comparableVersion: comparableVersion,
    /* The one definition of "the downloaded copy is out of date", shared by
       app/js/course-store.js and the old shell's Course Library panel so the
       two cannot disagree about what the badge means.

       local:  a saved record {objectsVersion, mapVersion, savedAt}
       remote: the manifest row {objectsVersion, mapVersion} */
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
      var newerMap = Number.isFinite(Number(remote.mapVersion))
        && Number(remote.mapVersion) > Number(local.mapVersion || 0);
      if (newerMap) return "frame";
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
