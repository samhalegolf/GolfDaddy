/* GET /api/courses-near?lat=&lng= — every golf course around a point.
 *
 * The course picker's second step. The first step resolves a NAME to a place
 * (Nominatim, client side); this resolves that place to the courses actually on
 * it, and it never sees the search term. Searching "st andrews" has to return
 * Craigtoun, Balgove, Jubilee and Eden - none of which are called St Andrews
 * anything - so carrying the query through would quietly return half the list
 * and look like it worked.
 *
 * Server side rather than in the picker for three reasons: Overpass needs a
 * User-Agent and a rate limiter that already exist here
 * (lib/gd-overpass-client.mjs), the browser would hit CORS, and concentrating
 * this on the function IP keeps one polite caller instead of thousands.
 *
 * Fail-soft by contract. Overpass is a shared, goodwill-funded service and is
 * busy often; a failure here returns the courses we already hold maps for with
 * `partial: true` rather than an error, because the picker's job is to let
 * someone start a round. The caller falls back to its flat list when this
 * returns nothing at all. */

import { fetchOverpass } from "./lib/gd-overpass-client.mjs";
import {
  COURSES_NEAR_RADIUS_M,
  boundingBox,
  coursesFromOverpass,
  mergeWithLibrary,
  nearbyCoursesQuery
} from "./lib/gd-courses-near-core.mjs";
import { nameVersionTagEnabled, taggedCourseName, courseVersionLabel } from "./lib/gd-course-name-version-tag.mjs";

const COURSE_TABLE = "course_maps";
const MAX_RADIUS_M = 25000;

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }

function json(status, body) {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      /* Five minutes: what courses exist near a point does not change on a
         human timescale, and the picker may ask twice while someone is still
         deciding. Long enough to matter, short enough that a course mapped
         today shows up today. */
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept"
    }
  });
}

/* Courses we already hold a map for, inside the bounding box. Read even when
   Overpass fails, which is what makes the failure mode useful rather than
   empty. */
async function libraryNear(lat, lng, radiusM) {
  if (!hasSupabase()) return [];
  const box = boundingBox(lat, lng, radiusM);
  const query = COURSE_TABLE
    + "?select=course_id,course_name,course_lat,course_lng,hole_count,objects_revision"
    + "&published=eq.true"
    + "&course_lat=gte." + box.minLat + "&course_lat=lte." + box.maxLat
    + "&course_lng=gte." + box.minLng + "&course_lng=lte." + box.maxLng
    + "&limit=200";
  const response = await fetch(supabaseBase() + "/rest/v1/" + query, {
    headers: {
      apikey: supabaseKey(),
      Authorization: "Bearer " + supabaseKey(),
      "Content-Type": "application/json"
    }
  });
  if (!response.ok) return [];
  const body = await response.json().catch(() => null);
  return Array.isArray(body) ? body : [];
}

/* Names tagged with their version, for an installed app build that can show a version no
   other way - see lib/gd-course-name-version-tag.mjs. Off by default and costing nothing
   when off: the extra read below only happens once the switch is on.
 *
 * Applied AFTER mergeWithLibrary, never before. That merge decides whether an OSM course
 * and a mapped course are the same place by comparing the slug of their names, so a course
 * renamed to "Akarana Golf Club (v2.0)" would stop matching plain "Akarana Golf Club" and
 * the picker would list the same course twice - once mapped, once not. */
async function tagVersionNames(courses, libraryRows) {
  const revisionById = {};
  (Array.isArray(libraryRows) ? libraryRows : []).forEach((row) => {
    const id = String((row && row.course_id) || "");
    if (id) revisionById[id] = row.objects_revision;
  });
  const ids = Object.keys(revisionById);
  if (!ids.length) return courses;

  let visualsById = {};
  try {
    const query = "course_visuals?select=course_id,bake_number,bake_objects_revision"
      + "&course_id=in.(" + ids.map((id) => '"' + id.replace(/"/g, "") + '"').join(",") + ")";
    const response = await fetch(supabaseBase() + "/rest/v1/" + query, {
      headers: {
        apikey: supabaseKey(),
        Authorization: "Bearer " + supabaseKey(),
        "Content-Type": "application/json"
      }
    });
    if (response.ok) {
      const rows = await response.json().catch(() => null);
      (Array.isArray(rows) ? rows : []).forEach((row) => {
        const id = String((row && row.course_id) || "");
        if (id) visualsById[id] = row;
      });
    }
  } catch (error) { /* no versions to tag with: names stay untouched */ }

  return courses.map((course) => {
    const id = String((course && course.courseId) || "");
    if (!id || !Object.prototype.hasOwnProperty.call(revisionById, id)) return course;
    const visual = visualsById[id] || null;
    const version = courseVersionLabel.courseVersion({
      bakeNumber: visual ? visual.bake_number : null,
      objectsRevision: revisionById[id],
      bakeObjectsRevision: visual ? visual.bake_objects_revision : null
    });
    return Object.assign({}, course, { name: taggedCourseName(course.name, version, true) });
  });
}

export default async function coursesNear(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "GET") return json(405, { error: "Method not allowed" });

  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return json(400, { error: "lat and lng are required" });
  }
  const asked = Number(url.searchParams.get("radius"));
  const radiusM = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_RADIUS_M) : COURSES_NEAR_RADIUS_M;
  const anchor = { lat, lng };

  /* Both reads start together: the library read does not depend on Overpass,
     and Overpass is the slow one. */
  const [library, overpass] = await Promise.all([
    libraryNear(lat, lng, radiusM).catch(() => []),
    fetchOverpass(nearbyCoursesQuery(lat, lng, radiusM)).catch((error) => ({ __error: error }))
  ]);

  const failed = !!(overpass && overpass.__error);
  const osmCourses = failed ? [] : coursesFromOverpass(overpass, anchor);
  const merged = mergeWithLibrary(osmCourses, library, anchor);
  const tagNames = nameVersionTagEnabled(env);
  const courses = tagNames ? await tagVersionNames(merged, library) : merged;

  return json(200, {
    anchor,
    radiusM,
    /* Said out loud so a tagged name is never a mystery to whoever reads this response. */
    nameVersionTag: tagNames,
    /* True means the list is the courses we happen to hold maps for, not
       everything that is there. The picker says so rather than presenting a
       short list as complete. */
    partial: failed,
    count: courses.length,
    courses
  });
}

export const config = {
  path: "/api/courses-near"
};
