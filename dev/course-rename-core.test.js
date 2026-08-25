/* Renaming a course must never lose what it used to be called, and never move its id.
 *
 * A multi-course site publishes as "Course 1" / "Course 2" because the loops are
 * separated before anything knows which is North and which is South. A real name
 * arrives later; accepting it has to be free.
 *
 * Run: node dev/course-rename-core.test.js */

const assert = require("assert");
const path = require("path");
const CORE = "file://" + path.join(__dirname, "..", "functions", "lib", "gd-course-rename-core.mjs");

(async () => {
  const r = await import(CORE);

  /* ---------- what counts as a name worth showing a player ------------ */
  assert.strictEqual(r.isPublishableCourseName("Te Arai Links - South Course"), true);
  assert.strictEqual(r.isPublishableCourseName("Course 1"), false, "our own provisional label is not an improvement");
  assert.strictEqual(r.isPublishableCourseName("Scorecard"), false, "a table heading is not a course name");
  assert.strictEqual(r.isPublishableCourseName("Hole by hole"), false);
  assert.strictEqual(r.isPublishableCourseName("  "), false);

  /* ---------- only ever more specific -------------------------------- */
  assert.strictEqual(r.shouldRename("Te Arai Links - Course 1", "Te Arai Links - South Course"), true,
    "a provisional name loses to a real one");
  assert.strictEqual(r.shouldRename("Te Arai Links - South Course", "Te Arai Links"), false,
    "the facility must not overwrite the course - that is the direction a facility-level search pushes");
  assert.strictEqual(r.shouldRename("Te Arai Links", "Te Arai Links - South Course"), true,
    "but the course supersedes the facility");
  assert.strictEqual(r.shouldRename("Te Arai Links - South Course", "Mangawhai Golf Club"), false,
    "an unrelated longer name is not an improvement, it is a different course");
  assert.strictEqual(r.shouldRename("Te Arai Links", "Te Arai Links"), false, "no change is not a rename");

  /* ---------- the old name survives ----------------------------------- */
  const patch = r.renamePatch(
    { course_name: "Te Arai Links - Course 1", course_aliases: ["Te Arai Links"] },
    "Te Arai Links - South Course"
  );
  assert.strictEqual(patch.course_name, "Te Arai Links - South Course");
  assert.deepStrictEqual(patch.course_aliases, ["Te Arai Links - Course 1", "Te Arai Links"],
    "the name it used to have is kept, newest first");
  assert(!("course_id" in patch), "a rename must never move the id - visuals and shot history hang off it");
  assert(!("osm_course_ref" in patch), "nor the OSM identity");

  assert.strictEqual(r.renamePatch({ course_name: "Te Arai Links - South Course" }, "Te Arai Links"), null,
    "nothing to change means no write at all");

  /* Repeated renames must not grow the column without bound. */
  let row = { course_name: "Course 1", course_aliases: [] };
  for (let i = 0; i < 20; i++) {
    const next = r.renamePatch(row, "Name " + i + " - Course " + String.fromCharCode(65 + i));
    if (next) row = Object.assign({}, row, next);
  }
  assert(row.course_aliases.length <= 12, "aliases are capped, got " + row.course_aliases.length);

  /* ---------- a reference under an old name still resolves ------------ */
  const renamed = { course_name: "Te Arai Links - South Course", course_aliases: ["Te Arai Links - Course 1"] };
  assert.strictEqual(r.courseAnswersToName(renamed, "Te Arai Links - South Course"), true);
  assert.strictEqual(r.courseAnswersToName(renamed, "te arai links - course 1"), true, "case-insensitive, and via an alias");
  assert.strictEqual(r.courseAnswersToName(renamed, "Tara Iti"), false);
  assert.strictEqual(r.courseAnswersToName(renamed, ""), false);

  console.log("course rename tests passed");
})().catch(error => { console.error(error); process.exit(1); });
