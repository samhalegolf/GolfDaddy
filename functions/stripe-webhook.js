"use strict";

const crypto = require("crypto");
const {
  MONTHLY_MEMBERSHIP_KEY,
  MONTH_PASS_KEY,
  email,
  env,
  hasSupabase,
  json,
  monthPassWindow,
  normaliseProductKey,
  paymentProduct,
  productPriceId,
  rowProductKey,
  stripeFetch,
  subjectOrFilter,
  supabaseFetch,
  text
} = require("./payment-utils");
const { sendSystemAlert } = require("./alert-utils");
const referrals = require("./referral-service");

const GRACE_DAYS = 7;
const WEBHOOK_PROCESSING_RETRY_AFTER_MS = 15 * 60 * 1000;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  if (!env("STRIPE_WEBHOOK_SECRET")) return json(503, { error: "Stripe webhook is not configured yet" });
  if (!hasSupabase()) {
    await sendSystemAlert({
      eventType: "supabase_not_configured",
      title: "Stripe webhook cannot reach Supabase",
      detail: "A Stripe webhook was received but payment storage is not configured. Entitlements will not be granted.",
      context: { endpoint: "stripe-webhook" }
    });
    return json(503, { error: "Payment storage is not configured yet" });
  }

  const signature = event.headers["stripe-signature"] || event.headers["Stripe-Signature"];
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "";

  let stripeEvent;
  try {
    stripeEvent = verifyStripeEvent(rawBody, signature, env("STRIPE_WEBHOOK_SECRET"));
  } catch (_error) {
    return json(400, { error: "Webhook signature verification failed" });
  }

  let claim;
  try {
    claim = await claimWebhookEvent(stripeEvent);
    if (claim.duplicate) return json(200, { received: true, duplicate: true });

    await processStripeEvent(stripeEvent);
    await completeWebhookEvent(stripeEvent, "processed", "");
    await recordLegacyPaymentEvent(stripeEvent);
    return json(200, { received: true });
  } catch (error) {
    await completeWebhookEvent(stripeEvent, "failed", error && (error.body || error.message) ? JSON.stringify(error.body || error.message).slice(0, 2000) : String(error || "Webhook processing failed").slice(0, 2000)).catch(function () {});
    await sendSystemAlert({
      eventType: "stripe_webhook_processing_failed",
      title: "Stripe webhook processing failed",
      detail: "A Stripe event could not be fully processed. Check stripe_webhook_events, payment_events and entitlement tables.",
      context: { stripeEventId: stripeEvent && stripeEvent.id || null, stripeEventType: stripeEvent && stripeEvent.type || null, status: error.status || null, details: error.body || error.message || String(error) }
    });
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

async function claimWebhookEvent(stripeEvent) {
  const createdAt = toIso(stripeEvent.created) || new Date().toISOString();
  const inserted = await supabaseFetch("stripe_webhook_events?on_conflict=stripe_event_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({
      stripe_event_id: stripeEvent.id,
      event_type: stripeEvent.type,
      stripe_created_at: createdAt,
      processing_status: "processing",
      error_message: null,
      updated_at: new Date().toISOString()
    })
  });
  if (Array.isArray(inserted) && inserted.length) return { duplicate: false, row: inserted[0] };

  const existing = await supabaseFetch("stripe_webhook_events?select=*&stripe_event_id=eq." + encodeURIComponent(stripeEvent.id) + "&limit=1", { method: "GET" });
  const row = Array.isArray(existing) ? existing[0] : null;
  if (row && row.processing_status === "processed") return { duplicate: true, row };
  if (row && row.processing_status === "processing" && !processingClaimIsStale(row)) return { duplicate: true, row };

  await supabaseFetch("stripe_webhook_events?stripe_event_id=eq." + encodeURIComponent(stripeEvent.id), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      processing_status: "processing",
      error_message: null,
      updated_at: new Date().toISOString()
    })
  });
  return { duplicate: false, row };
}

function processingClaimIsStale(row) {
  const updatedAt = row && row.updated_at ? new Date(row.updated_at).getTime() : NaN;
  if (!Number.isFinite(updatedAt)) return true;
  return Date.now() - updatedAt > WEBHOOK_PROCESSING_RETRY_AFTER_MS;
}

