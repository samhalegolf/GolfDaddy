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

   Configure one of:
     BRAVE_SEARCH_API_KEY
     GOOGLE_CSE_KEY + GOOGLE_CSE_ID */

const { safeRemoteUrl } = require("./lib/safe-remote-url");

const MAX_RESULTS = 8;
const PROVIDER_FETCH_COUNT = 15;

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
  const query = `${name}${region ? " " + region : ""} golf scorecard hole by hole par`;

  const provider = pickProvider();
  if (!provider) {
    return json(503, { error: "No search provider configured", query });
  }

  let raw;
  try {
    raw = await provider.search(query);
  } catch (error) {
    return json(502, {
      error: "Scorecard search failed",
      message: (error && error.message) || String(error),
      provider: provider.name,
      query
    });
  }

  const results = rankResults(raw, name)
    .slice(0, limit)
    .map(result => ({ url: result.url, title: result.title, snippet: result.snippet }));

  return json(200, { query, provider: provider.name, results });
};

function pickProvider() {
  if (env("BRAVE_SEARCH_API_KEY")) return { name: "brave", search: searchBrave };
  if (env("GOOGLE_CSE_KEY") && env("GOOGLE_CSE_ID")) return { name: "google-cse", search: searchGoogleCse };
  return null;
}

async function searchBrave(query) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(PROVIDER_FETCH_COUNT));
  const res = await fetch(url.href, {
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": env("BRAVE_SEARCH_API_KEY")
    }
  });
  if (!res.ok) throw new Error("Brave search returned " + res.status);
  const body = await res.json();
  const items = (body && body.web && body.web.results) || [];
  return items.map(item => ({
    url: item && item.url,
    title: stripTags(item && item.title),
    snippet: stripTags(item && item.description)
  }));
}

async function searchGoogleCse(query) {
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", env("GOOGLE_CSE_KEY"));
  url.searchParams.set("cx", env("GOOGLE_CSE_ID"));
  url.searchParams.set("q", query);
  url.searchParams.set("num", "10"); // CSE hard-caps at 10 per request
  const res = await fetch(url.href, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error("Google CSE returned " + res.status);
  const body = await res.json();
  const items = (body && body.items) || [];
  return items.map(item => ({
    url: item && item.link,
    title: stripTags(item && item.title),
    snippet: stripTags(item && item.snippet)
  }));
}

/* Reorders provider results so the pages most likely to hold a hole-by-hole table
   come first, and drops anything the fetcher would refuse anyway - no point
   handing back a URL that /api/scorecard-fetch will reject. */
function rankResults(results, name) {
  const nameTokens = tokenize(name);
  const seen = new Set();
  const scored = [];

  (results || []).forEach((result, index) => {
    const parsed = safeRemoteUrl(result && result.url);
    if (!parsed) return;
    const key = parsed.href.replace(/\/+$/, "");
    if (seen.has(key)) return;
    seen.add(key);

    const haystack = `${parsed.href} ${result.title || ""} ${result.snippet || ""}`;
    let score = 0;
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

    scored.push({ url: parsed.href, title: result.title || "", snippet: result.snippet || "", score });
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

function stripTags(value) {
  return String(value == null ? "" : value).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
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
