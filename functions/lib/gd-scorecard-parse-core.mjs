/* Turn a scorecard table into holes - the pure half of the Scorecard Engine.
 *
 * Deliberately takes a GRID of strings rather than HTML. Pulling rows and cells
 * out of a page is a thin, swappable adapter; deciding what the numbers mean is
 * the part that is hard, worth testing, and identical whatever produced the
 * markup. Keeping them apart is also why the last parser died: it lived inside
 * gd-gps-scorecard-owner-v1.js with the scorecard UI, and when that file was
 * deleted with the old GPS play runtime on 2026-08-02 the parser went with it.
 *
 * WHERE CARDS ACTUALLY COME FROM
 *
 * Not club websites, mostly. Te Arai Links is ranked in the world top 100 and
 * publishes no hole-by-hole card at all - just "18 hole, par 72" and four tee
 * totals. Course-profile and handicapping sites are the real source: a handful
 * of them, stable layouts, near-complete coverage. That inverts the old
 * resolution ladder, which guessed club domains first and reached an aggregator
 * only as its fourth attempt.
 *
 * It also makes the problem tractable. N clubs means N bespoke layouts and no
 * end to it; a few aggregators means a few adapters, each written once and good
 * for thousands of courses.
 *
 * THE SHAPE THEY SHARE
 *
 * Every one of them lays a card out the same way, and it is the TRANSPOSE of
 * what the old parser assumed:
 *
 *     Hole          1    2    3   ...  Out   10  ...  In    Tot
 *     Handicap     15    1   11             4
 *     Par           5    4    4   ...  36    4   ...  36    72
 *     Championship 530  444  355  ... 3433  433  ... 3345  6778
 *
 * Holes are COLUMNS and each row is labelled by its first cell. So a value is
 * found by its row LABEL, never by its column position - which is the whole
 * failure of the old parser, whose addNumericScorecardRow hardcoded
 * [0]=Black [1]=Blue [2]=White [3]=Yellow [4]=Red [5]=index [6]=par and put
 * every number in the wrong field whenever a club had four tee sets, or six, or
 * listed par first.
 *
 * WHICH TEE ROW GETS READ
 *
 * Any of them. Course identification matches on relative structure - rank order
 * and where the short holes fall - so the tee set never has to be identified
 * correctly for matching to work. That is what makes this robust: the one
 * question the old parser had to answer and always got wrong is now a question
 * nobody has to ask.
 *
 * When an absolute number is wanted, preferredTee picks second-from-longest,
 * which is the usual best fit against mapped geometry. Nothing depends on it.
 *
 * Sources disagree, and that is expected. GolfPass's own per-hole Championship
 * row for Te Arai South sums to 6778 while its tee table for the same course
 * says 6843, and the club's site says 6843 too. Absolute yardage is not
 * trustworthy to the yard from anyone. Relative structure is. */

/* Column headings that are totals, not holes. Dropping these is most of the job:
   an Out column sitting between holes 9 and 10 reads as a hole number otherwise,
   and 36 is a plausible par. */
const TOTAL_HEADINGS = /^(out|in|tot|total|front|back|f9|b9|sub|subtotal)$/i;

/* Row labels that are not tee sets. Everything else on a card is a distance row,
   whatever the club calls its tees - Championship, Back Combo, Tips, Blue, Medal,
   Society, Yellow - which is why tee rows are identified by exclusion rather than
   by a list nobody can finish. */