async function completeWebhookEvent(stripeEvent, status, errorMessage) {
  await supabaseFetch("stripe_webhook_events?stripe_event_id=eq." + encodeURIComponent(stripeEvent.id), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      processing_status: status,
      processed_at: status === "processed" ? new Date().toISOString() : null,
      error_message: errorMessage || null,
      updated_at: new Date().toISOString()
    })
  });
}

async function recordLegacyPaymentEvent(stripeEvent) {
  await supabaseFetch("payment_events?on_conflict=stripe_event_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({
      stripe_event_id: stripeEvent.id,
      event_type: stripeEvent.type,
      payload_json: stripeEvent
    })
  }).catch(function () {});
}

async function processStripeEvent(stripeEvent) {
  const object = stripeEvent && stripeEvent.data && stripeEvent.data.object || {};
  switch (stripeEvent.type) {
    case "checkout.session.completed":
      return handleCheckoutCompleted(object, stripeEvent);
    case "checkout.session.expired":
      return handleCheckoutExpired(object, stripeEvent);
    case "invoice.paid":
      return handleInvoicePaid(object, stripeEvent);
    case "invoice.payment_failed":
    case "invoice.payment_action_required":
    case "invoice.finalization_failed":
      return handleInvoiceProblem(object, stripeEvent);
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return handleSubscriptionChanged(object, stripeEvent);
    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(object, stripeEvent);
    case "charge.refunded":
      return handleChargeRefunded(object, stripeEvent);
    case "charge.dispute.created":
      return handleChargeDisputeCreated(object);
    case "payment_intent.payment_failed":
      return handlePaymentIntentFailed(object);
    default:
      return null;
  }
}

async function handleCheckoutCompleted(session, stripeEvent) {
  const key = productKeyFrom(session);
  if (key === MONTH_PASS_KEY) return grantMonthPass(session);
  if (key === MONTHLY_MEMBERSHIP_KEY && session.subscription) {
    const subscription = await retrieveSubscription(idValue(session.subscription));
    if (subscription && await subscriptionIsMonthlyMembership(subscription)) {
      await upsertMembershipFromSubscription(subscription, stripeEvent, {
        session,
        status: subscription.status || "incomplete"
      });
    }
  }
}

async function handleCheckoutExpired(session, stripeEvent) {
  if (productKeyFrom(session) !== MONTHLY_MEMBERSHIP_KEY || !session.subscription) return;
  const subscriptionId = idValue(session.subscription);
  const existing = await membershipBySubscription(subscriptionId);
  if (!existing) return;
  await patchMembership(existing.user_id, {
    status: "incomplete_expired",
    last_stripe_event_created_at: toIso(stripeEvent.created),
    last_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
}

async function grantMonthPass(session) {
  if (!session || session.payment_status !== "paid") return;
  const metadata = session.metadata || {};
  const userId = text(metadata.user_id || metadata.account_id || session.client_reference_id, 120);
  const accountEmail = email(metadata.account_email || session.customer_details && session.customer_details.email || session.customer_email);
  if (!userId && !accountEmail) throw new Error("Could not resolve Caddy account for Month Pass");

  const existing = await supabaseFetch("user_entitlements?select=id&stripe_checkout_session_id=eq." + encodeURIComponent(session.id) + "&limit=1", { method: "GET" });
  if (Array.isArray(existing) && existing.length) return;

  const baseMs = await monthPassBaseMs(userId, accountEmail);
  const window = monthPassWindow(baseMs);
  await supabaseFetch("user_entitlements?on_conflict=stripe_checkout_session_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({
      user_id: userId || null,
      account_email: accountEmail || null,
      entitlement_type: MONTH_PASS_KEY,
      product_key: MONTH_PASS_KEY,
      status: "active",
      starts_at: window.starts_at,
      expires_at: window.expires_at,
      stripe_customer_id: text(session.customer, 200) || null,
      stripe_checkout_session_id: text(session.id, 200),
      stripe_payment_intent_id: text(session.payment_intent, 200) || null,
      metadata: {
        product_key: MONTH_PASS_KEY,
        amount_total: session.amount_total || null,
        currency: session.currency || "",
        payment_status: session.payment_status || "",
        source: "stripe_checkout"
      },
      updated_at: new Date().toISOString()
    })
  });
}

