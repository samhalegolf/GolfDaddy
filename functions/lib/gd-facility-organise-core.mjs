/* Facility organise, phase 1 - the pure half. See FACILITY_ORGANISE_PLAN_2026-10-01.md.
 *
 * Reads a facility's published courses and the cards stored for it, works out which card
 * describes which piece of ground, and returns a PLAN: every change it would make, with its
 * evidence and whether it is safe to apply on its own.
 *
 * Phase 1 applies renames only. Everything else - a combination of two nines, an 18 that is
 * really two nines, a course no card explains - is written into the plan for Studio to show,
 * and waits for phase 2 and an admin's approval.
 *
 * Why this exists: the mapper's naming pairs one card with one separated course and can do
 * nothing else. Millbrook's only card is "Remarkables/Arrow Course" - an 18 made of two named
 * nines - over ground the mapper split into four 18s, and nothing could read that. Here an 18
 * card made of two nines is matched both ways: whole, against the 18s, and half by half,
 * against the nines. */

import { matchLoopsToCards, MIN_MATCH_SCORE } from "./gd-scorecard-match-core.mjs";
import { courseLabelOf } from "./gd-course-listing-core.mjs";
import { decodeEntities } from "./gd-scorecard-parse-core.mjs";
import { shouldRename, isProvisionalCourseName } from "./gd-course-rename-core.mjs";

const NINE_MAX_HOLES = 9;
const COURSE_MIN_HOLES = 15;
/* A pairing inside a winning assignment can still be weak on its own - the assignment is
   judged on its average. A rename is only applied on its own evidence. */
const AUTO_RENAME_PAIR_SCORE = MIN_MATCH_SCORE;

/* What a card calls its course, without the club in front or the page's noise:
     "Millbrook Resort &amp; Country Club - Remarkables/Arrow Course" -> "Remarkables / Arrow"
     "Te Arai Links Golf Club - North Course"                          -> "North Course"
     "세종(世宗) 코스 | Par 36"                                          -> "세종(世宗) 코스"
   parts are the nines a combination is made of, in playing order. */
export function cardCourseLabel(cardName) {
  const raw = decodeEntities(cardName || "").replace(/\s+/g, " ").trim();
  let label = (courseLabelOf(raw) || raw).replace(/\s*[|·]\s*par\s*\d+.*$/i, "").trim();
  const parts = label.replace(/\s+course$/i, "").split(/\s*\/\s*/).map(part => part.trim()).filter(Boolean);
  if (parts.length > 1) label = parts.join(" / ");
  return { label, parts: parts.length > 1 ? parts : [] };
}

/* The name a course row gets from a card: the facility, then the course - the convention
   every multi-course row already follows ("Te Arai Links Golf Club - North Course"), so a
   course still reads right where it is listed on its own, outside its parent. */
export function courseNameFromCard(cardName, facilityName) {
  const { label } = cardCourseLabel(cardName);
  return withFacility(label, facilityName);
}

function withFacility(label, facilityName) {
  if (!label) return "";
  const facility = String(facilityName || "").trim();
  if (!facility || label.toLowerCase().includes(facility.toLowerCase())) return label;
  return facility + " - " + label;
}

function holeCountOf(card) {
  return new Set(((card && card.holes) || []).map(row => Number(row && (row.hole ?? row.holeNumber))).filter(Number.isFinite)).size;
}

/* An 18 made of two named nines, cut into the two nine-hole cards it is made of - the back
   nine renumbered 1-9, so it lines up with a nine on the ground numbered 1-9. */
function halvesOf(card, parts) {
  const holes = (card.holes || []).map(row => ({ ...row, hole: Number(row.hole ?? row.holeNumber) })).filter(row => Number.isFinite(row.hole));
  const front = holes.filter(row => row.hole >= 1 && row.hole <= 9);
  const back = holes.filter(row => row.hole >= 10 && row.hole <= 18).map(row => ({ ...row, hole: row.hole - 9 }));
  return [
    { name: parts[0], holes: front, fromCard: card.name, half: "front" },
    { name: parts[1], holes: back, fromCard: card.name, half: "back" }
  ].filter(half => half.holes.length >= 6);
}

/* rows:  [{ courseId, name, aliases, holeCount, lengths: {hole: metres} }]
   cards: [{ name, holes: [{hole, par, distanceM}] }]
   Returns { changes, summary, matches } - see the header. Nothing here touches a database. */
