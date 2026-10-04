/* GET /api/course-search?q=&country=&region=&lat=&lng=&debug=1
 * GET /api/course-search?confirm=1&name=&lat=&lng=&region=&country=
 *
 * Course discovery for the picker. Find a real golf course or club, return
 * coordinates we can trust - nothing more. Scorecards, holes and OSM polygons
 * are the mapping pipeline's concern after the player has chosen; a club that
 * exists only as a Mapbox POI is a valid answer here.
 *
 * Server side, not in the picker, because:
 *   - Mapbox needs the token and Nominatim/Overpass need an identifying
 *     User-Agent and a rate limiter, which live here;
 *   - the picker should send one query and get one normalised answer, not
 *     orchestrate three providers and reconcile them itself.
 *
 * Providers, all ones this project already uses:
 *   Clarity    course_maps_list (published rows; a row with holes is a map)
 *   Mapbox     Search Box /forward, POIs only (MAPBOX_PUBLIC_TOKEN)
 *   Nominatim  OSM place search
 * plus, for confidence only:
 *   Overpass   one batched ground check (golf holes, greens, outdoor space)
 *   web search the existing scorecard search provider, ?confirm=1 only
 *
 * Fail-soft throughout. Any provider can be down, unconfigured or rate
 * limited; the answer is then whatever the others found, and diagnostics say
 * which one was missing. The pure decisions are in lib/gd-course-search-core.mjs. */

import { createRequire } from "node:module";
import { fetchOverpass } from "./lib/gd-overpass-client.mjs";
import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";
import { distinctiveTokens, searchText } from "./lib/gd-golf-vocabulary.mjs";
import {
  CONFIDENCE, aliasQueries, debugResult, dedupeListings, groundCheckQuery, groundEvidence,
  groupResults, isGolfListing, isWeak, listingsFromClarity, listingsFromMapbox,
  listingsFromNominatim, needsGroundCheck, playerVisible, publicResult, rankCandidates,
  relaxedQuery, scoreCandidate, scorecardEvidence
} from "./lib/gd-course-search-core.mjs";

const require = createRequire(import.meta.url);
const { pickProvider, stripTags } = require("./lib/gd-web-search.js");
const { safeRemoteUrl, resolvesToPublicAddress } = require("./lib/safe-remote-url.js");

const LIST_VIEW = "course_maps_list";
const CLARITY_COLUMNS = "id,course_id,course_name,course_lat,course_lng,finder_lat,finder_lng,region,country,country_code,facility_key,facility_name,course_aliases,hole_count";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const MAPBOX_FORWARD_URL = "https://api.mapbox.com/search/searchbox/v1/forward";
const USER_AGENT = "ClarityCaddyCourseSearch/1 (golf course discovery; contact samhalegolf@gmail.com)";
const PROVIDER_TIMEOUT_MS = 5000;
const GROUND_TIMEOUT_MS = 8000;
const GROUND_MAX = 10;
const RESULT_MAX = 40;

function env(name) { return process.env[name] || ""; }

/* Same variable and same rule as lib/gd-mapbox-source.mjs (a public pk. token,
   never an sk.), read here rather than imported: that module pulls in the
   tile/image stack, which a search function has no use for. */
const MAPBOX_TOKEN_ENV = "MAPBOX_PUBLIC_TOKEN";
function mapboxToken() {
  const token = env(MAPBOX_TOKEN_ENV).trim();
  return token.startsWith("pk.") ? token : "";
}
function mapboxStatusText() {
  const raw = env(MAPBOX_TOKEN_ENV).trim();
  if (!raw) return MAPBOX_TOKEN_ENV + " is not set";
  return raw.startsWith("pk.") ? "configured" : MAPBOX_TOKEN_ENV + " is not a public pk. token";
}
const supabaseFetch = createSupabaseFetch({
  base: () => env("SUPABASE_URL"),
  key: () => env("SUPABASE_SERVICE_ROLE_KEY"),
  label: "course-search"
});
function hasSupabase() { return !!(env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY")); }

function json(status, body, cacheSeconds = 300) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      /* What exists under a name does not change on a human timescale; five
         minutes lets a second identical search (Enter, then the button) be
         free without hiding a course mapped today for long. */
      "Cache-Control": cacheSeconds ? "public, max-age=" + cacheSeconds : "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept"
    }
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + " timed out")), ms); })
  ]).finally(() => clearTimeout(timer));
}

async function getJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: Object.assign({ Accept: "application/json" }, headers), signal: controller.signal });
    if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
    return await res.json();
  } finally { clearTimeout(timer); }
}

