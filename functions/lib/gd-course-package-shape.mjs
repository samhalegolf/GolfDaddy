/* Shapes the four backing tables (course_maps, course_visuals, course_visual_jobs,
   course_mapper_jobs) into the response contract described by the course-package
   architecture doc: one of Full Map Package / Lite Geometry Pack / Processing /
   Manual Action Required / Failed / None. ("Failed" is a post-doc addition - see
   deriveCoursePackageState for why a failed run must not read as "none".)

   Shared between functions/course-package.mjs (the reader) and, indirectly, the writers that
   produce the source data (functions/course-mapper-worker-background.mjs writes
   objects_json/holes_json this reads; functions/course-visual-worker-background.mjs writes
   uploaded_assets this reads) - kept in one small module so the two ends of the contract
   cannot drift independently of each other. */

/* The version of a course's OBJECTS (geometry) as the rest of the system counts
   it: the newest of published_at/updated_at on course_maps. published_at is the
   meaningful one for a published course, but fall back to updated_at so a row
   touched without a republish still invalidates a stale local copy.

   Defined here rather than in course-library.mjs so /api/course-library and
   /api/course-package report the SAME value. They did not: the manifest
   reported this timestamp while the package reported course_maps.geometry_version
   (the mapper algorithm version, "v1" or null). A client comparing one against
   the other was comparing two unrelated things, so every course with a null
   geometry_version read as permanently "Update available". */
export function objectsVersion(map) {
  const published = map && map.published_at ? String(map.published_at) : "";
  const updated = map && map.updated_at ? String(map.updated_at) : "";
  if (published && updated) return published > updated ? published : updated;
  return published || updated || null;
}

