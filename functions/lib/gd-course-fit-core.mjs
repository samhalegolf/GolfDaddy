/* Does the geometry we just mapped actually fit the place the player asked for?
 *
 * The pin screen used to run on EVERY new course: gdCoursePickerNeedsCoursePin
 * returned true unless something proved otherwise, so the first thing a player
 * met after searching a course was a map to drag. That is backwards. The search
 * result already carries a coordinate, from Nominatim or from course_maps, and
 * it is right nearly every time.
 *
 * So: trust the search pin, map from it, and only ask the player to place one
 * when the result is CLEARLY wrong. This module owns "clearly wrong", and it
 * deliberately answers with one boolean plus a reason rather than a set of
 * flags for the client to weigh - the caller has one decision to make.
 *
 * Four ways a pin proves itself wrong, all from facts the mapper already
 * computes:
 *
 *   multiple-courses    the same hole number turned up in two places far apart,
 *                       so the sweep covered more than one course and we cannot
 *                       tell which one was meant
 *   holes-not-contiguous  the holes do not run 1..n - we have a fragment of a
 *                       course rather than a course. Needs no outside evidence
 *                       at all, which is why it catches what the other three
 *                       miss; see the rule itself for the Te Arai case
 *   scorecard-mismatch  the club's own scorecard says 18 and we resolved 11
 *   holes-scattered     the holes span more ground than a golf course occupies,
 *                       so some of them belong to a neighbour
 *
 * Everything else - a course with no scorecard, a short course, a course that
 * resolved fewer holes than OSM hinted at - is NOT evidence the pin is wrong,
 * and must not cost the player a map-dragging step. Silence is trust. */

/* The longest real golf courses run about 3km end to end; a 27-hole site with
   three loops around a clubhouse is under 2km across. 6km is deliberately far
   past anything legitimate, because the cost of asking is a step in front of
   every player and the cost of not asking is a course that plays slightly odd
   until someone re-pins it. Only fires when the sweep has plainly eaten a
   neighbouring club - which happens when that neighbour is not in course_maps,
   so guideBelongsToCourse has no sibling centre to partition it away with. */
export const COURSE_FIT_MAX_SPAN_M = 6000;

/* Matches the automapper's own loop-separation threshold. Below this, two
   features with one hole number are OSM tagging the same hole twice. */
export const COURSE_FIT_LOOP_SEPARATION_M = 250;

/* Standard complete hole counts. A course is 9, 18, 27 or 36 holes; nothing else
   is a finished round of golf. Real short courses exist - Balgove is 9, Boulcott's
   Summerset Six is 6 - but they are complete AT their own count, which is what a
   scorecard is for. Absent a card, a non-standard count is a scan that stopped
   early far more often than it is a genuinely odd course. */
export const STANDARD_HOLE_COUNTS = [9, 18, 27, 36];

/* Is this course complete enough to present as a finished map?
 *
 * Two ways to be complete, in order of authority:
 *
 *   the card    The club says 18 and we resolved 18. That is the answer, and it is
 *               the only one that can vouch for a course whose real count is odd -
 *               a 6-hole course with a 6-hole card is complete.
 *   the shape   No card, but the holes run 1..n and n is a standard count. Good
 *               enough: 18 contiguous holes is a golf course whatever the internet
 *               failed to tell us about it.
 *
 * Six holes with no card is neither, and that is the case this exists to refuse -
 * Te Arai Links published holes 9, 10, 12, 13, 16, 17 of a 36-hole site as a
 * finished course because nothing asked either question. */
