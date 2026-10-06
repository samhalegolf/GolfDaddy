"use strict";

/* Finds candidate scorecard pages for a course by name.

   The client used to guess URLs from the course name - `${slug}golf.co.nz`,
   `golfify.io/courses/${slug}` - which only works for courses whose domain happens
   to match their name. This runs a real web search server-side and hands back URLs
   that actually exist. Search runs here rather than in the page for the same reason
   scorecard-fetch does: search APIs need a secret key and send no CORS headers.

   It deliberately returns URLs, not page text. The caller feeds them back through
   /api/scorecard-fetch and the existing parsers, so there is one fetch path and one
   set of parsers rather than two.

   Provider selection and the Brave/Google-CSE calls live in ./lib/gd-web-search.js, shared
   with functions/marketing-hole-intel.mjs. Configure one of BRAVE_SEARCH_API_KEY, or
   GOOGLE_CSE_KEY + GOOGLE_CSE_ID. */

const { safeRemoteUrl } = require("./lib/safe-remote-url");
const { isBlockedHost } = require("./lib/gd-polite-fetch");
const { pickProvider } = require("./lib/gd-web-search");
const {
  buildCourseSearchIdentity, buildSearchQueries, domainQueries, scoreSearchCandidate
} = require("./lib/gd-course-search-identity");

const MAX_RESULTS = 8;

/* Pages that tend to carry a full hole-by-hole table. */
const SCORECARD_HINTS = [
  { pattern: /scorecard|score-card/i, weight: 6 },
  { pattern: /hole-by-hole|holebyhole/i, weight: 5 },
  { pattern: /\bcourse\b|\bholes?\b/i, weight: 2 },
  { pattern: /\bpar\b|\bstroke.?index\b|\byardage\b|\bmetres\b/i, weight: 2 }
];

/* Pages that match the words but never carry the table. */
const SCORECARD_PENALTIES = [
  { pattern: /\bnews\b|\bblog\b|\bevent|\bmembership\b|\bshop\b|\bcontact\b/i, weight: 4 },
  { pattern: /facebook\.com|instagram\.com|x\.com|twitter\.com|youtube\.com|tripadvisor\./i, weight: 12 }
];

