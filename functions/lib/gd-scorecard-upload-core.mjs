/* An admin hands us a scorecard. What did they hand us, and what card is in it?
 *
 * The drop zone on a course row accepts whatever an admin has to hand: a photo or
 * scan of the printed card, a PDF from the club, the club's web page saved as
 * HTML, a spreadsheet export as CSV or tab-separated text, a card pasted straight
 * out of a web table, or a JSON card in the shape we store. Everything here is
 * pure - the model-backed reads for pictures and PDFs live in gd-scorecard-vision
 * - so every text route can be tested on the real pasted text.
 *
 * Text is the interesting one. A card pasted from a web page arrives as tab-
 * separated lines:
 *
 *   Hole   1    2    3  ...  9    Out
 *   Par    4    3    4  ...  4    35
 *   SI     11   15   9  ...  1
 *   Yards  300  119  333 ... 455  2,986
 *   Hole   10   11   12 ...  18   In    Total
 *   ...
 *
 * That is the horizontal layout the HTML parser already understands, so the text
 * becomes a grid and goes through parseScorecardCards exactly as a page's tables
 * would: split at each "Hole" row, the nines merged into one 18-hole card. */

import { parseScorecardCards, parseScorecardCardsHtml, toEngineCard } from "./gd-scorecard-parse-core.mjs";

export const UPLOAD_KINDS = ["image", "pdf", "html", "text", "json"];
export const MAX_TEXT_CHARS = 650000;

const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif)$/i;

/* What a file is, by its declared type first and its name second. Spreadsheets and
   Word documents are refused by name so the admin hears "export it as CSV" rather
   than a parse failure. */
export function classifyUpload(file) {
  const type = String((file && file.mediaType) || "").toLowerCase().split(";")[0].trim();
  const name = String((file && file.name) || "").toLowerCase();
  if (IMAGE_TYPES.test(type) || /\.(jpe?g|png|webp|gif)$/.test(name)) return "image";
  if (type === "application/pdf" || /\.pdf$/.test(name)) return "pdf";
  if (type === "text/html" || type === "application/xhtml+xml" || /\.html?$/.test(name)) return "html";
  if (type === "application/json" || /\.json$/.test(name)) return "json";
  if (/\.(xlsx?|docx?|numbers|pages)$/.test(name)) return null;
  if (type.startsWith("text/") || /\.(csv|tsv|txt|md)$/.test(name) || (!type && file && typeof file.text === "string")) return "text";
  return null;
}

/* One line of CSV or TSV into cells. Tabs win when present - a tab-separated paste
   can carry "2,986" in a cell - otherwise commas, honouring double quotes, and
   failing both, runs of two or more spaces. */
export function splitDelimitedLine(line) {
  const text = String(line || "").replace(/\r$/, "");
  if (text.includes("\t")) return text.split("\t").map(cell => cell.trim());
  if (text.includes(",")) {
    const cells = [];
    let cell = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') {
        if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
      } else if (ch === "," && !quoted) {
        cells.push(cell.trim()); cell = "";
      } else cell += ch;
    }
    cells.push(cell.trim());
    return cells;
  }
  return text.trim().split(/\s{2,}|\s+(?=\d)/).map(cell => cell.trim());
}

/* Pasted or uploaded text as one grid. parseScorecardCards splits it at each
   hole-header row and merges the nines, exactly as it does for a page's tables. */
export function textToGrid(text) {
  return String(text || "").slice(0, MAX_TEXT_CHARS).split(/\n/).map(splitDelimitedLine).filter(row => row.some(Boolean));
}

export function cardsFromText(text, options = {}) {
  return parseScorecardCards([textToGrid(text)], { name: options.name, unit: options.unit });
}

export function cardsFromHtml(html, options = {}) {
  return parseScorecardCardsHtml(String(html || "").slice(0, MAX_TEXT_CHARS), { name: options.name, unit: options.unit });
}

