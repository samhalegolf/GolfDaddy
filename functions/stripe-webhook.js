exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
  if (!webhookSecret) {
    // The route exists now so Stripe can be wired later without changing app routes.
    // Return 200 to avoid noisy retries during early setup when the endpoint is probed.
    return json(200, {
      received: true,
      configured: false,
      note: "Stripe webhook secret is not configured yet."
    });
  }

  // Placeholder for future verified Stripe webhook handling.
  // When Stripe wiring is activated, verify `stripe-signature`, parse the event,
  // then update the user's access state in the permanent account store.
  return json(200, {
    received: true,
    configured: true,
    note: "Webhook route is ready; entitlement persistence is not connected yet."
  });
};

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
