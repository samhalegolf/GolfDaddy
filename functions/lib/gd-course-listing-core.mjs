/* WHO SAYS THIS SITE HOLDS MORE THAN ONE COURSE - the search, or us?
 *
 * Two questions that look identical from inside the mapper and are not:
 *
 *   "Millbrook - Remarkables 18" was selected, and the sweep around it also
 *   caught Coronet and Arrow.
 *
 *   "Millbrook Resort" was selected, and the sweep caught three courses.
 *
 * The first is not a multi-course problem at all. A real listing was picked,
 * that listing names a course, and the only question worth asking is whether we
 * can map it. The second is - but even there the courses have names already,
 * because the same search source that returned the resort returns the three
 * courses on it (functions/lib/gd-courses-near-core.mjs queries the very tags
 * this file reads back out of the mapper's own payload). Inventing "Course 1 /
 * Course 2 / Course 3" over ground that external listings have already named is
 * the mapper answering a question that was never asked of it.
 *
 * So there are THREE resolution modes, and they exist to be told apart:
 *
 *   single-listing              one listing was selected and one course is
 *                               being mapped. Other courses on the ground are
 *                               somebody else's listing, not this run's problem.
 *   listing-led-multi-course    a facility was selected, and credible
 *                               individual course listings sit on its ground.
 *                               THEY are the children; their identity comes from
 *                               the listing, not from our separation.
 *   geometry-led-multi-course   a facility was selected and nothing named the
 *                               courses. Only now does the mapper infer them.
 *
 * WHY THE DISTINCTION IS NOT COSMETIC
 *
 * The two multi-course modes want OPPOSITE things from duplicated ground.
 *
 * A listing-backed course may legitimately share, or wholly duplicate, another
 * listing's geometry - two search providers describing the same playable course,
 * a resort listing and a course listing that resolve to the same eighteen. The
 * listing supplies the identity; mapping the same ground twice is cheap and
 * routing a player to the wrong course record is not. Nothing here may impose a
 * "one green, one course" rule, and gd-inferred-course-claims-core.mjs - which
 * DOES impose one - is deliberately never consulted on this path.
 *
 * A geometry-inferred sibling is the reverse: unique hole allocation is part of
 * the evidence that it is a separate course at all, so reuse counts against it.
 * That belongs in the other file, and the mode is what decides which one runs.
 *
 * Pure - names and separated loops in, a verdict out. No network, no database. */

import { splitCourseName } from "./gd-automapper-core.mjs";

export const RESOLUTION_MODE = {
  SINGLE_LISTING: "single-listing",
  LISTING_LED: "listing-led-multi-course",
  GEOMETRY_LED: "geometry-led-multi-course"
};

/* Ground a named polygon must hold before it counts as a course listing rather
   than a stray outline. Same floor the scorecard matcher and the facility
   reconciler use: below six holes a shape is noise, not a course. */
export const MIN_LISTING_HOLES = 6;

/* Two, because one listing on a multi-course site has not separated anything -
   the rest of the ground would still need inferring, which is the fallback. */
export const MIN_LISTING_LED_COURSES = 2;

