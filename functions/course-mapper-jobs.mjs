/* Server-side AutoMapper job queue API. Structural sibling of course-visual-jobs.mjs, kept as
   a SEPARATE table/endpoint rather than a third `kind` on course_visual_jobs: geometry
   resolution (this) and image rendering (course-visual-jobs.mjs) are different
   responsibilities with different failure modes, and folding them together would couple two
   pipelines' status/dedupe/rate-limit rules for no benefit.

   POST {courseId, kind:"automap"} (ANY player, signed in or not) -> enqueues a mapping run and
   pings the background worker. This is the app's only way to start a mapping run - there is no
   admin-authored recipe path here the way there is for visual jobs, because AutoMapper takes
   no authoring input. A signed-out caller identifies itself with {guestId}, a persistent
   per-installation string (scripts/gd-guest-identity.js); see mapperActorKey below for what
   that is and is not.
   POST {courseId, kind:"nudge"} (admin only) -> requeues a stalled run.
   GET ?courseId=... -> recent jobs plus a derived mapping state for that course, readable by
   players so the app can poll cheaply while it plays over live tiles + a Lite Geometry Pack.
   GET with no courseId -> the same derived state for EVERY course, one row each, for the
   admin list. Same vocabulary as the single-course form so a row and its detail cannot
   disagree.

   The worker itself is functions/course-mapper-worker-background.mjs. */

import { MAPPER_VERSION, SURFACE_TYPES, HAND_DRAWN_SURFACE_TYPES } from "./lib/gd-automapper-core.mjs";
import { findDuplicateCourseWithGeometry } from "./lib/gd-duplicate-course-guard.mjs";
import { fetchOverpass } from "./lib/gd-overpass-client.mjs";
import { boundingBox, coursesFromOverpass, mergeWithLibrary, nearbyCoursesQuery } from "./lib/gd-courses-near-core.mjs";

import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";
const TABLE = "course_mapper_jobs";
const MAPS_TABLE = "course_maps";
const VISUALS_TABLE = "course_visuals";
const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);

/* These are protective circuit-breakers, not product entitlements. A signed-in player may
   search/prepare as many courses as they reasonably need; the high ceiling only stops a loop
   from hammering Overpass or the mapper queue. Guests have a separate product rule below:
   one SUCCESSFUL prepared map, then a free account is required. Failed attempts do not spend
   that free success. */
const AUTO_RATE_WINDOW_MS = 30 * 60 * 1000;
const AUTO_RATE_MAX_PER_USER = 60;
const AUTO_RATE_MAX_PER_GUEST = 4;
const GUEST_SUCCESS_LIMIT = 1;

/* Who asked for this mapping run, as the one string that goes in requested_by and that the
   rate limit is keyed to:

     user:<supabase-user-id>   a verified session
     guest:<installation-id>   an anonymous install (scripts/gd-guest-identity.js)

   A guest id is NOT an account: nothing is created for it, it carries no personal data, and
   it never unlocks the operator actions below. It exists so a signed-out golfer can have a
   course prepared for them - which is the normal first run of this app - while still being
   countable. A verified user always wins over a supplied guest id, so a signed-in player
   cannot spend a guest budget by also sending one. */
const GUEST_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;
export function mapperActorKey({ userId, guestId } = {}) {
  const uid = String(userId || "").trim();
  if (uid) return "user:" + uid;
  const gid = String(guestId || "").trim().toLowerCase();
  return GUEST_ID_RE.test(gid) ? "guest:" + gid : "";
}
function isGuestActor(actorKey) {
  return String(actorKey || "").startsWith("guest:");
}
function actorRateLimit(actorKey) {
  return isGuestActor(actorKey) ? AUTO_RATE_MAX_PER_GUEST : AUTO_RATE_MAX_PER_USER;
}

/* Same reasoning as course-visual-jobs.mjs's STALL_SECONDS: the worker heartbeats between
   OSM fetch, per-hole resolution and green-shape refinement, so silence this long is a dead
   invocation, not a slow one. */
const STALL_SECONDS = 120;
const ASSUMED_COURSE_MATCH_RADIUS_M = 4000; // same radius course-package.mjs uses

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function anonKey() { return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || ""; }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }

async function verifiedUser(req, payload) {
  const header = String((req && req.headers && typeof req.headers.get === "function" && req.headers.get("authorization")) || "");
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const token = bearer || String(payload && (payload.accessToken || payload.access_token) || "").trim();
  if (!token) return null;
  const base = supabaseBase();
  const key = anonKey() || supabaseKey();
  if (!base || !key) return null;
  try {
    const response = await fetch(base + "/auth/v1/user", { method: "GET", headers: { apikey: key, Authorization: "Bearer " + token } });
    if (!response.ok) return null;
    const user = await response.json();
    if (!user || !user.id) return null;
    const email = String(user.email || "").trim().toLowerCase();
    return { id: String(user.id), email, isAdmin: ADMIN_EMAILS.has(email) };
  } catch (error) {
    return null;
  }
}

const supabaseFetch = createSupabaseFetch({
  base: supabaseBase,
  key: supabaseKey,
  label: "course-mapper-jobs"
});

function slug(value) { return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90); }

/* Two shapes, one answer. A course_maps row carries the geometry itself; a
   course_maps_list row carries the view's counts of it (object_count,
   hole_count). The counts are what the state reads now - see LIST_VIEW below -
   but a row that still arrives with the payload is judged the same way, so a
   caller that has the geometry in hand need not fetch the counts to ask. */
