/* COURSE_NAME_VERSION_TAG - fold a course's version into the NAME the server reports, so
   it reads "Maungakiekie Golf Club (v2.0)".
 *
 * Why this exists at all: an app build that is already shipped draws every other string on
 * its Course Library card on the device. Reading the shipped client
 * (ios/App/App/public/scripts/gd-course-library-pin-lock.js) - map type, size, downloaded
 * date and the update status are all computed locally from the saved record. The name is
 * the only string the server chooses, so on an installed build it is the only way to say
 * which version that device is holding. Everything else needs new app code.
 *
 * Off by default, and meant to be switched back off. The tagged name does not stay on the
 * card: the device saves it into its local library record, and from there it travels into
 * round records and scorecards. Tagging every user's course names permanently to answer a
 * question about one phone is not a trade worth making.
 *
 * Lives here rather than in either endpoint because BOTH have to agree: /api/course-library
 * feeds the app shell's picker, /api/courses-near feeds the older shell's "Find course",
 * and a course downloaded through one path must not be named differently from the same
 * course downloaded through the other. */
import courseVersionLabel from "../../scripts/gd-course-version-label.js";

/* Explicit values rather than "any truthy string", so a var left set to "false" or "0"
   while debugging does not quietly rename every course. */
export function nameVersionTagEnabled(env) {
  const read = typeof env === "function" ? env : (name => process.env[name] || "");
  const raw = String(read("COURSE_NAME_VERSION_TAG") || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/* The name to report. Untagged whenever the switch is off OR there is no version to tag
   with - an untagged name is always the real name, never "Course ()". */
export function taggedCourseName(name, version, enabled) {
  if (!enabled) return name;
  return courseVersionLabel.withName(name, version);
}

export { courseVersionLabel };
