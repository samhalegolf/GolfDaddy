// Manual Bubble Set: a player's placement -> the canonical offset anchor.
//
// What must not drift here is what a hand-placed Bubble is allowed to claim,
// and which way round it points. A player drags a Bubble and the app stores
// degrees; if those two ever disagree the golfer aims at one thing on this
// screen and a different thing on the course. So this file holds the sign
// convention, the placement<->degrees identity, the refusal to invent geometry
// or evidence, and the provenance that keeps a player-set Bubble telling the
// truth about itself afterwards.
//
// Run: node dev/manual-bubble-set-core.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const core = require(path.join(ROOT, 'scripts', 'gd-manual-bubble-set-core.js'));
const practiceCore = require(path.join(ROOT, 'scripts', 'gd-manual-practice-core.js'));

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('ok  -', msg);
  else { console.error('FAIL:', msg); failures += 1; }
}
function near(a, b, tolerance, msg) {
  const ok = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
  assert(ok, msg + (ok ? '' : ` (got ${a}, expected ~${b} +-${tolerance})`));
}

/* The three app functions the lane is allowed to read, stubbed so the whole
   conversion runs headlessly. */
const BAG = { PW: 120, '7i': 150, '5i': 175, Driver: 230 };
const GENERATED = {
  PW: { widthM: 18, depthM: 16 },
  '7i': { widthM: 26, depthM: 22 },
  '5i': { widthM: 30, depthM: 26 },
  Driver: { widthM: 44, depthM: 34 }
};
const deps = {
  clubBaselineM: (club) => BAG[club],
  generatedBubbleForClub: (club, carryM, offsetDeg) => {
    const shape = GENERATED[club];
    if (!shape) return null;
    return Object.assign({ club, baseDistanceM: carryM, offsetDeg }, shape);
  },
  buildOffsetAnchor: practiceCore.buildOffsetAnchor
};

// ---- the shared anchor really is shared -----------------------------------

assert(
  typeof practiceCore.buildOffsetAnchor === 'function',
  'the offset anchor is built by the shared builder in the Manual Practice seam'
);
assert(
  practiceCore.applyTrustedOverrideToAnalysis(
    { methods: {}, recommendation: null },
    { club: '7i', offsetDeg: 2.6, createdBy: 'coach-1' }
  ).override.source === 'coach_manual_override',
  'the coach lane still stamps coach_manual_override through that same builder'
);

// ---- the sign convention ---------------------------------------------------
//
// Ball left, target right. Model +y is DOWN on screen and means RIGHT of the
// target line - the same landscape law as gdShotBubbleModelEndpoint and
// gdShotChartYForLateral. There is exactly one convention in this app.

const DX = 315.6;   // a representative lane run from ball to target line

near(core.offsetDegForPlacement(0, DX), 0, 1e-9, 'a Bubble left on the target line is 0.0 degrees');
assert(core.offsetDegForPlacement(40, DX) > 0, 'placing the Bubble BELOW the line is a RIGHT (positive) offset');
assert(core.offsetDegForPlacement(-40, DX) < 0, 'placing the Bubble ABOVE the line is a LEFT (negative) offset');
near(
  core.offsetDegForPlacement(40, DX),
  -core.offsetDegForPlacement(-40, DX),
  1e-9,
  'equal distances either side of the line read as equal and opposite degrees'
);
assert(!Number.isFinite(core.offsetDegForPlacement(10, 0)), 'a lane with no run cannot be read as an angle');
assert(!Number.isFinite(core.offsetDegForPlacement('nonsense', DX)), 'an unreadable placement is not silently 0.0');

// ---- placement and drawing are the same number -----------------------------
//
// The forward direction is gdShotBubbleModelEndpoint's y = yModel + tan(deg)*dx.
// This file owns the inverse. Round-tripping proves the golfer is stored at the
// angle they were shown, and the source check below proves the forward rule
// this inverse is the inverse OF has not been rewritten underneath it.

[-9, -6.4, -2.3, -0.4, 0, 0.4, 2.3, 6.4, 9].forEach((deg) => {
  const dy = Math.tan(deg * Math.PI / 180) * DX;
  near(core.offsetDegForPlacement(dy, DX), deg, 1e-9, `a Bubble drawn at ${deg} deg reads back as ${deg} deg`);
});

