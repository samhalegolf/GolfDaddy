"use strict";

/* Course identity and international scorecard-search primitives.
 *
 * This module is deliberately dependency-free and usable from both the CommonJS
 * search function and the ESM resolver. It preserves local-script names, adds
 * conservative Latin variants when metadata supplies them, and never treats a
 * transliteration as stronger evidence than the original name plus location. */

const LEGAL_SUFFIXES = /\b(?:ltd|limited|inc|incorporated|llc|plc|co\.?|corp(?:oration)?)\b/gi;
const CLUB_SUFFIX = /(?:\s|[.·ㆍ_-])*(?:c\s*\.?\s*c\s*\.?|g\s*\.?\s*c\s*\.?|country\s+club|golf\s+club|golf\s+course)\s*$/i;
const LATIN = /[a-z]/i;
const NON_LATIN = /[^\u0000-\u024f]/;

const SEARCH_LOCALES = {
  KR: ["코스", "스코어카드", "홀", "파", "거리", "코스소개"],
  JP: ["コース", "スコアカード", "ホール", "パー", "距離", "コース紹介"],
  CN: ["球场", "记分卡", "球洞", "标准杆", "距离", "球场介绍"],
  TW: ["球場", "計分卡", "球洞", "標準桿", "距離", "球場介紹"],
  HK: ["球場", "計分卡", "球洞", "標準桿", "距離", "球場介紹"]
};

const COUNTRY_CODES = {
  "south korea": "KR", korea: "KR", 대한민국: "KR", 한국: "KR",
  japan: "JP", 日本: "JP", china: "CN", 中国: "CN",
  taiwan: "TW", 臺灣: "TW", 台湾: "TW", "hong kong": "HK", 香港: "HK"
};

function text(value) {
  return String(value == null ? "" : value).normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
}

function comparable(value) {
  return text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en")
    .replace(LEGAL_SUFFIXES, " ").replace(/[\p{P}\p{S}_]+/gu, " ").replace(/\s+/g, " ").trim();
}

function titleWords(value) {
  return text(value).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
}

function add(set, value) {
  const clean = text(value);
  if (clean) set.set(comparable(clean), clean);
}

/* Lightweight Revised-Romanization approximation for Hangul syllables. This is
   search expansion, not a display-name authority; official/provider English is
   still preferred when present. */
function romanizeHangul(value) {
  const lead = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
  const vowel = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
  const tail = ["", "k", "k", "ks", "n", "nj", "nh", "t", "l", "lk", "lm", "lb", "ls", "lt", "lp", "lh", "m", "p", "ps", "t", "t", "ng", "t", "t", "k", "t", "p", "h"];
  let changed = false;
  const out = [...text(value)].map(char => {
    const code = char.charCodeAt(0) - 0xAC00;
    if (code < 0 || code >= 11172) return char;
    changed = true;
    return lead[Math.floor(code / 588)] + vowel[Math.floor((code % 588) / 28)] + tail[code % 28];
  }).join("");
  return changed ? out : "";
}

function suffixVariants(value) {
  const original = titleWords(value);
  const base = original.replace(CLUB_SUFFIX, "").trim();
  const out = new Map();
  add(out, original);
  if (!base) return [...out.values()];
  const bases = new Map();
  add(bases, base);
  /* Conservative compound handling for common golf-place words. It turns
     Sophiagreen into Sophia Green without trying to segment arbitrary names. */
  add(bases, base.replace(/([a-z])(?=(?:green|links|hills?|lakes?|valley|mountain|park)\b)/ig, "$1 "));
  if (/^[a-z ]+$/i.test(base) && /\s/.test(base)) add(bases, base.replace(/\s+/g, ""));
  [...bases.values()].forEach(baseName => ["", "CC", "Country Club", "Golf Club", "Golf Course"].forEach(suffix => {
    add(out, baseName + (suffix ? " " + suffix : ""));
  }));
  ["CC", "Country Club", "Golf Club", "Golf Course"].forEach(suffix => {
    add(out, base + " " + suffix);
  });
  /* Korean/Japanese names commonly join CC/GC directly to the proper name. */
  if (NON_LATIN.test(base)) add(out, base + "CC");
  return [...out.values()];
}

function inferredCountryCode(course) {
  const direct = text(course && (course.countryCode || course.country_code)).toUpperCase();
  if (/^[A-Z]{2}$/.test(direct)) return direct;
  return COUNTRY_CODES[comparable(course && course.country)] || "";
}