async function monthPassBaseMs(userId, accountEmail) {
  const now = Date.now();
  const filter = subjectOrFilter(userId, accountEmail, "");
  if (!filter) return now;
  const rows = await supabaseFetch("user_entitlements?select=entitlement_type,product_key,status,starts_at,expires_at,metadata&status=eq.active&" + filter + "&order=expires_at.desc.nullsfirst&limit=100", { method: "GET" });
  const expiries = (Array.isArray(rows) ? rows : []).filter(function (row) {
    return rowProductKey(row) === MONTH_PASS_KEY && row.expires_at && new Date(row.expires_at).getTime() > now;
  }).map(function (row) {
    return new Date(row.expires_at).getTime();
  }).filter(Number.isFinite);
  return Math.max(now, expiries.length ? Math.max.apply(Math, expiries) : now);
}

async function handleInvoicePaid(invoice, stripeEvent) {
  const subscription = await retrieveSubscription(subscriptionIdFromInvoice(invoice));
  if (!subscription || !await subscriptionIsMonthlyMembership(subscription)) return;
  const identity = await subscriptionIdentity(subscription, invoice);
  if (!identity.userId) throw new Error("Could not resolve Caddy account for paid invoice");

  const existing = await membershipByUserOrSubscription(identity.userId, subscription.id);
  if (existing && existing.last_paid_invoice_id === invoice.id) return;

  await upsertMembershipFromSubscription(subscription, stripeEvent, {
    invoice,
    status: subscription.status || "active",
    accessUntil: periodEndIso(subscription),
    graceUntil: null,
    firstPaymentFailedAt: null,
    lastPaidInvoiceId: invoice.id
  });
  await referrals.markScheduledRewardAppliedForInvoice({
    invoice,
    subscription,
    stripeEvent,
    userId: identity.userId,
    accountEmail: identity.accountEmail
  });
  await referrals.evaluateReferralConversion({
    invoice,
    subscription,
    stripeEvent,
    userId: identity.userId,
    accountEmail: identity.accountEmail
  });
}

async function handleInvoiceProblem(invoice, stripeEvent) {
  const subscription = await retrieveSubscription(subscriptionIdFromInvoice(invoice));
  if (!subscription || !await subscriptionIsMonthlyMembership(subscription)) return;
  const identity = await subscriptionIdentity(subscription, invoice);
  if (!identity.userId) throw new Error("Could not resolve Caddy account for failed invoice");

  const existing = await membershipByUserOrSubscription(identity.userId, subscription.id);
  const firstFailedAt = existing && existing.first_payment_failed_at || toIso(stripeEvent.created) || new Date().toISOString();
  const graceUntil = new Date(new Date(firstFailedAt).getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await upsertMembershipFromSubscription(subscription, stripeEvent, {
    invoice,
    status: "past_due",
    firstPaymentFailedAt: firstFailedAt,
    graceUntil,
    accessUntil: existing && existing.access_until || periodEndIso(subscription)
  });
}

async function handleSubscriptionChanged(subscriptionObject, stripeEvent) {
  const subscription = await retrieveSubscription(subscriptionObject && subscriptionObject.id) || subscriptionObject;
  if (!subscription || !await subscriptionIsMonthlyMembership(subscription)) return;
  await upsertMembershipFromSubscription(subscription, stripeEvent, { status: subscription.status || "incomplete" });
}

async function handleSubscriptionDeleted(subscription, stripeEvent) {
  if (!subscription || !await subscriptionIsMonthlyMembership(subscription)) return;
  const identity = await subscriptionIdentity(subscription, null);
  if (!identity.userId) return;
  const existing = await membershipByUserOrSubscription(identity.userId, subscription.id);
  const paidThrough = periodEndIso(subscription) || existing && existing.access_until || null;
  await upsertMembershipFromSubscription(subscription, stripeEvent, {
    status: "canceled",
    accessUntil: paidThrough,
    cancelAtPeriodEnd: false
  });
}

async function upsertMembershipFromSubscription(subscription, stripeEvent, options) {
  options = options || {};
  const identity = await subscriptionIdentity(subscription, options.invoice || options.session || null);
  const userId = identity.userId;
  if (!userId) throw new Error("Could not resolve Caddy account for membership");
  const now = new Date().toISOString();
  const eventCreatedAt = toIso(stripeEvent && stripeEvent.created) || now;
  const existing = await membershipByUserOrSubscription(userId, subscription.id);
  if (existing && existing.last_stripe_event_created_at && new Date(existing.last_stripe_event_created_at).getTime() > new Date(eventCreatedAt).getTime() && !options.lastPaidInvoiceId) {
    return;
  }

  const patch = {
    user_id: userId,
    account_email: identity.accountEmail || existing && existing.account_email || null,
    stripe_customer_id: idValue(subscription.customer) || identity.customerId || existing && existing.stripe_customer_id || null,
    stripe_subscription_id: subscription.id,
    stripe_price_id: subscriptionPriceId(subscription) || existing && existing.stripe_price_id || null,
    status: options.status || subscription.status || existing && existing.status || "incomplete",
    access_until: options.accessUntil !== undefined ? options.accessUntil : accessUntilForSubscription(subscription, existing),
    grace_until: options.graceUntil !== undefined ? options.graceUntil : existing && existing.grace_until || null,
    first_payment_failed_at: options.firstPaymentFailedAt !== undefined ? options.firstPaymentFailedAt : existing && existing.first_payment_failed_at || null,
    cancel_at_period_end: options.cancelAtPeriodEnd !== undefined ? !!options.cancelAtPeriodEnd : !!subscription.cancel_at_period_end,
    current_period_start: periodStartIso(subscription),
    current_period_end: periodEndIso(subscription),
    last_paid_invoice_id: options.lastPaidInvoiceId !== undefined ? options.lastPaidInvoiceId : existing && existing.last_paid_invoice_id || null,
    last_stripe_event_created_at: eventCreatedAt,
    last_synced_at: now,
    updated_at: now
  };

  if (options.graceUntil === null) patch.grace_until = null;
  if (options.firstPaymentFailedAt === null) patch.first_payment_failed_at = null;

  await supabaseFetch("caddie_memberships?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(patch)
  });
}