function hasGeometryPayload(map) {
  if (!map) return false;
  const objectCount = Number(map.object_count);
  const holeCount = Number(map.hole_count);
  if (Number.isFinite(objectCount) || Number.isFinite(holeCount)) {
    return (Number.isFinite(objectCount) && objectCount > 0) || (Number.isFinite(holeCount) && holeCount > 0);
  }
  const objects = map.objects_json && typeof map.objects_json === "object" ? map.objects_json : {};
  const holes = map.holes_json && typeof map.holes_json === "object" ? map.holes_json : {};
  return Object.keys(objects).length > 0 || Object.keys(holes).length > 0;
}

/* Whether a course has geometry is answered from the counts view, never from
   the geometry itself.
 *
 * mapperBuildStateAll used to read objects_json and holes_json for every
 * published course - about 12 MB of JSON, serialised by Postgres and shipped
 * to this function - purely to ask Object.keys(...).length > 0 per row. The
 * Studio asks this endpoint on load and every 5 seconds while any bar is
 * live, so during a build it was a 12 MB read every 5 seconds. Alongside the
 * phone's library sync that was enough to fill PostgREST's connection pool;
 * every other read (the picker's course package, the row status polls, the
 * Studio list itself) then queued behind it until it timed out, and the
 * Studio fell back to its local cache (18 Sep 2026, 08:13-08:27 UTC).
 *
 * course_maps_list computes object_count and hole_count in the database from
 * the same two columns, so the answer is identical and the read is a few
 * hundred bytes. */
const LIST_VIEW = "course_maps_list";

/* Derived from what EXISTS over what the job queue last said, same reasoning as
   course-visual-jobs.mjs's courseBuildState: a course with published geometry is playable
   (over the live map, as a Lite Geometry Pack) no matter what the queue says.

     geometry-ready  - course_maps has published geometry; the app can render a Lite pack
     running/queued  - a mapping run is in flight; the app plays live tiles with no overlay yet
     failed          - the last run failed and nothing is in flight
     none            - never mapped; a player selecting this course may start one */
/* Every course's mapping state in one request.
 *
 * The admin Course Database lists every course at once and needs to show which
 * ones failed. Asking /api/course-mapper-jobs per course meant one request per
 * row, so the screen simply did not ask - and a failed scan was invisible even
 * though the reason was sitting in course_mapper_jobs the whole time.
 *
 * Same vocabulary as mapperBuildState so a row and its detail panel can never
 * disagree, and derived the same way: what EXISTS beats what the queue last
 * said, because a course with geometry is playable whatever the queue thinks.
 *
 * Jobs are read newest-first and only the first per course is kept, which is
 * the latest-per-course PostgREST cannot express directly. The cap is a real
 * limit rather than a formality: a course whose jobs all fall outside it
 * reports "none" rather than a wrong answer, so it is set well above the
 * number of courses. */
const BULK_JOB_SCAN_LIMIT = 2000;

/* The enrichment kind. A separate row kind rather than a flag on an automap job, so a
   collection run can never be claimed by the mapping path, can never be deduped against a
   mapping job, and shows up in logs and job history as the different operation it is.

   It and the refine kind below are excluded from the build state on purpose. That state is
   what the PLAYER-facing package flow branches on: counting an admin maintenance sweep as
   "this course is building" would put every course on every phone into Processing while
   nothing about its map was changing. */
export const OBJECT_COLLECTION_KIND = "collect_extra_objects";

/* Re-traces surfaces that already exist, against the course's own published frames
   (gd-surface-refine-core.mjs). Like collection it touches the objects layer alone; unlike
   collection it adds nothing, it only replaces geometry we already had with a lighter ring we
   own. Its own kind for the same reasons - separate dedupe, separate history, and no chance of
   a mapping run claiming it. */
export const SHAPE_REFINE_KIND = "refine_surface_shapes";

/* Background growth of the course database. When a player's scan settles, the courses
   nearest to it that we hold nothing for are queued under this kind - a player who scans one
   course is likely to play one nearby soon, so it is ready when they do.

   Its own kind so it can never get in a player's way:
     - the worker only claims one when no player job is queued or running (claimNextJob in
       course-mapper-worker-background.mjs), and only one at a time;
     - it is never counted against anyone's rate limit or guest allowance (those count
       kind=automap only);
     - a player opening one of these courses while its job is still queued promotes it to an
       ordinary automap job (promoteNearbyJob), so they never wait behind the background queue;
     - it never queues further neighbours itself, so one scan cannot ripple across a region;
     - a failure is quiet: no debug session, no "a course needs mapping" alert, because no
       player was promised anything.
   It is still a MAPPING job (not a maintenance kind): a course with one queued reads as
   "processing" like any other build. */
export const NEARBY_AUTOMAP_KIND = "nearby_automap";
export const NEARBY_PREFETCH_COUNT = 10;
const NEARBY_PREFETCH_RADIUS_M = 25000;
const NEARBY_ACTOR_PREFIX = "nearby:";

const MAINTENANCE_KINDS = new Set([OBJECT_COLLECTION_KIND, SHAPE_REFINE_KIND]);
const isMappingJob = job => !MAINTENANCE_KINDS.has(String(job && job.kind || "automap"));

