/* Whose overlay row a course draws on.
 *
 * A facility has ONE mapping overlay: the ground is shared, so the shapes are too. It lives on
 * the facility's pinned course - the row every sibling's facility_key names - and its play
 * orders say which holes make which course. Foyle showed what a per-course overlay does: the
 * 18 was split off the par 3's record, opened its own empty overlay, and its mapper run failed
 * because every shape on the ground was on the par 3's row.
 *
 * So the overlay API, the AI scan, the mapper worker and the job queue all ask this first and
 * read and write the owner's row. A course with no facility, or whose facility row is missing,
 * owns its own. Each caller passes its own supabaseFetch (see course-package.mjs). */

const MAPS_TABLE = "course_maps";

export async function overlayOwnerId(supabaseFetch, courseId) {
  if (!courseId) return courseId;
  const rows = await supabaseFetch(MAPS_TABLE + "?select=course_id,facility_key&course_id=eq." + encodeURIComponent(courseId) + "&limit=1").catch(() => null);
  const facilityKey = Array.isArray(rows) && rows[0] ? rows[0].facility_key : null;
  if (!facilityKey || facilityKey === courseId) return courseId;
  const owner = await supabaseFetch(MAPS_TABLE + "?select=course_id&course_id=eq." + encodeURIComponent(facilityKey) + "&limit=1").catch(() => null);
  return Array.isArray(owner) && owner.length ? facilityKey : courseId;
}

/* The courses that share an owner's overlay: the owner itself and every row under it,
   published or not (a retired course is still a variant someone may want back). */
export async function overlayCourses(supabaseFetch, ownerId) {
  const rows = await supabaseFetch(MAPS_TABLE + "?select=course_id,course_name,hole_count,published,course_lat,course_lng&or=(course_id.eq."
    + encodeURIComponent(ownerId) + ",facility_key.eq." + encodeURIComponent(ownerId) + ")").catch(() => []);
  return (Array.isArray(rows) ? rows : [])
    .map(row => ({ courseId: row.course_id, name: row.course_name || row.course_id, holes: row.hole_count || null, published: row.published !== false, lat: row.course_lat, lng: row.course_lng }))
    .sort((a, b) => (a.courseId === ownerId ? -1 : b.courseId === ownerId ? 1 : a.courseId.localeCompare(b.courseId)));
}
