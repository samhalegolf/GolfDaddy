/* Read-only proxy for the course-visuals Storage bucket.
   GET /api/course-visual-assets?path=<courseId>/frames/v3/h1.jpg
   Published course imagery is public to players by design; the proxy only allows the
   captures/ and frames/ prefixes and streams objects with long cache headers (paths are
   versioned, so cached objects never go stale in place).
   The bucket itself is created public (supabase/migrations/20260715_create_course_visuals.sql)
   - this proxy's PATH_RE allow-list is the real access boundary either way, since nothing
   reads the bucket directly. */

const BUCKET = "course-visuals";
const PATH_RE = /^[a-z0-9][a-z0-9-]{0,90}\/(captures|frames)\/[a-zA-Z0-9._\/-]{1,300}$/;

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }

export default async function courseVisualAssets(req) {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 200, headers: cors({}) });
  }
  if (req.method !== "GET") return json(405, { error: "Method not allowed" });
  if (!supabaseBase() || !supabaseKey()) return json(503, { error: "Supabase is not configured" });
  const url = new URL(req.url);
  const path = String(url.searchParams.get("path") || "");
  if (!PATH_RE.test(path) || path.includes("..")) return json(400, { error: "Invalid asset path" });
  const upstream = await fetch(supabaseBase() + "/storage/v1/object/" + BUCKET + "/" + path, {
    headers: { apikey: supabaseKey(), Authorization: "Bearer " + supabaseKey() }
  });
  if (!upstream.ok) return json(upstream.status === 404 ? 404 : 502, { error: "Asset unavailable" });
  const contentType = upstream.headers.get("content-type") || (path.endsWith(".json") ? "application/json" : path.endsWith(".png") ? "image/png" : "image/jpeg");
  return new Response(upstream.body, {
    status: 200,
    headers: cors({
      "Content-Type": contentType,
      /* index.json moves as new bakes land; versioned image paths never change in place. */
      "Cache-Control": path.endsWith("index.json") ? "public, max-age=60" : "public, max-age=31536000, immutable"
    })
  });
}

export const config = {
  path: "/api/course-visual-assets",
};

function cors(headers) {
  return Object.assign({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept"
  }, headers);
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: cors({ "Content-Type": "application/json", "Cache-Control": "no-store" }) });
}
