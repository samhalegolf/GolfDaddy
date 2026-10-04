/* Find a course's scorecard and put it in the shared store.
 *
 * The half of the Scorecard Engine that talks to the world. gd-scorecard-parse-core
 * decides what a table means; this decides which page to read and what to do with
 * the answer.
 *
 * WHY THIS EXISTS AT ALL
 *
 * course_scorecards has never had a row written to it. Every piece around it works
 * - scorecard-search finds URLs, scorecard-fetch proxies them past CORS,
 * scorecard-store caches and quality-gates writes, all tested - but the parser in
 * the middle was deleted with the old GPS play runtime on 2026-08-02 and nothing
 * replaced it. So fetchScorecardEvidence in the mapper worker reads an empty table
 * every time and expectedHoles is null for every course in the database.
 *
 * That null is not cosmetic. At Te Arai Links it disabled the wider-frame retry,
 * the geometry-resolver handoff AND the "published incomplete" warning - three
 * guards, one missing number - and six holes of a 36-hole site published as a
 * finished course with status "done".
 *
 * WHERE IT LOOKS, AND IN WHAT ORDER
 *
 * Candidates are ranked by identity and location first, with known scorecard
 * sources as a tie-breaker. A strong official-domain match is therefore inspected
 * early, but an aggregator that carries the exact club/course identity still wins
 * over weak or generic pages. Semantic structure, not the page title or literal
 * word "scorecard", decides whether the fetched document is useful. */

import { parseScorecardCardsHtml, courseFactsFromText, pageText } from "./gd-scorecard-parse-core.mjs";
import courseSearchIdentity from "./gd-course-search-identity.js";
import {
  scorecardImageCandidates, holePageLinks, assembleVisualCards, imageKindHint,
  MAX_CARD_IMAGES, VISUAL_STORED_CONFIDENCE_CAP
} from "./gd-scorecard-visual-core.mjs";

const {
  buildCourseSearchIdentity, scoreSearchCandidate, scoreScorecardPage,
  detectFacilityStructure, similarity
} = courseSearchIdentity;

export const SCORECARD_SOURCE_PRIORITY = ["golfpass", "18birdies", "golfshot", "swingu", "club-site", "search"];

/* Recognised so a result can say where it came from, and so the search ranker can
   prefer a known-good source over an unknown one. Not an allowlist - an unknown
   host that parses cleanly is still a usable card. */
const KNOWN_SOURCES = [
  { id: "golfpass", host: /(^|\.)golfpass\.com$/i, unit: "yards" },
  { id: "18birdies", host: /(^|\.)18birdies\.com$/i, unit: "yards" },
  { id: "golfshot", host: /(^|\.)golfshot\.com$/i, unit: null },
  { id: "swingu", host: /(^|\.)swingu\.com$/i, unit: null },
  { id: "golfify", host: /(^|\.)golfify\.io$/i, unit: null }
];

export function classifySource(url) {
  let host = "";
  try { host = new URL(String(url)).hostname; } catch (e) { return { id: "club-site", unit: null }; }
  const known = KNOWN_SOURCES.find(source => source.host.test(host));
  return known ? { id: known.id, unit: known.unit } : { id: "club-site", unit: null };
}

/* The course's own name, from the page rather than from the search result title.
   A Brave title is "... - South Course in Tomarata, Auckland, New Zealand | GolfPass";
   the og:title is "Te Arai Links Golf Club - South Course". Names end up on
   course_maps rows and in the picker, so the tidy one is worth the regex. */
export function courseNameFromHtml(html, fallback, pageUrl) {
  const source = String(html || "");
  const og = source.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || source.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  const h1 = source.match(/<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i);
  const pick = (og && og[1]) || (h1 && h1[1].replace(/<[^>]*>/g, "")) || "";
  const clean = stripSiteSuffix(pick.replace(/\s*[|\u2013\u2014]\s*(GolfPass|18Birdies|Golf Advisor|Golfshot).*$/i, ""), pageUrl)
    .replace(/\s+in\s+[^,]+,.*$/i, "").replace(/\s+/g, " ").trim();
  return clean || fallback || "";
}

/* "Club Filipino Inc de Cebu, Danao | Golf4Holland" is the course plus the site's own
   name. Left on, the site name became the stored card's key and the name a loop was
   published under. Only a trailing segment that IS the page's host comes off, so
   "Te Arai Links Golf Club - North Course" keeps its course half. */
