/* Visual engine job queue API.
   POST {courseId, kind:"snapshot"} (admin only, verified against Supabase Auth like
   course-maps) -> inserts a course_visual_jobs row and pings the background worker.
   GET ?courseId=... -> recent jobs for that course so the admin UI can show status.
   The worker itself is functions/course-visual-worker-background.mjs. */

const TABLE = "course_visual_jobs";
const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function anonKey() { return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || ""; }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }

async function verifiedAdminEmail(req, payload) {
  const header = String((req && req.headers && typeof req.headers.get === "function" && req.headers.get("authorization")) || "");
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const token = bearer || String(payload && (payload.accessToken || payload.access_token) || "").trim();
  if (!token) return "";
  const base = supabaseBase();
  const key = anonKey() || supabaseKey();
  if (!base || !key) return "";
  try {
    const response = await fetch(base + "/auth/v1/user", { method: "GET", headers: { apikey: key, Authorization: "Bearer " + token } });
    if (!response.ok) return "";
    const user = await response.json();
    const verified = String(user && user.email || "").trim().toLowerCase();
    return user && user.id && ADMIN_EMAILS.has(verified) ? verified : "";
  } catch (error) {
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
  const textBody = await response.text();
  let body = null;
  try { body = textBody ? JSON.parse(textBody) : null; } catch (e) { body = textBody; }
  if (!response.ok) throw new Error("Supabase " + response.status + ": " + (typeof body === "string" ? body : JSON.stringify(body)));
  return body;
}

function slug(value) { return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90); }

export default async function courseVisualJobs(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url);
    const courseId = slug(url.searchParams.get("courseId") || url.searchParams.get("course_id"));
    if (!courseId) return json(400, { error: "courseId required" });
    const rows = await supabaseFetch(TABLE + "?select=id,course_id,kind,status,error,result,created_at,updated_at&course_id=eq." + encodeURIComponent(courseId) + "&order=created_at.desc&limit=8");
    return json(200, { jobs: Array.isArray(rows) ? rows : [] });
  }

  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  let payload;
  try { payload = await req.json(); } catch (e) { return json(400, { error: "Invalid JSON" }); }

  const adminEmail = await verifiedAdminEmail(req, payload);
  if (!adminEmail) return json(403, { error: "Admin verification failed" });

  const courseId = slug(payload && (payload.courseId || payload.course_id));
  if (!courseId) return json(400, { error: "courseId required" });
  const kind = String(payload && payload.kind || "snapshot") === "export" ? "export" : "snapshot";

  /* One live job per course+kind - repeated Scan taps must not fan out duplicate workers. */
  const existing = await supabaseFetch(TABLE + "?select=id,status&course_id=eq." + encodeURIComponent(courseId) + "&kind=eq." + kind + "&status=in.(queued,running)&limit=1");
  if (Array.isArray(existing) && existing.length) {
    return json(200, { job: existing[0], deduped: true });
  }

  const inserted = await supabaseFetch(TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([{ course_id: courseId, kind, status: "queued", recipe: payload && payload.recipe || null, requested_by: adminEmail }])
  });
  const job = Array.isArray(inserted) ? inserted[0] : inserted;

  /* Ping the background worker; fire-and-forget. If the ping is lost the job stays queued and
     the next enqueue or a manual worker invocation sweeps it up. */
  try {
    const origin = new URL(req.url).origin;
    fetch(origin + "/.netlify/functions/course-visual-worker-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: job && job.id || null })
    }).catch(() => {});
  } catch (e) { /* queued job remains sweepable */ }

  return json(202, { job });
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
