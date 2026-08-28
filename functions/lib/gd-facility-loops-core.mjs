/* Turning a pile of scorecard claims over one piece of ground into courses.
 *
 * THE NINE IS THE ATOM
 *
 * A 27-hole site is not one thing. It is at least three shapes, and the club's
 * own scorecards describe whichever one it sells:
 *
 *   18 proper + a par-3 nine    two real courses, different lengths, no shared
 *                               ground. Two cards, and they agree.
 *   three named nines           Red, White, Blue. Three cards, or one card the
 *                               club publishes as a combined 27.
 *   three nines, 3x18 orders    Red+White, White+Blue, Blue+Red. THREE 18-hole
 *                               cards over TWENTY-SEVEN holes of ground, each
 *                               sharing a nine with each of the others.
 *
 * The last one is why claiming ground exclusively, card by card, is not enough
 * on its own. Card 1 takes 18 candidates; card 2 needs nine of them back and
 * would find only nine free, look like a failure, and be dropped - leaving a
 * third of the facility unpublished and two of its three courses missing.
 *
 * What survives all three cases is the NINE. Every one of these facilities is
 * built from nine-hole loops; the cards differ only in how many they staple
 * together. So courses are published as nines - named where a card names them,
 * "Course 1/2/3" where nothing does - all sharing one facility_key.
 *
 * The 18-hole combinations are NOT stored. When a facility publishes as three
 * nines, the player is asked at round start which two they are playing and taps
 * them; that is their eighteen for the day, in the order they tapped. Free
 * choice beats a stored list, because clubs rotate their pairings and a player
 * who wants White then Red is not served by a "Red + White" someone printed.
 *
 * WHY OVERLAP, AND NOT A RULE ABOUT 18s
 *
 * Nothing about an 18-hole card says whether it is a course or a composite.
 * The 18 at an 18-plus-par-3 facility is a real, whole course and must publish
 * as one; the 18 at a three-nines facility is two thirds of a play order. The
 * only thing that tells them apart is whether another card wants the same
 * ground: a real 18 shares nothing with its neighbour, a composite shares
 * exactly a nine with each of the others.
 *
 * So this does not guess from hole counts. It matches every card over the whole
 * site, looks at what overlaps what, and lets the facility say which shape it
 * is. Absent any overlap, the cards are the courses and nothing is sliced.
 *
 * Pure - claims in, loops out, no network and no database. The mapper worker
 * owns the fetching and the retrying; this owns the arithmetic. */

/* Ground shared between two claims before they are talking about the same
   loop. Six, for the same reason the scorecard matcher uses six: below that a
   coincidence of a few holes is indistinguishable from a real overlap. */
export const MIN_SHARED_CANDIDATES = 6;

/* The atomic loop. Not configurable, because it is not a tuning knob - golf
   facilities are built in nines, and a facility that is not would break every
   other assumption in the pipeline long before this one. */
export const HOLES_PER_LOOP = 9;

/* How many nine-hole loops the ground holds. Rounded, because a candidate or
   two either way is a practice green caught in the sweep or a hole the
   resolver could not build a centre-line for, not a fraction of a loop. */
export function atomicLoopCount(candidateCount) {
  const count = Math.max(0, Number(candidateCount) || 0);
  return count < HOLES_PER_LOOP ? 0 : Math.max(1, Math.round(count / HOLES_PER_LOOP));
}

function candidateIds(claim) {
  return new Set(((claim && claim.holes) || [])
    .map(hole => hole && hole.candidateId)
    .filter(id => id != null)
    .map(String));
}

/* How much ground two claims have in common. */
export function claimOverlap(a, b) {
  const idsA = candidateIds(a);
  if (!idsA.size) return 0;
  let shared = 0;
  candidateIds(b).forEach(id => { if (idsA.has(id)) shared += 1; });
  return shared;
}

function holeCount(claim) {
  return ((claim && claim.holes) || []).length;
}

/* Is `small` just part of `big`?
 *
 * A 9-hole card for the front nine of an 18 is CONTAINED in the 18's card:
 * every hole it names is already in the other. That is not two courses, it is
 * one course described twice at different lengths - an aggregator listing the
 * front nine separately, or a wrong card that happens to fit half the ground.
 *
 * This distinction is load-bearing. Without it a plain 18-hole course that
 * turned up a stray 9-hole card was read as a composite facility, sliced down
 * the middle, and published as two nine-hole courses. Containment is the
 * signature of a duplicate; PARTIAL overlap is the signature of a play order. */
export function isContainedIn(small, big) {
  const smallCount = holeCount(small);
  const bigCount = holeCount(big);
  if (!smallCount || bigCount <= smallCount) return false;
  /* Nine tenths rather than all of it: a card can carry one hole the other
     resolved differently without becoming a separate course. */
  return claimOverlap(small, big) >= smallCount * 0.9;
}

/* Drop every claim that is wholly inside a bigger one, largest first. */
export function dropContainedClaims(claims) {
  const list = (claims || []).slice().sort((a, b) => holeCount(b) - holeCount(a));
  return list.filter((claim, index) => !list.some((other, otherIndex) =>
    otherIndex < index && isContainedIn(claim, other)));
}

