import { getStore } from "@netlify/blobs";

const STORE_NAME = "clarity-course-maps";
const STORE_KEY = "published-course-maps-v1";
const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);

export default async function courseMaps(req) {
  if (req.method === "OPTIONS") return json(204, null);
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
  const blobStore = safeStore();
  if (!blobStore) return json(503, { error: "Course map storage unavailable" });
  await blobStore.setJSON(STORE_KEY, current);
  return json(200, current);
}

export const config = {
  path: "/api/course-maps",
};

function store() {
  return getStore(STORE_NAME);
}

function safeStore() {
  try {
    return store();
  } catch (error) {
    console.warn("course map store unavailable", error && error.message || error);
    return null;
  }
}

function emptyMaps() {
  return { version: 1, courses: {}, updatedAt: null };
}

async function readMaps() {
  const blobStore = safeStore();
  if (!blobStore) return emptyMaps();
  const saved = await blobStore.get(STORE_KEY, { type: "json" }).catch(() => null);
  if (saved && saved.courses) return saved;
  return emptyMaps();
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
    },
  });
}

function text(value, limit) {
  const out = String(value || "").trim();
  return out.length > limit ? out.slice(0, limit) : out;
}

function finite(value) {
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

function validHole(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 && n <= 36 ? Math.round(n) : null;
}

function slug(value) {
  return String(value || "course").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "course";
}