function normalise(value) {
  return String(value == null ? "" : value)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokensOf(value) {
  return normalise(value).split(" ").filter(Boolean);
}

/* Words that make a trailing fragment a COURSE label rather than the rest of a
 * place name.
 *
 * Deliberately a short, concrete list rather than "anything after a dash".
 * "Wairakei - Taupo" is one course's name and splitting it would suppress a
 * facility's real siblings; "Millbrook - Remarkables 18" is a course listing and
 * failing to see it is how a run that was handed the right answer went looking
 * for a different one. A hole count, a course word, a colour or a compass point
 * is what actually separates the two, and every one of them is something a club
 * puts on a course and never on a town. */
const LABEL_WORDS = /^(course|links|nine|loop|championship|old|new|red|white|blue|green|black|gold|yellow|silver|copper|orange|purple|north|south|east|west|northeast|northwest|southeast|southwest)$/;
const HOLE_COUNT = /^(9|18|27|36|45|54)$/;
/* Two words that only mean anything together. "Par" on its own is a street
   name; "Par 3" is a course. */
const LABEL_PHRASES = /^(par (3|three|60|62|64))$/;

/* Does this fragment name a course? */
export function looksLikeCourseLabel(value) {
  const phrase = normalise(value);
  if (!phrase) return false;
  if (LABEL_PHRASES.test(phrase)) return true;
  return phrase.split(" ").some(word => LABEL_WORDS.test(word) || HOLE_COUNT.test(word));
}

/* The course label carried by a search result's name, or "" when the name is
 * just a place.
 *
 * splitCourseName is asked first because it already owns the club-designator
 * rules the duplicate guard depends on ("X Golf Club (Par 3)", "X Golf Club -
 * North"). What it deliberately will not do is split a name whose left half
 * carries no designator, because for ITS question - are these two rows the same
 * course? - a false split is expensive. Here a missed split is the expensive
 * one, so a plain separator is accepted too, and the label test above is what
 * keeps that from swallowing ordinary place names. */
export function courseLabelOf(courseName) {
  const viaDesignator = splitCourseName(courseName).label;
  if (viaDesignator && looksLikeCourseLabel(viaDesignator)) return viaDesignator;
  const text = String(courseName || "").replace(/\s+/g, " ").trim();
  const paren = text.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (paren && paren[1].trim() && looksLikeCourseLabel(paren[2])) return paren[2].trim();
  const separated = text.match(/^(.*?)\s+[-–—:]\s+(.*)$/);
  if (separated && separated[1].trim() && looksLikeCourseLabel(separated[2])) return separated[2].trim();
  return "";
}

/* Does this search result name a course in its own right, or the place it sits
   on? Names are not identity anywhere else in this pipeline and they are not
   here either - this is one signal, and planListingResolution prefers the
   ground's own answer whenever the ground has one. */
export function listingKindOf(courseName) {
  return courseLabelOf(courseName) ? "individual-course" : "general-facility";
}

/* The individual course listings sitting on this ground.
 *
 * Not a new lookup: separateLoops already assigned every hole to the OSM course
 * polygon that contains it, and a polygon with a name IS the listing - the same
 * `golf=course` / `leisure=golf_course` name+centre pair /api/courses-near hands
 * the picker. So the search source has already named these courses and the
 * mapper is reading its answer back rather than asking again.
 *
 * A loop separated by ROUTING is not a listing. Routing is the mapper chaining
 * hole geometry into loops because nothing on the ground said which was which -
 * that is exactly the inference this whole file exists to hold back until it is
 * needed. */
export function listingsFromLoops(loops, opts) {
  const facility = normalise((opts && opts.facilityName) || "");
  const seen = new Set();
  return (loops || [])
    .map((loop, index) => ({ loop, index }))
    .filter(entry => entry.loop && entry.loop.method === "containment")
    .filter(entry => String(entry.loop.name || "").trim())
    .filter(entry => ((entry.loop.holeNumbers || []).length) >= MIN_LISTING_HOLES)
    /* A polygon named for the whole site tells its courses apart no better than
       a number does. It is the parent, not one of the children. */
    .filter(entry => normalise(entry.loop.name) !== facility)
    .filter(entry => {
      const key = normalise(entry.loop.name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(entry => ({
      name: String(entry.loop.name).trim(),
      osmRef: entry.loop.osmRef || null,
      holes: (entry.loop.holeNumbers || []).length,
      loopIndex: entry.index
    }));
}

/* The words that tell these listings apart.
 *
 * Every course at Millbrook is called Millbrook something, so "millbrook" in a
 * search result says nothing about WHICH course was picked. "remarkables" does.
 * Taking the tokens that are not common to all of them is what turns a name
 * comparison into a discriminating one, and it needs no word list - the
 * facility's own listings say which of their words are shared. */
export function distinguishingTokens(listings) {
  const lists = (listings || []).map(listing => new Set(tokensOf(listing.name)));
  if (!lists.length) return new Set();
  const all = new Set();
  lists.forEach(set => set.forEach(token => all.add(token)));
  const common = [...all].filter(token => lists.every(set => set.has(token)));
  common.forEach(token => all.delete(token));
  return all;
}

/* Which listing, if any, this scan was started from.
 *
 * Answered on the distinguishing words alone. A selection that carries none of
 * them named the facility however specific it looks, and one that carries two
 * listings' worth is ambiguous and must not pick a winner - both of those are
 * "no match", and the caller falls through to the multi-course branches, which
 * is the safe direction: publishing a facility's courses when one was wanted is
 * recoverable, mapping the wrong course under the player's chosen name is not. */
export function matchSelectionToListing(courseName, listings) {
  const list = listings || [];
  if (!list.length) return null;
  const selected = new Set(tokensOf(courseName));
  if (!selected.size) return null;

  const exact = list.find(listing => normalise(listing.name) === normalise(courseName));
  if (exact) return Object.assign({}, exact, { matchedOn: "exact-name", matchedTokens: [] });

  const distinguishing = distinguishingTokens(list);
  const scored = list.map(listing => {
    const matched = tokensOf(listing.name).filter(token => distinguishing.has(token) && selected.has(token));
    return { listing, matched };
  }).filter(entry => entry.matched.length);

  if (scored.length !== 1) return null;
  return Object.assign({}, scored[0].listing, {
    matchedOn: "distinguishing-words",
    matchedTokens: scored[0].matched
  });
}

/* THE ROUTER.
 *
 * loops are what separateLoops produced (null when the site did not separate),
 * courseName is the search result the player actually selected.
 *
 * Order is the argument. A selection that resolves to one real listing settles
 * the question before any facility reasoning starts, because the listing is a
 * stronger identity anchor than any partition we could compute. Only when the
 * selection names the place do the listings on that place become its children.
 * Only when nothing named them does the mapper infer them.
 *
 * `scopedLoopIndex` is the whole payload of a single-listing verdict: the loop
 * this run should map, with the rest of the site's ground left to the listings
 * that own it. */
export function planListingResolution(input) {
  const courseName = (input && input.courseName) || "";
  const loops = (input && input.loops) || null;
  const listings = listingsFromLoops(loops, { facilityName: courseName });
  const kind = listingKindOf(courseName);
  const base = { listings, listingKind: kind, parentListing: null, childListings: [], selectedListing: null, scopedLoopIndex: null };

  const selected = matchSelectionToListing(courseName, listings);
  if (selected) {
    return Object.assign({}, base, {
      mode: RESOLUTION_MODE.SINGLE_LISTING,
      reason: "selection-matches-an-individual-course-listing",
      selectedListing: selected,
      scopedLoopIndex: selected.loopIndex
    });
  }

  if (listings.length >= MIN_LISTING_LED_COURSES) {
    return Object.assign({}, base, {
      mode: RESOLUTION_MODE.LISTING_LED,
      reason: "credible-individual-course-listings-on-this-ground",
      parentListing: courseName || null,
      childListings: listings
    });
  }

  /* A name that says "course" over ground nothing has named.
   *
   * The listings could not answer, but the player still picked a course rather
   * than a place, and manufacturing siblings under that name is the one thing
   * this must not do: "Millbrook - Remarkables 18" becoming Course 1, Course 2
   * and a three-hole Course 3 is worse than mapping the ground the pin sits on
   * and saying nothing about the rest. The pinned loop is that ground -
   * separateLoops sorts by distance from the pin, and the pin came from the
   * listing the player chose. */
  if (kind === "individual-course" && loops && loops.length > 1) {
    return Object.assign({}, base, {
      mode: RESOLUTION_MODE.SINGLE_LISTING,
      reason: "selection-names-a-course-and-nothing-on-the-ground-separates-it",
      selectedListing: { name: courseName, osmRef: null, holes: (loops[0].holeNumbers || []).length, loopIndex: 0, matchedOn: "pinned-loop" },
      scopedLoopIndex: 0
    });
  }

  return Object.assign({}, base, {
    mode: RESOLUTION_MODE.GEOMETRY_LED,
    reason: listings.length
      ? "only-" + listings.length + "-individual-course-listing-on-this-ground"
      : "no-credible-individual-course-listings"
  });
}
