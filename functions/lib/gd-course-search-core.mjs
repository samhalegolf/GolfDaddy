/* Course discovery - the pure half of /api/course-search.
 *
 * The picker's search has one job: find a real golf course or club and hand
 * back coordinates we can trust. It does NOT need a scorecard, hole geometry,
 * an OSM polygon or an existing Clarity map to return a valid result - those
 * are the mapping pipeline's business once a course has been chosen. A course
 * that exists only as a Mapbox POI is a perfectly good search result.
 *
 * So discovery is provider-agnostic: Clarity's own course_maps, Mapbox POI
 * search and Nominatim each return listings; this file turns them into one
 * shape, decides which listings are the same place, judges how sure we are
 * that each is a physical course, ranks by what was typed, and decides
 * whether the answer is a list or a "which country?" question.
 *
 * Nothing here does I/O. functions/course-search.mjs fetches; this decides.
 *
 *   SEARCH -> listings -> trustworthy coordinates -> player picks
 *          -> mapping pipeline (existing map | OSM seed | manual/image)
 */

import {
  comparable, displayName, distinctiveTokens, golfTerms, nameMatch, nonCourseSignals, sameNameKind,
  LOCAL_TERMS_BY_COUNTRY, ENGLISH_EXPANSION
} from "./gd-golf-vocabulary.mjs";
import { placeFromAddress } from "./gd-course-place.mjs";

/* ------------------------------------------------------------------ geometry */

