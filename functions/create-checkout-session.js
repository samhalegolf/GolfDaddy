exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
  if (!stripeSecretKey) {
    return json(503, {
      error: "Stripe checkout is not configured yet.",
      configured: false,
      requiredEnv: [
        "STRIPE_SECRET_KEY",
        "STRIPE_PRICE_ROUND_PASS",
        "STRIPE_PRICE_UNLIMITED_MONTHLY",
        "STRIPE_PRICE_UNLIMITED_ANNUAL"
      ]
    });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (error) {
    return json(400, { error: "Invalid JSON body" });
  }

  const productKey = String(body.productKey || "").trim();
  const priceId = priceIdForProduct(productKey);
  if (!priceId) {
    return json(400, { error: "Unknown or unconfigured product", productKey });
  }

  const siteUrl = process.env.CLARITY_SITE_URL || originFromEvent(event) || "https://caddy.claritygolf.app";
  const successUrl = String(body.successUrl || `${siteUrl}?checkout=success`);
  const cancelUrl = String(body.cancelUrl || siteUrl);
  const mode = productKey === "round_pass" ? "payment" : "subscription";

  const params = new URLSearchParams();
  params.set("mode", mode);
  params.set("success_url", successUrl);
  params.set("cancel_url", cancelUrl);
  params.set("line_items[0][price]", priceId);
  params.set("line_items[0][quantity]", "1");
  if (body.clientReferenceId) params.set("client_reference_id", String(body.clientReferenceId));
  params.set("metadata[productKey]", productKey);
  params.set("metadata[source]", "clarity-caddie");
  if (body.metadata && typeof body.metadata === "object") {
    Object.keys(body.metadata).slice(0, 20).forEach((key) => {
      if (/^[a-zA-Z0-9_:-]{1,40}$/.test(key)) {
        params.set(`metadata[${key}]`, String(body.metadata[key]).slice(0, 500));
      }
    });
  }

  try {
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const data = await response.json();
    if (!response.ok) {
      return json(response.status, { error: data && data.error && data.error.message || "Stripe checkout failed" });
    }

    return json(200, {
      configured: true,
      id: data.id,
      url: data.url,
      productKey
    });
  } catch (error) {
    return json(500, { error: error.message || "Checkout request failed" });
  }
};

function priceIdForProduct(productKey) {
  const envMap = {
    round_pass: "STRIPE_PRICE_ROUND_PASS",
    unlimited_monthly: "STRIPE_PRICE_UNLIMITED_MONTHLY",
    unlimited_annual: "STRIPE_PRICE_UNLIMITED_ANNUAL",
    founder_annual: "STRIPE_PRICE_FOUNDER_ANNUAL",
    coach_monthly: "STRIPE_PRICE_COACH_MONTHLY"
  };
  const envName = envMap[productKey];
  return envName ? String(process.env[envName] || "").trim() : "";
}

function originFromEvent(event) {
  const headers = event.headers || {};
  const proto = headers["x-forwarded-proto"] || "https";
  const host = headers.host || headers.Host;
  return host ? `${proto}://${host}` : "";
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}
