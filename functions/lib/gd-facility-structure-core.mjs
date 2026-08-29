/* What physically exists at this site, decided from evidence rather than counts.
 *
 * THREE SEPARATE QUESTIONS, ANSWERED IN THREE PLACES
 *
 *   structure       What is on the ground: one course, several nines, several
 *                   courses. THIS FILE.
 *   mapping method  How the holes were identified: OSM numbering, AutoMapper,
 *                   the Native Resolver, or a mix. Recorded here, decided by
 *                   the worker.
 *   organisation    How the published rows group, what a player may pair with
 *                   what, which nine goes first. Downstream, and deliberately
 *                   not allowed to reach back into geometry.
 *
 * They used to be one question and the answer was always "nines", because the
 * only code that asked was the code that had already decided the site was a
 * multi-loop facility. So a 27-hole ratio meant three nines whether the ground
 * held three nines or an eighteen and a par-3 nine, and an 18-hole card at a
 * three-nine site could publish itself as a whole course over two of them.
 *
 * WHY NOT COUNT HOLES
 *
 * 27 candidates is the same number for all of:
 *
 *   three named nines           Red, White, Blue           -> multi-nine
 *   18 proper + a par-3 nine    two real courses           -> multi-course
 *   an 18 with noise            practice ground swept in   -> single-course
 *
 * Nothing in "27" separates them. What separates them is what the cards claim
 * and HOW THAT GROUND SITS: whether a nine falls inside an eighteen, whether
 * two claims each keep ground of their own, whether anything is left over.
 *
 *   nine INSIDE an eighteen, and more ground beyond it
 *                               the eighteen is two nines stapled together and
 *                               the nine names one of them          -> multi-nine
 *   nine inside an eighteen, nothing beyond
 *                               one course described twice          -> single-course
 *   nine DISJOINT from an eighteen
 *                               two courses, no shared ground       -> multi-course
 *   two eighteens sharing a nine, each keeping a nine
 *                               play orders over three nines        -> multi-nine
 *
 * Every one of those reads the ground. None of them reads a hole count on its
 * own, which is the rule this file exists to enforce.
 *
 * Pure - evidence in, a verdict out. No network, no database, no publishing. */

import { atomicLoopCount, claimOverlap, claimsOverlap, dropContainedClaims, isContainedIn, HOLES_PER_LOOP, MIN_SHARED_CANDIDATES } from "./gd-facility-loops-core.mjs";

export const FACILITY_STRUCTURE = {
  SINGLE: "single-course",
  MULTI_NINE: "multi-nine",
  MULTI_COURSE: "multi-course",
  UNKNOWN: "unknown"
};

export const MAPPING_METHOD = {
  OSM_NUMBERED: "osm-numbered",
  AUTOMAPPER: "automapper",
  NATIVE_RESOLVER: "native-resolver",
  MIXED: "mixed"
};

function holeCount(claim) { return ((claim && claim.holes) || []).length; }

function claimIds(claim) {
  return ((claim && claim.holes) || []).map(hole => hole && hole.candidateId).filter(id => id != null).map(String);
}

/* How much ground no claim speaks for. */
export function unclaimedGround(claims, candidateCount) {
  const ids = new Set();
  (claims || []).forEach(claim => claimIds(claim).forEach(id => ids.add(id)));
  return Math.max(0, (Math.max(0, Number(candidateCount) || 0)) - ids.size);
}

/* A claim nobody else shares ground with in the play-order way.
 *
 * This is the line between "safe to take off the table" and "must stay in
 * play". Red+White and White+Blue each keep a nine of their own while sharing
 * one - remove either one's ground and the other looks like a failed match and
 * gets dropped, which is how two of a facility's three courses used to vanish.
 * A claim with no such partner owns its ground outright and excluding it only
 * makes the remaining problem smaller. */
export function isIndependentClaim(claim, claims) {
  return !(claims || []).some(other => {
    if (other === claim) return false;
    const shared = claimOverlap(claim, other);
    if (shared < MIN_SHARED_CANDIDATES) return false;
    return (holeCount(claim) - shared) >= MIN_SHARED_CANDIDATES
      && (holeCount(other) - shared) >= MIN_SHARED_CANDIDATES;
  });
}

/* Does a nine sit inside an eighteen while more ground waits outside it?
 *
 * The signature of an aggregator's combined card. Howeston's generic 18-hole
 * "All Square" card swallowed the ground of two real nines, one of which had
 * its own named card - and because containment reads as "one course described
 * twice", the named nine was dropped and the 18 published as a whole course.
 *
 * Containment alone cannot say which it is. What decides it is whether the
 * eighteen accounts for the site: a front-nine card inside a plain 18 leaves
 * nothing over, while a named nine inside a composite 18 leaves at least one
 * more nine of ground standing unexplained. */
