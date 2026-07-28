/* Visual engine job queue API.
   POST {courseId, kind:"snapshot"|"export"} (admin only, verified against Supabase Auth like
   course-maps) -> inserts a course_visual_jobs row and pings the background worker.
   POST {courseId, kind:"auto"} (ANY signed-in player) -> enqueues a snapshot only. The worker
   auto-chains the natural export after it, so this is the whole automatic route: a player
   selects a course with no frames and the build starts. No recipe may be passed on this path.
   GET ?courseId=... -> recent jobs plus a derived build state for that course, readable by
   players so the app can poll cheaply while it plays over live tiles.
   The worker itself is functions/course-visual-worker-background.mjs. */

const TABLE = "course_visual_jobs";
const MAPS_TABLE = "course_maps";
const VISUALS_TABLE = "course_visuals";
const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);

/* A player tap is cheap for them and expensive for us (a course snapshot is ~6.6k tile fetches),
   so the auto path is rate limited on top of the one-live-job-per-course dedupe. */
const AUTO_RATE_WINDOW_MS = 30 * 60 * 1000;
const AUTO_RATE_MAX_PER_USER = 3;

/* How long a "running" job may go without a heartbeat before it is treated as a dead
   invocation. The worker beats after every capture and every hole - roughly every 10 seconds -
   so two minutes of silence is a corpse, not a slow job. Well under the reaper's own 6-minute
   cutoff on purpose: the reaper is the automatic safety net and can afford to be sure, while a
   nudge is a person looking at a stuck bar who already is. */
const STALL_SECONDS = 120;

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function anonKey() { return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || ""; }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }

/* Resolve the caller's Supabase session once. The auto path needs "is this a real signed-in
   person", the admin paths need "and is it one of us" - both read the same verified identity
   rather than trusting anything the client sent about itself. */
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

/* One word for "where is this course up to", derived from what actually EXISTS rather than
   from job bookkeeping wherever the two could disagree: published frames win over any job
   history, because a course with frames is playable no matter what the queue says.

     frames-ready    - published frames exist; the app downloads and plays them
     running/queued  - a build is in flight; the app plays live tiles and polls
     captures-ready  - snapshot landed but the export did not; retrying only needs an export
     failed          - the last thing we tried failed and nothing is in flight
     none            - never built; a player selecting this course may start one */
async function courseBuildState(courseId) {
  const [visualRows, jobRows, mapRows] = await Promise.all([
    supabaseFetch(VISUALS_TABLE + "?select=published_version,current_version,status,updated_at&course_id=eq." + encodeURIComponent(courseId) + "&limit=1").catch(() => []),
    supabaseFetch(TABLE + "?select=id,kind,status,error,result,created_at,updated_at&course_id=eq." + encodeURIComponent(courseId) + "&order=created_at.desc&limit=8").catch(() => []),
    /* The app tries several candidate keys for a course it has just selected (id, saved id,
       name, name minus "Golf Club"...). Without this it cannot tell "this key is not a course"
       from "this course has never been built", and both look like state "none". */
    supabaseFetch(MAPS_TABLE + "?select=course_id&course_id=eq." + encodeURIComponent(courseId) + "&published=eq.true&limit=1").catch(() => [])
  ]);
  const jobs = Array.isArray(jobRows) ? jobRows : [];
  const visual = Array.isArray(visualRows) ? visualRows[0] : null;
  const live = jobs.find(job => job.status === "running") || jobs.find(job => job.status === "queued");
  const framesReady = !!(visual && Number(visual.published_version) > 0);
  let state;
  if (framesReady) state = "frames-ready";
  else if (live) state = live.status === "running" ? "running" : "queued";
  else if (jobs.some(job => job.kind === "snapshot" && job.status === "done")) state = "captures-ready";
  else if (jobs.length && jobs[0].status === "failed") state = "failed";
  else state = "none";
  /* A worker heartbeats after every capture and every hole, so silence is the only honest
     signal that an invocation died - status stays "running" on a process that is gone. The
     reaper needs 6 minutes to be sure; the UI wants to say "this looks stuck" well before
     that, which is what stalledSeconds is for. */
  const stalledSeconds = live && live.updated_at
    ? Math.max(0, Math.round((Date.now() - new Date(live.updated_at).getTime()) / 1000))
    : null;
  return {
    state,
    hasGeometry: Array.isArray(mapRows) && mapRows.length > 0,
    /* Reported even while a rebuild runs: frames stay playable during a re-export. */
    framesReady,
    framesVersion: visual ? Number(visual.published_version) || null : null,
    building: !!live,
    activeKind: live ? live.kind : null,
    stalledSeconds,
    stalled: live && live.status === "running" && stalledSeconds != null && stalledSeconds > STALL_SECONDS,
    progress: live && live.result && live.result.progress || null,
    lastError: !live && jobs.length && jobs[0].status === "failed" ? String(jobs[0].error || "").slice(0, 300) : null,
    jobs
  };
}

