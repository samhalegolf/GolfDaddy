/* Watch Map package API - admin generation + public status read.

   GET  ?courseId=...            -> current package status/report (public, same shape either way)
   POST {courseId}               -> admin-only. Bakes a fresh Watch package for every hole this
                                     course has geometry for, from course_maps.objects_json, and
                                     replaces the course's course_watch_maps row.

   Deliberately synchronous, not a job queue like course-visual-jobs.mjs/course-mapper-jobs.mjs:
   those exist because their work fetches tens of thousands of external map tiles. This pipeline
   reads geometry already sitting in course_maps and draws flat SVG shapes from it - no network
   fetch per hole - so an 18-hole course bakes in low single-digit seconds, comfortably inside a
   normal (non-background) Netlify function's budget. If a future course-size outlier changes
   that, this is the seam to convert to the same queue+worker shape, not a reason to build one
   pre-emptively now.

   Never touches course_maps, course_visuals, course_visual_jobs, or course_mapper_jobs - the
   task this generates from is READ, everything it writes lands only in course_watch_maps and
   the course-watch-maps Storage bucket. */

import sharp from "sharp";
import watchMapCore from "../scripts/gd-watch-map-core.js";
import { objectsVersion } from "./lib/gd-course-package-shape.mjs";

const MAPS_TABLE = "course_maps";
const WATCH_TABLE = "course_watch_maps";
const BUCKET = "course-watch-maps";
const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function anonKey() { return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || ""; }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }

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

async function storageUpload(path, buffer, contentType) {
  const response = await fetch(supabaseBase() + "/storage/v1/object/" + BUCKET + "/" + path, {
    method: "POST",
    headers: { apikey: supabaseKey(), Authorization: "Bearer " + supabaseKey(), "Content-Type": contentType, "x-upsert": "true" },
    body: buffer
  });
  if (!response.ok) throw new Error("Storage upload " + response.status + " for " + path + ": " + (await response.text()).slice(0, 300));
  return path;
}

async function verifiedUser(req) {
  const header = String((req && req.headers && typeof req.headers.get === "function" && req.headers.get("authorization")) || "");
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
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

function slug(value) { return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90); }

function holeNumbersFromObjects(objectsJson) {
  const numbers = new Set();
  Object.values(objectsJson || {}).forEach(object => {
    const n = Number(object && object.holeNumber);
    if (Number.isFinite(n) && n > 0) numbers.add(n);
  });
  return Array.from(numbers).sort((a, b) => a - b);
}

/* Renders one hole's baked SVG to both PNG and WebP and keeps whichever is smaller - the task
   asks us to compare, not to assume. WebP wins on essentially every flat-vector hole (measured:
   ~4-6x smaller than PNG for this recipe's flat fills), but the comparison is real, not assumed. */
async function encodeSmallest(svg) {
  const buffer = Buffer.from(svg, "utf8");
  const [png, webp] = await Promise.all([
    sharp(buffer).png({ compressionLevel: 9, palette: true }).toBuffer(),
    sharp(buffer).webp({ quality: 82 }).toBuffer()
  ]);
  return webp.length <= png.length
    ? { format: "webp", contentType: "image/webp", bytes: webp }
    : { format: "png", contentType: "image/png", bytes: png };
}

