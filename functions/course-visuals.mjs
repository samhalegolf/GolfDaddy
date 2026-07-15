const TABLE = "course_visuals";
const BUCKET = "course-visuals";
const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);

function env(name) {
  return process.env[name] || "";
}

function supabaseBase() {
  return env("SUPABASE_URL").replace(/\/+$/, "");
}

function supabaseKey() {
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

function hasSupabase() {
  return !!(supabaseBase() && supabaseKey());
}

async function supabaseFetch(path, options = {}) {
  if (!hasSupabase()) throw new Error("Supabase is not configured");
  const headers = Object.assign({
    apikey: supabaseKey(),
    Authorization: "Bearer " + supabaseKey(),
    "Content-Type": "application/json"
  }, options.headers || {});
  const response = await fetch(supabaseBase() + "/rest/v1/" + path, Object.assign({}, options, { headers }));
  const bodyText = await response.text();
  let body = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch (_error) {
      body = bodyText;
    }
  }
  if (!response.ok) {
    const error = new Error("Supabase request failed");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function supabaseStorageFetch(path, options = {}) {
  if (!hasSupabase()) throw new Error("Supabase is not configured");
  const headers = Object.assign({
    apikey: supabaseKey(),
    Authorization: "Bearer " + supabaseKey(),
  }, options.headers || {});
  const response = await fetch(supabaseBase() + "/storage/v1/object/" + path, Object.assign({}, options, { headers }));
  const bodyText = await response.text();
  if (!response.ok) {
    const error = new Error("Supabase storage request failed");
    error.status = response.status;
    error.body = bodyText;
    throw error;
  }
  return bodyText;
}

export default async function courseVisuals(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method === "GET") {
    const url = new URL(req.url);
    const courseId = text(url.searchParams.get("courseId"), 160);
    if (!courseId) return json(400, { error: "courseId is required" });
    if (!hasSupabase()) return json(200, { visual: null, storage: "unconfigured" });
    try {
      const rows = await supabaseFetch(TABLE + "?select=*&course_id=eq." + encodeURIComponent(courseId) + "&order=updated_at.desc&limit=1", { method: "GET" });
      return json(200, { visual: Array.isArray(rows) && rows[0] ? rowToVisual(rows[0]) : null, storage: "supabase" });
    } catch (error) {
      return json(error.status || 503, { error: storageMessage(error), visual: null });
    }
  }
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  let payload;
  try {
    payload = await req.json();
  } catch (_error) {
    return json(400, { error: "Invalid JSON" });
  }

  const actor = payload && payload.actor || {};
  if (!isAdminActor(actor)) return json(403, { error: "Admin visual publish only" });
  const visual = sanitizeVisual(payload && payload.visual);
  if (!visual) return json(400, { error: "Course visual record is required" });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured", visual });

  try {
    const uploadedAssets = await uploadVisualAssets(payload && payload.visual && payload.visual.assets);
    if (uploadedAssets.length) visual.uploaded_assets = uploadedAssets;
    await supabaseFetch(TABLE + "?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(visualToRow(visual))
    });
    const responseVisual = withPlayPayload(visual);
    return json(200, { visual: responseVisual, play_payload: responseVisual.play_payload, playPayload: responseVisual.play_payload, storage: "supabase" });
  } catch (error) {
    return json(error.status || 503, { error: storageMessage(error), visual });
  }
}

async function uploadVisualAssets(assets) {
  const uploaded = [];
  for (const asset of Array.isArray(assets) ? assets : []) {
    const clean = sanitizeAsset(asset);
    if (!clean) continue;
    const bytes = dataUrlToBytes(clean.dataUrl);
    await supabaseStorageFetch(BUCKET + "/" + encodeURIComponent(clean.path).replace(/%2F/g, "/"), {
      method: "POST",
      headers: {
        "Content-Type": clean.contentType,
        "x-upsert": "true",
      },
      body: bytes
    });
    uploaded.push({ path: clean.path, role: clean.role, contentType: clean.contentType, byteLength: bytes.byteLength, holeNumber: clean.holeNumber, hole_number: clean.holeNumber, metadata: clean.metadata });
  }
  return uploaded;
}

export const config = {
  path: "/api/course-visuals",
};

