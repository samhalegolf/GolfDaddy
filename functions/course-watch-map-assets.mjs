/* Read-only proxy for the course-watch-maps Storage bucket, mirroring
   functions/course-visual-assets.mjs's proxy for course-visuals. Published Watch map imagery is
   public by design; the proxy's path allow-list is the real access boundary, same reasoning as
   the native-visuals proxy - nothing reads the bucket directly. */

import sharp from "sharp";

const BUCKET = "course-watch-maps";
const PATH_RE = /^[a-z0-9][a-z0-9-]{0,90}\/v[0-9]+\/h[0-9]{1,2}\.(png|webp)$/;

/* `format=jpeg|png` re-encodes the stored image on the way out. Garmin needs
   it: Communications.makeImageRequest fetches through Garmin's image service,
   which answers 400 to a WebP body (verified 2026-09-21 against the Connect IQ
   simulator - the same URL as PNG came back 200). The stored packages are
   WebP because that is what watchOS receives as transcoded bytes from the
   phone; Garmin fetches by URL instead, so the conversion has to happen
   here. JPEG at this quality is roughly the WebP's size; PNG of a 200x1536
   hole is several times larger and only there for a caller that needs
   lossless. Apple never asks - it does not use the URL at all. */
const FORMATS = { jpeg: { contentType: "image/jpeg", encode: (image) => image.jpeg({ quality: 85 }) },
                  png: { contentType: "image/png", encode: (image) => image.png() } };

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
  /* Versioned path (vN) - never changes in place, safe to cache forever. The
     format rides in the URL, so each encoding is its own cache entry. */
  const cacheForever = "public, max-age=31536000, immutable";
  const wanted = String(url.searchParams.get("format") || "").toLowerCase();
  if (wanted) {
    const format = FORMATS[wanted];
    if (!format) return json(400, { error: "Unsupported format" });
    if (contentType !== format.contentType) {
      let encoded;
      try {
        encoded = await format.encode(sharp(Buffer.from(await upstream.arrayBuffer()))).toBuffer();
      } catch (error) {
        return json(502, { error: "Asset could not be re-encoded" });
      }
      return new Response(encoded, {
        status: 200,
        headers: cors({ "Content-Type": format.contentType, "Cache-Control": cacheForever })
      });
    }
  }
  return new Response(upstream.body, {
    status: 200,
    headers: cors({ "Content-Type": contentType, "Cache-Control": cacheForever })
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
