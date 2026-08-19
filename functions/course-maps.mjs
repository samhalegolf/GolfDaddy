import { placeFromCourse, reverseGeocodePlace } from "./lib/gd-course-place.mjs";

const STORE_NAME = "clarity-course-maps";
const STORE_KEY = "published-course-maps-v1";
const TABLE = "course_maps";
const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);
let getStoreImpl = null;
let getStoreLoadAttempted = false;

function env(name) {
  return process.env[name] || "";
}

function supabaseBase() {
  return env("SUPABASE_URL").replace(/\/+$/, "");
}

function supabaseKey() {
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

function anonKey() {
  return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || "";
}

function hasSupabase() {
  return !!(supabaseBase() && supabaseKey());
}

/* Admin identity has to be PROVEN, not asserted. The caller's Supabase access
   token is validated against /auth/v1/user, and the email that comes back is the
   only email we trust - a body-supplied `actor` can no longer grant admin, so an
   anonymous caller can no longer delete or reset a course map by claiming to be
   one. Returns the verified admin email, or "" for everyone else. */
async function verifiedAdminEmail(req, payload) {
  const header = String((req && req.headers && typeof req.headers.get === "function" && req.headers.get("authorization")) || "");
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const token = bearer || String(payload && (payload.accessToken || payload.access_token) || "").trim();
  if (!token) return "";
  const base = supabaseBase();
  const key = anonKey() || supabaseKey();
  if (!base || !key) return "";
  try {
    const response = await fetch(base + "/auth/v1/user", {
      method: "GET",
      headers: { apikey: key, Authorization: "Bearer " + token }
    });
    if (!response.ok) return "";
    const user = await response.json();
    const verified = String(user && user.email || "").trim().toLowerCase();
    return user && user.id && ADMIN_EMAILS.has(verified) ? verified : "";
  } catch (error) {
    console.warn("course map admin verification failed", error && error.message || error);
    return "";
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
  const bodyText = await response.text();
  let body = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch (_error) {
      body = bodyText;
    }
  }
  if (!response.ok) {
    const error = new Error("Supabase request failed");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export default async function courseMaps(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method === "GET") return json(200, await readMaps());
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  let payload;
  try {
    payload = await req.json();
  } catch (error) {
    return json(400, { error: "Invalid JSON" });
  }

  const claimedActor = payload && payload.actor || {};
  /* Verified against Supabase Auth - never taken from the request body. */
  const adminEmail = await verifiedAdminEmail(req, payload);
  const adminActor = !!adminEmail;
  const actor = adminActor ? Object.assign({}, claimedActor, { email: adminEmail, role: "admin" }) : claimedActor;
  const action = text(payload && payload.action, 40).toLowerCase() || "upsert";
  const generatedUpload = isGeneratedCourseUpload(payload);

  if (action === "delete" || action === "reset") {
    if (!adminActor) {
      return json(403, {
        error: "Admin delete requires a verified admin session",
        code: "admin_session_required"
      });
    }
    return deleteCourseMap(payload);
  }

  if (!adminActor && !generatedUpload) return json(403, { error: "Admin publish only" });

  const course = sanitizeCourse(payload && payload.course, adminActor ? actor : communityScanActor(actor));
  if (!course) return json(400, { error: "Course map is required" });
  await ensureCoursePlace(course);

  const current = await readMaps();
  const existingKey = findCourseMapKey(current, course);
  const existingCourse = existingKey ? current.courses[existingKey] : null;
  // Play, scan and publish behave the SAME for everyone - admin is not a
  // different code path here. Admin is only a privilege for out-of-band actions
  // (delete above), and for looking at the database afterward. The merge that
  // builds the published map is identical for all actors: non-destructive and
  // additive, so a partial scan never wipes holes it did not include. Course
  // dedupe across sessions is a backend job, not something this path decides.
  const mode = "create-or-append";
  const merge = mergeGeneratedCourse(existingCourse, course);
  if (!merge.course) return json(400, { error: "No new generated objects" });
  if (existingKey && existingKey !== merge.course.id) delete current.courses[existingKey];
  current.courses[merge.course.id] = merge.course;
  current.updatedAt = new Date().toISOString();

  const warnings = [];
  let storage = "netlify-blobs";
  if (hasSupabase()) {
    try {
      await writeSupabaseCourse(course);
      storage = "supabase";
    } catch (error) {
      warnings.push({ storage: "supabase", message: storageMessage(error) });
    }
  } else {
    warnings.push({ storage: "supabase", message: "Supabase is not configured" });
  }

  const mirrored = await writeBlobMaps(current);
  if (!mirrored.ok) {
    warnings.push({ storage: "netlify-blobs", message: mirrored.message });
    if (storage !== "supabase") return json(503, { error: "Course map storage unavailable", warnings });
  }

  /* Geometry changed -> the visual worker should re-snapshot this course. Fire-and-forget:
     publish must never fail because the visual queue hiccuped, and the jobs endpoint dedupes
     if a snapshot is already queued or running. */
  if (storage === "supabase" && merge.accepted && (merge.accepted.objects || merge.accepted.holes)) {
    try {
      /* courseId, NOT id. `course.id` is the STORE key, "published::helensville", which
         slugifies to "published-helensville" - a course that does not exist. Every publish
         since this hook was added enqueued a snapshot for that phantom id, the worker failed
         it with "not found in course_maps", and the real course was never scanned. The
         automatic route was dead on the publish path and said so in the job table for days. */
      await enqueueVisualSnapshot(merge.course, req);
    } catch (error) {
      warnings.push({ storage: "visual-queue", message: storageMessage(error) });
    }
  }

  return json(200, Object.assign(current, { storage, warnings, mode, accepted: merge.accepted }));
}

/* The id the visual worker looks a course up by - it reads course_maps.course_id, which is
   `course.courseId`. Deliberately NOT `course.id`: that is the store key, "published::x", and
   it slugifies to "published-x", a course that does not exist. Pulled out and exported so the
   distinction is testable rather than a comment nobody reads at the call site. */
function visualSnapshotCourseId(course) {
  const raw = course && typeof course === "object" ? course.courseId : course;
  return String(raw || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function enqueueVisualSnapshot(course, req) {
  const id = visualSnapshotCourseId(course);
  if (!id || !hasSupabase()) return;
  const existing = await supabaseFetch("course_visual_jobs?select=id&course_id=eq." + encodeURIComponent(id) + "&kind=eq.snapshot&status=in.(queued,running)&limit=1");
  if (Array.isArray(existing) && existing.length) return;
  await supabaseFetch("course_visual_jobs", {
    method: "POST",
    body: JSON.stringify([{ course_id: id, kind: "snapshot", status: "queued", requested_by: "course-maps-publish" }])
  });
  try {
    const origin = new URL(req.url).origin;
    await fetch(origin + "/.netlify/functions/course-visual-worker-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    }).catch(() => {});
  } catch (e) { /* queued job remains sweepable */ }
}

export const config = {
  path: "/api/course-maps",
};

async function store() {
  if (!getStoreLoadAttempted) {
    getStoreLoadAttempted = true;
    try {
      const mod = await import("@netlify/blobs");
      getStoreImpl = mod && mod.getStore;
    } catch (error) {
      console.warn("course map blob module unavailable", error && error.message || error);
    }
  }
  return getStoreImpl ? getStoreImpl(STORE_NAME) : null;
}

async function safeStore() {
  try {
    return await store();
  } catch (error) {
    console.warn("course map store unavailable", error && error.message || error);
    return null;
  }
}

function emptyMaps() {
  return { version: 1, courses: {}, updatedAt: null, storage: "empty" };
}

async function readMaps() {
  if (!hasSupabase()) return readBlobMaps();
  const blobMapsPromise = readBlobMaps().catch((error) => {
    console.warn("course map mirror read failed", error && error.message || error);
    return null;
  });
  try {
    const cloudMaps = await readSupabaseMaps();
    const blobMaps = await blobMapsPromise;
    return withMirrorSummary(cloudMaps, blobMaps);
  } catch (error) {
    console.warn("course map supabase read failed", error && (error.body || error.message) || error);
    const warnings = [{ storage: "supabase", message: storageMessage(error) }];
    const blobMaps = await blobMapsPromise;
    if (env("COURSE_MAPS_ALLOW_BLOB_FALLBACK") === "true") {
      return Object.assign(blobMaps || emptyMaps(), {
        storage: "netlify-blobs",
        authoritativeStorage: "supabase",
        warnings
      });
    }
    return Object.assign(emptyMaps(), {
      storage: "supabase",
      unavailable: true,
      mirrorStorage: blobMaps ? "netlify-blobs" : null,
      mirrorCourseCount: blobMaps ? Object.keys(blobMaps.courses || {}).length : 0,
      warnings
    });
  }
}

async function deleteCourseMap(payload) {
  const courseId = deleteCourseId(payload);
  if (!courseId) return json(400, { error: "courseId is required" });

  let current;
  try {
    current = hasSupabase() ? await readSupabaseMaps() : await readBlobMaps();
  } catch (error) {
    return json(error.status || 503, { error: storageMessage(error), courseId, storage: "supabase" });
  }

  const existingKey = findCourseMapKey(current, {
    id: "published::" + courseId,
    courseId,
    courseName: payload && (payload.courseName || payload.name) || payload && payload.course && (payload.course.courseName || payload.course.name)
  });
  let deletedMirror = 0;
  if (existingKey) {
    delete current.courses[existingKey];
    current.updatedAt = new Date().toISOString();
    deletedMirror = 1;
  }

  const warnings = [];
  let deletedSupabase = 0;
  let storage = "netlify-blobs";
  if (hasSupabase()) {
    try {
      deletedSupabase = await deleteSupabaseCourse(courseId);
      storage = "supabase";
    } catch (error) {
      return json(error.status || 503, { error: storageMessage(error), courseId, storage: "supabase" });
    }
  } else {
    warnings.push({ storage: "supabase", message: "Supabase is not configured" });
  }

  const mirrored = await writeBlobMaps(current);
  if (!mirrored.ok) {
    warnings.push({ storage: "netlify-blobs", message: mirrored.message });
    if (storage !== "supabase") return json(503, { error: "Course map storage unavailable", courseId, warnings });
  }

  return json(200, Object.assign(current, {
    ok: true,
    action: "delete",
    courseId,
    deleted: { supabase: deletedSupabase, mirror: deletedMirror },
    storage,
    warnings
  }));
}

function withMirrorSummary(cloudMaps, blobMaps) {
  const out = Object.assign(emptyMaps(), cloudMaps || {}, { storage: "supabase" });
  out.mirrorStorage = blobMaps ? "netlify-blobs" : null;
  out.mirrorCourseCount = blobMaps ? Object.keys(blobMaps.courses || {}).length : 0;
  return out;
}

async function readBlobMaps() {
  const blobStore = await safeStore();
  if (!blobStore) return emptyMaps();
  const saved = await blobStore.get(STORE_KEY, { type: "json" }).catch(() => null);
  if (saved && saved.courses) return Object.assign(emptyMaps(), saved, { storage: "netlify-blobs" });
  return emptyMaps();
}

async function writeBlobMaps(maps) {
  const blobStore = await safeStore();
  if (!blobStore) return { ok: false, message: "Netlify Blob store unavailable" };
  try {
    await blobStore.setJSON(STORE_KEY, maps);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: storageMessage(error) };
  }
}

async function readSupabaseMaps() {
  const rows = await supabaseFetch(
    TABLE + "?select=id,course_id,course_name,course_lat,course_lng,finder_lat,finder_lng,region,country,country_code,published,published_at,published_by_json,objects_json,holes_json,assets_json,course_json,created_at,updated_at&published=eq.true&order=updated_at.desc&limit=500",
    { method: "GET" }
  );
  return mapsFromSupabaseRows(rows);
}

async function writeSupabaseCourse(course) {
  await supabaseFetch(TABLE + "?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(courseToSupabaseRow(course))
  });
}

async function deleteSupabaseCourse(courseId) {
  const byCourseId = await supabaseFetch(TABLE + "?course_id=eq." + encodeURIComponent(courseId), {
    method: "DELETE",
    headers: { Prefer: "return=representation" }
  });
  const byId = await supabaseFetch(TABLE + "?id=eq." + encodeURIComponent("published::" + courseId), {
    method: "DELETE",
    headers: { Prefer: "return=representation" }
  });
  return (Array.isArray(byCourseId) ? byCourseId.length : 0) + (Array.isArray(byId) ? byId.length : 0);
}

function mapsFromSupabaseRows(rows) {
  const maps = emptyMaps();
  maps.storage = "supabase";
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const course = courseFromSupabaseRow(row);
    if (course && course.id) maps.courses[course.id] = course;
    if (row && row.updated_at && (!maps.updatedAt || String(row.updated_at) > String(maps.updatedAt))) maps.updatedAt = row.updated_at;
  });
  return maps;
}

function courseToSupabaseRow(course) {
  const now = new Date().toISOString();
  return {
    id: text(course && course.id, 180),
    course_id: text(course && course.courseId, 160),
    course_name: text(course && course.courseName, 200),
    course_lat: finite(course && course.courseLat),
    course_lng: finite(course && course.courseLng),
    finder_lat: finite(course && (course.finderLat ?? course.courseFinderLat)),
    finder_lng: finite(course && (course.finderLng ?? course.courseFinderLng)),
    /* Columns rather than course_json only, so the picker's course list can
       read the subtitle without unpacking a payload per course, and so the
       backfill can find the rows it still has to visit. Null when unknown -
       an empty string would read as "resolved to nothing" and be skipped. */
    region: text(course && course.region, 120) || null,
    country: text(course && course.country, 80) || null,
    country_code: text(course && course.countryCode, 8).toUpperCase() || null,
    published: true,
    published_at: text(course && course.publishedAt, 80) || now,
    published_by_json: jsonObject(course && course.publishedBy),
    objects_json: jsonObject(course && course.objects),
    holes_json: jsonObject(course && course.holes),
    /* Denormalised so /api/course-library can report hole counts without
       reading holes_json, which runs to tens of kilobytes per course. */
    hole_count: Object.keys(jsonObject(course && course.holes)).length || null,
    assets_json: jsonObject(course && course.assets),
    course_json: jsonObject(course),
    updated_at: text(course && course.updatedAt, 80) || now
  };
}

function courseFromSupabaseRow(row) {
  if (!row || typeof row !== "object") return null;
  const base = jsonObject(row.course_json);
  const course = Object.assign({}, base, {
    id: text(row.id || base.id, 180),
    userId: "published",
    courseId: text(row.course_id || base.courseId, 160),
    courseName: text(row.course_name || base.courseName || base.name, 200),
    courseLat: finite(row.course_lat ?? base.courseLat),
    courseLng: finite(row.course_lng ?? base.courseLng),
    finderLat: finite(row.finder_lat ?? base.finderLat ?? base.courseFinderLat),
    finderLng: finite(row.finder_lng ?? base.finderLng ?? base.courseFinderLng),
    courseFinderLat: finite(row.finder_lat ?? base.courseFinderLat ?? base.finderLat),
    courseFinderLng: finite(row.finder_lng ?? base.courseFinderLng ?? base.finderLng),
    region: text(row.region ?? base.region, 120),
    country: text(row.country ?? base.country, 80),
    countryCode: text(row.country_code ?? base.countryCode, 8).toUpperCase(),
    published: true,
    publishedAt: text(row.published_at || base.publishedAt, 80),
    publishedBy: jsonObject(row.published_by_json || base.publishedBy),
    objects: jsonObject(row.objects_json || base.objects),
    holes: jsonObject(row.holes_json || base.holes),
    assets: jsonObject(row.assets_json || base.assets),
    createdAt: text(row.created_at || base.createdAt, 80),
    updatedAt: text(row.updated_at || base.updatedAt, 80)
  });
  return course.id && course.courseId && course.courseName ? course : null;
}

function mergeMapSets(...sets) {
  const opts = sets.length && sets[sets.length - 1] && !sets[sets.length - 1].courses ? sets.pop() : {};
  const out = emptyMaps();
  out.storage = opts.storage || "merged";
  sets.forEach((set) => {
    Object.values(set && set.courses || {}).forEach((course) => {
      if (course && course.id) out.courses[course.id] = course;
    });
    if (set && set.updatedAt && (!out.updatedAt || String(set.updatedAt) > String(out.updatedAt))) out.updatedAt = set.updatedAt;
  });
  return out;
}

/* Removed: isAdminActor() trusted actor.email/actor.role straight from the
   request body, so anyone could claim admin and delete any course map. Admin is
   now established by verifiedAdminEmail() against Supabase Auth. */

function isGeneratedCourseUpload(payload) {
  if (!payload || payload.generated !== true) return false;
  const mode = text(payload.mode, 80).toLowerCase();
  const source = text(payload.source, 120).toLowerCase();
  if (mode === "generated-create-or-append") return true;
  return /automapper|native-resolver|course-picker-pin|generated-map/.test(source);
}

function communityScanActor(actor) {
  return {
    name: "Community scan",
    email: "",
    accountId: text(actor && actor.accountId, 120),
    role: "player"
  };
}

function deleteCourseId(payload) {
  const course = payload && payload.course || {};
  const raw = text(
    payload && (payload.courseId || payload.course_id || payload.id || payload.courseName || payload.name) ||
    course && (course.courseId || course.course_id || course.id || course.courseName || course.name),
    220
  );
  return slug(raw.replace(/^published::/i, ""));
}

function findCourseMapKey(maps, course) {
  const courses = maps && maps.courses || {};
  if (course && course.id && courses[course.id]) return course.id;
  const cid = slug(course && course.courseId);
  const name = cleanName(course && (course.courseName || course.name));
  return Object.keys(courses).find((key) => {
    const existing = courses[key] || {};
    return !!(
      cid && slug(existing.courseId || existing.id) === cid ||
      name && cleanName(existing.courseName || existing.name) === name
    );
  }) || "";
}

function mergeGeneratedCourse(existing, incoming) {
  const now = new Date().toISOString();
  const accepted = { objects: 0, holes: 0, course: existing ? 0 : 1 };
  if (!existing) {
    if (!generatedCourseHasGeometry(incoming)) return { course: null, accepted };
    const created = Object.assign({}, incoming, {
      communityGenerated: true,
      updatedAt: now,
      createdAt: incoming.createdAt || now
    });
    accepted.objects = Object.keys(created.objects || {}).length;
    accepted.holes = Object.keys(created.holes || {}).length;
    return { course: created, accepted };
  }

  const course = Object.assign({}, existing, {
    objects: Object.assign({}, existing.objects || {}),
    holes: Object.assign({}, existing.holes || {}),
    assets: Object.assign({}, existing.assets || {}),
    communityGenerated: existing.communityGenerated === true || incoming.communityGenerated === true,
  });

  Object.values(incoming.objects || {}).forEach((object) => {
    if (!object || generatedObjectExists(course, object)) return;
    course.objects[object.id] = object;
    accepted.objects += 1;
  });
  Object.values(incoming.holes || {}).forEach((hole) => {
    if (!hole || generatedHoleExists(course, hole)) return;
    course.holes[hole.holeNumber] = hole;
    accepted.holes += 1;
  });

  ["courseLat", "courseLng", "finderLat", "finderLng", "courseFinderLat", "courseFinderLng"].forEach((key) => {
    if ((course[key] === null || course[key] === undefined || course[key] === "") && incoming[key] !== null && incoming[key] !== undefined && incoming[key] !== "") course[key] = incoming[key];
  });
  if (accepted.objects || accepted.holes) course.updatedAt = now;
  return { course, accepted };
}

function generatedCourseHasGeometry(course) {
  return Object.keys(course && course.objects || {}).length > 0 || Object.keys(course && course.holes || {}).length > 0;
}

function generatedObjectExists(course, object) {
  if (!object || !object.id) return true;
  const objects = Object.values(course && course.objects || {});
  if ((course.objects || {})[object.id]) return true;
  const position = point(object.position || object.greenCenter);
  if (!position) return true;
  const holeNumber = validHole(object.holeNumber);
  const type = text(object.type, 40).toLowerCase();
  const threshold = type === "green" ? 10 : 8;
  return objects.some((existing) => {
    if (!existing) return false;
    if (text(existing.type, 40).toLowerCase() !== type) return false;
    if (validHole(existing.holeNumber) !== holeNumber) return false;
    const existingPoint = point(existing.position || existing.greenCenter);
    return !!(existingPoint && distanceM(existingPoint, position) <= threshold);
  });
}

function generatedHoleExists(course, hole) {
  const holeNumber = validHole(hole && hole.holeNumber);
  if (!holeNumber) return true;
  if ((course.holes || {})[holeNumber]) return true;
  const center = point(hole.greenCenter || hole.position);
  if (!center) return true;
  return Object.values(course.holes || {}).some((existing) => {
    if (validHole(existing && existing.holeNumber) !== holeNumber) return false;
    const existingCenter = point(existing.greenCenter || existing.position);
    return !!(existingCenter && distanceM(existingCenter, center) <= 10);
  });
}

function sanitizeCourse(input, actor) {
  if (!input || typeof input !== "object") return null;
  const courseName = text(input.courseName || input.name, 160);
  if (!courseName) return null;
  const courseId = slug(input.courseId || input.id || courseName);
  const id = "published::" + courseId;
  const now = new Date().toISOString();
  const locationPoint = point(input.courseLocation && (input.courseLocation.centre || input.courseLocation.center || input.courseLocation) || input.courseCentre || input.courseCenter);
  const locationConfirmed = input.courseLocationConfirmed === true || !!(input.courseLocation && input.courseLocation.confirmed === true);
  const place = placeFromCourse(input);
  const course = {
    id,
    userId: "published",
    courseId,
    courseName,
    courseLat: finite(input.courseLat ?? (locationPoint && locationPoint.lat)),
    courseLng: finite(input.courseLng ?? (locationPoint && locationPoint.lng)),
    finderLat: finite(input.finderLat || input.courseFinderLat || (locationPoint && locationPoint.lat)),
    finderLng: finite(input.finderLng || input.courseFinderLng || (locationPoint && locationPoint.lng)),
    courseFinderLat: finite(input.finderLat || input.courseFinderLat || (locationPoint && locationPoint.lat)),
    courseFinderLng: finite(input.finderLng || input.courseFinderLng || (locationPoint && locationPoint.lng)),
    courseLocation: locationPoint ? {
      centre: locationPoint,
      source: text(input.courseLocation && input.courseLocation.source || input.courseLocationSource, 120),
      confidence: finite(input.courseLocation && input.courseLocation.confidence || input.courseLocationConfidence),
      confirmed: locationConfirmed,
      updatedAt: text(input.courseLocation && input.courseLocation.updatedAt || input.courseLocationUpdatedAt, 80) || now
    } : undefined,
    courseLocationSource: text(input.courseLocationSource || input.courseLocation && input.courseLocation.source, 120),
    courseLocationConfirmed: locationConfirmed,
    /* Region and country as words. Taken from the client when it already knows
       (a course picked out of search carries what the geocoder said), and
       filled in from the coordinates otherwise - see ensureCoursePlace. */
    region: text(place && place.region, 120),
    country: text(place && place.country, 80),
    countryCode: text(place && place.countryCode, 8).toUpperCase(),
    courseLocationUpdatedAt: text(input.courseLocationUpdatedAt || input.courseLocation && input.courseLocation.updatedAt, 80),
    createdAt: text(input.createdAt, 80) || now,
    updatedAt: now,
    published: true,
    publishedAt: now,
    publishedBy: {
      name: text(actor && actor.name, 120) || "Admin",
      email: text(actor && actor.email, 160).toLowerCase(),
      accountId: text(actor && actor.accountId, 120),
    },
    holes: {},
    objects: {},
  };

  Object.values(input.objects || {}).forEach((raw) => {
    const object = sanitizeObject(raw, courseId);
    if (object) course.objects[object.id] = object;
  });
  Object.values(input.holes || {}).forEach((raw) => {
    const hole = sanitizeHole(raw, courseId);
    if (hole && hole.holeNumber) course.holes[hole.holeNumber] = hole;
  });
  return course;
}

/* Fill in a course's region and country from its coordinates when the client
   did not send them.
 *
 * Doing this on the server rather than trusting the client is what makes the
 * subtitle actually appear on every saved course. A course reaches this
 * endpoint by several routes - admin publish, community scan sync, a replayed
 * draft - and only the search-result route ever had the geocoder's answer to
 * pass on. Resolving once here covers all of them.
 *
 * Publishing is rare and this is one request, so the cost is not a concern.
 * It must never block a publish though: reverseGeocodePlace resolves to null on
 * any failure and the course saves with no place, which the backfill picks up
 * later. Mutates in place because the caller already owns the object. */
async function ensureCoursePlace(course) {
  if (!course || course.countryCode || course.country) return course;
  const place = await reverseGeocodePlace(
    course.courseLat ?? course.finderLat,
    course.courseLng ?? course.finderLng
  );
  if (!place) return course;
  course.region = text(place.region, 120);
  course.country = text(place.country, 80);
  course.countryCode = text(place.countryCode, 8).toUpperCase();
  return course;
}

function sanitizeObject(raw, courseId) {
  if (!raw || typeof raw !== "object") return null;
  const type = text(raw.type, 40);
  const id = text(raw.id, 140);
  const position = point(raw.position || raw.greenCenter);
  if (!type || !id || !position) return null;
  const shape = shapePoints(raw.shape || raw.greenShape);
  const holeNumber = validHole(raw.holeNumber);
  return {
    id,
    userId: "published",
    courseId,
    type,
    position,
    shape,
    holeNumber,
    confirmed: !!raw.confirmed,
    lifecycle: text(raw.lifecycle, 80),
    targetEligible: !!raw.targetEligible,
    source: text(raw.source || raw.greenSource, 120),
    greenCenter: type === "green" ? position : undefined,
    greenShape: type === "green" ? shape : undefined,
    greenSource: type === "green" ? text(raw.greenSource || raw.source, 120) : undefined,
    createdAt: text(raw.createdAt, 80),
    updatedAt: text(raw.updatedAt, 80),
    published: true,
  };
}

function sanitizeHole(raw, courseId) {
  if (!raw || typeof raw !== "object") return null;
  const center = point(raw.greenCenter || raw.position);
  const holeNumber = validHole(raw.holeNumber);
  if (!center || !holeNumber) return null;
  return {
    id: text(raw.id, 140),
    userId: "published",
    courseId,
    holeNumber,
    greenCenter: center,
    greenShape: shapePoints(raw.greenShape || raw.shape),
    greenSource: text(raw.greenSource || raw.source, 120),
    confirmed: true,
    createdAt: text(raw.createdAt, 80),
    updatedAt: text(raw.updatedAt, 80),
    published: true,
  };
}

function json(status, body) {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept",
    },
  });
}