function finitePoint(value) {
  const lat = Number(value && value.lat);
  const lng = Number(value && value.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function objectsByHole(objectsJson) {
  const byHole = new Map();
  Object.values(objectsJson || {}).forEach(object => {
    if (!object || !Number.isFinite(Number(object.holeNumber))) return;
    const hole = Number(object.holeNumber);
    if (!byHole.has(hole)) byHole.set(hole, []);
    byHole.get(hole).push(object);
  });
  return byHole;
}

/* Route is not stored as an ordered polyline anywhere in course_maps today - only discrete
   tee/fairway/green points. This approximates a route as [tee, fairway points as stored,
   green] rather than fabricating an ordering the source data cannot support. Good enough for
   drawing a corridor overlay on the live map; not a substitute for the original OSM guide
   line if that level of fidelity is ever needed. */
function approximateRoute(objects) {
  const tee = objects.find(o => o.type === "tee");
  const fairway = objects.filter(o => o.type === "fairway");
  const green = objects.find(o => o.type === "green");
  return [tee, ...fairway, green].filter(Boolean).map(o => finitePoint(o.position)).filter(Boolean);
}

export function courseBoundsFromObjects(objectsJson) {
  const points = Object.values(objectsJson || {}).map(o => finitePoint(o && o.position)).filter(Boolean);
  if (!points.length) return null;
  return {
    south: Math.min(...points.map(p => p.lat)), north: Math.max(...points.map(p => p.lat)),
    west: Math.min(...points.map(p => p.lng)), east: Math.max(...points.map(p => p.lng))
  };
}

/* Doc shape: {courseId, status:"lite-geo-ready", objectsVersion, geometryVersion, courseBounds,
   holes:[{holeNumber, tee, green, greenShape, route, confidence}], visualJob:{status}}. */
export function shapeLitePackage(map, visualJobStatus) {
  const byHole = objectsByHole(map.objects_json);
  const holes = Array.from(byHole.entries()).map(([holeNumber, objects]) => {
    const tee = objects.find(o => o.type === "tee");
    const green = objects.find(o => o.type === "green");
    return {
      holeNumber,
      tee: tee ? finitePoint(tee.position) : null,
      green: green ? finitePoint(green.position) : null,
      greenShape: (green && Array.isArray(green.greenShape) ? green.greenShape : green && green.shape) || null,
      route: approximateRoute(objects),
      confidence: green && Number.isFinite(Number(green.resolverConfidence)) ? Number(green.resolverConfidence) : null
    };
  }).sort((a, b) => a.holeNumber - b.holeNumber);
  return {
    courseId: map.course_id,
    status: "lite-geo-ready",
    objectsVersion: objectsVersion(map),
    geometryVersion: map.geometry_version || null,
    courseBounds: courseBoundsFromObjects(map.objects_json),
    holes,
    visualJob: { status: visualJobStatus || "none" }
  };
}

function hashText(text) {
  let hash = 5381;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

function assetUrl(path) {
  return "/api/course-visual-assets?path=" + encodeURIComponent(path);
}

/* Doc shape: {courseId, status:"full-map-ready", packageVersion, objectsVersion, geometryVersion,
   generatedAt, holes:[{holeNumber, geometry, visual:{url,width,height,anchorPins,transform,
   checksum}}]}.

   "checksum" here is a hash of this JSON descriptor (path+dimensions+bounds), NOT a hash of
   the image bytes themselves - re-hashing the actual published JPEG would mean this read
   endpoint downloading every hole's imagery on every request. It is enough to let a client
   detect that ITS COPY of the descriptor is stale, which is the property course-package
   consumers actually need (see stage 7's boundary-safe activation, which compares this
   against what it already has before swapping visuals mid-round) - it is not a substitute
   for a real content hash if one is ever needed for integrity verification.
   "transform"/"orientation" from the doc's illustrative schema are represented here as the
   real `playSurface` object the visual worker already writes (projection, anchorPins,
   sourceBounds, captureZoom, originPx) rather than inventing fields with no data behind
   them. */
export function shapeFullPackage(map, visual) {
  /* Belt as well as braces: deriveCoursePackageState above will no longer route an
     orphaned visual here, but this is a public export and a null map must not be a
     crash in any caller. */
  if (!map || !visual) return null;
  const byHole = objectsByHole(map.objects_json);
  const frames = (visual.uploaded_assets || []).filter(a => a && a.role === "hole-frame-published" && Number.isFinite(Number(a.holeNumber)));
  const holes = frames.map(frame => {
    const holeNumber = Number(frame.holeNumber);
    const objects = byHole.get(holeNumber) || [];
    const green = objects.find(o => o.type === "green");
    const tee = objects.find(o => o.type === "tee");
    const metadata = frame.metadata || {};
    const playSurface = metadata.playSurface || null;
    const checksum = hashText(frame.path + "|" + (metadata.width || "") + "|" + (metadata.height || "") + "|" + JSON.stringify(metadata.bounds || {}));
    return {
      holeNumber,
      geometry: {
        tee: tee ? finitePoint(tee.position) : null,
        green: green ? finitePoint(green.position) : null,
        greenShape: (green && (green.greenShape || green.shape)) || null,
        route: approximateRoute(objects)
      },
      visual: {
        url: assetUrl(frame.path),
        width: metadata.width || null,
        height: metadata.height || null,
        bounds: metadata.bounds || null,
        playSurface,
        checksum
      }
    };
  }).sort((a, b) => a.holeNumber - b.holeNumber);
  return {
    courseId: map.course_id,
    status: "full-map-ready",
    packageVersion: visual.published_version || null,
    objectsVersion: objectsVersion(map),
    geometryVersion: map.geometry_version || null,
    generatedAt: (visual.diagnostics && visual.diagnostics.generatedAt) || visual.updated_at || null,
    holes
  };
}

export function hasGeometryPayload(map) {
  if (!map) return false;
  const objects = map.objects_json && typeof map.objects_json === "object" ? map.objects_json : {};
  const holes = map.holes_json && typeof map.holes_json === "object" ? map.holes_json : {};
  return Object.keys(objects).length > 0 || Object.keys(holes).length > 0;
}

function liveJob(jobs) {
  return (jobs || []).find(j => j.status === "running") || (jobs || []).find(j => j.status === "queued") || null;
}

/* Derives ONE overall course-package state from the four tables. Precedence, per the
   architecture doc: Full beats Lite beats Processing beats Manual beats None - a published
   Full Map Package makes the course playable regardless of what the mapper/visual queues are
   doing right now (a re-export in progress must not knock a course back to "processing" and
   off the map players are currently using). Mirrors the "what EXISTS over what the queue
   last said" reasoning already used by course-visual-jobs.mjs's courseBuildState and
   course-mapper-jobs.mjs's mapperBuildState - this is the same rule one level up, composing
   both of their derived states rather than re-deriving from raw job rows. */
export function deriveCoursePackageState({ map, visual, visualJobs, mapperJobs }) {
  /* A published visual is only a Full Map Package if the geometry it was rendered
     against still exists. Deleting a course_maps row without its course_visuals row
     leaves a published visual pointing at nothing, and this used to answer
     "full-map-ready" for it - after which shapeFullPackage dereferenced a null map
     and the whole endpoint 502'd for that course. Orphaned state must degrade, never
     crash: with no map row the honest answer is that the course is not built. */
  const fullReady = !!(map && visual && Number(visual.published_version) > 0);
  const hasGeometry = hasGeometryPayload(map);
  const liveMapperJob = liveJob(mapperJobs);
  const liveVisualJob = liveJob(visualJobs);
  const lastMapperJob = (mapperJobs || [])[0];
  const manualRequired = !!(lastMapperJob && lastMapperJob.status === "manual-required");
  /* "failed" is a real state, not a flavor of "none". Collapsing it into "none" meant
     buildCoursePackageWithTrigger re-enqueued a fresh mapper job on every poll of a course
     whose runs fail fast: 2026-08-18, a mis-matched "california" course burned 5 identical
     failed jobs in 40 seconds, which exhausted the per-user auto rate limit
     (course-mapper-jobs.mjs AUTO_RATE_MAX_PER_USER) and silently starved the two real LA
     courses scanned right after it of any mapper job at all. A failed run against unchanged
     OSM data will fail identically; retrying it is a deliberate act (the mapping flyout's
     Auto tool, or an admin remap), never an automatic side effect of reading state. */
  const lastFailed = !!(lastMapperJob && lastMapperJob.status === "failed");
  if (fullReady) return "full-map-ready";
  if (hasGeometry) return "lite-geo-ready";
  if (manualRequired) return "manual-required";
  if (liveMapperJob || liveVisualJob) return "processing";
  if (lastFailed) return "failed";
  return "none";
}

export const __coursePackageShapeTest = { objectsByHole, approximateRoute, hasGeometryPayload, liveJob };
