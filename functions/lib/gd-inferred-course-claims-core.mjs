/* WHEN THE MAPPER ITSELF IS DECIDING HOW MANY COURSES ARE HERE.
 *
 * The fallback path, and the only one this file may run on. Nothing named the
 * courses - no separate listings, no OSM course polygons, no cards that tell
 * them apart - so the mapper is partitioning physical ground into courses on
 * its own evidence. See gd-course-listing-core.mjs for the mode that decides
 * which path a run is on.
 *
 * THAT MAKES DUPLICATE GROUND MEAN THE OPPOSITE OF WHAT IT MEANS ELSEWHERE.
 *
 * A listing-backed course record may share every hole with another listing's,
 * and that is fine: two legitimate external listings can describe the same
 * playable course, and the listing - not the geometry - is the identity. There
 * is no global rule in this codebase that a green belongs to one course, and
 * this file must never become one.
 *
 * But when the mapper is asking "which of these 36 holes are Course A and which
 * are Course B", unique allocation is not a tidiness preference - it is the
 * evidence. Course B is a separate course BECAUSE it is played over ground
 * Course A does not use. A candidate assembled mostly from holes a stronger
 * candidate already claimed has not found a second course; it has found the
 * first one again, walked in a different order.
 *
 * So allocation here behaves like elimination:
 *
 *     identify the strongest course       claim its physical holes
 *     -> what remains unclaimed           is what another course can be made of
 *     -> a candidate with little of its own                  is not a course
 *
 * rather than letting every plausible 1..18 route publish over whatever ground
 * it likes.
 *
 * AND THE FRAGMENTS.
 *
 * Separation does not always come out clean. A run can produce something like
 *
 *     candidate: holes 1, 2, 18
 *
 * which is three holes of somebody else's course wearing a course's shape.
 * Published, it becomes a sibling in the picker that a player can select and
 * cannot play. It is not a course; it is ground this run could not explain, and
 * saying so is both truer and cheaper to recover from - the facility keeps the
 * courses that DID resolve, and the leftovers are recorded as outstanding
 * rather than shipped.
 *
 * Note what is NOT a fragment. Te Arai's North came out of separation with 16
 * of its 18 holes: that is a clipped scan of a real course, it covers almost
 * the whole numbering, and withholding it would cost a player a course over two
 * missing holes. The rule has to separate "most of a course" from "a few holes
 * of one", which is why it reads the DENSITY of the numbering rather than
 * demanding a perfect 1..n.
 *
 * Pure - candidates in, an allocation and a verdict out. No network, no
 * database, and no opinion about listing-backed courses. */

/* A course the mapper inferred needs at least a nine of its own. Golf
   facilities are built in nines - the same atom gd-facility-loops-core.mjs is
   built on - and anything smaller has no shape that could be played. */
export const MIN_INFERRED_COURSE_HOLES = 9;

/* How much of its own numbering a candidate must actually hold. 1,2,18 covers
   three eighteenths of the run it claims; a 16-of-18 clipped scan covers nearly
   all of it. Six tenths sits well clear of both, and deliberately nearer the
   fragment: a candidate missing 40% of its holes is already being published
   with a warning and a refused visual chain. */
export const MIN_HOLE_NUMBER_DENSITY = 0.6;

/* Above this share of borrowed ground a candidate is the stronger course seen
   again, not a second one. Half, because a genuine sibling that shares a nine
   with another is the composite-facility shape - which the card-led reconciler
   owns (gd-facility-loops-core.mjs) and which never reaches this file - while
   anything past half is a route drawn over somebody else's holes. */
export const MAX_REUSED_GROUND_SHARE = 0.5;

/* A candidate's ground, as PAIRS.
 *
 * The number and the physical hole have to travel together or the elimination
 * cannot say which numbers a candidate keeps after it loses ground: two
 * parallel arrays drift the moment either is deduped, and a wrong pairing here
 * would withhold real courses. So a candidate is
 *
 *     { index, name, contiguous, holes: [{ number, id }] }
 *
 * and everything below reads that one list. `id` is PHYSICAL - an OSM element
 * ref on the numbered path, a resolver candidate id on the card-led one -
 * because both courses on a site carry the numbers 1..18 and the number alone
 * identifies nothing. */
function pairsOf(candidate) {
  const seen = new Set();
  return ((candidate && candidate.holes) || []).map(hole => ({
    number: Number(hole && hole.number),
    id: String((hole && hole.id) == null ? "" : hole.id)
  })).filter(pair => {
    if (!pair.id || !Number.isFinite(pair.number)) return false;
    if (seen.has(pair.id)) return false;
    seen.add(pair.id);
    return true;
  });
}

function numbersOf(candidate) {
  return [...new Set(pairsOf(candidate).map(pair => pair.number))].sort((a, b) => a - b);
}

/* How much of the run 1..max this candidate actually holds. A course numbered
   1..18 with two missing scores 0.89; 1,2,18 scores 0.17. */
