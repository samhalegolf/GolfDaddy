"use strict";

/* Which hole a club tells the world about. Studio-only, admin-gated, and entirely optional -
   the Snapshot Machine's hole choice falls back to terrain variance whenever this returns
   nothing, which is the ordinary outcome for a club with a thin web presence.
 *
 * The search itself is the same Brave/Google-CSE client the scorecard resolver uses
 * (./lib/gd-web-search.js). What is different is what we do with the results: scorecard-search
 * hands back URLs for a fetcher to parse, this one reads the TITLES AND SNIPPETS ONLY and
 * extracts hole numbers mentioned alongside signature-hole language. Nothing is fetched, so no
 * club's page is scraped and no third-party HTML is parsed - the evidence is the search
 * engine's own summary, which is exactly the strength of evidence this is worth.
 *
 * WHY IT IS ADMIN-GATED. It spends the search key's quota, and it is reachable from one Studio
 * page used by one person. scorecard-search is open because every player's course needs a
 * scorecard; nobody's round depends on this.
 *
 * CONFIDENCE IS NOT A PROBABILITY. It is a 0..1 summary of how much agreeing evidence turned
 * up: how strong the phrase was ("signature hole" outranks "famous"), how many separate
 * results said the same hole, and whether the course name actually appears in the result. The
 * consumer (scripts/gd-marketing-snapshot-core.js) treats a high number as "outrank the
 * geometry" and a low one as "break a tie", so those two bands are the only distinctions that
 * have to hold. GET /api/marketing-hole-intel?name=...&region=...&holes=18
 */

const { resolveCaller } = require("./clarity-caller");
const { pickProvider } = require("./lib/gd-web-search");

const MAX_HOLES = 36;

/* Phrases that mean "this hole is the one we show people", with how much each is worth. A
   phrase must sit within PROXIMITY chars of the hole number to count - "the signature 7th" and
   "our signature hole ... the 7th plays downhill" are both real, "the 7th is closed for
   maintenance, see our signature hole page" is not, and distance is the only cheap separator.

   Weights are nominal and only have to order each other. "Signature hole" is a term of art a
   club chooses deliberately; "famous"/"iconic" are journalism; "postcard"/"most photographed"
   are the strongest possible signal for THIS purpose and are weighted accordingly. */
const PHRASES = [
  { pattern: /most photographed|postcard hole|picture postcard/i, weight: 1.0 },
  { pattern: /signature hole/i, weight: 0.9 },
  { pattern: /\bsignature\b/i, weight: 0.6 },
  { pattern: /famous|iconic|celebrated/i, weight: 0.5 },
  { pattern: /best known|most memorable|standout hole/i, weight: 0.5 },
  { pattern: /toughest|hardest hole|number 1 (stroke )?index/i, weight: 0.3 }
];

const PROXIMITY = 120;

exports.handler = async function marketingHoleIntel(event) {
  if (event.httpMethod === "OPTIONS") return json(204, null);
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed" });

  let caller;
  try { caller = await resolveCaller(event); }
  catch (error) { return json(500, { error: "Could not resolve caller" }); }
  if (!caller || !caller.isAdmin) return json(403, { error: "Admin permission required" });

  const params = (event && event.queryStringParameters) || {};
  const name = cleanName(params.name).slice(0, 120);
  if (!name) return json(400, { error: "name is required" });
  const region = cleanName(params.region).slice(0, 60);
  const holeCount = clamp(Number(params.holes) || 18, 1, MAX_HOLES);

  const query = `${name}${region ? " " + region : ""} golf signature hole`;

  const provider = pickProvider();
  if (!provider) return json(503, { error: "No search provider configured", query });

  let raw;
  try { raw = await provider.search(query); }
  catch (error) {
    return json(502, { error: "Hole intel search failed", message: (error && error.message) || String(error), provider: provider.name, query });
  }

  const intel = extractHoles(raw, name, holeCount);
  return json(200, { query, provider: provider.name, holeCount, intel, results: raw.length });
};

