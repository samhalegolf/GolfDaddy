/* Scorecards that only exist as pictures.
 *
 * Plenty of club sites never publish a table. The card is a JPEG of the printed
 * card, a "front nine" and "back nine" pair, or one graphic per hole on a page per
 * hole. gd-scorecard-parse-core reads none of that, so the resolver used to give
 * up with "no readable structure" on a page that was showing the answer.
 *
 * This module is the pure half of the fallback: which images to look at, what the
 * vision model must hand back, and - the part that matters - whether to believe
 * it. Nothing here touches the network or the model; gd-scorecard-vision.mjs does
 * that and is injected into the resolver.
 *
 * DO NOT TRUST THE READ
 *
 * A misread digit is the normal failure, not the rare one: a 4 read as a 1 turns a
 * par 4 into nonsense, an 8 read as a 3 moves a 380-yard hole to 330. So a read is
 * only accepted when something OTHER than the read agrees with it:
 *
 *   - the totals printed on the card match the sum of the holes read,
 *   - the stroke index is a complete, unique 1..N set,
 *   - or two separate images give the same pars for the same holes.
 *
 * A card with none of those is rejected however clean it looks. Printed totals
 * that disagree with the holes are not a soft signal - that read is thrown away. */

import { toEngineCard } from "./gd-scorecard-parse-core.mjs";

export const VISUAL_ACCEPT_CONFIDENCE = 0.6;
/* Stored visual cards stay below the 0.8 "sticky" line in shouldReplaceFacilityCard,
   so a later HTML read of the same course can still replace a picture read. */
export const VISUAL_STORED_CONFIDENCE_CAP = 0.75;
export const MAX_CARD_IMAGES = 4;
export const MAX_HOLE_PAGES = 18;

const YARDS_PER_METRE = 1.0936;

/* ---------------------------------------------------------------- finding images */

