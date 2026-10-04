/* Golf vocabulary: how to tell that a place listing is a golf course, in the
 * languages golfers actually name their clubs in.
 *
 * Three jobs, and only three:
 *   - classification   does this name/category say "golf course", or "golf
 *                      shop / simulator / range / mini golf"?
 *   - search expansion  which local word to try when the typed text found
 *                      nothing ("Ullna" + "golfklubb" in Sweden)
 *   - weak-term handling "golf", "club", "course" are not what tells two
 *                      courses apart, so name matching weighs them less
 *
 * It is NOT an identity function. A name keeps every word it was given:
 * "Ba Golf Club" stays "ba golf club" for comparison, and the club words are
 * only dropped where a caller explicitly asks for the distinctive part - and
 * even then a short remainder ("ba") is reported as short, so callers never
 * key, dedupe or substring-match on two letters. That is the bug this module
 * exists to make impossible: a two-letter core matched "Balgove" and
 * "Barnbougle" as if they were Ba.
 *
 * Four separate concepts, four separate functions:
 *   displayName(raw)     what the player sees (raw, trimmed)
 *   searchText(raw)      what a provider is sent (raw, whitespace-cleaned)
 *   comparable(raw)      what two names are compared on (folded, abbreviations
 *                        expanded, golf words KEPT)
 *   golfTerms(raw)       which classification phrases the name carries
 */

/* Phrases that, inside a name or a category, mean "a golf course or the club
   that owns one". Folded (lower-case, no accents) because comparable() folds
   the name before looking. Longest first so "golf and country club" is found
   before "country club". Where a word is a compound in its language
   (golfklubb, golfplatz) it is matched as a substring, because Nordic and
   German club names fuse it ("Ullnagolfklubb" is rare, but "Golfclub" as one
   word is the norm). */
export const COURSE_TERMS = [
  /* English */
  { term: "golf and country club", lang: "en" },
  { term: "golf country club", lang: "en" },
  { term: "golf links", lang: "en" },
  { term: "golf course", lang: "en" },
  { term: "golf club", lang: "en" },
  { term: "golf resort", lang: "en" },
  { term: "golf estate", lang: "en" },
  { term: "country club", lang: "en" },
  { term: "links", lang: "en" },
  /* Nordic */
  { term: "golfklubb", lang: "sv/nb" },
  { term: "golfbana", lang: "sv" },
  { term: "golfbane", lang: "nb/da" },
  { term: "golfklub", lang: "da" },
  { term: "golfseura", lang: "fi" },
  { term: "golfkentta", lang: "fi" },
  { term: "golfklubi", lang: "fi" },
  { term: "golfklubbur", lang: "is" },
  { term: "golfvollur", lang: "is" },
  /* German / Dutch */
  { term: "golfclub", lang: "de/nl" },
  { term: "golfplatz", lang: "de" },
  { term: "golfanlage", lang: "de" },
  { term: "golfpark", lang: "de" },
  { term: "golfbaan", lang: "nl" },
  { term: "golfvereniging", lang: "nl" },
  /* Romance */
  { term: "campo de golf", lang: "es" },
  { term: "club de golf", lang: "es/fr" },
  { term: "parcours de golf", lang: "fr" },
  { term: "terrain de golf", lang: "fr" },
  { term: "campo de golfe", lang: "pt" },
  { term: "clube de golfe", lang: "pt" },
  { term: "campo da golf", lang: "it" },
  { term: "circolo golf", lang: "it" },
  { term: "circolo del golf", lang: "it" },
  /* Central / Eastern Europe */
  { term: "pole golfowe", lang: "pl" },
  { term: "klub golfowy", lang: "pl" },
  { term: "golf klub", lang: "cs/sk/hr" },
  { term: "golfove hriste", lang: "cs" },
  { term: "golfpalya", lang: "hu" },
  { term: "гольф клуб", lang: "ru" },
  { term: "гольф поле", lang: "ru" },
  /* East Asia */
  { term: "골프장", lang: "ko" },
  { term: "골프클럽", lang: "ko" },
  { term: "골프 클럽", lang: "ko" },
  { term: "컨트리클럽", lang: "ko" },
  { term: "cc", lang: "ko/ja", abbreviation: true },
  { term: "ゴルフ場", lang: "ja" },
  { term: "ゴルフクラブ", lang: "ja" },
  { term: "ゴルフコース", lang: "ja" },
  { term: "カントリークラブ", lang: "ja" },
  { term: "ゴルフ倶楽部", lang: "ja" },
  { term: "高尔夫球场", lang: "zh" },
  { term: "高爾夫球場", lang: "zh" },
  { term: "高尔夫俱乐部", lang: "zh" },
  { term: "高爾夫俱樂部", lang: "zh" },
  /* South-East Asia / Middle East */
  { term: "สนามกอล์ฟ", lang: "th" },
  { term: "sân golf", lang: "vi" },
  { term: "padang golf", lang: "id/ms" },
  { term: "kelab golf", lang: "ms" },
  { term: "نادي الجولف", lang: "ar" },
  { term: "نادي الغولف", lang: "ar" }
].map((entry) => Object.assign({}, entry, { folded: fold(entry.term) }))
  .sort((a, b) => b.folded.length - a.folded.length);

