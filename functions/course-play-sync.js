"use strict";

const {
  hasSupabase,
  json,
  supabaseFetch,
  text
} = require("./payment-utils");

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { ok: false, status: "method_not_allowed", error: "Method not allowed" });

  let input;
  try {
    input = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { ok: false, status: "invalid_json", error: "Invalid JSON" });
  }

  const dryRun = !!(input.dryRun || input.action === "dry_run");
  const source = text(input.source || "admin-course-database", 120);
  const payload = sanitizeCoursePlayPayload(input.payload || input.coursePlayPayload || input);
  const validation = validatePayload(payload);
  if (!validation.ok) {
    return json(400, Object.assign({ ok: false, status: "rejected", configured: hasSupabase(), dryRun, source }, validation));
  }

  if (dryRun) {
    return json(200, {
      ok: true,
      status: "dry_run",
      configured: hasSupabase(),
      dryRun: true,
      source,
      courseFingerprint: payload.courseFingerprint,
      payloadHash: payload.payloadHash,
      courseName: payload.courseName,
      holeCount: payload.holes.length,
      strippedFields: strippedFields(),
      warnings: validation.warnings
    });
  }

  if (!hasSupabase()) {
    return json(200, {
      ok: false,
      status: "not_configured",
      configured: false,
      dryRun: false,
      source,
      courseFingerprint: payload.courseFingerprint,
      payloadHash: payload.payloadHash,
      courseName: payload.courseName,
      holeCount: payload.holes.length,
      message: "Supabase is not configured for Course Play sync. Local Course Database is unchanged."
    });
  }

  try {
    const now = new Date().toISOString();
    await supabaseFetch("course_play_courses?on_conflict=course_fingerprint", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        course_fingerprint: payload.courseFingerprint,
        course_id: payload.courseId,
        course_key: payload.courseKey,
        course_name: payload.courseName,
        schema_version: payload.schemaVersion,
        data_version: payload.dataVersion,
        status: payload.status,
        source: payload.source,
        confidence: payload.confidence,
        hole_count: payload.holes.length,
        bounds_json: payload.bounds,
        centre_json: payload.centre,
        payload_hash: payload.payloadHash,
        payload_json: payload,
        last_seen_at: now,
        updated_at: now
      })
    });

    const holeRows = payload.holes.map(hole => ({
      course_fingerprint: payload.courseFingerprint,
      hole_number: hole.holeNumber,
      hole_fingerprint: hole.holeFingerprint,
      status: hole.status,
      source: hole.source,
      confidence: hole.confidence,
      tee_point_json: hole.teePoint,
      green_centre_json: hole.greenCentre,
      green_shape_json: hole.greenShape,
      green_bounds_json: hole.greenBounds,
      fairway_points_json: hole.fairwayPoints,
      route_points_json: hole.routePoints,
      frame_anchors_json: hole.frameAnchors,
      presentation_json: hole.presentation,
      payload_hash: hole.payloadHash,
      payload_json: hole,
      updated_at: now
    }));
    if (holeRows.length) {
      await supabaseFetch("course_play_holes?on_conflict=course_fingerprint,hole_number", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(holeRows)
      });
    }

    const contributionId = "cpc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
    await supabaseFetch("course_play_contributions", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        contribution_id: contributionId,
        course_fingerprint: payload.courseFingerprint,
        payload_hash: payload.payloadHash,
        source,
        dry_run: false,
        hole_count: payload.holes.length,
        payload_json: {
          courseFingerprint: payload.courseFingerprint,
          payloadHash: payload.payloadHash,
          courseName: payload.courseName,
          holeCount: payload.holes.length,
          uploadedAt: now,
          source
        }
      })
    });

    return json(200, {
      ok: true,
      status: "uploaded",
      configured: true,
      dryRun: false,
      source,
      courseFingerprint: payload.courseFingerprint,
      payloadHash: payload.payloadHash,
      courseName: payload.courseName,
      holeCount: payload.holes.length,
      holesUpserted: holeRows.length,
      contributionId,
      warnings: validation.warnings
    });
  } catch (error) {
    return json(error.status || 502, {
      ok: false,
      status: "failed",
      configured: true,
      dryRun: false,
      source,
      courseFingerprint: payload.courseFingerprint,
      payloadHash: payload.payloadHash,
      courseName: payload.courseName,
      holeCount: payload.holes.length,
      error: "Course Play Supabase upload failed",
      details: error.body || error.message || String(error)
    });
  }
};

