/* "What golf courses are near this point?" — the pure half.
 *
 * The course picker's second step. Step one finds a PLACE by name (Nominatim,
 * client side, unchanged); this answers what is actually there, and it
 * deliberately forgets the name that got us the coordinate. That is the whole
 * mechanism: searching "st andrews" has to surface Craigtoun, Balgove, Jubilee
 * and Eden, none of which carry "St Andrews" anywhere in their name.
 *
 * Overpass rather than a second Nominatim call because `leisure=golf_course` is
 * an exact tag and free-text "golf" is not - that query returns driving ranges,
 * golf shops, Golf Road and Golf View Cottage, and no amount of client-side
 * filtering fixes it. The mapper already talks to Overpass through a throttled,
 * identified client (gd-overpass-client.mjs), so this adds a query shape rather
 * than a dependency.
 *
 * Nothing here claims the returned courses belong together. They are near each
 * other, which is a fact we computed; a parent-child relationship would be a
 * claim we invented from proximity. The caller renders distance, never
 * hierarchy - see the picker's meta line. */

import { distance } from "./gd-automapper-core.mjs";

/* Matches the picker's own NEARBY_M. St Andrews is the case that sets it:
   Castle sits ~1.6km from the Old Course and Craigtoun ~4km, so anything
   tighter silently drops two of the eight courses. */
export const COURSES_NEAR_RADIUS_M = 5200;

/* A course_maps row and an OSM footprint are the same course when their centres
   are this close. Generous because a course_maps centre is a clubhouse pin or a
   hole-1 tee while the OSM centre is the polygon centroid, and on a long links
   those are properly far apart. Two DIFFERENT courses whose centroids fall
   within 600m of each other are rare enough to accept the odd merge. */
const SAME_COURSE_M = 600;

export function courseSlug(value) {
  return String(value || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/* Both tags, because many courses carry only one. golf=course is the golf
   schema's own; leisure=golf_course is what most mappers actually reach for. */
export function nearbyCoursesQuery(lat, lng, radiusM) {
  const radius = Math.round(Number(radiusM) > 0 ? Number(radiusM) : COURSES_NEAR_RADIUS_M);
  const at = "(around:" + radius + "," + Number(lat) + "," + Number(lng) + ")";
  const selectors = [
    ["way", "leisure", "golf_course"], ["relation", "leisure", "golf_course"],
    ["way", "golf", "course"], ["relation", "golf", "course"]
  ];
  /* `out tags center` not `out geom`: the picker needs a name and a point, and
     asking for full geometry on eight links courses is megabytes for nothing. */
  return "[out:json][timeout:18];("
    + selectors.map(([type, key, value]) => type + at + '["' + key + '"="' + value + '"];').join("")
    + ");out tags center;";
}

function elementPoint(element) {
  const centre = element && element.center ? element.center : element;
  const lat = Number(centre && centre.lat);
  const lng = Number(centre && (centre.lng ?? centre.lon));
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/* One entry per course. OSM tags the same course as both a way and a relation
   often enough that dropping duplicates here is not optional - and an unnamed
   footprint is useless in a picker, so it is dropped rather than shown as
   "Course". */
export function coursesFromOverpass(payload, anchor) {
  const byKey = new Map();
  ((payload && payload.elements) || []).forEach((element) => {
    const tags = (element && element.tags) || {};
    const name = String(tags.name || "").trim();
    const point = elementPoint(element);
    if (!name || !point) return;
    const key = courseSlug(name);
    if (!key) return;
    const entry = {
      name,
      lat: point.lat,
      lng: point.lng,
      osmType: String(element.type || ""),
      osmId: element.id == null ? null : Number(element.id),
      distanceM: anchor ? Math.round(distance(anchor, point)) : null
    };
    const seen = byKey.get(key);
    /* A relation describes the whole course; a way is often one part of it. */
    if (!seen || (seen.osmType !== "relation" && entry.osmType === "relation")) byKey.set(key, entry);
  });
  return [...byKey.values()];
}

/* Courses we already hold a map for must win: they are playable immediately,
   and showing the OSM copy beside them would offer the player two rows for one
   course where only one of them works. Matched by proximity first (names drift
   between OSM and a club's own wording) and by slug second. */
export function mergeWithLibrary(osmCourses, libraryRows, anchor) {
  const library = (Array.isArray(libraryRows) ? libraryRows : []).map((row) => {
    const point = {
      lat: Number(row && (row.course_lat ?? row.lat)),
      lng: Number(row && (row.course_lng ?? row.lng))
    };
    return {
      name: String((row && (row.course_name || row.name)) || "").trim(),
      courseId: String((row && (row.course_id || row.courseId)) || "").trim(),
      lat: Number.isFinite(point.lat) ? point.lat : null,
      lng: Number.isFinite(point.lng) ? point.lng : null,
      holeCount: row && row.hole_count == null ? null : Number(row.hole_count),
      hasMap: true,
      distanceM: anchor && Number.isFinite(point.lat) && Number.isFinite(point.lng)
        ? Math.round(distance(anchor, point)) : null
    };
  }).filter((row) => row.name && row.courseId);

  const claimed = new Set();
  (Array.isArray(osmCourses) ? osmCourses : []).forEach((osm) => {
    const slug = courseSlug(osm.name);
    const match = library.find((row) => {
      if (courseSlug(row.name) === slug) return true;
      if (row.lat == null || row.lng == null) return false;
      return distance(row, osm) <= SAME_COURSE_M;
    });
    if (match) claimed.add(osm);
  });

  const unmapped = (Array.isArray(osmCourses) ? osmCourses : [])
    .filter((osm) => !claimed.has(osm))
    .map((osm) => Object.assign({ courseId: null, holeCount: null, hasMap: false }, osm));

  return library.concat(unmapped).sort((a, b) => {
    const ad = Number.isFinite(a.distanceM) ? a.distanceM : Infinity;
    const bd = Number.isFinite(b.distanceM) ? b.distanceM : Infinity;
    if (ad !== bd) return ad - bd;
    return String(a.name).localeCompare(String(b.name));
  });
}

/* A degrees-per-metre box for the Supabase pre-filter, so the library read is a
   bounded scan rather than the whole table. Deliberately a touch wider than the
   radius - the exact distance test happens in mergeWithLibrary. */
export function boundingBox(lat, lng, radiusM) {
  const radius = Number(radiusM) > 0 ? Number(radiusM) : COURSES_NEAR_RADIUS_M;
  const dLat = radius / 111320;
  const dLng = radius / (111320 * Math.max(0.05, Math.cos(Number(lat) * Math.PI / 180)));
  return {
    minLat: Number(lat) - dLat, maxLat: Number(lat) + dLat,
    minLng: Number(lng) - dLng, maxLng: Number(lng) + dLng
  };
}