async function mapperBuildStateAll() {
  const [jobRows, mapRows] = await Promise.all([
    supabaseFetch(TABLE + "?select=course_id,kind,status,error,result,mapper_version,created_at,updated_at&order=created_at.desc&limit=" + BULK_JOB_SCAN_LIMIT).catch(() => []),
    supabaseFetch(LIST_VIEW + "?select=course_id,published,hole_count,object_count&limit=2000").catch(() => [])
  ]);
  const jobs = Array.isArray(jobRows) ? jobRows : [];
  const maps = Array.isArray(mapRows) ? mapRows : [];

  const latestByCourse = new Map();
  const liveByCourse = new Map();
  jobs.filter(isMappingJob).forEach((job) => {
    const id = String(job && job.course_id || "");
    if (!id) return;
    if (!latestByCourse.has(id)) latestByCourse.set(id, job);
    if ((job.status === "running" || job.status === "queued") && !liveByCourse.has(id)) liveByCourse.set(id, job);
  });
  /* Live maintenance runs, kept in their own map for the same reason mapperBuildState keeps
     them in their own field: they feed the row's progress bar and never its state. */
  const maintenanceByCourse = new Map();
  jobs.filter(job => !isMappingJob(job)).forEach((job) => {
    const id = String(job && job.course_id || "");
    if (!id) return;
    if ((job.status === "running" || job.status === "queued") && !maintenanceByCourse.has(id)) maintenanceByCourse.set(id, job);
  });

  const courses = {};
  const ids = new Set([...latestByCourse.keys()]);
  maps.forEach((row) => { if (row && row.course_id) ids.add(String(row.course_id)); });
  const mapById = new Map(maps.map((row) => [String(row && row.course_id || ""), row]));

  maintenanceByCourse.forEach((job, id) => ids.add(id));
  ids.forEach((id) => {
    const latest = latestByCourse.get(id) || null;
    const live = liveByCourse.get(id) || null;
    const maintenanceJob = maintenanceByCourse.get(id) || null;
    const hasGeometry = hasGeometryPayload(mapById.get(id) || null);
    let state;
    if (hasGeometry) state = "geometry-ready";
    else if (live) state = live.status === "running" ? "running" : "queued";
    else if (latest && latest.status === "failed") state = "failed";
    else state = "none";
    courses[id] = {
      state,
      hasGeometry,
      /* The whole point of the endpoint: the sentence that says what went
         wrong, in the row, without a second request. */
      lastError: latest && latest.status === "failed" ? String(latest.error || "").slice(0, 300) : null,
      lastJobStatus: latest ? String(latest.status || "") : null,
      lastJobKind: latest ? String(latest.kind || "") : null,
      lastJobAt: latest ? (latest.updated_at || latest.created_at || null) : null,
      mapperVersion: latest ? (latest.mapper_version || null) : null,
      building: !!live,
      progress: (live && live.result && live.result.progress) || null,
      activeKind: live ? String(live.kind || "automap") : null,
      stalled: !!(live && live.status === "running" && live.updated_at
        && (Date.now() - new Date(live.updated_at).getTime()) / 1000 > STALL_SECONDS),
      maintenance: maintenanceJob ? {
        kind: String(maintenanceJob.kind || ""),
        state: maintenanceJob.status === "running" ? "running" : "queued",
        progress: (maintenanceJob.result && maintenanceJob.result.progress) || null,
        stalled: maintenanceJob.status === "running" && maintenanceJob.updated_at
          ? (Date.now() - new Date(maintenanceJob.updated_at).getTime()) / 1000 > STALL_SECONDS
          : false
      } : null
    };
  });

  return {
    courses,
    counted: ids.size,
    /* Says so when the scan cap was reached, rather than letting a truncated
       read look like a complete one. */
    truncated: jobs.length >= BULK_JOB_SCAN_LIMIT,
    currentMapperVersion: MAPPER_VERSION
  };
}