function validatePayload(payload) {
  const warnings = [];
  if (!payload || typeof payload !== "object") return { ok: false, error: "Course Play payload is required" };
  if (!payload.courseFingerprint) return { ok: false, error: "Course fingerprint is required" };
  if (!payload.payloadHash) return { ok: false, error: "Payload hash is required" };
  if (!payload.courseName) warnings.push("Course name was empty and normalized to Course.");
  if (!Array.isArray(payload.holes) || !payload.holes.length) return { ok: false, error: "At least one hole is required" };
  const badHole = payload.holes.find(hole => !hole || !hole.holeNumber || !hole.holeFingerprint);
  if (badHole) return { ok: false, error: "Every hole requires holeNumber and holeFingerprint" };
  return { ok: true, warnings };
}

function sanitizeCoursePlayPayload(raw) {
  raw = raw && raw.payload || raw;
  if (!raw || typeof raw !== "object") return null;
  const holes = (Array.isArray(raw.holes) ? raw.holes : []).map(sanitizeHole).sort((a, b) => a.holeNumber - b.holeNumber);
  const bounds = courseBounds(holes);
  const clean = {
    schema: "gd.course_play_supabase.course",
    schemaVersion: Math.max(1, Number(raw.schemaVersion || 2)),
    sanitizedAt: new Date().toISOString(),
    recordId: text(raw.recordId, 180),
    courseId: text(raw.courseId || raw.courseKey || "course", 160),
    courseKey: text(raw.courseKey || raw.courseId || "course", 160),
    courseName: text(raw.courseName || "Course", 220),
    status: text(raw.status || "unknown", 80),
    source: text(raw.source || "local", 100),
    confidence: text(raw.confidence || "unknown", 160),
    dataVersion: Math.max(1, Number(raw.dataVersion || 1)),
    syncStatus: text(raw.syncStatus || "local", 80),
    remoteId: raw.remoteId || null,
    invalidatedAt: raw.invalidatedAt || null,
    invalidationReason: raw.invalidationReason || null,
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
    holeCount: holes.length,
    bounds,
    centre: centre(bounds),
    holes
  };
  clean.courseFingerprint = "gdc_" + stableHash([
    fingerprintText(clean.courseName),
    clean.holeCount,
    holes.map(hole => ({
      n: hole.holeNumber,
      tee: hole.teePoint,
      green: hole.greenCentre,
      shape: hole.greenShape,
      route: hole.routePoints,
      anchors: hole.frameAnchors
    }))
  ]);
  clean.payloadHash = "gdcp_" + stableHash(Object.assign({}, clean, { sanitizedAt: null }));
  return clean;
}