async function generateWatchPackage({ courseId, map, actorEmail }) {
  const holeNumbers = holeNumbersFromObjects(map.objects_json);
  const version = Date.now();
  const holes = [];
  const errors = [];
  let totalBytes = 0;

  for (const holeNumber of holeNumbers) {
    const geometry = watchMapCore.objectsForHole(map.objects_json, holeNumber);
    const frame = watchMapCore.buildWatchHoleFrame(watchMapCore.WATCH_MAP_RECIPE_V1, geometry);
    if (!frame.ok) { errors.push({ holeNumber, reason: frame.reason }); continue; }
    try {
      const encoded = await encodeSmallest(frame.svg);
      const path = courseId + "/v" + version + "/h" + holeNumber + "." + encoded.format;
      await storageUpload(path, encoded.bytes, encoded.contentType);
      totalBytes += encoded.bytes.length;
      holes.push({
        holeNumber,
        path,
        width: frame.width,
        height: frame.height,
        format: encoded.format,
        bytes: encoded.bytes.length,
        spatialReference: frame.spatialReference,
        checkpoints: frame.checkpoints,
        validation: frame.validation,
        layers: frame.layers
      });
      if (!frame.validation.ok) errors.push({ holeNumber, reason: "spatial reference validation failed: " + frame.validation.issues.join("; ") });
    } catch (error) {
      errors.push({ holeNumber, reason: String(error && error.message || error) });
    }
  }

  const status = holes.length === 0 ? "failed" : errors.length === 0 && holes.length === holeNumbers.length ? "ready" : "partial";
  const row = {
    id: courseId,
    course_id: courseId,
    status,
    watch_package_version: version,
    recipe_id: watchMapCore.WATCH_MAP_RECIPE_V1.id,
    recipe_version: watchMapCore.WATCH_MAP_RECIPE_V1.version,
    source_objects_version: objectsVersion(map),
    hole_count: holeNumbers.length,
    ready_hole_count: holes.length,
    total_bytes: totalBytes,
    format: holes.length ? holes[0].format : null,
    holes,
    errors,
    generated_at: new Date().toISOString(),
    generated_by: actorEmail || null,
    updated_at: new Date().toISOString()
  };

  await supabaseFetch(WATCH_TABLE, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([row])
  });

  return row;
}

function reportShape(row) {
  if (!row) return { status: "none", holeCount: 0, readyHoleCount: 0, totalBytes: 0, holes: [], errors: [] };
  return {
    status: row.status,
    watchPackageVersion: row.watch_package_version,
    recipeId: row.recipe_id,
    recipeVersion: row.recipe_version,
    sourceObjectsVersion: row.source_objects_version,
    holeCount: row.hole_count,
    readyHoleCount: row.ready_hole_count,
    totalBytes: row.total_bytes,
    format: row.format,
    generatedAt: row.generated_at,
    generatedBy: row.generated_by,
    holes: row.holes || [],
    errors: row.errors || []
  };
}

async function loadWatchRow(courseId) {
  const rows = await supabaseFetch(WATCH_TABLE + "?select=*&course_id=eq." + encodeURIComponent(courseId) + "&limit=1").catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : null;
}

export default async function courseWatchMaps(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url);
    const courseId = slug(url.searchParams.get("courseId") || url.searchParams.get("course_id"));
    if (!courseId) return json(400, { error: "courseId required" });
    const row = await loadWatchRow(courseId);
    return json(200, Object.assign({ courseId }, reportShape(row)));
  }

  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  let payload;
  try { payload = await req.json(); } catch (e) { return json(400, { error: "Invalid JSON" }); }

  const user = await verifiedUser(req);
  if (!user) return json(401, { error: "Sign in required" });
  if (!user.isAdmin) return json(403, { error: "Admin verification failed" });

  const courseId = slug(payload && (payload.courseId || payload.course_id));
  if (!courseId) return json(400, { error: "courseId required" });

  const maps = await supabaseFetch(MAPS_TABLE + "?select=course_id,objects_json,holes_json,published_at,updated_at&course_id=eq." + encodeURIComponent(courseId) + "&published=eq.true&limit=1");
  const map = Array.isArray(maps) ? maps[0] : null;
  if (!map || !map.objects_json || !Object.keys(map.objects_json).length) {
    return json(404, { error: "course has no published geometry to generate Watch maps from" });
  }

  try {
    const row = await generateWatchPackage({ courseId, map, actorEmail: user.email });
    return json(200, Object.assign({ courseId }, reportShape(row)));
  } catch (error) {
    return json(502, { error: String(error && error.message || error) });
  }
}

export const config = {
  path: "/api/course-watch-maps",
};

export const __test = { holeNumbersFromObjects, reportShape };

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
