/* Manual Bubble Set: the player-facing lane.
 *
 * Opens from My Bubble, asks two questions - which club, and where does that
 * shot finish - and hands the answer to the canonical My Bubble save. That is
 * the whole feature.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT MANUAL PRACTICE
 *
 * Manual Practice (gd-manual-practice-data.js) is a coach/admin tool that plots
 * many observations, classifies each as representative or disrupted, and files
 * the session into the Practice Library as evidence. Its admin gate stays
 * exactly as it is: nothing here relaxes isAdminUser(), nothing here opens its
 * UI, and no player reaches its plotting surface, its review list, its history
 * or its trusted-override controls through this file.
 *
 * What the two lanes share is the one small idea the coach override already
 * proved: a stated offset can anchor the Bubble without fabricating a single
 * shot. That idea lives in gd-manual-practice-core.js's buildOffsetAnchor, and
 * both lanes call it. Nothing else is shared.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT WRITTEN
 *
 * Writes: a staged pending source on the active profile, then
 * gdBubbleOffsetSave() - the same commit Practice adoption and the distance
 * lane use, including its access check and its cloud-synced profile write.
 *
 * Does NOT write: any practice shot, any Shot Library row, any launch-monitor
 * capture, any second bubble store. The reference club's bubble is the one the
 * generator already draws for that club at its bag distance; every other club
 * is sized by the existing Bag/Bubble scaling from the saved offset, which is
 * why only one Bubble is ever placed.
 */