function sanitizeHole(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  const clean = {
    schema: "gd.course_play_supabase.hole",
    schemaVersion: Math.max(1, Number(raw.schemaVersion || 2)),
    recordId: text(raw.recordId, 180),
    courseId: text(raw.courseId, 160),
    courseKey: text(raw.courseKey, 160),
    courseName: text(raw.courseName || "Course", 220),
    holeNumber: normalizeHoleNumber(raw.holeNumber),
    status: text(raw.status || "unknown", 80),
    source: text(raw.source || "local", 100),
    confidence: text(raw.confidence || "unknown", 160),
    teePoint: sanitizePoint(raw.teePoint),
    greenCentre: sanitizePoint(raw.greenCentre),
    greenShape: sanitizePoints(raw.greenShape),
    greenBounds: sanitizeBounds(raw.greenBounds),
    fairwayPoints: sanitizePoints(raw.fairwayPoints),
    routePoints: sanitizePoints(raw.routePoints),
    frameAnchors: sanitizeFrameAnchors(raw.frameAnchors),
    presentation: sanitizePresentation(raw.presentation),
    dataVersion: Math.max(1, Number(raw.dataVersion || 1)),
    invalidatedAt: raw.invalidatedAt || null,
    invalidationReason: raw.invalidationReason || null,
    syncStatus: text(raw.syncStatus || "local", 80),
    remoteId: raw.remoteId || null,
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null
  };
  clean.greenBounds = clean.greenBounds || deriveBounds(clean.greenShape.concat([clean.greenCentre].filter(Boolean)));
  clean.holeFingerprint = "gdh_" + stableHash([
    fingerprintText(clean.courseName),
    clean.holeNumber,
    clean.teePoint,
    clean.greenCentre,
    clean.greenShape,
    clean.routePoints,
    clean.frameAnchors
  ]);
  clean.payloadHash = "gdhp_" + stableHash(clean);
  return clean;
}

function sanitizeFrameAnchors(value) {
  value = value && typeof value === "object" ? value : {};
  return {
    tee: sanitizePoint(value.tee),
    green: sanitizePoint(value.green),
    route: sanitizePoints(value.route),
    greenShape: sanitizePoints(value.greenShape)
  };
}

function sanitizePresentation(value) {
  value = value && typeof value === "object" ? value : {};
  return {
    owner: text(value.owner || "gps-play", 80),
    capturedSurfaceReady: !!value.capturedSurfaceReady,
    frameStatus: text(value.frameStatus || "unknown", 80)
  };
}

function sanitizePoint(value) {
  if (!value || typeof value !== "object") return null;
  const lat = roundCoord(value.lat !== undefined ? value.lat : value.latitude);
  const lng = roundCoord(value.lng !== undefined ? value.lng : (value.lon !== undefined ? value.lon : value.longitude));
  if (lat === null || lng === null) return null;
  return { lat, lng };
}

function sanitizePoints(list) {
  return (Array.isArray(list) ? list : []).map(sanitizePoint).filter(Boolean);
}

function sanitizeBounds(value) {
  if (!value || typeof value !== "object") return null;
  const south = roundCoord(value.south);
  const west = roundCoord(value.west);
  const north = roundCoord(value.north);
  const east = roundCoord(value.east);
  return [south, west, north, east].some(v => v === null) ? null : { south, west, north, east };
}

function deriveBounds(points) {
  const pts = (Array.isArray(points) ? points : []).filter(Boolean);
  if (!pts.length) return null;
  const lats = pts.map(p => p.lat);
  const lngs = pts.map(p => p.lng);
  return {
    south: Math.min.apply(null, lats),
    west: Math.min.apply(null, lngs),
    north: Math.max.apply(null, lats),
    east: Math.max.apply(null, lngs)
  };
}

function courseBounds(holes) {
  let pts = [];
  holes.forEach(hole => {
    pts = pts.concat([hole.teePoint, hole.greenCentre], hole.greenShape || [], hole.fairwayPoints || [], hole.routePoints || []);
  });
  return deriveBounds(pts);
}

function centre(bounds) {
  if (!bounds) return null;
  return {
    lat: roundCoord((Number(bounds.south) + Number(bounds.north)) / 2),
    lng: roundCoord((Number(bounds.west) + Number(bounds.east)) / 2)
  };
}

function normalizeHoleNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 1;
}

function roundCoord(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1000000) / 1000000 : null;
}

function fingerprintText(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
}

function stableHash(value) {
  const input = typeof value === "string" ? value : stableStringify(value);
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return ("00000000" + (h >>> 0).toString(16)).slice(-8);
}

function strippedFields() {
  return [
    "capturedManifestKey",
    "frameIndexKey",
    "manifestKey",
    "tileMetadata",
    "tiles",
    "originPx",
    "imageWidth",
    "imageHeight",
    "captureZoom",
    "localStorage frame index",
    "debug timeline",
    "sync queue"
  ];
}