async function mapperBuildState(courseId) {
  const [jobRows, mapRows, countRows] = await Promise.all([
    supabaseFetch(TABLE + "?select=id,kind,status,error,result,mapper_version,created_at,updated_at&course_id=eq." + encodeURIComponent(courseId) + "&order=created_at.desc&limit=8").catch(() => []),
    supabaseFetch(MAPS_TABLE + "?select=course_id,published,geometry_version&course_id=eq." + encodeURIComponent(courseId) + "&published=eq.true&limit=1").catch(() => []),
    /* Counts from the view rather than the geometry from the table - see LIST_VIEW. The
       app polls this while a course maps, and each poll was a full copy of the map. */
    supabaseFetch(LIST_VIEW + "?select=course_id,hole_count,object_count&course_id=eq." + encodeURIComponent(courseId) + "&published=eq.true&limit=1").catch(() => [])
  ]);
  const jobs = Array.isArray(jobRows) ? jobRows : [];
  const mapRow = Array.isArray(mapRows) ? mapRows[0] : null;
  const countRow = Array.isArray(countRows) ? countRows[0] : null;
  const map = mapRow ? Object.assign({}, mapRow, {
    hole_count: countRow ? countRow.hole_count : 0,
    object_count: countRow ? countRow.object_count : 0
  }) : null;
  /* Mapping jobs only - see OBJECT_COLLECTION_KIND. `jobs` still carries every kind for the
     admin history, which is the one place the enrichment runs SHOULD be visible. */
  const mapping = jobs.filter(isMappingJob);
  const live = mapping.find(job => job.status === "running") || mapping.find(job => job.status === "queued");
  /* Collect Extra Objects and Refine Shapes, which isMappingJob deliberately excludes from
     `state` - a maintenance run must never make a fully mapped course read as "Processing".
     They are still WORK, though, and the Course Database now draws a progress bar for every
     long action on the screen, so they are reported here as their own field. Nothing below
     reads this into `state`; it feeds the bar and nothing else. */
  const maintenanceJob = jobs.filter(job => !isMappingJob(job))
    .find(job => job.status === "running" || job.status === "queued") || null;
  const hasGeometry = hasGeometryPayload(map);
  let state;
  if (hasGeometry) state = "geometry-ready";
  else if (live) state = live.status === "running" ? "running" : "queued";
  else if (mapping.length && mapping[0].status === "failed") state = "failed";
  else state = "none";
  const stalledSeconds = live && live.updated_at
    ? Math.max(0, Math.round((Date.now() - new Date(live.updated_at).getTime()) / 1000))
    : null;
  return {
    state,
    hasGeometry,
    geometryVersion: map ? (map.geometry_version || null) : null,
    currentMapperVersion: MAPPER_VERSION,
    building: !!live,
    stalledSeconds,
    stalled: live && live.status === "running" && stalledSeconds != null && stalledSeconds > STALL_SECONDS,
    progress: live && live.result && live.result.progress || null,
    /* Which of the three job kinds is running. The stage names overlap between them
       ("querying-overpass" is emitted by both automap and Collect Extra Objects) and mean a
       different fraction of a different job, so the bar cannot place a stage without it -
       see the per-kind phase tables in scripts/gd-progress-core.js. */
    activeKind: live ? String(live.kind || "automap") : null,
    maintenance: maintenanceJob ? {
      kind: String(maintenanceJob.kind || ""),
      state: maintenanceJob.status === "running" ? "running" : "queued",
      progress: (maintenanceJob.result && maintenanceJob.result.progress) || null,
      stalled: maintenanceJob.status === "running" && maintenanceJob.updated_at
        ? (Date.now() - new Date(maintenanceJob.updated_at).getTime()) / 1000 > STALL_SECONDS
        : false
    } : null,
    lastError: !live && mapping.length && mapping[0].status === "failed" ? String(mapping[0].error || "").slice(0, 300) : null,
    jobs
  };
}

/* Upserts a minimal course_maps row carrying only identity/location columns, so a course
   with no prior geometry still has somewhere for the worker to read a center point from.
   `on_conflict=id` with a partial body only overwrites the columns present here - existing
   objects_json/holes_json on a course that already has geometry are left untouched. Mirrors
   the "published::"+courseId id convention functions/course-maps.mjs uses, so a row created
   here and a row later published through the normal course-maps flow are the same record. */
/* Returns true when the course has a usable centre afterwards - either one was written from
   the request, or a row with coordinates already existed. The worker cannot query Overpass
   without one, so this answer decides whether enqueuing is worth anything at all. */
async function ensureCourseCenter(courseId, payload) {
  const lat = Number(payload && payload.courseLat);
  const lng = Number(payload && payload.courseLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return await hasKnownCentre(courseId);
  try {
    await supabaseFetch(MAPS_TABLE + "?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{
        id: "published::" + courseId,
        course_id: courseId,
        course_name: String(payload.courseName || courseId).slice(0, 200),
        course_lat: lat,
        course_lng: lng,
        published: true
      }])
    });
    return true;
  } catch (error) {
    console.warn("course-mapper-jobs: ensureCourseCenter failed", courseId, error && error.message || error);
    return await hasKnownCentre(courseId);
  }
}

async function hasKnownCentre(courseId) {
  try {
    const rows = await supabaseFetch(MAPS_TABLE + "?select=course_lat,course_lng&course_id=eq." + encodeURIComponent(courseId) + "&limit=1");
    const row = Array.isArray(rows) ? rows[0] : null;
    return !!(row && Number.isFinite(Number(row.course_lat)) && Number.isFinite(Number(row.course_lng)));
  } catch (error) {
    /* Unknown beats false here: a transient read failure should not turn into "this course
       can never be mapped". The worker's own check is the real gate. */
    return true;
  }
}

/* The core "start a mapping run for this course" logic, factored out so
   functions/course-package.mjs can trigger it directly on a cache miss (stage 5 of the
   migration plan) without an internal HTTP round-trip - same reasoning as
   course-visual-worker-background.mjs writing straight to its jobs table instead of calling
   its own sibling endpoint over HTTP.

   An actor is required - `user:<id>` or `guest:<install-id>`, see mapperActorKey - because the
   rate limit and the requested_by provenance are both keyed to it. Callers may pass an
   already-built actorKey, or userId/guestId to have one built here; a caller with neither gets
   {unauthorized:true} and nothing is written. What is NOT required any more is a Supabase
   account: a signed-out golfer opening an unmapped course is the ordinary first run of this
   app, and refusing to map for them meant that run always ended in manual green-tapping. */
