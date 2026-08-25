/* Course library manifest.
 *
 * A device keeps a local library of downloaded courses for speed. To know
 * whether that copy is stale it needs versions, not payloads - pulling full
 * course maps just to discover nothing changed defeats the point, and those
 * payloads run to tens of kilobytes each.
 *
 * This returns one small row per published course. No objects, no holes, no
 * course_json. Everything it reads is either a scalar column or the
 * denormalised hole_count, so the cost does not grow with course size.
 *
 * Two independent versions are reported per course:
 *   objects_version      - the geometry GPS play uses, from course_maps
 *   clarity_map_version  - the processed visual, from course_visuals
 * so the library can update one without the other and show "objects current,
 * new Clarity map available".
 */

import { objectsVersion } from "./lib/gd-course-package-shape.mjs";

const COURSE_TABLE = "course_maps";
const VISUAL_TABLE = "course_visuals";

function env(name) {
  return process.env[name] || "";
}

function supabaseBase() {
  return env("SUPABASE_URL").replace(/\/+$/, "");
}

function supabaseKey() {
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

function hasSupabase() {
  return !!(supabaseBase() && supabaseKey());
}

async function supabaseFetch(path) {
  if (!hasSupabase()) throw new Error("Supabase is not configured");
  const response = await fetch(supabaseBase() + "/rest/v1/" + path, {
    headers: {
      apikey: supabaseKey(),
      Authorization: "Bearer " + supabaseKey(),
      "Content-Type": "application/json"
    }
  });
  const bodyText = await response.text();
  let body = null;
  if (bodyText) {
    try { body = JSON.parse(bodyText); } catch (_error) { body = bodyText; }
  }
  if (!response.ok) {
    const error = new Error("Supabase request failed");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function json(status, body) {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      /* no-store: a stale manifest would defeat the freshness check it exists
         to answer. The response is small enough that caching buys nothing. */
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept"
    }
  });
}

function text(value, max) {
  const clean = value == null ? "" : String(value);
  return max ? clean.slice(0, max) : clean;
}

function integer(value) {
  /* Guard the empty cases explicitly: Number(null) is 0 and Number.isFinite(0)
     is true, so a missing hole_count would report as a course with zero holes
     rather than an unknown one. Those mean very different things to a client
     deciding whether its copy is usable. */
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export default async function courseLibrary(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "GET") return json(405, { error: "Method not allowed" });

  if (!hasSupabase()) {
    return json(503, { error: "Course library is not configured", configured: false });
  }

  const url = new URL(req.url);
  /* Optional delta: a client that already holds a manifest asks only for what
     changed since. Compared against published_at/updated_at as ISO strings,
     which sort correctly. */
  const since = text(url.searchParams.get("since"), 40);

  try {
    let query = COURSE_TABLE
      + "?select=course_id,course_name,course_lat,course_lng,hole_count,facility_key,published_at,updated_at"
      + "&published=eq.true&order=updated_at.desc&limit=1000";
    if (since) query += "&updated_at=gt." + encodeURIComponent(since);

    const rows = await supabaseFetch(query);
    const courses = Array.isArray(rows) ? rows : [];

    /* Visual versions are looked up separately and only for the courses in
       hand, so a course with no Clarity map costs nothing. */
    let visualsByCourse = {};
    if (courses.length) {
      const ids = courses
        .map((row) => text(row.course_id, 160))
        .filter(Boolean)
        .map((id) => '"' + id.replace(/"/g, '') + '"');
      if (ids.length) {
        const visualRows = await supabaseFetch(
          VISUAL_TABLE
          + "?select=course_id,published_version,current_version,status,updated_at"
          + "&course_id=in.(" + ids.join(",") + ")"
        ).catch(() => []);
        (Array.isArray(visualRows) ? visualRows : []).forEach((row) => {
          const id = text(row && row.course_id, 160);
          if (id) visualsByCourse[id] = row;
        });
      }
    }

    const manifest = courses.map((row) => {
      const id = text(row.course_id, 160);
      const visual = visualsByCourse[id] || null;
      return {
        course_id: id,
        course_name: text(row.course_name, 200),
        /* Carried to the client so a search result can group the courses that came
           out of one scan, rather than guessing the link from distance. */
        facilityKey: row.facility_key || null,
        lat: row.course_lat == null ? null : Number(row.course_lat),
        lng: row.course_lng == null ? null : Number(row.course_lng),
        /* Null means the course was published before hole_count existed and has
           not been republished. Deliberately not guessed at. */
        hole_count: integer(row.hole_count),
        objects_version: objectsVersion(row),
        clarity_map_version: visual ? integer(visual.published_version) : null,
        clarity_map_status: visual ? text(visual.status, 40) || null : null
      };
    });

    return json(200, {
      configured: true,
      since: since || null,
      count: manifest.length,
      serverTime: new Date().toISOString(),
      courses: manifest
    });
  } catch (error) {
    return json(error.status || 502, {
      error: "Could not read the course library",
      details: error.body || error.message || String(error)
    });
  }
}

export const config = {
  path: "/api/course-library"
};