/* -------------------------------------------------------------- Nominatim
   Usage policy: an identifying User-Agent and at most one request a second.
   This instance queues its own calls; the picker no longer calls Nominatim
   from every phone, so this is now the only caller. */
let nominatimQueue = Promise.resolve();
let nominatimLast = 0;
function nominatim(params) {
  const run = nominatimQueue.then(async () => {
    const wait = Math.max(0, nominatimLast + 1100 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    nominatimLast = Date.now();
    const url = new URL(NOMINATIM_URL);
    Object.entries(Object.assign({ format: "jsonv2", addressdetails: "1", extratags: "1", namedetails: "1", limit: "15", "accept-language": "en" }, params))
      .forEach(([k, v]) => { if (v != null && v !== "") url.searchParams.set(k, String(v)); });
    return getJson(url.href, { "User-Agent": USER_AGENT });
  });
  nominatimQueue = run.catch(() => {});
  return run;
}

/* A region the player chose becomes a bounding box, so providers filter by
   geography rather than by the words "Alberta Canada" glued onto the name. */
async function resolveRegionBox(region, countryCode) {
  if (!region) return null;
  const tryOnce = async (extra) => {
    const rows = await nominatim(Object.assign({ q: region, countrycodes: countryCode ? countryCode.toLowerCase() : "", limit: "1", extratags: "0", namedetails: "0" }, extra));
    const box = Array.isArray(rows) && rows[0] && rows[0].boundingbox;
    if (!Array.isArray(box) || box.length !== 4) return null;
    const [minLat, maxLat, minLng, maxLng] = box.map(Number);
    return [minLat, maxLat, minLng, maxLng].every(Number.isFinite) ? { minLat, maxLat, minLng, maxLng, label: rows[0].display_name || region } : null;
  };
  try {
    return (await tryOnce({ featureType: "state" })) || (await tryOnce({}));
  } catch (error) { return null; }
}

function nominatimParams(text, request, box, opts = {}) {
  const params = { q: text };
  if (request.countryCode) params.countrycodes = request.countryCode.toLowerCase();
  if (box) { params.viewbox = [box.minLng, box.maxLat, box.maxLng, box.minLat].join(","); params.bounded = "1"; }
  if (opts.poiOnly) params.layer = "poi";
  return params;
}

/* ----------------------------------------------------------------- Mapbox
   Search Box forward search, POIs only. A public pk. token is enough. Search
   results are display/selection data under Mapbox's terms; when the same
   course is also in OSM or Clarity, dedupe makes THAT record canonical, so
   Mapbox coordinates only travel onward when nobody else has the course. */
async function mapbox(text, request, box, opts = {}) {
  const token = mapboxToken();
  if (!token) return null;
  const url = new URL(MAPBOX_FORWARD_URL);
  url.searchParams.set("q", text);
  url.searchParams.set("access_token", token);
  url.searchParams.set("limit", "10");
  url.searchParams.set("types", "poi");
  url.searchParams.set("language", "en");
  if (request.countryCode) url.searchParams.set("country", request.countryCode.toLowerCase());
  if (box) url.searchParams.set("bbox", [box.minLng, box.minLat, box.maxLng, box.maxLat].join(","));
  if (request.near) url.searchParams.set("proximity", request.near.lng + "," + request.near.lat);
  if (opts.golfCategory) url.searchParams.set("poi_category", "golf_course");
  return getJson(url.href);
}

/* ---------------------------------------------------------------- Clarity */
async function clarity(text, request) {
  if (!hasSupabase()) return null;
  const d = distinctiveTokens(text);
  /* The longest distinctive word narrows the scan; a short name ("Ba Golf
     Club") searches its whole typed phrase instead of two letters. */
  const needle = (d.short ? text : d.tokens.slice().sort((a, b) => b.length - a.length)[0] || text)
    .replace(/[*,()%"\\]/g, " ").trim();
  if (needle.length < 2) return [];
  let path = LIST_VIEW + "?select=" + CLARITY_COLUMNS + "&published=eq.true"
    + "&course_name=ilike." + encodeURIComponent("*" + needle + "*") + "&limit=50";
  if (request.countryCode) path += "&country_code=eq." + encodeURIComponent(request.countryCode);
  return supabaseFetch(path, { method: "GET" });
}

/* ------------------------------------------------------------------ search */

function parseRequest(url) {
  const p = url.searchParams;
  const lat = Number(p.get("lat")), lng = Number(p.get("lng"));
  const cc = String(p.get("country") || p.get("countryCode") || "").trim().toUpperCase();
  return {
    query: searchText(p.get("q") || p.get("query") || ""),
    countryCode: /^[A-Z]{2}$/.test(cc) ? cc : "",
    region: searchText(p.get("region") || "").slice(0, 80),
    near: Number.isFinite(lat) && Number.isFinite(lng) && p.get("lat") !== null && p.get("lng") !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null,
    debug: p.get("debug") === "1"
  };
}

/* One rung of the ladder: every provider, the same text, in parallel. */
async function runRung(rung, text, request, box, diagnostics, opts = {}) {
  const status = (promise, name) => promise.then((payload) => ({ name, payload, ok: payload != null }))
    .catch((error) => ({ name, payload: null, ok: false, error: String((error && error.message) || error) }));
  const jobs = [status(mapbox(text, request, box, opts), "mapbox"), status(nominatim(nominatimParams(text, request, box, opts)), "nominatim")];
  if (opts.clarity) jobs.push(status(clarity(text, request), "clarity"));
  const answers = await Promise.all(jobs);
  const listings = [];
  const counts = {};
  answers.forEach((a) => {
    const parsed = a.name === "mapbox" ? listingsFromMapbox(a.payload)
      : a.name === "nominatim" ? listingsFromNominatim(a.payload) : listingsFromClarity(a.payload);
    const golf = parsed.filter(isGolfListing);
    counts[a.name] = a.ok ? golf.length : (a.error ? "error: " + a.error : "not configured");
    listings.push(...golf);
  });
  diagnostics.rungs.push({ rung, text, golfCategory: !!opts.golfCategory, counts });
  return listings;
}

async function groundCheck(candidates, diagnostics) {
  const targets = candidates.filter(needsGroundCheck).slice(0, GROUND_MAX);
  if (!targets.length) { diagnostics.ground = { status: "not needed", checked: 0 }; return; }
  try {
    const payload = await withTimeout(fetchOverpass(groundCheckQuery(targets)), GROUND_TIMEOUT_MS, "Overpass");
    targets.forEach((c) => { c.ground = groundEvidence(payload, c); c.groundStatus = "ok"; });
    diagnostics.ground = { status: "ok", checked: targets.length };
  } catch (error) {
    /* No ground evidence is neutral, not negative: the listing's own name and
       category still decide, and a busy Overpass never hides a real club. */
    targets.forEach((c) => { c.groundStatus = "unavailable"; });
    diagnostics.ground = { status: "unavailable", checked: 0, error: String((error && error.message) || error) };
  }
}

export async function searchCourses(request) {
  const started = Date.now();
  const diagnostics = {
    query: request.query, countryCode: request.countryCode, region: request.region,
    mapbox: mapboxStatusText(),
    clarity: hasSupabase() ? "configured" : "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set",
    rungs: []
  };
  const box = await resolveRegionBox(request.region, request.countryCode);
  if (request.region) diagnostics.regionBox = box ? "resolved" : "not found (region used for ranking only)";

  const all = [];
  const evaluate = () => rankCandidates(dedupeListings(all), request);
  all.push(...await runRung(1, request.query, request, box, diagnostics, { clarity: true }));
  if (isWeak(evaluate(), request.query)) {
    all.push(...await runRung(2, request.query, request, box, diagnostics, { golfCategory: true, poiOnly: true }));
  }
  const relaxed = relaxedQuery(request.query);
  if (relaxed && isWeak(evaluate(), request.query)) {
    all.push(...await runRung(3, relaxed, request, box, diagnostics));
  }
  if (isWeak(evaluate(), request.query)) {
    for (const variant of aliasQueries(request.query, request.countryCode)) {
      all.push(...await runRung(4, variant, request, box, diagnostics));
      if (!isWeak(evaluate(), request.query)) break;
    }
  }

  let candidates = evaluate();
  /* A typed search only cares about listings whose name answers it; the
     neighbourhood of a match is /api/courses-near's job. */
  candidates = candidates.filter((c) => c.nameMatch !== "none").slice(0, RESULT_MAX);
  /* A region the provider could not filter by still has to mean something. */
  if (request.countryCode) candidates = candidates.filter((c) => !c.countryCode || c.countryCode === request.countryCode);

  await groundCheck(candidates, diagnostics);
  candidates.forEach((c) => Object.assign(c, scoreCandidate(c, c.ground, null)));
  candidates = rankCandidates(candidates, request);

  const visible = candidates.filter(playerVisible);
  const hidden = candidates.filter((c) => !playerVisible(c));
  const groups = groupResults(visible, request);

  diagnostics.providers = {
    clarity: all.filter((l) => l.source === "clarity").length,
    mapbox: all.filter((l) => l.source === "mapbox").length,
    nominatim: all.filter((l) => l.source === "nominatim").length
  };
  diagnostics.afterDedupe = candidates.length;
  diagnostics.visible = visible.length;
  diagnostics.hidden = hidden.length;
  diagnostics.countries = visible.reduce((acc, c) => { const k = c.countryCode || "?"; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  diagnostics.byConfidence = candidates.reduce((acc, c) => { acc[c.confidence] = (acc[c.confidence] || 0) + 1; return acc; }, {});
  diagnostics.ms = Date.now() - started;

  const body = { query: request.query, countryCode: request.countryCode || null, region: request.region || null, results: visible.map(publicResult), groups, diagnostics };
  /* The admin view: every candidate with its evidence, including the ones a
     player does not see. Ambiguous hidden ones are also listed for everyone
     (name and point only) so the picker can ask ?confirm=1 about them. */
  body.ambiguous = hidden.filter((c) => c.ambiguous && (c.nameMatch === "exact" || c.nameMatch === "strong")).slice(0, 2).map(publicResult);
  if (request.debug) body.debug = { candidates: candidates.map(debugResult) };
  /* Counts are harmless; which keys are configured and raw provider errors are
     for the admin view only. */
  else {
    delete body.diagnostics.mapbox;
    delete body.diagnostics.clarity;
    body.diagnostics.rungs = body.diagnostics.rungs.map((r) => ({ rung: r.rung, text: r.text }));
    if (body.diagnostics.ground) delete body.diagnostics.ground.error;
  }
  return body;
}

/* ---------------------------------------------------------- confirmation
   The late, expensive check for an ambiguous candidate. Snippets first; one
   page fetch only if they were inconclusive. Never run for every result. */
async function fetchPageText(href) {
  const url = safeRemoteUrl(href);
  if (!url || !(await resolvesToPublicAddress(url))) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(url.href, { redirect: "manual", signal: controller.signal, headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 ClarityCaddyCourseSearch/1.0" } });
    if (!res.ok) return "";
    const html = String(await res.text()).slice(0, 400000);
    return stripTags(html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " "));
  } catch (error) { return ""; }
  finally { clearTimeout(timer); }
}

export async function confirmCourse(candidate) {
  const provider = pickProvider();
  if (!provider) return { status: "unavailable", reason: "no web search provider configured", confirmed: false };
  const place = candidate.region || candidate.country || "";
  const query = '"' + candidate.name + '" ' + (place ? place + " " : "") + "golf scorecard";
  let results = [];
  try { results = await withTimeout(provider.search(query, 8), PROVIDER_TIMEOUT_MS, "web search"); }
  catch (error) { return { status: "unavailable", reason: String((error && error.message) || error), confirmed: false }; }
  const texts = results.map((r) => ({ url: r.url, text: (r.title || "") + " " + (r.snippet || "") }));
  let evidence = scorecardEvidence(texts, candidate.name);
  if (!evidence.confirmed && results[0]) {
    const page = await fetchPageText(results[0].url);
    if (page) evidence = scorecardEvidence([{ url: results[0].url, text: (results[0].title || "") + " " + page }], candidate.name);
  }
  const scored = scoreCandidate(Object.assign({ category: [], tags: {}, clarity: null, osm: null }, candidate), null, evidence);
  return {
    status: "ok",
    query,
    confirmed: evidence.confirmed,
    holes: evidence.holes || null,
    url: evidence.url || null,
    /* Scorecard evidence on top of the listing's own name/category; ground
       evidence the caller already had is not re-fetched here. */
    confidence: evidence.confirmed && scored.confidence === CONFIDENCE.POSSIBLE ? CONFIDENCE.LIKELY : scored.confidence
  };
}

export default async function courseSearch(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "GET") return json(405, { error: "Method not allowed" });
  const url = new URL(req.url);

  if (url.searchParams.get("confirm") === "1") {
    const lat = Number(url.searchParams.get("lat")), lng = Number(url.searchParams.get("lng"));
    const name = searchText(url.searchParams.get("name") || "");
    if (!name) return json(400, { error: "name is required" });
    const result = await confirmCourse({
      name, lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
      region: searchText(url.searchParams.get("region") || ""), country: searchText(url.searchParams.get("country") || "")
    });
    return json(200, result, result.status === "ok" ? 3600 : 0);
  }

  const request = parseRequest(url);
  if (request.query.length < 2) return json(400, { error: "q is required" });
  try {
    return json(200, await searchCourses(request), request.debug ? 0 : 300);
  } catch (error) {
    /* Even a total failure answers with an empty, well-formed result: the
       picker still shows its local matches and the player can still play. */
    return json(200, { query: request.query, results: [], groups: { mode: "list", countries: [] }, diagnostics: { error: String((error && error.message) || error) } }, 0);
  }
}

export const config = {
  path: "/api/course-search"
};
