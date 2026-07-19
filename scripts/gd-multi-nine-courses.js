(function () {
  'use strict';

  // Support for courses with more than two 9-hole loops (e.g. Howeston's
  // three nines) inside a scorecard/round/GPS pipeline that otherwise only
  // ever assumes a single front-9 + back-9 = 18 layout.
  //
  // Everywhere downstream (holeCount(), nextHole()/previousHole(),
  // gdScorecardHoleAt(), the GPS course-play pipeline, captured-surface hole
  // indexing) reads `scorecard.holes` as a flat array and treats array index
  // (hole - 1) as the lookup key, so a hole MUST be numbered 1..N
  // contiguously. There's no realistic way to preserve a course's true
  // hole numbers (e.g. 19-27 for a third nine) without that array-index
  // assumption breaking throughout the app - so a 3-nine course is modelled
  // here as: pick any two of the three nines, and they get loaded into
  // `scorecard.holes` renumbered 1-18, exactly like a normal two-nine
  // course. Everything else keeps working unmodified.
  //
  // Caveat this implies: captured-surface scans / GPS hole data are filed
  // under the renumbered hole (1-18), not the course's physical hole number.
  // If a player later plays the same nine paired with a *different* other
  // nine, that renumbering shifts and old scans/GPS data for that nine won't
  // line up. Fine for the common case of always playing the same pairing;
  // a real fix would need the hole-indexing assumption above removed
  // app-wide, which is out of scope here.

  var SELECTION_KEY = 'gd_nine_selection_v1';

  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

  function placeholderNine(count) {
    var holes = [];
    for (var i = 0; i < count; i++) holes.push({ hole: i + 1, par: null, index: null, metres: null });
    return holes;
  }

  // Multi-nine course registry. Match by course name so this works
  // regardless of which of the app's several course-key slug schemes is
  // active for a given call site.
  var COURSES = [
    {
      key: 'howeston-golf-club',
      match: /howeston/i,
      nines: [
        { id: 'A', label: 'Nine A', holes: placeholderNine(9) },
        { id: 'B', label: 'Nine B', holes: placeholderNine(9) },
        { id: 'C', label: 'Nine C', holes: placeholderNine(9) }
      ]
    }
  ];

  function multiNineCourseFor(course) {
    var name = String(course && (course.name || course.courseName) || '');
    if (!name) return null;
    return COURSES.find(function (entry) { return entry.match.test(name); }) || null;
  }

  function readSelections() {
    return safe(function () { return JSON.parse(localStorage.getItem(SELECTION_KEY) || '{}') || {}; }, {}) || {};
  }

  function writeSelections(map) {
    safe(function () { localStorage.setItem(SELECTION_KEY, JSON.stringify(map || {})); });
  }

  function validSelection(entry, ids) {
    return Array.isArray(ids) && ids.length === 2 && ids.every(function (id) {
      return entry.nines.some(function (n) { return n.id === id; });
    });
  }

  function selectionFor(entry) {
    var all = readSelections();
    var picked = all[entry.key];
    if (validSelection(entry, picked)) return picked;
    return [entry.nines[0].id, entry.nines[1].id];
  }

  function buildHoles(entry, nineIds) {
    var chosen = nineIds.map(function (id) {
      return entry.nines.find(function (n) { return n.id === id; });
    }).filter(Boolean);
    var holes = [];
    chosen.forEach(function (nine, sideIndex) {
      nine.holes.forEach(function (h, holeIndex) {
        holes.push(Object.assign({}, h, {
          hole: sideIndex * 9 + holeIndex + 1,
          score: null,
          putts: null,
          tees: {},
          nineId: nine.id,
          nineLabel: nine.label,
          realHoleNumber: h.hole
        }));
      });
    });
    return holes;
  }

  var shellInstalled = false;
  var renderInstalled = false;

  function wrapScorecardShell() {
    if (shellInstalled) return true;
    var original = window.gdScorecardShell;
    if (typeof original !== 'function') return false;
    function wrapped(course, reason) {
      var entry = multiNineCourseFor(course);
      var shell = original(course, reason);
      if (!entry) return shell;
      var nineIds = selectionFor(entry);
      shell.holes = buildHoles(entry, nineIds);
      shell.nines = { available: entry.nines.map(function (n) { return { id: n.id, label: n.label }; }), selected: nineIds };
      return shell;
    }
    window.gdScorecardShell = wrapped;
    shellInstalled = true;
    return true;
  }

  function applySelection(entry, nineIds, course) {
    if (!validSelection(entry, nineIds)) return false;
    var all = readSelections();
    all[entry.key] = nineIds;
    writeSelections(all);
    safe(function () {
      if (typeof scorecard === 'undefined' || !scorecard) return;
      var holes = buildHoles(entry, nineIds);
      scorecard.holes = typeof gdScorecardMergeScores === 'function' ? gdScorecardMergeScores(holes, scorecard.holes) : holes;
      scorecard.source = 'shell';
      scorecard.nines = { available: entry.nines.map(function (n) { return { id: n.id, label: n.label }; }), selected: nineIds };
      // Drop any cached website-scorecard entry for this course so a future
      // reload doesn't resurrect the previous nine pairing from cache.
      safe(function () {
        if (typeof GD_SCORECARD_CACHE_KEY === 'undefined' || typeof gdScorecardCourseKey !== 'function') return;
        var cacheKey = gdScorecardCourseKey(course || null);
        var cache = JSON.parse(localStorage.getItem(GD_SCORECARD_CACHE_KEY) || '{}') || {};
        if (cacheKey && cache[cacheKey]) { delete cache[cacheKey]; localStorage.setItem(GD_SCORECARD_CACHE_KEY, JSON.stringify(cache)); }
      });
      if (typeof selectedHole !== 'undefined') selectedHole = Math.max(1, Math.min(scorecard.holes.length || 18, Number(selectedHole) || 1));
      if (typeof renderScorecard === 'function') renderScorecard();
      safe(function () { window.dispatchEvent(new CustomEvent('clarity:nine-selection-changed', { detail: { courseKey: entry.key, nines: nineIds } })); });
    });
    return true;
  }

  function ensureStyle() {
    if (document.getElementById('gdNineSelectorStyle')) return;
    var style = document.createElement('style');
    style.id = 'gdNineSelectorStyle';
    style.textContent = '.gdNineSelectorRow{display:flex;gap:6px;margin:2px 0 10px;flex-wrap:wrap}' +
      '.gdNineSelectorBtn{flex:1 1 auto;min-width:64px;height:34px;border-radius:12px;border:1px solid rgba(255,255,255,.14);' +
      'background:rgba(255,255,255,.06);color:#fff;font-weight:850;font-size:12px;letter-spacing:.02em;cursor:pointer}' +
      '.gdNineSelectorBtn.active{background:#1fd36d;color:#071008;border-color:#1fd36d}' +
      '.gdNineSelectorHint{width:100%;font-size:11px;color:rgba(255,255,255,.5);margin-top:2px}';
    document.head.appendChild(style);
  }

  function renderPicker(entry, course) {
    var meta = document.getElementById('gdScoreCourseMeta');
    if (!meta || !meta.parentNode) return;
    ensureStyle();
    var row = document.getElementById('gdNineSelectorRow');
    if (!row) {
      row = document.createElement('div');
      row.id = 'gdNineSelectorRow';
      row.className = 'gdNineSelectorRow';
      meta.parentNode.insertBefore(row, meta.nextSibling);
    }
    var selected = selectionFor(entry);
    row.innerHTML = entry.nines.map(function (nine) {
      var isActive = selected.indexOf(nine.id) !== -1;
      return '<button type="button" class="gdNineSelectorBtn' + (isActive ? ' active' : '') + '" data-nine-id="' +
        nine.id + '">' + nine.label + '</button>';
    }).join('') + '<div class="gdNineSelectorHint">Pick the two nines you\'re playing today</div>';
    Array.prototype.forEach.call(row.querySelectorAll('.gdNineSelectorBtn'), function (btn) {
      btn.onclick = function (event) {
        if (event) event.preventDefault();
        var id = btn.getAttribute('data-nine-id');
        var current = selectionFor(entry);
        var next;
        if (current.indexOf(id) !== -1) {
          if (current.length <= 1) return; // keep at least one selected
          next = current.filter(function (n) { return n !== id; });
        } else {
          next = current.length >= 2 ? [current[1], id] : current.concat([id]);
        }
        if (next.length !== 2) return;
        applySelection(entry, next, course);
        renderPicker(entry, course);
      };
    });
  }

  function removePicker() {
    var row = document.getElementById('gdNineSelectorRow');
    if (row && row.parentNode) row.parentNode.removeChild(row);
  }

  function installScorecardRenderHook() {
    if (renderInstalled) return true;
    if (typeof document === 'undefined' || !document.addEventListener) return false;
    document.addEventListener('gd:scorecard-render', function () {
      safe(function () {
        var course = typeof gdScorecardConfirmedCourse === 'function' ? gdScorecardConfirmedCourse() : null;
        var entry = multiNineCourseFor(course);
        if (entry) renderPicker(entry, course); else removePicker();
      });
    });
    renderInstalled = true;
    return true;
  }

  var installAttempts = 0;
  function install() {
    var okShell = wrapScorecardShell();
    var okRender = installScorecardRenderHook();
    if ((!okShell || !okRender) && installAttempts++ < 10) setTimeout(install, 400);
  }

  window.GolfDaddyMultiNineCourses = {
    courseFor: multiNineCourseFor,
    selectionFor: selectionFor,
    setSelection: function (courseKey, nineIds) {
      var entry = COURSES.find(function (c) { return c.key === courseKey; });
      return entry ? applySelection(entry, nineIds) : false;
    },
    list: function () { return COURSES.slice(); }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