/* The words that say "golf" without saying "course". On their own they are
   weak: a golf shop, Golf Road and Golf View Cottage all carry them. */
export const WEAK_TERMS = new Set([
  "golf", "club", "course", "country", "links", "resort", "the", "and", "de", "del", "la", "le",
  "golfklubb", "golfclub", "golfklub", "golfbaan", "golfplatz", "golfbana", "golfbane", "golfpark", "golfanlage",
  "campo", "circolo", "clube", "golfe", "parcours", "terrain", "estate"
]);

/* What a listing is when it is golf but not a course. Each carries a kind so
   the confidence model can weigh "indoor simulator" (no holes at all) more
   heavily than "academy" (often attached to a real course). */
export const NON_COURSE_TERMS = [
  { pattern: /\b(?:indoor|simulator|simulators|sim golf|screen golf|virtual golf|golfzon|trackman|golf lounge|golf bar|golf studio|golf simulation|x-?golf)\b/, kind: "indoor", weight: 40 },
  { pattern: /스크린\s?골프|실내\s?골프|インドア|シミュレーション|室内高尔夫|模拟高尔夫/, kind: "indoor", weight: 40 },
  { pattern: /\b(?:mini ?golf|crazy golf|adventure golf|putt ?putt|miniature golf|glow golf|footgolf|foot golf|disc golf|frisbee golf|minigolf)\b/, kind: "mini", weight: 40 },
  { pattern: /\b(?:golf shop|pro shop|golf store|golf superstore|golf outlet|golf warehouse|golf galaxy|golf repair|club fitting|golf fitting)\b/, kind: "shop", weight: 35 },
  { pattern: /\b(?:driving range|golf range|practice range|golf dome|topgolf|drivingrange)\b|골프\s?연습장|練習場|练习场/, kind: "range", weight: 30 },
  { pattern: /\b(?:golf academy|golf school|golf lessons?)\b/, kind: "academy", weight: 15 }
];

/* Local course words to try per country when the typed text found nothing.
   First entry is the most common one. Countries not listed fall back to the
   English set only. */