const POSITIVE = [
  { re: /score[\s_-]?card|scorecard/i, weight: 60 },
  { re: /yardage|card[\s_-]?(front|back)|course[\s_-]?(card|guide|planner|layout|map)/i, weight: 35 },
  { re: /\bholes?[\s_-]?\d{1,2}\b|hole[\s_-]?by[\s_-]?hole|\bhole\b/i, weight: 25 },
  { re: /front[\s_-]?(9|nine)|back[\s_-]?(9|nine)|\b(out|in)[\s_-]?nine\b/i, weight: 25 },
  { re: /\b(par|yards?|metres?|meters?|tees?|layout|flyover)\b/i, weight: 10 }
];
const NEGATIVE = /logo|icon|sprite|avatar|favicon|badge|social|facebook|twitter|instagram|linkedin|youtube|tripadvisor|payment|visa|mastercard|sponsor|partner|award|placeholder|spinner|loader|pixel|tracking|emoji|flag[\s_-]|arrow|button|weather/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif)(\?|#|$)/i;

function attr(tag, name) {
  const m = tag.match(new RegExp("\\b" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : "";
}

function absoluteHttps(raw, pageUrl) {
  const value = String(raw || "").trim().replace(/&amp;/g, "&");
  if (!value || /^data:/i.test(value)) return null;
  try {
    const url = new URL(value, pageUrl);
    return url.protocol === "https:" ? url.href : null;
  } catch (e) { return null; }
}

/* The widest entry of a srcset, since digits on a card need every pixel. */
function largestFromSrcset(srcset) {
  let best = null, bestWidth = -1;
  String(srcset || "").split(",").forEach(part => {
    const [url, size] = part.trim().split(/\s+/);
    if (!url) return;
    const width = /^(\d+)w$/.test(size || "") ? Number(RegExp.$1) : /^(\d+(?:\.\d+)?)x$/.test(size || "") ? Number(RegExp.$1) * 1000 : 0;
    if (width > bestWidth) { best = url; bestWidth = width; }
  });
  return best;
}

/* Front, back, a single hole, or a whole card - from the words around the image.
   Only a hint for the prompt and the assembler; the read itself says what it saw. */
export function imageKindHint(text) {
  const words = String(text || "").toLowerCase();
  const hole = words.match(/(?:^|[^a-z])hole[\s_-]*(?:no\.?|number|#)?[\s_-]*(\d{1,2})(?!\d)/);
  if (hole && Number(hole[1]) >= 1 && Number(hole[1]) <= 18 && !/score[\s_-]?card/.test(words)) {
    return { kind: "single-hole", hole: Number(hole[1]) };
  }
  if (/front[\s_-]?(9|nine)|holes?[\s_-]?1[\s_-]+(to|-)[\s_-]*9\b|\bout[\s_-]?nine\b/.test(words)) return { kind: "front-nine", hole: null };
  if (/back[\s_-]?(9|nine)|holes?[\s_-]?10[\s_-]+(to|-)[\s_-]*18\b|\bin[\s_-]?nine\b/.test(words)) return { kind: "back-nine", hole: null };
  return { kind: "full-card", hole: null };
}

/* Images on a page that could be a scorecard or a hole graphic, best first.
 *
 * options.holeNumber: the page is a hole page (from holePageLinks), so its main
 * picture is that hole's graphic even when nothing about the file says "hole". */
export function scorecardImageCandidates(html, pageUrl, options = {}) {
  const source = String(html || "");
  const found = new Map();
  const consider = (raw, context, extra = {}) => {
    const url = absoluteHttps(raw, pageUrl);
    if (!url) return;
    const path = (() => { try { return decodeURIComponent(new URL(url).pathname); } catch (e) { return url; } })();
    if (/\.svg(\?|#|$)/i.test(path)) return;
    if (!IMAGE_EXT.test(path) && !extra.trustedImage) return;
    const text = (context + " " + path).replace(/\s+/g, " ");
    if (NEGATIVE.test(text)) return;
    if (Number.isFinite(extra.width) && extra.width > 0 && extra.width < 150) return;
    if (Number.isFinite(extra.height) && extra.height > 0 && extra.height < 100) return;
    let score = 0;
    POSITIVE.forEach(rule => { if (rule.re.test(text)) score += rule.weight; });
    let hint = imageKindHint(text);
    if (options.holeNumber) {
      /* A hole page's own graphic. Big unlabelled images still qualify here, at a
         lower score, because hole pages rarely caption their main picture. */
      score += 15;
      if (!(Number.isFinite(extra.width) && extra.width > 0 && extra.width < 300)) score += 5;
      hint = { kind: "single-hole", hole: hint.kind === "single-hole" && hint.hole === options.holeNumber ? hint.hole : options.holeNumber };
    }
    if (extra.og) score -= 10;
    if (score <= 0) return;
    const existing = found.get(url);
    if (!existing || existing.score < score) {
      found.set(url, { url, score, kind: hint.kind, hole: hint.hole, context: context.slice(0, 160).trim() });
    }
  };

  const imgRe = /<img\b[^>]*>/gi;
  let m;
  while ((m = imgRe.exec(source))) {
    const tag = m[0];
    const context = [attr(tag, "alt"), attr(tag, "title"), attr(tag, "class"), attr(tag, "id")].join(" ");
    const width = Number(attr(tag, "width")) || null;
    const height = Number(attr(tag, "height")) || null;
    const srcset = attr(tag, "srcset") || attr(tag, "data-srcset");
    const candidates = [largestFromSrcset(srcset), attr(tag, "data-src"), attr(tag, "data-lazy-src"), attr(tag, "data-original"), attr(tag, "src")].filter(Boolean);
    if (candidates.length) consider(candidates[0], context, { width, height });
  }
  const sourceRe = /<source\b[^>]*>/gi;
  while ((m = sourceRe.exec(source))) {
    const best = largestFromSrcset(attr(m[0], "srcset") || attr(m[0], "data-srcset"));
    if (best) consider(best, attr(m[0], "media"));
  }
  /* Linked straight to the full-size file: "Download scorecard". The link text is
     usually the only label the image ever gets. */
  const linkRe = /<a\b([^>]*)>([\s\S]{0,300}?)<\/a>/gi;
  while ((m = linkRe.exec(source))) {
    const href = attr("<a " + m[1] + ">", "href");
    if (!IMAGE_EXT.test(href)) continue;
    consider(href, m[2].replace(/<[^>]*>/g, " ") + " " + attr("<a " + m[1] + ">", "title"));
  }
  const styleRe = /background(?:-image)?\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  while ((m = styleRe.exec(source))) consider(m[1], "");
  const og = source.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || source.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (og) consider(og[1], "og:image", { og: true, trustedImage: true });

  return [...found.values()].sort((a, b) => b.score - a.score);
}

/* Links on a page to that course's per-hole pages: /the-course/hole-7, /holes/7,
   "Hole 7" as the anchor text. Same host only, one URL per hole number. */
export function holePageLinks(html, pageUrl) {
  let host = "";
  try { host = new URL(pageUrl).hostname.replace(/^www\./, ""); } catch (e) { return []; }
  const byHole = new Map();
  const linkRe = /<a\b([^>]*)>([\s\S]{0,200}?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(String(html || "")))) {
    const href = attr("<a " + m[1] + ">", "href");
    let url;
    try { url = new URL(href.replace(/&amp;/g, "&"), pageUrl); } catch (e) { continue; }
    if (url.protocol !== "https:" || url.hostname.replace(/^www\./, "") !== host) continue;
    if (IMAGE_EXT.test(url.pathname)) continue;
    const text = m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const path = url.pathname.toLowerCase();
    const fromPath = path.match(/(?:^|\/)(?:hole|holes)[\/_-]?(?:no-?|number-?)?(\d{1,2})(?:[\/_-]|$)/);
    const fromText = text.match(/^hole\s*(?:no\.?|#)?\s*(\d{1,2})\b/i);
    const hole = Number((fromPath && fromPath[1]) || (fromText && fromText[1]));
    if (!(hole >= 1 && hole <= 18)) continue;
    url.hash = "";
    if (url.href.replace(/\/+$/, "") === String(pageUrl).replace(/\/+$/, "")) continue;
    if (!byHole.has(hole)) byHole.set(hole, url.href);
  }
  return [...byHole.entries()].sort((a, b) => a[0] - b[0]).slice(0, MAX_HOLE_PAGES).map(([hole, url]) => ({ hole, url }));
}

/* ---------------------------------------------------------------- the model's answer */

const nullableInt = { anyOf: [{ type: "integer" }, { type: "null" }] };

/* One entry per image, in the order sent. Printed totals are asked for EXACTLY AS
   PRINTED and never computed - they are the independent check the read is held to. */
export const VISUAL_SCORECARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["images"],
  properties: {
    images: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["imageIndex", "isScorecard", "kind", "legibility", "courseName", "unit", "holes", "tees", "printedParOut", "printedParIn", "printedParTotal"],
        properties: {
          imageIndex: { type: "integer" },
          isScorecard: { type: "boolean" },
          kind: { type: "string", enum: ["full-card", "front-nine", "back-nine", "single-hole", "other"] },
          legibility: { type: "string", enum: ["clear", "partial", "poor"] },
          courseName: { type: "string" },
          unit: { type: "string", enum: ["yards", "metres", "unknown"] },
          holes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["hole", "par", "strokeIndex"],
              properties: { hole: { type: "integer" }, par: nullableInt, strokeIndex: nullableInt }
            }
          },
          tees: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "distances", "printedOut", "printedIn", "printedTotal"],
              properties: {
                name: { type: "string" },
                distances: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["hole", "value"],
                    properties: { hole: { type: "integer" }, value: { type: "integer" } }
                  }
                },
                printedOut: nullableInt, printedIn: nullableInt, printedTotal: nullableInt
              }
            }
          },
          printedParOut: nullableInt, printedParIn: nullableInt, printedParTotal: nullableInt
        }
      }
    }
  }
};