export function courseCoverageComplete(facts) {
  const f = facts || {};
  const numbers = [...new Set((f.holeNumbers || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  const expected = Number(f.expectedHoles) || 0;
  if (!numbers.length) return { complete: false, reason: "no-holes", holes: 0 };

  const contiguous = numbers[0] === 1 && numbers[numbers.length - 1] === numbers.length;
  if (!contiguous) {
    return {
      complete: false,
      reason: "holes-not-contiguous",
      holes: numbers.length,
      highestHole: numbers[numbers.length - 1],
      missing: Array.from({ length: numbers[numbers.length - 1] }, (_, i) => i + 1).filter(n => !numbers.includes(n))
    };
  }
  if (expected > 0) {
    return numbers.length >= expected
      ? { complete: true, reason: null, holes: numbers.length, matchedCard: true }
      : { complete: false, reason: "short-of-card", holes: numbers.length, expectedHoles: expected };
  }
  return STANDARD_HOLE_COUNTS.includes(numbers.length)
    ? { complete: true, reason: null, holes: numbers.length, matchedCard: false }
    : { complete: false, reason: "non-standard-hole-count", holes: numbers.length };
}

export function boundsSpanM(bounds) {
  if (!bounds) return null;
  const north = Number(bounds.north), south = Number(bounds.south);
  const east = Number(bounds.east), west = Number(bounds.west);
  if (![north, south, east, west].every(Number.isFinite)) return null;
  const dy = (north - south) * 111320;
  const dx = (east - west) * 111320 * Math.cos(((north + south) / 2) * Math.PI / 180);
  return Math.round(Math.hypot(dx, dy));
}

/* facts: { collision, expectedHoles, holesResolved, courseBounds }
   collision is detectHoleNumberCollision()'s answer, or null when it did not run. */
export function courseFitVerdict(facts) {
  const f = facts || {};
  const collision = f.collision || null;
  const expected = Number(f.expectedHoles) || 0;
  const resolved = Number(f.holesResolved) || 0;
  const spanM = boundsSpanM(f.courseBounds);

  /* Order matters only for which reason gets reported; any one of them is
     enough. Multi-loop leads because it is the one the player can actually fix
     by pinning - the other two might equally mean thin OSM data. */
  if (collision && collision.multiLoop && Number(collision.loops) > 1) {
    return untrusted("multiple-courses", "ground", {
      loops: Number(collision.loops) || null,
      widestSeparationM: Number(collision.widestSeparationM) || null
    });
  }
  /* Coverage, judged by the card when there is one and by the shape when there is
     not - see courseCoverageComplete. The cheapest check in this file and the only
     one needing no outside evidence at all, which is why it catches what the rules
     below miss: Te Arai had no scorecard, no OSM holes tag, and a 982m span against
     a 6000m ceiling, so every other rule passed six holes of a 36-hole site. */
  if (Array.isArray(f.holeNumbers) && f.holeNumbers.length) {
    const coverage = courseCoverageComplete({ holeNumbers: f.holeNumbers, expectedHoles: expected });
    if (!coverage.complete) {
      return untrusted(coverage.reason === "short-of-card" ? "scorecard-mismatch" : coverage.reason, "coverage",
        Object.assign({ holesResolved: coverage.holes }, coverage.missing ? { missing: coverage.missing, highestHole: coverage.highestHole } : {},
          coverage.expectedHoles ? { expectedHoles: coverage.expectedHoles } : {}));
    }
  }
  if (expected > 0 && resolved > 0 && resolved < expected) {
    return untrusted("scorecard-mismatch", "coverage", { expectedHoles: expected, holesResolved: resolved });
  }
  if (spanM !== null && spanM > COURSE_FIT_MAX_SPAN_M) {
    return untrusted("holes-scattered", "ground", { spanM, maxSpanM: COURSE_FIT_MAX_SPAN_M });
  }
  return { trusted: true, reason: null, scope: null, detail: {}, spanM };
}

/* scope separates the two things a bad verdict can mean, because they deserve
   different answers:
 *
 *   "ground"    we mapped somewhere else, or somewhere plus its neighbour. The
 *               map is wrong, not thin. Worth stopping for.
 *   "coverage"  right ground, fewer holes than the scorecard claims. Often the
 *               scorecard - a scraped 18 against a real 9, or an OSM holes tag
 *               nobody updated. A playable map like this must still play, or a
 *               bad scrape locks a course out of the app permanently.
 */
function untrusted(reason, scope, detail) {
  return { trusted: false, reason, scope, detail: detail || {} };
}

/* One short sentence for the pin screen. The player is being asked to do work,
   so they are owed the reason - "we could not tell which course" is actionable,
   "mapping was ambiguous" is not. */
export function courseFitMessage(verdict) {
  if (!verdict || verdict.trusted) return "";
  const d = verdict.detail || {};
  if (verdict.reason === "multiple-courses") {
    return "There " + (d.loops === 2 ? "are two courses" : "are " + (d.loops || "several") + " courses")
      + " here. Pin the one you are playing.";
  }
  if (verdict.reason === "scorecard-mismatch") {
    return "Found " + d.holesResolved + " holes but the scorecard says " + d.expectedHoles
      + ". Pin the course so we map the right ground.";
  }
  if (verdict.reason === "holes-not-contiguous") {
    return "Found " + d.holesResolved + " holes numbered up to " + d.highestHole
      + " - this course is not complete. Pin the one you are playing.";
  }
  if (verdict.reason === "non-standard-hole-count") {
    return "Found " + d.holesResolved + " holes, which is not a full course. Pin the one you are playing.";
  }
  if (verdict.reason === "holes-scattered") {
    return "The holes found are too spread out to be one course. Pin the one you are playing.";
  }
  return "Pin the course you are playing.";
}
