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

import { MAPPER_VERSION } from "./lib/gd-automapper-core.mjs";
import { findDuplicateCourseWithGeometry } from "./lib/gd-duplicate-course-guard.mjs";

const TABLE = "course_mapper_jobs";
const MAPS_TABLE = "course_maps";
const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);

/* Mirrors course-visual-jobs.mjs's AUTO_RATE_* - a player tap is cheap for them, and an
   Overpass query plus green-shape analysis is not free for us or for the shared Overpass
   endpoint, so the open POST path is rate limited on top of the one-live-job-per-course
   dedupe. */
const AUTO_RATE_WINDOW_MS = 30 * 60 * 1000;
const AUTO_RATE_MAX_PER_USER = 5;
/* Anonymous installs get a tighter budget than signed-in players for the same window. A guest
   id is a string this device minted for itself, so it costs nothing to discard and mint
   another - the limit is a speed bump against a loop, not an identity check. The expensive
   thing it protects is the Overpass query behind each NEW map; reading an existing map,
   polling a running job and re-picking the same course all dedupe above this and spend
   nothing. */
const AUTO_RATE_MAX_PER_GUEST = 3;

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
function actorRateLimit(actorKey) {
  return String(actorKey || "").startsWith("guest:") ? AUTO_RATE_MAX_PER_GUEST : AUTO_RATE_MAX_PER_USER;
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

async function supabaseFetch(path, options = {}) {
  if (!hasSupabase()) throw new Error("Supabase is not configured");
  const headers = Object.assign({
    apikey: supabaseKey(),
    Authorization: "Bearer " + supabaseKey(),
    "Content-Type": "application/json"
  }, options.headers || {});
  const response = await fetch(supabaseBase() + "/rest/v1/" + path, Object.assign({}, options, { headers }));
  const textBody = await response.text();
  let body = null;
  try { body = textBody ? JSON.parse(textBody) : null; } catch (e) { body = textBody; }
  if (!response.ok) throw new Error("Supabase " + response.status + ": " + (typeof body === "string" ? body : JSON.stringify(body)));
  return body;
}

function slug(value) { return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90); }

function hasGeometryPayload(map) {
  if (!map) return false;
  const objects = map.objects_json && typeof map.objects_json === "object" ? map.objects_json : {};
  const holes = map.holes_json && typeof map.holes_json === "object" ? map.holes_json : {};
  return Object.keys(objects).length > 0 || Object.keys(holes).length > 0;
}

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

   It is excluded from the build state below on purpose. That state is what the PLAYER-facing
   package flow branches on: counting an admin enrichment sweep as "this course is building"
   would put every course on every phone into Processing while nothing about its map was
   changing. */
export const OBJECT_COLLECTION_KIND = "collect_extra_objects";
const isMappingJob = job => String(job && job.kind || "automap") !== OBJECT_COLLECTION_KIND;

async function mapperBuildStateAll() {
  const [jobRows, mapRows] = await Promise.all([
    supabaseFetch(TABLE + "?select=course_id,kind,status,error,mapper_version,created_at,updated_at&order=created_at.desc&limit=" + BULK_JOB_SCAN_LIMIT).catch(() => []),
    supabaseFetch(MAPS_TABLE + "?select=course_id,published,geometry_version,objects_json,holes_json&limit=2000").catch(() => [])
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

  const courses = {};
  const ids = new Set([...latestByCourse.keys()]);
  maps.forEach((row) => { if (row && row.course_id) ids.add(String(row.course_id)); });
  const mapById = new Map(maps.map((row) => [String(row && row.course_id || ""), row]));

  ids.forEach((id) => {
    const latest = latestByCourse.get(id) || null;
    const live = liveByCourse.get(id) || null;
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
      building: !!live
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
  const [jobRows, mapRows] = await Promise.all([
    supabaseFetch(TABLE + "?select=id,kind,status,error,result,mapper_version,created_at,updated_at&course_id=eq." + encodeURIComponent(courseId) + "&order=created_at.desc&limit=8").catch(() => []),
    supabaseFetch(MAPS_TABLE + "?select=course_id,published,geometry_version,objects_json,holes_json&course_id=eq." + encodeURIComponent(courseId) + "&published=eq.true&limit=1").catch(() => [])
  ]);
  const jobs = Array.isArray(jobRows) ? jobRows : [];
  const map = Array.isArray(mapRows) ? mapRows[0] : null;
  /* Mapping jobs only - see OBJECT_COLLECTION_KIND. `jobs` still carries every kind for the
     admin history, which is the one place the enrichment runs SHOULD be visible. */
  const mapping = jobs.filter(isMappingJob);
  const live = mapping.find(job => job.status === "running") || mapping.find(job => job.status === "queued");
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
  const located = await ensureCourseCenter(courseId, { courseLat, courseLng, courseName });

  const state = await mapperBuildState(courseId);
  if (state.hasGeometry && state.geometryVersion === MAPPER_VERSION) {
    return { deduped: true, state: state.state, geometryVersion: state.geometryVersion };
  }
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

  const rateMax = actorRateLimit(actor);
  const since = new Date(Date.now() - AUTO_RATE_WINDOW_MS).toISOString();
  const recent = await supabaseFetch(TABLE + "?select=id&requested_by=eq." + encodeURIComponent(actor) + "&created_at=gt." + encodeURIComponent(since) + "&limit=" + (rateMax + 1));
  if (Array.isArray(recent) && recent.length >= rateMax) return { rateLimited: true, state: state.state, actorKey: actor, limit: rateMax };

  /* Last gate, deliberately after the dedupe and rate-limit answers rather than before them.

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
  if ((nudge || remap || collect) && !(user && user.isAdmin)) return json(403, { error: "Admin verification failed" });

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
  if (result.rateLimited) return json(429, { error: "too many course mapping runs started recently", state: result.state, limit: result.limit || null });
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

export const __courseMapperJobsTest = { mapperBuildState, hasGeometryPayload, mapperActorKey, MAPPER_VERSION, AUTO_RATE_MAX_PER_USER, AUTO_RATE_MAX_PER_GUEST };