exports.handler = async function scorecardSearch(event) {
  if (event.httpMethod === "OPTIONS") {
    return json(204, null);
  }
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { error: "Invalid JSON" });
  }

  const name = cleanName(payload && payload.name);
  if (!name) return json(400, { error: "Course name required" });

  const region = cleanName(payload && payload.region).slice(0, 60);
  const limit = clamp(Number(payload && payload.limit) || MAX_RESULTS, 1, MAX_RESULTS);
  const identity = buildCourseSearchIdentity(Object.assign({}, payload && payload.identity, {
    courseName: name,
    region: (payload && payload.identity && payload.identity.region) || region,
    country: payload && (payload.country || (payload.identity && payload.identity.country)),
    countryCode: payload && (payload.countryCode || (payload.identity && payload.identity.countryCode)),
    lat: payload && (payload.lat != null ? payload.lat : payload.identity && payload.identity.lat),
    lng: payload && (payload.lng != null ? payload.lng : payload.identity && payload.identity.lng)
  }));
  const queryPlan = buildSearchQueries(identity, { max: 12 });
  const query = queryPlan[0] && queryPlan[0].query;

  const provider = pickProvider();
  if (!provider) {
    return json(503, { error: "No search provider configured", query });
  }

  let raw;
  try {
    const batches = [];
    raw = [];
    /* Three at a time avoids bursting a provider with the full ladder. Stop once
       identity evidence exposes a strong official domain; its internal search is
       more useful than spending the rest of the broad queries. */
    for (let offset = 0; offset < queryPlan.length; offset += 3) {
      const next = await Promise.all(queryPlan.slice(offset, offset + 3).map(item => provider.search(item.query)
        .then(results => ({ item, results: results || [], error: null }))
        .catch(error => ({ item, results: [], error: String(error && error.message || error).slice(0, 160) }))));
      batches.push(...next);
      raw.push(...next.flatMap(batch => batch.results.map(result => Object.assign({}, result, {
        matchedQuery: batch.item.query, queryKind: batch.item.kind
      }))));
      if (rankResults(raw, identity).some(result => result.identityScore
        && result.identityScore.officialDomain && result.score >= 65)) break;
    }

    /* Once the broad ladder exposes a likely official host, search inside it. The
       course page often has a generic title and is invisible to exact-name ranking. */
    const firstRank = rankResults(raw, identity);
    const officialDomains = [...new Set(firstRank.filter(result => result.identityScore && result.identityScore.officialDomain)
      .map(result => { try { return new URL(result.url).hostname.replace(/^www\./, ""); } catch (e) { return ""; } })
      .filter(Boolean))].slice(0, 2);
    const insidePlan = officialDomains.flatMap(domain => domainQueries(domain, identity).slice(0, 3));
    const inside = await Promise.all(insidePlan.map(item => provider.search(item.query)
      .then(results => ({ item, results: results || [], error: null }))
      .catch(error => ({ item, results: [], error: String(error && error.message || error).slice(0, 160) }))));
    raw = raw.concat(inside.flatMap(batch => batch.results.map(result => Object.assign({}, result, {
      matchedQuery: batch.item.query, queryKind: batch.item.kind, official: true
    }))));
    payload.__trace = {
      queries: batches.concat(inside).map(batch => ({ query: batch.item.query, kind: batch.item.kind, results: batch.results.length, error: batch.error })),
      domainsDiscovered: officialDomains
    };
  } catch (error) {
    return json(502, {
      error: "Scorecard search failed",
      message: (error && error.message) || String(error),
      provider: provider.name,
      query
    });
  }

  const results = rankResults(raw, identity)
    .slice(0, limit)
    .map(result => ({
      url: result.url, title: result.title, snippet: result.snippet,
      matchedQuery: result.matchedQuery || "", queryKind: result.queryKind || "",
      candidateScore: result.score,
      scoreReasons: result.identityScore ? result.identityScore.reasons : []
    }));

  return json(200, {
    query, provider: provider.name, identity,
    queries: (payload.__trace && payload.__trace.queries) || [],
    domainsDiscovered: (payload.__trace && payload.__trace.domainsDiscovered) || [],
    results
  });
};

/* Reorders provider results so the pages most likely to hold a hole-by-hole table
   come first, and drops anything the fetcher would refuse anyway - no point
   handing back a URL that /api/scorecard-fetch will reject. */
function rankResults(results, identity) {
  const nameTokens = (identity.aliases || []).flatMap(tokenize);
  const seen = new Set();
  const scored = [];

  (results || []).forEach((result, index) => {
    const parsed = safeRemoteUrl(result && result.url);
    if (!parsed || isBlockedHost(parsed)) return;
    const key = parsed.href.replace(/\/+$/, "");
    if (seen.has(key)) return;
    seen.add(key);

    const haystack = `${parsed.href} ${result.title || ""} ${result.snippet || ""}`;
    const identityScore = scoreSearchCandidate(result, identity);
    let score = identityScore.score;
    SCORECARD_HINTS.forEach(hint => {
      if (hint.pattern.test(haystack)) score += hint.weight;
    });
    SCORECARD_PENALTIES.forEach(penalty => {
      if (penalty.pattern.test(haystack)) score -= penalty.weight;
    });

    /* A result on a host that echoes the club name is far more likely to be the
       club's own site than an aggregator that merely mentions it. */
    const host = parsed.hostname.toLowerCase().replace(/[^a-z0-9]/g, "");
    const hostHits = nameTokens.filter(token => host.includes(token)).length;
    score += hostHits * 3;

    const titleTokens = tokenize(result.title);
    score += nameTokens.filter(token => titleTokens.includes(token)).length;

    /* Keep the provider's own ordering as the tiebreak. */
    score -= index * 0.1;

    scored.push({
      url: parsed.href, title: result.title || "", snippet: result.snippet || "", score,
      matchedQuery: result.matchedQuery || "", queryKind: result.queryKind || "", identityScore
    });
  });

  return scored.sort((a, b) => b.score - a.score);
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 2 && !/^(the|and|golf|club|course|links)$/.test(token));
}

function cleanName(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, 120);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function env(name) {
  return process.env[name] || "";
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: body == null ? "" : JSON.stringify(body)
  };
}
