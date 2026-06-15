"use strict";

const {
  PASS_CONFIG,
  appUrl,
  email,
  env,
  json,
  passPriceId,
  passType,
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

  const type = passType(payload.passType || payload.entitlementType || payload.product);
  if (!type) return json(400, { error: "Choose a valid pass" });

  const price = passPriceId(type);
  if (!price) return json(503, { error: PASS_CONFIG[type].label + " is not configured yet" });

  const accountEmail = email(payload.email || payload.accountEmail);
  const accountId = text(payload.accountId || payload.userId, 120);
  const accountName = text(payload.name || payload.accountName, 120);
  if (!accountEmail && !accountId) {
    return json(400, { error: "Sign in before buying a pass" });
  }

  const site = appUrl();
  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("client_reference_id", accountId || accountEmail);
  params.append("line_items[0][price]", price);
  params.append("line_items[0][quantity]", "1");
  params.append("success_url", site + "/?payment=success&session_id={CHECKOUT_SESSION_ID}");
  params.append("cancel_url", site + "/?payment=cancelled");
  params.append("allow_promotion_codes", "true");
  if (accountEmail) params.append("customer_email", accountEmail);
  params.append("metadata[app]", "clarity-caddie");
  params.append("metadata[entitlement_type]", type);
  params.append("metadata[account_id]", accountId);
  params.append("metadata[account_email]", accountEmail);
  params.append("metadata[account_name]", accountName);
  params.append("payment_intent_data[metadata][app]", "clarity-caddie");
  params.append("payment_intent_data[metadata][entitlement_type]", type);
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
      passType: type
    });
  } catch (error) {
    return json(502, { error: error && error.message ? error.message : "Could not start checkout" });
  }
};