export default async function courseVisualJobs(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url);
    const courseId = slug(url.searchParams.get("courseId") || url.searchParams.get("course_id"));
    if (!courseId) return json(400, { error: "courseId required" });
    return json(200, Object.assign({ courseId }, await courseBuildState(courseId)));
  }

  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  let payload;
  try { payload = await req.json(); } catch (e) { return json(400, { error: "Invalid JSON" }); }

  const requestedKind = String(payload && payload.kind || "snapshot");
  const auto = requestedKind === "auto";
  const nudge = requestedKind === "nudge";
  const user = await verifiedUser(req, payload);
  if (!user) return json(401, { error: "Sign in required" });
  /* "auto" is the only kind a non-admin may enqueue, and it can only ever produce a snapshot
     with no recipe - the natural export is chained by the worker. Explicit export (which
     carries a recipe) stays admin-only. */
  if (!auto && !user.isAdmin) return json(403, { error: "Admin verification failed" });
  const kind = auto ? "snapshot" : requestedKind === "export" ? "export" : "snapshot";

  const courseId = slug(payload && (payload.courseId || payload.course_id));
  if (!courseId) return json(400, { error: "courseId required" });

  /* Nudge: what an admin does when the progress bar has stopped moving. It queues nothing.
     A job whose invocation died is still marked "running", and nothing will touch it until the
     reaper's 6-minute cutoff and the next 10-minute sweeper tick - up to a quarter hour of a
     bar sitting still. This hands that job back to the queue and wakes a worker now.
     Deliberately refuses to touch a job that is still heartbeating: requeuing a live run would
     hand the same course to two workers. */
  if (nudge) {
    const state = await courseBuildState(courseId);
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
    await pingWorker(req);
    return json(200, Object.assign({ nudged: true, requeued }, await courseBuildState(courseId)));
  }

  if (auto) {
    /* Frames already exist - nothing to build. Cheap guard so a client polling loop that
       misreads its own cache can't queue a course rebuild every time it opens. */
    const state = await courseBuildState(courseId);
    if (state.framesReady || state.building) return json(200, { state: state.state, deduped: true, framesVersion: state.framesVersion });
    /* A course with no published geometry has nothing to shoot; fail fast rather than
       enqueueing a job whose only outcome is "capture plan is empty". */
    const maps = await supabaseFetch(MAPS_TABLE + "?select=course_id&course_id=eq." + encodeURIComponent(courseId) + "&published=eq.true&limit=1");
    if (!Array.isArray(maps) || !maps.length) return json(404, { error: "course has no published geometry", state: "none" });
    const since = new Date(Date.now() - AUTO_RATE_WINDOW_MS).toISOString();
    const recent = await supabaseFetch(TABLE + "?select=id&requested_by=eq." + encodeURIComponent("auto:" + user.id) + "&created_at=gt." + encodeURIComponent(since) + "&limit=" + (AUTO_RATE_MAX_PER_USER + 1));
    if (Array.isArray(recent) && recent.length >= AUTO_RATE_MAX_PER_USER) return json(429, { error: "too many course builds started recently", state: state.state });
  }

  /* One live job per course+kind - repeated Scan taps must not fan out duplicate workers.
     Only FRESH jobs count: a job untouched for 20+ minutes is a corpse from a dead worker
     (the worker reaps those), and letting it dedupe new requests silently swallowed a manual
     Publish. */
  const freshCutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const existing = await supabaseFetch(TABLE + "?select=id,status&course_id=eq." + encodeURIComponent(courseId) + "&kind=eq." + kind + "&status=in.(queued,running)&updated_at=gt." + encodeURIComponent(freshCutoff) + "&limit=1");
  if (Array.isArray(existing) && existing.length) {
    return json(200, { job: existing[0], deduped: true });
  }

  const inserted = await supabaseFetch(TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    /* Auto jobs carry no recipe by construction: the worker's natural/last-published baseline
       is the whole point of the automatic route, and letting a player-shaped request smuggle
       one in would make the app surface an authoring surface. */
    body: JSON.stringify([{ course_id: courseId, kind, status: "queued", recipe: auto ? null : (payload && payload.recipe || null), requested_by: auto ? "auto:" + user.id : user.email }])
  });
  const job = Array.isArray(inserted) ? inserted[0] : inserted;

  await pingWorker(req, job && job.id || null);

  return json(202, { job, state: "queued" });
}

/* Wake the background worker. If the ping is lost the job stays queued and the next enqueue or
   the 10-minute sweeper picks it up.
   AWAITED, not fire-and-forget: serverless freezes the process the moment the handler returns,
   so an un-awaited fetch never leaves the building. The worker acks 202 immediately, so this
   costs a few hundred ms. */
async function pingWorker(req, jobId) {
  try {
    const origin = new URL(req.url).origin;
    await fetch(origin + "/.netlify/functions/course-visual-worker-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: jobId || null })
    }).catch(() => {});
  } catch (e) { /* queued job remains sweepable */ }
}

export const config = {
  path: "/api/course-visual-jobs",
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
