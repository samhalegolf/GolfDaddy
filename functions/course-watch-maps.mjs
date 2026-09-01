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

/* Storage is normally only a delivery layer: course_watch_maps is the canonical package
   record.  A historical integer overflow meant a fully-uploaded package could be left
   without that record, though.  This read-only inspection path makes that visible instead
   of incorrectly reporting "not generated".  It deliberately reconstructs only facts the
   object names/metadata prove; spatial references remain unavailable until regeneration. */
async function storageList(prefix) {
  const response = await fetch(supabaseBase() + "/storage/v1/object/list/" + BUCKET, {
    method: "POST",
    headers: { apikey: supabaseKey(), Authorization: "Bearer " + supabaseKey(), "Content-Type": "application/json" },
    body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: "name", order: "desc" } })
  });
  const body = await response.json().catch(() => []);
  if (!response.ok) throw new Error("Storage list " + response.status + ": " + JSON.stringify(body).slice(0, 300));
  return Array.isArray(body) ? body : [];
}

/* Exact object paths for every superseded package of this course.

   Pure, and separated from the fetching so the one thing that must never be
   wrong - that the live package is not in the delete list - is testable without
   a network or a bucket. The keep-version is excluded twice: once by folder
   name, and once again on the assembled path. */
function supersededPaths(courseId, keepVersion, listing) {
  const keep = "v" + keepVersion;
  const paths = [];
  (listing || []).forEach(entry => {
    const folder = String(entry && entry.folder || "");
    if (!/^v\d+$/.test(folder) || folder === keep) return;
    (entry.assets || []).forEach(name => {
      if (!/^h\d{1,2}\.(png|webp)$/.test(String(name))) return;
      paths.push(courseId + "/" + folder + "/" + name);
    });
  });
  return paths.filter(path => path.startsWith(courseId + "/v") && !path.includes("/" + keep + "/"));
}

async function storageRemove(paths) {
  if (!paths.length) return 0;
  const response = await fetch(supabaseBase() + "/storage/v1/object/" + BUCKET, {
    method: "DELETE",
    headers: { apikey: supabaseKey(), Authorization: "Bearer " + supabaseKey(), "Content-Type": "application/json" },
    body: JSON.stringify({ prefixes: paths })
  });
  if (!response.ok) throw new Error("Storage delete " + response.status + ": " + (await response.text()).slice(0, 300));
  return paths.length;
}

/* A regenerate uploads a new vN folder and, before this, left every previous one
   in the bucket for good - Millbrook accumulated five dead packages (~455KB)
   across one afternoon of retries.

   Deliberately runs only AFTER the row is persisted. Pruning first, or pruning
   on a failed save, is how a course ends up with no usable package at all: the
   old assets would be gone and the new ones unreferenced. */
async function pruneSupersededPackages(courseId, keepVersion) {
  const folders = (await storageList(courseId))
    .map(item => String(item && item.name || ""))
    .filter(name => /^v\d+$/.test(name) && name !== "v" + keepVersion);
  const listing = [];
  for (const folder of folders) {
    const assets = await storageList(courseId + "/" + folder);
    listing.push({ folder, assets: assets.map(asset => String(asset && asset.name || "")) });
  }
  return storageRemove(supersededPaths(courseId, keepVersion, listing));
}

async function findStoredPackage(courseId) {
  const versions = (await storageList(courseId)).map(item => String(item && item.name || ""))
    .filter(name => /^v\d+$/.test(name)).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  for (const folder of versions) {
    const assets = await storageList(courseId + "/" + folder);
    const holes = assets.map(asset => {
      const match = /^h(\d{1,2})\.(png|webp)$/.exec(String(asset && asset.name || ""));
      if (!match) return null;
      const bytes = Number(asset.metadata && asset.metadata.size || asset.size || 0);
      return { holeNumber: Number(match[1]), path: courseId + "/" + folder + "/" + match[0], format: match[2], bytes };
    }).filter(Boolean).sort((a, b) => a.holeNumber - b.holeNumber);
    if (holes.length) return { watchPackageVersion: Number(folder.slice(1)), holes };
  }
  return null;
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

  try {
    await supabaseFetch(WATCH_TABLE, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify([row])
    });
  } catch (error) {
    error.watchMapReport = reportShape(row);
    error.watchMapFailure = {
      stage: "package metadata persistence",
      generatedHoleCount: holes.length,
      uploadedHoleCount: holes.length,
      packageMetadataSaved: false,
      reason: String(error && error.message || error)
    };
    throw error;
  }

  /* Best-effort: the package is already live and correct at this point, so a
     bucket that refuses a delete leaves litter, never a broken course. */
  try {
    row.prunedAssets = await pruneSupersededPackages(courseId, version);
  } catch (error) {
    row.prunedAssets = 0;
    row.pruneError = String(error && error.message || error);
  }

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

function recoveryReport(courseId, stored) {
  const holes = stored.holes;
  return {
    courseId,
    status: "recovery",
    recovery: true,
    watchPackageVersion: stored.watchPackageVersion,
    recipeId: null,
    recipeVersion: null,
    holeCount: holes.length,
    readyHoleCount: holes.length,
    totalBytes: holes.reduce((total, hole) => total + (hole.bytes || 0), 0),
    holes,
    errors: [{ reason: "Package metadata missing. These uploaded assets can be inspected, but regeneration is required to restore the canonical spatial-reference package." }]
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
    const report = reportShape(row);
    if (row && Array.isArray(report.holes) && report.holes.length) return json(200, Object.assign({ courseId }, report));
    try {
      const stored = await findStoredPackage(courseId);
      if (stored) return json(200, recoveryReport(courseId, stored));
    } catch (error) {
      /* A storage-list outage must not hide a valid canonical row.  With no row, retain the
         normal empty state rather than claiming recovery from an unverified listing. */
    }
    return json(200, Object.assign({ courseId }, report));
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
    /* Not part of reportShape: pruning is an outcome of THIS run, not a
       property of the stored package, and the GET path must never claim it. */
    return json(200, Object.assign({ courseId }, reportShape(row), {
      prunedAssets: row.prunedAssets || 0,
      pruneError: row.pruneError || null
    }));
  } catch (error) {
    if (error.watchMapReport) return json(502, Object.assign({ courseId }, error.watchMapReport, {
      status: "failed",
      error: "Watch Map generation failed during " + error.watchMapFailure.stage,
      failure: error.watchMapFailure
    }));
    return json(502, { courseId, status: "failed", error: String(error && error.message || error), failure: { stage: "generation", reason: String(error && error.message || error) } });
  }
}

export const config = {
  path: "/api/course-watch-maps",
};

export const __test = { holeNumbersFromObjects, reportShape, recoveryReport, supersededPaths };

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
