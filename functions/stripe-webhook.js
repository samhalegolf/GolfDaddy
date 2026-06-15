"use strict";

const crypto = require("crypto");
const {
  email,
  entitlementWindow,
  env,
  hasSupabase,
  json,
  passType,
  supabaseFetch,
  text
} = require("./payment-utils");

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  if (!env("STRIPE_WEBHOOK_SECRET")) {
    return json(503, { error: "Stripe webhook is not configured yet" });
  }
  if (!hasSupabase()) {
    return json(503, { error: "Payment storage is not configured yet" });
  }

  const signature = event.headers["stripe-signature"] || event.headers["Stripe-Signature"];
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "";

  let stripeEvent;
  try {
    stripeEvent = verifyStripeEvent(rawBody, signature, env("STRIPE_WEBHOOK_SECRET"));
  } catch (error) {
    return json(400, { error: "Webhook signature verification failed" });
  }

  try {
    const seen = await supabaseFetch("payment_events?select=id&stripe_event_id=eq." + encodeURIComponent(stripeEvent.id) + "&limit=1", {
      method: "GET"
    });
    if (Array.isArray(seen) && seen.length) return json(200, { received: true, duplicate: true });

    if (stripeEvent.type === "checkout.session.completed") {
      await grantCheckoutEntitlement(stripeEvent.data.object);
    }

    if (stripeEvent.type === "charge.refunded" || stripeEvent.type === "payment_intent.payment_failed") {
      await markRelatedEntitlements(stripeEvent.data.object, stripeEvent.type);
    }

    await supabaseFetch("payment_events", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        stripe_event_id: stripeEvent.id,
        event_type: stripeEvent.type,
        payload_json: stripeEvent
      })
    });

    return json(200, { received: true });
  } catch (error) {
    return json(error.status || 502, {
      error: "Webhook processing failed",
      details: error.body || error.message || String(error)
    });
  }
};

function verifyStripeEvent(rawBody, signature, secret) {
  if (!signature || !secret) throw new Error("Missing signature");
  const parts = String(signature).split(",").reduce(function (acc, item) {
    const pair = item.split("=");
    const key = pair.shift();
    const value = pair.join("=");
    if (!acc[key]) acc[key] = [];
    acc[key].push(value);
    return acc;
  }, {});
  const timestamp = parts.t && parts.t[0];
  const signatures = parts.v1 || [];
  if (!timestamp || !signatures.length) throw new Error("Invalid signature header");

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) throw new Error("Signature timestamp outside tolerance");

  const expected = crypto
    .createHmac("sha256", secret)
    .update(timestamp + "." + rawBody, "utf8")
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const matched = signatures.some(function (value) {
    const candidate = Buffer.from(String(value || ""), "hex");
    return candidate.length === expectedBuffer.length && crypto.timingSafeEqual(candidate, expectedBuffer);
  });
  if (!matched) throw new Error("Signature mismatch");
  return JSON.parse(rawBody);
}

async function grantCheckoutEntitlement(session) {
  if (!session || session.payment_status !== "paid") return;
  const metadata = session.metadata || {};
  const type = passType(metadata.entitlement_type);
  if (!type) return;

  const createdMs = session.created ? Number(session.created) * 1000 : Date.now();
  const window = entitlementWindow(type, createdMs);
  const accountEmail = email(metadata.account_email || session.customer_details && session.customer_details.email || session.customer_email);
  const accountId = text(metadata.account_id || session.client_reference_id, 120);

  await supabaseFetch("user_entitlements?on_conflict=stripe_checkout_session_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      user_id: accountId || null,
      account_email: accountEmail || null,
      entitlement_type: type,
      status: "active",
      starts_at: window.starts_at,
      expires_at: window.expires_at,
      stripe_customer_id: text(session.customer, 200) || null,
      stripe_checkout_session_id: text(session.id, 200),
      stripe_payment_intent_id: text(session.payment_intent, 200) || null,
      metadata: {
        account_name: text(metadata.account_name, 120),
        amount_total: session.amount_total || null,
        currency: session.currency || "",
        payment_status: session.payment_status || ""
      },
      updated_at: new Date().toISOString()
    })
  });
}

async function markRelatedEntitlements(object, eventType) {
  const paymentIntentId = text(object && (object.payment_intent || object.id), 200);
  if (!paymentIntentId) return;
  const status = eventType === "charge.refunded" ? "refunded" : "cancelled";
  await supabaseFetch("user_entitlements?stripe_payment_intent_id=eq." + encodeURIComponent(paymentIntentId), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status,
      updated_at: new Date().toISOString()
    })
  });
}