export function planFacilityOrganise({ facilityKey, facilityName, rows, cards }) {
  const changes = [];
  const matches = {};
  const courses = (rows || []).filter(row => row.holeCount >= COURSE_MIN_HOLES);
  const nines = (rows || []).filter(row => row.holeCount > 0 && row.holeCount <= NINE_MAX_HOLES);
  const odd = (rows || []).filter(row => !courses.includes(row) && !nines.includes(row));

  const readable = (cards || []).map(card => ({ card, holes: holeCountOf(card), ...cardCourseLabel(card.name) }))
    .filter(entry => entry.label && entry.holes >= 6);
  const courseCards = readable.filter(entry => entry.holes >= COURSE_MIN_HOLES);
  const nineCards = readable.filter(entry => entry.holes <= NINE_MAX_HOLES);
  /* The nines every combination card is made of. A nine card of the same name wins. */
  const halves = [];
  courseCards.filter(entry => entry.parts.length === 2).forEach(entry => {
    halvesOf(entry.card, entry.parts).forEach(half => {
      if (nineCards.some(nine => nine.label.toLowerCase() === half.name.toLowerCase())) return;
      if (halves.some(other => other.name.toLowerCase() === half.name.toLowerCase())) return;
      halves.push(half);
    });
  });

  const named = new Map();
  function considerRenames(group, groupCards, labelOf) {
    if (!group.length || !groupCards.length) return null;
    const match = matchLoopsToCards(
      group.map(row => ({ id: row.courseId, lengths: row.lengths })),
      groupCards.map(entry => ({ name: entry.name || entry.card.name, holes: (entry.holes && Array.isArray(entry.holes) ? entry.holes : entry.card.holes) }))
    );
    if (!match.resolved) return match;
    match.assignment.forEach(pair => {
      const row = group.find(candidate => candidate.courseId === pair.loopId);
      const entry = groupCards.find(candidate => (candidate.name || candidate.card.name) === pair.cardName);
      if (!row || !entry) return;
      const to = labelOf(entry);
      named.set(row.courseId, { entry, to });
      if (!to) return;
      const strong = pair.score >= AUTO_RENAME_PAIR_SCORE;
      changes.push({
        type: "rename", courseId: row.courseId, from: row.name, to,
        card: entry.fromCard || entry.card && entry.card.name || pair.cardName,
        score: round(pair.score), margin: round(match.margin),
        auto: strong && shouldRename(row.name, to),
        why: !strong ? "this course's own match is weak" : (shouldRename(row.name, to) ? null : "current name is not a placeholder")
      });
    });
    return match;
  }

  matches.courses = summariseMatch(considerRenames(courses, courseCards, entry => withFacility(entry.label, facilityName)));
  matches.nines = summariseMatch(considerRenames(nines,
    nineCards.map(entry => ({ ...entry })).concat(halves.map(half => ({ ...half, label: half.name }))),
    entry => withFacility(entry.label || entry.name, facilityName)));

  /* A combination card whose two nines are both on the ground as nines: a course to list
     under the parent. Recorded for phase 2, which adds the table it lives in. */
  courseCards.filter(entry => entry.parts.length === 2).forEach(entry => {
    /* By the nine's NAME, not by which card it was read from: a nine shared by two
       combinations is named once, from whichever card came first. */
    const nineNamed = part => [...named.entries()].find(([courseId, value]) => nines.some(row => row.courseId === courseId)
      && String(value.entry.label || value.entry.name || "").toLowerCase() === part.toLowerCase());
    const front = nineNamed(entry.parts[0]);
    const back = nineNamed(entry.parts[1]);
    if (front && back) {
      changes.push({ type: "combination", name: withFacility(entry.label, facilityName), frontCourseId: front[0], backCourseId: back[0], card: entry.card.name, auto: false });
    }
    /* The same card matched WHOLE to an 18 on the ground: that 18 is these two nines.
       Splitting it is a phase-2 change and always needs approval. */
    const whole = [...named.entries()].find(([, value]) => value.entry === entry);
    if (whole) {
      changes.push({ type: "split", courseId: whole[0], front: entry.parts[0], back: entry.parts[1], card: entry.card.name, auto: false,
        why: "this 18 is two named nines - splitting lets each nine join other combinations" });
    }
  });

  /* Ground no card explains, once every card has had its chance. Provisional and unmatched
     is either a course whose card is still missing or a neighbouring club - a person decides. */
  (rows || []).forEach(row => {
    if (named.has(row.courseId)) return;
    if (odd.includes(row)) {
      changes.push({ type: "review", courseId: row.courseId, name: row.name, reason: "unusual-hole-count", holes: row.holeCount, auto: false });
      return;
    }
    if (isProvisionalCourseName(row.name)) {
      changes.push({ type: "review", courseId: row.courseId, name: row.name, reason: readable.length ? "no-card-matches-this-course" : "no-cards-stored", auto: false });
    }
  });

  const renames = changes.filter(change => change.type === "rename");
  return {
    facilityKey, facilityName,
    cards: readable.map(entry => ({ name: entry.card.name, label: entry.label, holes: entry.holes, nines: entry.parts })),
    matches,
    changes,
    summary: {
      courses: (rows || []).length,
      cards: readable.length,
      renames: renames.filter(change => change.auto).length,
      waiting: changes.filter(change => !change.auto && change.type !== "rename").length + renames.filter(change => !change.auto).length
    }
  };
}

function summariseMatch(match) {
  if (!match) return null;
  return { resolved: !!match.resolved, reason: match.reason || null, score: round(match.score), margin: round(match.margin) };
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}
