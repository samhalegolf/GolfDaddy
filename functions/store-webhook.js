"use strict";

/* RevenueCat webhook: the single write path for Google Play and App Store billing.
 *
 * RevenueCat verifies receipts with Apple and Google and normalises both stores
 * into one event stream, so this function never talks to either store directly.
 * Every event carries the already-validated expiry, which is what we persist.
 *
 * Store purchases are written to user_entitlements, not caddie_memberships: the
 * entitlement read path in payment-utils is already source-agnostic, while
 * caddie_memberships is driven entirely by Stripe webhooks.
 *
 * A renewing subscription is ONE row, keyed on the store transaction id, whose
 * expires_at is pushed forward on each RENEWAL. Idempotency is therefore twofold:
 * store_webhook_events rejects replayed event ids, and the unique index on
 * store_transaction_id keeps concurrent deliveries from forking a second row.
 */

const crypto = require("crypto");
const {
  STORE_MEMBERSHIP_KEY,
  STORE_MONTH_PASS_KEY,
  email,
  encodeFilter,
  env,
  hasSupabase,
  json,
  supabaseFetch,
  text
} = require("./payment-utils");
const { sendSystemAlert } = require("./alert-utils");

/* Events that grant or extend access. Everything else is recorded and ignored:
   we never revoke early. If a user cancels, the store keeps them entitled until
   the period they already paid for runs out, and EXPIRATION lands then. */
const GRANTING_EVENTS = {
  INITIAL_PURCHASE: true,
  RENEWAL: true,
  UNCANCELLATION: true,
  PRODUCT_CHANGE: true,
  NON_RENEWING_PURCHASE: true,
  SUBSCRIPTION_EXTENDED: true
};

/* Events that end access immediately. CANCELLATION is deliberately absent - it
   means "will not renew", not "access ends now". */
const REVOKING_EVENTS = {
  EXPIRATION: true,
  REFUND: true
};

const STORE_MAP = {
  PLAY_STORE: "play",
  APP_STORE: "app_store",
  MAC_APP_STORE: "app_store",
  AMAZON: "amazon",
  STRIPE: "stripe",
  PROMOTIONAL: "promotional"
};

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const expected = env("REVENUECAT_WEBHOOK_AUTH");
  if (!expected) {
    /* Fail closed. An unauthenticated endpoint that writes entitlements would let
       anyone grant themselves paid access. */
    await sendSystemAlert({
      eventType: "store_webhook_not_configured",
      title: "Store webhook rejected: REVENUECAT_WEBHOOK_AUTH is not set",
      detail: "A RevenueCat webhook arrived but the shared secret is not configured, so it could not be authenticated. Store purchases are not being recorded.",
      context: { endpoint: "store-webhook" }
    });
    return json(503, { error: "Store billing is not configured" });
  }

  const headers = event.headers || {};
  const provided = headers.authorization || headers.Authorization || "";
  if (!safeEqual(provided, expected)) {
    return json(401, { error: "Unauthorized" });
  }

  if (!hasSupabase()) {
    await sendSystemAlert({
      eventType: "supabase_not_configured",
      title: "Store webhook could not reach Supabase",
      detail: "A verified RevenueCat event could not be recorded because Supabase environment variables are missing. The purchase is paid for but access was not granted.",
      context: { endpoint: "store-webhook" }
    });
    return json(503, { error: "Payment storage is not configured" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_error) {
    return json(400, { error: "Invalid JSON" });
  }

  const rcEvent = body && body.event;
  if (!rcEvent || !rcEvent.id || !rcEvent.type) {
    return json(400, { error: "Missing event" });
  }

  /* Ack test pings without touching entitlements. */
  if (rcEvent.type === "TEST") {
    return json(200, { received: true, test: true });
  }

  const claim = await claimEvent(rcEvent);
  if (claim.duplicate) return json(200, { received: true, duplicate: true });

  try {
    const outcome = await processEvent(rcEvent);
    await settleEvent(rcEvent.id, "processed", null);
    return json(200, Object.assign({ received: true }, outcome));
  } catch (error) {
    const message = error && (error.message || String(error));
    await settleEvent(rcEvent.id, "failed", message);
    await sendSystemAlert({
      eventType: "store_webhook_failed",
      title: "Store purchase could not be recorded",
      detail: "A verified RevenueCat event failed to process. The user may have paid without receiving access. Check store_webhook_events.",
      context: { eventId: rcEvent.id, eventType: rcEvent.type, appUserId: rcEvent.app_user_id || null, error: message }
    });
    /* 500 so RevenueCat retries. The event row is left 'failed' and the retry
       reclaims it, so a transient Supabase blip self-heals. */
    return json(500, { error: "Could not record store purchase" });
  }
};

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  /* timingSafeEqual throws on length mismatch, so compare a digest of each -
     equal length, and still constant time. */
  const leftHash = crypto.createHash("sha256").update(left).digest();
  const rightHash = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

async function claimEvent(rcEvent) {
  const eventAt = msToIso(rcEvent.event_timestamp_ms);
  await supabaseFetch("store_webhook_events?on_conflict=store_event_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({
      store_event_id: text(rcEvent.id, 200),
      event_type: text(rcEvent.type, 80),
      store: STORE_MAP[rcEvent.store] || null,
      app_user_id: text(rcEvent.app_user_id, 200) || null,
      store_event_at: eventAt,
      processing_status: "processing",
      payload_json: rcEvent
    })
  });

  const rows = await supabaseFetch(
    "store_webhook_events?select=*&store_event_id=eq." + encodeFilter(rcEvent.id) + "&limit=1",
    { method: "GET" }
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (row && row.processing_status === "processed") return { duplicate: true, row };
  return { duplicate: false, row };
}