function sanitizeVisual(input) {
  if (!input || typeof input !== "object") return null;
  const courseId = slug(input.course_id || input.courseId);
  if (!courseId) return null;
  const now = new Date().toISOString();
  return {
    id: text(input.id || ("visual::" + courseId), 180),
    course_id: courseId,
    status: status(input.status),
    raw_master_path: text(input.raw_master_path || input.rawMasterPath, 320),
    basic_image_path: text(input.basic_image_path || input.basicImagePath, 320),
    preview_image_path: text(input.preview_image_path || input.previewImagePath, 320),
    published_image_path: text(input.published_image_path || input.publishedImagePath, 320),
    course_bounds: jsonObject(input.course_bounds || input.courseBounds),
    source_capture_ids: jsonArray(input.source_capture_ids || input.sourceCaptureIds),
    preset_id: text(input.preset_id || input.presetId, 160),
    preset_version: integer(input.preset_version ?? input.presetVersion),
    course_overrides: jsonObject(input.course_overrides || input.courseOverrides),
    current_version: integer(input.current_version ?? input.currentVersion),
    published_version: integer(input.published_version ?? input.publishedVersion),
    last_error: jsonObject(input.last_error || input.lastError),
    diagnostics: jsonObject(input.diagnostics),
    versions: jsonArray(input.versions),
    uploaded_assets: jsonArray(input.uploaded_assets || input.uploadedAssets),
    updated_at: text(input.updated_at || input.updatedAt, 80) || now
  };
}

function visualToRow(visual) {
  return Object.assign({}, visual, {
    created_at: undefined
  });
}

function rowToVisual(row) {
  return withPlayPayload({
    id: text(row && row.id, 180),
    course_id: text(row && row.course_id, 160),
    status: status(row && row.status),
    raw_master_path: text(row && row.raw_master_path, 320),
    basic_image_path: text(row && row.basic_image_path, 320),
    preview_image_path: text(row && row.preview_image_path, 320),
    published_image_path: text(row && row.published_image_path, 320),
    course_bounds: jsonObject(row && row.course_bounds),
    source_capture_ids: jsonArray(row && row.source_capture_ids),
    preset_id: text(row && row.preset_id, 160),
    preset_version: integer(row && row.preset_version),
    course_overrides: jsonObject(row && row.course_overrides),
    current_version: integer(row && row.current_version),
    published_version: integer(row && row.published_version),
    last_error: jsonObject(row && row.last_error),
    diagnostics: jsonObject(row && row.diagnostics),
    versions: jsonArray(row && row.versions),
    uploaded_assets: jsonArray(row && row.uploaded_assets),
    created_at: text(row && row.created_at, 80),
    updated_at: text(row && row.updated_at, 80)
  });
}

function withPlayPayload(visual) {
  const out = Object.assign({}, visual || {});
  out.play_payload = visualToPlayPayload(out);
  out.playPayload = out.play_payload;
  return out;
}

function visualToPlayPayload(visual) {
  visual = visual || {};
  const overview = playAssetForRole(visual, "published", visual.published_image_path);
  const holeFrames = playAssetsForRole(visual, "hole-frame-published").sort((a, b) => integer(a.holeNumber) - integer(b.holeNumber));
  const singleHole = playAssetForRole(visual, "single-hole-published", "") || holeFrames[0] || null;
  const holeFrameMap = {};
  for (const asset of holeFrames) {
    const holeNumber = integer(asset && asset.holeNumber);
    if (holeNumber) holeFrameMap[String(holeNumber)] = asset;
  }
  const statusValue = visual.status === "published" && overview ? "published" : "unavailable";
  return {
    schema: "gd.course_visual.play_payload",
    version: 1,
    source: "supabase-course-visuals",
    course_id: text(visual.course_id, 160),
    courseId: text(visual.course_id, 160),
    status: statusValue,
    published_version: integer(visual.published_version),
    publishedVersion: integer(visual.published_version),
    preset_id: text(visual.preset_id, 160),
    presetId: text(visual.preset_id, 160),
    preset_version: integer(visual.preset_version),
    presetVersion: integer(visual.preset_version),
    course_bounds: jsonObject(visual.course_bounds),
    courseBounds: jsonObject(visual.course_bounds),
    published_visual: overview,
    publishedVisual: overview,
    single_hole_published_visual: singleHole,
    singleHolePublishedVisual: singleHole,
    hole_frames: holeFrames,
    holeFrames,
    hole_frame_map: holeFrameMap,
    holeFrameMap,
    assets: {
      overview,
      singleHole,
      holeFrames,
      holeFrameMap,
      stitchUnderlay: overview
    },
    updated_at: text(visual.updated_at, 80),
    updatedAt: text(visual.updated_at, 80)
  };
}

function playAssetForRole(visual, role, fallbackPath) {
  return playAssetFromUpload(jsonArray(visual && visual.uploaded_assets).find((asset) => String(asset && asset.role || "") === role), role, fallbackPath);
}