/* Does any pair of claims share ground while EACH keeps ground of its own?
 *
 * That mutual-partial-overlap shape is what a play-order facility looks like
 * and nothing else does. Red+White and White+Blue share the nine called White,
 * and each still owns a nine the other has never heard of. Compare:
 *
 *   18 + par-3 nine     overlap 0            -> two separate courses
 *   18 + its front 9    overlap 9, but the   -> one course, described twice
 *                       nine owns nothing
 *                       of its own
 *   Red+White,          overlap 9, and each  -> a composite facility
 *   White+Blue          owns 9 the other
 *                       does not
 *
 * Requiring uniqueness on BOTH sides is what separates the second row from the
 * third. Testing only the shared side cannot tell them apart, which is exactly
 * how an ordinary 18 came to be published as two nines. */
export function claimsOverlap(claims) {
  const list = claims || [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const shared = claimOverlap(list[i], list[j]);
      if (shared < MIN_SHARED_CANDIDATES) continue;
      const uniqueA = holeCount(list[i]) - shared;
      const uniqueB = holeCount(list[j]) - shared;
      if (uniqueA >= MIN_SHARED_CANDIDATES && uniqueB >= MIN_SHARED_CANDIDATES) return true;
    }
  }
  return false;
}

/* One claim cut into its nines, in the card's own hole order.
 *
 * Holes 1-9 of "Red + White" ARE Red, and 10-18 ARE White, because that is what
 * a combined card is: two nines printed end to end in the order they are
 * played. A claim that is not a whole number of nines is left alone - a 12-hole
 * read is a bad match or a genuinely odd course, and slicing it would invent
 * loops that do not exist. */
export function sliceClaimIntoLoops(claim) {
  const holes = ((claim && claim.holes) || []).slice().sort((a, b) => a.holeNumber - b.holeNumber);
  if (!holes.length || holes.length % HOLES_PER_LOOP !== 0) return [claim];
  /* A nine cut into nines is the same nine with its name thrown away. The
     slicer blanks cardName because a combined card cannot name the loops it is
     made of - true of "Red + White", nonsense for a card that already IS Red. */
  if (holes.length === HOLES_PER_LOOP) return [claim];
  const segments = [];
  for (let start = 0; start < holes.length; start += HOLES_PER_LOOP) {
    const slice = holes.slice(start, start + HOLES_PER_LOOP);
    segments.push({
      /* Renumbered 1-9: this is a nine-hole course now, and the ninth hole of
         White is its hole 9, not the card's hole 18. */
      holes: slice.map((hole, index) => Object.assign({}, hole, { holeNumber: index + 1, cardHoleNumber: hole.holeNumber })),
      /* A composite card cannot name the nines it is made of - "Red + White"
         names neither - so a sliced loop publishes provisionally and is
         labelled later by course-scorecard-update. */
      cardName: "",
      fromCard: (claim && claim.cardName) || "",
      segmentIndex: segments.length,
      confidence: claim && claim.confidence
    });
  }
  return segments;
}

/* Distinct loops out of a set of possibly-overlapping segments, best evidence
   first. A segment that shares its ground with a loop already kept is the same
   loop reached from another card - White arriving a second time via
   White+Blue - and it is recorded against that loop rather than published
   twice. */
export function dedupeLoops(segments) {
  const kept = [];
  (segments || []).forEach(segment => {
    const match = kept.find(loop => claimOverlap(loop, segment) >= MIN_SHARED_CANDIDATES);
    if (match) {
      if (segment.fromCard && !match.alsoFromCards.includes(segment.fromCard)) match.alsoFromCards.push(segment.fromCard);
      return;
    }
    kept.push(Object.assign({}, segment, { alsoFromCards: segment.fromCard ? [segment.fromCard] : [] }));
  });
  return kept;
}

/* WHY THE CLUB'S OWN COMBINATIONS ARE NOT RECORDED
 *
 * An earlier version of this file returned the 18-hole cards as "play orders" -
 * Red+White, White+Blue - so the app could offer them by name, and the worker
 * wrote them to a facility_play_orders column.
 *
 * That was solving a problem the player already solves. A 27-hole facility
 * publishes as three nines sharing a facility_key; at round start the player is
 * asked which two they are playing and taps them. They are free to pick any
 * pair, in either order, which is what actually happens on the day - clubs
 * rotate their pairings, and a player who wants White then Red is not served by
 * a stored list that only knows Red then White.
 *
 * So the combinations are not data. Three sibling nines are the data, and the
 * pairing is a question asked once per round. Everything needed to ask it is
 * already on the row: the facility_key, and the siblings that share it.
 *
 * What this file still owes the caller is the SLICING - turning a combined
 * 18-hole card into the two nines it was printed from - because that is how the
 * three nines get identified in the first place. That stays. */

/* The structure verdict this file changes behaviour for. Compared as a plain
   string so gd-facility-structure-core.mjs can own the vocabulary without this
   file importing it - the dependency runs the other way. */