async function settleEvent(eventId, status, errorMessage) {
  await supabaseFetch("store_webhook_events?store_event_id=eq." + encodeFilter(eventId), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      processing_status: status,
      error_message: errorMessage || null,
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
  });
}

async function processEvent(rcEvent) {
  if (REVOKING_EVENTS[rcEvent.type]) return revokeAccess(rcEvent);
  if (GRANTING_EVENTS[rcEvent.type]) return grantAccess(rcEvent);
  return { handled: false, reason: "event type not actionable" };
}

/* RevenueCat's app_user_id is set to our account_id by the client at login.
   Falling back to the aliases and the subscriber email covers anonymous purchases
   that are later linked to an account. */
async function resolveSubject(rcEvent) {
  const candidates = [];
  const primary = text(rcEvent.app_user_id, 200);
  if (primary) candidates.push(primary);
  if (Array.isArray(rcEvent.aliases)) {
    rcEvent.aliases.forEach(function (alias) {
      const clean = text(alias, 200);
      if (clean && candidates.indexOf(clean) === -1) candidates.push(clean);
    });
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const rows = await supabaseFetch(
      "app_accounts?select=account_id,email&account_id=eq." + encodeFilter(candidates[i]) + "&limit=1",
      { method: "GET" }
    );
    const account = Array.isArray(rows) ? rows[0] : null;
    if (account && account.account_id) {
      return { userId: account.account_id, accountEmail: account.email || null, appUserId: primary };
    }
  }

  const subscriberEmail = email(rcEvent.subscriber_attributes
    && rcEvent.subscriber_attributes.$email
    && rcEvent.subscriber_attributes.$email.value);
  if (subscriberEmail) {
    const rows = await supabaseFetch(
      "app_accounts?select=account_id,email&email=eq." + encodeFilter(subscriberEmail) + "&limit=1",
      { method: "GET" }
    );
    const account = Array.isArray(rows) ? rows[0] : null;
    if (account && account.account_id) {
      return { userId: account.account_id, accountEmail: account.email || null, appUserId: primary };
    }
    /* Known buyer, unknown account. Record against the email so the entitlement is
       picked up when they finish signing up - readPaidAccess matches on email too. */
    return { userId: null, accountEmail: subscriberEmail, appUserId: primary };
  }

  throw new Error("Could not resolve a Caddy account for store purchase");
}

function productKeyFor(rcEvent) {
  const period = String(rcEvent.period_type || "").toUpperCase();
  if (rcEvent.type === "NON_RENEWING_PURCHASE") return STORE_MONTH_PASS_KEY;
  /* TRIAL and INTRO still grant membership access; they are simply cheaper periods. */
  if (period === "NORMAL" || period === "TRIAL" || period === "INTRO" || !period) return STORE_MEMBERSHIP_KEY;
  return STORE_MEMBERSHIP_KEY;
}