export async function enqueueMapperJob({ courseId, courseLat, courseLng, courseName, userId, guestId, actorKey, origin }) {
  const actor = String(actorKey || "").trim() || mapperActorKey({ userId, guestId });
  if (!actor) return { unauthorized: true };
  /* Same guard course-package.mjs's buildCoursePackageWithTrigger already runs before it
     enqueues - needed here too because this is a second, independent front door onto the
     same job queue (POST /api/course-mapper-jobs, reachable directly, not only through
     course-package.mjs's read path). Without it, a courseId slug that drifts between two
     requests for the same physical course (a renamed variant, a different search result for
     the same club) creates a second course_maps row and a second copy of the same geometry -
     see lib/gd-duplicate-course-guard.mjs's header for the case this was written for. Only
     checked when real coordinates are supplied, the same precondition ensureCourseCenter
     itself requires to do anything. */
  const lat = Number(courseLat), lng = Number(courseLng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const duplicate = await findDuplicateCourseWithGeometry(supabaseFetch, {
      courseId, courseName, center: { lat, lng }, radiusM: ASSUMED_COURSE_MATCH_RADIUS_M
    }).catch(() => null);
    if (duplicate) return { duplicate: true, courseId: duplicate.courseId };
  }
  const state = await mapperBuildState(courseId);
  if (state.hasGeometry && state.geometryVersion === MAPPER_VERSION) {
    return { deduped: true, state: state.state, geometryVersion: state.geometryVersion };
  }
  /* A player asked for a course that is only waiting in the background queue: move it to the
     front rather than leaving them behind every other prefetch. */
  if (state.building && state.activeKind === NEARBY_AUTOMAP_KIND) await promoteNearbyJob(courseId, origin);
  if (state.building) return { deduped: true, state: state.state };

  /* Dedupe BEFORE the rate limit, not after. Both answers can be true at once - a guest at
     their limit re-opening a course that is already being mapped - and only one of them is
     useful: there is nothing to start, so there is nothing to refuse. Answered the other way
     round, a player who had spent their budget would be told "slow down" about a job that was
     already running for them, and the client would stop waiting for it. Reusing a live job
     costs no quota, which is the rule the whole limit depends on: picking the same course
     again, or polling one that is mid-build, must never count as a new scan. */
  const freshCutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const existing = await supabaseFetch(TABLE + "?select=id,status&course_id=eq." + encodeURIComponent(courseId) + "&kind=eq.automap&status=in.(queued,running)&updated_at=gt." + encodeURIComponent(freshCutoff) + "&limit=1");
  if (Array.isArray(existing) && existing.length) return { deduped: true, job: existing[0], state: "queued" };

  /* Guest product boundary: one successful prepared map per anonymous installation. This is
     intentionally based on status=done, not "requests started": a failed first attempt should
     not consume the free try. Re-opening the successful course and reusing a live job both
     returned above, so this only gates a NEW map. */
  if (isGuestActor(actor)) {
    const successful = await supabaseFetch(TABLE + "?select=id&requested_by=eq." + encodeURIComponent(actor)
      + "&kind=eq.automap&status=eq.done&order=created_at.desc&limit=" + GUEST_SUCCESS_LIMIT);
    if (Array.isArray(successful) && successful.length >= GUEST_SUCCESS_LIMIT) {
      return { signupRequired: true, state: state.state, actorKey: actor };
    }

    /* Only one anonymous map may be in flight at once. That closes the race where a guest
       could queue several different courses before the first one reaches done. A failed job
       is terminal and therefore does not block an immediate retry. */
    const guestLive = await supabaseFetch(TABLE + "?select=id,course_id,status&requested_by=eq." + encodeURIComponent(actor)
      + "&kind=eq.automap&status=in.(queued,running)&limit=1");
    if (Array.isArray(guestLive) && guestLive.length) {
      return { rateLimited: true, protective: true, state: state.state, actorKey: actor, limit: 1 };
    }
  }

  /* Signed-in "unlimited" means there is no ordinary product quota. This high ceiling (and
     the smaller anonymous one) is only a crash/abuse circuit-breaker. */
  const rateMax = actorRateLimit(actor);
  const since = new Date(Date.now() - AUTO_RATE_WINDOW_MS).toISOString();
  const recent = await supabaseFetch(TABLE + "?select=id&requested_by=eq." + encodeURIComponent(actor)
    + "&kind=eq.automap&created_at=gt." + encodeURIComponent(since) + "&limit=" + (rateMax + 1));
  if (Array.isArray(recent) && recent.length >= rateMax) {
    return { rateLimited: true, protective: true, state: state.state, actorKey: actor, limit: rateMax };
  }

  /* Do not create even the location-only course_maps stub until the actor gates have passed.
     A refused second guest course should leave no server-side footprint that looks half-saved. */
  const located = await ensureCourseCenter(courseId, { courseLat, courseLng, courseName });

  /* Last gate, deliberately after the dedupe and protective-limit answers rather than before them.

     A job for a course with no coordinates cannot succeed - the worker reads the centre from
     course_maps to build the Overpass query and dies on "has no known location", which is how
     kelvin-heights-road (a road out of a geocode, not a golf course) burned a queue slot and
     left a failed row nobody could act on. But "already building" and "slow down" are truer
     answers when they apply: a course mid-build plainly has a centre, and a rate-limited
     caller should hear about the limit. Only a genuinely new, genuinely unlocatable request
     reaches here. */
  if (!located) return { unlocatable: true, state: state.state };

  const inserted = await supabaseFetch(TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{ course_id: courseId, kind: "automap", status: "queued", mapper_version: MAPPER_VERSION, requested_by: actor }])
  });
  const job = Array.isArray(inserted) ? inserted[0] : inserted;
  await pingWorkerAt(origin, job && job.id || null);
  return { queued: true, job, state: "queued", actorKey: actor };
}