export function buildVisualPrompt(images) {
  const lines = (images || []).map((image, index) => {
    const hint = image.kind === "single-hole" && image.hole ? "probably the graphic for hole " + image.hole
      : image.kind === "front-nine" ? "probably the front nine"
      : image.kind === "back-nine" ? "probably the back nine"
      : "possibly a full scorecard";
    return "Image " + (index + 1) + ": " + hint + (image.context ? " (page label: " + JSON.stringify(image.context.slice(0, 80)) + ")" : "") + ".";
  });
  return [
    "You are transcribing golf scorecard images for a course database. Return one entry per image, imageIndex starting at 1.",
    lines.join("\n"),
    "",
    "Rules:",
    "- Transcribe only what is printed. Never infer, estimate or calculate a value. If a value is missing, cut off or unreadable, use null (or leave that hole out of a tee's distances).",
    "- Hole numbers are as printed (1-18). Par is the par row. strokeIndex is the handicap / index / HCP / S.I. row.",
    "- One tee entry per distance row, named as printed (colour or tee name). Distances are per-hole lengths only.",
    "- printedOut / printedIn / printedTotal and printedParOut / printedParIn / printedParTotal are the OUT, IN and TOTAL figures exactly as printed on the card. If the card does not print them, use null. Do not add them up yourself.",
    "- unit is the unit the card states (yards or metres); 'unknown' if it does not say.",
    "- courseName is the course name printed on the image, or an empty string.",
    "- If an image is not a scorecard or hole graphic (a photo, map without numbers, logo, advert), set isScorecard false, kind 'other', and leave holes and tees empty.",
    "- legibility: 'clear' if every figure you returned was easy to read, 'partial' if some were hard, 'poor' if you were guessing at several."
  ].join("\n");
}