function buildCourseSearchIdentity(course) {
  course = course || {};
  const rawName = text(course.rawName || course.courseName || course.name);
  const osmName = text(course.osmName || course.osm_name || rawName);
  const localName = text(course.localName || course.local_name || (NON_LATIN.test(osmName) ? osmName : ""));
  const englishName = text(course.englishName || course.english_name || course.providerName || (LATIN.test(rawName) ? rawName : ""));
  const aliases = new Map();
  const transliterations = new Map();
  [rawName, osmName, localName, englishName]
    .concat(Array.isArray(course.aliases) ? course.aliases : [])
    .forEach(name => suffixVariants(name).forEach(alias => add(aliases, alias)));
  (Array.isArray(course.transliterations) ? course.transliterations : []).forEach(name => {
    add(transliterations, name);
    suffixVariants(name).forEach(alias => add(aliases, alias));
  });
  [rawName, osmName, localName].forEach(name => {
    const romanized = romanizeHangul(name);
    if (!romanized) return;
    add(transliterations, romanized);
    suffixVariants(romanized).forEach(alias => add(aliases, alias));
  });
  const lat = Number(course.lat != null ? course.lat : course.center && course.center.lat);
  const lng = Number(course.lng != null ? course.lng : course.center && course.center.lng);
  return {
    rawName, osmName, localName, englishName,
    aliases: [...aliases.values()], transliterations: [...transliterations.values()],
    city: text(course.city), region: text(course.region), country: text(course.country),
    countryCode: inferredCountryCode(course),
    lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
    nearbyPlaceNames: (course.nearbyPlaceNames || []).map(text).filter(Boolean),
    expectedHoleCount: Number(course.expectedHoleCount) || null,
    candidateLoopNames: (course.candidateLoopNames || []).map(text).filter(Boolean)
  };
}

function buildSearchQueries(identity, options) {
  identity = identity || {};
  const max = Math.max(1, Number(options && options.max) || 18);
  const queries = new Map();
  const put = (query, kind, alias) => {
    const clean = text(query);
    if (clean && !queries.has(comparable(clean))) queries.set(comparable(clean), { query: clean, kind, alias: alias || "" });
  };
  const local = identity.localName || identity.osmName || identity.rawName;
  const aliases = [];
  const aliasKeys = new Set();
  const pushAlias = value => {
    const clean = text(value), key = comparable(clean);
    if (clean && !aliasKeys.has(key)) { aliasKeys.add(key); aliases.push(clean); }
  };
  pushAlias(local);
  pushAlias(identity.englishName);
  /* Prefer a genuinely split Latin spelling before suffix permutations. */
  (identity.aliases || []).filter(alias => {
    const distinctive = tokens(alias);
    return LATIN.test(alias) && distinctive.length >= 2;
  }).forEach(pushAlias);
  (identity.aliases || []).forEach(pushAlias);
  if (local) {
    put(local + " scorecard", "exact-local", local);
    put(local + " golf course", "local-golf", local);
  }
  const localeTerms = SEARCH_LOCALES[identity.countryCode] || [];
  localeTerms.slice(0, 3).forEach(term => { if (local) put(local + " " + term, "locale", local); });
  aliases.slice(0, 5).forEach(alias => put(alias + " scorecard", "alias-scorecard", alias));
  const place = identity.city || identity.region || identity.country;
  aliases.slice(0, 2).forEach(alias => {
    if (place) put(alias + " " + place + " golf", "location", alias);
  });
  aliases.slice(0, 4).forEach(alias => {
    put(alias + " course", "alias-course", alias);
    put(alias + " hole par", "alias-structure", alias);
  });
  localeTerms.slice(3).forEach(term => { if (local) put(local + " " + term, "locale", local); });
  return [...queries.values()].slice(0, max);
}

function domainQueries(domain, identity) {
  const local = identity.localName || identity.rawName;
  const terms = ["course", "scorecard", "holes", "par"].concat((SEARCH_LOCALES[identity.countryCode] || []).slice(0, 3));
  return terms.map(term => ({ query: "site:" + domain + " " + (local ? local + " " : "") + term, kind: "official-domain", alias: local || "" }));
}

function tokens(value) {
  return comparable(value).split(/\s+/).filter(token => token.length > 1 && !/^(the|and|golf|club|course|country|links|resort|cc|gc)$/.test(token));
}

function similarity(a, b) {
  const ca = comparable(a), cb = comparable(b);
  if (!ca || !cb) return 0;
  if (ca === cb || ca.includes(cb) || cb.includes(ca)) return 1;
  const aa = new Set(tokens(ca)), bb = new Set(tokens(cb));
  if (!aa.size || !bb.size) return 0;
  let shared = 0;
  aa.forEach(token => { if (bb.has(token)) shared += 1; });
  return (2 * shared) / (aa.size + bb.size);
}

