/* Which mapped loop is which named course? — the pure half of the Scorecard Engine.
 *
 * A site with two 18s gives the mapper two loops of geometry and the club gives
 * it two scorecards. Nothing in either says which is which. This decides it.
 *
 * The whole method is RELATIVITY. Absolute distance cannot be the signal:
 * a scorecard is measured from one tee set of five, OSM's playing line and the
 * card's yardage disagree on every dogleg, and half the world cards in yards.
 * None of that matters, because none of it changes the SHAPE - which hole is
 * longest, which is shortest, where the short holes fall. That shape survives
 * every one of those distortions, and it is different enough between two courses
 * on one site to tell them apart.
 *
 * A useful consequence: the parser never has to work out which tee column it is
 * reading. Any column ranks the same. That was the single hardest problem in the
 * old client-side parser (a hardcoded five-column tee order that silently put
 * every value in the wrong field whenever a club listed four tee sets, or six,
 * or par first) and relativity deletes it rather than solving it.
 *
 * Three signals, all relative:
 *
 *   parClassOverlap   The k shortest holes of a loop against the k par-3s of a
 *                     card. Decisive on its own most of the time - two courses
 *                     at one facility almost never share par-3 positions - and
 *                     it needs no absolute threshold, because k comes from the
 *                     card rather than from a guess about what "short" means.
 *   rankCorrelation   Spearman over every hole both sides have. The workhorse,
 *                     and the one that degrades gracefully when a card is
 *                     missing holes.
 *   lengthShare       Each loop's share of total mapped length against each
 *                     card's share of total carded length. Both sides measured
 *                     in their own units, so the SHARES compare even though the
 *                     scales do not. Only says anything when one course is
 *                     materially longer than its sibling, hence the low weight.
 *
 * Scored JOINTLY, never greedily. Matching each loop to its own best card
 * independently can hand both loops the same card and call it two matches;
 * assignments are scored whole and the best one wins.
 *
 * Nothing here blocks mapping. A weak or tied answer means the courses publish
 * with provisional labels - see matchLoopsToCards' `resolved` flag. Getting a
 * name wrong is worse than not having one; getting the geometry wrong is worse
 * than both, and geometry never depends on this file. */

import { distance } from "./gd-automapper-core.mjs";

/* How much each signal contributes. parClassOverlap leads because it is the one
   that is usually decisive by itself; lengthShare trails because two sibling
   courses are often built to similar lengths and it says nothing when they are. */
export const MATCH_WEIGHTS = { parClassOverlap: 0.45, rankCorrelation: 0.4, lengthShare: 0.15 };

/* Below this the winning assignment is not trusted enough to name courses from.
   Both are needed: a high score on two holes is luck, and two cards that score
   equally well have not been told apart even when both score highly. */
export const MIN_MATCH_SCORE = 0.55;
export const MIN_MATCH_MARGIN = 0.08;

/* Fewer shared holes than this and rank correlation is noise rather than
   evidence. Well under 18 on purpose - a card missing a few holes still
   fingerprints a course, and refusing on a 14-hole parse would waste a card that
   is perfectly good for this. */
export const MIN_COMPARABLE_HOLES = 6;

/* Brute force is 24 assignments at N=4 and 120 at N=5. No real facility needs
   more, and refusing beats quietly taking minutes on a pathological payload. */
const MAX_JOINT_COURSES = 5;

function validHoleNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 && n <= 45 ? Math.round(n) : null;
}

function finiteLength(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* Along the line, not across the gap. OSM tags a golf hole as a way running tee
   to green, so summing its segments follows the dogleg - which is exactly what a
   scorecard measures and what a centroid-to-centroid straight line does not. */
export function lineLengthM(points) {
  const pts = (points || []).filter(p => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng ?? p.lon)));
  if (pts.length < 2) return null;
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += distance(
      { lat: Number(pts[i - 1].lat), lng: Number(pts[i - 1].lng ?? pts[i - 1].lon) },
      { lat: Number(pts[i].lat), lng: Number(pts[i].lng ?? pts[i].lon) }
    );
  }
  return total > 0 ? total : null;
}

/* {holeNumber -> metres} from a loop's own OSM hole ways.
 *
 * Keeps the LONGEST feature per number rather than the first. A hole tagged as
 * both a way and a relation returns twice, and the relation often carries only a
 * fragment; taking the longer of the two is right in both cases and costs
 * nothing when there is only one. */
