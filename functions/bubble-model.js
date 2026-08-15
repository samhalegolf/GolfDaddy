"use strict";

/**
 * Bubble player model + geometry configuration endpoint.
 *
 * This is the server side of the boundary the job spec draws:
 *
 *     Server decides the player model. App applies and renders the model.
 *
 * The modelling itself is not here. It lives in
 * scripts/gd-bubble-signals-core.js, which the browser also loads, for exactly
 * the reason the practice parser lives in one file: the phone previews what
 * the server decided, and two copies of that opinion would drift. This file
 * supplies the parts that are genuinely server-only - who is asking, where the
 * shots are, and where the answer is kept.
 *
 * The core is outside functions/, so netlify.toml pins it via
 * [functions] included_files, same as the parser core.
 *
 * ---------------------------------------------------------------------------
 * NO LOADING BARS
 *
 * Analysis runs when the DATA CHANGES, not when a screen opens:
 *
 *     new practice data saved -> POST analyse -> model persisted
 *     screen opens            -> GET  model   -> last good model, immediately
 *
 * GET therefore never analyses. If the library has moved on since the model
 * was built, GET says so with `stale: true` and still returns the last good
 * model, so the caller can render now and refresh quietly. A screen that
 * cannot show a bubble until an analysis finishes is the thing this shape
 * exists to prevent.
 *
 * ---------------------------------------------------------------------------
 * ACTIONS
 *
 *   GET  ?playerId=            last good model for that player (compact)
 *   GET  ?playerId=&full=1     ...plus detection diagnostics (staff only)
 *   GET  ?config=1             the active geometry config (staff only)
 *   GET  ?configs=1            config version history (admin only)
 *   POST {action:"analyse"}    rebuild and persist one player's model
 *   POST {action:"preview"}    run the engine on supplied rows, persist nothing
 *   POST {action:"publish"}    publish a new geometry config version (admin)
 */

const { hasSupabase, json, supabaseFetch, encodeFilter, text } = require("./payment-utils");
const { resolveCaller } = require("./clarity-caller");
const signals = require("../scripts/gd-bubble-signals-core.js");

const MODEL_TABLE = "bubble_player_models";
const CONFIG_TABLE = "bubble_geometry_configs";
const LIBRARY_TABLE = "shot_library_batches";

/* A player with more history than this does not get a better model from the
   extra rows, and pulling all of it makes the analysis a slow request instead
   of a quick one. Newest batches win. */
const MAX_BATCHES = 60;
const MAX_ROWS = 3000;

