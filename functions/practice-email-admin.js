"use strict";

/**
 * Practice email intake - admin read view.
 *
 * Read-only, and deliberately its own function rather than another action on
 * practice-email-intake.js. That file is the webhook: it accepts mail from
 * Resend and it writes. This one only ever reads, and only ever for an admin,
 * so the two have nothing to share but table names.
 *
 * Why it exists at all: the intake tables are RLS'd to the service role, so a
 * browser holding an anon key cannot read them however admin the person is.
 * Studio therefore cannot query Supabase directly - it has to come through a
 * function that holds the service key and checks who is asking first.
 *
 * What it answers: what arrived, and how far it got. One row per attachment,
 * plus the emails that produced no attachment at all, because "nothing landed"
 * is the case you most want to see.
 */

const { hasSupabase, json, supabaseFetch, encodeFilter } = require("./payment-utils");
const { resolveCaller } = require("./clarity-caller");

const EVENT_COLUMNS = [
  "intake_id", "created_at", "status", "sender_email", "recipient_email",
  "player_key", "subject", "sender_verified", "routing_json"
].join(",");

const BATCH_COLUMNS = [
  "import_batch_id", "intake_id", "created_at", "source_type", "source_name",
  "status", "row_count", "valid_count", "invalid_count", "provider",
  "unit_system", "session_date", "metadata"
].join(",");

function clampLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 25;
  return Math.min(200, Math.max(1, Math.floor(number)));
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

/* The batch row as Studio needs it. metadata is unpacked here rather than in
   the browser so the page is not parsing JSON shapes the server already knows,
   and so a change to what the intake stores is a one-file change. */
function batchView(row) {
  const metadata = (row && row.metadata) || {};
  return {
    importBatchId: row.import_batch_id,
    createdAt: row.created_at,
    sourceType: row.source_type,
    sourceName: row.source_name,
    status: row.status,
    rowCount: Number(row.row_count || 0),
    validCount: Number(row.valid_count || 0),
    invalidCount: Number(row.invalid_count || 0),
    provider: row.provider || "",
    unitSystem: row.unit_system || "",
    unitSource: metadata.unitSource || "",
    sessionDate: row.session_date || "",
    warnings: list(metadata.warnings),
    parseErrors: list(metadata.parseErrors),
    photoCount: list(metadata.photos).length,
    senderVerified: metadata.senderVerified !== false
  };
}

function eventView(row, batches) {
  const routing = (row && row.routing_json) || {};
  return {
    intakeId: row.intake_id,
    createdAt: row.created_at,
    status: row.status,
    from: row.sender_email || "",
    to: row.recipient_email || "",
    playerKey: row.player_key || "",
    subject: row.subject || "",
    senderVerified: row.sender_verified === true,
    errors: list(routing.errors),
    unsupportedCount: list(routing.unsupported).length,
    batches: batches
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed" });
  if (!hasSupabase()) return json(503, { configured: false, error: "Supabase is not configured" });

  let caller = null;
  try {
    caller = await resolveCaller(event);
  } catch (error) {
    return json(error.status || 401, { error: "Could not verify the caller" });
  }
  if (!caller) return json(401, { error: "Sign in to view practice email intake" });
  /* Admin only, not staff. A coach seeing every player's inbound mail is a
     different decision from a coach seeing their own players, and this view
     is not scoped per coach. */
  if (!caller.isAdmin) return json(403, { error: "Admin permission required" });

  const params = event.queryStringParameters || {};
  const limit = clampLimit(params.limit);

  try {
    const events = list(await supabaseFetch(
      "practice_email_intake_events?select=" + EVENT_COLUMNS
      + "&order=created_at.desc&limit=" + limit,
      { method: "GET" }
    ));

    /* Batches are fetched for exactly the events on this page. Fetching the
       last N batches instead would silently drop the batches of an event that
       produced several attachments. */
    const intakeIds = events.map(function (row) { return row.intake_id; }).filter(Boolean);
    let batches = [];
    if (intakeIds.length) {
      const inList = intakeIds.map(function (id) { return '"' + encodeFilter(id) + '"'; }).join(",");
      batches = list(await supabaseFetch(
        "practice_import_batches?select=" + BATCH_COLUMNS
        + "&intake_id=in.(" + inList + ")&order=created_at.asc",
        { method: "GET" }
      ));
    }

    const byIntake = {};
    batches.forEach(function (row) {
      const key = row.intake_id;
      if (!key) return;
      (byIntake[key] = byIntake[key] || []).push(batchView(row));
    });

    const addresses = list(await supabaseFetch(
      "practice_email_addresses?select=address,local_part,player_key,active,created_at"
      + "&order=created_at.desc&limit=200",
      { method: "GET" }
    ));

    const senders = list(await supabaseFetch(
      "practice_email_senders?select=player_key,sender_email,source,verified_at"
      + "&order=verified_at.desc&limit=200",
      { method: "GET" }
    ));

    return json(200, {
      configured: true,
      checkedAt: new Date().toISOString(),
      limit: limit,
      intakes: events.map(function (row) { return eventView(row, byIntake[row.intake_id] || []); }),
      addresses: addresses.map(function (row) {
        return {
          address: row.address,
          localPart: row.local_part,
          playerKey: row.player_key,
          active: row.active !== false,
          createdAt: row.created_at,
          senders: senders
            .filter(function (sender) { return sender.player_key === row.player_key; })
            .map(function (sender) {
              return { email: sender.sender_email, source: sender.source, verifiedAt: sender.verified_at };
            })
        };
      })
    });
  } catch (error) {
    return json(error.status || 502, {
      error: "Could not read practice email intake",
      details: error.body || error.message || String(error)
    });
  }
};

/* Exported for dev/practice-email-admin.test.js. The handler itself needs
   Supabase and a signed-in admin, so the pieces worth pinning are the shaping
   functions and the limit clamp. */
exports.__testables = { batchView, eventView, clampLimit };