export function loopLengthsFromOsm(elements) {
  const lengths = {};
  (elements || []).forEach(element => {
    const tags = (element && element.tags) || {};
    if (String(tags.golf || "").toLowerCase() !== "hole") return;
    const hole = validHoleNumber(String(tags.ref || tags.name || "").match(/\d+/)?.[0]);
    if (!hole) return;
    const points = [];
    if (Array.isArray(element.geometry)) points.push(...element.geometry);
    if (Array.isArray(element.members)) element.members.forEach(m => { if (Array.isArray(m && m.geometry)) points.push(...m.geometry); });
    const length = lineLengthM(points);
    if (length && (!lengths[hole] || length > lengths[hole])) lengths[hole] = length;
  });
  return lengths;
}

/* {holeNumber -> metres} from a course's already-PUBLISHED objects_json, for
   relabelling a course that is not being rescanned - loopLengthsFromOsm above
   needs raw Overpass elements from an in-progress scan, which a stored
   course_maps row does not have.
 *
 * Straight tee-to-green, not the dogleg-following line loopLengthsFromOsm sums.
 * Cheaper than reconstructing fairway point order from a stored object map, and
 * good enough: every signal here is relative (rank order, share of total), never
 * absolute, so a dogleg being foreshortened moves every hole's number by roughly
 * the same fraction rather than reordering them. */
export function courseLengthsFromPublishedGeometry(objects) {
  const byHole = {};
  Object.values(objects || {}).forEach(object => {
    const hole = validHoleNumber(object && object.holeNumber);
    if (!hole || !object || !object.position) return;
    if (!byHole[hole]) byHole[hole] = {};
    if (object.type === "tee") byHole[hole].tee = object.position;
    else if (object.type === "green") byHole[hole].green = object.position;
  });
  const lengths = {};
  Object.keys(byHole).forEach(hole => {
    const pair = byHole[hole];
    if (!pair.tee || !pair.green) return;
    const length = finiteLength(distance(
      { lat: Number(pair.tee.lat), lng: Number(pair.tee.lng ?? pair.tee.lon) },
      { lat: Number(pair.green.lat), lng: Number(pair.green.lng ?? pair.green.lon) }
    ));
    if (length) lengths[hole] = length;
  });
  return lengths;
}

/* A card's distances in the same {holeNumber -> metres} shape. The tee column is
   deliberately not identified - see the header. */
export function cardLengths(card) {
  const lengths = {};
  ((card && card.holes) || []).forEach(row => {
    const hole = validHoleNumber(row && (row.hole ?? row.holeNumber ?? row.number));
    const length = finiteLength(row && (row.distanceM ?? row.metres ?? row.distance ?? row.yards));
    if (hole && length && !lengths[hole]) lengths[hole] = length;
  });
  return lengths;
}

export function cardPars(card) {
  const pars = {};
  ((card && card.holes) || []).forEach(row => {
    const hole = validHoleNumber(row && (row.hole ?? row.holeNumber ?? row.number));
    const par = Number(row && row.par);
    if (hole && Number.isFinite(par) && par >= 3 && par <= 6) pars[hole] = Math.round(par);
  });
  return pars;
}

/* Hole numbers both sides carry a length for. Everything below compares over
   this set only, so a card missing holes costs precision rather than an answer. */
function sharedHoles(a, b) {
  return Object.keys(a).map(Number).filter(hole => Number.isFinite(b[hole])).sort((x, y) => x - y);
}

/* Ranks over a chosen set of holes, 1 = longest. Ties share the mean rank so a
   pair of identical lengths cannot bias the correlation either way. */
export function rankVector(lengths, holes) {
  const list = (holes || Object.keys(lengths).map(Number))
    .filter(hole => Number.isFinite(lengths[hole]))
    .map(hole => ({ hole, length: lengths[hole] }))
    .sort((a, b) => b.length - a.length);
  const ranks = {};
  let i = 0;
  while (i < list.length) {
    let j = i;
    while (j + 1 < list.length && list[j + 1].length === list[i].length) j++;
    const mean = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[list[k].hole] = mean;
    i = j + 1;
  }
  return ranks;
}

