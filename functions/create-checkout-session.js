"use strict";

const {
  MONTHLY_MEMBERSHIP_KEY,
  MONTH_PASS_KEY,
  appUrl,
  email,
  ensureStripeCustomer,
  env,
  json,
  isStripePriceId,
  membershipBlocksNewCheckout,
  normaliseProductKey,
  paymentProduct,
  productPriceId,
  readPaidAccess,
  resolveAccount,
  stripeFetch,
  stripeSubscriptionBlocksNewCheckout,
  text
} = require("./payment-utils");
const { prepareReferredMembershipCheckout } = require("./referral-service");

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  if (!env("STRIPE_SECRET_KEY")) return json(503, { error: "Stripe is not configured yet" });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (_error) {
    return json(400, { error: "Invalid JSON" });
  }

  const productKey = normaliseProductKey(payload.productKey || payload.passType || payload.entitlementType || payload.product);
  if (productKey !== MONTH_PASS_KEY && productKey !== MONTHLY_MEMBERSHIP_KEY) {
    return json(400, { error: "Choose One Month Pass or Monthly Membership" });
  }

  try {
    const account = await resolveAccount(payload, { event, requireAuth: true });
    const product = await paymentProduct(productKey, { activeOnly: false });
    if (product && product.active === false) {
      return json(503, { error: (product.name || "This product") + " is not active yet" });
    }

    const price = productPriceId(product, productKey);
    if (!price) {
      const label = product && product.name || (productKey === MONTH_PASS_KEY ? "One Month Pass" : "Monthly Membership");
      return json(503, { error: label + " is not connected to a Stripe Price ID yet" });
    }
    if (!isStripePriceId(price)) {
      const label = product && product.name || (productKey === MONTH_PASS_KEY ? "One Month Pass" : "Monthly Membership");
      return json(503, { error: label + " needs a valid Stripe Price ID before Checkout can start" });
    }

    const customer = await ensureStripeCustomer(account);
    if (!customer || !customer.id) return json(502, { error: "Could not prepare Stripe Customer" });

    if (productKey === MONTHLY_MEMBERSHIP_KEY) {
      const existing = await existingMembershipRelationship(account, customer.id, price);
      if (existing) {
        return json(200, {
          ok: true,
          existingMembership: true,
          action: String(existing.status || "").toLowerCase() === "incomplete" ? "complete_payment_setup" : "manage_membership",
          message: String(existing.status || "").toLowerCase() === "incomplete"
            ? "A membership setup is already in progress."
            : "This account already has a membership relationship.",
          subscriptionId: existing.stripe_subscription_id || existing.id || null,
          status: existing.status || null
        });
      }
    }

    const site = appUrl();
    const metadata = {
      app: "clarity-caddie",
      user_id: text(account.account_id, 120),
      account_id: text(account.account_id, 120),
      account_email: email(account.email),
      account_name: text(account.name, 120),
      product_key: productKey
    };
    let referralCheckout = null;
    if (productKey === MONTHLY_MEMBERSHIP_KEY) {
      referralCheckout = await prepareReferredMembershipCheckout(account);
      if (referralCheckout && referralCheckout.referralId) {
        metadata.referral_id = text(referralCheckout.referralId, 120);
        metadata.referred_by_account_id = text(referralCheckout.inviterAccountId, 120);
        metadata.referral_free_access_ends_at = text(referralCheckout.freeAccessEndsAt, 80);
      }
    }

    const params = {
      mode: productKey === MONTHLY_MEMBERSHIP_KEY ? "subscription" : "payment",
      customer: customer.id,
      client_reference_id: account.account_id,
      "line_items[0][price]": price,
      "line_items[0][quantity]": "1",
      success_url: site + "/?payment=success&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: site + "/?payment=cancelled",
      allow_promotion_codes: "true"
    };
    Object.keys(metadata).forEach(function (key) {
      params["metadata[" + key + "]"] = metadata[key];
    });

    if (productKey === MONTH_PASS_KEY) {
      Object.keys(metadata).forEach(function (key) {
        params["payment_intent_data[metadata][" + key + "]"] = metadata[key];
      });
    } else {
      Object.keys(metadata).forEach(function (key) {
        params["subscription_data[metadata][" + key + "]"] = metadata[key];
      });
      if (referralCheckout && referralCheckout.trialEnd) {
        params["subscription_data[trial_end]"] = String(referralCheckout.trialEnd);
      }
    }

    const session = await stripeFetch("POST", "/v1/checkout/sessions", params);
    if (!session || !session.url) throw new Error("Could not start checkout");

    return json(200, {
      ok: true,
      id: session.id,
      url: session.url,
      productKey,
      referral: referralCheckout ? {
        referralId: referralCheckout.referralId,
        freeAccessEndsAt: referralCheckout.freeAccessEndsAt,
        billingStartsAt: referralCheckout.freeAccessEndsAt
      } : null
    });
  } catch (error) {
    return json(error.status || 502, { error: error && error.message ? error.message : "Could not start checkout", details: error.body || null });
  }
};

async function existingMembershipRelationship(account, customerId, priceId) {
  const accountId = text(account && account.account_id, 120);
  const accountEmail = email(account && account.email);
  const access = await readPaidAccess({ accountId, accountEmail });
  const localRelationship = (access.memberships || []).find(function (row) {
    return membershipBlocksNewCheckout(row);
  });
  if (localRelationship) return localRelationship;

  const subscriptions = await stripeFetch("GET", "/v1/subscriptions", {
    customer: customerId,
    status: "all",
    limit: 100,
    "expand[]": "data.items.data.price"
  });
  const rows = Array.isArray(subscriptions && subscriptions.data) ? subscriptions.data : [];
  return rows.find(function (subscription) {
    if (!stripeSubscriptionBlocksNewCheckout(subscription)) return false;
    if (normaliseProductKey(subscription.metadata && subscription.metadata.product_key) === MONTHLY_MEMBERSHIP_KEY) return true;
    const items = subscription.items && Array.isArray(subscription.items.data) ? subscription.items.data : [];
    return items.some(function (item) {
      return item && item.price && item.price.id === priceId;
    });
  }) || null;
}
