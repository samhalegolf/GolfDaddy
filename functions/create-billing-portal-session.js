"use strict";

const {
  appUrl,
  ensureStripeCustomer,
  env,
  json,
  resolveAccount,
  stripeFetch
} = require("./payment-utils");

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

  try {
    const account = await resolveAccount(payload, { event, requireAuth: true });
    const customer = await ensureStripeCustomer(account);
    if (!customer || !customer.id) return json(404, { error: "No Stripe customer found for this account" });

    const portal = await stripeFetch("POST", "/v1/billing_portal/sessions", {
      customer: customer.id,
      return_url: appUrl() + "/?payment=portal_return"
    });
    if (!portal || !portal.url) throw new Error("Could not open membership management");

    return json(200, { ok: true, url: portal.url });
  } catch (error) {
    return json(error.status || 502, { error: error && error.message ? error.message : "Could not open membership management", details: error.body || null });
  }
};
