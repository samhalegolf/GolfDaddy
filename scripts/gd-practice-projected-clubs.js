/* Practice: Projected Clubs, and Practice Session Comparison.
 *
 * Two views, one idea, which is why they live together:
 *
 *     ONE PLAYER MODEL, EXPRESSED AT DIFFERENT POINTS.
 *
 * Projected Clubs expresses it at different points through the BAG. Session
 * Comparison expresses two of them - the model Session A implies against the
 * model Session B implies - at the same points.
 *
 * ---------------------------------------------------------------------------
 * WHAT A PROJECTED CLUB IS NOT
 *
 * It is not a bubble built from that club's own rows. A projected 5i exists
 * whether or not a 5i was hit, because the model is normalised across the
 * session and then projected through the bag - the same thing GPS Play already
 * does when it draws a bubble for whatever club the distance calls for.
 *
 *     club-labelled shot evidence
 *         -> normalised player model
 *         -> Bubble Signals
 *         -> Micro-Geometry model
 *         -> club projector
 *         -> projected club bubbles
 *
 * Club labels establish relationships ACROSS the set. They do not make those
 * rows the owner of that club's bubble. Reading them the other way is the
 * mistake this whole file is arranged to prevent, and it is why the comparison
 * question is "what player model does Session A imply versus Session B" and
 * never "what bubble do these 6i rows make for the 6i".
 *
 * ---------------------------------------------------------------------------
 * NORMALISED STAYS PRIMARY
 *
 * Projected Clubs is the SECONDARY view. Normalised Practice remains the
 * default and is untouched by this file - gd-route-audit.js still renders it
 * exactly as it did, and the switcher starts on it.
 *
 * ---------------------------------------------------------------------------
 * NOT STUDIO-ONLY
 *
 * gdOpenPracticeSessionComparison() is exported on window from a file the
 * phone build loads, and the Practice screen shows its button. Studio's Bubble
 * Geometry page calls the same function. Studio is another entry point into
 * the comparison, not the owner of it.
 */