function haversineKm(aLat, aLng, bLat, bLng) {
  if (![aLat, aLng, bLat, bLng].every(Number.isFinite)) return null;
  const rad = n => n * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function scoreSearchCandidate(candidate, identity) {
  const haystack = text([candidate.title, candidate.name, candidate.snippet, candidate.url].filter(Boolean).join(" "));
  const aliases = identity.aliases || [];
  const nameSimilarity = aliases.reduce((best, alias) => Math.max(best, similarity(alias, haystack)), 0);
  let score = Math.round(nameSimilarity * 45);
  const reasons = nameSimilarity ? ["name:" + nameSimilarity.toFixed(2)] : [];
  [identity.city, identity.region, identity.country].filter(Boolean).forEach(place => {
    if (comparable(haystack).includes(comparable(place))) { score += 8; reasons.push("location:" + place); }
  });
  if (/scorecard|score-card|hole.by.hole|\bpar\b|스코어카드|코스소개|コース|球場|球场/i.test(haystack)) { score += 12; reasons.push("golf-content"); }
  let host = "";
  try { host = new URL(candidate.url).hostname.replace(/^www\./, ""); } catch (e) {}
  const hostFlat = comparable(host).replace(/\s/g, "");
  const hostMatch = aliases.some(alias => {
    const compact = comparable(alias).replace(/\b(?:golf|club|course|country|links|resort|cc|gc)\b/g, "").replace(/\s/g, "");
    return compact.length >= 4 && hostFlat.includes(compact);
  });
  const knownListing = /(?:golfpass|18birdies|golfshot|swingu|golfify|hole19|tripadvisor|facebook|instagram|youtube)\./i.test(host);
  const likelyOfficial = !!candidate.official || hostMatch || (!knownListing && nameSimilarity >= 0.85);
  if (likelyOfficial) { score += 20; reasons.push("official-domain"); }
  const distanceKm = haversineKm(identity.lat, identity.lng, Number(candidate.lat), Number(candidate.lng));
  if (distanceKm != null) {
    if (distanceKm <= 5) { score += 25; reasons.push("distance:" + distanceKm.toFixed(1) + "km"); }
    else if (distanceKm > 80) { score -= 35; reasons.push("far-away:" + distanceKm.toFixed(0) + "km"); }
  }
  if (/hotel|travel package|nearby courses|directory|tripadvisor/i.test(haystack)) { score -= 10; reasons.push("ambiguous-listing"); }
  return { score, nameSimilarity, distanceKm, officialDomain: likelyOfficial, reasons };
}

function scoreScorecardPage(html, cards) {
  const source = text(String(html || "").replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
  const details = {};
  details.holeSequenceScore = /(?:^|\D)1\D+2\D+3\D+4\D+5\D+6\D+7\D+8\D+9(?:\D|$)/.test(source) ? 20 : 0;
  details.parPatternScore = /(?:\bpar\b|파|パー|標準桿|标准杆)/i.test(source) ? 15 : 0;
  const distances = source.match(/\b(?:[1-6]\d{2}|\d{2})\s*(?:m|metres?|meters?|yds?|yards?)?\b/gi) || [];
  details.distanceTableScore = Math.min(20, distances.length * 2);
  details.teeColumnScore = /\b(?:tee|championship|back|middle|forward|blue|white|red)\b/i.test(source) ? 10 : 0;
  details.handicapColumnScore = /\b(?:hdcp|handicap|index|stroke.?index)\b/i.test(source) ? 10 : 0;
  details.golfPageContextScore = /golf|country club|코스|골프|ゴルフ|球場|球场/i.test(source) ? 10 : 0;
  details.parsedCardScore = Math.min(30, (cards || []).reduce((sum, card) => sum + Math.min(10, (card.holes || []).length), 0));
  return { score: Object.values(details).reduce((sum, value) => sum + value, 0), details };
}

function detectFacilityStructure(cards) {
  const loops = (cards || []).filter(card => (card.holes || []).length >= 9).map(card => ({
    name: loopDisplayName(card.name),
    holes: (card.holes || []).length, par: Number(card.par) || null
  }));
  return { holeCount: loops.reduce((sum, loop) => sum + loop.holes, 0), loops, loopCount: loops.length };
}

function loopDisplayName(value) {
  let clean = text(value || "Course")
    .replace(/\s*[|·-]\s*par\s*\d+.*$/i, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:scorecard|course guide)\b/gi, " ")
    .replace(/(?:\s+course|\s*코스|\s*コース)\s*$/i, "")
    .replace(/\s+/g, " ").trim();
  const romanized = romanizeHangul(clean);
  if (romanized && !LATIN.test(clean)) clean = romanized.replace(/\b\w/g, char => char.toUpperCase());
  return clean || "Course";
}

module.exports = {
  SEARCH_LOCALES, text, comparable, romanizeHangul, suffixVariants, buildCourseSearchIdentity,
  buildSearchQueries, domainQueries, similarity, haversineKm, scoreSearchCandidate,
  scoreScorecardPage, detectFacilityStructure, loopDisplayName
};