const PAR_LABEL = /^(par|par m|par w|mens? par|womens? par)$/i;
const HANDICAP_LABEL = /^(h(an)?di?(cap)?\.*|index|s\.?i\.?|stroke( index)?|hcp)\.*$/i;
const SKIP_LABEL = /^(hole|holes|#|tee|yards?|met(er|re)s?|rating|slope|score|putts)$/i;

const YARD_TO_M = 0.9144;

function cleanCell(value) {
  return String(value == null ? "" : value).replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function intOrNull(value) {
  const text = cleanCell(value).replace(/[^\d.-]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function validHoleNumber(value) {
  const n = intOrNull(value);
  return n !== null && n >= 1 && n <= 45 ? n : null;
}

/* The row that names the holes, and what each of its columns means.
 *
 * Found by content, not position: the first row carrying at least six ascending
 * hole numbers. A card can open with a title row, a units toggle or a blank, and
 * anchoring on "row 0" breaks on all three. */
export function findHoleColumns(grid) {
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    const columns = new Map();
    let previous = 0, ascending = true;
    for (let c = 0; c < row.length; c++) {
      const cell = cleanCell(row[c]);
      if (!cell || TOTAL_HEADINGS.test(cell)) continue;
      const hole = validHoleNumber(cell);
      if (hole === null) continue;
      if (hole <= previous) { ascending = false; break; }
      previous = hole;
      columns.set(c, hole);
    }
    if (ascending && columns.size >= 6) return { headerRow: r, columns };
  }
  return null;
}

/* One table's worth of card. Returns null when the grid holds no hole row at all,
   so a caller can sweep every table on a page and keep what answers. */
export function parseScorecardGrid(grid, options = {}) {
  const found = findHoleColumns(grid || []);
  if (!found) return null;
  const { headerRow, columns } = found;

  const par = {}, handicap = {}, tees = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const label = cleanCell(row[0]);
    if (!label) continue;
    /* A second header row - the 10-18 block of a card split into two stacked
       tables - ends this block rather than being read as a tee called "Hole". */
    if (findHoleColumns([row])) break;

    const values = {};
    columns.forEach((hole, column) => {
      const n = intOrNull(row[column]);
      if (n !== null) values[hole] = n;
    });
    if (!Object.keys(values).length) continue;

    if (PAR_LABEL.test(label)) { Object.assign(par, values); continue; }
    if (HANDICAP_LABEL.test(label)) { Object.assign(handicap, values); continue; }
    if (SKIP_LABEL.test(label)) continue;
    /* Par is 3-6 and a stroke index is 1-18; a distance row is none of those, so
       a mislabelled or unlabelled tee row is still recognisable by its values. */
    const numbers = Object.values(values);
    if (numbers.every(n => n >= 1 && n <= 18) && numbers.length > 3) continue;
    tees.push({ name: label, distances: values });
  }

  if (!tees.length && !Object.keys(par).length) return null;
  return { holes: [...columns.values()], par, handicap, tees, unit: options.unit || null };
}

/* Cards split across stacked blocks - 18Birdies puts holes 1-9 in one table and
   10-18 in another, each with its own Hole/Par/Handicap/tee rows - are merged by
   hole number. Tee rows are merged by name so "Championship" from both halves
   becomes one row rather than two nine-hole ones. */
export function mergeScorecardParts(parts) {
  const live = (parts || []).filter(Boolean);
  if (!live.length) return null;
  const merged = { holes: [], par: {}, handicap: {}, tees: [], unit: live.find(p => p.unit)?.unit || null };
  const teesByName = new Map();
  live.forEach(part => {
    merged.holes.push(...part.holes);
    Object.assign(merged.par, part.par);
    Object.assign(merged.handicap, part.handicap);
    part.tees.forEach(tee => {
      const key = tee.name.toLowerCase();
      if (!teesByName.has(key)) teesByName.set(key, { name: tee.name, distances: {} });
      Object.assign(teesByName.get(key).distances, tee.distances);
    });
  });
  merged.holes = [...new Set(merged.holes)].sort((a, b) => a - b);
  merged.tees = [...teesByName.values()];
  return merged;
}

/* Second-longest tee set. The longest is the championship card almost nobody
   plays and the one least like mapped geometry; the next one down is the usual
   best fit. Only matters when an absolute distance is wanted - see the header. */
export function preferredTee(tees) {
  const scored = (tees || [])
    .map(tee => ({ tee, total: Object.values(tee.distances).reduce((s, v) => s + v, 0) }))
    .filter(entry => entry.total > 0)
    .sort((a, b) => b.total - a.total);
  if (!scored.length) return null;
  return (scored[1] || scored[0]).tee;
}

/* Metres, from whatever the source printed. Detected from the numbers when the
   source did not say: no golf hole is 500 metres and no 18-hole course is 5000
   metres of par 72, so a mean hole over 300 is yards. */
export function toMetres(distances, unit) {
  const values = Object.values(distances || {});
  if (!values.length) return {};
  const declared = String(unit || "").toLowerCase();
  const isYards = /^y/.test(declared) ? true
    : /^m/.test(declared) ? false
    : values.reduce((s, v) => s + v, 0) / values.length > 300;
  const out = {};
  Object.keys(distances).forEach(hole => {
    out[hole] = isYards ? Math.round(distances[hole] * YARD_TO_M) : distances[hole];
  });
  return out;
}

/* The engine's own shape: [{hole, par, distanceM}], gaps allowed.
 *
 * No 18-hole gate. The old parser threw away anything that was not exactly 18 and
 * moved to the next URL, which discarded perfectly usable cards - twelve clean
 * holes fingerprints a course, and identification tolerates gaps by design. */
export function toEngineCard(parsed, name) {
  if (!parsed) return null;
  const tee = preferredTee(parsed.tees);
  const metres = tee ? toMetres(tee.distances, parsed.unit) : {};
  const holes = parsed.holes.map(hole => ({
    hole,
    par: parsed.par[hole] ?? null,
    distanceM: metres[hole] ?? null,
    strokeIndex: parsed.handicap[hole] ?? null
  })).filter(row => row.par !== null || row.distanceM !== null);
  if (!holes.length) return null;
  return {
    name: name || "",
    holes,
    holeCount: holes.length,
    par: holes.reduce((sum, row) => sum + (row.par || 0), 0) || null,
    teeName: tee ? tee.name : null,
    teeOptions: parsed.tees.map(t => t.name)
  };
}

/* Whole page: every table on it, stacked blocks merged, one card out.
   grids is [[row, row, ...], ...] - one grid per <table>. */
/* Every card on a page, not just one.
 *
 * Tables are grouped by their heading before merging, so a stacked front/back nine
 * under one heading becomes one card while two courses under two headings stay two.
 * Unlabelled tables join the group before them - that is the 18Birdies shape, where
 * the second nine's table sits under the same heading as the first. */
/* A heading is a title, not a name: "South Course Scorecard", "North Course - Score
   Card", "Hole by hole". The trailing noun is what the page calls the TABLE, and
   carrying it into a course name puts "Scorecard" on a course_maps row. */
export function cleanCardLabel(label) {
  const text = cleanCell(label)
    .replace(/\s*[-\u2013\u2014:]?\s*(hole[\s-]?by[\s-]?hole|score\s?card|scorecard|yardages?|tees?\s*&?\s*yardages?)\s*$/i, "")
    .replace(/\s*[-\u2013\u2014:]\s*$/, "")
    .trim();
  /* A heading that was ONLY the noun leaves nothing, and an empty name is better
     than "Scorecard" - the caller falls back to the page title. */
  return /^(scorecard|score card|hole by hole)$/i.test(cleanCell(label)) ? "" : text;
}

export function parseScorecardCards(grids, options = {}) {
  const groups = [];
  (grids || []).forEach(grid => {
    const parsed = parseScorecardGrid(grid, options);
    if (!parsed) return;
    const label = cleanCardLabel(grid && grid.label);
    const last = groups[groups.length - 1];
    if (last && (!label || label === last.label)) last.parts.push(parsed);
    else groups.push({ label, parts: [parsed] });
  });
  return groups
    .map(group => toEngineCard(mergeScorecardParts(group.parts), group.label || options.name))
    .filter(Boolean);
}

/* One card, for callers that know the page holds a single course. */
export function parseScorecardPage(grids, options = {}) {
  const cards = parseScorecardCards(grids, options);
  if (!cards.length) return null;
  /* Merged rather than "first" when a page is genuinely one course split over
     several unlabelled tables - mergeScorecardParts already handles that above, so
     more than one card here means the page really did hold more than one course. */
  return cards[0];
}

/* ---------- HTML -> grids ------------------------------------------------
 *
 * Deliberately dependency-free rather than linkedom or cheerio. Everything above
 * this line is pure and testable; this is the one place that touches markup, and
 * a scorecard is a plain <table> of <tr> and <td> - no scripts to run, no layout
 * to compute, no selectors to resolve. Pulling a DOM library into a Netlify
 * function to read that would be a dependency carried for one regex's worth of
 * work.
 *
 * The old parser needed a real DOM because it read doc.body.innerText, which is a
 * layout concept no server-side parser provides - and that dependency is the sole
 * reason scorecard resolution lived in the browser, which is in turn why
 * course_scorecards has never had a row written to it. */

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " ", ndash: "-", mdash: "-" };

function decodeEntities(text) {
  return String(text || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
    const key = code.toLowerCase();
    if (HTML_ENTITIES[key]) return HTML_ENTITIES[key];
    if (key[0] === "#") {
      const value = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
    }
    return whole;
  });
}

