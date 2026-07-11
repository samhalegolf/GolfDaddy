"use strict";

// Clarity Shot Library sync endpoint.
// Supabase is the source of truth for practice shot library data; the browser
// keeps a localStorage cache so graphs render instantly and stay steady.
//
// Actions:
//   push_batches: upsert import batches (last write wins per batch, based on
//                 clientUpdatedAt; stale pushes are skipped, not overwritten).
//   pull:         return all batches for a player scope (optionally only rows
//                 changed since a given timestamp).

const {
  encodeFilter,
  hasSupabase,
  json,
  supabaseFetch,
  text
} = require("./payment-utils");

const TABLE = "shot_library_batches";
const MAX_BATCHES_PER_PUSH = 40;

function toIso(value, fallback) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : (fallback || new Date().toISOString());
}

function scopeFilter(payload) {
  const playerId = text(payload.playerId, 120);
  const accountId = text(payload.accountId, 120);
  if (playerId) return TABLE + "?player_id=eq." + encodeFilter(playerId);
  if (accountId) return TABLE + "?account_id=eq." + encodeFilter(accountId);
  return "";
}

function normaliseBatch(row, payload) {
  const importBatchId = text(row.importBatchId || row.import_batch_id, 160);
  if (!importBatchId) return null;
  const status = String(row.status || "active").toLowerCase() === "deleted" ? "deleted" : "active";
  const batchPayload = row.payload && typeof row.payload === "object" ? row.payload : {};
  const shots = Array.isArray(batchPayload.shots) ? batchPayload.shots : [];
  return {
    import_batch_id: importBatchId,
    account_id: text(row.accountId || payload.accountId, 120) || null,
    player_id: text(row.playerId || payload.playerId, 120) || null,
    player_name: text(row.playerName || payload.playerName, 160) || null,
    status,
    payload_json: batchPayload,
    shot_count: shots.length,
    client_updated_at: toIso(row.clientUpdatedAt),
    deleted_at: status === "deleted" ? toIso(row.deletedAt) : null,
    deleted_by: status === "deleted" ? (text(row.deletedBy, 120) || null) : null,
    updated_at: new Date().toISOString()
  };
}

async function pushBatches(payload) {
  const incoming = (Array.isArray(payload.batches) ? payload.batches : [])
    .slice(0, MAX_BATCHES_PER_PUSH)
    .map((row) => normaliseBatch(row, payload))
    .filter(Boolean);
  if (!incoming.length) return { synced: true, upserted: 0, skipped: 0 };

  const ids = incoming.map((row) => row.import_batch_id);
  const existing = await supabaseFetch(
    TABLE + "?select=import_batch_id,client_updated_at&import_batch_id=in.(" +
      ids.map((id) => '"' + String(id).replace(/"/g, "") + '"').join(",") + ")",
    { method: "GET" }
  );
  const existingTimes = {};
  (Array.isArray(existing) ? existing : []).forEach((row) => {
    existingTimes[row.import_batch_id] = Date.parse(row.client_updated_at || "") || 0;
  });

  const fresh = incoming.filter((row) => {
    const known = existingTimes[row.import_batch_id];
    if (!known) return true;
    return Date.parse(row.client_updated_at) >= known;
  });

  if (fresh.length) {
    await supabaseFetch(TABLE + "?on_conflict=import_batch_id", {
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

async function pull(payload) {
  const base = scopeFilter(payload);
  if (!base) return { synced: false, error: "Missing player scope" };
  let path = base +
    "&select=import_batch_id,account_id,player_id,player_name,status,payload_json,client_updated_at,deleted_at,deleted_by,updated_at" +
    "&order=updated_at.desc&limit=500";
  const since = Date.parse(String(payload.since || ""));
  if (Number.isFinite(since)) {
    path += "&updated_at=gt." + encodeFilter(new Date(since).toISOString());
  }
  const rows = await supabaseFetch(path, { method: "GET" });
  return {
    synced: true,
    batches: (Array.isArray(rows) ? rows : []).map((row) => ({
      importBatchId: row.import_batch_id,
      accountId: row.account_id || "",
      playerId: row.player_id || "",
      playerName: row.player_name || "",
      status: row.status || "active",
      payload: row.payload_json || {},
      clientUpdatedAt: row.client_updated_at || "",
      deletedAt: row.deleted_at || "",
      deletedBy: row.deleted_by || ""
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
    return json(503, { configured: false, synced: false, error: "Supabase is not configured. Shot library was not synced." });
  }

  const action = text(payload.action || "", 40);
  try {
    if (action === "push_batches") return json(200, await pushBatches(payload));
    if (action === "pull") return json(200, await pull(payload));
    return json(400, { error: "Unsupported shot library sync action", synced: false });
  } catch (error) {
    return json(error.status || 502, {
      configured: true,
      synced: false,
      error: "Shot library sync failed",
      details: error.body || error.message || String(error)
    });
  }
};