/* Every "hole 7" / "7th hole" / "the 7th" / "the famous 7th" a result mentions, with the
   character offset so phrase proximity can be measured.
 *
 * The last pattern is a BARE ordinal, which on its own would also match "the 18th century" and
 * "July 4th". Two things keep it honest and both are needed: the ordinal must not be followed
 * by a word that makes it something other than a hole, and - the real filter - phraseNear()
 * still has to find signature language within PROXIMITY characters. A bare ordinal with no
 * such phrase beside it never becomes evidence, so the loose pattern costs nothing and is what
 * catches the commonest phrasing of all: "the famous 5th". */
const NOT_A_HOLE = /^\s*(century|centuries|anniversary|edition|avenue|ave\b|street|st\b|place|floor|birthday|annual|time|grade|amendment)/i;

function holeMentions(text, holeCount) {
  const out = [];
  const patterns = [
    /\bhole\s*(?:no\.?\s*|number\s*|#\s*)?(\d{1,2})\b/gi,
    /\b(\d{1,2})(?:st|nd|rd|th)\s+hole\b/gi,
    /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/gi,
    /\bpar[\s-]?[345][,\s]+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/gi,
    /\b(\d{1,2})(?:st|nd|rd|th)\b/gi
  ];
  patterns.forEach(pattern => {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const hole = Number(match[1]);
      if (!Number.isFinite(hole) || hole < 1 || hole > holeCount) continue;
      if (NOT_A_HOLE.test(text.slice(match.index + match[0].length))) continue;
      out.push({ hole, at: match.index });
    }
  });
  return out;
}

/* The strongest phrase within PROXIMITY of an offset, or null. */
function phraseNear(text, at) {
  const from = Math.max(0, at - PROXIMITY);
  const window = text.slice(from, at + PROXIMITY);
  let best = null;
  PHRASES.forEach(entry => {
    if (!entry.pattern.test(window)) return;
    if (!best || entry.weight > best.weight) best = entry;
  });
  return best;
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 2 && !/^(the|and|golf|club|course|links)$/.test(token));
}

/* One entry per hole that any result named, ordered strongest first.

   Two results agreeing is worth more than one result being emphatic, which is why agreement is
   a separate term rather than a bigger weight. It is capped: three independent pages saying
   "the 7th" is as sure as this gets, and a course whose every page repeats the same sentence
   should not out-certify one that says it once with better words. */
function extractHoles(results, name, holeCount) {
  const nameTokens = tokenize(name);
  const byHole = new Map();

  (Array.isArray(results) ? results : []).forEach(result => {
    const text = `${(result && result.title) || ""} ${(result && result.snippet) || ""}`;
    if (!text.trim()) return;
    /* Does this result appear to be about the course we asked about at all? A generic
       "best signature holes in the world" listicle mentions twenty holes at twenty courses. */
    const lower = text.toLowerCase();
    const onTopic = nameTokens.length === 0 || nameTokens.some(token => lower.includes(token));
    if (!onTopic) return;

    const seenInThisResult = new Set();
    holeMentions(text, holeCount).forEach(mention => {
      const phrase = phraseNear(text, mention.at);
      if (!phrase) return;
      if (seenInThisResult.has(mention.hole)) return;
      seenInThisResult.add(mention.hole);
      const existing = byHole.get(mention.hole) || { hole: mention.hole, weight: 0, agreement: 0, sources: [] };
      existing.weight = Math.max(existing.weight, phrase.weight);
      existing.agreement += 1;
      if (result && result.url && existing.sources.length < 3) existing.sources.push(result.url);
      byHole.set(mention.hole, existing);
    });
  });

  return Array.from(byHole.values())
    .map(entry => ({
      hole: entry.hole,
      confidence: Math.round(Math.min(1, entry.weight * (0.7 + 0.15 * Math.min(entry.agreement, 3))) * 100) / 100,
      agreement: entry.agreement,
      source: entry.sources[0] || "",
      sources: entry.sources
    }))
    .sort((a, b) => b.confidence - a.confidence || b.agreement - a.agreement);
}

function cleanName(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: body == null ? "" : JSON.stringify(body)
  };
}

/* Exported for dev/marketing-hole-intel.test.js — the extraction is the part with rules worth
   pinning, and it is pure. */
exports.extractHoles = extractHoles;
exports.holeMentions = holeMentions;