/* Spearman, rescaled from [-1,1] to [0,1] so every signal in this file scores on
   the same scale and the weights above mean what they look like. */
export function rankCorrelation(lengthsA, lengthsB, holes) {
  const list = holes || sharedHoles(lengthsA, lengthsB);
  if (list.length < MIN_COMPARABLE_HOLES) return null;
  const ra = rankVector(lengthsA, list);
  const rb = rankVector(lengthsB, list);
  const n = list.length;
  const meanA = list.reduce((s, h) => s + ra[h], 0) / n;
  const meanB = list.reduce((s, h) => s + rb[h], 0) / n;
  let num = 0, denA = 0, denB = 0;
  list.forEach(hole => {
    const da = ra[hole] - meanA, db = rb[hole] - meanB;
    num += da * db; denA += da * da; denB += db * db;
  });
  if (denA <= 0 || denB <= 0) return null;
  return (num / Math.sqrt(denA * denB) + 1) / 2;
}

/* Where the short holes are, and where the long ones are.
 *
 * The card says how many par 3s a course has; the loop is then asked for exactly
 * that many of its shortest holes. So "short" never needs a threshold in metres -
 * it is defined by the card being tested, which is what makes this work across
 * units, tee sets and course lengths alike.
 *
 * Scored as overlap in both directions at once (Jaccard), because a loop whose
 * four shortest holes are a subset of a card's six par-3s is a weaker match than
 * one where the two sets are the same size and agree. */
export function parClassOverlap(loopLengths, pars, holes) {
  const list = holes || Object.keys(loopLengths).map(Number).filter(h => Number.isFinite(pars[h]));
  if (list.length < MIN_COMPARABLE_HOLES) return null;
  const byLength = list.slice().sort((a, b) => loopLengths[a] - loopLengths[b]);
  const scoreClass = (wanted, pick) => {
    if (!wanted.length) return null;
    const got = new Set(pick(wanted.length));
    const hit = wanted.filter(hole => got.has(hole)).length;
    const union = new Set([...wanted, ...got]).size;
    return union ? hit / union : null;
  };
  const shorts = scoreClass(list.filter(h => pars[h] === 3), k => byLength.slice(0, k));
  const longs = scoreClass(list.filter(h => pars[h] === 5), k => byLength.slice(-k));
  const parts = [shorts, longs].filter(v => v !== null);
  return parts.length ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
}

function total(lengths) {
  return Object.values(lengths).reduce((sum, value) => sum + value, 0);
}

/* Each side's share of its own total, compared. Scale-free by construction: the
   loops are in metres of mapped playing line and the cards are in whatever the
   club prints, but "this course is 53% of the golf on this site" is the same
   claim either way. Meaningless when the siblings are the same length, which is
   common - hence the smallest weight of the three. */
export function lengthShareAgreement(loopShare, cardShare) {
  if (!Number.isFinite(loopShare) || !Number.isFinite(cardShare)) return null;
  return 1 - Math.min(1, Math.abs(loopShare - cardShare) * 4);
}

/* One loop against one card. Returns the parts as well as the total so a wrong
   answer can be read rather than argued about - the same reason every parsed
   value carries its provenance. */
export function scorePairing(loop, card, shares) {
  const loopLengths = loop.lengths || {};
  const lengths = cardLengths(card);
  const pars = cardPars(card);
  const holes = sharedHoles(loopLengths, lengths);
  const parHoles = Object.keys(loopLengths).map(Number).filter(hole => Number.isFinite(pars[hole]));

  const signals = {
    parClassOverlap: parClassOverlap(loopLengths, pars, parHoles),
    rankCorrelation: rankCorrelation(loopLengths, lengths, holes),
    lengthShare: shares ? lengthShareAgreement(shares.loop, shares.card) : null
  };

  /* Re-weighted across whatever actually produced a number, so a card with no
     distances still scores on par positions alone instead of being punished for
     the signals it could not feed. */
  let weighted = 0, available = 0;
  Object.keys(MATCH_WEIGHTS).forEach(name => {
    if (signals[name] === null || signals[name] === undefined) return;
    weighted += signals[name] * MATCH_WEIGHTS[name];
    available += MATCH_WEIGHTS[name];
  });

  return {
    loopId: loop.id,
    cardName: (card && card.name) || "",
    score: available > 0 ? weighted / available : 0,
    signals,
    comparedHoles: holes.length,
    parHoles: parHoles.length
  };
}

