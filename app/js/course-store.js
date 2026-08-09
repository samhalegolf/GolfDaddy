/* Local persistence for downloaded course maps - the "course library" a
   course lives in between rounds, so play never has to wait on a network
   round-trip for a course already downloaded.

   localStorage-backed. Metadata only (geometry + visual playSurface
   transforms) - never the actual photo bytes, which stay small enough that
   many courses fit comfortably under a localStorage quota. Shared with the
   old shell via the same origin, so Player Profile > Course Library reads
   the same records this writes. Capacitor's WebView has the same
   localStorage API, so this needs no separate native code path for that
   context - "cache" vs. "local storage" in how this was described is a
   naming difference between the browser and the wrapped app, not two
   different mechanisms this needs to implement. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var STORE_KEY = "clarity:course-library:v1";

  function readAll() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {}; } catch (e) { return {}; }
  }
  function writeAll(all) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); return true; } catch (e) { return false; }
  }

  app.courseStore = {
    /* entry: {courseId, courseName, mapType: "object"|"published", objectsVersion, mapVersion, pkg}.
       Returns the saved record (with byte size + timestamp filled in), or
       null if localStorage rejected the write (quota, private browsing). */
    save: function (entry) {
      if (!entry || !entry.courseId) return null;
      var body = JSON.stringify(entry.pkg || null);
      var record = {
        courseId: entry.courseId,
        courseName: entry.courseName || entry.courseId,
        mapType: entry.mapType === "published" ? "published" : "object",
        objectsVersion: entry.objectsVersion || null,
        mapVersion: Number.isFinite(Number(entry.mapVersion)) ? Number(entry.mapVersion) : null,
        pkg: entry.pkg || null,
        savedAt: Date.now(),
        bytes: body.length
      };
      var all = readAll();
      all[record.courseId] = record;
      return writeAll(all) ? record : null;
    },
    load: function (courseId) {
      return readAll()[courseId] || null;
    },
    list: function () {
      var all = readAll();
      return Object.keys(all).map(function (id) { return all[id]; })
        .sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
    },
    remove: function (courseId) {
      var all = readAll();
      delete all[courseId];
      return writeAll(all);
    },
    /* Is the server's manifest row (from /api/course-library: objectsVersion
       a sortable timestamp string, mapVersion an integer) newer than what's
       saved locally? No local copy is not "an update" - that's a fresh
       download, a different action. */
    updateAvailable: function (courseId, remote) {
      var local = this.load(courseId);
      if (!local || !remote) return false;
      return app.courseVersions.isStale(local, {
        objectsVersion: remote.objectsVersion,
        mapVersion: remote.mapVersion
      });
    }
  };
})();