async function patchMembership(userId, patch) {
  await supabaseFetch("caddie_memberships?user_id=eq." + encodeURIComponent(userId), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch)
  });
}

async function handleChargeRefunded(charge) {
  const amount = Number(charge && charge.amount);
  const refunded = Number(charge && charge.amount_refunded);
  if (!Number.isFinite(amount) || !Number.isFinite(refunded) || refunded < amount) return;

  const paymentIntentId = idValue(charge && charge.payment_intent);
  if (paymentIntentId) {
    await supabaseFetch("user_entitlements?stripe_payment_intent_id=eq." + encodeURIComponent(paymentIntentId), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "refunded",
        updated_at: new Date().toISOString()
      })
    });
  }

  const invoiceId = idValue(charge && charge.invoice);
  if (invoiceId) {
    const invoice = await stripeFetch("GET", "/v1/invoices/" + encodeURIComponent(invoiceId), {}).catch(function () { return null; });
    const subscription = invoice ? await retrieveSubscription(subscriptionIdFromInvoice(invoice)) : null;
    if (subscription && await subscriptionIsMonthlyMembership(subscription)) {
      await recordMembershipRefundWarning(subscription.id, invoiceId, charge);
      await referrals.reversePendingReferralRewardForInvoice(invoiceId, "qualifying_payment_refunded");
    }
  }
}

async function handleChargeDisputeCreated(dispute) {
  const chargeId = idValue(dispute && dispute.charge);
  if (!chargeId) return;
  const charge = await stripeFetch("GET", "/v1/charges/" + encodeURIComponent(chargeId), {}).catch(function () { return null; });
  const invoiceId = idValue(charge && charge.invoice);
  if (!invoiceId) return;
  await referrals.reversePendingReferralRewardForInvoice(invoiceId, "qualifying_payment_disputed");
}

async function recordMembershipRefundWarning(subscriptionId, invoiceId, charge) {
  const existing = await membershipBySubscription(subscriptionId);
  if (!existing || !existing.user_id) return;
  const metadata = Object.assign({}, existing.metadata || {}, {
    last_full_refund_warning: {
      invoice_id: invoiceId,
      charge_id: charge && charge.id || null,
      amount_refunded: charge && charge.amount_refunded || null,
      recorded_at: new Date().toISOString(),
      note: "Membership invoice was fully refunded; subscription state was preserved until Stripe reports an update or cancellation."
    }
  });
  await patchMembership(existing.user_id, {
    metadata,
    last_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
}

async function handlePaymentIntentFailed(paymentIntent) {
  const paymentIntentId = text(paymentIntent && paymentIntent.id, 200);
  if (!paymentIntentId) return;
  await supabaseFetch("user_entitlements?stripe_payment_intent_id=eq." + encodeURIComponent(paymentIntentId), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "cancelled",
      updated_at: new Date().toISOString()
    })
  });
}