function list(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso() {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------------
   Config
   ------------------------------------------------------------------------ */

async function activeConfigRow() {
  const rows = list(await supabaseFetch(
    CONFIG_TABLE + "?select=id,version,config_version,model_version,label,note,config_json,created_at"
    + "&active=is.true&limit=1",
    { method: "GET" }
  ));
  return rows[0] || null;
}

/* The engine's own defaults are the fallback, and they are the identity
   config - every Signal off. A database that has not been migrated yet
   therefore renders exactly today's bubble rather than nothing at all. */
async function resolveActiveConfig() {
  let row = null;
  try {
    row = await activeConfigRow();
  } catch (error) {
    row = null;
  }
  const config = signals.resolveConfig(row ? row.config_json : null);
  return {
    row,
    config,
    version: row ? Number(row.version) : 0,
    id: row ? row.id : null
  };
}

/* ------------------------------------------------------------------------
   Shots

   Read from the shot library the player already syncs, rather than asking the
   phone to upload its rows a second time. "New practice data saved" and "the
   server has the shots" are then the same event.
   ------------------------------------------------------------------------ */

async function loadPlayerRows(playerId, accountId) {
  const filter = playerId
    ? "player_id=eq." + encodeFilter(playerId)
    : "account_id=eq." + encodeFilter(accountId);
  const batches = list(await supabaseFetch(
    LIBRARY_TABLE + "?select=import_batch_id,payload_json,client_updated_at,updated_at"
    + "&" + filter + "&status=eq.active&order=client_updated_at.desc&limit=" + MAX_BATCHES,
    { method: "GET" }
  ));

  const rows = [];
  let latestAt = null;
  batches.forEach((batch) => {
    const stamp = batch.client_updated_at || batch.updated_at;
    if (stamp && (!latestAt || Date.parse(stamp) > Date.parse(latestAt))) latestAt = stamp;
    const payload = (batch && batch.payload_json) || {};
    list(payload.shots).forEach((shot) => {
      if (rows.length < MAX_ROWS) rows.push(shot);
    });
  });

  return { rows, batchCount: batches.length, latestAt };
}

/* ------------------------------------------------------------------------
   Model
   ------------------------------------------------------------------------ */

function modelRowView(row, options) {
  const full = !!(options && options.full);
  if (!row) return null;
  const view = {
    playerId: row.player_id,
    status: row.status,
    analysedAt: row.analysed_at,
    sourceShots: Number(row.source_shots || 0),
    sourceBatches: Number(row.source_batches || 0),
    sourceLatestAt: row.source_latest_at,
    geometryConfigVersion: Number(row.config_version || 0),
    model: row.model_json || null,
    error: row.error || ""
  };
  if (full) view.diagnostics = row.diagnostics_json || null;
  return view;
}

async function loadModelRow(playerId) {
  const rows = list(await supabaseFetch(
    MODEL_TABLE + "?select=*&player_id=eq." + encodeFilter(playerId) + "&limit=1",
    { method: "GET" }
  ));
  return rows[0] || null;
}

/* Runs the shared engine. Everything modelling-shaped in here is a call into
   the core - this function only decides what to feed it and what to keep. */
function buildModel(rows, activeConfig, input) {
  const model = signals.buildPlayerModel({
    rows,
    config: activeConfig.config,
    offsetDeg: input.offsetDeg,
    handedness: input.handedness,
    expectedLateralSpreadDeg: input.expectedLateralSpreadDeg,
    generatedAt: nowIso()
  });
  return {
    full: model,
    compact: signals.compactModel(model)
  };
}

async function analysePlayer(caller, payload) {
  const playerId = text(payload.playerId, 120);
  const accountId = text(payload.accountId, 120) || (caller.account && caller.account.account_id) || "";
  if (!playerId) return json(400, { error: "playerId is required" });

  /* A player may rebuild their own model; staff may rebuild anyone's. Nobody
     else gets to trigger analysis for an id they picked. */
  if (!caller.isStaff && !callerOwnsPlayer(caller, playerId, accountId)) {
    return json(403, { error: "Not your player model" });
  }

  const activeConfig = await resolveActiveConfig();

  let loaded;
  try {
    loaded = await loadPlayerRows(playerId, accountId);
  } catch (error) {
    return json(502, { error: "Could not read the shot library" });
  }

  /* Explicit rows win, so Studio can analyse generated data through the very
     same path a real player's data takes. */
  const rows = Array.isArray(payload.rows) && payload.rows.length ? payload.rows : loaded.rows;

  let built;
  try {
    built = buildModel(rows, activeConfig, payload);
  } catch (error) {
    await writeModelRow({
      playerId, accountId, activeConfig,
      status: "failed", error: String((error && error.message) || error).slice(0, 400),
      sourceShots: rows.length, sourceBatches: loaded.batchCount, sourceLatestAt: loaded.latestAt,
      model: null, diagnostics: null
    });
    return json(500, { error: "Analysis failed" });
  }

  await writeModelRow({
    playerId, accountId, activeConfig,
    status: "ready", error: "",
    sourceShots: rows.length, sourceBatches: loaded.batchCount, sourceLatestAt: loaded.latestAt,
    model: built.compact,
    diagnostics: { detected: built.full.detected, projection: built.full.projection }
  });

  return json(200, {
    ok: true,
    playerId,
    model: built.compact,
    geometryConfigVersion: activeConfig.version,
    sourceShots: rows.length,
    sourceBatches: loaded.batchCount,
    detected: caller.isStaff ? built.full.detected : undefined
  });
}

function callerOwnsPlayer(caller, playerId, accountId) {
  const account = caller.account || {};
  const own = String(account.account_id || "");
  if (own && accountId && own === accountId) return true;
  if (own && own === playerId) return true;
  return false;
}

async function writeModelRow(input) {
  const row = {
    player_id: input.playerId,
    account_id: input.accountId || null,
    model_version: signals.MODEL_VERSION,
    config_version: input.activeConfig.version,
    geometry_config_id: input.activeConfig.id,
    model_json: input.model || {},
    diagnostics_json: input.diagnostics || {},
    source_shots: input.sourceShots,
    source_batches: input.sourceBatches,
    source_latest_at: input.sourceLatestAt || null,
    status: input.status,
    error: input.error || null,
    analysed_at: nowIso(),
    updated_at: nowIso()
  };
  await supabaseFetch(MODEL_TABLE + "?on_conflict=player_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([row])
  });
}

/* ------------------------------------------------------------------------
   GET
   ------------------------------------------------------------------------ */

async function readModel(caller, params) {
  const playerId = text(params.playerId, 120);
  if (!playerId) return json(400, { error: "playerId is required" });
  const accountId = text(params.accountId, 120) || (caller.account && caller.account.account_id) || "";
  if (!caller.isStaff && !callerOwnsPlayer(caller, playerId, accountId)) {
    return json(403, { error: "Not your player model" });
  }

  const row = await loadModelRow(playerId);
  if (!row) {
    /* Not an error. A player with no analysis yet renders the plain bubble,
       which is exactly what an identity model would have told them to do. */
    return json(200, { playerId, model: null, stale: false, neverAnalysed: true });
  }

  /* Staleness is answered from stored numbers, never by re-analysing on a
     read. The caller renders the model it just got and asks for a rebuild in
     the background if it wants one. */
  let stale = false;
  let libraryLatestAt = null;
  try {
    const latest = list(await supabaseFetch(
      LIBRARY_TABLE + "?select=client_updated_at&player_id=eq." + encodeFilter(playerId)
      + "&status=eq.active&order=client_updated_at.desc&limit=1",
      { method: "GET" }
    ));
    libraryLatestAt = latest[0] ? latest[0].client_updated_at : null;
    if (libraryLatestAt && row.source_latest_at) {
      stale = Date.parse(libraryLatestAt) > Date.parse(row.source_latest_at);
    } else if (libraryLatestAt && !row.source_latest_at) {
      stale = true;
    }
  } catch (error) {
    /* Could not check - say not stale rather than blocking on it. */
    stale = false;
  }

  const activeConfig = await resolveActiveConfig();
  if (activeConfig.version && Number(row.config_version) !== activeConfig.version) stale = true;

  const view = modelRowView(row, { full: caller.isStaff && String(params.full || "") === "1" });
  return json(200, Object.assign({ stale, libraryLatestAt, activeConfigVersion: activeConfig.version }, view));
}

async function readConfig(caller, params) {
  if (!caller.isStaff) return json(403, { error: "Staff permission required" });
  if (String(params.configs || "") === "1") {
    if (!caller.isAdmin) return json(403, { error: "Admin permission required" });
    const rows = list(await supabaseFetch(
      CONFIG_TABLE + "?select=id,version,label,note,active,published_by,created_at&order=version.desc&limit=50",
      { method: "GET" }
    ));
    return json(200, { versions: rows });
  }
  const active = await resolveActiveConfig();
  return json(200, {
    version: active.version,
    label: active.row ? active.row.label : "engine defaults",
    note: active.row ? active.row.note : "No published config found - the engine's own defaults are in use, which disable every Signal.",
    config: active.config,
    defaults: signals.defaultConfig()
  });
}

/* ------------------------------------------------------------------------
   Publish
   ------------------------------------------------------------------------ */

async function publishConfig(caller, payload) {
  if (!caller.isAdmin) return json(403, { error: "Admin permission required" });
  if (!payload.config || typeof payload.config !== "object") return json(400, { error: "config is required" });

  /* Resolved through the core before it is stored, so a config published from
     Studio can never contain a key the engine does not read, and can never be
     missing one it does. */
  const config = signals.resolveConfig(payload.config);

  const latest = list(await supabaseFetch(
    CONFIG_TABLE + "?select=version&order=version.desc&limit=1",
    { method: "GET" }
  ));
  const version = (latest[0] ? Number(latest[0].version) : 0) + 1;

  /* Stand the old one down FIRST. bubble_geometry_configs has a partial unique
     index on active, so inserting a second active row would be rejected - and
     rightly, because two active configs mean two different bubbles depending
     on which row a query happened to see. */
  await supabaseFetch(CONFIG_TABLE + "?active=is.true", {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ active: false, updated_at: nowIso() })
  });

  await supabaseFetch(CONFIG_TABLE, {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify([{
      version,
      config_version: signals.CONFIG_VERSION,
      model_version: signals.MODEL_VERSION,
      active: true,
      label: text(payload.label, 160) || ("Config " + version),
      note: text(payload.note, 2000) || null,
      config_json: config,
      published_by: (caller.account && caller.account.account_id) || "unknown"
    }])
  });

  /* Every stored model was built under the config that just stopped being
     active. Mark them stale rather than rebuilding thousands of them inside
     one request: each player's next GET reports stale, their next analyse
     rebuilds, and nobody waits on a screen in the meantime. */
  await supabaseFetch(MODEL_TABLE + "?status=eq.ready", {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "stale", updated_at: nowIso() })
  });

  return json(200, { ok: true, version, config });
}

