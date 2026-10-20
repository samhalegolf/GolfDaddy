/* The mapping queue, as Studio's Mapping Queue page shows it.
 *
 * Read from course_mapper_jobs and course_map_notify_requests, admin only, through
 * GET /api/course-mapper-jobs?queue=1:
 *   - running: jobs the worker has claimed, oldest claim first, flagged stalled when the
 *     worker has not touched them for stallSeconds;
 *   - queued:  waiting jobs in the order the worker will claim them
 *              (course-mapper-worker-background.mjs claimNextJob): every player job first,
 *              oldest first, then the idle kinds in idleKinds order, each oldest first;
 *   - recent:  jobs that finished or failed in the last day, newest first;
 *   - waiting: courses people asked to be emailed about ("email me when it's ready"), with
 *              how many addresses are still waiting.
 *
 * buildMapperQueue is pure; loadMapperQueue does the reads. */

const RECENT_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 60;
const LIVE_LIMIT = 1000;
const WAITING_LIMIT = 1000;
const NAME_LOOKUP_LIMIT = 200;

/* Who asked, in words. Never the raw guest or user id. */
export function requesterLabel(requestedBy, adminUserIds = []) {
  const by = String(requestedBy || "");
  if (by.startsWith("guest:")) return "Player (guest)";
  if (by.startsWith("user:admin-")) return "Admin";
  if (by.startsWith("user:")) return (adminUserIds || []).map(String).includes(by.slice(5)) ? "You" : "Player";
  if (by.startsWith("nearby:")) return "Nearby sweep";
  if (by.startsWith("region:")) return "Regional scan";
  return by ? "System" : "Unknown";
}

function time(value) { const t = Date.parse(value); return Number.isFinite(t) ? t : 0; }
function oldestFirst(a, b) { return time(a.created_at) - time(b.created_at); }

function row(job, names, adminUserIds) {
  return {
    id: job.id,
    courseId: job.course_id,
    courseName: names[job.course_id] || "",
    kind: job.kind,
    status: job.status,
    requestedBy: requesterLabel(job.requested_by, adminUserIds),
    error: job.error || "",
    createdAt: job.created_at,
    updatedAt: job.updated_at
  };
}

export function buildMapperQueue({ jobs = [], recentJobs = [], waitingRows = [], names = {}, idleKinds = [], adminUserIds = [], now = Date.now(), stallSeconds = 120 } = {}) {
  const idle = idleKinds.map(String);
  const live = (jobs || []).filter(Boolean);

  const running = live.filter(job => job.status === "running")
    .sort((a, b) => time(a.updated_at) - time(b.updated_at))
    .map(job => {
      const quietSeconds = Math.max(0, Math.round((now - time(job.updated_at)) / 1000));
      return Object.assign(row(job, names, adminUserIds), { stalled: quietSeconds > stallSeconds, quietSeconds });
    });

  const queuedJobs = live.filter(job => job.status === "queued");
  const lanes = [{ lane: "player", jobs: queuedJobs.filter(job => !idle.includes(job.kind)) }]
    .concat(idle.map(kind => ({ lane: "background", jobs: queuedJobs.filter(job => job.kind === kind) })));
  const queued = [];
  lanes.forEach(({ lane, jobs: laneJobs }) => {
    laneJobs.slice().sort(oldestFirst).forEach(job => {
      queued.push(Object.assign(row(job, names, adminUserIds), { lane, position: queued.length + 1 }));
    });
  });

  const recent = (recentJobs || []).filter(job => job && (job.status === "done" || job.status === "failed") && now - time(job.updated_at) <= RECENT_MS)
    .sort((a, b) => time(b.updated_at) - time(a.updated_at))
    .slice(0, RECENT_LIMIT)
    .map(job => row(job, names, adminUserIds));

  const byCourse = new Map();
  (waitingRows || []).forEach(request => {
    if (!request || !request.course_id) return;
    const item = byCourse.get(request.course_id) || { courseId: request.course_id, courseName: "", addresses: 0, since: null };
    item.addresses += 1;
    item.courseName = item.courseName || request.course_name || names[request.course_id] || "";
    if (!item.since || time(request.created_at) < time(item.since)) item.since = request.created_at;
    byCourse.set(request.course_id, item);
  });
  const waiting = Array.from(byCourse.values()).sort((a, b) => time(a.since) - time(b.since));

  return {
    counts: {
      running: running.length,
      stalled: running.filter(job => job.stalled).length,
      queued: queued.length,
      playerQueued: queued.filter(job => job.lane === "player").length,
      failedToday: recent.filter(job => job.status === "failed").length,
      doneToday: recent.filter(job => job.status === "done").length,
      waitingCourses: waiting.length
    },
    running,
    queued,
    recent,
    waiting
  };
}

export async function loadMapperQueue(supabaseFetch, { idleKinds = [], adminUserIds = [], stallSeconds = 120, now = Date.now() } = {}) {
  const since = new Date(now - RECENT_MS).toISOString();
  const fields = "select=id,course_id,kind,status,error,requested_by,created_at,updated_at";
  const [jobs, recentJobs, waitingRows] = await Promise.all([
    supabaseFetch("course_mapper_jobs?" + fields + "&status=in.(queued,running)&order=created_at.asc&limit=" + LIVE_LIMIT),
    supabaseFetch("course_mapper_jobs?" + fields + "&status=in.(done,failed)&updated_at=gte." + encodeURIComponent(since) + "&order=updated_at.desc&limit=" + RECENT_LIMIT),
    supabaseFetch("course_map_notify_requests?select=course_id,course_name,created_at&notified_at=is.null&order=created_at.asc&limit=" + WAITING_LIMIT).catch(() => [])
  ]);
  const list = value => (Array.isArray(value) ? value : []);
  const ids = Array.from(new Set(list(jobs).concat(list(recentJobs), list(waitingRows)).map(r => r && r.course_id).filter(Boolean))).slice(0, NAME_LOOKUP_LIMIT);
  const names = {};
  if (ids.length) {
    const maps = await supabaseFetch("course_maps?select=course_id,course_name&course_id=in.(" + ids.map(id => '"' + String(id).replace(/"/g, "") + '"').map(encodeURIComponent).join(",") + ")").catch(() => []);
    list(maps).forEach(m => { if (m && m.course_id && m.course_name) names[m.course_id] = m.course_name; });
  }
  return buildMapperQueue({ jobs: list(jobs), recentJobs: list(recentJobs), waitingRows: list(waitingRows), names, idleKinds, adminUserIds, now, stallSeconds });
}