function stripSiteSuffix(title, pageUrl) {
  const letters = text => String(text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const host = letters(safeHostname(pageUrl).split(".")[0]);
  if (host.length < 5) return title;
  return String(title || "").replace(/(?:\s*[|\u2013\u2014]\s*|\s+-\s+)([^|\u2013\u2014]+)$/, (whole, tail) => {
    const site = letters(tail);
    return site.length >= 5 && (host.includes(site) || site.includes(host)) ? "" : whole;
  });
}

/* Sibling courses at the same facility, from the page we already fetched.
 *
 * A search for "Te Arai Links" returns its South Course and stops. The North is a
 * separate page with its own internal id (43601 against the South's 43275) that no
 * query rule derives - but the South's own "Nearby Courses" block links straight to
 * it. Free, exact, and it is the only way a two-course site yields the two cards the
 * loop matcher needs to tell North from South apart.
 *
 * Restricted to the same host and to links sharing a meaningful word with the club
 * name, so "Nearby Courses" does not drag in Mangawhai, Omaha Beach and Tara Iti -
 * all of which sit in that same block. */
export function siblingCourseLinks(html, pageUrl, courseName) {
  let host = "";
  try { host = new URL(pageUrl).hostname; } catch (e) { return []; }
  const stop = /^(golf|club|course|the|and|at|links|country|resort|of)$/i;
  const words = String(courseName || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !stop.test(w));
  if (!words.length) return [];
  const out = new Map();
  const linkRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let hit;
  while ((hit = linkRe.exec(String(html || "")))) {
    let url;
    try { url = new URL(hit[1], pageUrl); } catch (e) { continue; }
    if (url.hostname !== host) continue;
    const path = url.pathname.toLowerCase();
    if (!/\/courses?\//.test(path)) continue;
    if (url.href.replace(/\/+$/, "") === String(pageUrl).replace(/\/+$/, "")) continue;
    /* Every name word must appear, so a sibling of THIS club qualifies and a
       neighbouring club in the same list does not. */
    if (!words.every(word => path.includes(word))) continue;
    out.set(url.href.replace(/\/+$/, ""), true);
  }
  return [...out.keys()].slice(0, 4);
}

/* Is this card actually for the course we asked about?
 *
 * A Brave search for "Te Arai Links" returned bluegolf.com's scorecard for AYREN
 * Links Golf Club - a different club on another continent - and it parsed cleanly,
 * scored well, and went into the pool the loop matcher chooses from. A wrong card
 * that parses is more dangerous than a page that fails, because everything
 * downstream treats it as evidence.
 *
 * Checked on the club words the page itself claims, not on the URL: an aggregator
 * path is often a slug of the right club while the page is about another. */
export function cardNameMatchesCourse(cardName, courseName) {
  const stop = /^(golf|club|course|the|and|at|links|country|resort|of|scorecard|detailed|database|north|south|east|west|old|new)$/i;
  const words = text => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !stop.test(w));
  const wanted = words(courseName);
  /* A name with nothing distinctive left - "Golf course", the OSM placeholder,
     or a Korean club name that the Latin filter reduces to "CC" - cannot
     vouch for any card, so no card is accepted. This used to return true,
     which took the University of Georgia's card for a course in Uljin and a
     resort 100 km away for 소피아그린CC, and stored both as evidence. */
  if (!wanted.length) return false;
  const got = new Set(words(cardName));
  const hits = wanted.filter(word => got.has(word)).length;
  /* Every distinctive word, so "Te Arai" clears and "Ayren" does not. One-word
     club names still work because the bar is the whole set, however small. */
  return hits === wanted.length;
}

/* The old guard above remains exported for callers that compare two Latin names.
   Discovery uses the complete identity instead: an exact Korean/Japanese/Chinese
   alias is valid evidence, as is an English provider alias supplied alongside it. */
export function cardNameMatchesIdentity(cardName, identity) {
  const claimed = String(cardName || "").trim();
  if (!claimed) return false;
  return (identity.aliases || []).some(alias => similarity(alias, claimed) >= 0.78);
}

/* course_scorecards.course_key is the DISPLAY NAME lowercased and whitespace-
   collapsed, NOT the dash-slug every other table uses. Must stay byte-identical to
   scorecardCourseKey() in course-mapper-worker-background.mjs or a card written
   here is invisible to the reader that needs it. */
export function scorecardCourseKey(courseName) {
  return String(courseName || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/* A card is worth storing when it can answer the questions the engine asks of it.
 *
 * Deliberately NOT "18 holes or nothing" - that gate is what made the old parser
 * discard a 17-hole read and move to the next URL. Identification matches on
 * relative structure and tolerates gaps by design, so nine good holes beats
 * nothing. scorecard-store applies its own stricter gate before anything becomes
 * every device's cached answer; this one only decides whether to stop looking. */
export function cardQuality(card) {
  if (!card || !Array.isArray(card.holes)) return { usable: false, score: 0, reason: "no-card" };
  const withPar = card.holes.filter(hole => Number.isFinite(hole.par)).length;
  const withDistance = card.holes.filter(hole => Number.isFinite(hole.distanceM)).length;
  if (withPar < 9) return { usable: false, score: 0, reason: "fewer-than-nine-pars", withPar, withDistance };
  /* Par carries identification on its own - where the short holes fall is the
     decisive signal - so distances lift the score rather than gating it. */
  return { usable: true, score: withPar + withDistance * 0.5, reason: null, withPar, withDistance };
}

/* Are these two cards the same course?
 *
 * Names are the first answer and the weakest one. An aggregator serves the same
 * course on its overview page and its scorecard page, sometimes titled differently;
 * a club that lists both its courses under one generic "Scorecard" heading gives two
 * different courses the same name. Counting by name alone is wrong in both
 * directions - it splits one course in two, and merges two courses into one.
 *
 * So the layout decides. Two 18-hole cards for the SAME course have the same par on
 * every hole; two different courses on one site do not - Te Arai's South is par 72
 * with its short holes at 5, 8, 12, 17, and its North is par 71 with them at 2, 7,
 * 12, 15, 17. That is the same relative-structure argument the loop matcher runs on,
 * applied one level earlier: what makes a course identifiable also makes it
 * distinguishable.
 *
 * Distances break the tie when par is identical, which happens on sibling courses
 * built to the same par - compared as RANK ORDER, so tee sets and units cannot make
 * one course look like two. */
export function sameCourseCard(a, b) {
  const parOf = card => (card && card.holes || []).filter(h => Number.isFinite(h.par));
  const parA = parOf(a), parB = parOf(b);
  const shared = parA.filter(h => parB.some(x => x.hole === h.hole));
  if (shared.length < 6) {
    /* Too little overlap to judge by layout - fall back to the names, which is all
       that is left. */
    return scorecardCourseKey(a && a.name) === scorecardCourseKey(b && b.name);
  }
  const parMatches = shared.every(h => h.par === parB.find(x => x.hole === h.hole).par);
  if (!parMatches) return false;

  const ranks = card => {
    const withDistance = (card.holes || []).filter(h => Number.isFinite(h.distanceM));
    const order = withDistance.slice().sort((x, y) => y.distanceM - x.distanceM).map(h => h.hole);
    return new Map(order.map((hole, index) => [hole, index]));
  };
  const ra = ranks(a), rb = ranks(b);
  const common = [...ra.keys()].filter(hole => rb.has(hole));
  /* Same par everywhere and no distances to separate them: the same course. */
  if (common.length < 6) return true;
  const disagreements = common.filter(hole => Math.abs(ra.get(hole) - rb.get(hole)) > 2).length;
  return disagreements <= Math.max(1, Math.round(common.length * 0.15));
}

/* IS THIS CARD STITCHED TOGETHER OUT OF THE OTHERS?
 *
 * Howeston's aggregator page publishes an "18-hole" card for a 27-hole club, and
 * it is not a course. Its holes are spliced out of the club's real nines and put
 * back in the wrong order:
 *
 *   All Square 1-4   317,104,250,308   Howard 1-4, exactly
 *   All Square 5-6   345,125           WESTWARD 2-3, exactly
 *   All Square 8-9   295,290           Howard 8-9, exactly
 *
 * Accepting that as a course claim is how a facility publishes an eighteen that
 * nobody has ever played, over ground belonging to two real loops.
 *
 * THE TEST IS ORDER, NOT ORIGIN
 *
 * "Its holes come from the sibling cards" is NOT evidence of fabrication - it is
 * the definition of a legitimate combined card. A real "Red + White" card IS
 * Red's nine followed by White's nine, and rejecting cards for that would throw
 * away exactly the composite evidence gd-facility-loops-core.mjs is built to
 * slice.
 *
 * What separates them is whether the sibling survives as a CONTIGUOUS RUN in the
 * card's own hole order. Red + White carries Red 1-9 at holes 1-9, unbroken and
 * in sequence. Howeston's card carries four of Howard, then two of Westward,
 * then two more of Howard - the same distances, shuffled. A club prints its
 * nines end to end; an aggregator's bad scrape interleaves them.
 *
 * Returns { stitched, runs, drawnFrom, longestRun }. `stitched` is true only
 * when the card is substantially made of sibling holes AND no sibling survives
 * as a run long enough to be a nine. */
export const STITCH_TOLERANCE_M = 3;
const STITCH_MIN_RUN = 8;

function distancesOf(card) {
  return ((card && card.holes) || [])
    .slice()
    .sort((a, b) => (a.hole || 0) - (b.hole || 0))
    .map(hole => (Number.isFinite(hole.distanceM) ? hole.distanceM : null));
}

/* The longest stretch of `card` that follows `sibling` hole for hole, in order.
   Distances are compared with a small tolerance because two sources round and
   re-measure the same hole differently. */
function longestOrderedRun(cardDistances, siblingDistances) {
  let best = 0;
  for (let start = 0; start < cardDistances.length; start += 1) {
    for (let offset = 0; offset < siblingDistances.length; offset += 1) {
      let run = 0;
      while (start + run < cardDistances.length && offset + run < siblingDistances.length) {
        const a = cardDistances[start + run];
        const b = siblingDistances[offset + run];
        if (a == null || b == null || Math.abs(a - b) > STITCH_TOLERANCE_M) break;
        run += 1;
      }
      if (run > best) best = run;
    }
  }
  return best;
}

export function stitchedCardVerdict(card, siblings) {
  const mine = distancesOf(card);
  /* Only cards SHORTER than this one can have been stitched into it. Without
     that direction the test is symmetric and accuses the victim: Howeston's real
     Howard nine came back "stitched" because the aggregator's fake eighteen had
     borrowed from it. A nine is never assembled out of an eighteen. */
  const others = (siblings || []).filter(other => other && other !== card
    && ((other.holes || []).length) < ((card.holes || []).length));
  const usable = mine.filter(value => value != null).length;
  if (usable < 9 || !others.length) return { stitched: false, reason: "not-enough-to-judge", runs: [], drawnFrom: 0, longestRun: 0 };

  const runs = others.map(other => ({
    name: (other && other.name) || "(unnamed)",
    run: longestOrderedRun(mine, distancesOf(other))
  }));
  const longestRun = runs.reduce((max, entry) => Math.max(max, entry.run), 0);

  /* How much of this card any sibling can account for at all, in any order. A
     multiset count, so a distance repeated twice needs two sources. */
  const pool = [];
  others.forEach(other => distancesOf(other).forEach(value => { if (value != null) pool.push(value); }));
  let drawnFrom = 0;
  mine.forEach(value => {
    if (value == null) return;
    const index = pool.findIndex(candidate => Math.abs(candidate - value) <= STITCH_TOLERANCE_M);
    if (index >= 0) { pool.splice(index, 1); drawnFrom += 1; }
  });

  /* Substantially built from the siblings, yet not carrying any of them whole
     and in order. That is a scrape that lost the boundaries between the club's
     nines, not a card for a course somebody plays. */
  const mostlyBorrowed = drawnFrom >= Math.ceil(usable * 0.5);
  const stitched = mostlyBorrowed && longestRun < STITCH_MIN_RUN;
  return {
    stitched,
    reason: stitched
      ? "borrows-" + drawnFrom + "-of-" + usable + "-holes-longest-ordered-run-" + longestRun
      : (mostlyBorrowed ? "composite-run-" + longestRun : "own-holes"),
    runs, drawnFrom, longestRun
  };
}

/* Distinct courses in a pool, by layout rather than by title. */
/* When two cards are the same course, the fuller one stands for it. A front-nine-only
   scrape with no distances (Club Filipino on Golf4Holland) matches the full eighteen by
   par on the holes they share - it must not be the copy that survives. */
export function distinctCards(cards) {
  const fullness = card => { const quality = cardQuality(card); return (quality.withPar || 0) + (quality.withDistance || 0); };
  const distinct = [];
  (cards || []).forEach(card => {
    const index = distinct.findIndex(kept => sameCourseCard(kept, card));
    if (index < 0) distinct.push(card);
    else if (fullness(card) > fullness(distinct[index])) distinct[index] = card;
  });
  return distinct;
}

/* Good enough to stop looking: a distance on (nearly) every hole with a par. A card
   with pars alone still identifies a course and is kept, but the next page may carry
   the lengths the geometry resolver needs to number holes - Club Filipino stopped on
   a par-only nine while All Square had the full eighteen with distances. */
export function cardHasDistances(card) {
  const quality = cardQuality(card);
  return quality.usable && quality.withDistance >= quality.withPar - 1;
}

export function distinctCardCount(cards) {
  return distinctCards(cards).length;
}

/* deps: { fetchHtml, search, readStore, writeStore, visual } - all injected so this
   module stays testable without a network, in keeping with every other core here.
   deps.visual (optional, from gd-scorecard-vision.mjs): { fetchHtml, readImages }
   for the picture fallback when no page held a readable table.

   course: { courseName, region, country }
   options.want: how many DISTINCT courses this site is known to have. The scan has
   already separated the loops by the time this runs, so the target is a fact, not a
   guess - keep reading candidates until that many distinct cards are in hand. */
export async function resolveScorecard(course, deps, options) {
  const name = String((course && (course.courseName || course.name)) || "").trim();
  const key = scorecardCourseKey(name);
  const identity = buildCourseSearchIdentity(course);
  const out = {
    courseKey: key, courseName: name, identity, cards: [], stored: false,
    statedHoleCount: null, attempts: [], searchTrace: {
      originalCourseName: name,
      canonicalCourseName: identity.englishName || name,
      aliases: identity.aliases,
      transliterations: identity.transliterations,
      location: { city: identity.city, region: identity.region, country: identity.country, countryCode: identity.countryCode, lat: identity.lat, lng: identity.lng },
      queries: [], domainsDiscovered: [], candidates: []
    },
    /* Where the run got to, in order - see resolveVisualScorecard. */
    debug: { stage: null, stages: [] },
    visual: null
  };
  if (!key) return Object.assign(out, { reason: "no-course-name" });

  if (deps.readStore) {
    const cached = await deps.readStore(key).catch(() => null);
    if (cached && Array.isArray(cached.holes) && cached.holes.length) {
      return Object.assign(out, { cards: [cached], fromCache: true });
    }
  }

  /* The number of courses the scan actually separated, when the caller knows it.
     Without it, 2 is the floor that still lets a plain single course stop early. */
  const want = Math.max(1, Number(options && options.want) || 1);
  const gathered = await gatherCandidates(course, identity, deps);
  const candidates = gathered.candidates;
  out.searchTrace.queries = gathered.trace.queries || [];
  out.searchTrace.domainsDiscovered = gathered.trace.domainsDiscovered || [];
  out.searchTrace.candidates = candidates.map(candidate => ({
    url: candidate.url, title: candidate.name || "", score: candidate.candidateScore,
    reasons: candidate.scoreReasons || [], why: candidate.why
  }));
  const queued = new Set(candidates.map(candidate => candidate.url));
  const parsed = [];
  /* Pages that are about this course but held no readable table - where the
     picture fallback looks if every page comes up empty. */
  const visualPages = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    /* Stop on DISTINCT courses found, not pages read. A site with two courses keeps
       reading - including the sibling links a page hands us - until it has two, and
       an extra copy of a course already held does not count towards the target.
       Only cards with distances count - see cardHasDistances. */
    if (distinctCardCount(parsed.filter(cardHasDistances)) >= want) break;
    const html = await deps.fetchHtml(candidate.url).catch(error => {
      out.attempts.push({ url: candidate.url, ok: false, reason: String(error && error.message || error).slice(0, 200) });
      return null;
    });
    if (!html) continue;
    const source = classifySource(candidate.url);
    /* Follow the page to this club's other courses before moving on. Only from a
       recognised aggregator, and only once, so this cannot wander. */
    if (source.id !== "club-site" && !candidate.sibling) {
      siblingCourseLinks(html, candidate.url, name).forEach(url => {
        if (queued.has(url) || candidates.length >= 10) return;
        queued.add(url);
        candidates.push({ url, name: "", why: "sibling-course", sibling: true });
      });
    }
    /* Every card the page holds, not one. A club that puts both its courses on one
       page hands over both here, each named by the heading above its own table -
       which is the cheapest possible route to "one card per course". */
    const pageName = courseNameFromHtml(html, candidate.name || name, candidate.url);
    const cards = parseScorecardCardsHtml(html, { name: pageName, unit: source.unit });
    const pageConfidence = scoreScorecardPage(html, cards);
    out.attempts.push({
      url: candidate.url, ok: !!cards.length, source: source.id,
      cards: cards.length, holes: cards[0] ? cards[0].holes.length : 0,
      candidateScore: candidate.candidateScore || 0,
      scorecardConfidence: pageConfidence.score,
      scorecardSignals: pageConfidence.details
    });
    const attempt = out.attempts[out.attempts.length - 1];
    /* Prose facts are worth keeping even from a page whose table was unreadable -
       "18 hole, par 72" is the field three of the mapper's guards depend on. */
    cards.forEach(card => { if (card.statedHoleCount && !out.statedHoleCount) out.statedHoleCount = card.statedHoleCount; });
    if (!cards.length) {
      attempt.stage = "html-extraction-failed";
      const pageIdentity = cardNameMatchesIdentity(pageName, identity) || cardNameMatchesCourse(pageName, name)
        || Number(candidate.nameSimilarity) >= 0.78 || !!candidate.officialDomain;
      if (pageIdentity && visualPages.length < 4) visualPages.push({ candidate, html, pageName, source });
    }
    /* A page with no readable table at all still answers the one question three of
       the mapper's guards depend on. Te Arai's own site is exactly this: no card
       anywhere, but "The 18 hole, par 72 golf course" in plain English. */
    if (!cards.length && !out.statedHoleCount) {
      const facts = courseFactsFromText(pageText(html));
      if (facts.holeCount) { out.statedHoleCount = facts.holeCount; attempt.statedHoleCount = facts.holeCount; }
    }
    cards.forEach(card => {
      const quality = cardQuality(card);
      if (!quality.usable) { attempt.reason = quality.reason; return; }
      /* A card's own heading can be just "Scorecard", so it is checked against the
         page's name too before being called a different club's card. */
      const identityMatched = cardNameMatchesIdentity(card.name, identity)
        || cardNameMatchesIdentity(pageName, identity)
        || cardNameMatchesCourse(card.name, name)
        || cardNameMatchesCourse(pageName, name);
      const searchIdentityMatched = Number(candidate.nameSimilarity) >= 0.78;
      const officialSemanticMatch = !!candidate.officialDomain && pageConfidence.score >= 55;
      if (!identityMatched && !searchIdentityMatched && !officialSemanticMatch) {
        attempt.rejected = "name-mismatch:" + (card.name || "").slice(0, 60);
        return;
      }
      attempt.usable = true;
      if (!out.searchTrace.canonicalCourseName || out.searchTrace.canonicalCourseName === name) {
        const latinPageName = /[a-z]/i.test(pageName) ? pageName : "";
        if (latinPageName) out.searchTrace.canonicalCourseName = latinPageName;
      }
      const cardLabel = String(card.name || "").trim();
      const usefulCardLabel = cardLabel && !/^(?:scorecard|course|course guide|golf course)$/i.test(cardLabel);
      parsed.push(Object.assign({}, card, {
        /* Falls back to the page's name when the table heading is generic, so two
           cards from one page stay distinguishable but a lone card is still named. */
        name: usefulCardLabel ? cardLabel : pageName,
        sourceUrl: candidate.url, source: source.id,
        quality: quality.score + pageConfidence.score * 0.1 + (candidate.candidateScore || 0) * 0.05,
        resolution: {
          identity, officialDomain: candidate.officialDomain ? safeHostname(candidate.url) : "",
          confidence: Math.min(1, (pageConfidence.score + Math.max(0, candidate.candidateScore || 0)) / 140),
          fetchedAt: new Date().toISOString(), scorecardConfidence: pageConfidence.score
        }
      }));
    });
  }

  if (parsed.length) {
    out.debug.stages.push("html-resolved");
  } else {
    out.debug.stages.push("html-extraction-failed");
    await resolveVisualScorecard(visualPages, { name, identity }, deps.visual, out, parsed);
  }
  out.debug.stage = out.debug.stages[out.debug.stages.length - 1];

  /* Best first, and every card kept rather than only the winner: a site with two
     courses yields two cards, and the loop matcher needs both to tell them apart. */
  parsed.sort((a, b) => b.quality - a.quality);
  out.cards = parsed;
  out.facility = detectFacilityStructure(distinctCards(parsed));
  out.want = want;
  out.distinct = distinctCardCount(parsed);
  /* Says so when it came up short rather than letting the caller assume the pool is
     complete - a two-course site with one card cannot name anything, and the job row
     should show that as a shortfall, not a silence. */
  const nothingReason = out.visual && out.visual.status === "visual-extraction-failed" ? "visual-extraction-failed" : "no-readable-card";
  if (out.distinct < want) out.reason = parsed.length ? "found-" + out.distinct + "-of-" + want + "-courses" : nothingReason;
  if (!parsed.length) return Object.assign(out, { reason: nothingReason });

  if (deps.writeStore) {
    out.stored = await deps.writeStore(key, name, parsed).then(() => true).catch(error => {
      out.storeError = String(error && error.message || error).slice(0, 200);
      return false;
    });
  }
  return out;
}

/* THE PICTURE FALLBACK
 *
 * Runs only when no page held a readable table. Looks at the pages that were about
 * this course (and at their per-hole pages) for images of the card, then tops that
 * up with an image search, has them transcribed, and keeps only what
 * gd-scorecard-visual-core can corroborate.
 *
 * The image search is there because the card often lives on a page we cannot
 * read. Cebu Country Club's is on BlueGolf and mScorecard, both of which refuse our
 * page fetch, and its own site shows none - but an image search for
 * "Cebu Country Club scorecard" turns up the card itself.
 *
 * Two model calls at most: the card-like images first, then - only if those did
 * not resolve - the per-hole graphics as one batch.
 *
 * out.debug.stages records the route, so a job row says which of these happened:
 *   html-extraction-failed -> (no image)                      nothing to look at
 *   html-extraction-failed -> scorecard-image-found -> visual-extraction-failed
 *   html-extraction-failed -> scorecard-image-found -> visual-scorecard-resolved */
async function resolveVisualScorecard(pages, context, visual, out, parsed) {
  const report = out.visual = { status: null, pagesInspected: 0, holePages: 0, imageSearch: null, images: [], reads: [], accepted: [], rejected: [] };
  if (!visual) { report.status = "unavailable"; return; }

  const cardImages = [];
  let holeImages = [];
  for (const page of pages.slice(0, 3)) {
    report.pagesInspected += 1;
    scorecardImageCandidates(page.html, page.candidate.url).forEach(image => {
      if (!cardImages.some(existing => existing.url === image.url)) cardImages.push(Object.assign({ page }, image));
    });
    /* One page's hole set, the fullest one found: hole graphics from two different
       sites are not one course's card. */
    const links = holePageLinks(page.html, page.candidate.url);
    if (links.length < 9 || links.length <= holeImages.length) continue;
    const fetched = await Promise.all(links.map(link => visual.fetchHtml(link.url)
      .then(html => ({ link, html }))
      .catch(error => ({ link, error: String(error && error.message || error).slice(0, 120) }))));
    report.holePages += fetched.filter(entry => entry.html).length;
    const perHole = fetched.map(entry => {
      if (!entry.html) return null;
      const best = scorecardImageCandidates(entry.html, entry.link.url, { holeNumber: entry.link.hole })[0];
      return best ? Object.assign({ page, fromHolePage: true, pageUrl: entry.link.url }, best, { kind: "single-hole", hole: entry.link.hole }) : null;
    }).filter(Boolean);
    if (perHole.length > holeImages.length) holeImages = perHole;
  }
  /* A full card that is also a hole page's picture is a card, not a hole graphic. */
  holeImages = holeImages.filter(image => !cardImages.some(card => card.url === image.url && card.kind !== "single-hole"));
  const cardBatch = cardImages.filter(image => image.kind !== "single-hole").slice(0, MAX_CARD_IMAGES);

  /* Page images first - they come from pages already matched to this course - and
     the image search fills whatever room is left in the same model call. */
  if (cardBatch.length < MAX_CARD_IMAGES && visual.searchImages) {
    const query = context.name + " scorecard";
    const search = report.imageSearch = { query, results: 0, kept: [], error: null };
    const results = await visual.searchImages(query).catch(error => {
      search.error = String(error && error.message || error).slice(0, 160);
      return [];
    });
    search.results = results.length;
    imageSearchCandidates(results, context.identity, context.name)
      .filter(image => !cardBatch.some(existing => existing.url === image.url))
      .slice(0, MAX_CARD_IMAGES - cardBatch.length)
      .forEach(image => {
        cardBatch.push(image);
        search.kept.push({ url: image.url, page: image.page.candidate.url, title: image.context });
      });
  }

  report.images = cardBatch.concat(holeImages).map(image => ({ url: image.url, kind: image.kind, hole: image.hole, score: image.score, page: image.page.candidate.url }));
  if (!report.images.length) { report.status = "no-scorecard-image"; return; }
  out.debug.stages.push("scorecard-image-found");

  const reads = [];
  const runBatch = async (batch, label) => {
    if (!batch.length) return null;
    const answers = await visual.readImages(batch).catch(error => {
      report.reads.push({ batch: label, error: String(error && error.message || error).slice(0, 200) });
      return [];
    });
    answers.forEach(answer => {
      report.reads.push({ batch: label, url: answer.image.url, ok: !!answer.raw, error: answer.error || null, kind: answer.raw ? answer.raw.kind : null, legibility: answer.raw ? answer.raw.legibility : null });
      if (answer.raw) reads.push({ raw: answer.raw, image: answer.image });
    });
    return assembleVisualCards(reads);
  };

  let assembled = await runBatch(cardBatch, "card-images");
  if (!(assembled && assembled.accepted.length) && holeImages.length >= 9) assembled = await runBatch(holeImages, "hole-graphics");
  report.rejected = assembled ? assembled.rejected : [];

  const accepted = [];
  (assembled ? assembled.accepted : []).forEach(result => {
    /* A name printed on the card that is plainly another club's sinks it, the same
       guard the HTML path applies to an aggregator's heading. */
    if (result.printedName && /[a-z]/i.test(result.printedName)
      && !cardNameMatchesIdentity(result.printedName, context.identity) && !cardNameMatchesCourse(result.printedName, context.name)) {
      report.rejected.push({ url: result.images.join(" + "), reason: "name-mismatch:" + result.printedName.slice(0, 60) });
      return;
    }
    accepted.push(result);
  });

  accepted.forEach(result => {
    const page = cardBatch.concat(holeImages).find(image => image.url === result.images[0]).page;
    const quality = cardQuality(result.card);
    if (!quality.usable) { report.rejected.push({ url: result.images.join(" + "), reason: quality.reason }); return; }
    const confidence = Math.min(VISUAL_STORED_CONFIDENCE_CAP, result.confidence);
    parsed.push(Object.assign({}, result.card, {
      /* The page's name, not the one printed on the card: a printed heading is
         "Scorecard: Cebu Country Club", and that would end up on a course row. */
      name: page.pageName || context.name,
      sourceUrl: page.candidate.url, source: "visual-" + page.source.id,
      quality: quality.score * result.confidence,
      resolution: {
        identity: context.identity, officialDomain: page.candidate.officialDomain ? safeHostname(page.candidate.url) : "",
        method: "visual", confidence, visualConfidence: result.confidence,
        visualChecks: result.checks, visualLayout: result.layout, visualProblems: result.problems,
        imageUrls: result.images, fetchedAt: new Date().toISOString()
      }
    }));
    report.accepted.push({ images: result.images, layout: result.layout, confidence: result.confidence, checks: result.checks, holes: result.card.holes.length });
  });

  report.status = report.accepted.length ? "visual-scorecard-resolved" : "visual-extraction-failed";
  out.debug.stages.push(report.status);
}

/* Image search results worth sending to the reader, best first.
 *
 * These come from no page we have matched to the course, so the bar is the result's
 * own title: it must name this course and say it is a card. The name printed on
 * the card is checked again after it is read. */
export function imageSearchCandidates(results, identity, courseName) {
  const confidenceRank = { high: 3, medium: 2, low: 1 };
  const seen = new Set();
  return (results || []).map(result => {
    const url = String((result && result.imageUrl) || "");
    const pageUrl = String((result && result.pageUrl) || "");
    const title = String((result && result.title) || "").trim();
    if (!/^https:\/\//i.test(url) || /\.svg(\?|#|$)/i.test(url) || seen.has(url)) return null;
    seen.add(url);
    if (Number.isFinite(result.width) && result.width > 0 && result.width < 400) return null;
    const text = title + " " + pageUrl + " " + url;
    if (!/score[\s_-]?card|yardage|course[\s_-]?card/i.test(text)) return null;
    if (!cardNameMatchesIdentity(title, identity) && !cardNameMatchesCourse(title, courseName)) return null;
    const hint = imageKindHint(title);
    const score = (confidenceRank[result.confidence] || 1) + (/score[\s_-]?card/i.test(title) ? 2 : 0);
    return {
      url, thumbnailUrl: result.thumbnailUrl || null, score, kind: hint.kind === "single-hole" ? "full-card" : hint.kind, hole: null,
      context: title.slice(0, 160),
      page: {
        candidate: { url: pageUrl || url, officialDomain: false },
        pageName: courseName,
        source: { id: "image-search" }
      }
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score);
}

/* Pages worth reading, best-known source first.
 *
 * Aggregator URLs cannot be guessed - GolfPass keys on an internal numeric id
 * (43275-te-arai-links-golf-club-south-course) that no slug rule produces - so
 * search is how they are found, and without a search provider configured this
 * degrades to the club's own site. That is a real limitation, not a silent one:
 * the caller gets it back on `attempts`. */
async function gatherCandidates(course, identity, deps) {
  const seen = new Set();
  const list = [];
  const add = (url, label, why, metadata) => {
    const clean = String(url || "").replace(/\/+$/, "");
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    const scored = scoreSearchCandidate(Object.assign({ url: clean, title: label || "" }, metadata || {}), identity);
    list.push(Object.assign({
      url: clean, name: label || identity.rawName, why,
      candidateScore: Number(metadata && metadata.candidateScore) || scored.score,
      scoreReasons: (metadata && metadata.scoreReasons) || scored.reasons,
      nameSimilarity: scored.nameSimilarity,
      officialDomain: scored.officialDomain || !!(metadata && metadata.official)
    }, metadata || {}));
  };

  let trace = { queries: [], domainsDiscovered: [] };
  if (deps.search) {
    const region = identity.region || identity.country || "";
    const response = await deps.search(identity.rawName, region, identity).catch(() => []);
    const hits = Array.isArray(response) ? response : ((response && response.results) || []);
    if (response && !Array.isArray(response)) {
      trace = { queries: response.queries || [], domainsDiscovered: response.domainsDiscovered || [] };
      if (response.identity) {
        (response.identity.aliases || []).forEach(alias => {
          if (!identity.aliases.some(existing => similarity(existing, alias) >= 1)) identity.aliases.push(alias);
        });
      }
    }
    hits.forEach(hit => add(hit.url || hit, hit.title || hit.name, "search", hit));
  }
  [course && course.website, course && course.url].filter(Boolean).forEach(site => add(site, identity.rawName, "club-site", { official: true }));

  /* A likely official root is useful even when search landed on news or booking.
     Probe conventional course paths; fetch failures are recorded and harmless. */
  const roots = new Set();
  list.filter(candidate => candidate.officialDomain || candidate.why === "club-site").forEach(candidate => {
    try { roots.add(new URL(candidate.url).origin); } catch (e) {}
  });
  const paths = ["/course", "/course-info", "/courseguide", "/course-guide", "/golf", "/scorecard", "/holes"];
  [...roots].slice(0, 2).forEach(root => paths.forEach(path => add(root + path, identity.rawName, "official-path", { official: true })));

  /* Identity/location evidence leads. Source reputation breaks close ties, so a
     strongly matching aggregator still wins while an unrelated one cannot jump
     ahead of the official club page merely because its host is familiar. */
  const rank = url => {
    const index = SCORECARD_SOURCE_PRIORITY.indexOf(classifySource(url).id);
    return index === -1 ? SCORECARD_SOURCE_PRIORITY.length : index;
  };
  return {
    candidates: list.sort((a, b) => {
      const scoreDelta = b.candidateScore - a.candidateScore;
      return Math.abs(scoreDelta) >= 8 ? scoreDelta : (rank(a.url) - rank(b.url) || scoreDelta);
    }).slice(0, 18),
    trace
  };
}

function safeHostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
}

/* The card's holes measured from its forward tee, for a course OSM mapped without tees.
 *
 * With no tee to start from, a par 4 or 5 is measured from the far end of its fairway, and
 * the forward tee is the one that plays from about there - so it is the card's best match for
 * those lines. Par 3s keep the card's own length: their line runs from a guessed tee off the
 * green before, which is not where the forward tee is.
 *
 * Takes holes in either shape the mapper holds them (engine card teesM, or a stored row's
 * tees: { name: { metres } }). The forward tee is the shortest tee with a length on every par
 * 4 and 5. Returns null when the card does not carry two tees, so there is nothing to change. */
export function forwardTeeHoles(holes) {
  const list = holes || [];
  const teesOf = hole => {
    const out = {};
    Object.entries(hole.teesM || hole.tees || {}).forEach(([name, value]) => {
      const metres = Number(value && typeof value === "object" ? value.metres : value);
      if (Number.isFinite(metres)) out[name] = metres;
    });
    return out;
  };
  const long = list.filter(hole => Number(hole.par) >= 4);
  if (!long.length) return null;
  const names = new Set();
  list.forEach(hole => Object.keys(teesOf(hole)).forEach(name => names.add(name)));
  if (names.size < 2) return null;
  const complete = [...names].filter(name => long.every(hole => Number.isFinite(teesOf(hole)[name])));
  if (!complete.length) return null;
  const total = name => long.reduce((sum, hole) => sum + teesOf(hole)[name], 0);
  const forward = complete.sort((a, b) => total(a) - total(b))[0];
  return {
    tee: forward,
    holes: list.map(hole => Number(hole.par) >= 4
      ? Object.assign({}, hole, { distanceM: teesOf(hole)[forward], metres: teesOf(hole)[forward] })
      : hole)
  };
}

/* Which course_key a distinct card should be written under, when the facility
   already has rows in the shared store.
 *
 * writeStore used to persist only the best card (cards[0]), so a multi-course
 * facility's second/third card never reached course_scorecards. Now that every
 * distinct card is written, the same card can be re-resolved under a slightly
 * different title next time - "Te Arai Links" one run, "Te Arai Links Golf Club
 * - North Course" the next - and without this check that mints a second row for
 * the same North card instead of updating the first. Structural sameness
 * (sameCourseCard), not the title, decides whether it is the same row. */
export function resolveFacilityCardKey(existingRows, card, facilityKey) {
  const match = (existingRows || []).find(row => sameCourseCard(
    { name: row.course_name, holes: Array.isArray(row.holes_json) ? row.holes_json : [] },
    card
  ));
  return match ? match.course_key : scorecardCourseKey(card.name || "");
}

/* Engine card -> the shape scorecard-store's quality gate accepts: holes numbered
   1..n with no gaps, par required on every one. A card with gaps is still useful
   to the matcher in memory but cannot be shared, because the store's contract is
   that a cached card is complete. */
export function toStorePayload(card, courseName) {
  const holes = (card && card.holes) || [];
  const contiguous = holes.every((hole, index) => hole.hole === index + 1 && Number.isFinite(hole.par));
  if (!holes.length || !contiguous) return null;
  return {
    courseKey: scorecardCourseKey(courseName),
    courseName,
    source: card.source || "scorecard-engine",
    sourceUrl: card.sourceUrl || "",
    holes: holes.map(hole => ({
      hole: hole.hole,
      par: hole.par,
      index: hole.strokeIndex ?? null,
      metres: hole.distanceM ?? null,
      tees: Object.fromEntries(Object.entries(hole.teesM || {}).map(([name, metres]) => [name, { metres }])),
      sourceUrl: card.sourceUrl || ""
    }))
  };
}

/* One distinct card -> a course_scorecards upsert row, tagged with the facility
   it was resolved for and keyed by resolveFacilityCardKey (an existing row's
   key when this is structurally the same card, else the card's own name).
   Returns null on a gappy card - same completeness contract as toStorePayload,
   since this is the row callers pass straight to the upsert. */
export function facilityScorecardRow(card, courseName, facilityKey, existingRows) {
  const payload = toStorePayload(card, card.name || courseName);
  if (!payload) return null;
  return {
    course_key: resolveFacilityCardKey(existingRows, card, facilityKey),
    course_name: payload.courseName,
    facility_key: facilityKey || null,
    source: payload.source,
    source_url: payload.sourceUrl,
    hole_count: payload.holes.length,
    distance_count: payload.holes.filter(hole => Number.isFinite(hole.metres)).length,
    holes_json: payload.holes,
    sources_json: [{
      source: card.source || "", sourceUrl: card.sourceUrl || "", holes: (card.holes || []).length,
      resolution: card.resolution || null
    }],
    updated_at: new Date().toISOString()
  };
}

/* A high-confidence or manually confirmed cached identity is sticky. Refreshes
   may improve it, but a weaker scrape cannot silently replace it. */
export function shouldReplaceFacilityCard(existing, incoming) {
  if (!existing) return true;
  const resolution = row => {
    const first = Array.isArray(row && row.sources_json) ? row.sources_json[0] : null;
    return (first && first.resolution) || {};
  };
  const oldResolution = resolution(existing), nextResolution = resolution(incoming);
  const oldConfidence = Number(oldResolution.confidence) || 0;
  const nextConfidence = Number(nextResolution.confidence) || 0;
  const confirmed = oldResolution.confirmed === true
    || oldConfidence >= 0.8
    || /manual|confirmed/i.test(String(existing.source || ""));
  if (!confirmed) return true;
  if (!nextConfidence) return false;
  return nextConfidence >= oldConfidence;
}