async function retrieveSubscription(subscriptionId) {
  const id = text(subscriptionId, 200);
  if (!id) return null;
  return await stripeFetch("GET", "/v1/subscriptions/" + encodeURIComponent(id), {
    "expand[]": ["items.data.price", "latest_invoice"]
  }).catch(function () { return null; });
}

async function subscriptionIsMonthlyMembership(subscription) {
  if (!subscription || !subscription.id) return false;
  if (normaliseProductKey(subscription.metadata && subscription.metadata.product_key) === MONTHLY_MEMBERSHIP_KEY) return true;
  const product = await paymentProduct(MONTHLY_MEMBERSHIP_KEY, { activeOnly: false }).catch(function () { return null; });
  const priceId = productPriceId(product, MONTHLY_MEMBERSHIP_KEY);
  return !!(priceId && subscriptionPriceId(subscription) === priceId);
}

async function subscriptionIdentity(subscription, source) {
  const metadata = Object.assign({}, subscription && subscription.metadata || {}, source && source.metadata || {});
  let userId = text(metadata.user_id || metadata.account_id || source && source.client_reference_id, 120);
  let accountEmail = email(metadata.account_email || source && (source.customer_email || source.customer_details && source.customer_details.email));
  const customerId = idValue(subscription && subscription.customer || source && source.customer);

  if ((!userId || !accountEmail) && customerId) {
    const rows = await supabaseFetch("app_accounts?select=*&stripe_customer_id=eq." + encodeURIComponent(customerId) + "&limit=1", { method: "GET" }).catch(function () { return []; });
    const account = Array.isArray(rows) ? rows[0] : null;
    userId = userId || text(account && account.account_id, 120);
    accountEmail = accountEmail || email(account && account.email);
  }

  if ((!userId || !accountEmail) && subscription && subscription.id) {
    const existing = await membershipBySubscription(subscription.id);
    userId = userId || text(existing && existing.user_id, 120);
    accountEmail = accountEmail || email(existing && existing.account_email);
  }

  return { userId, accountEmail, customerId };
}

async function membershipByUserOrSubscription(userId, subscriptionId) {
  const filters = [];
  if (userId) filters.push("user_id.eq." + encodeURIComponent(userId));
  if (subscriptionId) filters.push("stripe_subscription_id.eq." + encodeURIComponent(subscriptionId));
  if (!filters.length) return null;
  const rows = await supabaseFetch("caddie_memberships?select=*&or=(" + filters.join(",") + ")&limit=1", { method: "GET" }).catch(function () { return []; });
  return Array.isArray(rows) ? rows[0] : null;
}

async function membershipBySubscription(subscriptionId) {
  if (!subscriptionId) return null;
  const rows = await supabaseFetch("caddie_memberships?select=*&stripe_subscription_id=eq." + encodeURIComponent(subscriptionId) + "&limit=1", { method: "GET" }).catch(function () { return []; });
  return Array.isArray(rows) ? rows[0] : null;
}

function accessUntilForSubscription(subscription, existing) {
  const status = String(subscription && subscription.status || "").toLowerCase();
  if (status === "active" || status === "trialing") return periodEndIso(subscription);
  if (subscription && subscription.cancel_at_period_end && periodEndIso(subscription)) return periodEndIso(subscription);
  return existing && existing.access_until || null;
}

function productKeyFrom(object) {
  return normaliseProductKey(object && object.metadata && object.metadata.product_key);
}

function subscriptionIdFromInvoice(invoice) {
  return idValue(invoice && (invoice.subscription || invoice.subscription_details && invoice.subscription_details.subscription || invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription));
}

function subscriptionPriceId(subscription) {
  const items = subscription && subscription.items && Array.isArray(subscription.items.data) ? subscription.items.data : [];
  const item = items[0] || null;
  return text(item && item.price && item.price.id, 200);
}

function periodStartIso(subscription) {
  return toIso(periodValue(subscription, "current_period_start"));
}

function periodEndIso(subscription) {
  return toIso(periodValue(subscription, "current_period_end"));
}

function periodValue(subscription, field) {
  const direct = Number(subscription && subscription[field]);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const items = subscription && subscription.items && Array.isArray(subscription.items.data) ? subscription.items.data : [];
  const fromItem = Number(items[0] && items[0][field]);
  return Number.isFinite(fromItem) && fromItem > 0 ? fromItem : null;
}

function idValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return text(value.id, 200);
}

function toIso(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}