export const LOCAL_TERMS_BY_COUNTRY = {
  SE: ["golfklubb", "golfbana"], NO: ["golfklubb", "golfbane"], DK: ["golfklub", "golfbane"],
  FI: ["golfseura", "golfkenttä"], IS: ["golfklúbbur"],
  DE: ["golfclub", "golfplatz"], AT: ["golfclub", "golfplatz"], CH: ["golfclub", "golfplatz"],
  NL: ["golfbaan", "golfclub"], BE: ["golfclub", "golf club"],
  ES: ["club de golf", "campo de golf"], MX: ["club de golf", "campo de golf"], AR: ["club de golf"],
  CL: ["club de golf"], CO: ["club de golf"], FR: ["golf club", "club de golf"],
  PT: ["golfe", "campo de golfe"], BR: ["clube de golfe", "campo de golfe"], IT: ["golf club", "circolo golf"],
  PL: ["klub golfowy", "pole golfowe"], CZ: ["golf klub"], SK: ["golf klub"],
  KR: ["골프장", "cc"], JP: ["ゴルフ場", "カントリークラブ"], CN: ["高尔夫球场"], TW: ["高爾夫球場"], HK: ["高爾夫球場"],
  TH: ["สนามกอล์ฟ"], ID: ["padang golf"], MY: ["kelab golf"]
};
export const ENGLISH_EXPANSION = ["golf club", "golf course", "country club"];

/* ------------------------------------------------------------- normalising */

/* Lower-case, accents off, width-normalised. NFD then NFC so a Hangul
   syllable is recomposed after the accent strip - left decomposed, Korean
   names compare as jamo soup that no vocabulary entry would ever match. */
export function fold(value) {
  return String(value == null ? "" : value)
    .normalize("NFKC")
    .normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC")
    .toLocaleLowerCase("en")
    .replace(/[​-‍﻿]/g, "");
}

export function displayName(raw) {
  return String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
}

/* What a provider is sent. The player's own words, untouched apart from
   whitespace: a provider is better at its own matching than we are at
   guessing what to append. */
export function searchText(raw) {
  return displayName(raw).slice(0, 120);
}

/* What two names are compared on. Abbreviations are EXPANDED, never dropped,
   so "Akarana GC", "Akarana G.C." and "Akarana Golf Club" all compare equal
   while "Ba Golf Club" still reads "ba golf club". */
