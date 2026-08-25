/* Shared by every path that can create a new course_maps row for a
   coordinate the player picked: is this actually a course we already have,
   under a different id or name?

   Moved out of course-package.mjs so course-mapper-jobs.mjs can use the same
   check on its own direct enqueue route (POST /api/course-mapper-jobs), which
   used to bypass course-package.mjs's guard entirely - a courseId slug drift
   between two publish/enqueue calls for the same physical course was the
   route the "accidental third Te Arai row" took. Each caller keeps its own
   supabaseFetch (passed in) rather than this module owning an HTTP client -
   same "every function owns its own request plumbing" convention already
   used across functions/. */

import { nearbyKnownCourses, classifyCourseRelationship } from "./gd-automapper-core.mjs";

const MAPS_TABLE = "course_maps";

function hasGeometryPayload(row) {
  if (!row) return false;
  const objects = row.objects_json && typeof row.objects_json === "object" ? row.objects_json : {};
  const holes = row.holes_json && typeof row.holes_json === "object" ? row.holes_json : {};
  return Object.keys(objects).length > 0 || Object.keys(holes).length > 0;
}

/* A generous bounding box narrows the candidate set before the exact-distance check in
   nearbyKnownCourses - avoids a full-table scan while staying wide enough that radiusM
   (in metres) is never clipped. */
export async function findDuplicateCourseWithGeometry(supabaseFetch, { courseId, courseName, center, radiusM }) {
  const pad = 0.06;
  const rows = await supabaseFetch(
    MAPS_TABLE + "?select=course_id,course_name,course_lat,course_lng,objects_json,holes_json&published=eq.true" +
    "&course_lat=gte." + (center.lat - pad) + "&course_lat=lte." + (center.lat + pad) +
    "&course_lng=gte." + (center.lng - pad) + "&course_lng=lte." + (center.lng + pad) + "&limit=50"
  ).catch(() => []);
  const candidates = (Array.isArray(rows) ? rows : [])
    .filter(row => row.course_id !== courseId && hasGeometryPayload(row))
    .map(row => ({ courseId: row.course_id, courseName: row.course_name, courseLat: row.course_lat, courseLng: row.course_lng }));
  const nearby = nearbyKnownCourses(center, candidates, radiusM);
  /* Proximity alone is NOT duplication. Every course at a 36-hole facility sits within
     radiusM of its siblings, so taking the nearest mapped course meant the second course
     at a facility was permanently shadowed by the first: it was handed the sibling's
     geometry and never enqueued a job of its own. Only redirect when the candidate is
     genuinely the same course under a different id/name.

     The courseId fallback matters for callers that send a location but no display name -
     ids here are slugs of the name ("taupo-golf-club-centennial"), so un-slugging the
     hyphens recovers enough for the facility/label split to work. */
  const request = { courseId, courseName: courseName || String(courseId || "").replace(/-+/g, " ") };
  return nearby.find(candidate => classifyCourseRelationship(request, candidate) === "duplicate") || null;
}