/* Cell text with markup removed. <br> becomes a space rather than nothing so
   "530<br>yds" does not read as "530yds". Nested spans, links and images are
   dropped outright - a scorecard cell's meaning is entirely in its text. */
function cellText(html) {
  return cleanCell(decodeEntities(String(html || "")
    .replace(/<(br|\/tr|\/td|\/th)[^>]*>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, "")));
}

/* Every <table> on the page, each as an array of rows of cell strings.
 *
 * colspan is honoured because header rows use it for grouping; rowspan is not,
 * because no scorecard needs it and guessing wrong there silently shifts a whole
 * row of distances by one hole. */
/* The heading a table sits under.
 *
 * A card is labelled by the page, not just by the page's title: an aggregator that
 * carries BOTH of a club's courses puts "South Course Scorecard" above one table and
 * "North Course Scorecard" above the next. Without this every table on the page
 * merged into one card and a two-course page became a single 36-hole nonsense.
 *
 * Nearest preceding heading, since that is what a reader would use. */
function headingBefore(source, index) {
  const before = source.slice(Math.max(0, index - 4000), index);
  const headings = before.match(/<h[1-6]\b[^>]*>[\s\S]{1,200}?<\/h[1-6]>/gi);
  if (!headings || !headings.length) return "";
  return cellText(headings[headings.length - 1].replace(/<\/?h[1-6][^>]*>/gi, ""));
}

