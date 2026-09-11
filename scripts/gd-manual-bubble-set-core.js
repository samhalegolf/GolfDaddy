/* Manual Bubble Set: a player's own placement -> the canonical offset anchor.
 *
 * This is a new INPUT METHOD into the Bubble model, not a new Bubble type. The
 * golfer knows one thing the app cannot read off a launch monitor they do not
 * own: "when I make my smoothest swing with this club, the ball naturally
 * finishes about here". That is a direction. The canonical language for a
 * direction is already degrees off alignment, so this file's whole job is to
 * turn a dragged position into that number and hand it to the anchor shape the
 * coach override already uses (gd-manual-practice-core.js buildOffsetAnchor).
 *
 * What lives here is ONLY the placement <-> degrees conversion and the shapes
 * the browser lane hands on. Deliberately absent:
 *
 *   - any Bubble geometry of its own. The shape comes from
 *     gdGeneratedShotBubbleForClub for the selected club at its bag distance,
 *     injected as deps.generatedBubbleForClub. A manual placement moves the
 *     Bubble; it does not redraw it.
 *   - any scaling across the Bag. One directional anchor is saved and the
 *     existing Bag/Bubble generator sizes every other club from its own bag
 *     distance, exactly as it does after a Practice adoption.
 *   - any evidence. No shots are invented, nothing is written to the Practice
 *     Library, and the stored source says user_manual_set so a manual Bubble
 *     can never be read back as practice evidence or as a coach override.
 *
 * SIGN CONVENTION - there is only one in this app and this file does not add a
 * second. Positive degrees mean RIGHT of the target line, for right- and
 * left-handers alike (gdOffsetLabel renders +2.3 as "R 2.3deg"; handedness
 * only ever changes the Bubble's derived tilt/skew, never which way the aim
 * points). In the lane model the ball is at the left and the target at the
 * right, so model +y is RIGHT and draws BELOW the alignment line - the same
 * landscape law as gdShotBubbleModelEndpoint and gdShotChartYForLateral.
 *
 * Dependency-injected rather than reaching for globals, so the conversion runs
 * headlessly in dev/manual-bubble-set-core.test.js:
 *   deps.clubBaselineM(club)                      - gdClarityClubBaselineM
 *   deps.generatedBubbleForClub(club, carryM, deg)- gdGeneratedShotBubbleForClub
 *   deps.buildOffsetAnchor(input)                 - manual practice core's shared anchor
 */
