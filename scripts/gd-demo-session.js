/* Demo Mode session owner (practice-side).
 *
 * Fake evidence, real processors. This file generates synthetic practice
 * shots and runs them through the real cluster/pattern engine
 * (GolfDaddyLaunchMonitorData.analyze({store})) instead of the real shot
 * library, and stages/commits the resulting bubble through the real
 * Adopt -> Save click handlers instead of duplicating that math. Nothing
 * here is ever written to gd_launch_monitor_data_v1, gd_player_profiles_v27,
 * or Supabase - see dev/demo-session-*.test.js for the isolation proof.
 *
 * State survives the Play -> Course Picker -> GPS Play navigation (a real
 * document reload, see gd-course-picker-search-v2.js:navigateToAppPlay) via
 * sessionStorage only - tab-scoped, cleared on tab close, never durable.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'gd_demo_session_v1';

  var PATTERN_PRESETS = [
    { id: 'modest-left', centerDeg: -3.1, spreadDeg: 2.4 },
    { id: 'modest-right', centerDeg: 2.9, spreadDeg: 2.4 },
    { id: 'tight-left', centerDeg: -2.0, spreadDeg: 1.3 },
    { id: 'tight-right', centerDeg: 2.1, spreadDeg: 1.3 },
    { id: 'near-centred', centerDeg: 0.6, spreadDeg: 1.7 },
    { id: 'broader', centerDeg: -1.5, spreadDeg: 3.3 }
  ];

  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  function nowIso() { return new Date().toISOString(); }

  function randId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  // Cheap approximate-normal jitter (Box-Muller), not a real evidence source -
  // just enough variance that repeated demo runs don't look identical.
  function jitter(spread) {
    var u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return spread * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function defaultState() {
    return {
      active: false,
      sevenIronCarryM: null,
      patternCenterDeg: null,
      patternSpreadDeg: null,
      practiceAnalysis: null,
      demoBag: [],
      adopted: false,
      adoptedBubble: null,
      courseDataActive: false,
      gpsEnteredAt: null
    };
  }

  var state = defaultState();

  function persist() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    refreshUI();
  }

  function load() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) state = Object.assign(defaultState(), JSON.parse(raw));
    } catch (e) {}
  }

  load();

  function pickPreset() {
    return PATTERN_PRESETS[Math.floor(Math.random() * PATTERN_PRESETS.length)];
  }

  function buildSyntheticGroups(sevenIronCarryM, preset) {
    var count = 16 + Math.floor(Math.random() * 8);
    var groups = [];
    for (var i = 0; i < count; i += 1) {
      var carry = sevenIronCarryM + jitter(sevenIronCarryM * 0.03);
      var sideAngle = preset.centerDeg + jitter(preset.spreadDeg);
      groups.push({
        candidateClub: '7i',
        source: 'manual',
        metrics: [
          { candidateMetric: 'carryDistance', rawLabel: 'Carry', value: Math.max(1, Math.round(carry * 10) / 10), confidence: 0.92 },
          { candidateMetric: 'sideAngle', rawLabel: 'Side Angle', value: Math.round(sideAngle * 100) / 100, confidence: 0.9 }
        ]
      });
    }
    return groups;
  }

  function buildDemoAnalysis(sevenIronCarryM, preset) {
    var api = window.GolfDaddyLaunchMonitorData;
    if (!api || typeof api.analyze !== 'function' || typeof api.normalizeShot !== 'function') return null;
    var sessionRow = { sessionId: randId('demo-session'), startedAt: nowIso(), sourceIdentity: { providerGuess: 'manual' } };
    var captureRow = { captureId: randId('demo-capture'), timestamp: nowIso() };
    var groups = buildSyntheticGroups(sevenIronCarryM, preset);
    var shots = groups.map(function (group) {
      return safe(function () { return api.normalizeShot(group, sessionRow, captureRow); }, null);
    }).filter(Boolean);
    var store = { shots: shots, sessions: [sessionRow], captures: [captureRow], rejects: [] };
    return safe(function () { return api.analyze({ store: store }); }, null);
  }

  function computeDemoBag(sevenIronCarryM) {
    var defaults = safe(function () {
      return window.GDBubbleEngine && typeof window.GDBubbleEngine.defaultBagRows === 'function'
        ? window.GDBubbleEngine.defaultBagRows() : [];
    }, []) || [];
    var ref = defaults.filter(function (r) { return r.club === '7i'; })[0];
    if (!(Number(sevenIronCarryM) > 0) || !defaults.length || !ref || !(ref.baseCarry > 0)) return [];
    var scale = Number(sevenIronCarryM) / ref.baseCarry;
    return defaults.map(function (row) { return { club: row.club, baseCarry: Math.round(row.baseCarry * scale) }; });
  }

  function start(sevenIronCarryM) {
    var carry = Number(sevenIronCarryM);
    if (!(carry > 0)) return false;
    var preset = pickPreset();
    state = defaultState();
    state.active = true;
    state.sevenIronCarryM = carry;
    state.patternCenterDeg = preset.centerDeg;
    state.patternSpreadDeg = preset.spreadDeg;
    state.practiceAnalysis = buildDemoAnalysis(carry, preset);
    state.demoBag = computeDemoBag(carry);
    persist();
    return !!state.practiceAnalysis;
  }

  // === Adopt: run the REAL Adopt -> Save click handlers against a throwaway
  // profile clone, so every bit of the real bubble-shape math (offset, club
  // selection, distance-learning summary, width/depth) is reused verbatim and
  // the real profile is never fetched during the flow. See
  // dev/demo-session-adopt-isolation.test.js. ==================================

  function buildStagingProfileClone() {
    var real = safe(function () { return typeof window.ensureProfile === 'function' ? window.ensureProfile() : null; }, null);
    return real ? JSON.parse(JSON.stringify(real)) : { bag: [], bubbleProfiles: {} };
  }

  function extractAdoptedBubble(demoProfile) {
    var source = demoProfile && demoProfile.practiceBubbleSource;
    if (!source || !source.active || !Number.isFinite(Number(source.offsetDeg))) return null;
    return {
      offsetDeg: Number(source.offsetDeg),
      handedness: demoProfile.handedness === 'left' ? 'left' : 'right',
      club: source.club || '7i',
      shapeSource: 'demo-adopted'
    };
  }

  function adopt() {
    if (!state.active || !state.practiceAnalysis) return false;
    if (typeof window.gdPracticeAdoptBubbleFromAction !== 'function' || typeof window.gdPracticeSaveBubbleFromAction !== 'function') return false;
    var demoProfile = buildStagingProfileClone();
    var realEnsureProfile = window.ensureProfile;
    var realSave = window.savePlayerProfiles;
    var realSync = window.syncCoreProfileFromActive;
    window.ensureProfile = function () { return demoProfile; };
    window.savePlayerProfiles = function () {};
    window.syncCoreProfileFromActive = function () {};
    try {
      window.gdPracticeAdoptBubbleFromAction();
      window.gdPracticeSaveBubbleFromAction();
    } finally {
      window.ensureProfile = realEnsureProfile;
      window.savePlayerProfiles = realSave;
      window.syncCoreProfileFromActive = realSync;
    }
    var adoptedBubble = extractAdoptedBubble(demoProfile);
    if (!adoptedBubble) return false;
    state.adoptedBubble = adoptedBubble;
    state.adopted = true;
    persist();
    safe(function () { typeof window.renderPracticeData === 'function' && window.renderPracticeData(true); }, null);
    return true;
  }

  function setCourseDataActive(active) { state.courseDataActive = !!active; persist(); }
  function markGpsEntered() { state.gpsEnteredAt = nowIso(); persist(); }

  function destroy() {
    state = defaultState();
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
    refreshUI();
    safe(function () { typeof window.renderPracticeData === 'function' && window.renderPracticeData(true); }, null);
  }

  // === Try Demo entry form (index.html #gdDemoEntryForm) ====================

  function openEntry(event) {
    if (event) event.preventDefault();
    var form = document.getElementById('gdDemoEntryForm');
    if (form) form.hidden = false;
    return false;
  }

  function cancelEntry(event) {
    if (event) event.preventDefault();
    var form = document.getElementById('gdDemoEntryForm');
    if (form) form.hidden = true;
    return false;
  }

  function startFromEntry(event) {
    if (event) event.preventDefault();
    var input = document.getElementById('gdDemoCarryInput');
    var carry = Number(input && input.value);
    if (!(carry > 0)) {
      safe(function () { typeof window.gdLmToast === 'function' && window.gdLmToast('Enter a 7-iron carry'); }, null);
      return false;
    }
    var started = start(carry);
    if (started) {
      cancelEntry();
      safe(function () { typeof window.renderPracticeData === 'function' && window.renderPracticeData(true); }, null);
    } else {
      safe(function () { typeof window.gdLmToast === 'function' && window.gdLmToast('Demo could not start - try again'); }, null);
    }
    return false;
  }

  function exit(event) {
    if (event) event.preventDefault();
    destroy();
    return false;
  }

  // === UI wiring (badges + pulse/callout on the two permanent buttons) ======
  // Kept self-contained here (direct DOM lookups by id/class) rather than
  // spread across gd-route-audit.js's render functions, other than the one
  // Adopt-dock template branch that has to live where that markup is built.

  function refreshUI() {
    safe(function () {
      var playBtn = document.getElementById('gdPracticePlayBtn');
      if (playBtn) {
        playBtn.classList.toggle('gdDemoPulse', !!(state.active && state.adopted));
        var callout = document.getElementById('gdPracticePlayCallout');
        if (callout) callout.hidden = !(state.active && state.adopted);
      }
      var badge = document.getElementById('gdPracticeDemoBadge');
      if (badge) badge.hidden = !state.active;
      var tryBtn = document.getElementById('gdPracticeTryDemoBtn');
      if (tryBtn) tryBtn.hidden = !!state.active;
      var exitBtn = document.getElementById('gdPracticeExitDemoBtn');
      if (exitBtn) exitBtn.hidden = !state.active;
    }, null);
  }

  var api = {
    get active() { return !!state.active; },
    get adopted() { return !!state.adopted; },
    get sevenIronCarryM() { return state.sevenIronCarryM; },
    get patternCenterDeg() { return state.patternCenterDeg; },
    get patternSpreadDeg() { return state.patternSpreadDeg; },
    get practiceAnalysis() { return state.practiceAnalysis; },
    get demoBag() { return state.demoBag; },
    get adoptedBubble() { return state.adoptedBubble; },
    get courseDataActive() { return state.courseDataActive; },
    get gpsEnteredAt() { return state.gpsEnteredAt; },
    start: start,
    adopt: adopt,
    setCourseDataActive: setCourseDataActive,
    markGpsEntered: markGpsEntered,
    destroy: destroy,
    exit: exit,
    openEntry: openEntry,
    cancelEntry: cancelEntry,
    startFromEntry: startFromEntry,
    refreshUI: refreshUI,
    // exposed for dev/*.test.js only
    _presetIds: function () { return PATTERN_PRESETS.map(function (p) { return p.id; }); },
    _buildDemoAnalysis: buildDemoAnalysis,
    _computeDemoBag: computeDemoBag
  };

  window.GDDemoSession = api;
  document.addEventListener('DOMContentLoaded', refreshUI);
})();
