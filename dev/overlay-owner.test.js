/* Whose overlay row a course draws on (functions/lib/gd-overlay-owner.mjs).
 *
 * The case: Foyle, a par 3 on the pinned row and an 18 split off it. Both must draw on the
 * par 3's row - the 18 opening its own empty overlay is the bug this exists for.
 *
 * Run: node dev/overlay-owner.test.js */

const assert = require("assert");
const path = require("path");

const MAPS = [
  { course_id: "foyle-golf-club", course_name: "Foyle Golf Club - Par 3 Course", facility_key: "foyle-golf-club", hole_count: 9, published: true },
  { course_id: "foyle-golf-club-course-2", course_name: "Foyle Golf Club - Eighteen", facility_key: "foyle-golf-club", hole_count: 18, published: true },
  { course_id: "lonely-links", course_name: "Lonely Links", facility_key: null, hole_count: 18, published: true },
  { course_id: "orphan-course-2", course_name: "Orphan - Course 2", facility_key: "orphan", hole_count: 9, published: true }
];

async function stubFetch(url) {
  const eq = field => { const m = url.match(new RegExp(field + "=eq\\.([^&]+)")); return m ? decodeURIComponent(m[1]) : null; };
  const or = url.match(/or=\(course_id\.eq\.([^,]+),facility_key\.eq\.([^)]+)\)/);
  if (or) return MAPS.filter(row => row.course_id === decodeURIComponent(or[1]) || row.facility_key === decodeURIComponent(or[2]));
  return MAPS.filter(row => row.course_id === eq("course_id"));
}

(async () => {
  const { overlayOwnerId, overlayCourses } = await import(path.join(__dirname, "..", "functions", "lib", "gd-overlay-owner.mjs"));
  assert.strictEqual(await overlayOwnerId(stubFetch, "foyle-golf-club-course-2"), "foyle-golf-club", "the 18 draws on the facility's overlay");
  assert.strictEqual(await overlayOwnerId(stubFetch, "foyle-golf-club"), "foyle-golf-club", "the pinned course owns it");
  assert.strictEqual(await overlayOwnerId(stubFetch, "lonely-links"), "lonely-links", "a course on its own owns its own");
  assert.strictEqual(await overlayOwnerId(stubFetch, "orphan-course-2"), "orphan-course-2", "a facility row that is missing does not take the overlay with it");
  const courses = await overlayCourses(stubFetch, "foyle-golf-club");
  assert.deepStrictEqual(courses.map(c => c.courseId), ["foyle-golf-club", "foyle-golf-club-course-2"], "the owner first, then its siblings");
  console.log("overlay owner tests passed");
})().catch(error => { console.error(error); process.exit(1); });