const audit = fs.readFileSync(path.join(ROOT, 'scripts', 'gd-route-audit.js'), 'utf8');
assert(
  /rawDy\s*=\s*Number\.isFinite\(n\)\s*\?\s*Math\.tan\(n\*Math\.PI\/180\)\*dx\s*:\s*0/.test(audit),
  'the forward rule this inverse mirrors is still y = yModel + tan(deg)*dx, unnegated'
);
assert(
  /const minY=frame\.modelH\*\.30;[\s\S]{0,80}const maxY=frame\.modelH\*\.80;/.test(audit),
  'the drawn band is still [0.30H, 0.80H] - the range placementRangeDeg is told about'
);

// ---- the range the player can actually express -----------------------------

const range = core.placementRangeDeg({ dxModel: DX, maxUpModel: 50, maxDownModel: 50 });
assert(range.leftDeg < 0 && range.rightDeg > 0, 'the placement range opens both ways from the target line');
near(range.rightDeg, -range.leftDeg, 1e-9, 'and opens the same amount each way, so neither miss is easier to state');
assert(
  core.clampOffsetDeg(90, range) === Number(range.rightDeg.toFixed(2)),
  'a placement past the surface cannot store a degree value the player never saw'
);
assert(
  Math.abs(core.clampOffsetDeg(90, { leftDeg: -80, rightDeg: 80 })) === core.MAX_OFFSET_DEG,
  'and nothing may be saved past the hard limit, whatever the surface allows'
);
assert(core.clampOffsetDeg(0, range) === 0, 'zero is a real answer and survives the clamp untouched');
assert(!Number.isFinite(core.clampOffsetDeg('nonsense', range)), 'an unreadable offset is not clamped into a fake one');

// ---- the reference club: the Bag answers for distance ----------------------

const sevenIron = core.resolveReferenceClub('7i', deps);
assert(sevenIron.baseDistanceM === 150, 'the reference distance is the BAG baseline, never typed in on this screen');
assert(sevenIron.carrySource === 'bag_baseline', 'and says so');
assert(
  core.resolveReferenceClub('3w', deps).baseDistanceM === core.FALLBACK_CARRY_M,
  'a club the bag cannot answer for falls back rather than failing the screen'
);
assert(core.resolveReferenceClub('3w', deps).carrySource === 'fallback_carry', 'and says that too');

// ---- the shape comes from the generator, and is never invented -------------

const driver = core.referenceBubbleFor('Driver', 2.3, deps);
assert(driver.widthM === 44 && driver.depthM === 34, 'the Bubble drawn is the GENERATED bubble for that club');
assert(driver.baseDistanceM === 230, 'at that club\'s own bag distance');
assert(
  core.referenceBubbleFor('3w', 2.3, deps) === null,
  'a club the generator cannot draw returns nothing - no stand-in shape is invented'
);
assert(
  core.referenceBubbleFor('7i', 2.3, {}) === null,
  'and with no generator at all there is no Bubble, rather than a guessed one'
);
assert(
  core.referenceBubbleFor('7i', 2.3, deps).widthM !== core.referenceBubbleFor('Driver', 2.3, deps).widthM,
  'each club keeps its own generated size - the reference club is not stamped over the bag'
);

// ---- the saved record: honest about what it is -----------------------------

const record = core.manualSetRecord({
  club: '7i',
  offsetDeg: 2.34,
  baseDistanceM: 150,
  createdAt: '2026-09-12T09:00:00.000Z',
  updatedAt: '2026-09-12T09:05:00.000Z',
  deps
});
assert(record.source === 'user_manual_set', 'a player-set Bubble is stamped user_manual_set');
assert(record.source !== practiceCore.SOURCE_OVERRIDE, 'and is never confused with the coach override');
assert(record.source !== practiceCore.SOURCE_MANUAL, 'and is never confused with Manual Practice evidence');
assert(record.referenceClub === '7i' && record.offsetDeg === 2.34, 'the club and the offset are what the player set');
assert(record.anchor.source === 'user_manual_set', 'the anchor carries the same source through the shared builder');
assert(record.createdAt === '2026-09-12T09:00:00.000Z' && record.updatedAt === '2026-09-12T09:05:00.000Z', 'when it was set, and when it was last changed, are both kept');
assert(!!record.placementVersion, 'the placement rule that produced it is stamped, so it can be read back later');
assert(core.manualSetRecord({ club: '7i', offsetDeg: 'nonsense', deps }) === null, 'a placement with no real offset saves nothing');

// ---- the staged pending source: the canonical seam, nothing more -----------