function nineInsideLargerClaim(claims, candidateCount) {
  const list = claims || [];
  for (const small of list) {
    if (holeCount(small) !== HOLES_PER_LOOP) continue;
    for (const big of list) {
      if (big === small || holeCount(big) <= HOLES_PER_LOOP) continue;
      if (!isContainedIn(small, big)) continue;
      const beyond = Math.max(0, (Number(candidateCount) || 0) - holeCount(big));
      if (beyond >= HOLES_PER_LOOP) return { small, big, beyond };
    }
  }
  return null;
}

/* Nine-hole claims that do not share ground with each other. Two of those are
   two physical loops however the club chooses to sell them. */
function disjointNineClaims(claims) {
  const nines = (claims || []).filter(claim => holeCount(claim) === HOLES_PER_LOOP);
  const kept = [];
  nines.forEach(nine => {
    if (kept.some(other => claimOverlap(nine, other) >= MIN_SHARED_CANDIDATES)) return;
    kept.push(nine);
  });
  return kept;
}

/* No pair of claims shares any meaningful ground. */
function allClaimsDisjoint(claims) {
  const list = claims || [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (claimOverlap(list[i], list[j]) >= MIN_SHARED_CANDIDATES) return false;
    }
  }
  return true;
}

/* input: {
 *   candidateCount   hole candidates the resolver found on this ground
 *   claims           [{ cardName, confidence, holes: [{holeNumber, candidateId}] }]
 *   osmNineLoops     count of separately-identified nine-hole loops from OSM /
 *                    AutoMapper, when the numbering already did the separating
 *   prior            the previous assessment in this scan, kept when nothing
 *                    stronger has turned up
 * }
 *
 * Returns { structure, confident, reason, evidence, expectedLoops,
 * unclaimedCandidates, sticky }.
 *
 * `confident` is the gate on acting: an unconfident verdict must not switch a
 * facility into nine-hole handling, and must not stop a run either. */
