/* Read-only proxy for the course-watch-maps Storage bucket, mirroring
   functions/course-visual-assets.mjs's proxy for course-visuals. Published Watch map imagery is
   public by design; the proxy's path allow-list is the real access boundary, same reasoning as
   the native-visuals proxy - nothing reads the bucket directly. */

const BUCKET = "course-watch-maps";
const PATH_RE = /^[a-z0-9][a-z0-9-]{0,90}\/v[0-9]+\/h[0-9]{1,2}\.(png|webp)$/;

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }

export default async function courseWatchMapAssets(req) {
  if (req.method === "OPTIONS") return new Response("", { status: 200, headers: cors({}) });
  if (req.method !== "GET") return json(405, { error: "Method not allowed" });
  if (!supabaseBase() || !supabaseKey()) return json(503, { error: "Supabase is not configured" });
  const url = new URL(req.url);
  const path = String(url.searchParams.get("path") || "");
  if (!PATH_RE.test(path) || path.includes("..")) return json(400, { error: "Invalid asset path" });
  const upstream = await fetch(supabaseBase() + "/storage/v1/object/" + BUCKET + "/" + path, {
    headers: { apikey: supabaseKey(), Authorization: "Bearer " + supabaseKey() }
  });
  if (!upstream.ok) {
    const missing = upstream.status === 404 || upstream.status === 400;
    return json(missing ? 404 : 502, { error: missing ? "Asset not found" : "Asset unavailable" });
  }
  const contentType = upstream.headers.get("content-type") || (path.endsWith(".webp") ? "image/webp" : "image/png");
  return new Response(upstream.body, {
    status: 200,
    headers: cors({
      "Content-Type": contentType,
      /* Versioned path (vN) - never changes in place, safe to cache forever. */
      "Cache-Control": "public, max-age=31536000, immutable"
    })
  });
}

export const config = {
  path: "/api/course-watch-map-assets",
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
