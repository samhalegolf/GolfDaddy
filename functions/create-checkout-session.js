"use strict";

const {
  PASS_CONFIG,
  appUrl,
  email,
  env,
  json,
  normaliseProductKey,
  passPriceId,
  passType,
  paymentProduct,
  productDurationHours,
  productPriceId,
  text
} = require("./payment-utils");

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  if (!env("STRIPE_SECRET_KEY")) {
    return json(503, { error: "Stripe is not configured yet" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { error: "Invalid JSON" });
  }

  const requestedKey = normaliseProductKey(payload.productKey || payload.passType || payload.entitlementType || payload.product);
  if (!requestedKey) return json(400, { error: "Choose a valid pass or membership" });

  let product = null;
  try { product = await paymentProduct(requestedKey); } catch (_error) { product = null; }

  const legacyType = passType(requestedKey);
  if (!product && !legacyType) return json(400, { error: "Choose a valid active pass or membership" });

  const price = productPriceId(product, legacyType);
  if (!price) {
    const label = product && product.name || PASS_CONFIG[legacyType] && PASS_CONFIG[legacyType].label || "This product";
    return json(503, { error: label + " is not connected to a Stripe Price ID yet" });
  }

  const accountEmail = email(payload.email || payload.accountEmail);
  const accountId = text(payload.accountId || payload.userId, 120);
  const accountName = text(payload.name || payload.accountName, 120);
  if (!accountEmail && !accountId) {
    return json(400, { error: "Sign in before buying a pass" });
  }

  const productKey = product && product.product_key || legacyType;
  const productKind = product && product.product_kind || legacyType;
  const label = product && product.name || PASS_CONFIG[legacyType] && PASS_CONFIG[legacyType].label || productKey;
  const durationHours = productDurationHours(product, legacyType);
  const mode = productKind === "membership" || String(product && product.billing_schedule || "").toLowerCase().indexOf("subscription") !== -1 ? "subscription" : "payment";

  const site = appUrl();
  const params = new URLSearchParams();
  params.append("mode", mode);
  params.append("client_reference_id", accountId || accountEmail);
  params.append("line_items[0][price]", price);
  params.append("line_items[0][quantity]", "1");
  params.append("success_url", site + "/?payment=success&session_id={CHECKOUT_SESSION_ID}");
  params.append("cancel_url", site + "/?payment=cancelled");
  params.append("allow_promotion_codes", "true");
  if (accountEmail) params.append("customer_email", accountEmail);
  params.append("metadata[app]", "clarity-caddie");
  params.append("metadata[product_key]", productKey);
  params.append("metadata[product_kind]", productKind);
  params.append("metadata[product_name]", label);
  params.append("metadata[entitlement_type]", productKey);
  params.append("metadata[duration_hours]", String(durationHours));
  params.append("metadata[account_id]", accountId);
  params.append("metadata[account_email]", accountEmail);
  params.append("metadata[account_name]", accountName);
  params.append("payment_intent_data[metadata][app]", "clarity-caddie");
  params.append("payment_intent_data[metadata][product_key]", productKey);
  params.append("payment_intent_data[metadata][entitlement_type]", productKey);
  params.append("payment_intent_data[metadata][duration_hours]", String(durationHours));
  params.append("payment_intent_data[metadata][account_id]", accountId);
  params.append("payment_intent_data[metadata][account_email]", accountEmail);

  try {
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env("STRIPE_SECRET_KEY"),
        "Content-Type": "application/x-www-form-urlencoded",
        "Stripe-Version": "2026-02-25.clover"
      },
      body: params
    });
    const session = await response.json().catch(function () { return null; });
    if (!response.ok || !session || !session.url) {
      const message = session && session.error && session.error.message || "Could not start checkout";
      throw new Error(message);
    }

    return json(200, {
      id: session.id,
      url: session.url,
      productKey,
      passType: productKey
    });
  } catch (error) {
    return json(502, { error: error && error.message ? error.message : "Could not start checkout" });
  }
};
