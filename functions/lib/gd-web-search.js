"use strict";

/* The one web-search client. Extracted verbatim from functions/scorecard-search.js when
   functions/marketing-hole-intel.mjs needed the same Brave/Google-CSE selection - two copies
   of a provider block is exactly the shape of duplication that lets one of them keep an old
   key name or an old result field after the other is fixed.

   Configure one of:
     BRAVE_SEARCH_API_KEY
     GOOGLE_CSE_KEY + GOOGLE_CSE_ID

   pickProvider() returns null when neither is set. That is a configuration answer, not an
   error: both callers turn it into a 503 with the query they would have run, so an operator
   can see what was asked for. */

const PROVIDER_FETCH_COUNT = 15;

function env(name) {
  return process.env[name] || "";
}

function stripTags(value) {
  return String(value == null ? "" : value).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

async function searchBrave(query, count) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count || PROVIDER_FETCH_COUNT));
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

/* Image search, for scorecards that only exist as pictures. Same shape from both
   providers: the image itself, the page it sits on, and its size when known. */
async function searchBraveImages(query, count) {
  const url = new URL("https://api.search.brave.com/res/v1/images/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count || 20));
  /* A course's card can be hosted anywhere, not just in its own country. */
  url.searchParams.set("country", "ALL");
  const res = await fetch(url.href, {
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": env("BRAVE_SEARCH_API_KEY")
    }
  });
  if (!res.ok) throw new Error("Brave image search returned " + res.status);
  const body = await res.json();
  return ((body && body.results) || []).map(item => ({
    imageUrl: item && item.properties && item.properties.url,
    thumbnailUrl: item && item.thumbnail && item.thumbnail.src,
    pageUrl: item && item.url,
    title: stripTags(item && item.title),
    width: Number(item && item.properties && item.properties.width) || null,
    height: Number(item && item.properties && item.properties.height) || null,
    confidence: (item && item.confidence) || null
  }));
}

async function searchGoogleCseImages(query) {
  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", env("GOOGLE_CSE_KEY"));
  url.searchParams.set("cx", env("GOOGLE_CSE_ID"));
  url.searchParams.set("q", query);
  url.searchParams.set("searchType", "image");
  url.searchParams.set("num", "10");
  const res = await fetch(url.href, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error("Google CSE image search returned " + res.status);
  const body = await res.json();
  return ((body && body.items) || []).map(item => ({
    imageUrl: item && item.link,
    thumbnailUrl: item && item.image && item.image.thumbnailLink,
    pageUrl: item && item.image && item.image.contextLink,
    title: stripTags(item && item.title),
    width: Number(item && item.image && item.image.width) || null,
    height: Number(item && item.image && item.image.height) || null,
    confidence: null
  }));
}

function pickProvider() {
  if (env("BRAVE_SEARCH_API_KEY")) return { name: "brave", search: searchBrave, searchImages: searchBraveImages };
  if (env("GOOGLE_CSE_KEY") && env("GOOGLE_CSE_ID")) return { name: "google-cse", search: searchGoogleCse, searchImages: searchGoogleCseImages };
  return null;
}

module.exports = { pickProvider, stripTags, PROVIDER_FETCH_COUNT };