/* A player wants this course now. A queued background job becomes an ordinary automap job -
   claimed ahead of the background queue, and woken by its id so it starts straight away. A
   job already running is left alone; it is already doing the work. The status and kind filters
   make this a no-op when the worker claims it first or another request promoted it already. */
export async function promoteNearbyJob(courseId, origin) {
  const promoted = await supabaseFetch(TABLE + "?course_id=eq." + encodeURIComponent(courseId)
    + "&kind=eq." + NEARBY_AUTOMAP_KIND + "&status=eq.queued", {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ kind: "automap", updated_at: new Date().toISOString() })
  }).catch(() => []);
  const job = Array.isArray(promoted) ? promoted[0] : null;
  if (job && origin) await pingWorkerAt(origin, job.id);
  return !!job;
}

/* Queue the courses nearest to a scanned one that we hold nothing for. Called by the worker
   after a player's scan has settled, so the one Overpass query here never competes with it.

   "Hold nothing for" means no course_maps row near it: a mapped course, a course mid-build and
   a course that already failed all have one (ensureCourseCenter writes it before any job), so
   none of them is queued again. Same OSM list and same library merge as /api/courses-near, and
   the same id the picker gives an unmapped OSM course (a slug of its name), so the job lands
   on the row the player will later open.

   Best-effort throughout: a busy Overpass simply means no neighbours this time. */
export async function enqueueNearbyMapperJobs({ sourceCourseId, limit = NEARBY_PREFETCH_COUNT } = {}) {
  const rows = await supabaseFetch(MAPS_TABLE + "?select=course_lat,course_lng&course_id=eq." + encodeURIComponent(sourceCourseId) + "&limit=1").catch(() => []);
  const source = Array.isArray(rows) ? rows[0] : null;
  const lat = Number(source && source.course_lat), lng = Number(source && source.course_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { queued: [], reason: "source-has-no-centre" };

  const box = boundingBox(lat, lng, NEARBY_PREFETCH_RADIUS_M);
  const [library, overpass] = await Promise.all([
    supabaseFetch(MAPS_TABLE + "?select=course_id,course_name,course_lat,course_lng"
      + "&course_lat=gte." + box.minLat + "&course_lat=lte." + box.maxLat
      + "&course_lng=gte." + box.minLng + "&course_lng=lte." + box.maxLng + "&limit=500").catch(() => []),
    fetchOverpass(nearbyCoursesQuery(lat, lng, NEARBY_PREFETCH_RADIUS_M)).catch(error => ({ __error: error }))
  ]);
  if (overpass && overpass.__error) return { queued: [], reason: "overpass-unavailable" };

  const candidates = mergeWithLibrary(coursesFromOverpass(overpass, { lat, lng }), library, { lat, lng })
    .filter(course => !course.hasMap && slug(course.name))
    .slice(0, limit);

  const queued = [];
  for (const course of candidates) {
    const courseId = slug(course.name);
    const center = { lat: course.lat, lng: course.lng };
    const duplicate = await findDuplicateCourseWithGeometry(supabaseFetch, {
      courseId, courseName: course.name, center, radiusM: ASSUMED_COURSE_MATCH_RADIUS_M
    }).catch(() => null);
    if (duplicate) continue;
    /* The id is a name slug, so a same-named course anywhere in the world already owns it.
       Writing this centre over that row would move the other course here. Likewise any live
       job for the id, of any kind - a player may have opened it in the meantime. */
    const [owned, live] = await Promise.all([
      supabaseFetch(MAPS_TABLE + "?select=course_id&course_id=eq." + encodeURIComponent(courseId) + "&limit=1").catch(() => null),
      supabaseFetch(TABLE + "?select=id&course_id=eq." + encodeURIComponent(courseId) + "&status=in.(queued,running)&limit=1").catch(() => null)
    ]);
    if (!Array.isArray(owned) || owned.length || !Array.isArray(live) || live.length) continue;
    if (!await ensureCourseCenter(courseId, { courseLat: center.lat, courseLng: center.lng, courseName: course.name })) continue;
    await supabaseFetch(TABLE, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify([{ course_id: courseId, kind: NEARBY_AUTOMAP_KIND, status: "queued", mapper_version: MAPPER_VERSION, requested_by: NEARBY_ACTOR_PREFIX + sourceCourseId }])
    }).then(() => queued.push(courseId)).catch(() => {});
  }
  return { queued, candidates: candidates.length };
}

/* Enrichment has its own enqueue rather than reusing enqueueMapperJob, because every gate in
   that one is wrong here. It refuses a course that already has geometry at the current mapper
   version - which is exactly the course this action targets. It rate-limits against a player
   budget - this is an admin action. And it dedupes on kind=automap - a mapping run in flight
   must not swallow a collection request, or the enrichment silently never happens.

   The one precondition it does add: saved holes must already exist. Collection uses the saved
   map as its spatial framework and resolves nothing itself, so on a course with no holes it
   would query Overpass and correctly find nowhere to put anything. */