(function () {
  'use strict';

  var OVERLAY_ID = 'gdManualBubbleSetOverlay';
  var LANE_WIDTH = 480;
  var LANE_HEIGHT = 200;
  /* startPct/basePct/yPct are the frame the shared gdShotBubbleFrame builds.
     yPct is 0.55 rather than a natural-looking 0.5 on purpose: the shared
     endpoint clamps the drawn y into [0.30H, 0.80H], so centring at 0.55H is
     what makes the left and right halves of the drag the same size. At 0.5H a
     player could express 50% more right miss than left. */
  var LANE_START_PCT = 30 / LANE_WIDTH;
  var LANE_BASE_PCT = 0.72;
  var LANE_Y_PCT = 0.55;

  var state = null;

  function safe(fn, fallback) {
    try { return fn(); } catch (error) { return fallback; }
  }

  function core() {
    return window.GolfDaddyManualBubbleSetCore || null;
  }

  function practiceCore() {
    return window.GolfDaddyManualPracticeCore || window.ClarityCaddieManualPracticeCore || null;
  }

  /* The three app functions this lane is allowed to read, handed to the core
     rather than reached for inside it. */
  function deps() {
    return {
      clubBaselineM: function (club) {
        return typeof window.gdClarityClubBaselineM === 'function' ? window.gdClarityClubBaselineM(club) : NaN;
      },
      generatedBubbleForClub: function (club, carryM, offsetDeg) {
        return typeof window.gdGeneratedShotBubbleForClub === 'function'
          ? window.gdGeneratedShotBubbleForClub(club, carryM, offsetDeg)
          : null;
      },
      buildOffsetAnchor: function (input) {
        var api = practiceCore();
        return api && typeof api.buildOffsetAnchor === 'function' ? api.buildOffsetAnchor(input) : null;
      }
    };
  }

  function profile() {
    return safe(function () {
      return typeof window.ensureProfile === 'function' ? window.ensureProfile() : null;
    }, null);
  }

  function toast(message) {
    safe(function () {
      if (typeof window.gdLmToast === 'function') window.gdLmToast(message);
      else if (typeof window.toast === 'function') window.toast(message);
    });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function clubKey(club) {
    return safe(function () {
      return typeof window.gdCompareClubKey === 'function' ? window.gdCompareClubKey(club) : String(club || '').trim();
    }, String(club || '').trim());
  }

  // === The player's bag ====================================================

  /* Their actual clubs, in bag order, straight from the Bag. No hard-coded
     reference club: a player whose smoothest swing is a hybrid should be able
     to say so, and a bag without a 7i should not be asked about one.

     The profile's own bag is read FIRST, and it is the same array
     gdClarityClubBaselineM looks a distance up in. Offering a club the
     baseline lookup cannot then answer for would silently drop that club onto
     the fallback carry - the list and the distances have to be the same bag.
     gdBagSourceRows() is the fallback for shells where the profile bag has not
     been filled in yet. */
  function bagClubs() {
    var clubs = [];
    function add(value) {
      var club = clubKey(value);
      if (club && clubs.indexOf(club) === -1) clubs.push(club);
    }
    var bag = safe(function () { return (profile() || {}).bag; }, null);
    if (Array.isArray(bag)) bag.forEach(function (row) { add(row && (row.club || row.name)); });
    if (!clubs.length) {
      var rows = safe(function () {
        return typeof window.gdBagSourceRows === 'function' ? window.gdBagSourceRows() : [];
      }, []) || [];
      rows.forEach(function (row) { add(row && (row.club || row.name)); });
    }
    return clubs;
  }

  function defaultClub(clubs, restored) {
    if (restored && restored.referenceClub) {
      var match = clubs.filter(function (club) {
        return club.toLowerCase() === String(restored.referenceClub).toLowerCase();
      })[0];
      if (match) return match;
    }
    var seven = clubs.filter(function (club) { return club.toLowerCase() === '7i'; })[0];
    return seven || clubs[0] || '';
  }

  // === Placement geometry ==================================================
  //
  // Every number here comes from the shared frame. The lane does not know how
  // an offset becomes a y position - it asks gdShotBubbleModelEndpoint, the
  // same function the hub preview and the GPS-ready preview ask - and the core
  // owns the one direction that did not already exist, y back to degrees.

  function frame() {
    if (typeof window.gdShotBubbleFrame !== 'function') return null;
    return safe(function () {
      return window.gdShotBubbleFrame(LANE_WIDTH, LANE_HEIGHT, laneOpts());
    }, null);
  }

  function laneOpts(extra) {
    return Object.assign({
      modelWidth: LANE_WIDTH,
      modelHeight: LANE_HEIGHT,
      startXPct: LANE_START_PCT,
      basePct: LANE_BASE_PCT,
      yPct: LANE_Y_PCT
    }, extra || {});
  }

  function endpointFor(offsetDeg, laneFrame) {
    if (typeof window.gdShotBubbleModelEndpoint !== 'function' || !laneFrame) return null;
    return safe(function () { return window.gdShotBubbleModelEndpoint(offsetDeg, laneFrame); }, null);
  }

  /* The band the shared endpoint clamps into, expressed for the core so the
     drag, the readout and the saved value are all held to the same limit. */
  function placementRange(laneFrame) {
    var api = core();
    if (!api || !laneFrame) return { leftDeg: -12, rightDeg: 12 };
    var centre = laneFrame.yModel;
    return api.placementRangeDeg({
      dxModel: Math.max(1, laneFrame.zeroXModel - laneFrame.startXModel),
      maxUpModel: centre - laneFrame.modelH * 0.30,
      maxDownModel: laneFrame.modelH * 0.80 - centre
    });
  }

  function offsetForPointer(svg, event, laneFrame) {
    var api = core();
    if (!api || !svg || !event || !laneFrame) return NaN;
    var rect = svg.getBoundingClientRect();
    if (!rect || !rect.height || !rect.width) return NaN;
    /* preserveAspectRatio="xMidYMid meet": work in the same letterboxed space
       the frame does rather than assuming the SVG fills its box. */
    var scale = Math.min(rect.width / LANE_WIDTH, rect.height / LANE_HEIGHT);
    var offsetY = (rect.height - LANE_HEIGHT * scale) / 2;
    var yModel = (Number(event.clientY) - rect.top - offsetY) / Math.max(0.0001, scale);
    var dy = yModel - laneFrame.yModel;
    var dx = Math.max(1, laneFrame.zeroXModel - laneFrame.startXModel);
    return api.clampOffsetDeg(api.offsetDegForPlacement(dy, dx), placementRange(laneFrame));
  }

  // === Rendering ===========================================================

  function offsetLabel(offsetDeg) {
    var n = Number(offsetDeg);
    if (!Number.isFinite(n)) return '-';
    if (Math.abs(n) < 0.05) return 'Straight at the target';
    return (n > 0 ? 'Right ' : 'Left ') + Math.abs(n).toFixed(1) + '°';
  }

  /* The generated Bubble for the club and placement showing right now. Resolved
     once per render and passed around, rather than recomputed as a side effect
     of drawing - the readout underneath the lane has to be able to name the
     same distance the lane just drew. */
  function currentReference() {
    var api = core();
    if (!api || !state || !state.club) return null;
    return api.referenceBubbleFor(state.club, state.offsetDeg, deps());
  }

  function laneSvg(reference) {
    var laneFrame = frame();
    if (!laneFrame) return '<div class="gdManualBubbleSetUnavailable">The Bubble preview is not ready on this screen.</div>';
    if (!reference) return '<div class="gdManualBubbleSetUnavailable">No Bubble can be generated for ' + escapeHtml((state && state.club) || 'this club') + ' yet.</div>';

    var aim = endpointFor(state.offsetDeg, laneFrame);
    if (!aim) return '<div class="gdManualBubbleSetUnavailable">The Bubble preview is not ready on this screen.</div>';

    var originX = laneFrame.x(laneFrame.startXModel);
    var originY = laneFrame.y(laneFrame.yModel);
    var targetX = laneFrame.x(laneFrame.zeroXModel);
    var bubbleX = laneFrame.x(aim.x);
    var bubbleY = laneFrame.y(aim.y);

    /* The Bubble itself is the generated one for this club at this distance -
       the same call the hub preview makes. Manual Set moves it; it never
       invents a shape for it. */
    var bubbleMarkup = safe(function () {
      return window.gdShotBubbleAimSvg(LANE_WIDTH, LANE_HEIGHT, laneOpts({
        club: reference.club,
        offsetDeg: state.offsetDeg,
        baseDistanceM: reference.baseDistanceM,
        bubbleWidthM: reference.widthM,
        bubbleDepthM: reference.depthM,
        handedness: (profile() || {}).handedness || 'right',
        lineMode: 'straight',
        showAimLine: false,
        stroke: 'rgba(215,176,107,.72)',
        fill: 'rgba(255,241,190,.16)',
        opacity: 0.96,
        className: 'gdManualBubbleSetShape'
      }));
    }, '') || '';

    return '<svg class="gdManualBubbleSetLane" id="gdManualBubbleSetLane" viewBox="0 0 ' + LANE_WIDTH + ' ' + LANE_HEIGHT + '"'
      + ' preserveAspectRatio="xMidYMid meet" role="img"'
      + ' aria-label="Bubble placed ' + escapeHtml(offsetLabel(state.offsetDeg)) + '">'
      + '<rect x="0" y="0" width="' + LANE_WIDTH + '" height="' + LANE_HEIGHT + '" rx="18" fill="rgba(3,12,11,.42)"/>'
      /* Top is left, bottom is right - the app's one landscape law. Saying so
         on the surface is the whole reason the player can trust the drag. */
      + '<text class="gdManualBubbleSetSide" x="' + LANE_WIDTH / 2 + '" y="20" text-anchor="middle">LEFT</text>'
      + '<text class="gdManualBubbleSetSide" x="' + LANE_WIDTH / 2 + '" y="' + (LANE_HEIGHT - 10) + '" text-anchor="middle">RIGHT</text>'
      + '<line x1="' + originX.toFixed(1) + '" y1="' + originY.toFixed(1) + '" x2="' + (LANE_WIDTH - 16) + '" y2="' + originY.toFixed(1) + '"'
      + ' stroke="rgba(238,245,242,.42)" stroke-width="1.4" stroke-dasharray="7 7" stroke-linecap="round"/>'
      + '<g class="gdManualBubbleSetTarget">'
      + '<line x1="' + (targetX - 11).toFixed(1) + '" y1="' + originY.toFixed(1) + '" x2="' + (targetX + 11).toFixed(1) + '" y2="' + originY.toFixed(1) + '" stroke="rgba(255,255,255,.78)" stroke-width="1.6" stroke-linecap="round"/>'
      + '<line x1="' + targetX.toFixed(1) + '" y1="' + (originY - 11).toFixed(1) + '" x2="' + targetX.toFixed(1) + '" y2="' + (originY + 11).toFixed(1) + '" stroke="rgba(255,255,255,.78)" stroke-width="1.6" stroke-linecap="round"/>'
      + '</g>'
      + bubbleMarkup
      + '<circle cx="' + originX.toFixed(1) + '" cy="' + originY.toFixed(1) + '" r="6" fill="rgba(255,255,255,.92)"/>'
      + '<g class="gdManualBubbleSetHandle" data-gd-manual-bubble-handle="1" pointer-events="all">'
      + '<circle cx="' + bubbleX.toFixed(1) + '" cy="' + bubbleY.toFixed(1) + '" r="30" fill="transparent"/>'
      + '<circle cx="' + bubbleX.toFixed(1) + '" cy="' + bubbleY.toFixed(1) + '" r="6.5" fill="rgba(255,235,170,.95)" stroke="rgba(8,12,8,.6)" stroke-width="1.2"/>'
      + '</g>'
      + '</svg>';
  }

  function overlayHtml() {
    var reference = currentReference();
    var clubs = state.clubs;
    var chips = clubs.length
      ? clubs.map(function (club) {
        var active = club.toLowerCase() === String(state.club).toLowerCase();
        return '<button type="button" class="gdManualBubbleSetChip' + (active ? ' active' : '') + '"'
          + ' aria-pressed="' + (active ? 'true' : 'false') + '"'
          + ' data-gd-manual-bubble-action="club" data-value="' + escapeHtml(club) + '">' + escapeHtml(club) + '</button>';
      }).join('')
      : '<span class="gdManualBubbleSetEmpty">Build your Bag first - Manual Set places the Bubble for a club you carry.</span>';

    var distance = Number(reference && reference.baseDistanceM);
    var distanceNote = Number.isFinite(distance) && distance > 0
      ? escapeHtml(state.club) + ' · ' + Math.round(distance) + 'm from your Bag'
      : '';

    return '<div class="gdManualBubbleSetSheet" role="dialog" aria-modal="true" aria-labelledby="gdManualBubbleSetTitle">'
      + '<div class="gdManualBubbleSetHead">'
      + '<button type="button" class="gdManualBubbleSetBack" data-gd-manual-bubble-action="close" aria-label="Close Manual Set">‹</button>'
      + '<div><strong id="gdManualBubbleSetTitle">Manual Set</strong><span>' + (state.hasManualSet ? 'Edit your Bubble' : 'Set your Bubble without practice data') + '</span></div>'
      + '</div>'
      + '<p class="gdManualBubbleSetLead">Choose the club that best represents your smoothest swing.</p>'
      + '<div class="gdManualBubbleSetClubs">' + chips + '</div>'
      + '<p class="gdManualBubbleSetLead">Set the Bubble where that shot naturally finishes.</p>'
      + '<div class="gdManualBubbleSetStage">' + laneSvg(reference) + '</div>'
      + '<div class="gdManualBubbleSetReadout"><strong id="gdManualBubbleSetReadout">' + escapeHtml(offsetLabel(state.offsetDeg)) + '</strong>'
      + (distanceNote ? '<span>' + distanceNote + '</span>' : '') + '</div>'
      + '<p class="gdManualBubbleSetLead gdManualBubbleSetScale">We’ll scale it across the rest of your bag.</p>'
      + '<div class="gdManualBubbleSetActions">'
      + '<button type="button" class="gdManualBubbleSetPrimary" data-gd-manual-bubble-action="save"' + (state.club ? '' : ' disabled') + '>Use This Bubble</button>'
      + '<button type="button" data-gd-manual-bubble-action="close">Cancel</button>'
      + '</div>'
      + '</div>';
  }

  function overlay() {
    return document.getElementById(OVERLAY_ID);
  }

  function render() {
    var node = overlay();
    if (!node || !state) return;
    node.innerHTML = overlayHtml();
  }

  /* Redraw only the lane and the readout. The drag rewrites the SVG on every
     move; rewriting the club chips with it would tear focus off the surface
     mid-gesture. */
  function renderPlacement() {
    var node = overlay();
    if (!node || !state) return;
    var stage = node.querySelector('.gdManualBubbleSetStage');
    if (stage) stage.innerHTML = laneSvg(currentReference());
    var readout = node.querySelector('#gdManualBubbleSetReadout');
    if (readout) readout.textContent = offsetLabel(state.offsetDeg);
  }

  // === Open / close ========================================================

  function open() {
    var api = core();
    if (!api) { toast('Manual Set is not available on this screen'); return false; }
    var p = profile();
    if (!p) { toast('Sign in to set your Bubble'); return false; }

    var restored = api.restoreState(p, deps());
    var clubs = bagClubs();
    var club = defaultClub(clubs, restored);
    state = {
      clubs: clubs,
      club: club,
      /* Centred on the target line unless they already have a manual Bubble.
         0.0 is a completely valid answer and nothing here nudges them off it. */
      offsetDeg: restored.hasManualSet ? restored.offsetDeg : 0,
      hasManualSet: restored.hasManualSet
    };

    var node = overlay();
    if (!node) {
      node = document.createElement('div');
      node.id = OVERLAY_ID;
      node.className = 'gdManualBubbleSetOverlay';
      document.body.appendChild(node);
    }
    node.classList.add('open');
    document.body.classList.add('gdManualBubbleSetOpen');
    render();
    return false;
  }

  function close() {
    var node = overlay();
    if (node) { node.classList.remove('open'); node.innerHTML = ''; }
    document.body.classList.remove('gdManualBubbleSetOpen');
    state = null;
    return false;
  }

  // === Save ================================================================

  /* The canonical path, start to finish: stage the pending source the same way
     Practice adoption and the distance lane stage theirs, then call
     gdBubbleOffsetSave() - which owns the access check, the profile write, the
     bubbleProfiles/previewBubbleSet update, the cloud-synced save and every
     re-render. Nothing about My Bubble is decided in this file. */
  function save() {
    var api = core();
    var p = profile();
    if (!api || !p || !state) return false;
    if (!state.club) { toast('Choose a club first'); return false; }
    if (typeof window.gdBubbleOffsetSave !== 'function') { toast('My Bubble is not ready'); return false; }

    var reference = api.referenceBubbleFor(state.club, state.offsetDeg, deps());
    if (!reference) { toast('No Bubble can be generated for that club yet'); return false; }

    var storageClub = safe(function () {
      return typeof window.gdMyBubbleStorageClub === 'function' ? window.gdMyBubbleStorageClub(reference.club) : reference.club;
    }, reference.club);

    var now = new Date().toISOString();
    var pending = api.pendingSourceFor({
      club: storageClub,
      offsetDeg: state.offsetDeg,
      baseDistanceM: reference.baseDistanceM,
      createdAt: safe(function () { return (p.manualBubbleSet || {}).createdAt; }, '') || now,
      updatedAt: now,
      createdBy: safe(function () {
        return window.ClaritySession && typeof window.ClaritySession.get === 'function'
          ? String(window.ClaritySession.get().profileId || '')
          : '';
      }, ''),
      deps: deps(),
      /* The generated bubble for this club, carried through unchanged so the
         saved shape is the one the player was looking at. Every OTHER club is
         regenerated from its own bag distance by the existing scaling - the
         reference club's dimensions are never copied across the bag. */
      bubble: Object.assign({}, reference.generated, {
        baseCarry: reference.baseDistanceM,
        baseDistanceM: reference.baseDistanceM,
        expectedDistanceM: reference.baseDistanceM,
        handedness: p.handedness || 'right'
      })
    });
    if (!pending) { toast('That placement could not be read'); return false; }

    p.practiceBubblePendingSource = pending;
    p.practiceBubblePendingAt = now;
    safe(function () { window.savePlayerProfiles(); });

    var before = Number(p.faceOffsetDeg);
    /* Wrapped, not called bare. gdBubbleOffsetSave() can refuse (no membership)
       and can throw on the way out through the paywall; either way the stage
       below must be cleaned up, or a refused Manual Set leaves My Bubble
       showing an unsaved "Save" state the player never asked for. */
    safe(function () { window.gdBubbleOffsetSave(); });

    /* gdBubbleOffsetSave returns nothing and may refuse on access. Read the
       profile back rather than claiming a save that did not happen. */
    var after = profile() || {};
    /* A committed save consumes the pending stage. Checking only the offset
       would report success when access was refused and an identical Bubble
       happened to be saved already. */
    var saved = !after.practiceBubblePendingSource
      && after.practiceBubbleSource && after.practiceBubbleSource.active === true
      && Math.abs(Number(after.faceOffsetDeg) - pending.offsetDeg) < 0.02;
    if (!saved) {
      if (after.practiceBubblePendingSource === pending) {
        delete after.practiceBubblePendingSource;
        delete after.practiceBubblePendingAt;
        if (Number.isFinite(before)) after.faceOffsetDeg = before;
        safe(function () { window.savePlayerProfiles(); });
      }
      return false;
    }
    close();
    toast('My Bubble set - ' + offsetLabel(pending.offsetDeg));
    return false;
  }

  // === Wiring ==============================================================

  function beginDrag(event) {
    var laneFrame = frame();
    if (!laneFrame || !state) return;

    /* Re-queried every move on purpose: renderPlacement() replaces the SVG node, so
       a reference captured at pointerdown is detached by the second move and
       measures 0x0 - the drag would die after one step. */
    function move(moveEvent) {
      var node = overlay();
      var svg = node && node.querySelector('#gdManualBubbleSetLane');
      if (!svg) return;
      var next = offsetForPointer(svg, moveEvent, laneFrame);
      if (!Number.isFinite(next)) return;
      moveEvent.preventDefault();
      if (next === state.offsetDeg) return;
      state.offsetDeg = next;
      renderPlacement();
    }
    function finish() {
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', finish, true);
      document.removeEventListener('pointercancel', finish, true);
    }
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', finish, true);
    document.addEventListener('pointercancel', finish, true);
    /* A tap anywhere in the lane places the Bubble there; a drag then refines
       it. Both are the same gesture as far as this lane is concerned. */
    move(event);
  }

  function bind() {
    if (window.__gdManualBubbleSetBound) return;
    window.__gdManualBubbleSetBound = true;

    document.addEventListener('click', function (event) {
      var target = event.target && event.target.closest
        ? event.target.closest('[data-gd-manual-bubble-action]')
        : null;
      if (!target) return;
      var action = String(target.getAttribute('data-gd-manual-bubble-action') || '');
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === 'open') open();
      else if (action === 'close') close();
      else if (action === 'save') save();
      else if (action === 'club' && state) {
        var club = clubKey(target.getAttribute('data-value'));
        if (club && club !== state.club) { state.club = club; render(); }
      }
    }, true);

    document.addEventListener('pointerdown', function (event) {
      if (!state) return;
      var handle = event.target && event.target.closest
        ? event.target.closest('[data-gd-manual-bubble-handle],#gdManualBubbleSetLane')
        : null;
      if (!handle) return;
      event.preventDefault();
      beginDrag(event);
    }, true);

    document.addEventListener('keydown', function (event) {
      if (!state) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
    }, true);
  }

  bind();

  var api = { open: open, close: close, save: save, SOURCE: 'user_manual_set' };
  window.GolfDaddyManualBubbleSet = api;
  window.gdOpenManualBubbleSet = open;
  var app = (window.ClarityApp = window.ClarityApp || {});
  app.manualBubbleSet = api;
})();