export function comparable(raw) {
  let s = fold(raw)
    .replace(/&/g, " and ")
    .replace(/[’'`´]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ").trim();
  /* g c / g and c c / c c, as initials. The letters were dotted or spaced; by
     here the dots are spaces. */
  s = s.replace(/(^| )g ?(?:and )?c ?c(?= |$)/g, "$1golf and country club")
    .replace(/(^| )g ?c(?= |$)/g, "$1golf club")
    .replace(/(^| )c ?c(?= |$)/g, "$1country club")
    .replace(/(^| )saint(?= )/g, "$1st")
    .replace(/(^| )mount(?= )/g, "$1mt");
  /* Korean and Japanese clubs fuse CC onto the proper name: 소피아그린CC. */
  s = s.replace(/([^\x00-\x7f])cc(?= |$)/g, "$1 country club");
  return s.replace(/\s+/g, " ").trim();
}

export function tokens(raw) {
  const c = comparable(raw);
  return c ? c.split(" ") : [];
}

/* The words that tell this course apart from every other golf club. When
   removing the golf words leaves fewer than three letters, the full token
   list is returned with short:true - "Ba Golf Club" is [ba, golf, club], not
   [ba]. Callers that key or substring-match must check `short`. */
export function distinctiveTokens(raw) {
  const all = tokens(raw);
  const distinctive = all.filter((t) => !WEAK_TERMS.has(t) && !COURSE_TERMS.some((c) => c.folded === t));
  const letters = distinctive.join("").replace(/[^\p{L}\p{N}]/gu, "");
  /* Non-Latin scripts carry far more per character: two Hangul syllables are
     a real name. */
  const enough = /[^\x00-\x7f]/.test(letters) ? letters.length >= 2 : letters.length >= 3;
  return { tokens: distinctive.length ? distinctive : all, short: !enough, all };
}

/* Classification phrases present in a name or category string. */
export function golfTerms(raw) {
  const c = " " + comparable(raw) + " ";
  const found = [];
  COURSE_TERMS.forEach((entry) => {
    if (entry.abbreviation) return; /* already expanded by comparable() */
    const term = comparable(entry.term);
    if (!term) return;
    /* Multi-word and ASCII terms on word boundaries; fused compounds and CJK
       anywhere. */
    const ascii = /^[a-z ]+$/.test(term);
    const hit = ascii && !/^(golfklubb|golfclub|golfklub|golfbaan|golfplatz|golfbana|golfbane|golfpark|golfanlage|golfseura|golfkentta|golfklubi|golfklubbur|golfvollur|golfpalya)$/.test(term)
      ? c.includes(" " + term + " ")
      : c.includes(term);
    if (hit && !found.some((f) => f.includes(term))) found.push(term);
  });
  return found;
}

/* Non-course golf listings: simulator, shop, range, mini golf, academy. */
export function nonCourseSignals(raw) {
  const c = " " + comparable(raw) + " ";
  return NON_COURSE_TERMS.filter((entry) => entry.pattern.test(c)).map((entry) => ({ kind: entry.kind, weight: entry.weight }));
}

/* ----------------------------------------------------------------- matching */

/* How well a candidate name answers what the player typed.
 *   exact    same comparable string ("Akarana GC" = "Akarana Golf Club")
 *   strong   every distinctive typed word is a whole word of the name, or
 *            the name starts with the typed text
 *   partial  some distinctive words shared, or the last typed word is the
 *            start of a name word (still typing)
 *   none
 * Whole-word only for short words: "ba" never matches "balgove". */
export function nameMatch(query, name) {
  const q = comparable(query);
  const n = comparable(name);
  if (!q || !n) return { tier: "none", score: 0 };
  if (q === n) return { tier: "exact", score: 100 };
  const qd = distinctiveTokens(query);
  const nd = distinctiveTokens(name);
  const nameWords = new Set(nd.all);
  const qWords = qd.tokens;
  const allPresent = qWords.every((t) => nameWords.has(t));
  const sameCore = qd.tokens.length === nd.tokens.length && qd.tokens.every((t) => nd.tokens.includes(t));
  if (sameCore && !qd.short) return { tier: "strong", score: 92 };
  if (allPresent) {
    /* "Ba Golf Club" inside "FSC Ba Golf Club": the whole typed phrase, in order. */
    const phrase = (" " + n + " ").includes(" " + q + " ");
    return { tier: "strong", score: phrase ? 85 : 78 };
  }
  if (!qd.short && n.startsWith(q)) return { tier: "strong", score: 80 };
  let shared = 0;
  qWords.forEach((t) => { if (nameWords.has(t)) shared += 1; });
  const last = qWords[qWords.length - 1] || "";
  const prefix = last.length >= 3 && nd.all.some((t) => t !== last && t.startsWith(last));
  if (shared || prefix) {
    const ratio = (shared + (prefix ? 0.8 : 0)) / Math.max(1, qWords.length);
    return { tier: "partial", score: Math.round(30 + 35 * Math.min(1, ratio)) };
  }
  return { tier: "none", score: 0 };
}

/* Name similarity for deduping two listings of the SAME place from two
   providers. Stricter than nameMatch in one way: neither side may carry a
   distinctive word the other lacks unless the shorter side is fully inside
   the longer AND the caller has also checked they are very close - two
   courses at one resort ("North", "South") differ in exactly one word. */
export function sameNameKind(a, b) {
  const ca = comparable(a), cb = comparable(b);
  if (!ca || !cb) return "different";
  if (ca === cb) return "same";
  const da = distinctiveTokens(a), db = distinctiveTokens(b);
  const sa = new Set(da.tokens), sb = new Set(db.tokens);
  const aInB = [...sa].every((t) => sb.has(t));
  const bInA = [...sb].every((t) => sa.has(t));
  if (aInB && bInA) return "same";
  if ((aInB || bInA) && !da.short && !db.short) return "subset";
  return "different";
}