async function enqueueObjectCollectionJob({ courseId, actor, origin }) {
  const rows = await supabaseFetch(MAPS_TABLE + "?select=course_id,holes_json,objects_json&course_id=eq." + encodeURIComponent(courseId) + "&limit=1").catch(() => []);
  const map = Array.isArray(rows) ? rows[0] : null;
  if (!map) return { missing: true };
  if (!Object.keys(map.holes_json || {}).length) return { noHoles: true };

  const freshCutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const existing = await supabaseFetch(TABLE + "?select=id,status&course_id=eq." + encodeURIComponent(courseId)
    + "&kind=eq." + OBJECT_COLLECTION_KIND + "&status=in.(queued,running)&updated_at=gt." + encodeURIComponent(freshCutoff) + "&limit=1");
  if (Array.isArray(existing) && existing.length) return { deduped: true, job: existing[0] };

  const inserted = await supabaseFetch(TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{ course_id: courseId, kind: OBJECT_COLLECTION_KIND, status: "queued", mapper_version: MAPPER_VERSION, requested_by: actor }])
  });
  const job = Array.isArray(inserted) ? inserted[0] : inserted;
  await pingWorkerAt(origin, job && job.id || null);
  return { queued: true, job };
}

/* Refinement needs two things collection does not: surfaces to re-trace, and published frames
   to trace them against. Both are checked here rather than in the worker so an operator gets
   "this course has no frames yet" immediately instead of a failed job row minutes later. */
async function enqueueShapeRefineJob({ courseId, actor, origin }) {
  const [mapRows, visualRows] = await Promise.all([
    supabaseFetch(MAPS_TABLE + "?select=course_id,objects_json&course_id=eq." + encodeURIComponent(courseId) + "&limit=1").catch(() => []),
    supabaseFetch(VISUALS_TABLE + "?select=course_id,uploaded_assets&course_id=eq." + encodeURIComponent(courseId) + "&limit=1").catch(() => [])
  ]);
  const map = Array.isArray(mapRows) ? mapRows[0] : null;
  if (!map) return { missing: true };
  const surfaces = Object.values(map.objects_json || {})
    .filter(o => o && SURFACE_TYPES.has(o.type) && !HAND_DRAWN_SURFACE_TYPES.has(o.type) && Array.isArray(o.shape) && o.shape.length >= 3);
  if (!surfaces.length) return { noSurfaces: true };
  const assets = (Array.isArray(visualRows) ? visualRows[0] : null);
  const frames = ((assets && assets.uploaded_assets) || [])
    .filter(a => a && a.role === "hole-frame-published" && a.metadata && a.metadata.playSurface);
  if (!frames.length) return { noFrames: true };

  const freshCutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const existing = await supabaseFetch(TABLE + "?select=id,status&course_id=eq." + encodeURIComponent(courseId)
    + "&kind=eq." + SHAPE_REFINE_KIND + "&status=in.(queued,running)&updated_at=gt." + encodeURIComponent(freshCutoff) + "&limit=1");
  if (Array.isArray(existing) && existing.length) return { deduped: true, job: existing[0] };

  const inserted = await supabaseFetch(TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{ course_id: courseId, kind: SHAPE_REFINE_KIND, status: "queued", mapper_version: MAPPER_VERSION, requested_by: actor }])
  });
  const job = Array.isArray(inserted) ? inserted[0] : inserted;
  await pingWorkerAt(origin, job && job.id || null);
  return { queued: true, job, surfaces: surfaces.length, frames: frames.length };
}