export function assessFacilityStructure(input) {
  const candidateCount = Math.max(0, Number(input && input.candidateCount) || 0);
  const claims = ((input && input.claims) || []).filter(claim => holeCount(claim) >= MIN_SHARED_CANDIDATES);
  const osmNineLoops = Math.max(0, Number(input && input.osmNineLoops) || 0);
  const prior = (input && input.prior) || null;
  const expectedLoops = atomicLoopCount(candidateCount);
  const unclaimedCandidates = unclaimedGround(claims, candidateCount);
  const evidence = [];

  const verdict = (structure, confident, reason) => {
    const out = { structure, confident, reason, evidence, expectedLoops, unclaimedCandidates, sticky: false };
    /* A facility that has already proved itself multi-nine is not talked out of
       it by a later aggregator card that happens to fit two of its loops. Only
       evidence that is itself confident may move the verdict, and nothing may
       collapse a multi-nine site back to one course. */
    if (!prior || !prior.confident) return out;
    if (prior.structure === structure) return Object.assign(out, { confident: true });
    if (!confident) return Object.assign({}, prior, { sticky: true, evidence, reason: "held-" + prior.structure + "-over-unconfident-" + structure, unclaimedCandidates, expectedLoops });
    if (prior.structure === FACILITY_STRUCTURE.MULTI_NINE && structure === FACILITY_STRUCTURE.SINGLE) {
      return Object.assign({}, prior, { sticky: true, evidence, reason: "held-multi-nine-over-single-course-claim", unclaimedCandidates, expectedLoops });
    }
    return out;
  };

  if (!candidateCount) return verdict(FACILITY_STRUCTURE.UNKNOWN, false, "no-hole-candidates");

  /* Nines already separated by numbering. Nothing here needs the resolver, and
     saying so is what keeps a cleanly-mapped 27 off the expensive path. */
  if (osmNineLoops >= 2) {
    evidence.push("osm-nine-loops:" + osmNineLoops);
    return verdict(FACILITY_STRUCTURE.MULTI_NINE, true, "numbering-separated-nine-hole-loops");
  }

  if (!claims.length) {
    /* Ground and nothing that explains it. Deliberately not a structure: a
       verdict here would be a guess off the candidate count, which is the one
       thing this file refuses to do. */
    return verdict(FACILITY_STRUCTURE.UNKNOWN, false, expectedLoops > 1 ? "no-claims-over-multi-loop-ground" : "no-claims");
  }

  /* Play orders. Two claims sharing a nine while each keeps one of its own is a
     shape nothing else produces - see claimsOverlap. */
  if (claimsOverlap(claims)) {
    evidence.push("mutual-partial-overlap");
    return verdict(FACILITY_STRUCTURE.MULTI_NINE, true, "cards-share-ground-and-keep-their-own");
  }

  const nested = nineInsideLargerClaim(claims, candidateCount);
  if (nested) {
    evidence.push("nine-inside-" + holeCount(nested.big) + "-with-" + nested.beyond + "-beyond");
    return verdict(FACILITY_STRUCTURE.MULTI_NINE, true, "combined-card-covers-a-named-nine-and-ground-remains");
  }

  /* Containment that is NOT the multi-nine signature is what it has always
     been: one course described twice, an aggregator listing a front nine
     separately or a wrong card that fits half the ground. Out it goes, before
     anything downstream reads it as two courses sharing ground. */
  const effective = dropContainedClaims(claims);

  const nines = disjointNineClaims(effective);
  if (nines.length >= 2) {
    evidence.push("disjoint-nine-claims:" + nines.length);
    return verdict(FACILITY_STRUCTURE.MULTI_NINE, true, "two-or-more-nine-hole-loops-on-separate-ground");
  }

  /* Separate courses: nothing shared, at least one of them a full-length course
     in its own right, and between them they account for the site. This is the
     18-plus-par-3-nine case and it must NOT become three nines. */
  if (effective.length >= 2 && allClaimsDisjoint(effective)) {
    evidence.push("disjoint-claims:" + effective.length);
    const anyFull = effective.some(claim => holeCount(claim) > HOLES_PER_LOOP);
    if (anyFull && unclaimedCandidates < HOLES_PER_LOOP) {
      return verdict(FACILITY_STRUCTURE.MULTI_COURSE, true, "separate-courses-account-for-the-ground");
    }
    return verdict(FACILITY_STRUCTURE.MULTI_COURSE, false, "separate-courses-but-ground-unaccounted-for");
  }

  if (effective.length === 1) {
    evidence.push("single-claim:" + holeCount(effective[0]));
    /* One card, and the ground it did not claim is under a loop's worth: a
       course with practice greens and rejected candidates around it. */
    if (unclaimedCandidates < HOLES_PER_LOOP) return verdict(FACILITY_STRUCTURE.SINGLE, true, "one-course-accounts-for-the-ground");
    /* One card and a nine or more standing outside it. There IS something else
       here, but one card cannot say what shape it is - and guessing from the
       leftover count is exactly the inference this file refuses to make. */
    return verdict(FACILITY_STRUCTURE.UNKNOWN, false, unclaimedCandidates + "-candidates-beyond-the-only-claim");
  }

  return verdict(FACILITY_STRUCTURE.UNKNOWN, false, "evidence-does-not-explain-the-ground");
}

/* What the mapping methods across a set of accepted claims add up to. */
export function summariseMappingMethod(methods) {
  const distinct = [...new Set((methods || []).filter(Boolean))];
  if (!distinct.length) return null;
  return distinct.length === 1 ? distinct[0] : MAPPING_METHOD.MIXED;
}

/* HOW WERE THESE HOLES ACTUALLY IDENTIFIED?
 *
 * A separate question from what the site IS, and it has to stay separate: a
 * cleanly-numbered 27 and a 27 the resolver had to derive from scorecard
 * distances are the SAME structure reached two different ways, and a facility
 * that reports only its structure cannot tell an operator which of its courses
 * are resting on evidence worth re-checking.
 *
 * The four answers, and what earns each:
 *
 *   osm-numbered     Every published hole took its number from OSM's own
 *                    ref/name tags, and nothing else had to be worked out.
 *   automapper       The numbers came from OSM, but the tags alone did not put
 *                    the holes on the right course - the AutoMapper had to chain
 *                    hole geometry into loops itself, because the site had no
 *                    separate course polygons to sort them by. Broken or
 *                    duplicated numbering lands here.
 *   native-resolver  Numbering derived from a scorecard's distances, OSM refs
 *                    ignored entirely.
 *   mixed            More than one of the above reached the published geometry.
 *
 * Note what does NOT make it `automapper`: widening the query frame. A wider
 * sweep changes which features were fetched, not how they were identified, and
 * counting it would make almost every large site report the same method.
 *
 * Returns null rather than guessing when nothing was identified at all. */