/* A card already in the shape we store or serve: { name|courseName, holes:[{hole, par,
   index|strokeIndex, metres|distanceM, tees:{name:{metres}} }] }. */
export function cardFromJson(value, options = {}) {
  let data = value;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch (e) { return null; }
  }
  if (data && data.scorecard && Array.isArray(data.scorecard.holes)) data = data.scorecard;
  if (!data || !Array.isArray(data.holes) || !data.holes.length) return null;
  const holes = data.holes.map(hole => {
    const number = Number(hole && (hole.hole != null ? hole.hole : hole.number));
    const par = Number(hole && hole.par);
    if (!Number.isFinite(number) || !Number.isFinite(par)) return null;
    const index = Number(hole.strokeIndex != null ? hole.strokeIndex : hole.index);
    const metres = Number(hole.distanceM != null ? hole.distanceM : hole.metres);
    const teesM = {};
    Object.entries(hole.teesM || hole.tees || {}).forEach(([tee, entry]) => {
      const m = Number(entry && typeof entry === "object" ? entry.metres : entry);
      if (Number.isFinite(m) && m > 0) teesM[tee] = Math.round(m);
    });
    return {
      hole: number, par,
      strokeIndex: Number.isFinite(index) ? index : null,
      distanceM: Number.isFinite(metres) ? Math.round(metres) : null,
      teesM
    };
  }).filter(Boolean).sort((a, b) => a.hole - b.hole);
  if (holes.length < 9) return null;
  const name = String(data.name || data.courseName || options.name || "").trim();
  return toEngineCard({
    holes: holes.map(h => h.hole),
    par: Object.fromEntries(holes.map(h => [h.hole, h.par])),
    handicap: Object.fromEntries(holes.filter(h => h.strokeIndex != null).map(h => [h.hole, h.strokeIndex])),
    tees: teesFromHoles(holes),
    unit: "metres"
  }, name);
}

function teesFromHoles(holes) {
  const byTee = new Map();
  holes.forEach(hole => {
    Object.entries(hole.teesM).forEach(([tee, metres]) => {
      if (!byTee.has(tee)) byTee.set(tee, {});
      byTee.get(tee)[hole.hole] = metres;
    });
    if (hole.distanceM != null && !Object.keys(hole.teesM).length) {
      if (!byTee.has("Card")) byTee.set("Card", {});
      byTee.get("Card")[hole.hole] = hole.distanceM;
    }
  });
  return [...byTee.entries()].map(([name, distances]) => ({ name, distances }));
}

/* Every text-route file in an upload, as cards. Pictures and PDFs are left for the
   caller to send to the vision reader; they come back here as `deferred`. */
export function cardsFromUpload(files, options = {}) {
  const cards = [], deferred = [], rejected = [];
  (files || []).forEach(file => {
    const kind = classifyUpload(file);
    const label = String((file && file.name) || "pasted text");
    if (kind === "image" || kind === "pdf") { deferred.push(Object.assign({ kind }, file)); return; }
    if (!kind) { rejected.push({ name: label, reason: "unsupported-format" }); return; }
    const text = String(file.text || "");
    /* The browser's OCR knows whether the card it read said yards or metres. */
    const fileOptions = file.unit ? Object.assign({}, options, { unit: file.unit }) : options;
    let found = [];
    if (kind === "html") found = cardsFromHtml(text, fileOptions);
    else if (kind === "json") found = [cardFromJson(text, fileOptions)].filter(Boolean);
    else found = cardsFromText(text, fileOptions);
    /* A .txt that is really a saved web page still has its tables. */
    if (!found.length && kind === "text" && /<table/i.test(text)) found = cardsFromHtml(text, fileOptions);
    if (!found.length) rejected.push({ name: label, reason: "no-card-found" });
    found.forEach(card => cards.push(Object.assign({ from: label }, card)));
  });
  return { cards, deferred, rejected };
}