const MULTI_NINE = "multi-nine";

/* claims: [{ cardName, holes: [{holeNumber, candidateId}], confidence, guides }]
 * opts:   { candidateCount, structure }
 *
 * `structure` is the facility verdict from gd-facility-structure-core.mjs, and
 * it changes two things and nothing else:
 *
 *   containment   With no structure, a nine inside an eighteen is one course
 *                 described twice and the nine is dropped. At a facility ALREADY
 *                 known to be built from nines that same nine is the NAME of
 *                 half the eighteen, and dropping it is how Howeston published a
 *                 generic 18-hole aggregator card over two real loops while the
 *                 named nine that could have identified one of them was
 *                 discarded as a duplicate.
 *   completion    Leftover ground is not the only way to be unfinished. Three
 *                 nines of ground with two loops resolved leaves eight
 *                 candidates spare - under the noise floor, and it read as done.
 *
 * Passing no structure leaves every existing path exactly as it was.
 *
 * Returns { loops, composite, structure, expectedLoops, claimedLoops,
 * claimedCandidateIds, unclaimedCandidates, complete, completionReason }.
 * `complete` is the signal the worker's resolution loop reads: false means the
 * facility is not accounted for and there is more to do. */
export function reconcileFacilityClaims(claims, opts) {
  const sized = (claims || []).filter(claim => ((claim.holes || []).length) >= MIN_SHARED_CANDIDATES);
  const candidateCount = Math.max(0, Number(opts && opts.candidateCount) || 0);
  const structure = (opts && opts.structure) || null;
  const multiNine = structure === MULTI_NINE;
  const expectedLoops = atomicLoopCount(candidateCount);

  /* Duplicates out FIRST, before anything looks at overlap.
   *
   * A card wholly inside another is one course described twice, and leaving it
   * in makes an ordinary 18 that also turned up a front-nine card look like a
   * facility whose cards share ground - which got it sliced into two nines.
   *
   * Not at a multi-nine facility, where containment means the opposite. Both
   * claims are kept, both are sliced, and dedupeLoops merges them over the same
   * ground into one loop carrying the smaller card's name. */
  const list = multiNine ? sized : dropContainedClaims(sized);

  /* Best evidence first, so the strongest card gets its ground and a weaker
     rival is the one recorded as a duplicate. Longer claims lead: an 18 that
     matched cleanly says more about the site than a nine that matched cleanly. */
  const ordered = list.slice().sort((a, b) =>
    ((b.holes || []).length - (a.holes || []).length) || ((b.confidence || 0) - (a.confidence || 0)));

  const composite = claimsOverlap(ordered);
  /* Slice when the cards have shown themselves to be play orders, or when the
     facility is already known to be built from nines - at which point an
     18-hole card is two of them however little it overlaps anything else.
     Otherwise an 18 with nothing overlapping it is a whole course and must
     publish as one. */
  const segments = (composite || multiNine) ? ordered.flatMap(sliceClaimIntoLoops) : ordered.map(claim =>
    Object.assign({}, claim, { fromCard: claim.cardName || "" }));
  /* Named segments lead into deduplication, so a loop with a card of its own is
     kept under that name rather than as the anonymous half of a combined card
     that happened to reach the same ground first. Stable, so everything else
     holds the strength order above. */
  const forDedupe = multiNine
    ? segments.slice().sort((a, b) => (b.cardName ? 1 : 0) - (a.cardName ? 1 : 0))
    : segments;
  const loops = dedupeLoops(forDedupe);

  const claimedIds = new Set();
  loops.forEach(loop => candidateIds(loop).forEach(id => claimedIds.add(id)));
  const unclaimedCandidates = Math.max(0, candidateCount - claimedIds.size);

  /* Done when there is not another loop's worth of ground left unspoken for.
     Judged on GROUND, not on loop count: a facility whose cards were all found
     still has a few candidates left over (a practice hole, a green the resolver
     rejected), and chasing those forever is what the hard stop in the worker
     exists to prevent.
     At a multi-nine facility that tolerance is not enough on its own - the
     expected loops have to have actually been resolved. */
  const groundQuiet = unclaimedCandidates < HOLES_PER_LOOP;
  const loopsFound = !multiNine || loops.length >= expectedLoops;
  const complete = groundQuiet && loopsFound;

  return {
    loops,
    composite,
    structure,
    expectedLoops,
    claimedLoops: loops.length,
    /* The ground already spoken for, so the caller can take it off the table
       before asking the resolver anything else - see the worker's rounds. */
    claimedCandidateIds: [...claimedIds],
    unclaimedCandidates,
    complete,
    completionReason: complete
      ? (multiNine ? "resolved-" + loops.length + "-of-" + expectedLoops + "-loops" : "ground-accounted-for")
      : (!groundQuiet
        ? unclaimedCandidates + "-candidates-unclaimed"
        : "resolved-" + loops.length + "-of-" + expectedLoops + "-expected-loops")
  };
}
