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
 * Course-profile and handicapping sites first, club websites last. That is the
 * reverse of the old ladder, which guessed club domains up front and reached an
 * aggregator only on its fourth attempt, and the reversal is not a preference -
 * it is what the evidence says. Te Arai Links is in the world top 100 and its own
 * site publishes no hole-by-hole card at all, just "18 hole, par 72" and four tee
 * totals. GolfPass publishes the full card for both of its courses, server-
 * rendered, in plain HTML.
 *
 * It is also the difference between a bounded problem and an unbounded one: a few
 * aggregators with stable layouts, versus every club in the world with its own.
 *
 * The club site still gets read last, because the fields it does reliably carry -
 * hole count, par, the course's real name - are exactly the ones the mapper needs
 * most and the cheapest to extract. */

import { parseScorecardHtml } from "./gd-scorecard-parse-core.mjs";

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
export function courseNameFromHtml(html, fallback) {
  const source = String(html || "");
  const og = source.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || source.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  const h1 = source.match(/<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i);
  const pick = (og && og[1]) || (h1 && h1[1].replace(/<[^>]*>/g, "")) || "";
  const clean = pick.replace(/\s*[|\u2013\u2014]\s*(GolfPass|18Birdies|Golf Advisor|Golfshot).*$/i, "")
    .replace(/\s+in\s+[^,]+,.*$/i, "").replace(/\s+/g, " ").trim();
  return clean || fallback || "";
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
  if (!wanted.length) return true;
  const got = new Set(words(cardName));
  const hits = wanted.filter(word => got.has(word)).length;
  /* Every distinctive word, so "Te Arai" clears and "Ayren" does not. One-word
     club names still work because the bar is the whole set, however small. */
  return hits === wanted.length;
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

/* deps: { fetchHtml, search, readStore, writeStore, log } - all injected so this
   module stays testable without a network, in keeping with every other core here. */
export async function resolveScorecard(course, deps) {
  const name = String((course && (course.courseName || course.name)) || "").trim();
  const key = scorecardCourseKey(name);
  const out = { courseKey: key, courseName: name, cards: [], stored: false, statedHoleCount: null, attempts: [] };
  if (!key) return Object.assign(out, { reason: "no-course-name" });

  if (deps.readStore) {
    const cached = await deps.readStore(key).catch(() => null);
    if (cached && Array.isArray(cached.holes) && cached.holes.length) {
      return Object.assign(out, { cards: [cached], fromCache: true });
    }
  }

  const candidates = await gatherCandidates(course, name, deps);
  const queued = new Set(candidates.map(candidate => candidate.url));
  const parsed = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (parsed.length >= 4) break;
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
    const card = parseScorecardHtml(html, { name: courseNameFromHtml(html, candidate.name || name), unit: source.unit });
    const quality = cardQuality(card);
    out.attempts.push({ url: candidate.url, ok: !!card, source: source.id, holes: card ? card.holes.length : 0, usable: quality.usable, reason: quality.reason });
    /* Prose facts are worth keeping even from a page whose table was unreadable -
       "18 hole, par 72" is the field three of the mapper's guards depend on. */
    if (card && card.statedHoleCount && !out.statedHoleCount) out.statedHoleCount = card.statedHoleCount;
    if (!quality.usable) continue;
    if (!cardNameMatchesCourse(card.name, name)) {
      out.attempts[out.attempts.length - 1].rejected = "name-mismatch:" + (card.name || "").slice(0, 60);
      continue;
    }
    parsed.push(Object.assign({}, card, { sourceUrl: candidate.url, source: source.id, quality: quality.score }));
  }

  /* Best first, and every card kept rather than only the winner: a site with two
     courses yields two cards, and the loop matcher needs both to tell them apart. */
  parsed.sort((a, b) => b.quality - a.quality);
  out.cards = parsed;
  if (!parsed.length) return Object.assign(out, { reason: "no-readable-card" });

  if (deps.writeStore) {
    out.stored = await deps.writeStore(key, name, parsed).then(() => true).catch(error => {
      out.storeError = String(error && error.message || error).slice(0, 200);
      return false;
    });
  }
  return out;
}

/* Pages worth reading, best-known source first.
 *
 * Aggregator URLs cannot be guessed - GolfPass keys on an internal numeric id
 * (43275-te-arai-links-golf-club-south-course) that no slug rule produces - so
 * search is how they are found, and without a search provider configured this
 * degrades to the club's own site. That is a real limitation, not a silent one:
 * the caller gets it back on `attempts`. */
async function gatherCandidates(course, name, deps) {
  const seen = new Set();
  const list = [];
  const add = (url, label, why) => {
    const clean = String(url || "").replace(/\/+$/, "");
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    list.push({ url: clean, name: label || name, why });
  };

  if (deps.search) {
    const region = String((course && (course.region || course.country)) || "");
    const hits = await deps.search(name, region).catch(() => []);
    (hits || []).forEach(hit => add(hit.url || hit, hit.name, "search"));
  }
  [course && course.website, course && course.url].filter(Boolean).forEach(site => add(site, name, "club-site"));

  /* Known sources first, then everything else in the order search ranked it. */
  const rank = url => {
    const index = SCORECARD_SOURCE_PRIORITY.indexOf(classifySource(url).id);
    return index === -1 ? SCORECARD_SOURCE_PRIORITY.length : index;
  };
  return list.sort((a, b) => rank(a.url) - rank(b.url)).slice(0, 8);
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
      tees: {},
      sourceUrl: card.sourceUrl || ""
    }))
  };
}
