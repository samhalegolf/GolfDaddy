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

  /* WHAT "IN THE BUBBLE" MEANS HERE, IN NUMBERS.
   *
   * The practice bubble the chart draws is the PRESET iron shape and nothing
   * else (gd-route-audit.js gdGraphBubbleDimensions -> gdDeriveBasePatternSize,
   * iron ratios: width 0.148 and depth 0.195 OF THE CARRY). Both are ratios of
   * the carry, so the bubble's half-axes are the same wherever the player sets
   * their 7-iron: +-atan(0.074) = 4.23 degrees laterally, +-9.75% of carry in
   * distance. Building shots in units of THOSE radii is what lets this file
   * promise "most of these miss the bubble" and have the drawn picture agree,
   * rather than guessing at a spread in degrees and hoping.
   *
   * Laterally the bubble sits wherever the cluster hunter puts it, so a lateral
   * miss has to clear the radius PLUS however far that centre drifts off the
   * core - hence the 1.55-radius floor on the miss shapes below. In DEPTH the
   * bubble is pinned to the anchor distance (gdBubbleRelativeParts draws it at
   * depth 0), so a distance miss needs no such margin.
   */
  var IRON_WIDTH_RATIO = 0.148;
  var IRON_DEPTH_RATIO = 0.195;
  var BUBBLE_ANGLE_RADIUS_DEG = Math.atan(IRON_WIDTH_RATIO / 2) * 180 / Math.PI;
  var BUBBLE_DEPTH_RADIUS_PCT = IRON_DEPTH_RATIO / 2;

  /* Where the repeatable pattern sits, and how tight it is - not how wide the
     day was. The variety in a demo session comes from the MISSES around the
     pattern, which is what a range session actually looks like. */
  var PATTERN_PRESETS = [
    { id: 'modest-left', centerDeg: -3.1, coreSpreadRadii: 0.24 },
    { id: 'modest-right', centerDeg: 2.9, coreSpreadRadii: 0.24 },
    { id: 'tight-left', centerDeg: -2.0, coreSpreadRadii: 0.15 },
    { id: 'tight-right', centerDeg: 2.1, coreSpreadRadii: 0.15 },
    { id: 'near-centred', centerDeg: 0.6, coreSpreadRadii: 0.2 },
    { id: 'broader', centerDeg: -1.5, coreSpreadRadii: 0.3 },
    { id: 'strong-left', centerDeg: -4.4, coreSpreadRadii: 0.22 },
    { id: 'strong-right', centerDeg: 4.2, coreSpreadRadii: 0.22 },
    { id: 'square', centerDeg: -0.3, coreSpreadRadii: 0.26 }
  ];

  /* Miss archetypes, in bubble radii. Every one clears the unit ellipse on at
     least one axis, so a shot built from any of them is outside the drawn
     bubble by construction rather than by luck. */
  var MISS_SHAPES = [
    { id: 'block-right', side: 'right', depthBias: 'flat', angle: [1.55, 2.7], depth: [-0.55, 0.55] },
    { id: 'wipe-right', side: 'right', depthBias: 'short', angle: [2.3, 3.4], depth: [-1.15, -0.2] },
    { id: 'heel-push', side: 'right', depthBias: 'long', angle: [1.55, 2.4], depth: [0.85, 1.5] },
    { id: 'pull-left', side: 'left', depthBias: 'flat', angle: [-2.7, -1.55], depth: [-0.55, 0.55] },
    { id: 'snap-left', side: 'left', depthBias: 'flat', angle: [-3.3, -2.2], depth: [-0.6, 0.6] },
    { id: 'toe-pull', side: 'left', depthBias: 'short', angle: [-2.3, -1.55], depth: [-1.6, -0.9] },
    { id: 'fat', side: 'centre', depthBias: 'short', angle: [-0.9, 0.9], depth: [-1.95, -1.3] },
    { id: 'thin-flyer', side: 'centre', depthBias: 'long', angle: [-0.9, 0.9], depth: [1.25, 1.95] }
  ];

  /* Share of the session that is the repeatable pattern; the rest are misses, so
     around two in three shots land outside the bubble. It has to stay clear of
     the cluster hunter's own quorum - it needs ceil(shots * clusterHunterPct)
     neighbours, 28% by default (gd-launch-monitor-data.js) - or it finds no
     pattern, Adopt never enables and the demo dead-ends. */
  var CORE_SHARE = 0.36;

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

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

  function between(range) { return range[0] + Math.random() * (range[1] - range[0]); }

  function shuffled(list) {
    var out = list.slice();
    for (var i = out.length - 1; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1));
      var swap = out[i];
      out[i] = out[j];
      out[j] = swap;
    }
    return out;
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

  /* THE DECK IS WHY THE HUNTER STILL FINDS THE PATTERN.
   *
   * One session reads as a player who blocks it right, the next as one who
   * comes out of it - but the deck is fixed at four shapes, one per region:
   * a right miss, a left miss, and both centre misses (fat and thin). Two
   * constraints are doing real work there and neither is decoration.
   *
   * COUNT. Misses are dealt evenly across the deck, so each shape gets about
   * (1 - CORE_SHARE)/4 of the session - comfortably under the hunter's quorum,
   * and no pair of deck shapes sits close enough to make one between them. Let
   * two shapes share a region and they can out-quorum the core, and the demo
   * adopts a bubble centred on a miss.
   *
   * DEPTH. With no saved bag (which is every guest running this) the chart
   * anchors its distance axis on the MEDIAN carry of these shots. fat and thin
   * always come as a pair, and the two wings are never both short or both long,
   * so the misses cannot drag that anchor off the pattern.
   */
  function missDeck() {
    var rights = MISS_SHAPES.filter(function (shape) { return shape.side === 'right'; });
    var lefts = MISS_SHAPES.filter(function (shape) { return shape.side === 'left'; });
    var centres = MISS_SHAPES.filter(function (shape) { return shape.side === 'centre'; });
    var right = pick(rights);
    var balanced = lefts.filter(function (shape) { return shape.depthBias === 'flat' || shape.depthBias !== right.depthBias; });
    var left = pick(balanced.length ? balanced : lefts);
    return shuffled([right, left].concat(centres));
  }

  function buildSyntheticGroups(sevenIronCarryM, preset) {
    var total = 24 + Math.floor(Math.random() * 13);
    var coreCount = Math.max(6, Math.ceil(total * CORE_SHARE));
    var deck = missDeck();
    var placed = [];
    var i;
    for (i = 0; i < total; i += 1) {
      if (i < coreCount) {
        /* Tight laterally, so the hunter's centre lands on the pattern instead
           of being dragged around by the pattern's own spread; looser in depth,
           because the depth axis has no such feedback and a core that is tight
           in both reads as a printed dot rather than a golfer. */
        placed.push({
          angleRadii: clamp(jitter(preset.coreSpreadRadii), -0.55, 0.55),
          depthRadii: clamp(jitter(preset.coreSpreadRadii * 1.5), -0.8, 0.8)
        });
      } else {
        /* Cyclic, not random, so the deck's balance survives into the actual
           shot list rather than only holding on average. */
        var shape = deck[(i - coreCount) % deck.length];
        placed.push({ angleRadii: between(shape.angle), depthRadii: between(shape.depth) });
      }
    }
    /* The chart plots rows in order and the evidence list reads the same order,
       so an unshuffled list would show every good shot first and every miss
       last - a session no range has ever produced. */
    return shuffled(placed).map(function (spot) {
      var sideAngle = clamp(preset.centerDeg + spot.angleRadii * BUBBLE_ANGLE_RADIUS_DEG, -18, 18);
      var carry = sevenIronCarryM * (1 + spot.depthRadii * BUBBLE_DEPTH_RADIUS_PCT);
      return {
        candidateClub: '7i',
        source: 'manual',
        /* Stated separately from the carry, so a shot that came up short reads as
           short. Without it normalizeShot takes expected FROM carry, every shot's
           depth is exactly 0, and the chart's distance axis carries nothing. */
        expectedDistanceM: Math.round(sevenIronCarryM * 10) / 10,
        metrics: [
          { candidateMetric: 'carryDistance', rawLabel: 'Carry', value: Math.max(20.5, Math.round(carry * 10) / 10), confidence: 0.88 + Math.random() * 0.08 },
          { candidateMetric: 'sideAngle', rawLabel: 'Side Angle', value: Math.round(sideAngle * 100) / 100, confidence: 0.86 + Math.random() * 0.08 }
        ]
      };
    });
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
    state.patternSpreadDeg = preset.coreSpreadRadii * BUBBLE_ANGLE_RADIUS_DEG;
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
    /* Set for exactly as long as the clone is in place, and read by the three
       entitlement checks in gd-route-audit.js (adopt, save, bubble-centre save).
       Those checks exist to stop a non-member writing a bubble they have not
       paid for; here there is no write to stop, because ensureProfile is the
       clone above and savePlayerProfiles is a no-op. Without the flag the demo
       dead-ends at the paywall for every non-member, which is everyone the demo
       is for. It is scoped to this call rather than to "a demo is running", so a
       demo session cannot be used to get a free real save through the My Bubble
       hub while it happens to be active. */
    window.__gdDemoAdoptInFlight = true;
    try {
      window.gdPracticeAdoptBubbleFromAction();
      window.gdPracticeSaveBubbleFromAction();
    } finally {
      window.__gdDemoAdoptInFlight = false;
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

  // === "Import shots" entry form (index.html #gdDemoEntryForm) =============

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