export function holeNumberDensity(numbers) {
  const list = [...new Set((numbers || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!list.length) return 0;
  return list.length / Math.max(list[list.length - 1], list.length);
}

/* Strength, decided before anything is allocated - so the order cannot depend
   on the allocation it is about to drive.
 *
 * Contiguity leads because a 1..n with nothing missing is the one shape that
 * cannot be a coincidence of another course's holes. Then size, then density,
 * then the separation's own order, which already put the pinned loop first. */
export function claimStrength(candidate) {
  const numbers = numbersOf(candidate);
  return {
    contiguous: !!candidate.contiguous,
    holes: numbers.length,
    density: holeNumberDensity(numbers)
  };
}

function byStrength(a, b) {
  const sa = claimStrength(a), sb = claimStrength(b);
  if (sa.contiguous !== sb.contiguous) return sa.contiguous ? -1 : 1;
  if (sa.holes !== sb.holes) return sb.holes - sa.holes;
  if (sa.density !== sb.density) return sb.density - sa.density;
  return (a.index ?? 0) - (b.index ?? 0);
}

/* THE PHYSICAL HOLE CLAIM.
 *
 * Every physical hole belongs to at most one inferred course. Strongest first,
 * each candidate claims the holes nobody has claimed yet; what it wanted and
 * could not have is recorded rather than silently dropped, because "this
 * candidate is 80% somebody else's course" is the finding, not a detail.
 *
 * See pairsOf for the candidate shape. */
export function allocatePhysicalHoles(candidates) {
  const claimed = new Set();
  return (candidates || []).slice().sort(byStrength).map(candidate => {
    const pairs = pairsOf(candidate);
    const own = [], reused = [];
    pairs.forEach(pair => {
      if (claimed.has(pair.id)) { reused.push(pair); return; }
      claimed.add(pair.id);
      own.push(pair);
    });
    return Object.assign({}, candidate, {
      ownHoleIds: own.map(pair => pair.id),
      reusedHoleIds: reused.map(pair => pair.id),
      /* Which of its hole NUMBERS survive on ground of its own - the set the
         verdict is actually judged on, which is the whole point of eliminating
         in strength order rather than scoring everyone against the open field. */
      ownHoleNumbers: [...new Set(own.map(pair => pair.number))].sort((a, b) => a - b),
      reusedShare: pairs.length ? reused.length / pairs.length : 0
    });
  });
}

/* Is this allocated candidate a course, or ground we could not explain?
 *
 * Every reason is stated rather than folded into a score, because "withheld"
 * and "withheld because it was 82% of the course next to it" want different
 * responses next time - the first reads as a mapper failure, the second as the
 * separation working. */
export function inferredCourseVerdict(allocated) {
  const own = ((allocated && allocated.ownHoleIds) || []).length;
  const numbers = ((allocated && allocated.ownHoleNumbers) || []);
  const density = holeNumberDensity(numbers);
  const reusedShare = Number(allocated && allocated.reusedShare) || 0;

  if (reusedShare > MAX_REUSED_GROUND_SHARE) {
    return { publishable: false, reason: "mostly-ground-another-course-already-claimed", ownHoles: own, density, reusedShare };
  }
  if (own < MIN_INFERRED_COURSE_HOLES) {
    return { publishable: false, reason: "fewer-than-" + MIN_INFERRED_COURSE_HOLES + "-holes-of-its-own", ownHoles: own, density, reusedShare };
  }
  if (density < MIN_HOLE_NUMBER_DENSITY) {
    return { publishable: false, reason: "hole-numbers-too-scattered-to-be-a-course", ownHoles: own, density, reusedShare };
  }
  return { publishable: true, reason: null, ownHoles: own, density, reusedShare };
}

/* The pass the geometry-led path runs before it publishes anything.
 *
 * Returns the courses that survived, the candidates that did not and why, and a
 * ledger of who claimed which ground - so a job row can be read back without
 * re-deriving the allocation from its output. The caller decides what to do
 * with a facility left holding one course or none; withheld ground is
 * OUTSTANDING, not discarded, and saying so is this function's other job. */
export function eliminateInferredCourses(candidates) {
  const allocated = allocatePhysicalHoles(candidates);
  const courses = [], withheld = [];
  allocated.forEach(entry => {
    const verdict = inferredCourseVerdict(entry);
    const row = Object.assign({}, entry, { verdict });
    (verdict.publishable ? courses : withheld).push(row);
  });
  /* Back into the order the caller handed them in - the separation already put
     the pinned loop first, and the elimination order is an internal detail. */
  courses.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return {
    courses,
    withheld,
    ledger: {
      candidates: allocated.length,
      published: courses.length,
      withheldCourses: withheld.map(entry => ({
        name: entry.name || null,
        holes: ((entry.holes) || []).length,
        ownHoles: entry.ownHoleIds.length,
        reusedHoles: entry.reusedHoleIds.length,
        reason: entry.verdict.reason
      })),
      /* Holes no surviving course speaks for. The honest name for a fragment's
         ground once it stops pretending to be a course. */
      unexplainedHoles: withheld.reduce((sum, entry) => sum + entry.ownHoleIds.length, 0),
      reusedHoles: allocated.reduce((sum, entry) => sum + entry.reusedHoleIds.length, 0)
    }
  };
}
