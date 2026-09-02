/* Watch Map package API - admin generation + public status read.

   GET  ?courseId=...            -> current package status/report (public, same shape either way)
   POST {courseId}               -> admin-only. Bakes a fresh Watch package for every hole this
                                     course has geometry for, from course_maps.objects_json, and
                                     replaces the course's course_watch_maps row.
   POST {courseId, action:       -> admin-only, metadata only. Writes the hole reference into an
         "backfill-reference"}      already-baked package without re-baking imagery or bumping
                                     its version, and only for holes whose own geometry has
                                     not moved since. See backfillHoleReferences.

   Deliberately synchronous, not a job queue like course-visual-jobs.mjs/course-mapper-jobs.mjs:
   those exist because their work fetches tens of thousands of external map tiles. This pipeline
   reads geometry already sitting in course_maps and draws flat SVG shapes from it - no network
   fetch per hole - so an 18-hole course bakes in low single-digit seconds, comfortably inside a
   normal (non-background) Netlify function's budget. If a future course-size outlier changes
   that, this is the seam to convert to the same queue+worker shape, not a reason to build one
   pre-emptively now.

   Never touches course_maps, course_visuals, course_visual_jobs, or course_mapper_jobs (the
   DATABASE TABLES) - the task this generates from is READ, everything it writes lands only in
   course_watch_maps and the course-watch-maps Storage bucket.

   The one read this pipeline adds beyond that: TERRAIN_BUCKET below is the "course-visuals"
   Storage BUCKET (hyphen), a different resource from the course_visuals DATABASE TABLE
   (underscore) the paragraph above forbids. It is read best-effort, for one file per course -
   the stable frames/index.json the satellite-bake worker already overwrites on every successful
   run - to find each hole's already-cropped elevation image and shade a Watch-scale relief from
   it. No row is read, no job state is consulted, and a course that has never run a satellite
   bake (or a hole whose relief there failed) simply ships its Watch map flat, exactly as every
   hole did before this existed. See generateWatchPackage's terrain step. */

import sharp from "sharp";
import watchMapCore from "../scripts/gd-watch-map-core.js";
import { objectsVersion } from "./lib/gd-course-package-shape.mjs";
import { decodeElevation, hillshade, ambientOcclusion, RELIEF_DEFAULTS } from "./lib/gd-relief-core.mjs";
import { applyRelief, greenContourSvg } from "./lib/gd-visual-export-core.mjs";
import greenCore from "../scripts/gd-green-contours-core.js";

const MAPS_TABLE = "course_maps";
const WATCH_TABLE = "course_watch_maps";
const BUCKET = "course-watch-maps";
const TERRAIN_BUCKET = "course-visuals";
const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);

/* Soft-light strength for the terrain relief laid under the ground fills. Lower than the
   satellite bake's own default: that recipe shades a photograph, where relief has real texture
   to compete with; this recipe shades three or four flat fill colours, where the same strength
   reads as heavier because there is nothing else in the picture to share it with. A drawing
   decision, tunable in place - see gd-relief-core.mjs's header on why relief is drawn, not
   measured. */
const TERRAIN_RELIEF_OPACITY = 0.55;

/* Roughly half the satellite bake's own contour weights (scripts/gd-green-contours-core.js's
   CONTOUR_DEFAULTS) - "thinner" was asked for explicitly, and a 448px-wide canvas earns it
   anyway: the satellite bake draws at up to 2048px, so its line weights already read heavier
   per unit of green here than there before any deliberate thinning at all. */
const WATCH_GREEN_CONTOUR_OPTIONS = {
  indexWidthPx: 0.55, nonIndexWidthPx: 0.35,
  indexHaloWidthPx: 1.0, nonIndexHaloWidthPx: 0.7,
  suppWidthPx: 0.36,
  arrowWidthPx: 0.6, arrowHaloWidthPx: 1.4
};

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

async function bucketDownload(bucket, path) {
  const response = await fetch(supabaseBase() + "/storage/v1/object/" + bucket + "/" + path, {
    headers: { apikey: supabaseKey(), Authorization: "Bearer " + supabaseKey() }
  });
  if (!response.ok) throw new Error("Storage download " + response.status + " for " + bucket + "/" + path);
  return Buffer.from(await response.arrayBuffer());
}

/* Best-effort, whole-course, called once per generation rather than once per hole: every
   hole's already-cropped elevation asset is listed in this one stable file, so finding it never
   costs more than the one read. Returns null on anything from "no satellite bake has ever run"
   to a malformed index - the caller's job is to ship the Watch map either way. */
async function loadTerrainIndex(courseId) {
  try {
    const buffer = await bucketDownload(TERRAIN_BUCKET, courseId + "/frames/index.json");
    const index = JSON.parse(buffer.toString("utf8"));
    return index && Array.isArray(index.holes) ? index : null;
  } catch (error) {
    return null;
  }
}