/* Runs the engine on supplied rows and stores nothing. This is what the Studio
   visualiser uses: real pipeline, real detector, no side effects on a real
   player's saved model. */
function previewModel(caller, payload, activeConfig) {
  if (!caller.isStaff) return json(403, { error: "Staff permission required" });
  const rows = list(payload.rows);
  if (!rows.length) return json(400, { error: "rows are required" });
  /* An explicit config in the request overrides the published one, so Studio
     can try a change before publishing it. */
  const config = payload.config ? signals.resolveConfig(payload.config) : activeConfig.config;
  const model = signals.buildPlayerModel({
    rows,
    config,
    offsetDeg: payload.offsetDeg,
    handedness: payload.handedness,
    expectedLateralSpreadDeg: payload.expectedLateralSpreadDeg,
    generatedAt: nowIso()
  });
  return json(200, {
    ok: true,
    preview: true,
    model: signals.compactModel(model),
    detected: model.detected,
    projection: model.projection,
    configVersion: payload.config ? "unpublished" : activeConfig.version
  });
}

/* ------------------------------------------------------------------------
   Handler
   ------------------------------------------------------------------------ */

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (!hasSupabase()) return json(503, { configured: false, error: "Supabase is not configured" });

  let caller = null;
  try {
    caller = await resolveCaller(event);
  } catch (error) {
    return json(error.status || 401, { error: "Could not verify the caller" });
  }
  if (!caller) return json(401, { error: "Sign in to read a bubble model" });

  const params = event.queryStringParameters || {};

  try {
    if (event.httpMethod === "GET") {
      if (String(params.config || "") === "1" || String(params.configs || "") === "1") {
        return await readConfig(caller, params);
      }
      return await readModel(caller, params);
    }

    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

    let payload = {};
    try {
      payload = JSON.parse(event.body || "{}") || {};
    } catch (error) {
      return json(400, { error: "Body must be JSON" });
    }

    const action = String(payload.action || "analyse").toLowerCase();
    if (action === "analyse" || action === "analyze") return await analysePlayer(caller, payload);
    if (action === "preview") return previewModel(caller, payload, await resolveActiveConfig());
    if (action === "publish" || action === "publish_config") return await publishConfig(caller, payload);
    return json(400, { error: "Unknown action" });
  } catch (error) {
    return json(500, { error: "Bubble model request failed" });
  }
};