function playAssetsForRole(visual, role) {
  return jsonArray(visual && visual.uploaded_assets)
    .filter((asset) => String(asset && asset.role || "") === role)
    .map((asset) => playAssetFromUpload(asset, role, ""))
    .filter(Boolean);
}

function playAssetFromUpload(uploaded, role, fallbackPath) {
  const sourcePath = text(uploaded && uploaded.path || fallbackPath, 420);
  const objectPath = storageObjectPath(sourcePath);
  if (!objectPath) return null;
  const publicUrl = publicStorageUrl(objectPath);
  const holeNumber = integer(uploaded && (uploaded.holeNumber ?? uploaded.hole_number));
  return {
    role,
    path: displayAssetPath(sourcePath || objectPath),
    storage_path: BUCKET + "/" + objectPath,
    storagePath: BUCKET + "/" + objectPath,
    public_url: publicUrl,
    publicUrl,
    url: publicUrl,
    content_type: text(uploaded && (uploaded.contentType || uploaded.content_type), 80) || "image/svg+xml",
    contentType: text(uploaded && (uploaded.contentType || uploaded.content_type), 80) || "image/svg+xml",
    byte_length: integer(uploaded && (uploaded.byteLength ?? uploaded.byte_length)),
    byteLength: integer(uploaded && (uploaded.byteLength ?? uploaded.byte_length)),
    hole_number: holeNumber,
    holeNumber,
    metadata: jsonObject(uploaded && uploaded.metadata)
  };
}

function storageObjectPath(value) {
  return text(value, 420).replace(/^\/+/, "").replace(/^course-visuals\//, "");
}

function displayAssetPath(value) {
  const pathValue = text(value, 420).replace(/^\/+/, "");
  return /^course-visuals\//.test(pathValue) ? pathValue : "course-visuals/" + storageObjectPath(pathValue);
}

function publicStorageUrl(objectPath) {
  const base = supabaseBase();
  const clean = storageObjectPath(objectPath);
  if (!base || !clean) return "";
  return base + "/storage/v1/object/public/" + BUCKET + "/" + clean.split("/").map(encodeURIComponent).join("/");
}

function isAdminActor(actor) {
  const email = String(actor && actor.email || "").trim().toLowerCase();
  const role = String(actor && actor.role || "").trim().toLowerCase();
  return role === "admin" && ADMIN_EMAILS.has(email);
}

function json(statusCode, body) {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept",
    },
  });
}

function text(value, limit) {
  const out = String(value || "").trim();
  return limit && out.length > limit ? out.slice(0, limit) : out;
}

function integer(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function sanitizeAsset(input) {
  if (!input || typeof input !== "object") return null;
  const pathValue = text(input.path, 420).replace(/^\/+/, "");
  const contentType = text(input.contentType || input.content_type, 80) || "image/svg+xml";
  const dataUrl = text(input.dataUrl || input.data_url, 5_000_000);
  if (!pathValue || !dataUrl.startsWith("data:")) return null;
  if (!/^course-visuals\//.test(pathValue)) return null;
  if (!/^image\/(svg\+xml|png|webp)$/.test(contentType)) return null;
  return { path: pathValue.replace(/^course-visuals\//, ""), dataUrl, contentType, role: text(input.role, 80), holeNumber: integer(input.holeNumber ?? input.hole_number), metadata: jsonObject(input.metadata) };
}

function dataUrlToBytes(value) {
  const match = String(value || "").match(/^data:([^,]*?)(;base64)?,(.*)$/);
  if (!match) throw new Error("Invalid asset data URL");
  const payload = match[3] || "";
  if (match[2]) return Buffer.from(payload, "base64");
  return Buffer.from(decodeURIComponent(payload), "utf8");
}

function status(value) {
  const raw = text(value, 80);
  const allowed = new Set(["unavailable", "input-ready", "stitching", "basic-ready", "rendering", "preview-ready", "published", "failed"]);
  return allowed.has(raw) ? raw : "unavailable";
}

function slug(value) {
  return String(value || "course").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160);
}

function storageMessage(error) {
  if (!error) return "Unknown storage error";
  if (error.body) return typeof error.body === "string" ? error.body : JSON.stringify(error.body).slice(0, 300);
  return String(error.message || error);
}

export const __courseVisualsTest = {
  sanitizeVisual,
  visualToRow,
  rowToVisual,
  visualToPlayPayload,
  withPlayPayload,
  sanitizeAsset,
  dataUrlToBytes,
};