export function extractTableGrids(html) {
  const source = String(html || "");
  const grids = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let table;
  while ((table = tableRe.exec(source))) {
    const rows = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let row;
    while ((row = rowRe.exec(table[1]))) {
      const cells = [];
      const cellRe = /<(t[dh])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
      let cell;
      while ((cell = cellRe.exec(row[1]))) {
        const span = Number((cell[2].match(/colspan\s*=\s*["']?(\d+)/i) || [])[1]) || 1;
        cells.push(cellText(cell[3]));
        for (let i = 1; i < Math.min(span, 24); i++) cells.push("");
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length >= 2) {
      /* The label rides on the array so callers that only want rows are unaffected. */
      rows.label = headingBefore(source, table.index);
      grids.push(rows);
    }
  }
  return grids;
}

/* Page text with markup and non-content elements stripped, for courseFactsFromText. */
export function pageText(html) {
  return cleanCell(decodeEntities(String(html || "")
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")));
}

/* The whole job for one fetched page: tables out, card back, prose as fallback
   for the count and par when the page carries no card at all. */
export function parseScorecardCardsHtml(html, options = {}) {
  const cards = parseScorecardCards(extractTableGrids(html), options);
  const facts = courseFactsFromText(pageText(html));
  return cards.map(card => Object.assign(card, {
    statedHoleCount: facts.holeCount,
    par: card.par || facts.par
  }));
}

export function parseScorecardHtml(html, options = {}) {
  const card = parseScorecardPage(extractTableGrids(html), options);
  const facts = courseFactsFromText(pageText(html));
  if (card) {
    /* Prose fills only what the table did not say. A stated "par 72" never
       overrides a par row that was actually read hole by hole. */
    return Object.assign(card, { statedHoleCount: facts.holeCount, par: card.par || facts.par });
  }
  if (!facts.holeCount && !facts.par) return null;
  /* No card, but "18 hole, par 72" is still the expectedHoles that three of the
     mapper's guards depend on. Worth returning on its own. */
  return { name: options.name || "", holes: [], holeCount: null, statedHoleCount: facts.holeCount, par: facts.par, teeName: null, teeOptions: [] };
}

/* Hole count and par from prose, for the many pages that carry no table.
 *
 * The single most valuable field in the engine and the cheapest to get. Te Arai's
 * mapper run had expectedHoles null - no shared card, no OSM holes tag - and that
 * one null disabled the wider-frame retry, the geometry-resolver handoff AND the
 * "published incomplete" warning. Three guards, one missing number, and the club's
 * own page says "The 18 hole, par 72 golf course" in plain English. */
export function courseFactsFromText(text) {
  const clean = cleanCell(text).toLowerCase();
  const holes = clean.match(/\b(9|12|18|27|36)[\s-]*hole\b/) || clean.match(/\bholes?\b[\s:]*\b(9|12|18|27|36)\b/);
  const par = clean.match(/\bpar[\s:]*\b(2[0-9]|[67][0-9]|8[0-9])\b/);
  return {
    holeCount: holes ? Number(holes[1]) : null,
    par: par ? Number(par[1]) : null
  };
}
