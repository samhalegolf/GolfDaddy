/* Renaming a course without losing what it used to be called. — pure.
 *
 * A course arrives named whatever the scan could work out, and for a multi-course
 * site that is usually provisional: the loops are separated before anything knows
 * which is the North and which is the South, so they publish as "Course 1" and
 * "Course 2" and play perfectly well under those names.
 *
 * A better name can arrive later, and it must not cost anything to accept. The rules
 * that make that safe:
 *
 *   the id never moves      course_id and osm_course_ref are the identity. Renaming
 *                           a row must not orphan its visuals, its captured surfaces
 *                           or a player's shot history, which is exactly what
 *                           deriving an id from a name would risk.
 *   the old name is kept    appended to course_aliases, so a search or a stored
 *                           reference under the previous name still resolves. A name
 *                           is a label; labels accumulate rather than replace.
 *   a name is never truth   it can be missing, generic, wrong, or simply change -
 *                           Craigtoun was the Duke's until January 2026. Nothing
 *                           keys on it. */

/* A name worth putting in front of a player. Rejects the generic table headings a
   parser picks up ("Scorecard", "Hole by hole") and our own provisional labels,
   because replacing "Course 1" with "Course 1" is not an improvement. */
export function isPublishableCourseName(name) {
  const text = String(name || "").trim();
  if (text.length < 3) return false;
  if (/^course\s*\d+$/i.test(text)) return false;
  if (/^(scorecard|score\s?card|hole[\s-]?by[\s-]?hole|course|golf course|the course)$/i.test(text)) return false;
  return true;
}

/* Is the new name actually better than the one the row has?
 *
 * A provisional name loses to anything publishable. A real name is only replaced by
 * one that is MORE specific - "Te Arai Links" must not overwrite "Te Arai Links -
 * South Course", which is the direction a facility-level search result would push. */
export function shouldRename(current, candidate) {
  if (!isPublishableCourseName(candidate)) return false;
  const now = String(current || "").trim();
  if (!now) return true;
  if (now === candidate) return false;
  if (/course\s*\d+$/i.test(now)) return true;
  /* Longer only counts when it CONTAINS the current name - "Foo - South Course"
     supersedes "Foo"; an unrelated longer string does not. */
  const a = now.toLowerCase(), b = candidate.toLowerCase();
  return b.includes(a) && b.length > a.length;
}

/* The row patch for a rename: the new display name, and the old one preserved.
   Returns null when nothing should change, so a caller can skip the write. */
export function renamePatch(row, candidate) {
  const current = String((row && row.course_name) || "").trim();
  const next = String(candidate || "").trim();
  if (!shouldRename(current, next)) return null;
  const aliases = Array.isArray(row && row.course_aliases) ? row.course_aliases : [];
  return {
    course_name: next,
    /* Newest first, current name excluded, deduped - and capped, because a course
       that gets renamed repeatedly should not grow an unbounded column. */
    course_aliases: [...new Set([current, ...aliases].filter(Boolean).filter(alias => alias !== next))].slice(0, 12),
    updated_at: new Date().toISOString()
  };
}

/* Does this row answer to that name? Current name or any alias.
   Used by lookups so a reference under an old name still resolves. */
export function courseAnswersToName(row, name) {
  const wanted = String(name || "").trim().toLowerCase();
  if (!wanted) return false;
  const names = [(row && row.course_name) || "", ...(Array.isArray(row && row.course_aliases) ? row.course_aliases : [])];
  return names.some(candidate => String(candidate || "").trim().toLowerCase() === wanted);
}
