/* The Mapping Overlay inbox: courses players asked the app to map, for an admin to fix by hand.
 *
 * Which jobs are player requests, and the per-course grouping, live in gd-player-requests.mjs
 * (the Course Mapping page shows that whole list). Each course asked for since INBOX_SINCE is
 * one inbox item:
 *   fix     - the latest run on the course failed: the player got no map.
 *   upgrade - it mapped, but a mapper-only map is the one worth checking and upgrading.
 *
 * An item leaves the inbox when the course's overlay is marked ready after the latest request
 * (the fix is done), or when it is dismissed (course_overlay_inbox_dismissals). A newer
 * request brings it back. */

import { groupPlayerRequests } from "./gd-player-requests.mjs";

export const INBOX_SINCE = "2026-10-08T00:00:00Z";
export const DISMISSALS_TABLE = "course_overlay_inbox_dismissals";
const JOB_LIMIT = 1000;

/* Pure: the inbox from the rows already read.
 *   requests   - automap jobs since INBOX_SINCE: {course_id, requested_by, status, error, created_at}
 *   latestRuns - the latest job of any kind per course: {course_id, status, error, updated_at}
 *   courses    - course_maps rows: {course_id, course_name, course_lat, course_lng}
 *   overlays   - {course_id, status, updated_at}
 *   dismissals - {course_id, dismissed_at}
 * Newest request first. */
export function buildInbox({ requests = [], latestRuns = [], courses = [], overlays = [], dismissals = [], adminUserIds = [] } = {}) {
  const items = groupPlayerRequests(requests, adminUserIds);
  const run = new Map(latestRuns.map(r => [r.course_id, r]));
  const course = new Map(courses.map(c => [c.course_id, c]));
  const overlay = new Map(overlays.map(o => [o.course_id, o]));
  const dismissed = new Map(dismissals.map(d => [d.course_id, d.dismissed_at]));
  const out = [];
  items.forEach(item => {
    const o = overlay.get(item.courseId);
    if (o && o.status === "ready" && Date.parse(o.updated_at) > Date.parse(item.requestedAt)) return;
    const gone = dismissed.get(item.courseId);
    if (gone && Date.parse(gone) > Date.parse(item.requestedAt)) return;
    const last = run.get(item.courseId) || null;
    const c = course.get(item.courseId) || {};
    const lat = Number(c.course_lat), lng = Number(c.course_lng);
    out.push({
      courseId: item.courseId,
      name: c.course_name || item.courseId,
      lat: Number.isFinite(lat) && c.course_lat != null ? lat : null,
      lng: Number.isFinite(lng) && c.course_lng != null ? lng : null,
      need: last && last.status === "done" ? "upgrade" : "fix",
      lastStatus: last ? last.status : null,
      lastError: last && last.error ? String(last.error).slice(0, 200) : null,
      requests: item.requests,
      players: item.players,
      requestedAt: item.requestedAt,
      firstRequestedAt: item.firstRequestedAt,
      overlay: o ? o.status : null
    });
  });
  return out;
}

function inList(ids) { return "(" + ids.map(id => '"' + String(id).replace(/"/g, "") + '"').join(",") + ")"; }

/* Reads what buildInbox needs. adminUserIds: the caller's own user id, so an admin's own test
   scans in the app do not fill the inbox. */
export async function loadInbox(supabaseFetch, { adminUserIds = [] } = {}) {
  const requests = await supabaseFetch("course_mapper_jobs?select=course_id,requested_by,status,error,created_at&kind=eq.automap&created_at=gte." + encodeURIComponent(INBOX_SINCE) + "&order=created_at.desc&limit=" + JOB_LIMIT);
  const ids = Array.from(new Set((Array.isArray(requests) ? requests : []).map(r => r.course_id).filter(Boolean)));
  if (!ids.length) return [];
  const list = inList(ids);
  const [runs, courses, overlays, dismissals] = await Promise.all([
    supabaseFetch("course_mapper_jobs?select=course_id,status,error,updated_at&course_id=in." + encodeURIComponent(list) + "&order=created_at.desc&limit=" + JOB_LIMIT),
    supabaseFetch("course_maps?select=course_id,course_name,course_lat,course_lng&course_id=in." + encodeURIComponent(list)),
    supabaseFetch("course_map_overlays?select=course_id,status,updated_at&course_id=in." + encodeURIComponent(list)),
    /* Dismissals only hide items: a failed read shows everything rather than nothing. */
    supabaseFetch(DISMISSALS_TABLE + "?select=course_id,dismissed_at&course_id=in." + encodeURIComponent(list)).catch(() => [])
  ]);
  /* Newest first, so the first row seen per course is its latest run. */
  const latest = new Map();
  (Array.isArray(runs) ? runs : []).forEach(r => { if (!latest.has(r.course_id)) latest.set(r.course_id, r); });
  return buildInbox({
    requests, latestRuns: Array.from(latest.values()),
    courses: Array.isArray(courses) ? courses : [],
    overlays: Array.isArray(overlays) ? overlays : [],
    dismissals: Array.isArray(dismissals) ? dismissals : [],
    adminUserIds
  });
}

export async function dismissInboxCourse(supabaseFetch, courseId, by) {
  await supabaseFetch(DISMISSALS_TABLE + "?on_conflict=course_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ course_id: courseId, dismissed_at: new Date().toISOString(), dismissed_by: by || null })
  });
  return { courseId, dismissed: true };
}
