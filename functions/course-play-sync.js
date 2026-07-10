"use strict";

// Clarity Caddie — course play map sync.
// Receives the course play pipeline's DB payload (built client-side by
// gd-course-play-pipeline.js buildCoursePlayDbPayload) and upserts it into
// the Supabase course_play_maps table. One row per account + course.
//
// Actions:
//   upsert_course : write/refresh the mapped course geometry
//   get_course    : read one saved course (exists check / future DB-first load)
//   list_courses  : list saved course summaries for an account

const {
  email,
  encodeFilter,
  hasSupabase,
  json,
  supabaseFetch,
  text
} = require("./payment-utils");

const MAX_PAYLOAD_BYTES = 900 * 1024;
const MAX_HOLES = 36;

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed", synced: false });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { error: "Invalid JSON", synced: false });
  }

  const action = text(payload.action || "upsert_course", 80);
  if (!hasSupabase()) {
    return json(503, { configured: false, synced: false, error: "Supabase is not configured. Course map was not saved." });
  }

  try {
    if (action === "upsert_course") return json(200, await upsertCourse(payload));
    if (action === "get_course") return json(200, await getCourse(payload));
    if (action === "list_courses") return json(200, await listCourses(payload));
    return json(400, { error: "Unsupported course play sync action", synced: false });
  } catch (error) {
    return json(error.status || 502, {
      configured: true,
      synced: false,
      error: "Could not save course map to Supabase",
      details: error.body || error.message || String(error)
    });
  }
};

function actorFrom(payload) {
  const actor = payload && payload.actor || {};
  return {
    accountId: text(actor.accountId || actor.account_id || payload.accountId, 120) || "anonymous",
    email: email(actor.email || payload.email) || null
  };
}

function courseFrom(payload) {
  // Accept either the sync envelope (envelope.payload) or the raw db payload.
  const envelope = payload && payload.envelope;
  const course = (envelope && envelope.payload) || payload && payload.course || payload && payload.payload;
  if (!course || typeof course !== "object") return null;
  if (!text(course.courseId || course.course_id, 160)) return null;
  return course;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function upsertCourse(payload) {
  const actor = actorFrom(payload);
  const course = courseFrom(payload);
  if (!course) throw badRequest("Course payload with courseId is required");

  const raw = JSON.stringify(course);
  if (raw.length > MAX_PAYLOAD_BYTES) throw badRequest("Course payload is too large");

  const holes = Array.isArray(course.holes) ? course.holes.slice(0, MAX_HOLES) : [];
  const holesReady = holes.filter(function (hole) {
    return hole && (hole.status === "play_data_ready" || hole.status === "mapped_geometry_ready");
  }).length;
  const now = new Date().toISOString();

  const row = {
    account_id: actor.accountId,
    account_email: actor.email,
    course_id: text(course.courseId || course.course_id, 160),
    course_key: text(course.courseKey || course.course_key, 160) || null,
    course_name: text(course.courseName || course.course_name, 200) || null,
    status: text(course.status, 80) || null,
    source: text(course.source, 120) || null,
    data_version: Math.max(1, Number(course.dataVersion || course.data_version || 1) || 1),
    holes_count: holes.length,
    holes_ready_count: holesReady,
    payload: course,
    client_updated_at: text(course.updatedAt || course.updated_at, 80) || now,
    updated_at: now
  };

  await supabaseFetch("course_play_maps?on_conflict=account_id,course_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(row)
  });

  return {
    configured: true,
    synced: true,
    savedAt: now,
    accountId: actor.accountId,
    courseId: row.course_id,
    dataVersion: row.data_version,
    holes: row.holes_count,
    holesReady: row.holes_ready_count
  };
}

async function getCourse(payload) {
  const actor = actorFrom(payload);
  const courseId = text(payload.courseId || payload.course_id, 160);
  if (!courseId) throw badRequest("courseId is required");

  const rows = await supabaseFetch(
    "course_play_maps?select=*&account_id=eq." + encodeFilter(actor.accountId) +
    "&course_id=eq." + encodeFilter(courseId) + "&limit=1",
    { method: "GET" }
  );
  const row = Array.isArray(rows) && rows[0] || null;
  return {
    configured: true,
    exists: !!row,
    courseId,
    accountId: actor.accountId,
    dataVersion: row ? row.data_version : null,
    holes: row ? row.holes_count : 0,
    holesReady: row ? row.holes_ready_count : 0,
    updatedAt: row ? row.updated_at : null,
    course: row ? row.payload : null
  };
}

async function listCourses(payload) {
  const actor = actorFrom(payload);
  const rows = await supabaseFetch(
    "course_play_maps?select=course_id,course_name,status,data_version,holes_count,holes_ready_count,updated_at" +
    "&account_id=eq." + encodeFilter(actor.accountId) + "&order=updated_at.desc&limit=100",
    { method: "GET" }
  );
  return { configured: true, accountId: actor.accountId, courses: Array.isArray(rows) ? rows : [] };
}