function text(value, limit) {
  const out = String(value || "").trim();
  return out.length > limit ? out.slice(0, limit) : out;
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function point(value) {
  const lat = finite(value && value.lat);
  const lng = finite(value && value.lng);
  return lat == null || lng == null ? null : { lat, lng };
}

function shapePoints(value) {
  if (!Array.isArray(value)) return null;
  const points = value.map(point).filter(Boolean);
  return points.length >= 3 ? points : null;
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function storageMessage(error) {
  if (!error) return "Unknown storage error";
  if (error.body) return typeof error.body === "string" ? error.body : JSON.stringify(error.body).slice(0, 300);
  return String(error.message || error);
}

function validHole(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 && n <= 36 ? Math.round(n) : null;
}

function slug(value) {
  return String(value || "course").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "course";
}

function cleanName(value) {
  return String(value || "").toLowerCase()
    .replace(/\b(golf club|golf course|country club|links|club|course|gc|cub)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function distanceM(a, b) {
  const lat1 = finite(a && a.lat);
  const lng1 = finite(a && a.lng);
  const lat2 = finite(b && b.lat);
  const lng2 = finite(b && b.lng);
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return Infinity;
  const rad = (value) => value * Math.PI / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

export const __courseMapsTest = {
  courseFromSupabaseRow,
  courseToSupabaseRow,
  deleteCourseId,
  findCourseMapKey,
  isGeneratedCourseUpload,
  mergeGeneratedCourse,
  mapsFromSupabaseRows,
  mergeMapSets,
  sanitizeCourse,
  visualSnapshotCourseId,
  withMirrorSummary,
};