(function () {
  'use strict';

  var VIEW_KEY = 'gd_practice_bubble_view_v1';
  var STYLE_ID = 'gdPracticeProjectedClubsStyle';

  function core() { return window.GDBubbleSignalsCore || null; }
  function view() { return window.GDBubbleGeometryView || null; }

  function safe(fn, fallback) {
    try { return fn(); } catch (error) { return fallback; }
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '.gdPracticeViewSwitch{display:flex;gap:6px;align-items:center;margin:0 0 8px;flex-wrap:wrap}',
      '.gdPracticeViewSwitch button{background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.14);',
      'border-radius:999px;padding:4px 12px;font:inherit;font-size:12px;cursor:pointer}',
      '.gdPracticeViewSwitch button.isOn{background:rgba(60,255,141,.16);border-color:rgba(60,255,141,.5)}',
      '.gdPracticeViewSwitch .gdPracticeViewSpacer{flex:1}',
      '.gdProjectedClubs{display:flex;gap:8px;flex-wrap:nowrap;overflow-x:auto;padding:2px 0 6px}',
      '.gdProjectedClubs figure{margin:0;flex:1 1 0;min-width:104px;text-align:center}',
      '.gdProjectedClubs svg{width:100%;height:auto;display:block}',
      '.gdProjectedNote{font-size:11.5px;opacity:.62;line-height:1.5;margin:4px 0 0}',
      /* Fully opaque. At 94% the screen underneath bled through the cards and
         its text sat behind the numbers being compared, which is exactly the
         wrong place to make someone squint. */
      '.gdSessionCompare{position:fixed;inset:0;z-index:100300;background:#060a08;overflow:auto;padding:18px;',
      'color:#e7f3ec;font-size:13px}',
      '.gdSessionCompareInner{max-width:960px;margin:0 auto;display:flex;flex-direction:column;gap:14px}',
      '.gdSessionCompareHead{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}',
      '.gdSessionCompareHead h2{margin:0;font-size:16px}',
      '.gdSessionCompare select,.gdSessionCompare button{background:rgba(255,255,255,.07);color:#e7f3ec;',
      'border:1px solid rgba(255,255,255,.16);border-radius:6px;padding:5px 10px;font:inherit;font-size:12px}',
      '.gdSessionCompare button{cursor:pointer}',
      '.gdSessionCompareGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}',
      '.gdSessionCard{border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:12px 14px;background:rgba(255,255,255,.03)}',
      '.gdSessionCard h3{margin:0 0 8px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;opacity:.75}',
      '.gdSessionCard dl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:0;font-size:12px}',
      '.gdSessionCard dt{opacity:.6}.gdSessionCard dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}',
      '.gdSessionCompare .gdProjectedClubs figcaption{font-size:11px;opacity:.65}',
      '.gdSessionCompareLegend{display:flex;gap:14px;font-size:11.5px;opacity:.7;flex-wrap:wrap}',
      '.gdSessionCompareLegend i{display:inline-block;width:14px;border-top:2px solid;margin-right:5px;vertical-align:middle}',
      '.gdSessionEmpty{opacity:.65;line-height:1.6}'
    ].join('');
    document.head.appendChild(style);
  }

  /* ------------------------------------------------------------------
     View mode. Normalised is primary and is the default on a fresh
     install; the choice is remembered per device, not per session.
     ------------------------------------------------------------------ */

  function currentView() {
    var stored = safe(function () { return window.localStorage.getItem(VIEW_KEY); }, '');
    return stored === 'projected' ? 'projected' : 'normalised';
  }

  function setView(mode) {
    var next = mode === 'projected' ? 'projected' : 'normalised';
    safe(function () { window.localStorage.setItem(VIEW_KEY, next); });
    if (typeof window.renderPracticeData === 'function') window.renderPracticeData(true);
    return false;
  }

  /* ------------------------------------------------------------------
     Rows and model
     ------------------------------------------------------------------ */

  /* Practice shots as the Signal engine reads them. The Shot Library row shape
     is one of the shapes normaliseRows() accepts, so nothing is converted
     here - see gd-bubble-signals-core.js normaliseRow(). */
  function rowsFromAnalysis(analysis) {
    if (!analysis) return [];
    var accepted = Array.isArray(analysis.acceptedShots) ? analysis.acceptedShots : [];
    if (accepted.length) return accepted;
    return Array.isArray(analysis.shots) ? analysis.shots : [];
  }

  function libraryShots() {
    var lm = window.GolfDaddyLaunchMonitorData || window.ClarityCaddieLaunchMonitorData;
    if (!lm || typeof lm.displayStore !== 'function') return { shots: [], sessions: [] };
    var store = safe(function () { return lm.displayStore(); }, null) || {};
    return {
      shots: Array.isArray(store.shots) ? store.shots : [],
      sessions: Array.isArray(store.sessions) ? store.sessions : []
    };
  }

  /* The approved geometry: the server-decided model when there is one, and
     identity when there is not. This view never computes a geometry the phone
     would not have rendered anyway - it draws what the engine is holding. */
  function approvedGeometry() {
    var client = window.GDBubbleModelClient;
    var geometry = client && typeof client.geometry === 'function' ? client.geometry() : null;
    return geometry || (core() ? core().identityGeometry() : null);
  }

  function savedOffsetDeg() {
    var myBubble = window.ClarityApp && window.ClarityApp.myBubble;
    var saved = myBubble && typeof myBubble.current === 'function'
      ? safe(function () { return myBubble.current(); }, null)
      : null;
    return saved && Number.isFinite(Number(saved.offsetDeg)) ? Number(saved.offsetDeg) : 0;
  }

  /* The model a set of rows implies. Used for the projection club list and,
     in the comparison, for both sides. */
  function modelFor(rows, config) {
    var api = core();
    if (!api) return null;
    return api.buildPlayerModel({
      rows: rows,
      config: config || null,
      offsetDeg: savedOffsetDeg(),
      handedness: 'right',
      generatedAt: new Date().toISOString()
    });
  }

  /* ------------------------------------------------------------------
     Projected Clubs
     ------------------------------------------------------------------ */

  /* Four or five clubs spaced through the bag, PW to Driver. The point is to
     fit on one screen and show the progression, not to list the bag. */
  function projectionClubs(model) {
    if (!model) return [];
    var representative = model.projection.representativeClubs;
    if (representative && representative.length >= 3) return representative.slice(0, 5);
    return (model.projection.clubs || []).slice(0, 5);
  }

  function projectedClubsHtml(analysis) {
    ensureStyle();
    var api = core();
    var drawer = view();
    if (!api || !drawer) {
      return '<p class="gdProjectedNote">The Bubble model is not loaded on this build, so there is nothing to project.</p>';
    }

    var rows = rowsFromAnalysis(analysis);
    var model = modelFor(rows);
    var clubs = projectionClubs(model);
    if (!clubs.length) {
      return '<p class="gdProjectedNote">No practice data yet. Import a session and the same model will be shown '
        + 'projected through the bag.</p>';
    }

    var geometry = approvedGeometry();
    var payloads = clubs.map(function (entry) { return drawer.basePayload(entry.club, entry.carryM); });
    /* One shared scale across the row, so the long clubs genuinely look bigger
       than the wedges - that difference IS the progression. */
    var scaleTo = drawer.commonScale(payloads, geometry, 1);

    var figures = clubs.map(function (entry, index) {
      return '<figure>'
        + drawer.bubbleSvg(payloads[index], geometry, {
          width: 150, height: 150, exaggeration: 1, scaleTo: scaleTo,
          showLabels: false, ariaLabel: 'Projected bubble for ' + entry.club
        })
        + '<figcaption>' + esc(entry.club) + ' &middot; ' + Math.round(entry.carryM) + 'm</figcaption>'
        + '</figure>';
    }).join('');

    var moulded = !api.isIdentityGeometry(geometry);
    return '<div class="gdProjectedClubs">' + figures + '</div>'
      + '<p class="gdProjectedNote">One player model, projected through the bag. These are not separate bubbles built '
      + 'from each club\'s own shots - a projected club exists whether or not that club was hit.'
      + (moulded ? ' Micro-Geometry moulding is applied at production scale, which is deliberately almost invisible here.' : '')
      + '</p>';
  }

  /* The switcher plus whichever view is active. gd-route-audit.js calls this
     instead of writing practiceSvg() straight into the panel; when the mode is
     normalised it hands back exactly what it was given, so the primary view is
     byte-for-byte unchanged. */
  function practiceVisualHtml(normalisedHtml, analysis) {
    ensureStyle();
    var mode = currentView();
    var switcher = '<div class="gdPracticeViewSwitch" role="tablist" aria-label="Practice bubble view">'
      + '<button type="button" role="tab" aria-selected="' + (mode === 'normalised') + '"'
      + ' class="' + (mode === 'normalised' ? 'isOn' : '') + '"'
      + ' onclick="return window.gdSetPracticeBubbleView(\'normalised\')">Normalised</button>'
      + '<button type="button" role="tab" aria-selected="' + (mode === 'projected') + '"'
      + ' class="' + (mode === 'projected' ? 'isOn' : '') + '"'
      + ' onclick="return window.gdSetPracticeBubbleView(\'projected\')">Projected Clubs</button>'
      + '<span class="gdPracticeViewSpacer"></span>'
      + '<button type="button" onclick="return window.gdOpenPracticeSessionComparison()">Compare sessions</button>'
      + '</div>';
    return switcher + (mode === 'projected' ? projectedClubsHtml(analysis) : normalisedHtml);
  }

  /* ------------------------------------------------------------------
     Session comparison
     ------------------------------------------------------------------ */

  function sessionOptions() {
    var library = libraryShots();
    var byId = {};
    library.shots.forEach(function (shot) {
      var id = String((shot && (shot.sessionId || shot.importBatchId)) || '').trim();
      if (!id) return;
      (byId[id] = byId[id] || []).push(shot);
    });
    var labels = {};
    library.sessions.forEach(function (session) {
      var id = String((session && (session.sessionId || session.importBatchId)) || '').trim();
      if (id) labels[id] = session;
    });
    return Object.keys(byId).map(function (id) {
      var session = labels[id] || {};
      var when = session.startedAt || session.importedAt || '';
      return {
        id: id,
        shots: byId[id],
        label: (session.label || 'Practice session')
          + (when ? ' · ' + String(when).slice(0, 10) : '')
          + ' · ' + byId[id].length + ' shots'
      };
    }).sort(function (a, b) { return a.label < b.label ? 1 : -1; });
  }

  function summaryDl(model) {
    if (!model) return '<p class="gdSessionEmpty">No model.</p>';
    var fired = Object.keys(model.signals).filter(function (id) { return model.signals[id].fired; });
    return '<dl>'
      + '<dt>Shots</dt><dd>' + model.base.sampleShots + '</dd>'
      + '<dt>Clubs</dt><dd>' + model.base.clubsSeen + '</dd>'
      + '<dt>Pattern</dt><dd>' + esc(model.base.playerPattern) + '</dd>'
      + '<dt>Dispersion</dt><dd>' + Number(model.base.dispersionScale).toFixed(2) + '&times;</dd>'
      + '<dt>Signals firing</dt><dd>' + (fired.length ? esc(fired.join(', ')) : 'none') + '</dd>'
      + '<dt>Axis</dt><dd>' + Number(model.geometry.axisAdjustmentDeg || 0).toFixed(3) + '&deg;</dd>'
      + '</dl>';
  }

  function regionDelta(a, b) {
    var api = core();
    if (!api || !a || !b) return '';
    var rows = api.REGIONS.map(function (name) {
      var left = (Number(a[name]) - 1) * 100;
      var right = (Number(b[name]) - 1) * 100;
      return '<dt>' + esc(api.REGION_LABELS[name]) + '</dt><dd>'
        + left.toFixed(2) + '% &rarr; ' + right.toFixed(2) + '%</dd>';
    }).join('');
    return '<dl>' + rows + '</dl>';
  }

  function comparisonHtml(state) {
    var api = core();
    var drawer = view();
    var sessions = state.sessions;
    if (sessions.length < 2) {
      return '<div class="gdSessionCard"><p class="gdSessionEmpty">Comparing sessions needs at least two practice '
        + 'sessions in the Shot Library. There ' + (sessions.length === 1 ? 'is one' : 'are none') + ' right now.</p></div>';
    }

    var a = sessions.filter(function (s) { return s.id === state.a; })[0] || sessions[0];
    var b = sessions.filter(function (s) { return s.id === state.b; })[0] || sessions[1];
    /* The engine and every Signal are turned ON for the comparison. The
       question here is what each session IMPLIES, which is a different
       question from what is currently published - a comparison that showed two
       identity bubbles because the engine is off would answer nothing. */
    var probe = api.resolveConfig({
      enabled: true,
      signals: Object.keys(api.defaultConfig().signals).reduce(function (out, id) {
        out[id] = { enabled: true };
        return out;
      }, {})
    });
    var modelA = modelFor(a.shots, probe);
    var modelB = modelFor(b.shots, probe);

    var picker = function (which, selected) {
      return '<select data-gd-session="' + which + '">' + sessions.map(function (s) {
        return '<option value="' + esc(s.id) + '"' + (s.id === selected ? ' selected' : '') + '>' + esc(s.label) + '</option>';
      }).join('') + '</select>';
    };

    /* Both models projected through the SAME representative clubs, so the
       drawings are comparable. Clubs come from A - if B never hit a 4i, its
       model is still projected through one, which is the whole point. */
    var clubs = projectionClubs(modelA);
    var payloads = clubs.map(function (entry) { return drawer.basePayload(entry.club, entry.carryM); });
    var scaleTo = Math.max(
      drawer.commonScale(payloads, modelA.geometry, state.exaggeration),
      drawer.commonScale(payloads, modelB.geometry, state.exaggeration)
    );

    function strip(model, colour) {
      return '<div class="gdProjectedClubs">' + clubs.map(function (entry, index) {
        return '<figure>' + drawer.bubbleSvg(payloads[index], model.geometry, {
          width: 132, height: 132, exaggeration: state.exaggeration, scaleTo: scaleTo,
          showLabels: false, showAxes: false, adjColour: colour,
          ariaLabel: 'Projected bubble for ' + entry.club
        }) + '<figcaption>' + esc(entry.club) + '</figcaption></figure>';
      }).join('') + '</div>';
    }

    return '<div class="gdSessionCompareGrid">'
      + '<div class="gdSessionCard"><h3>Session A</h3>' + picker('a', a.id) + summaryDl(modelA) + '</div>'
      + '<div class="gdSessionCard"><h3>Session B</h3>' + picker('b', b.id) + summaryDl(modelB) + '</div>'
      + '</div>'
      + '<div class="gdSessionCard"><h3>Projected through the same clubs</h3>'
      + '<p class="gdProjectedNote">What player model does Session A imply, versus Session B? Both are projected '
      + 'through the same representative clubs - not rebuilt from each club\'s own rows.</p>'
      + strip(modelA, '#7fd0ff') + strip(modelB, '#3cff8d')
      + '<div class="gdSessionCompareLegend">'
      + '<span><i style="border-color:#7fd0ff"></i>Session A</span>'
      + '<span><i style="border-color:#3cff8d"></i>Session B</span>'
      + '<span>Exaggeration ' + state.exaggeration + '&times;</span>'
      + '</div>'
      + '<div class="gdPracticeViewSwitch" style="margin-top:10px">'
      + [1, 5, 10].map(function (value) {
        return '<button type="button" data-gd-session-exag="' + value + '"'
          + (state.exaggeration === value ? ' class="isOn"' : '') + '>' + value + '&times;</button>';
      }).join('')
      + '</div></div>'
      + '<div class="gdSessionCard"><h3>Region difference</h3>'
      + '<p class="gdProjectedNote">Session A &rarr; Session B, per region.</p>'
      + regionDelta(modelA.geometry, modelB.geometry) + '</div>';
  }

  function openComparison() {
    ensureStyle();
    if (!core() || !view()) {
      window.alert('The Bubble model is not loaded on this build, so sessions cannot be compared.');
      return false;
    }
    var existing = document.getElementById('gdPracticeSessionCompare');
    if (existing) existing.remove();

    var sessions = sessionOptions();
    var state = {
      sessions: sessions,
      a: sessions[0] ? sessions[0].id : '',
      b: sessions[1] ? sessions[1].id : '',
      exaggeration: 1
    };

    var host = document.createElement('div');
    host.id = 'gdPracticeSessionCompare';
    host.className = 'gdSessionCompare';
    document.body.appendChild(host);

    function draw() {
      host.innerHTML = '<div class="gdSessionCompareInner">'
        + '<div class="gdSessionCompareHead"><h2>Compare Practice Sessions</h2>'
        + '<button type="button" data-gd-session-close>Close</button></div>'
        + comparisonHtml(state) + '</div>';
      host.querySelector('[data-gd-session-close]').addEventListener('click', function () { host.remove(); });
      Array.prototype.forEach.call(host.querySelectorAll('[data-gd-session]'), function (select) {
        select.addEventListener('change', function () {
          state[select.getAttribute('data-gd-session')] = select.value;
          draw();
        });
      });
      Array.prototype.forEach.call(host.querySelectorAll('[data-gd-session-exag]'), function (button) {
        button.addEventListener('click', function () {
          state.exaggeration = Number(button.getAttribute('data-gd-session-exag')) || 1;
          draw();
        });
      });
    }

    draw();
    return false;
  }

  /* ------------------------------------------------------------------
     Exports. On window rather than a namespace object because the Practice
     screen's markup calls them from inline onclick, and because Studio calls
     gdOpenPracticeSessionComparison() by the same name.
     ------------------------------------------------------------------ */

  /* practiceVisualHtml is deliberately NOT aliased onto window under its own
     name: gd-route-audit.js reaches it through GDPracticeProjectedClubs behind
     a guard, so the primary Normalised view survives this module being absent.
     One name, one path in. */
  window.gdSetPracticeBubbleView = setView;
  window.gdPracticeBubbleView = currentView;
  window.gdOpenPracticeSessionComparison = openComparison;

  window.GDPracticeProjectedClubs = {
    currentView: currentView,
    setView: setView,
    projectedClubsHtml: projectedClubsHtml,
    practiceVisualHtml: practiceVisualHtml,
    openComparison: openComparison,
    sessionOptions: sessionOptions
  };
})();
