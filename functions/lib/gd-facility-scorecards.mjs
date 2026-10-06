/* A facility's stored cards, and what they say its courses are called.
 *
 * Shared by Update Scorecards (which goes looking for cards on the web) and the
 * drop zone on a course row (which is handed one). Both end the same way: the
 * facility's distinct cards are matched against the geometry already published
 * for each sibling course, and a course is renamed only when that match is
 * confident. The matching rule lives here once so the two routes cannot drift.
 *
 * Every function takes the caller's own supabaseFetch - each Netlify function owns
 * its request plumbing (see course-package.mjs), so none is created here. */

import { distinctCards, distinctCardCount, facilityScorecardRow } from "./gd-scorecard-resolve.mjs";
import { matchLoopsToCards, courseLengthsFromPublishedGeometry } from "./gd-scorecard-match-core.mjs";
import { renamePatch } from "./gd-course-rename-core.mjs";
import { splitCourseName } from "./gd-automapper-core.mjs";

export const MAPS_TABLE = "course_maps";
export const SCORECARDS_TABLE = "course_scorecards";

const MAP_FIELDS = "course_id,course_name,course_lat,course_lng,facility_key,course_aliases,objects_json,holes_json,region,country,published";

/* The pinned course and every published sibling under its facility. Null when the
   course is not in course_maps at all. */
export async function loadFacilityChildren(supabaseFetch, courseId) {
  const rows = await supabaseFetch(MAPS_TABLE + "?select=" + MAP_FIELDS + "&course_id=eq." + encodeURIComponent(courseId) + "&limit=1");
  const pinned = Array.isArray(rows) ? rows[0] : null;
  if (!pinned) return null;
  const facilityKey = pinned.facility_key || pinned.course_id;
  if (!pinned.facility_key) return { facilityKey, pinned, children: [pinned] };
  const siblings = await supabaseFetch(MAPS_TABLE + "?select=" + MAP_FIELDS + "&facility_key=eq." + encodeURIComponent(facilityKey) + "&published=eq.true");
  const children = (Array.isArray(siblings) ? siblings : []).filter(row => row && row.course_id);
  /* The pinned row's own facility_key already equals facilityKey (the worker
     stamps it on every sibling including itself), so it is normally already in
     `children` - this only guards a row that predates that write. */
  if (!children.some(row => row.course_id === pinned.course_id)) children.push(pinned);
  return { facilityKey, pinned, children };
}

/* "Te Arai Links" from "Te Arai Links - North Course": the name cards are searched
   and labelled under. */
export function facilityNameOf(pinned, fallback) {
  return splitCourseName((pinned && pinned.course_name) || "").facility || (pinned && pinned.course_name) || fallback;
}

/* Every stored row under a facility, as the raw rows the key resolver compares against. */
export async function fetchFacilityRows(supabaseFetch, facilityKey) {
  if (!facilityKey) return [];
  const rows = await supabaseFetch(SCORECARDS_TABLE + "?select=course_key,course_name,holes_json,source,source_url,sources_json&facility_key=eq." + encodeURIComponent(facilityKey)).catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

/* The same rows as cards the matcher can use. */
export function cardsFromRows(rows) {
  return (rows || [])
    .filter(row => Array.isArray(row.holes_json) && row.holes_json.length)
    .map(row => ({ name: row.course_name, holes: row.holes_json, source: row.source, sourceUrl: row.source_url }));
}

/* Upsert the distinct cards under a facility. `filter(existing, row)` lets a caller
   keep a protected row (Update Scorecards does); the drop zone passes none, because
   an admin's own card outranks whatever a scrape stored. Returns the rows written. */
export async function storeFacilityCards(supabaseFetch, { cards, name, facilityKey, filter }) {
  const existing = await fetchFacilityRows(supabaseFetch, facilityKey);
  const rows = distinctCards(cards || []).map(card => facilityScorecardRow(card, name, facilityKey, existing)).filter(Boolean)
    .filter(row => !filter || filter(existing.find(old => old.course_key === row.course_key), row));
  if (!rows.length) return [];
  await supabaseFetch(SCORECARDS_TABLE + "?on_conflict=course_key", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(rows)
  });
  return rows;
}

/* Name each sibling course from the cards, when the evidence allows it.
 *
 * matchLoopsToCards can confidently name ONE course from a single card even when
 * the facility has two - "shorter side governs" is right for a resolver naming
 * whatever it can, but wrong for a facility-level rename: a player seeing one
 * sibling renamed to "North Course" while the other still reads "Course 2" is a
 * worse, more confusing state than leaving both provisional. So evidence for
 * every expected course is required before matching is even attempted. */
export async function relabelFacility(supabaseFetch, { children, cards }) {
  const want = children.length;
  const distinct = distinctCardCount(cards);
  const loops = children.map(row => ({ id: row.course_id, lengths: courseLengthsFromPublishedGeometry(row.objects_json) }));
  const match = distinct >= want
    ? matchLoopsToCards(loops, distinctCards(cards))
    : { resolved: false, reason: "insufficient-evidence", assignment: [] };

  const renamed = [];
  if (match.resolved) {
    for (const pair of match.assignment) {
      const row = children.find(child => child.course_id === pair.loopId);
      if (!row || !pair.cardName) continue;
      const patch = renamePatch(row, pair.cardName);
      if (!patch) continue;
      await supabaseFetch(MAPS_TABLE + "?course_id=eq." + encodeURIComponent(row.course_id), {
        method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch)
      });
      renamed.push({ courseId: row.course_id, from: row.course_name, to: patch.course_name });
    }
  }

  const plural = n => n === 1 ? "" : "s";
  const message = distinct < want
    ? "Found " + distinct + " of " + want + " required course card" + plural(want) + ". Labels unchanged."
    : !match.resolved
      ? distinct + " card" + plural(distinct) + " found but match was not confident enough. Labels unchanged."
      : renamed.length
        ? "Found " + distinct + " distinct course card" + plural(distinct) + ". Course labels updated."
        : "Found " + distinct + " distinct course card" + plural(distinct) + ". Labels already up to date.";

  return { want, distinct, resolved: !!match.resolved, reason: match.reason || null, renamed, message };
}