/* ---------------------------------------------------------------- validation */

function int(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/* Per-hole length that a hole of this par can plausibly be. Wide on purpose -
   this catches a dropped or doubled digit, not an unusual hole. */
const LENGTH_RANGE_YARDS = { 3: [60, 300], 4: [180, 530], 5: [360, 720], 6: [500, 800] };

function plausibleLength(value, par, unit) {
  const range = LENGTH_RANGE_YARDS[par];
  if (!range) return value >= 50 && value <= 800;
  const inYards = v => v >= range[0] && v <= range[1];
  if (unit === "yards") return inYards(value);
  if (unit === "metres") return inYards(value * YARDS_PER_METRE);
  return inYards(value) || inYards(value * YARDS_PER_METRE);
}

function sumOf(map, holes) {
  let total = 0;
  for (const hole of holes) {
    if (!Number.isFinite(map[hole])) return null;
    total += map[hole];
  }
  return total;
}

const FRONT = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const BACK = [10, 11, 12, 13, 14, 15, 16, 17, 18];

/* One image's read, checked on its own.
 *
 * Returns { ok, reason, problems, read } where `read` is in gd-scorecard-parse-core's
 * parsed shape ({holes, par, handicap, tees, unit}) plus the checks that passed.
 * options.expectHole: the page this image came from is that hole's page. */
export function validateVisualRead(raw, options = {}) {
  const problems = [];
  const reject = reason => ({ ok: false, reason, problems });
  if (!raw || raw.isScorecard === false || raw.kind === "other") return reject("not-a-scorecard");
  const unit = raw.unit === "yards" || raw.unit === "metres" ? raw.unit : null;

  const rows = (raw.holes || []).map(row => ({ hole: int(row && row.hole), par: int(row && row.par), si: int(row && row.strokeIndex) }))
    .filter(row => row.hole !== null);
  if (!rows.length) return reject("no-holes-read");
  if (rows.some(row => row.hole < 1 || row.hole > 18)) return reject("hole-number-out-of-range");
  const numbers = rows.map(row => row.hole);
  if (new Set(numbers).size !== numbers.length) return reject("duplicate-hole-numbers");
  if (Number.isFinite(options.expectHole) && !(rows.length === 1 && rows[0].hole === options.expectHole)) {
    return reject("hole-number-disagrees-with-page");
  }

  const par = {}, handicap = {};
  for (const row of rows) {
    if (row.par === null) continue;
    if (row.par < 3 || row.par > 6) return reject("impossible-par-" + row.par + "-on-hole-" + row.hole);
    par[row.hole] = row.par;
  }
  if (!Object.keys(par).length) return reject("no-pars-read");
  if (Object.values(par).some(p => p === 6)) problems.push("par-6-present");

  /* Stroke index: a misread here is common and harmless to drop, so duplicates
     strip the row rather than sink the read. */
  const siRows = rows.filter(row => row.si !== null);
  const siValues = siRows.map(row => row.si);
  let siUnique = siValues.length > 0 && siValues.every(v => v >= 1 && v <= 18) && new Set(siValues).size === siValues.length;
  if (siValues.length && !siUnique) problems.push("stroke-index-duplicated-or-out-of-range");
  if (siUnique) siRows.forEach(row => { handicap[row.hole] = row.si; });

  const holes = numbers.slice().sort((a, b) => a - b);
  const segments = [];
  const has = list => list.every(h => holes.includes(h));
  if (has(FRONT)) segments.push({ key: "out", holes: FRONT });
  if (has(BACK)) segments.push({ key: "in", holes: BACK });

  /* Printed par totals: the strongest check there is, and a hard one. */
  let parTotalsChecked = 0;
  const parPrinted = { out: int(raw.printedParOut), in: int(raw.printedParIn), total: int(raw.printedParTotal) };
  for (const seg of segments) {
    const printed = parPrinted[seg.key];
    if (printed === null) continue;
    const summed = sumOf(par, seg.holes);
    if (summed === null) continue;
    if (summed !== printed) return reject("par-" + seg.key + "-total-mismatch-" + summed + "-vs-printed-" + printed);
    parTotalsChecked += 1;
  }
  if (parPrinted.total !== null && (holes.length === 9 || holes.length === 18)) {
    const summed = sumOf(par, holes);
    if (summed !== null && summed === parPrinted.total) parTotalsChecked += 1;
    /* A nine-hole image often prints the eighteen's total beside its own OUT, so
       only a full card's total is held against it. */
    else if (summed !== null && holes.length === 18) return reject("par-total-mismatch-" + summed + "-vs-printed-" + parPrinted.total);
  }
  const fullPar = sumOf(par, holes);
  if (fullPar !== null && holes.length === 18 && (fullPar < 54 || fullPar > 78)) return reject("course-par-" + fullPar + "-out-of-range");
  if (fullPar !== null && holes.length === 9 && (fullPar < 27 || fullPar > 40)) return reject("nine-par-" + fullPar + "-out-of-range");

  /* Tees: implausible per-hole lengths are dropped, a printed total that disagrees
     drops the whole tee row. */
  const tees = [];
  let teeTotalsChecked = 0, droppedDistances = 0;
  (raw.tees || []).forEach((tee, index) => {
    const name = String((tee && tee.name) || "").trim() || "Tee " + (index + 1);
    const distances = {};
    (tee && tee.distances || []).forEach(entry => {
      const hole = int(entry && entry.hole), value = int(entry && entry.value);
      if (hole === null || value === null || !holes.includes(hole)) return;
      if (!plausibleLength(value, par[hole], unit)) { droppedDistances += 1; return; }
      distances[hole] = value;
    });
    if (!Object.keys(distances).length) return;
    const printed = { out: int(tee.printedOut), in: int(tee.printedIn), total: int(tee.printedTotal) };
    let checked = 0;
    for (const seg of segments) {
      if (printed[seg.key] === null) continue;
      const summed = sumOf(distances, seg.holes);
      if (summed === null) continue;
      if (Math.abs(summed - printed[seg.key]) > 1) { problems.push("tee-" + name + "-" + seg.key + "-total-mismatch"); return; }
      checked += 1;
    }
    if (printed.total !== null && holes.length === 18) {
      const summed = sumOf(distances, holes);
      if (summed !== null) {
        if (Math.abs(summed - printed.total) > 1) { problems.push("tee-" + name + "-total-mismatch"); return; }
        checked += 1;
      }
    }
    if (checked) teeTotalsChecked += 1;
    tees.push({ name, distances });
  });
  if (droppedDistances) problems.push("dropped-" + droppedDistances + "-implausible-distances");

  /* Longer tees are longer nearly everywhere. A row that crosses another on many
     holes is a misaligned read, so the shorter-total row of the pair is dropped. */
  for (let i = 0; i < tees.length; i++) {
    for (let j = i + 1; j < tees.length; j++) {
      const shared = Object.keys(tees[i].distances).filter(h => h in tees[j].distances);
      if (shared.length < 6) continue;
      /* Longer and shorter judged on the holes both rows have, so a row missing a
         dropped distance is not mistaken for the shorter tee. */
      const sumShared = tee => shared.reduce((s, h) => s + tee.distances[h], 0);
      const [long, short] = sumShared(tees[i]) >= sumShared(tees[j]) ? [tees[i], tees[j]] : [tees[j], tees[i]];
      const crossings = shared.filter(h => short.distances[h] > long.distances[h] + 10).length;
      if (crossings > Math.max(2, Math.round(shared.length * 0.25))) {
        short.dropped = true;
        problems.push("tee-" + short.name + "-crosses-" + long.name);
      }
    }
  }
  const keptTees = tees.filter(tee => !tee.dropped);

  /* Within any one tee a par 3 is shorter than a par 5. */
  keptTees.forEach(tee => {
    const of = p => Object.keys(tee.distances).filter(h => par[h] === p).map(h => tee.distances[h]);
    const threes = of(3), fives = of(5);
    if (threes.length && fives.length && Math.max(...threes) >= Math.min(...fives)) problems.push("tee-" + tee.name + "-par3-longer-than-par5");
  });

  return {
    ok: true, reason: null, problems,
    read: {
      holes, par, handicap, tees: keptTees, unit,
      kind: raw.kind, legibility: raw.legibility || "partial",
      courseName: String(raw.courseName || "").trim(),
      checks: { parTotals: parTotalsChecked, teeTotals: teeTotalsChecked, siUnique: siUnique && siRows.length === holes.length }
    }
  };
}

/* ---------------------------------------------------------------- assembly */

const LEGIBILITY_FACTOR = { clear: 1, partial: 0.85, poor: 0.6 };

function mergeReads(reads) {
  const merged = { holes: [], par: {}, handicap: {}, tees: [], unit: null };
  const teesByName = new Map();
  const conflicts = [];
  reads.forEach(read => {
    merged.unit = merged.unit || read.unit;
    read.holes.forEach(hole => {
      if (!merged.holes.includes(hole)) merged.holes.push(hole);
      if (Number.isFinite(read.par[hole])) {
        if (Number.isFinite(merged.par[hole]) && merged.par[hole] !== read.par[hole]) conflicts.push(hole);
        else merged.par[hole] = read.par[hole];
      }
      if (Number.isFinite(read.handicap[hole]) && !Number.isFinite(merged.handicap[hole])) merged.handicap[hole] = read.handicap[hole];
    });
    read.tees.forEach(tee => {
      const key = tee.name.toLowerCase();
      if (!teesByName.has(key)) teesByName.set(key, { name: tee.name, distances: {} });
      Object.assign(teesByName.get(key).distances, tee.distances);
    });
  });
  merged.holes.sort((a, b) => a - b);
  merged.tees = [...teesByName.values()];
  return { merged, conflicts };
}

/* One candidate card - one full card, a front + back pair, or a set of hole
   graphics - scored on its own evidence plus agreement with every other read. */
function scoreCandidate(parts, allReads, name) {
  const reads = parts.map(part => part.read);
  const problems = [].concat(...parts.map(part => part.problems));
  const { merged, conflicts } = mergeReads(reads);
  if (conflicts.length) return { ok: false, reason: "par-conflict-between-images-holes-" + conflicts.join(","), problems };

  const holes = merged.holes;
  const contiguousFront = holes.every((hole, index) => hole === index + 1);
  const backOnly = holes.length === 9 && holes[0] === 10 && holes[8] === 18;
  if (!contiguousFront && !backOnly) return { ok: false, reason: "holes-not-contiguous-" + holes.join(","), problems };
  const withPar = holes.filter(hole => Number.isFinite(merged.par[hole])).length;
  if (withPar < 9) return { ok: false, reason: "fewer-than-nine-pars", problems };
  if (holes.length === 18) {
    const coursePar = holes.reduce((s, h) => s + (merged.par[h] || 0), 0);
    if (withPar === 18 && (coursePar < 54 || coursePar > 78)) return { ok: false, reason: "course-par-" + coursePar + "-out-of-range", problems };
  }

  /* Stroke index across the merged card. Unique 1..N over every hole is a check
     no single misread passes; anything less is kept only if unique. */
  const siValues = holes.map(hole => merged.handicap[hole]).filter(Number.isFinite);
  const siUnique = new Set(siValues).size === siValues.length;
  if (!siUnique) { merged.handicap = {}; problems.push("stroke-index-duplicated-across-images"); }
  const siComplete = siUnique && siValues.length === holes.length && siValues.every(v => v >= 1 && v <= 18);

  const parTotals = reads.reduce((s, r) => s + r.checks.parTotals, 0);
  const teeTotals = reads.reduce((s, r) => s + r.checks.teeTotals, 0);

  /* Agreement: another image, not part of this candidate, gives the same pars
     for at least six of the same holes - and disagrees on none. */
  const others = allReads.filter(read => !reads.includes(read));
  let agreement = false;
  for (const other of others) {
    const shared = holes.filter(h => Number.isFinite(merged.par[h]) && Number.isFinite(other.par[h]));
    if (shared.length < 6) continue;
    if (shared.some(h => merged.par[h] !== other.par[h])) {
      problems.push("another-image-disagrees-on-par");
      agreement = false;
      break;
    }
    agreement = true;
  }

  const checks = {
    parTotalsMatched: parTotals > 0,
    teeTotalsMatched: teeTotals > 0,
    strokeIndexComplete: siComplete,
    imagesAgree: agreement
  };
  const independent = Object.values(checks).filter(Boolean).length;
  if (!independent) return { ok: false, reason: "no-independent-check", problems, checks };

  const distanceCoverage = merged.tees.length
    ? Math.max(...merged.tees.map(tee => holes.filter(h => Number.isFinite(tee.distances[h])).length)) / holes.length
    : 0;
  let score = 0.4
    + (checks.parTotalsMatched ? 0.2 : 0)
    + (checks.teeTotalsMatched ? 0.15 : 0)
    + (checks.strokeIndexComplete ? 0.15 : 0)
    + (checks.imagesAgree ? 0.1 : 0)
    + 0.1 * distanceCoverage
    + 0.05 * (withPar / holes.length);
  const penalty = Math.min(0.3, problems.reduce((s, p) => s + (/par3-longer|disagrees|crosses/.test(p) ? 0.1 : 0.03), 0));
  score -= penalty;
  /* The model's own view of the image can only take confidence away. */
  const legibility = reads.reduce((worst, r) => Math.min(worst, LEGIBILITY_FACTOR[r.legibility] ?? 0.85), 1);
  const confidence = Math.max(0, Math.min(1, Math.round(score * legibility * 100) / 100));
  if (confidence < VISUAL_ACCEPT_CONFIDENCE) return { ok: false, reason: "low-confidence-" + confidence, problems, checks, confidence };

  const printedName = reads.map(r => r.courseName).find(Boolean) || "";
  const card = toEngineCard(merged, name || printedName);
  if (!card) return { ok: false, reason: "no-card", problems, checks };
  return { ok: true, card, confidence, checks, problems, printedName, layout: parts.map(part => part.read.kind) };
}

/* Every image read -> the cards worth believing.
 *
 * reads: [{ raw, image: {url, kind, hole, pageUrl, fromHolePage} }] in the order sent.
 * Tried in order of how much a single source can vouch for itself: each full card
 * alone, then front + back pairs, then the per-hole graphics as one set. A page
 * carrying two different courses' full cards yields both. */
export function assembleVisualCards(reads, options = {}) {
  const validated = (reads || []).map(entry => {
    const expectHole = entry.image && entry.image.fromHolePage ? entry.image.hole : undefined;
    const result = validateVisualRead(entry.raw, { expectHole });
    return Object.assign({ image: entry.image }, result);
  });
  const good = validated.filter(entry => entry.ok);
  const allReads = good.map(entry => entry.read);
  const accepted = [], rejected = validated.filter(entry => !entry.ok).map(entry => ({ url: entry.image && entry.image.url, reason: entry.reason, problems: entry.problems }));
  const used = new Set();

  const tryCandidate = (parts, label) => {
    const verdict = scoreCandidate(parts, allReads, options.name);
    if (verdict.ok) {
      parts.forEach(part => used.add(part));
      accepted.push(Object.assign(verdict, { images: parts.map(part => part.image && part.image.url) }));
      return true;
    }
    rejected.push({ url: parts.map(part => part.image && part.image.url).join(" + "), layout: label, reason: verdict.reason, problems: verdict.problems, confidence: verdict.confidence ?? null });
    return false;
  };

  good.filter(entry => entry.read.holes.length === 18).forEach(entry => tryCandidate([entry], "full-card"));

  const fronts = good.filter(entry => !used.has(entry) && entry.read.holes.length === 9 && entry.read.holes[0] === 1);
  const backs = good.filter(entry => !used.has(entry) && entry.read.holes.length === 9 && entry.read.holes[0] === 10);
  for (const front of fronts) {
    for (const back of backs) {
      if (used.has(front) || used.has(back)) continue;
      const a = front.read.courseName, b = back.read.courseName;
      if (a && b && a.toLowerCase() !== b.toLowerCase()) continue;
      tryCandidate([front, back], "front-back");
    }
  }
  /* A nine with no partner is a nine-hole course's card, if it vouches for itself. */
  if (!accepted.length) fronts.forEach(front => { if (!used.has(front)) tryCandidate([front], "nine-hole-card"); });

  const holeGraphics = good.filter(entry => !used.has(entry) && entry.read.holes.length === 1);
  if (holeGraphics.length >= 9) tryCandidate(holeGraphics, "hole-graphics");

  accepted.sort((x, y) => y.confidence - x.confidence);
  return { accepted, rejected, validated: validated.length };
}
