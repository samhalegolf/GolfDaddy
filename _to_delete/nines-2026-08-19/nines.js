/* Multi-nine courses (more than 18 holes, e.g. three 9-hole loops) let the
   player pick which two nines they're playing today. Holes keep their real
   physical numbers throughout — /api/course-package already keys geometry
   by holeNumber, so there is no renumbering to do, only which subset is "in
   play" and in what order. A course with 18 or fewer holes always plays
   1..holeCount in order; this module only produces a result for courses
   with more, and callers treat a null result as "no picker needed". */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var STORE_KEY = "clarity:nines:v1";

  function readSelections() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {}; } catch (e) { return {}; }
  }

  function writeSelections(map) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(map)); } catch (e) {}
  }

  function range(start, end) {
    var out = [];
    for (var h = start; h <= end; h++) out.push(h);
    return out;
  }

  /* Nines are contiguous 9-hole blocks: 1-9, 10-18, 19-27, ... A hole count
     that isn't a clean multiple of 9, or is 18 or fewer, has nothing to
     pick — the course just plays 1..holeCount in order as it always has. */
  function ninesFor(holeCount) {
    if (!(holeCount > 18) || holeCount % 9 !== 0) return null;
    var nines = [];
    for (var i = 0; i < holeCount / 9; i++) {
      nines.push({ id: String(i + 1), label: "Nine " + String.fromCharCode(65 + i), holes: range(i * 9 + 1, i * 9 + 9) });
    }
    return nines;
  }

  function validSelection(nines, ids) {
    return Array.isArray(ids) && ids.length === 2 && ids[0] !== ids[1] &&
      ids.every(function (id) { return nines.some(function (n) { return n.id === id; }); });
  }

  function holesInPlay(nines, ids) {
    return ids.reduce(function (out, id) {
      var nine = nines.find(function (n) { return n.id === id; });
      return nine ? out.concat(nine.holes) : out;
    }, []);
  }

  function holeCountOf(pkg) {
    var holes = pkg && Array.isArray(pkg.holes) ? pkg.holes : [];
    return holes.reduce(function (max, h) { return Math.max(max, Number(h && h.holeNumber) || 0); }, 0);
  }

  function describe(courseKey, holeCount, ids) {
    var nines = ninesFor(holeCount);
    if (!nines) return null;
    return { holeCount: holeCount, available: nines, selected: ids, holesInPlay: holesInPlay(nines, ids) };
  }

  app.nines = {
    /* pkg: the /api/course-package response. Returns null for a normal
       (<=18-hole, or non-multiple-of-9) course. */
    forPackage: function (courseKey, pkg) {
      var holeCount = holeCountOf(pkg);
      var nines = ninesFor(holeCount);
      if (!nines) return null;
      var all = readSelections();
      var selected = validSelection(nines, all[courseKey]) ? all[courseKey] : [nines[0].id, nines[1].id];
      return describe(courseKey, holeCount, selected);
    },
    select: function (courseKey, pkg, ids) {
      var holeCount = holeCountOf(pkg);
      var nines = ninesFor(holeCount);
      if (!nines || !validSelection(nines, ids)) return null;
      var all = readSelections();
      all[courseKey] = ids;
      writeSelections(all);
      return describe(courseKey, holeCount, ids);
    }
  };
})();