const pending = core.pendingSourceFor({
  club: '7i',
  offsetDeg: -1.8,
  baseDistanceM: 150,
  createdAt: '2026-09-12T09:00:00.000Z',
  updatedAt: '2026-09-12T09:00:00.000Z',
  deps,
  bubble: deps.generatedBubbleForClub('7i', 150, -1.8)
});
assert(pending.active === true && pending.offsetDeg === -1.8, 'the stage carries the placement into the canonical save');
assert(pending.source === 'user_manual_set', 'stamped as the player\'s own, for the saved My Bubble to keep');
assert(pending.shots === 0, 'and claims no shots, because no shots were taken');
assert(
  pending.distanceMode !== 'committed' && pending.distanceMode !== 'review',
  'a hand-placed direction never triggers distance learning - it says nothing about distance'
);
assert(
  pending.bubble.shapeSource === core.SHAPE_SOURCE && pending.bubble.shapeSource !== 'coach-set',
  'the saved shape presents as My Bubble, not as a coach-set Starter Bubble'
);
assert(
  pending.bubble.offsetDeg === -1.8 && pending.bubble.faceAlignmentOffsetDeg === -1.8,
  'the stored bubble points where the player put it'
);
assert(
  /^user_manual_set\|/.test(pending.fingerprint),
  'the fingerprint is a manual-set fingerprint and can never equal a Practice one'
);
assert(
  core.pendingSourceFor({ club: '7i', offsetDeg: 2.3, deps, bubble: null }) === null,
  'nothing is staged without a real generated bubble behind it'
);
assert(
  !('observations' in pending) && !('clubGroups' in pending) && !('metrics' in pending),
  'no evidence shape rides along - a placement is not a practice session'
);

// ---- reopening the screen --------------------------------------------------

const manualProfile = {
  faceOffsetDeg: 2.34,
  handedness: 'right',
  practiceBubbleSource: { active: true, offsetDeg: 2.34, source: 'user_manual_set', club: '7i' },
  manualBubbleSet: { source: 'user_manual_set', referenceClub: '7i', offsetDeg: 2.34, updatedAt: '2026-09-12T09:05:00.000Z' }
};
const reopened = core.restoreState(manualProfile, deps);
assert(reopened.hasManualSet === true, 'a player who set their Bubble by hand reopens on their manual set');
assert(reopened.referenceClub === '7i' && reopened.offsetDeg === 2.34, 'on the same club, at the same placement');
assert(reopened.reference.baseDistanceM === 150, 'and the same bag distance it was set against');

const leftHanded = core.restoreState(
  Object.assign({}, manualProfile, { handedness: 'left' }),
  deps
);
assert(
  leftHanded.offsetDeg === reopened.offsetDeg,
  'handedness does not flip the aim: +2.34 is right of target for a left-hander too'
);

const practiceAdopted = core.restoreState({
  faceOffsetDeg: -1.1,
  practiceBubbleSource: { active: true, offsetDeg: -1.1, club: '5i' },
  manualBubbleSet: { source: 'user_manual_set', referenceClub: '7i', offsetDeg: 2.34 }
}, deps);
assert(
  practiceAdopted.hasManualSet === false,
  'once a Practice Bubble is adopted over it, the stale manual placement stops being the answer'
);
assert(
  practiceAdopted.offsetDeg === -1.1,
  'and reopening shows the Bubble the player actually has, not the one they used to have'
);

const noBubble = core.restoreState({}, deps);
assert(
  noBubble.hasManualSet === false && noBubble.offsetDeg === 0,
  'a player with no Bubble at all starts centred on the target line'
);

// ---- the lane cannot reach the admin Manual Practice surface ---------------

const lane = fs.readFileSync(path.join(ROOT, 'scripts', 'gd-manual-bubble-set.js'), 'utf8')
  /* Comments are allowed to NAME the admin lane - saying which gate stays shut
     is the whole point of them. Only real code may not reach for it. */
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
['isAdminUser', 'ManualPracticeData', 'applyTrustedOverride', 'finishSession', 'gd_manual_practice_v1'].forEach((name) => {
  assert(!lane.includes(name), `the player lane never calls ${name} - Manual Practice stays admin-gated`);
});
const practiceData = fs.readFileSync(path.join(ROOT, 'scripts', 'gd-manual-practice-data.js'), 'utf8');
assert(
  /function isAdminUser\s*\(\)\s*\{\s*return accountPermission\(\)\s*===\s*'admin';\s*\}/.test(practiceData),
  'and the Manual Practice admin gate itself is untouched'
);

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
