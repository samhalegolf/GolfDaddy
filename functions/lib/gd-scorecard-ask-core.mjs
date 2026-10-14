/* "Ask AI for this card": what we ask Claude about a course's scorecard, and how the answer
 * is read. Pure - no network, no SDK - so both are testable.
 *
 * The point is NOT a model that writes to the database. The operator wants to ask "what are
 * the pars and lengths of this course?" and have the answer land in the scorecard paste box
 * as if they had pasted it themselves, to check and Import by hand. So the model is told to
 * answer in exactly the tab-separated card the paste box already reads (lib/
 * gd-scorecard-upload-core cardsFromText), with a short header saying where it looked, and
 * readAskAnswer runs that same parser over the card part before anything is stored: an
 * answer the paste box could not read is reported as such, with the raw text kept for the
 * operator to fix. */

import { cardsFromText } from "./gd-scorecard-upload-core.mjs";

export const ASK_CONFIDENCE = ["high", "medium", "low"];
export const ASK_UNITS = ["yards", "metres"];
const SEPARATOR = /^\s*---+\s*$/m;

function text(value, max) { return String(value == null ? "" : value).trim().slice(0, max || 200); }

/* course - {name, lat, lng}; siblings - the other course names at the same facility, if any. */
export function buildScorecardAskPrompt({ course, siblings }) {
  const name = text(course && course.name, 120) || "the course";
  const where = course && Number.isFinite(Number(course.lat)) && Number.isFinite(Number(course.lng))
    ? " It is at latitude " + Number(course.lat).toFixed(5) + ", longitude " + Number(course.lng).toFixed(5) + "."
    : "";
  const others = (Array.isArray(siblings) ? siblings : []).map(s => text(s, 120)).filter(s => s && s !== name);
  return [
    "An operator is filling in the scorecard for " + name + ", a golf course." + where +
    " Find its CURRENT scorecard: the par and stroke index of every hole, and every hole's length from each set of tees the club publishes, named the way the club names them (White, Yellow, Red, Blue, Championship, Members, Ladies...). Use the club's own website first, then the national golf federation or union, then a reputable course directory. Search the web; do not guess from memory if a source can be found. Say which page you took the numbers from.",
    others.length
      ? "The same site has other courses: " + others.join(", ") + ". Return the card for " + name + " only, and say in NOTES if you are not sure which of the site's cards is which."
      : "If the club has more than one course or several nines, return the one that matches the name " + name + " and say in NOTES which others exist.",
    "Answer in EXACTLY this layout and nothing else - no prose before or after it. Five header lines, a line of three dashes, then the card as tab-separated rows: a Hole row with the hole numbers, a Par row, an SI row (stroke index, leave out if not published), then one row per tee set, each starting with the tee's name followed by that tee's length for each hole. Numbers only in the card rows, no totals, no units in the cells. Eighteen holes go in one Hole row (1 to 18), not two nines.",
    "COURSE: <the course name as the club writes it>",
    "UNIT: <yards or metres - whichever the lengths are in>",
    "SOURCE: <the URL you read the card from, or 'memory' if you could not find one>",
    "CONFIDENCE: <high, medium or low - how sure you are these are this course's current numbers>",
    "NOTES: <one line: anything the operator should know - a recent redesign, a card you could not confirm, which tee is the men's standard>",
    "---",
    "Hole\t1\t2\t3\t…\t18",
    "Par\t4\t3\t5\t…\t4",
    "SI\t7\t15\t1\t…\t10",
    "White\t354\t148\t512\t…\t389",
    "Yellow\t340\t138\t495\t…\t372"
  ].join("\n\n");
}

function header(block, key) {
  const match = new RegExp("^\\s*" + key + "\\s*:\\s*(.*)$", "im").exec(block);
  return match ? text(match[1], 600) : "";
}

/* The model's answer -> what goes on the ask row. `cardText` is exactly the part the operator
   will see in the paste box; `cards` says what the paste box's own parser makes of it. */
export function readAskAnswer(answer) {
  const whole = String(answer || "").replace(/\r/g, "").replace(/^```[a-z]*\s*|\s*```$/gi, "").trim();
  if (!whole) return { error: "the model answered with nothing" };
  const split = whole.split(SEPARATOR);
  const head = split.length > 1 ? split[0] : "";
  let card = (split.length > 1 ? split.slice(1).join("\n") : whole).trim();
  /* A card the model wrote with runs of spaces instead of tabs still reads: two or more
     spaces become a tab, which is what the paste box's own splitter looks for first. */
  if (!card.includes("\t")) card = card.split("\n").map(line => line.trim().replace(/ {2,}/g, "\t")).join("\n");
  const unitWord = header(head, "UNIT").toLowerCase();
  const unit = /^y/.test(unitWord) ? "yards" : /^m/.test(unitWord) ? "metres" : "";
  const confidenceWord = header(head, "CONFIDENCE").toLowerCase();
  const confidence = ASK_CONFIDENCE.find(level => confidenceWord.startsWith(level)) || "";
  const cards = cardsFromText(card, unit ? { unit } : {});
  const first = cards[0] || null;
  return {
    cardText: card.slice(0, 20000),
    courseName: header(head, "COURSE"),
    unit,
    source: header(head, "SOURCE"),
    confidence,
    notes: header(head, "NOTES"),
    cards: cards.length,
    holes: first && Array.isArray(first.holes) ? first.holes.length : 0,
    tees: first && Array.isArray(first.tees) ? first.tees.length : 0,
    readable: cards.length > 0
  };
}