export function mappingMethodFor(evidence) {
  const osmHoles = Math.max(0, Number(evidence && evidence.osmNumberedHoles) || 0);
  const resolverHoles = Math.max(0, Number(evidence && evidence.resolverHoles) || 0);
  if (!osmHoles && !resolverHoles) return null;
  if (osmHoles && resolverHoles) return MAPPING_METHOD.MIXED;
  if (resolverHoles) return MAPPING_METHOD.NATIVE_RESOLVER;
  return (evidence && evidence.separatedByGeometry) ? MAPPING_METHOD.AUTOMAPPER : MAPPING_METHOD.OSM_NUMBERED;
}

/* THE FACILITY ORGANISER
 *
 * Everything above solves geometry. This does not: it takes loops that are
 * already resolved and says what they are to each other - how many courses the
 * site publishes, which of them are nines of one facility, what still has no
 * name. Downstream (the picker, the round-start pairing prompt) reads this.
 *
 * Kept separate on purpose. When facility organisation and geometry solving
 * shared a function, a downstream rule about what a player may pair with what
 * ended up deciding how ground was matched, which is backwards. Nothing here
 * may be consulted while claims are still being resolved.
 *
 * Play ORDER is not here either. Three sibling nines is the whole answer; which
 * two a player walks today, and in which order, is a question asked once per
 * round - see gd-facility-loops-core.mjs. */
export function organiseFacility(loops, opts) {
  const list = (loops || []);
  const structure = (opts && opts.structure) || FACILITY_STRUCTURE.UNKNOWN;
  const courses = list.map((loop, index) => ({
    index,
    name: loop.name || loop.cardName || "",
    nameSource: loop.nameSource || ((loop.name || loop.cardName) ? "scorecard-resolved" : "provisional"),
    holes: (loop.holes || loop.guides || loop.holeNumbers || []).length,
    /* A nine at a multi-nine site is selectable ground the player pairs with
       another; anywhere else a published row is a course you simply play. */
    role: structure === FACILITY_STRUCTURE.MULTI_NINE ? "selectable-nine" : "course"
  }));
  return {
    structure,
    mappingMethod: (opts && opts.mappingMethod) || null,
    courses,
    siblings: courses.length,
    /* Straight out of the organiser rather than inferred from a "Course 2" in
       the picker, so Studio can offer Update Scorecards against exactly the
       facilities that need it. */
    needsLabelling: courses.some(course => course.nameSource === "provisional")
  };
}

/* What the next round should ask for, given what this one resolved.
 *
 * Two decisions, both of which used to be inline in the worker and neither of
 * which could be tested without a network:
 *
 *   what ground comes off the table
 *     Everything an independent claim owns. Nothing at all at a composite
 *     facility, where the cards legitimately reach for the same nine and taking
 *     one away makes the next look like a failed match.
 *
 *   how many cards to go looking for
 *     Driven by GROUND, not by how many card rows exist. Howeston had three rows
 *     for three loops and one of them was an aggregator describing two of the
 *     others - so counting rows said "enough evidence" over a facility that was
 *     a third unexplained. Ask for what has been resolved, plus what the
 *     leftovers could still hold, plus one: the count is an estimate and asking
 *     short costs a whole course while asking long costs one fetch. */
export function planNextRound(reconciled, opts) {
  const held = Math.max(1, Number(opts && opts.target) || 1);
  if (!reconciled) return { done: false, target: held, excludeCandidateIds: [], reason: "no-claims-yet" };
  const excludeCandidateIds = reconciled.composite ? [] : (reconciled.claimedCandidateIds || []).slice();
  if (reconciled.complete) {
    return { done: true, target: held, excludeCandidateIds, reason: reconciled.completionReason || "complete" };
  }
  const wanted = (reconciled.claimedLoops || 0) + atomicLoopCount(reconciled.unclaimedCandidates || 0) + 1;
  return {
    done: false,
    target: Math.max(held, wanted),
    excludeCandidateIds,
    reason: reconciled.completionReason || "incomplete"
  };
}

/* WHAT EACH CARD ACTUALLY TOOK, AND WHAT BECAME OF IT.
 *
 * The first Howeston rescan under the new architecture recorded three claims,
 * nothing rejected, and two published loops - and that was not enough to say
 * what went wrong. "Three claims became two loops" does not tell you WHICH two
 * collapsed, or whether the nine that vanished was swallowed by an aggregator's
 * claim or never matched its own ground in the first place. Those two have
 * opposite fixes, so counts alone send the next change out on a guess.
 *
 * So this records the GROUND: the candidate ids each claim took, how much every
 * pair of claims shares, and what reconciliation then did with each one. It is
 * the difference between reading a job row and re-deriving the algorithm from
 * its output.
 *
 * Pure, and read-only over the claims - it decides nothing. */
