/* Demo Mode session companion (GPS-play side).
 *
 * app/index.html is a separate document from the main site, reached only by
 * a full navigation (see gd-course-picker-search-v2.js:navigateToAppPlay),
 * so this file re-reads the same sessionStorage key the practice-side
 * gd-demo-session.js wrote before the navigation. It never writes
 * practiceAnalysis/adoption - those are owned by the practice side. It only
 * reads adoptedBubble/demoBag for the my-bubble.js seam, and later flips
 * courseDataActive before handing back to the main site.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'gd_demo_session_v1';

  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  function nowIso() { return new Date().toISOString(); }

  function read() {
    return safe(function () {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    }, null);
  }

  function write(state) {
    safe(function () { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }, null);
  }

  /* window.GDBubbleEngine only exists on this side of the app (app/js/), not
     on the main site - so the demo bag is computed here, lazily, the first
     time it's read, using the exact same pure scale math app/js/bag.js's
     generateQuickSet() uses, just never passed through its sync()/save(). */
  function demoBagFor(sevenIronCarryM) {
    var defaults = safe(function () {
      return window.GDBubbleEngine && typeof window.GDBubbleEngine.defaultBagRows === 'function'
        ? window.GDBubbleEngine.defaultBagRows() : [];
    }, []) || [];
    var ref = defaults.filter(function (r) { return r.club === '7i'; })[0];
    if (!(Number(sevenIronCarryM) > 0) || !defaults.length || !ref || !(ref.baseCarry > 0)) return [];
    var scale = Number(sevenIronCarryM) / ref.baseCarry;
    return defaults.map(function (row) { return { club: row.club, baseCarry: Math.round(row.baseCarry * scale) }; });
  }

  function setCourseDataActive(active) {
    var state = read();
    if (!state) return;
    state.courseDataActive = !!active;
    write(state);
  }

  function markGpsEntered() {
    var state = read();
    if (!state) return;
    state.gpsEnteredAt = nowIso();
    write(state);
  }

  var api = {
    get active() { var s = read(); return !!(s && s.active); },
    get adopted() { var s = read(); return !!(s && s.adopted); },
    get adoptedBubble() { var s = read(); return (s && s.adoptedBubble) || null; },
    get demoBag() {
      var s = read();
      if (!s) return [];
      if (Array.isArray(s.demoBag) && s.demoBag.length) return s.demoBag;
      return demoBagFor(s.sevenIronCarryM);
    },
    get gpsEnteredAt() { var s = read(); return s ? s.gpsEnteredAt : null; },
    setCourseDataActive: setCourseDataActive,
    markGpsEntered: markGpsEntered
  };

  window.GDDemoSession = api;
})();