/* The satellite-bake worker only ever records `playSurface.elevation` when its own relief
   succeeded for that hole (functions/course-visual-worker-background.mjs's own "relief is a
   finish, not the frame" gate) - so its mere presence here already means a decodable crop with
   real bounds exists. Still checked defensively: this file reads someone else's asset, not one
   it wrote itself. */
function elevationMetaForHole(terrainIndex, holeNumber) {
  if (!terrainIndex) return null;
  const hole = terrainIndex.holes.find(h => h.holeNumber === holeNumber);
  const elevation = hole && hole.playSurface && hole.playSurface.elevation;
  if (!elevation || !elevation.path || !elevation.bounds || !(elevation.metresPerPixel > 0)) return null;
  return elevation;
}

async function loadElevationCrop(elevationMeta) {
  const buffer = await bucketDownload(TERRAIN_BUCKET, elevationMeta.path);
  const { data, info } = await sharp(buffer, { limitInputPixels: false }).raw().toBuffer({ resolveWithObject: true });
  const decoded = decodeElevation(data, info.width, info.height, info.channels, elevationMeta.encoding);
  return { heights: decoded.heights, width: info.width, height: info.height, bounds: elevationMeta.bounds, metresPerPixel: elevationMeta.metresPerPixel };
}

/* Same mercator-y convention functions/lib/gd-relief-core.mjs's cropByBounds cuts the crop
   with (linear in longitude, log-scale in latitude) - matching it here is what makes a lat/lng
   land on the row/column that crop was actually cut from, not a nearby one. */
function mercY(lat) {
  const s = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

function heightSampler(crop) {
  const { heights, width, height, bounds } = crop;
  const dx = (bounds.east - bounds.west) || 1e-12;
  const dy = (mercY(bounds.south) - mercY(bounds.north)) || 1e-12;
  const y0 = mercY(bounds.north);
  return function sample(lat, lng) {
    const fx = Math.max(0, Math.min(width - 1, ((lng - bounds.west) / dx) * (width - 1)));
    const fy = Math.max(0, Math.min(height - 1, ((mercY(lat) - y0) / dy) * (height - 1)));
    const x0 = Math.floor(fx), y0i = Math.floor(fy);
    const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0i + 1);
    const tx = fx - x0, ty = fy - y0i;
    const h = (x, y) => heights[y * width + x];
    return h(x0, y0i) * (1 - tx) * (1 - ty) + h(x1, y0i) * tx * (1 - ty)
         + h(x0, y1) * (1 - tx) * ty + h(x1, y1) * tx * ty;
  };
}

/* Shaded fresh in the Watch canvas's own tee-up orientation, rather than shading the DEM crop
   north-up (as the satellite bake does) and warping the finished picture to match afterwards -
   a gradient taken on a rotated raster is a gradient of the ROTATION's own resampling, and
   rotating an already-lit hillshade blurs it and points the light the wrong way. Sampling each
   output pixel's real height and lighting THAT grid keeps both the gradient and the light
   direction honest in the exact frame that ships - no second raster ever exists to warp. */
function reliefMaskForFrame(spatialRef, sample) {
  const w = spatialRef.imageWidth, h = spatialRef.imageHeight;
  const heightsOut = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const latLng = watchMapCore.projectImageToLatLng(spatialRef, { x: x + 0.5, y: y + 0.5 });
      heightsOut[y * w + x] = latLng ? sample(latLng.lat, latLng.lng) : 0;
    }
  }
  const shade = hillshade(heightsOut, w, h, spatialRef.metresPerPixel, {
    exaggeration: RELIEF_DEFAULTS.exaggeration,
    azimuth: RELIEF_DEFAULTS.azimuth,
    altitude: RELIEF_DEFAULTS.altitude,
    smoothPx: 1
  });
  if (RELIEF_DEFAULTS.ambient > 0) {
    const ao = ambientOcclusion(heightsOut, w, h, RELIEF_DEFAULTS.exaggeration);
    for (let i = 0; i < shade.length; i++) shade[i] = shade[i] * (1 - RELIEF_DEFAULTS.ambient) + ao[i] * RELIEF_DEFAULTS.ambient;
  }
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < shade.length; i++) mask[i] = Math.round(shade[i] * 255);
  return mask;
}

/* Ground -> terrain relief -> thin green slope contours -> markers, composited in that order so
   relief lands on real ground pixels and never on the crisp UI markers drawn last. Ships the
   RESULT as a raster - the composited picture - never the elevation crop or the fitted surface
   themselves; those never leave this function. Falls back to the plain flat ground+markers SVG,
   unchanged from before this existed, whenever a hole has no elevation crop or anything about
   using one goes wrong - a Watch map must never fail to bake because its finish did. */