/* Every way to give each loop its own distinct card - ordered selections of size
   `take` from `list`, not full permutations of everything.
 *
 * Permuting all the cards was wrong whenever there were more cards than loops, and
 * that is the normal case: the resolver keeps up to four. With two loops and four
 * cards, 24 permutations collapse to 12 distinct loop->card mappings, so the top
 * two "rival" assignments were routinely the SAME mapping with the unused cards
 * shuffled behind it. Their scores were therefore identical, the margin came out at
 * exactly 0, and matchLoopsToCards refused every multi-card site with
 * "cards-too-alike" - including Te Arai, where the South and North cards are par 72
 * and par 71 and could hardly be more distinguishable. */
export function injections(list, take) {
  if (take <= 0) return [[]];
  const out = [];
  list.forEach((item, index) => {
    injections(list.slice(0, index).concat(list.slice(index + 1)), take - 1)
      .forEach(rest => out.push([item].concat(rest)));
  });
  return out;
}

/* Assign every loop to a card, as one decision.
 *
 * loops: [{ id, lengths: {holeNumber: metres} }]   - loopLengthsFromOsm per loop
 * cards: [{ name, holes: [{hole, par, distanceM}] }]
 *
 * Returns the winning assignment, the runner-up, and whether the gap between
 * them is wide enough to name courses from. `resolved: false` is a normal
 * outcome and means publish with provisional labels - never that mapping should
 * stop. */
export function matchLoopsToCards(loops, cards) {
  const loopList = (loops || []).filter(loop => loop && loop.lengths && Object.keys(loop.lengths).length);
  const cardList = (cards || []).filter(card => card && Array.isArray(card.holes) && card.holes.length);

  if (!loopList.length || !cardList.length) {
    return { resolved: false, reason: "nothing-to-match", assignment: [], runnerUp: null, score: 0, margin: 0 };
  }
  if (loopList.length > MAX_JOINT_COURSES || cardList.length > MAX_JOINT_COURSES) {
    return { resolved: false, reason: "too-many-courses", assignment: [], runnerUp: null, score: 0, margin: 0 };
  }

  const loopTotals = loopList.map(loop => total(loop.lengths));
  const cardTotals = cardList.map(card => total(cardLengths(card)));
  const loopSum = loopTotals.reduce((s, v) => s + v, 0);
  const cardSum = cardTotals.reduce((s, v) => s + v, 0);

  /* Every loop against every card once. The joint step below only permutes
     indices, so no pairing is ever scored twice. */
  const grid = loopList.map((loop, li) => cardList.map((card, ci) => scorePairing(loop, card, {
    loop: loopSum > 0 ? loopTotals[li] / loopSum : null,
    card: cardSum > 0 ? cardTotals[ci] / cardSum : null
  })));

  const cardIndexes = cardList.map((_, index) => index);
  /* Shorter side governs: three loops and two cards leaves one loop unnamed rather
     than forcing a card onto it. */
  const take = Math.min(loopList.length, cardList.length);
  const scored = injections(cardIndexes, take)
    .map(order => {
      const pairs = order.map((cardIndex, li) => grid[li][cardIndex]);
      if (!pairs.length) return null;
      return { pairs, score: pairs.reduce((sum, pair) => sum + pair.score, 0) / pairs.length };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1] || null;
  const margin = runnerUp ? best.score - runnerUp.score : 1;
  /* A lone card cannot be told apart from anything, so there is no margin to
     clear - only the score has to stand up. */
  const marginOk = !runnerUp || margin >= MIN_MATCH_MARGIN;
  const scoreOk = best.score >= MIN_MATCH_SCORE;

  return {
    resolved: scoreOk && marginOk,
    reason: scoreOk ? (marginOk ? null : "cards-too-alike") : "weak-match",
    assignment: best.pairs,
    runnerUp: runnerUp ? { score: runnerUp.score, pairs: runnerUp.pairs.map(p => ({ loopId: p.loopId, cardName: p.cardName })) } : null,
    score: best.score,
    margin
  };
}

export const __scorecardMatchCoreTest = { injections, sharedHoles, total };
