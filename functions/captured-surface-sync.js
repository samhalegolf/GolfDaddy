"use strict";

// Clarity Captured Surface sync endpoint.
// Backs up captured hole surface scans (tile-capture manifests + pins +
// projection data) to Supabase. The browser registry stays the working copy;
// this endpoint gives the scans a cloud home so they survive cleared browsers
// and are visible for diagnostics.
//
// Actions:
//   push_scans: upsert scans (last write wins per scan, based on
//               client_updated_at; stale pushes are skipped, not overwritten).
//   pull:       return scans for a course or account scope.

const {
  encodeFilter,
  hasSupabase,
  json,
  supabaseFetch,
  text
} = require("./payment-utils");

const TABLE = "captured_surfaces";
const MAX_SCANS_PER_PUSH = 20;

function toIso(value, fallback) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : (fallback || new Date().toISOString());
}

function jsonObject(value) {
  return value && typeof value === "object" ? value : {};
}

function normaliseScan(row, payload) {
  const clientScanId = text(row.client_scan_id || row.clientScanId || row.id, 200);
  if (!clientScanId) return null;
  return {
    client_scan_id: clientScanId,
    account_id: text(row.account_id || row.accountId || payload.accountId, 120) || null,
    player_id: text(row.player_id || row.playerId || payload.playerId, 120) || null,
    course_key: text(row.course_key || row.courseKey, 120) || "course",
    course_name: text(row.course_name || row.courseName, 160) || null,
    hole_number: Math.max(1, Math.round(Number(row.hole_number || row.holeNumber) || 1)),
    source_type: text(row.source_type || (row.source && row.source.type), 80) || null,
    status_json: jsonObject(row.status),
    interaction_json: jsonObject(row.interaction),
    projection_json: jsonObject(row.projection),
    pins_json: jsonObject(row.pins),
    manifest_json: jsonObject(row.manifest),
    client_created_at: row.created_at || row.createdAt ? toIso(row.created_at || row.createdAt) : null,
    client_updated_at: toIso(row.updated_at || row.updatedAt || row.clientUpdatedAt),
    updated_at: new Date().toISOString()
  };
}

async function pushScans(payload) {
  const incoming = (Array.isArray(payload.scans) ? payload.scans : [])
    .slice(0, MAX_SCANS_PER_PUSH)
    .map((row) => normaliseScan(row, payload))
    .filter(Boolean);
  if (!incoming.length) return { synced: true, upserted: 0, skipped: 0, serverTime: new Date().toISOString() };

  const ids = incoming.map((row) => row.client_scan_id);
  const existing = await supabaseFetch(
    TABLE + "?select=client_scan_id,client_updated_at&client_scan_id=in.(" +
      ids.map((id) => '"' + String(id).replace(/"/g, "") + '"').join(",") + ")",
    { method: "GET" }
  );
  const existingTimes = {};
  (Array.isArray(existing) ? existing : []).forEach((row) => {
    existingTimes[row.client_scan_id] = Date.parse(row.client_updated_at || "") || 0;
  });

  const fresh = incoming.filter((row) => {
    const known = existingTimes[row.client_scan_id];
    if (!known) return true;
    return Date.parse(row.client_updated_at) >= known;
  });

  if (fresh.length) {
    await supabaseFetch(TABLE + "?on_conflict=client_scan_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(fresh)
    });
  }

  return {
    synced: true,
    upserted: fresh.length,
    skipped: incoming.length - fresh.length,
    serverTime: new Date().toISOString()
  };
}

function scopeFilter(payload) {
  const courseKey = text(payload.courseKey, 120);
  const accountId = text(payload.accountId, 120);
  if (courseKey) {
    let base = TABLE + "?course_key=eq." + encodeFilter(courseKey);
    const hole = Math.round(Number(payload.holeNumber));
    if (Number.isFinite(hole) && hole > 0) base += "&hole_number=eq." + hole;
    return base;
  }
  if (accountId) return TABLE + "?account_id=eq." + encodeFilter(accountId);
  return "";
}

async function pull(payload) {
  const base = scopeFilter(payload);
  if (!base) return { synced: false, error: "Missing course or account scope" };
  let path = base +
    "&select=client_scan_id,account_id,player_id,course_key,course_name,hole_number,source_type,status_json,interaction_json,projection_json,pins_json,manifest_json,client_created_at,client_updated_at,updated_at" +
    "&order=updated_at.desc&limit=200";
  const since = Date.parse(String(payload.since || ""));
  if (Number.isFinite(since)) {
    path += "&updated_at=gt." + encodeFilter(new Date(since).toISOString());
  }
  const rows = await supabaseFetch(path, { method: "GET" });
  return {
    synced: true,
    scans: (Array.isArray(rows) ? rows : []).map((row) => ({
      client_scan_id: row.client_scan_id,
      account_id: row.account_id || "",
      player_id: row.player_id || "",
      course_key: row.course_key || "",
      course_name: row.course_name || "",
      hole_number: row.hole_number || 1,
      source_type: row.source_type || "",
      status: row.status_json || {},
      interaction: row.interaction_json || {},
      projection: row.projection_json || {},
      pins: row.pins_json || {},
      manifest: row.manifest_json || {},
      created_at: row.client_created_at || "",
      updated_at: row.client_updated_at || ""
    })),
    serverTime: new Date().toISOString()
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed", synced: false });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { error: "Invalid JSON", synced: false });
  }

  if (!hasSupabase()) {
    return json(503, { configured: false, synced: false, error: "Supabase is not configured. Captured surfaces were not synced." });
  }

  const action = text(payload.action || "", 40);
  try {
    if (action === "push_scans") return json(200, await pushScans(payload));
    if (action === "pull") return json(200, await pull(payload));
    return json(400, { error: "Unsupported captured surface sync action", synced: false });
  } catch (error) {
    return json(error.status || 502, {
      configured: true,
      synced: false,
      error: "Captured surface sync failed",
      details: error.body || error.message || String(error)
    });
  }
};
