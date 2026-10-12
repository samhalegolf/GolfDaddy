/* Courses players asked the app to map.
 *
 * A player opening a course with no map starts an automap job (course_mapper_jobs, kind
 * "automap", requested_by "user:<id>" or "guest:<id>"). This is the one reading of those rows:
 * who counts as a player, and one item per course with how often and how recently it was asked
 * for. The Mapping Overlay inbox (gd-overlay-inbox.mjs) narrows this to what still needs a hand;
 * the Course Mapping page in Studio shows the whole list.
 *
 * Not player requests: the admin's own account (adminUserIds - its test scans in the app),
 * admin runs (user:admin-...) and the nearby sweep (nearby:<course>). */

const JOB_LIMIT = 5000;

export function isPlayerRequest(requestedBy, adminUserIds) {
  const by = String(requestedBy || "");
  if (by.startsWith("guest:")) return true;
  if (!by.startsWith("user:") || by.startsWith("user:admin-")) return false;
  return !(adminUserIds instanceof Set ? adminUserIds : new Set((adminUserIds || []).map(String))).has(by.slice(5));
}

function later(a, b) { return !b || (a && Date.parse(a) > Date.parse(b)) ? a : b; }
function earlier(a, b) { return !b || (a && Date.parse(a) < Date.parse(b)) ? a : b; }

/* Pure: one item per course from automap job rows {course_id, requested_by, created_at},
   newest request first. */
export function groupPlayerRequests(requests = [], adminUserIds = []) {
  const admins = new Set((adminUserIds || []).map(String));
  const byCourse = new Map();
  (requests || []).forEach(job => {
    if (!job || !job.course_id || !isPlayerRequest(job.requested_by, admins)) return;
    const item = byCourse.get(job.course_id) || { courseId: job.course_id, requests: 0, players: new Set(), requestedAt: null, firstRequestedAt: null };
    item.requests += 1;
    item.players.add(String(job.requested_by));
    item.requestedAt = later(job.created_at, item.requestedAt);
    item.firstRequestedAt = earlier(job.created_at, item.firstRequestedAt);
    byCourse.set(job.course_id, item);
  });
  return Array.from(byCourse.values())
    .map(item => ({ courseId: item.courseId, requests: item.requests, players: item.players.size, requestedAt: item.requestedAt, firstRequestedAt: item.firstRequestedAt }))
    .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt));
}

/* Every automap request on record, grouped. adminUserIds: the caller's own user id. */
export async function loadPlayerRequests(supabaseFetch, { adminUserIds = [] } = {}) {
  const rows = await supabaseFetch("course_mapper_jobs?select=course_id,requested_by,created_at&kind=eq.automap&order=created_at.desc&limit=" + JOB_LIMIT);
  return groupPlayerRequests(Array.isArray(rows) ? rows : [], adminUserIds);
}
