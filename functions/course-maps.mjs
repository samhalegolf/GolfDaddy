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

function hasSupabase() {
  return !!(supabaseBase() && supabaseKey());
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

  const actor = payload && payload.actor || {};
  if (!isAdminActor(actor)) return json(403, { error: "Admin publish only" });

  const course = sanitizeCourse(payload && payload.course, actor);
  if (!course) return json(400, { error: "Course map is required" });

  const current = await readMaps();
  current.courses[course.id] = course;
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

  return json(200, Object.assign(current, { storage, warnings }));
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
  const blobMaps = await readBlobMaps();
  if (!hasSupabase()) return blobMaps;
  try {
    const cloudMaps = await readSupabaseMaps();
    return mergeMapSets(blobMaps, cloudMaps, { storage: "supabase" });
  } catch (error) {
    console.warn("course map supabase read failed", error && (error.body || error.message) || error);
    return Object.assign(blobMaps, { storage: "netlify-blobs", warnings: [{ storage: "supabase", message: storageMessage(error) }] });
  }
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
    TABLE + "?select=id,course_id,course_name,course_lat,course_lng,finder_lat,finder_lng,published,published_at,published_by_json,objects_json,holes_json,assets_json,course_json,created_at,updated_at&published=eq.true&order=updated_at.desc&limit=500",
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
    published: true,
    published_at: text(course && course.publishedAt, 80) || now,
    published_by_json: jsonObject(course && course.publishedBy),
    objects_json: jsonObject(course && course.objects),
    holes_json: jsonObject(course && course.holes),
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

function isAdminActor(actor) {
  const email = String(actor && actor.email || "").trim().toLowerCase();
  const role = String(actor && actor.role || "").trim().toLowerCase();
  return role === "admin" && ADMIN_EMAILS.has(email);
}

function sanitizeCourse(input, actor) {
  if (!input || typeof input !== "object") return null;
  const courseName = text(input.courseName || input.name, 160);
  if (!courseName) return null;
  const courseId = slug(input.courseId || input.id || courseName);
  const id = "published::" + courseId;
  const now = new Date().toISOString();
  const course = {
    id,
    userId: "published",
    courseId,
    courseName,
    courseLat: finite(input.courseLat),
    courseLng: finite(input.courseLng),
    finderLat: finite(input.finderLat || input.courseFinderLat),
    finderLng: finite(input.finderLng || input.courseFinderLng),
    courseFinderLat: finite(input.finderLat || input.courseFinderLat),
    courseFinderLng: finite(input.finderLng || input.courseFinderLng),
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

export const __courseMapsTest = {
  courseFromSupabaseRow,
  courseToSupabaseRow,
  mapsFromSupabaseRows,
  mergeMapSets,
  sanitizeCourse,
};