async function rasterizeFrame(frame, geometry, terrainIndex, holeNumber) {
  const elevationMeta = elevationMetaForHole(terrainIndex, holeNumber);
  if (!elevationMeta) return frame.svg;
  try {
    const crop = await loadElevationCrop(elevationMeta);
    const sample = heightSampler(crop);
    const mask = reliefMaskForFrame(frame.spatialReference, sample);

    const ground = await sharp(Buffer.from(frame.groundSvg, "utf8")).raw().toBuffer({ resolveWithObject: true });
    applyRelief(ground.data, mask, TERRAIN_RELIEF_OPACITY, ground.info.channels);
    const composited = sharp(ground.data, {
      raw: { width: ground.info.width, height: ground.info.height, channels: ground.info.channels },
      limitInputPixels: false
    });

    const overlays = [];
    if (geometry.greenShape && geometry.greenShape.length >= 8) {
      const surface = greenCore.fitGreenSurface(crop.heights,
        { width: crop.width, height: crop.height, bounds: crop.bounds, metresPerPixel: crop.metresPerPixel },
        geometry.greenShape);
      if (surface && surface.summary && surface.summary.confidence !== "low") {
        const project = (latLng) => watchMapCore.projectLatLngToImage(frame.spatialReference, latLng.lat, latLng.lng);
        const contourSvg = greenContourSvg(surface, frame.width, frame.height, project, WATCH_GREEN_CONTOUR_OPTIONS);
        if (contourSvg) overlays.push({ input: contourSvg, blend: "over" });
      }
    }
    overlays.push({ input: Buffer.from(frame.markersSvg, "utf8"), blend: "over" });
    return await composited.composite(overlays).png().toBuffer();
  } catch (error) {
    console.log("[watch-maps] terrain skipped for h" + holeNumber + ": " + String(error && error.message || error));
    return frame.svg;
  }
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

/* Renders one hole's baked image (flat SVG, or the terrain-composited raster from
   rasterizeFrame) to both PNG and WebP and keeps whichever is smaller - the task asks us to
   compare, not to assume. WebP wins on essentially every flat-vector hole (measured: ~4-6x
   smaller than PNG for this recipe's flat fills), but the comparison is real, not assumed. */
async function encodeSmallest(image) {
  const buffer = Buffer.isBuffer(image) ? image : Buffer.from(image, "utf8");
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
  const terrainIndex = await loadTerrainIndex(courseId);

  for (const holeNumber of holeNumbers) {
    const geometry = watchMapCore.objectsForHole(map.objects_json, holeNumber);
    const frame = watchMapCore.buildWatchHoleFrame(watchMapCore.WATCH_MAP_RECIPE_V1, geometry);
    if (!frame.ok) { errors.push({ holeNumber, reason: frame.reason }); continue; }
    try {
      const rasterized = await rasterizeFrame(frame, geometry, terrainIndex, holeNumber);
      const encoded = await encodeSmallest(rasterized);
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
        reference: frame.reference,
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

function sameCoordinate(a, b) {
  if (!a || !b) return false;
  return Math.abs(Number(a.lat) - Number(b.lat)) < 1e-9 && Math.abs(Number(a.lng) - Number(b.lng)) < 1e-9;
}

/* Does the stored package still describe the same hole the reference is about
   to claim it does?

   THE THING THIS MUST NOT COMPARE is the projection basis. The obvious guard —
   re-bake the hole and require an identical spatial reference — is wrong here,
   and wrong in a way that refuses every honest backfill.

   The canvas is framed on the hole's play corridor PLUS whichever mapped
   surface vertices fall inside it, so the image's width depends on the
   fairways, bunkers and water that were in objects_json at bake time. Those are
   capture-time input: they are collected to be drawn, they become part of the
   image, and the lean tee/green/route set that objects_json settles back to is
   all GPS Play needs. Millbrook proves the point — all 18 holes have identical
   tees, greens, green extents, route point counts and hole bearings, and all 18
   canvases changed width, purely because the surfaces are no longer listed.

   None of that is in the reference. The reference is lat/lng, and it is
   delivered beside the STORED spatial reference, which still projects it onto
   the stored image exactly as it always did. So the honest question is only
   whether the geometry the reference itself carries has moved, and that is what
   is compared here: the tee, the green, the green outline's near and far
   extents, the number of points in the play line, and the hole's bearing.

   Known gap, stated rather than papered over: a green outline that changed
   shape while keeping the same nearest and farthest points from the tee would
   pass. checkpoints is all the stored row keeps of the outline, so that is the
   floor available without re-reading the image. A moved green, a moved tee, a
   re-routed hole or a re-shaped green that moves either extent are all caught. */
function sameReferenceGeometry(stored, fresh) {
  const a = stored && stored.checkpoints, b = fresh && fresh.checkpoints;
  if (!a || !b) return false;
  if (!sameCoordinate(a.tee, b.tee) || !sameCoordinate(a.green, b.green)) return false;
  /* An outline that has appeared or vanished since the bake is a change. */
  if (!!a.greenFront !== !!b.greenFront || !!a.greenBack !== !!b.greenBack) return false;
  if (a.greenFront && (!sameCoordinate(a.greenFront, b.greenFront) || !sameCoordinate(a.greenBack, b.greenBack))) return false;
  if (Number(stored.layers && stored.layers.routePoints) !== Number(fresh.layers && fresh.layers.routePoints)) return false;
  /* The bearing the reference publishes is derived from this rotation, so it is
     compared directly rather than trusted to follow from the tee and green. */
  const rotation = Math.abs(Number(stored.spatialReference && stored.spatialReference.rotationDegrees)
    - Number(fresh.spatialReference && fresh.spatialReference.rotationDegrees));
  return Number.isFinite(rotation) && rotation < 1e-9;
}

/* Gives an already-baked package the hole reference it was generated without.

   `reference` is derived entirely from course_maps.objects_json - never from
   the image - so it can be written into an existing row WITHOUT re-baking any
   imagery and WITHOUT bumping watch_package_version. That matters: bumping the
   version would re-push ~100KB per course over WatchConnectivity to every
   wrist that already holds the package, for a few hundred bytes of geometry.
   Same manoeuvre as the millbrook-remarkables-18 metadata restore.

   The safety property is the whole point. objects_json may have been edited
   since the bake, and a reference describing today's green sitting under an
   image drawn from last week's would put the wrist's Bubble in a place the
   picture disagrees with - silently, because both halves are individually
   valid. So every hole is re-run through the real generator and the geometry
   the REFERENCE itself carries must be unchanged before it is accepted; see
   sameReferenceGeometry, which deliberately does not care that the canvas has
   been reframed. A hole that fails is left exactly as it was and named in the
   report; the fix for it is a regenerate, not a backfill. */
function backfillHoleReferences(map, row) {
  const stored = Array.isArray(row && row.holes) ? row.holes : [];
  const skipped = [];
  let updated = 0, alreadyPresent = 0;

  const holes = stored.map(hole => {
    const holeNumber = Number(hole && hole.holeNumber);
    if (hole && hole.reference) { alreadyPresent += 1; return hole; }
    if (!Number.isFinite(holeNumber) || holeNumber <= 0) {
      skipped.push({ holeNumber: hole && hole.holeNumber, reason: "hole has no usable number" });
      return hole;
    }
    const geometry = watchMapCore.objectsForHole(map.objects_json, holeNumber);
    const frame = watchMapCore.buildWatchHoleFrame(watchMapCore.WATCH_MAP_RECIPE_V1, geometry);
    if (!frame.ok) {
      skipped.push({ holeNumber, reason: frame.reason });
      return hole;
    }
    if (!sameReferenceGeometry(hole, frame)) {
      skipped.push({ holeNumber, reason: "the hole's own geometry has moved since this package was baked - regenerate instead" });
      return hole;
    }
    updated += 1;
    return Object.assign({}, hole, { reference: frame.reference });
  });

  return { holes, updated, alreadyPresent, skipped };
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

  /* Metadata-only: writes the hole reference into an existing package without
     touching its imagery or its version. Deliberately a separate action rather
     than something a plain POST does on the way past - a regenerate replaces a
     package, and this must be usable precisely when you do NOT want that. */
  if (String(payload && payload.action || "") === "backfill-reference") {
    const row = await loadWatchRow(courseId);
    if (!row || !Array.isArray(row.holes) || !row.holes.length) {
      return json(404, { courseId, error: "no stored Watch package to backfill" });
    }
    const result = backfillHoleReferences(map, row);
    if (result.updated > 0) {
      try {
        await supabaseFetch(WATCH_TABLE + "?course_id=eq." + encodeURIComponent(courseId), {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ holes: result.holes, updated_at: new Date().toISOString() })
        });
      } catch (error) {
        return json(502, { courseId, error: "backfill could not be persisted: " + String(error && error.message || error) });
      }
    }
    return json(200, {
      courseId,
      action: "backfill-reference",
      watchPackageVersion: row.watch_package_version,
      holeCount: result.holes.length,
      updated: result.updated,
      alreadyPresent: result.alreadyPresent,
      skipped: result.skipped
    });
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

export const __test = {
  holeNumbersFromObjects, reportShape, recoveryReport, supersededPaths, sameReferenceGeometry, backfillHoleReferences,
  mercY, heightSampler, elevationMetaForHole
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