(function (rootFactory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = rootFactory();
  } else {
    var api = rootFactory();
    if (typeof window !== 'undefined') {
      window.GolfDaddyManualBubbleSetCore = api;
      window.GolfDaddy = window.GolfDaddy || {};
      window.GolfDaddy.modules = window.GolfDaddy.modules || {};
      window.GolfDaddy.modules.manualBubbleSetCore = api;
    }
  }
})(function () {
  'use strict';

  /* The source stamped on everything this lane produces. Distinct from the
     coach's coach_manual_override on purpose: both are manual anchors, but
     "my coach set this" and "I set this myself" are different facts about the
     same player and the UI, the sync and any later audit all need to tell
     them apart. */
  var SOURCE = 'user_manual_set';

  /* Stamped on the saved record so a Bubble set under today's placement rule
     can always be read back against the rule that produced it, rather than
     being silently reinterpreted by a later one. */
  var PLACEMENT_VERSION = 'manual-bubble-set-v1';

  /* The shapeSource the saved bubble carries. gdBubbleRoleStyle only special-
     cases "coach-set" (which presents as a Starter Bubble); everything else
     presents as My Bubble, which is exactly right - a player who placed their
     own Bubble HAS a My Bubble. */
  var SHAPE_SOURCE = 'user-manual-set';

  /* Last-resort carry, used only when the bag cannot answer for the club.
     Matches gd-manual-practice-core.js so the two manual lanes cannot disagree
     about what an unknown club is worth. */
  var FALLBACK_CARRY_M = 155;
  var MIN_CARRY_M = 30;

  /* Nothing may be saved beyond this, whatever the drag surface allows. A
     Bubble is a natural shot pattern, not a shank: past this the generated
     geometry stops meaning anything and the player has plainly grabbed the
     handle rather than described a shot. */
  var MAX_OFFSET_DEG = 12;

  function asNumber(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function cleanString(value, fallback) {
    var text = String(value == null ? '' : value).trim();
    return text || String(fallback == null ? '' : fallback).trim();
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function round(value, decimals) {
    var factor = Math.pow(10, decimals || 0);
    return Math.round(asNumber(value, 0) * factor) / factor;
  }

  // === Placement <-> degrees ===============================================
  //
  // The forward direction already exists and is not duplicated here: the lane
  // renderer asks gdShotBubbleModelEndpoint where a given offset draws, and it
  // resolves y = yModel + tan(deg) * dx. This file owns the INVERSE, which is
  // the same identity read the other way, so a placement and the drawing of it
  // are the same number by construction rather than by agreement.

  /* dxModel is the run from the ball to the target line; dyModel is how far
     BELOW that line the player dropped the Bubble. Below is right. */
  function offsetDegForPlacement(dyModel, dxModel) {
    var dy = asNumber(dyModel, NaN);
    var dx = asNumber(dxModel, NaN);
    if (!Number.isFinite(dy) || !Number.isFinite(dx) || dx <= 0) return NaN;
    return Math.atan2(dy, dx) * 180 / Math.PI;
  }

  /* The reading the player can actually express on this surface. The renderer
     clamps the drawn y into a band, so a drag that leaves the band would store
     a degree value the player never saw - this is the band, in degrees, and it
     is what both the drag and the save are held to. */
  function placementRangeDeg(frame) {
    frame = frame || {};
    var dx = asNumber(frame.dxModel, NaN);
    var up = asNumber(frame.maxUpModel, NaN);
    var down = asNumber(frame.maxDownModel, NaN);
    if (!Number.isFinite(dx) || dx <= 0 || !Number.isFinite(up) || !Number.isFinite(down)) {
      return { leftDeg: -MAX_OFFSET_DEG, rightDeg: MAX_OFFSET_DEG };
    }
    return {
      leftDeg: Math.max(-MAX_OFFSET_DEG, offsetDegForPlacement(-Math.abs(up), dx)),
      rightDeg: Math.min(MAX_OFFSET_DEG, offsetDegForPlacement(Math.abs(down), dx))
    };
  }

  function clampOffsetDeg(offsetDeg, range) {
    var deg = asNumber(offsetDeg, NaN);
    if (!Number.isFinite(deg)) return NaN;
    var bounds = range || { leftDeg: -MAX_OFFSET_DEG, rightDeg: MAX_OFFSET_DEG };
    var left = asNumber(bounds.leftDeg, -MAX_OFFSET_DEG);
    var right = asNumber(bounds.rightDeg, MAX_OFFSET_DEG);
    return round(clamp(deg, Math.max(left, -MAX_OFFSET_DEG), Math.min(right, MAX_OFFSET_DEG)), 2);
  }

  // === Reference club ======================================================

  /* The bag answers for distance, and the generated Bubble answers for shape.
     Neither is asked to answer for direction - that is the only thing the
     player is here to supply. The carry is the BAG BASELINE, never a number
     typed into this screen: a second distance model for manual Bubbles is
     exactly the duplicate source of truth this feature must not create. */
  function resolveReferenceClub(club, deps) {
    deps = deps || {};
    var label = cleanString(club, '7i');

    var carryM = NaN;
    var carrySource = 'bag_baseline';
    if (typeof deps.clubBaselineM === 'function') {
      try {
        carryM = asNumber(deps.clubBaselineM(label), NaN);
      } catch (error) {
        carryM = NaN;
      }
    }
    if (!Number.isFinite(carryM) || carryM <= 0) {
      carryM = FALLBACK_CARRY_M;
      carrySource = 'fallback_carry';
    }
    carryM = Math.max(MIN_CARRY_M, carryM);

    return {
      club: label,
      baseDistanceM: round(carryM, 1),
      carrySource: carrySource
    };
  }

  /* The bubble the placement surface draws and the save stores. It is the
     generated bubble for this club at this bag distance and this offset -
     the same call the hub preview, the Comparison view and GPS all make. If
     the generator cannot answer, this returns null and the caller must not
     invent a shape to stand in for it. */
  function referenceBubbleFor(club, offsetDeg, deps) {
    deps = deps || {};
    var reference = resolveReferenceClub(club, deps);
    var deg = asNumber(offsetDeg, 0);
    if (typeof deps.generatedBubbleForClub !== 'function') return null;
    var generated = null;
    try {
      generated = deps.generatedBubbleForClub(reference.club, reference.baseDistanceM, deg) || null;
    } catch (error) {
      generated = null;
    }
    if (!generated) return null;
    var widthM = asNumber(generated.widthM || generated.bubbleWidthM || generated.clusterWidthM, NaN);
    var depthM = asNumber(generated.depthM || generated.bubbleDepthM || generated.clusterDepthM, NaN);
    if (!Number.isFinite(widthM) || widthM <= 0 || !Number.isFinite(depthM) || depthM <= 0) return null;
    return {
      club: reference.club,
      baseDistanceM: reference.baseDistanceM,
      carrySource: reference.carrySource,
      offsetDeg: round(deg, 2),
      widthM: round(widthM, 2),
      depthM: round(depthM, 2),
      generated: generated
    };
  }

  // === The saved record ====================================================

  /* The provenance the profile keeps. Enough to reopen the screen on exactly
     what the player set, and enough for anyone reading the profile later to
     see this Bubble was hand-placed rather than measured. */
  function manualSetRecord(input) {
    input = input || {};
    var deps = input.deps || {};
    var anchorInput = {
      source: SOURCE,
      club: input.club || input.referenceClub,
      offsetDeg: input.offsetDeg,
      createdAt: input.createdAt || '',
      createdBy: input.createdBy || ''
    };
    var anchor = typeof deps.buildOffsetAnchor === 'function'
      ? deps.buildOffsetAnchor(anchorInput)
      : null;
    if (!anchor) return null;
    var at = cleanString(input.updatedAt || input.createdAt, '');
    return {
      source: SOURCE,
      referenceClub: anchor.club,
      offsetDeg: anchor.offsetDeg,
      placementVersion: PLACEMENT_VERSION,
      baseDistanceM: asNumber(input.baseDistanceM, null),
      createdAt: cleanString(input.createdAt, at),
      updatedAt: at,
      anchor: anchor
    };
  }

  /* The staged pending source gdBubbleOffsetSave() commits. Same shape the
     Practice adoption and the distance-lane preview stage, because it is the
     same seam - only the source, the status and the shapeSource say where it
     came from.

     The fingerprint is deliberately NOT a practice fingerprint and can never
     collide with one. gdPracticeCurrentBubbleWasAdopted compares the saved
     fingerprint with the current practice analysis's; a manual Bubble must
     always compare false there, or "Adopt as My Bubble" would refuse to
     replace it and a player who later collects real Practice data would be
     locked out of their own evidence. */
  function pendingSourceFor(input) {
    input = input || {};
    var record = manualSetRecord(input);
    if (!record) return null;
    var bubble = input.bubble && typeof input.bubble === 'object' ? input.bubble : null;
    if (!bubble) return null;
    return {
      active: true,
      offsetDeg: record.offsetDeg,
      status: 'user_manual_set',
      club: record.referenceClub,
      shots: 0,
      fingerprint: [SOURCE, record.referenceClub, record.offsetDeg.toFixed(2)].join('|'),
      /* Not "committed" and not "review": this lane never touches distance
         learning, and gdBubbleOffsetSave only runs that for those two modes. */
      distanceMode: 'manual-set',
      source: SOURCE,
      manualSet: record,
      bubble: Object.assign({}, bubble, {
        club: record.referenceClub,
        offsetDeg: record.offsetDeg,
        faceOffsetDeg: record.offsetDeg,
        faceAlignmentOffsetDeg: record.offsetDeg,
        shapeSource: SHAPE_SOURCE
      })
    };
  }

  /* Reopening the screen. Reads back whatever the profile holds - a manual
     record first, then the plain saved anchor, so a player who set their
     Bubble another way still opens Manual Set on their real current position
     rather than on a fabricated zero. */
  function restoreState(profile, deps) {
    var p = profile && typeof profile === 'object' ? profile : {};
    var saved = p.manualBubbleSet && typeof p.manualBubbleSet === 'object' ? p.manualBubbleSet : null;
    var source = p.practiceBubbleSource && typeof p.practiceBubbleSource === 'object' ? p.practiceBubbleSource : {};
    var savedOffset = asNumber(saved && saved.offsetDeg, NaN);
    var activeOffset = asNumber(p.faceOffsetDeg, NaN);
    if (!Number.isFinite(activeOffset)) activeOffset = asNumber(p.centralFaceOffsetDeg, NaN);

    /* Only trust the manual record's offset if it is still the live one. A
       Practice Bubble adopted over the top makes the old manual number stale,
       and reopening on a stale position would quietly re-save it. */
    var manualIsLive = !!saved
      && source.active === true
      && cleanString(source.source, '') === SOURCE
      && Number.isFinite(savedOffset)
      && Number.isFinite(activeOffset)
      && Math.abs(savedOffset - activeOffset) < 0.02;

    var club = cleanString(
      manualIsLive ? saved.referenceClub : (source.club || (saved && saved.referenceClub)),
      ''
    );
    var offsetDeg = manualIsLive
      ? savedOffset
      : (Number.isFinite(activeOffset) && source.active === true ? activeOffset : 0);

    return {
      hasManualSet: manualIsLive,
      referenceClub: club,
      offsetDeg: round(offsetDeg, 2),
      updatedAt: cleanString(saved && saved.updatedAt, ''),
      reference: club ? resolveReferenceClub(club, deps) : null
    };
  }

  return {
    SOURCE: SOURCE,
    SHAPE_SOURCE: SHAPE_SOURCE,
    PLACEMENT_VERSION: PLACEMENT_VERSION,
    MAX_OFFSET_DEG: MAX_OFFSET_DEG,
    FALLBACK_CARRY_M: FALLBACK_CARRY_M,
    offsetDegForPlacement: offsetDegForPlacement,
    placementRangeDeg: placementRangeDeg,
    clampOffsetDeg: clampOffsetDeg,
    resolveReferenceClub: resolveReferenceClub,
    referenceBubbleFor: referenceBubbleFor,
    manualSetRecord: manualSetRecord,
    pendingSourceFor: pendingSourceFor,
    restoreState: restoreState
  };
});