export function describeClaimGround(claims, reconciled) {
  const list = (claims || []);
  const loops = ((reconciled && reconciled.loops) || []);

  const idsOf = claim => claimIds(claim);
  const overlapOf = (a, b) => claimOverlap(a, b);

  /* Which loop, if any, this claim's ground ended up inside. A claim that is
     not the loop's own card but shares its ground was merged during
     deduplication - or dropped as contained before that, which looks the same
     from here and is separated by the overlap figures below. */
  const fateOf = claim => {
    const own = loops.find(loop => loop.cardName && loop.cardName === claim.cardName
      && overlapOf(loop, claim) >= MIN_SHARED_CANDIDATES);
    if (own) return { fate: "published-as-own-loop", into: own.cardName || null };
    const host = loops.find(loop => overlapOf(loop, claim) >= MIN_SHARED_CANDIDATES);
    if (host) {
      return {
        fate: "absorbed",
        into: host.cardName || host.fromCard || "(unnamed loop)",
        sharedWithHost: overlapOf(host, claim)
      };
    }
    return { fate: "no-ground-published", into: null };
  };

  const overlaps = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const shared = overlapOf(list[i], list[j]);
      if (!shared) continue;
      overlaps.push({
        a: list[i].cardName || "(unnamed)",
        b: list[j].cardName || "(unnamed)",
        shared,
        /* The two numbers that decide every structure verdict: what each side
           keeps that the other has never heard of. Contained is uniqueB 0;
           a play order is both sides >= MIN_SHARED_CANDIDATES. */
        aKeeps: holeCount(list[i]) - shared,
        bKeeps: holeCount(list[j]) - shared
      });
    }
  }

  return {
    claims: list.map(claim => Object.assign({
      card: claim.cardName || "(unnamed)",
      holes: holeCount(claim),
      confidence: Number((claim.confidence || 0).toFixed(3)),
      /* Capped: enough to see which ground was taken and to line two claims up
         against each other, without turning a job row into a candidate dump. */
      candidateIds: idsOf(claim).slice(0, 24)
    }, fateOf(claim))),
    overlaps,
    loops: loops.map(loop => ({
      name: loop.cardName || "(provisional)",
      holes: holeCount(loop),
      fromCard: loop.fromCard || null,
      alsoFromCards: loop.alsoFromCards || [],
      candidateIds: idsOf(loop).slice(0, 24)
    }))
  };
}

/* TWO CARDS FIGHTING OVER ONE NINE.
 *
 * Howeston's Howard and Westward cards both matched the SAME nine fairways -
 * seven of nine candidates identical, the hole order scrambled between them
 * (Westward's 1 was Howard's 9), at confidences of 0.867 and 0.868. Two cards
 * that describe different loops cannot both be right about the same ground, and
 * a tie that close is the resolver saying it cannot tell them apart rather than
 * that it found two answers.
 *
 * This is a THIRD relationship, and until it was named the reconciler had to
 * force it into one of the two it knew:
 *
 *   play order   shared >= 6, and EACH keeps >= 6 of its own    -> slice into nines
 *   duplicate    one wholly inside the other                    -> drop the smaller
 *   contested    shared >= 6, and NEITHER keeps 6 of its own    -> the match failed
 *
 * Reconciling contested claims as if both were valid is what published a nine
 * twice and left a third of the facility unclaimed. The answer is not to pick a
 * winner on a 0.001 confidence margin - it is to stop matching them over the
 * same open field. Let the stronger one take its ground, remove it, and make the
 * other find its own; if it cannot, it was never a separate loop. */
export function contestedClaims(claims) {
  const list = (claims || []);
  const pairs = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const shared = claimOverlap(list[i], list[j]);
      if (shared < MIN_SHARED_CANDIDATES) continue;
      const aKeeps = holeCount(list[i]) - shared;
      const bKeeps = holeCount(list[j]) - shared;
      /* Both sides failing to keep a loop's worth of their own ground. A play
         order keeps a nine on each side; a duplicate keeps nothing on one side
         and everything on the other, and is handled as containment. */
      if (aKeeps >= MIN_SHARED_CANDIDATES || bKeeps >= MIN_SHARED_CANDIDATES) continue;
      if (isContainedIn(list[i], list[j]) || isContainedIn(list[j], list[i])) continue;
      pairs.push({
        a: list[i].cardName || "(unnamed)",
        b: list[j].cardName || "(unnamed)",
        shared, aKeeps, bKeeps,
        /* How little separates them. A margin this small is the resolver
           reporting a coin toss, and it is worth having on the row. */
        confidenceMargin: Number(Math.abs((list[i].confidence || 0) - (list[j].confidence || 0)).toFixed(4))
      });
    }
  }
  return pairs;
}