async function grantAccess(rcEvent) {
  const subject = await resolveSubject(rcEvent);
  const transactionId = storeTransactionId(rcEvent);
  if (!transactionId) throw new Error("Store event has no transaction id");

  const productKey = productKeyFor(rcEvent);
  const startsAt = msToIso(rcEvent.purchased_at_ms) || new Date().toISOString();
  /* Non-renewing purchases carry no expiration, so derive one from the product's
     30-day window. Subscriptions always carry a store-validated expiry, and it
     already includes any grace period RevenueCat has applied. */
  const expiresAt = msToIso(rcEvent.expiration_at_ms)
    || (productKey === STORE_MONTH_PASS_KEY
      ? new Date(new Date(startsAt).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
      : null);
  if (!expiresAt) throw new Error("Store event has no expiry to grant against");

  const existing = await supabaseFetch(
    "user_entitlements?select=id,expires_at&store_transaction_id=eq." + encodeFilter(transactionId) + "&limit=1",
    { method: "GET" }
  );
  const row = Array.isArray(existing) ? existing[0] : null;

  const payload = {
    user_id: subject.userId || null,
    account_email: subject.accountEmail || null,
    entitlement_type: productKey,
    product_key: productKey,
    status: "active",
    starts_at: startsAt,
    expires_at: expiresAt,
    store: STORE_MAP[rcEvent.store] || null,
    store_transaction_id: transactionId,
    store_product_id: text(rcEvent.product_id, 200) || null,
    store_app_user_id: subject.appUserId || null,
    source_type: "store",
    entitlement_reason: "store_purchase",
    non_renewing: productKey === STORE_MONTH_PASS_KEY,
    metadata: {
      product_key: productKey,
      store: STORE_MAP[rcEvent.store] || rcEvent.store || "",
      store_product_id: rcEvent.product_id || "",
      period_type: rcEvent.period_type || "",
      last_event_type: rcEvent.type,
      last_event_id: rcEvent.id,
      environment: rcEvent.environment || ""
    },
    updated_at: new Date().toISOString()
  };

  if (row && row.id) {
    /* Renewal: never move expiry backwards. Out-of-order delivery is normal and a
       late RENEWAL must not shorten access already granted by a later event. */
    if (row.expires_at && new Date(row.expires_at).getTime() >= new Date(expiresAt).getTime()) {
      delete payload.expires_at;
    }
    delete payload.starts_at;
    await supabaseFetch("user_entitlements?id=eq." + encodeFilter(row.id), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(payload)
    });
    return { handled: true, action: "extended", productKey: productKey };
  }

  await supabaseFetch("user_entitlements?on_conflict=store_transaction_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(payload)
  });
  return { handled: true, action: "granted", productKey: productKey };
}

async function revokeAccess(rcEvent) {
  const transactionId = storeTransactionId(rcEvent);
  if (!transactionId) throw new Error("Store event has no transaction id");

  const status = rcEvent.type === "REFUND" ? "refunded" : "expired";
  /* Expire at the store's stated time rather than now, so an EXPIRATION that
     arrives late does not retroactively erase access the user genuinely had. */
  const expiresAt = msToIso(rcEvent.expiration_at_ms) || new Date().toISOString();

  await supabaseFetch("user_entitlements?store_transaction_id=eq." + encodeFilter(transactionId), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: status,
      expires_at: rcEvent.type === "REFUND" ? new Date().toISOString() : expiresAt,
      updated_at: new Date().toISOString()
    })
  });
  return { handled: true, action: status };
}

function storeTransactionId(rcEvent) {
  /* original_transaction_id is stable across the life of a subscription, which is
     what makes one row per subscription possible. One-off purchases only have
     transaction_id. */
  return text(rcEvent.original_transaction_id || rcEvent.transaction_id, 200);
}

function msToIso(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

/* Exported for tests. */
exports.__test = {
  GRANTING_EVENTS,
  REVOKING_EVENTS,
  STORE_MAP,
  msToIso,
  productKeyFor,
  safeEqual,
  storeTransactionId
};