export function metres(a, b) {
  const lat1 = Number(a && a.lat), lng1 = Number(a && a.lng), lat2 = Number(b && b.lat), lng2 = Number(b && b.lng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return Infinity;
  const R = 6371000, rad = (x) => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function finite(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function countryCodeOf(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}

/* ------------------------------------------------------------------ providers
 *
 * Every provider row becomes a Listing:
 *   { name, lat, lng, country, countryCode, region, source, providerId,
 *     category: [...], tags: {...}, clarity: {...}|null, osm: {...}|null }
 * Rows with no name or no usable point are dropped: coordinates are the
 * product. */

function listing(fields) {
  const name = displayName(fields.name);
  const lat = finite(fields.lat), lng = finite(fields.lng);
  if (!name || lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return {
    name,
    lat, lng,
    country: displayName(fields.country).slice(0, 80),
    countryCode: countryCodeOf(fields.countryCode),
    region: displayName(fields.region).slice(0, 120),
    source: fields.source,
    providerId: String(fields.providerId || ""),
    category: (fields.category || []).map((c) => String(c || "").toLowerCase()).filter(Boolean),
    tags: fields.tags || {},
    clarity: fields.clarity || null,
    osm: fields.osm || null
  };
}

/* course_maps_list rows. A row with holes is a playable map; a row without is
   a stub the mapper wrote before a run that may have failed, so it may lend
   its identity to a provider listing of the same place but never stands on
   its own (see the picker's databaseCourseHasMap). */
export function listingsFromClarity(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const holeCount = Number(row && row.hole_count) || 0;
    return listing({
      name: row && row.course_name,
      lat: row && (row.course_lat ?? row.finder_lat),
      lng: row && (row.course_lng ?? row.finder_lng),
      country: row && row.country,
      countryCode: row && row.country_code,
      region: row && row.region,
      source: "clarity",
      providerId: "clarity:" + String((row && row.course_id) || ""),
      category: ["golf_course"],
      clarity: {
        id: String((row && row.id) || ""),
        courseId: String((row && row.course_id) || ""),
        holeCount,
        hasMap: holeCount > 0,
        aliases: Array.isArray(row && row.course_aliases) ? row.course_aliases : [],
        facilityKey: String((row && row.facility_key) || ""),
        facilityName: String((row && row.facility_name) || "")
      }
    });
  }).filter(Boolean);
}

/* Mapbox Search Box /forward. GeoJSON features; properties carry the name,
   coordinates, POI categories and a context block with country and region. */
export function listingsFromMapbox(payload) {
  const features = (payload && payload.features) || [];
  return features.map((feature) => {
    const p = (feature && feature.properties) || {};
    const coords = p.coordinates || {};
    const geometry = feature && feature.geometry && Array.isArray(feature.geometry.coordinates) ? feature.geometry.coordinates : [];
    const ctx = p.context || {};
    const categories = [].concat(p.poi_category_ids || [], p.poi_category || [], p.maki ? [p.maki] : []);
    return listing({
      name: p.name || p.name_preferred,
      lat: coords.latitude ?? geometry[1],
      lng: coords.longitude ?? geometry[0],
      country: ctx.country && ctx.country.name,
      countryCode: ctx.country && (ctx.country.country_code || ctx.country.country_code_alpha_2),
      region: ctx.region && ctx.region.name,
      source: "mapbox",
      providerId: "mapbox:" + String(p.mapbox_id || feature.id || ""),
      category: categories,
      tags: { featureType: p.feature_type || "", address: p.full_address || p.place_formatted || "" }
    });
  }).filter(Boolean);
}

/* Nominatim jsonv2 with addressdetails, extratags and namedetails. A result
   whose own class/type is leisure=golf_course IS an OSM course polygon - the
   strongest provider evidence there is, and it costs nothing extra. */
export function listingsFromNominatim(payload) {
  return (Array.isArray(payload) ? payload : []).map((item) => {
    /* Region before town - see gd-course-place.mjs for why. */
    const place = placeFromAddress(item && item.address) || {};
    const named = (item && item.namedetails) || {};
    const name = (item && item.name) || named.name || String((item && item.display_name) || "").split(",")[0];
    const cls = String((item && (item.category || item.class)) || "").toLowerCase();
    const type = String((item && item.type) || "").toLowerCase();
    const extratags = (item && item.extratags) || {};
    return listing({
      name,
      lat: item && item.lat,
      lng: item && item.lon,
      country: place.country,
      countryCode: place.countryCode,
      region: place.region,
      source: "nominatim",
      providerId: "osm:" + String((item && item.osm_type) || "") + ":" + String((item && item.osm_id) || ""),
      category: [cls + "=" + type],
      tags: Object.assign({}, extratags, { [cls]: type }),
      osm: { type: String((item && item.osm_type) || ""), id: finite(item && item.osm_id), cls, kind: type }
    });
  }).filter(Boolean);
}

/* -------------------------------------------------------- golf classification */

const COURSE_CATEGORY = /(^|[^a-z])golf_?course([^a-z]|$)|leisure=golf_course|golf=course/;
const NON_COURSE_CATEGORY = [
  { pattern: /miniature_golf|mini_?golf|minigolf/, kind: "mini", weight: 40 },
  { pattern: /indoor|simulator/, kind: "indoor", weight: 40 },
  { pattern: /shop=golf|sporting_goods|sports_shop|golf_shop|golf_store/, kind: "shop", weight: 35 },
  { pattern: /driving_range|golf=driving_range/, kind: "range", weight: 30 }
];

/* What the listing ITSELF says, before anyone looks at the ground: does its
   name read like a course, does its provider category say golf course, does
   anything say simulator/shop/range? */
export function listingSignals(item) {
  const cat = (item.category || []).join(" ");
  const tagText = Object.keys(item.tags || {}).map((k) => k + "=" + item.tags[k]).join(" ");
  const nameTerms = golfTerms(item.name);
  const categoryCourse = COURSE_CATEGORY.test(cat) || COURSE_CATEGORY.test(tagText);
  const nonCourse = nonCourseSignals(item.name);
  NON_COURSE_CATEGORY.forEach((entry) => {
    if (entry.pattern.test(cat + " " + tagText) && !nonCourse.some((n) => n.kind === entry.kind)) {
      nonCourse.push({ kind: entry.kind, weight: entry.weight });
    }
  });
  if (String((item.tags || {}).indoor || "").toLowerCase() === "yes" && !nonCourse.some((n) => n.kind === "indoor")) {
    nonCourse.push({ kind: "indoor", weight: 40 });
  }
  const golfWord = /golf|골프|ゴルフ|高尔夫|高爾夫|กอล์ฟ|гольф|غولف|جولف/i.test(item.name + " " + cat);
  return {
    golfName: nameTerms.length > 0,
    nameTerms,
    golfCategory: categoryCourse,
    golfRelated: golfWord || categoryCourse || nameTerms.length > 0,
    nonCourse,
    osmCoursePolygon: !!(item.osm && /^(way|relation)$/.test(item.osm.type) && (item.osm.cls === "leisure" && item.osm.kind === "golf_course" || item.osm.cls === "golf" && item.osm.kind === "course"))
  };
}

/* A listing worth keeping at all: something about it is golf. Mapbox and
   Nominatim answer free text with streets, suburbs and cafés too. */
export function isGolfListing(item) {
  if (item.source === "clarity") return true;
  return listingSignals(item).golfRelated;
}

/* -------------------------------------------------------------------- dedupe */

/* Two listings are the same place when they are close AND their names agree.
   Close alone is not enough - a resort's North and South courses share a
   clubhouse car park. Names alone are not enough - "Royal Golf Club" exists
   in a dozen countries. */
const SAME_PLACE_M = 600;      /* centroid vs clubhouse pin on a long links */
const SUBSET_SAME_PLACE_M = 250;
/* Canonical order: Clarity's own record, then OSM (permanent, attributable
   coordinates), then Mapbox. */
const SOURCE_RANK = { clarity: 0, nominatim: 1, mapbox: 2 };

function samePlace(a, b) {
  if (a.clarity && b.clarity && a.clarity.courseId && a.clarity.courseId === b.clarity.courseId) return true;
  /* Two different Clarity courses are never merged with each other: they are
     separate records by construction (a multi-course facility's loops). */
  if (a.clarity && b.clarity) return false;
  const d = metres(a, b);
  if (d > SAME_PLACE_M) return false;
  const names = [a.name].concat(a.aliases || []);
  const others = [b.name].concat(b.aliases || []);
  let best = "different";
  names.forEach((x) => others.forEach((y) => {
    const kind = sameNameKind(x, y);
    if (kind === "same") best = "same";
    else if (kind === "subset" && best === "different") best = "subset";
  }));
  if (best === "same") return true;
  /* "Royal Example" (OSM) vs "Royal Example Golf Club - Pro Shop" never gets
     here as a subset because the shop is filtered as non-course; "Te Arai
     Links North" vs "Te Arai Links" does, and is only merged when the Clarity
     side is not part of a facility. */
  if (best === "subset" && d <= SUBSET_SAME_PLACE_M) {
    const facility = (a.clarity && a.clarity.facilityKey) || (b.clarity && b.clarity.facilityKey);
    return !facility;
  }
  return false;
}

/* Collapse listings from every provider into candidates. The canonical record
   wins name, point and identity; every other source adds its id, aliases and
   any place fields the canonical one lacks. */
export function dedupeListings(listings) {
  const sorted = (Array.isArray(listings) ? listings : []).slice()
    .sort((a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9));
  const candidates = [];
  sorted.forEach((item) => {
    const match = candidates.find((c) => samePlace(c, item));
    if (!match) {
      candidates.push(Object.assign({}, item, {
        sources: [item.source],
        providerIds: { [item.source]: item.providerId },
        aliases: (item.clarity && item.clarity.aliases || []).slice(),
        members: [item]
      }));
      return;
    }
    if (!match.sources.includes(item.source)) match.sources.push(item.source);
    if (!match.providerIds[item.source]) match.providerIds[item.source] = item.providerId;
    if (comparable(item.name) !== comparable(match.name) && !match.aliases.includes(item.name)) match.aliases.push(item.name);
    if (!match.countryCode && item.countryCode) { match.countryCode = item.countryCode; match.country = item.country; }
    if (!match.country && item.country) match.country = item.country;
    if (!match.region && item.region) match.region = item.region;
    match.category = match.category.concat(item.category.filter((c) => !match.category.includes(c)));
    match.tags = Object.assign({}, item.tags, match.tags);
    if (!match.osm && item.osm) match.osm = item.osm;
    /* A Clarity stub lends identity to the provider listing it matched. */
    if (!match.clarity && item.clarity) match.clarity = item.clarity;
    match.members.push(item);
  });
  /* A stub that matched nothing has no evidence it is where it says, and its
     map never got built: leave it out rather than offer a dead row. */
  return candidates.filter((c) => !(c.sources.length === 1 && c.source === "clarity" && !(c.clarity && c.clarity.hasMap)));
}

/* --------------------------------------------------------------- confidence
 *
 * A POI called "Golf Club" may be an outdoor course, a simulator, a shop, a
 * range or a studio. One brittle gate gets this wrong in both directions
 * (OSM is thin in Fiji, Mapbox labels a simulator golf_course), so evidence
 * is added up instead, cheapest first:
 *
 *   +60 existing Clarity map (holes)        -> always confirmed
 *   +50 OSM course polygon (the listing itself, or one nearby)
 *   +40 3+ golf=hole features nearby
 *   +30 3+ greens/tees/fairways/bunkers nearby
 *   +20 large outdoor/recreation footprint nearby
 *   +30 scorecard page with a hole/par table (late, async, ambiguous only)
 *   +15 course words in the name ("golf club", "golfklubb", "골프장")
 *   +15 provider category golf_course
 *   +5  Clarity identity (a stub row agrees this is a course)
 *   -40 indoor / simulator / mini golf
 *   -35 golf shop, -30 range, -15 academy
 *   -30 commercial/industrial ground with no golf or outdoor evidence
 *
 * Absence of OSM data is NEUTRAL. Large parts of the golfing world have no
 * mapped holes; a missing polygon must not hide a real club. */
export const CONFIRMED_AT = 60;
export const LIKELY_AT = 30;
export const CONFIDENCE = { CONFIRMED: "confirmed_course", LIKELY: "likely_course", POSSIBLE: "possible_golf_facility" };

export function scoreCandidate(candidate, ground, scorecard) {
  const signals = listingSignals(candidate);
  const reasons = [];
  let score = 0;
  const add = (points, why) => { score += points; reasons.push((points > 0 ? "+" : "") + points + " " + why); };

  const clarityMap = !!(candidate.clarity && candidate.clarity.hasMap);
  if (clarityMap) add(60, "clarity map");
  else if (candidate.clarity) add(5, "clarity identity");

  const polygonHere = signals.osmCoursePolygon;
  const polygonNear = !!(ground && ground.coursePolygon);
  if (polygonHere || polygonNear) add(50, polygonHere ? "osm course polygon (listing)" : "osm course polygon nearby");

  if (ground && ground.holes >= 3) add(40, ground.holes + " golf holes nearby");
  if (ground && ground.features >= 3) add(30, ground.features + " greens/tees/fairways/bunkers nearby");
  if (ground && ground.outdoorHa >= 15) add(20, Math.round(ground.outdoorHa) + "ha outdoor/recreation nearby");

  if (scorecard && scorecard.confirmed) add(scorecard.strong ? 30 : 20, "scorecard evidence" + (scorecard.holes ? " (" + scorecard.holes + " holes)" : ""));

  if (signals.golfName) add(15, "course name (" + signals.nameTerms.join(", ") + ")");
  if (signals.golfCategory) add(15, "golf course category");

  let nonCourseTotal = 0;
  signals.nonCourse.forEach((n) => {
    /* Strong ground evidence outranks a word: "Royal Golf Club Driving Range"
       sitting on 18 mapped holes is the course's range, listed as part of it. */
    nonCourseTotal += n.weight;
    add(-n.weight, n.kind);
  });

  const groundPositive = !!(ground && (ground.holes >= 3 || ground.features >= 3 || ground.outdoorHa >= 15 || ground.coursePolygon));
  if (ground && ground.commercial && !groundPositive && !polygonHere && !clarityMap) add(-30, "commercial ground, no golf or outdoor evidence");

  const confidence = clarityMap || score >= CONFIRMED_AT ? CONFIDENCE.CONFIRMED
    : score >= LIKELY_AT ? CONFIDENCE.LIKELY : CONFIDENCE.POSSIBLE;
  /* Ambiguous: nothing says "not a course", but nothing cheap says "course"
     strongly enough either. These are what the scorecard check is for. */
  const ambiguous = confidence === CONFIDENCE.POSSIBLE && nonCourseTotal < 30 && signals.golfRelated && !scorecard;
  return { score, confidence, reasons, ambiguous, signals };
}

/* Which candidates the ground check should look at. Clarity maps and OSM
   polygons are already confirmed; checking them again would only spend the
   shared Overpass budget. */
export function needsGroundCheck(candidate) {
  if (candidate.clarity && candidate.clarity.hasMap) return false;
  return !listingSignals(candidate).osmCoursePolygon;
}

/* ------------------------------------------------------------- ground check
 *
 * ONE Overpass query for every candidate that needs it, not one per
 * candidate: the shared Overpass client is throttled to a request every
 * 1.2s, so ten queries would be twelve seconds before the first result. */
export const GROUND = {
  golfRadiusM: 1000,     /* a clubhouse pin to the far end of a links */
  polygonRadiusM: 750,
  outdoorRadiusM: 800,
  commercialRadiusM: 150
};

export function groundCheckQuery(points) {
  const parts = [];
  (points || []).forEach((p) => {
    const at = (r) => "(around:" + r + "," + Number(p.lat).toFixed(6) + "," + Number(p.lng).toFixed(6) + ")";
    parts.push("nwr" + at(GROUND.golfRadiusM) + '["leisure"="golf_course"];');
    parts.push("nwr" + at(GROUND.golfRadiusM) + '["golf"~"^(course|hole|green|tee|fairway|bunker|rough|driving_range)$"];');
    parts.push("way" + at(GROUND.outdoorRadiusM) + '["leisure"~"^(park|nature_reserve|recreation_ground|common)$"];');
    parts.push("way" + at(GROUND.outdoorRadiusM) + '["landuse"~"^(grass|meadow|recreation_ground|forest|village_green|farmland)$"];');
    parts.push("way" + at(GROUND.outdoorRadiusM) + '["natural"~"^(wood|scrub|heath|grassland|sand|wetland|bare_rock)$"];');
    parts.push("way" + at(GROUND.commercialRadiusM) + '["landuse"~"^(commercial|retail|industrial)$"];');
    parts.push("way" + at(60) + '["building"~"^(commercial|retail|industrial|warehouse|office|supermarket)$"];');
  });
  /* `out tags bb`: a name and a box is enough to count holes and estimate an
     area. Full geometry for a few hundred fairways is megabytes for nothing. */
  return "[out:json][timeout:15];(" + parts.join("") + ");out tags bb qt;";
}

function elementBox(el) {
  if (el && el.bounds) return { minLat: el.bounds.minlat, maxLat: el.bounds.maxlat, minLng: el.bounds.minlon, maxLng: el.bounds.maxlon };
  const lat = Number(el && el.lat), lng = Number(el && el.lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { minLat: lat, maxLat: lat, minLng: lng, maxLng: lng } : null;
}

/* Metres from a point to a box (0 inside it). */
function metresToBox(point, box) {
  const lat = Math.min(Math.max(point.lat, box.minLat), box.maxLat);
  const lng = Math.min(Math.max(point.lng, box.minLng), box.maxLng);
  return metres(point, { lat, lng });
}

function boxHectares(box) {
  const h = metres({ lat: box.minLat, lng: box.minLng }, { lat: box.maxLat, lng: box.minLng });
  const w = metres({ lat: box.minLat, lng: box.minLng }, { lat: box.minLat, lng: box.maxLng });
  return (h * w) / 10000;
}

/* Attribute one Overpass answer back to each candidate point. */
export function groundEvidence(payload, point) {
  const out = { coursePolygon: null, holes: 0, features: 0, outdoorHa: 0, commercial: false, holeRefs: [] };
  const seenHoles = new Set();
  ((payload && payload.elements) || []).forEach((el) => {
    const tags = (el && el.tags) || {};
    const box = elementBox(el);
    if (!box) return;
    const d = metresToBox(point, box);
    const golf = String(tags.golf || "");
    if ((tags.leisure === "golf_course" || golf === "course") && el.type !== "node") {
      if (d <= GROUND.polygonRadiusM && (!out.coursePolygon || d < out.coursePolygon.distanceM)) {
        out.coursePolygon = { distanceM: Math.round(d), name: String(tags.name || ""), osmType: el.type, osmId: el.id };
      }
      if (d <= GROUND.outdoorRadiusM) out.outdoorHa += Math.min(200, boxHectares(box));
      return;
    }
    if (golf === "hole") {
      if (d <= GROUND.golfRadiusM) {
        /* Count distinct holes by ref where tagged; a two-course facility
           has two hole 1s, which is still evidence of holes. */
        const key = (tags.ref || "") + "|" + el.type + el.id;
        if (!seenHoles.has(key)) { seenHoles.add(key); out.holes += 1; if (tags.ref) out.holeRefs.push(String(tags.ref)); }
      }
      return;
    }
    if (/^(green|tee|fairway|bunker|rough)$/.test(golf)) {
      if (d <= GROUND.golfRadiusM) out.features += 1;
      return;
    }
    if (golf === "driving_range") return;
    if (/^(commercial|retail|industrial)$/.test(String(tags.landuse || "")) || tags.building) {
      if (d <= GROUND.commercialRadiusM) out.commercial = true;
      return;
    }
    if (d <= GROUND.outdoorRadiusM) out.outdoorHa += Math.min(200, boxHectares(box));
  });
  out.outdoorHa = Math.round(out.outdoorHa * 10) / 10;
  return out;
}

/* ---------------------------------------------------------- scorecard check
 *
 * The late fallback for an ambiguous candidate: does a web page about it show
 * a golf hole table? We do not rebuild the scorecard - a page that clearly
 * lists 9 or 18 holes with pars is enough to say "there are golf holes here".
 * Fed by the existing web-search client (lib/gd-web-search.js); snippets
 * first, and one page fetch only if the snippets were inconclusive. */
export function scorecardEvidence(texts, name) {
  const want = distinctiveTokens(name);
  let best = { confirmed: false, strong: false, holes: 0, url: "" };
  (Array.isArray(texts) ? texts : []).forEach((entry) => {
    const body = String((entry && entry.text) || "").replace(/\s+/g, " ");
    if (!body) return;
    const folded = comparable(body);
    /* The page has to be about THIS club: its distinctive words present. */
    const about = want.tokens.every((t) => (" " + folded + " ").includes(" " + t + " "));
    if (!about) return;
    const holeTable = /(?:^|\D)1\D{1,40}2\D{1,40}3\D{1,40}4\D{1,40}5\D{1,40}6\D{1,40}7\D{1,40}8\D{1,40}9(?:\D|$)/.test(body);
    const par = /\bpar\s*(?:3|4|5|[2-7]\d)\b|\bpar\b|파\s?\d|パー|標準桿|标准杆/i.test(body);
    const holesMatch = body.match(/\b(9|18|27|36)[- ]?holes?\b|\b(9|18|27|36)\s*홀|(9|18|27|36)\s*ホール|(9|18|27|36)\s*洞/i);
    const holes = holesMatch ? Number(holesMatch[1] || holesMatch[2] || holesMatch[3] || holesMatch[4]) : 0;
    const extras = /\b(?:slope|course rating|stroke index|handicap|hcp|yardage|yards|metres|meters)\b/i.test(body);
    const strong = (holeTable && par) || (holes >= 9 && par && extras);
    const confirmed = strong || (holes >= 9 && (par || extras)) || /\bscorecard\b/i.test(body) && par && holes >= 9;
    if (confirmed && (!best.confirmed || (strong && !best.strong))) {
      best = { confirmed: true, strong: !!strong, holes: holes || (holeTable ? 9 : 0), url: String(entry.url || "") };
    }
  });
  return best;
}

/* ------------------------------------------------------------------ ranking
 *
 * With a typed query the question the player asked is "which of these is the
 * thing I named?", so the order is, roughly:
 *   exact full name > strong name > selected country > selected region
 *   > physical-course evidence > golf category > Clarity identity
 *   > Clarity map > proximity (weak tie-break only)
 * A partial match next door never outranks the exact name further away. */
const TIER = { exact: 4, strong: 3, partial: 2, none: 0 };

export function rankCandidates(candidates, request) {
  const query = request.query || "";
  const cc = countryCodeOf(request.countryCode);
  const region = comparable(request.region || "");
  const near = request.near && Number.isFinite(Number(request.near.lat)) ? request.near : null;
  return (candidates || []).map((c) => {
    const names = [c.name].concat(c.aliases || []);
    const match = names.map((n) => nameMatch(query, n)).sort((a, b) => b.score - a.score)[0] || { tier: "none", score: 0 };
    const countryHit = cc && c.countryCode === cc ? 1 : 0;
    const regionHit = region && comparable(c.region).includes(region) ? 1 : 0;
    const evidence = c.confidence === CONFIDENCE.CONFIRMED ? 2 : c.confidence === CONFIDENCE.LIKELY ? 1 : 0;
    const distance = near ? metres(near, c) : Infinity;
    /* 0..9, falling with log-distance: only ever a tie-break. */
    const proximity = Number.isFinite(distance) ? Math.max(0, 9 - Math.log10(Math.max(1, distance))) : 0;
    const rank = TIER[match.tier] * 100000
      + match.score * 1000
      + countryHit * 400
      + regionHit * 200
      + evidence * 40
      + (listingSignals(c).golfCategory ? 20 : 0)
      + (c.clarity ? 10 : 0)
      + (c.clarity && c.clarity.hasMap ? 5 : 0)
      + proximity;
    return Object.assign(c, { nameMatch: match.tier, nameScore: match.score, rank, distanceM: Number.isFinite(distance) ? Math.round(distance) : null });
  }).sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
}

/* -------------------------------------------------------------- the ladder
 *
 *   1. the exact text
 *   2. the exact text, restricted to the provider's golf-course category
 *   3. a relaxed name (club words dropped, "golf" kept as context)
 *   4. alias / translation variants for the selected country
 * A rung runs only when everything before it came back weak. */
export function isWeak(candidates, query) {
  const good = (candidates || []).filter((c) => {
    const m = nameMatch(query, c.name);
    return (m.tier === "exact" || m.tier === "strong") && listingSignals(c).golfRelated;
  });
  return good.length === 0;
}

export function relaxedQuery(query) {
  const d = distinctiveTokens(query);
  if (d.short) return "";
  const core = d.tokens.join(" ");
  return core && core !== comparable(query) ? core + " golf" : "";
}

export function aliasQueries(query, countryCode, max = 2) {
  const d = distinctiveTokens(query);
  if (d.short) return [];
  const core = d.tokens.join(" ");
  const terms = (LOCAL_TERMS_BY_COUNTRY[countryCodeOf(countryCode)] || []).concat(ENGLISH_EXPANSION);
  const typed = comparable(query);
  const out = [];
  terms.forEach((term) => {
    const q = core + " " + term;
    if (comparable(q) !== typed && !out.includes(q)) out.push(q);
  });
  return out.slice(0, max);
}

/* ---------------------------------------------------------------- grouping
 *
 * Worldwide ambiguity ("Royal Golf Club") is condensed into a country choice
 * rather than a long flat list. Data-driven, never keyed to a course:
 *   - 3+ countries                       -> countries first
 *   - more than LIST_MAX results in 2+   -> countries first
 *   - otherwise                          -> the list
 * Inside a chosen (or requested) country the same rule applies to regions. */
export const LIST_MAX = 8;
export const MAX_GROUPS = 6;

function groupBy(results, keyOf, labelOf, max) {
  const byKey = new Map();
  results.forEach((r) => {
    const key = keyOf(r) || "";
    if (!byKey.has(key)) byKey.set(key, { key, label: labelOf(r) || "", count: 0 });
    byKey.get(key).count += 1;
  });
  const known = [...byKey.values()].filter((g) => g.key).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const unknown = byKey.get("");
  const shown = known.slice(0, max - (known.length > max || unknown ? 1 : 0));
  const rest = known.slice(shown.length);
  const otherCount = rest.reduce((n, g) => n + g.count, 0) + (unknown ? unknown.count : 0);
  const groups = shown.map((g) => ({ key: g.key, label: g.label, count: g.count }));
  if (otherCount) groups.push({ key: "other", label: "", count: otherCount, other: true, keys: rest.map((g) => g.key) });
  return { groups, distinct: known.length };
}

export function groupResults(results, request) {
  const list = Array.isArray(results) ? results : [];
  const cc = countryCodeOf(request && request.countryCode);
  const regionAsked = !!(request && request.region);
  if (!cc) {
    const { groups, distinct } = groupBy(list, (r) => r.countryCode, (r) => r.country || r.countryCode, MAX_GROUPS);
    const mode = distinct >= 3 || (list.length > LIST_MAX && distinct >= 2) ? "countries" : "list";
    return {
      mode,
      countries: groups.map((g) => Object.assign(g, { countryCode: g.other ? "" : g.key, regions: regionGroups(list.filter((r) => g.other ? !r.countryCode || g.keys.includes(r.countryCode) : r.countryCode === g.key)) }))
    };
  }
  if (regionAsked) return { mode: "list", countries: [] };
  const regions = regionGroups(list);
  return { mode: regions.length ? "regions" : "list", countries: [], regions };
}

/* Regions only when they would actually condense a long list. */
function regionGroups(list) {
  if (list.length <= LIST_MAX) return [];
  const { groups, distinct } = groupBy(list, (r) => comparable(r.region), (r) => r.region, MAX_GROUPS);
  return distinct >= 2 ? groups : [];
}

/* ------------------------------------------------------------------ output */

/* The shape the picker consumes. Provider names never reach a player-facing
   string; `source` is the canonical provider, kept for the selection payload
   and the debug view. */
export function publicResult(c) {
  return {
    name: c.name,
    lat: c.lat,
    lng: c.lng,
    country: c.country,
    countryCode: c.countryCode,
    region: c.region,
    source: c.source,
    providerId: c.providerId,
    confidence: c.confidence,
    courseId: c.clarity ? c.clarity.courseId : null,
    hasMap: !!(c.clarity && c.clarity.hasMap),
    holeCount: c.clarity ? c.clarity.holeCount || null : null,
    facilityKey: c.clarity ? c.clarity.facilityKey || "" : "",
    facilityName: c.clarity ? c.clarity.facilityName || "" : "",
    osmType: c.osm ? c.osm.type : (c.ground && c.ground.coursePolygon ? c.ground.coursePolygon.osmType : ""),
    osmId: c.osm ? c.osm.id : (c.ground && c.ground.coursePolygon ? c.ground.coursePolygon.osmId : null),
    nameMatch: c.nameMatch,
    ambiguous: !!c.ambiguous
  };
}

export function debugResult(c) {
  return Object.assign(publicResult(c), {
    score: c.score,
    reasons: c.reasons,
    sources: c.sources,
    providerIds: c.providerIds,
    aliases: c.aliases,
    ground: c.ground || null,
    groundStatus: c.groundStatus || "skipped",
    golfName: !!(c.signals && c.signals.golfName),
    golfCategory: !!(c.signals && c.signals.golfCategory),
    nonCourse: c.signals ? c.signals.nonCourse.map((n) => n.kind) : []
  });
}

/* Player search shows confirmed and likely courses; the rest is for the
   admin debug view (and the scorecard check, which may promote them). */
export function playerVisible(c) {
  return c.confidence === CONFIDENCE.CONFIRMED || c.confidence === CONFIDENCE.LIKELY;
}