export default async function courseMapperJobs(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url);
    const courseId = slug(url.searchParams.get("courseId") || url.searchParams.get("course_id"));
    /* No courseId now means "all of them" rather than an error. The admin list
       needs every course's state at once; asking per row is what stopped it
       asking at all. */
    if (!courseId) return json(200, await mapperBuildStateAll());
    return json(200, Object.assign({ courseId }, await mapperBuildState(courseId)));
  }

  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  let payload;
  try { payload = await req.json(); } catch (e) { return json(400, { error: "Invalid JSON" }); }

  const requestedKind = String(payload && payload.kind || "automap");
  const nudge = requestedKind === "nudge";
  const remap = requestedKind === "remap";
  const collect = requestedKind === OBJECT_COLLECTION_KIND;
  const refine = requestedKind === SHAPE_REFINE_KIND;
  const user = await verifiedUser(req, payload);
  /* An anonymous caller may map, but only as itself: a guest install id is accepted here and
     nowhere else. Without a verified user AND without a usable guest id there is no actor to
     charge the run to, so nothing is read or written. */
  const actorKey = user ? mapperActorKey({ userId: user.id }) : mapperActorKey({ guestId: payload && (payload.guestId || payload.guest_id) });
  if (!actorKey) return json(401, { error: "A signed-in session or a guest installation id is required" });
  /* Only "automap" may be enqueued by an ordinary player. "nudge" and "remap" are operator
     actions - one on a stuck run, one on a bad map - same split as course-visual-jobs.mjs's
     export/nudge paths. A guest is never an operator: these ask for user.isAdmin, so an
     anonymous caller falls through to the same 403 a signed-in non-admin gets. */
  if ((nudge || remap || collect || refine) && !(user && user.isAdmin)) return json(403, { error: "Admin verification failed" });

  const courseId = slug(payload && (payload.courseId || payload.course_id));
  if (!courseId) return json(400, { error: "courseId required" });

  if (nudge) {
    const state = await mapperBuildState(courseId);
    let requeued = 0;
    if (state.stalled) {
      const cutoff = new Date(Date.now() - STALL_SECONDS * 1000).toISOString();
      const revived = await supabaseFetch(TABLE + "?course_id=eq." + encodeURIComponent(courseId) + "&status=eq.running&updated_at=lt." + encodeURIComponent(cutoff), {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ status: "queued", error: null, updated_at: new Date().toISOString() })
      });
      requeued = Array.isArray(revived) ? revived.length : 0;
    }
    await pingWorkerAt(new URL(req.url).origin);
    return json(200, Object.assign({ nudged: true, requeued }, await mapperBuildState(courseId)));
  }

  /* Enrichment, handled before the remap/automap path below and returning from here, so there
     is no route by which asking for extra objects can fall through into clearing geometry. */
  if (collect) {
    const result = await enqueueObjectCollectionJob({ courseId, actor: actorKey, origin: new URL(req.url).origin });
    if (result.missing) {
      return json(404, {
        error: "no course_maps row for " + courseId,
        detail: "Collecting extra objects enriches an existing map. This course has none yet - map it first."
      });
    }
    if (result.noHoles) {
      return json(409, {
        error: "no saved holes for " + courseId,
        detail: "Collecting extra objects uses the saved holes as its spatial framework and resolves none of its own. Map the course first."
      });
    }
    if (result.deduped) return json(200, { deduped: true, kind: OBJECT_COLLECTION_KIND, job: result.job });
    return json(202, { job: result.job, kind: OBJECT_COLLECTION_KIND, state: "queued" });
  }

  /* Refinement, returning from here for the same reason collection does: no route from asking
     for better shapes into clearing geometry. */
  if (refine) {
    const result = await enqueueShapeRefineJob({ courseId, actor: actorKey, origin: new URL(req.url).origin });
    if (result.missing) {
      return json(404, { error: "no course_maps row for " + courseId, detail: "Refining re-traces surfaces an existing map already has. Map the course first." });
    }
    if (result.noSurfaces) {
      return json(409, { error: "no surfaces to refine on " + courseId, detail: "Run Collect Extra Objects first - refinement re-traces the shapes that pass finds, it does not find its own." });
    }
    if (result.noFrames) {
      return json(409, { error: "no published frames for " + courseId, detail: "Refining traces against this course's own captures. Build its visuals first." });
    }
    if (result.deduped) return json(200, { deduped: true, kind: SHAPE_REFINE_KIND, job: result.job });
    return json(202, { job: result.job, kind: SHAPE_REFINE_KIND, state: "queued", surfaces: result.surfaces, frames: result.frames });
  }

  /* Remap: forget the geometry, keep the course.

     Deleting the course_maps row was the only way to force a fresh map, and it is too blunt -
     that row is also the course's entry in the picker's list AND the centre the pin gate and
     the Overpass query both read. Deleting it does not reset the map, it removes the course:
     the picker stops offering it, the pin gate fires, no package request is made and nothing
     is ever enqueued. (It also strands the worker, which reads the centre from this row -
     "has no known location in course_maps" in the job history is exactly that.)

     So clear what is actually stale - the geometry and its version - and leave the identity
     and the location alone. Emptying objects_json also clears the dedupe in enqueueMapperJob,
     which is what makes the enqueue below take rather than come back deduped. */
  if (remap) {
    const cleared = await supabaseFetch(MAPS_TABLE + "?course_id=eq." + encodeURIComponent(courseId), {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        objects_json: {}, holes_json: {}, geometry_version: null,
        hole_count: null, updated_at: new Date().toISOString()
      })
    });
    if (!Array.isArray(cleared) || !cleared.length) {
      /* No row to clear. Enqueuing anyway would hand the worker a course with no centre and
         earn a "no known location" failure, so say what is wrong instead. */
      return json(404, {
        error: "no course_maps row for " + courseId,
        detail: "Remap clears geometry from an existing course. A course with no row has to be added through the picker first, which creates its centre."
      });
    }
  }

  const result = await enqueueMapperJob({
    courseId,
    courseLat: payload && payload.courseLat,
    courseLng: payload && payload.courseLng,
    courseName: payload && payload.courseName,
    actorKey,
    origin: new URL(req.url).origin
  });
  if (result.duplicate) return json(200, { duplicate: true, courseId: result.courseId });
  if (result.unlocatable) {
    return json(422, {
      error: "no location for " + courseId,
      detail: "Mapping needs the course's coordinates. Send courseLat and courseLng, or pin the course first."
    });
  }
  if (result.signupRequired) {
    return json(403, {
      error: "Create a free account to prepare more courses.",
      code: "guest-signup-required",
      state: result.state
    });
  }
  if (result.rateLimited) {
    return json(429, {
      error: "The map server is busy right now. Please try again soon.",
      code: "server-busy",
      state: result.state
    });
  }
  if (result.deduped) return json(200, Object.assign({ deduped: true, remapped: remap }, result));
  return json(202, { job: result.job, state: "queued", remapped: remap });
}

/* AWAITED, not fire-and-forget - see course-visual-jobs.mjs's pingWorker for why: serverless
   freezes the process the moment the handler returns. */
async function pingWorkerAt(origin, jobId) {
  try {
    await fetch(origin + "/.netlify/functions/course-mapper-worker-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: jobId || null })
    }).catch(() => {});
  } catch (e) { /* queued job remains sweepable */ }
}

export const config = {
  path: "/api/course-mapper-jobs",
};

function json(status, body) {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept,Authorization"
    }
  });
}

export const __courseMapperJobsTest = { mapperBuildState, hasGeometryPayload, mapperActorKey, MAPPER_VERSION, AUTO_RATE_MAX_PER_USER, AUTO_RATE_MAX_PER_GUEST, GUEST_SUCCESS_LIMIT };
